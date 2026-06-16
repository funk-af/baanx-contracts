/*
 * MIT License
 *
 * Copyright (c) 2024 Algorand Foundation
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */
/* eslint-disable no-underscore-dangle */
/* eslint-disable camelcase */
import {
    Contract,
    GlobalState,
    BoxMap,
    Account,
    Asset,
    emit,
    abimethod,
    Txn,
    Global,
    assert,
    assertMatch,
    ensureBudget,
    arc4,
    itxn,
    op,
    compile,
    OnCompleteAction,
    clone,
    uint64,
    bytes,
    Bytes,
} from '@algorandfoundation/algorand-typescript';
import type { gtxn } from '@algorandfoundation/algorand-typescript';
import { Pausable } from './roles/Pausable.algo';
import { Recoverable } from './roles/Recoverable.algo';

// CardFundData
type CardFundData = {
    partnerChannel: Account;
    owner: Account;
    address: Account;
    nonce: uint64;
    withdrawalNonce: uint64;
};

// Withdrawal request for an amount of an asset, where the timestamp indicates the earliest it can be made
type PermissionlessWithdrawalRequest = {
    cardFund: Account;
    recipient: Account;
    asset: Asset;
    amount: uint64;
    createdAt: uint64;
    nonce: uint64;
};

const WithdrawalTypeApproved = 'approved';
const WithdrawalTypePermissionLess = 'permissionless';

// ========== Event Types ==========
type PartnerChannelCreated = {
    partnerChannel: Account;
    partnerChannelName: string;
};

type CardFundCreated = {
    cardFundOwner: Account;
    cardFund: Account;
    partnerChannel: Account;
};

type CardFundAssetEnabled = {
    cardFund: Account;
    asset: Asset;
};

type CardFundAssetDisabled = {
    cardFund: Account;
    asset: Asset;
};

type AssetAllowlistAdded = {
    asset: Asset;
};

type AssetAllowlistRemoved = {
    asset: Asset;
};

type Debit = {
    card: Account;
    asset: Asset;
    amount: uint64;
    nonce: uint64;
    reference: string;
};

type Refund = {
    card: Account;
    asset: Asset;
    amount: uint64;
    nonce: uint64;
};

type SettlementAddressChanged = {
    oldSettlementAddress: Account;
    newSettlementAddress: Account;
};

type Settlement = {
    recipient: Account;
    asset: Asset;
    amount: uint64;
    nonce: uint64;
};

type WithdrawalRequest = {
    cardFund: Account;
    recipient: Account;
    asset: Asset;
    amount: uint64;
    createdAt: uint64;
    nonce: uint64;
};

type WithdrawalRequestCancelled = {
    cardFund: Account;
    recipient: Account;
    asset: Asset;
    amount: uint64;
    createdAt: uint64;
    nonce: uint64;
};

type Withdrawal = {
    cardFund: Account;
    recipient: Account;
    asset: Asset;
    amount: uint64;
    createdAt: uint64;
    expiresAt: uint64;
    nonce: uint64;
    type: string;
};

// eslint-disable-next-line no-unused-vars
class Placeholder extends Pausable {
    // Updatable and destroyable placeholder contract
    @abimethod({ allowActions: ['NoOp'], onCreate: 'require' })
    deploy(): void {
        this._transferOwnership(Txn.sender);
        this._pauser.value = Txn.sender;
    }

    @abimethod({ allowActions: ['UpdateApplication'] })
    update(): void {
        assert(Txn.sender === Global.creatorAddress, 'SENDER_NOT_ALLOWED');
    }

    @abimethod({ allowActions: ['DeleteApplication'] })
    destroy(): void {
        assert(Txn.sender === Global.creatorAddress, 'SENDER_NOT_ALLOWED');
    }
}

class ControlledAddress extends Contract {
    /**
     * Create a new account, rekeying it to the caller application address
     * @returns New account address
     */
    @abimethod({ allowActions: ['DeleteApplication'], onCreate: 'require' })
    new(): Account {
        itxn.payment({
            receiver: Global.currentApplicationAddress,
            amount: 0,
            rekeyTo: Global.callerApplicationAddress,
        }).submit();

        return Global.currentApplicationAddress;
    }
}

export class Master extends Recoverable {
    // ========== Storage ==========
    // Card Funds
    card_funds = BoxMap<Account, CardFundData>({ keyPrefix: 'cf' });

    card_funds_active_count = GlobalState<uint64>({ key: 'cfac' });

    // Partner Channels
    partner_channels = BoxMap<Account, string>({ keyPrefix: 'pc' });

    partner_channels_active_count = GlobalState<uint64>({ key: 'pcac' });

    // Seconds to wait
    withdrawal_wait_time = GlobalState<uint64>({ key: 'wwt' });

    // Early withdrawal public key
    early_withdrawal_pubkey = GlobalState<bytes<32>>({ key: 'ewpk' });

    // Withdrawal requests
    // Only one allowed at any given point. MBR is sponsored by the contract owner (app account).
    withdrawals = BoxMap<Account, PermissionlessWithdrawalRequest>({ keyPrefix: 'wr' });

    // Settlement nonce
    settlement_nonce = GlobalState<uint64>({ key: 'sn' });

    // Settlement address
    settlement_address = BoxMap<Asset, Account>({ keyPrefix: 'sa' });

    // Refund address
    refund_address = GlobalState<Account>({ key: 'ra' });

    // ========== Internal Utils ==========
    /**
     * Check if the current transaction sender is the Card Fund holder/owner
     * @param cardFund Card Fund address
     * @returns True if the sender is the Card Holder of the card
     */
    private isCardFundOwner(cardFund: Account): boolean {
        assert(this.card_funds(cardFund).exists, 'CARD_FUND_NOT_FOUND');
        return this.card_funds(cardFund).value.owner === Txn.sender;
    }

    /**
     * Opt-in a Card Fund into an asset. Minimum balance requirement must be met prior to calling this function.
     * @param cardFund Card Fund address
     * @param asset Asset to opt-in to
     */
    private cardFundAssetOptIn(cardFund: Account, asset: Asset): void {
        // Only proceed if the master allowlist accepts it
        const [_assetBal, optedIn] = op.AssetHolding.assetBalance(Global.currentApplicationAddress, asset);
        assert(optedIn, 'ASSET_NOT_OPTED_IN');

        itxn.assetTransfer({
            sender: cardFund,
            assetReceiver: cardFund,
            xferAsset: asset,
            assetAmount: 0,
        }).submit();

        emit<CardFundAssetEnabled>({
            cardFund: cardFund,
            asset: asset,
        });
    }

    private cardFundAssetCloseOut(cardFund: Account, asset: Asset): void {
        itxn.assetTransfer({
            sender: cardFund,
            assetReceiver: cardFund,
            assetCloseTo: cardFund,
            xferAsset: asset,
            assetAmount: 0,
        }).submit();

        itxn.payment({
            sender: cardFund,
            receiver: Txn.sender,
            amount: this.getCardFundAssetMbr(),
        }).submit();

        emit<CardFundAssetDisabled>({
            cardFund: cardFund,
            asset: asset,
        });
    }

    private withdrawFunds(
        cardFund: Account,
        asset: Asset,
        amount: uint64,
        timestamp: uint64,
        nonce: uint64,
        withdrawalType: string
    ): void {
        // if amount is zero, we skip the asset transfer
        if (amount > 0) {
            itxn.assetTransfer({
                sender: cardFund,
                assetReceiver: Txn.sender,
                xferAsset: asset,
                assetAmount: amount,
            }).submit();
        }

        // Emit withdrawal event
        emit<Withdrawal>({
            cardFund: cardFund,
            recipient: Txn.sender,
            asset: asset,
            amount: amount,
            createdAt: withdrawalType === WithdrawalTypePermissionLess ? timestamp : 0,
            expiresAt: withdrawalType === WithdrawalTypeApproved ? timestamp : 0,
            nonce: nonce,
            type: withdrawalType,
        });

        this.card_funds(cardFund).value.withdrawalNonce = nonce + 1;
    }

    private updateSettlementAddress(asset: Asset, newSettlementAddress: Account): void {
        const oldSettlementAddress = this.settlement_address(asset).exists
            ? this.settlement_address(asset).value
            : Global.zeroAddress;
        this.settlement_address(asset).value = newSettlementAddress;

        emit<SettlementAddressChanged>({
            oldSettlementAddress: oldSettlementAddress,
            newSettlementAddress: newSettlementAddress,
        });
    }

    // ========== External Methods ==========
    /**
     * Deploy a partner channel, setting the owner as provided
     */
    @abimethod({ allowActions: ['NoOp'], onCreate: 'require' })
    deploy(owner: Account): Account {
        this._transferOwnership(owner);
        this._pauser.value = Txn.sender;

        return Global.currentApplicationAddress;
    }

    /**
     * Allows the owner to update the smart contract
     */
    @abimethod({ allowActions: ['UpdateApplication'] })
    update(): void {
        this.onlyOwner();

        // Initialize global counters on first upgrade from the placeholder contract.
        // puya-ts does not auto-zero-init GlobalState, so set them explicitly if unset.
        if (!this.card_funds_active_count.hasValue) {
            this.card_funds_active_count.value = 0;
        }
        if (!this.partner_channels_active_count.hasValue) {
            this.partner_channels_active_count.value = 0;
        }
        if (!this.settlement_nonce.hasValue) {
            this.settlement_nonce.value = 0;
        }
        if (!this.paused.hasValue) {
            this.paused.value = false;
        }
    }

    /**
     * Destroy the smart contract, sending all Algo to the owner account. This can only be done if there are no active card funds
     */
    @abimethod({ allowActions: ['DeleteApplication'] })
    destroy(): void {
        this.onlyOwner();

        // There must not be any active card fund
        assert(!this.card_funds_active_count.value, 'CARD_FUNDS_STILL_ACTIVE');
        // There must not be any active partner channels
        assert(!this.partner_channels_active_count.value, 'PARTNER_CHANNELS_STILL_ACTIVE');

        itxn.payment({
            receiver: Global.currentApplicationAddress,
            amount: 0,
            closeRemainderTo: this.owner(),
        }).submit();
    }

    // ===== Owner Methods =====
    /**
     * Set the number of seconds a withdrawal request must wait until being withdrawn
     * @param seconds New number of seconds to wait
     */
    setWithdrawalTimeout(seconds: uint64): void {
        this.onlyOwner();

        this.withdrawal_wait_time.value = seconds;
    }

    /**
     * Sets the early withdrawal public key.
     * @param pubkey - The public key to set.
     */
    setEarlyWithdrawalPubkey(pubkey: bytes<32>): void {
        this.onlyOwner();

        this.early_withdrawal_pubkey.value = pubkey;
    }

    /**
     * Retrieves the minimum balance requirement for creating a partner channel account.
     * @param partnerChannelName - The name of the partner channel.
     * @returns The minimum balance requirement for creating a partner channel account.
     */
    getPartnerChannelMbr(partnerChannelName: string): uint64 {
        const boxCost: uint64 = 2500 + 400 * (3 + 32 + Bytes(partnerChannelName).length);
        return Global.minBalance + Global.minBalance + boxCost;
    }

    /**
     * Creates a partner channel account and associates it with the provided partner channel name.
     * Only the owner of the contract can call this function.
     *
     * @param mbr - The PayTxn object representing the payment transaction.
     * @param partnerChannelName - The name of the partner channel.
     * @returns The address of the newly created partner channel account.
     */
    partnerChannelCreate(mbr: gtxn.PaymentTxn, partnerChannelName: string): Account {
        assertMatch(mbr, {
            receiver: Global.currentApplicationAddress,
            amount: this.getPartnerChannelMbr(partnerChannelName),
        });

        // Create a new account
        const compiledPartner = compile(ControlledAddress);
        const partnerChannelAddr = arc4.abiCall<typeof ControlledAddress.prototype.new>({
            approvalProgram: compiledPartner.approvalProgram,
            clearStateProgram: compiledPartner.clearStateProgram,
            onCompletion: OnCompleteAction.DeleteApplication,
        }).returnValue;

        // Fund the account with a minimum balance
        itxn.payment({
            receiver: partnerChannelAddr,
            amount: Global.minBalance,
        }).submit();

        this.partner_channels(partnerChannelAddr).value = partnerChannelName;

        // Increment active partner channels
        this.partner_channels_active_count.value = this.partner_channels_active_count.value + 1;

        emit<PartnerChannelCreated>({
            partnerChannel: partnerChannelAddr,
            partnerChannelName: partnerChannelName,
        });

        return partnerChannelAddr;
    }

    partnerChannelClose(partnerChannel: Account): void {
        this.onlyOwner();

        itxn.payment({
            sender: partnerChannel,
            receiver: partnerChannel,
            amount: 0,
            closeRemainderTo: Txn.sender,
        }).submit();

        const partnerChannelSize: uint64 = Bytes(this.partner_channels(partnerChannel).value).length;
        const boxCost: uint64 = 2500 + 400 * (3 + 32 + partnerChannelSize);

        itxn.payment({
            receiver: Txn.sender,
            amount: boxCost,
        }).submit();

        // Delete the partner channel from the box
        this.partner_channels(partnerChannel).delete();

        // Decrement active partner channels
        this.partner_channels_active_count.value = this.partner_channels_active_count.value - 1;
    }

    /**
     * Retrieves the minimum balance requirement for creating a card fund account.
     * @param asset Asset to opt-in to. 0 = No asset opt-in
     * @returns Minimum balance requirement for creating a card fund account
     */
    getCardFundMbr(asset: Asset): uint64 {
        // TODO: Double check size requirement is accurate. The prefix doesn't seem right.
        // Box Cost: 2500 + 400 * (Prefix + Address + (partnerChannel + owner + address + nonce + withdrawalNonce))
        const boxCost: uint64 = 2500 + 400 * (3 + 32 + (32 + 32 + 32 + 8 + 8));
        const assetMbr: uint64 = asset.id ? Global.assetOptInMinBalance : 0;
        return Global.minBalance + assetMbr + boxCost;
    }

    /**
     * Create account. This generates a brand new account and funds the minimum balance requirement
     * @param mbr Payment transaction of minimum balance requirement
     * @param partnerChannel Funding Channel name
     * @param asset Asset to opt-in to. 0 = No asset opt-in
     * @returns Newly generated account used by their card
     */
    cardFundCreate(mbr: gtxn.PaymentTxn, partnerChannel: Account, asset: Asset): Account {
        assert(this.partner_channels(partnerChannel).exists, 'PARTNER_CHANNEL_NOT_FOUND');

        const cardFundData: CardFundData = {
            partnerChannel: partnerChannel,
            owner: Txn.sender,
            address: Global.zeroAddress,
            nonce: 0,
            withdrawalNonce: 0,
        };

        assertMatch(mbr, {
            receiver: Global.currentApplicationAddress,
            amount: this.getCardFundMbr(asset),
        });

        // Create a new account
        const compiledCardFund = compile(ControlledAddress);
        const cardFundAddr = arc4.abiCall<typeof ControlledAddress.prototype.new>({
            approvalProgram: compiledCardFund.approvalProgram,
            clearStateProgram: compiledCardFund.clearStateProgram,
            onCompletion: OnCompleteAction.DeleteApplication,
        }).returnValue;

        // Update the card fund data with the newly generated address
        cardFundData.address = cardFundAddr;

        // Fund the account with a minimum balance
        const assetMbr: uint64 = asset.id ? Global.assetOptInMinBalance : 0;
        itxn.payment({
            receiver: cardFundAddr,
            amount: Global.minBalance + assetMbr,
        }).submit();

        // Opt-in to the asset if provided
        if (asset.id) {
            this.cardFundAssetOptIn(cardFundAddr, asset);
        }

        // Store new card along with Card Holder
        this.card_funds(cardFundAddr).value = clone(cardFundData);

        // Increment active card funds
        this.card_funds_active_count.value = this.card_funds_active_count.value + 1;

        emit<CardFundCreated>({
            cardFundOwner: Txn.sender,
            cardFund: cardFundAddr,
            partnerChannel: partnerChannel,
        });

        // Return the new account address
        return cardFundAddr;
    }

    /**
     * Close account. This permanently removes the rekey and deletes the account from the ledger
     * @param cardFund Address to close
     */
    cardFundClose(cardFund: Account): void {
        assert(this.isOwner() || this.isCardFundOwner(cardFund), 'SENDER_NOT_ALLOWED');

        itxn.payment({
            sender: cardFund,
            receiver: cardFund,
            amount: 0,
            closeRemainderTo: Txn.sender,
        }).submit();

        const cardFundSize: uint64 = 112; // CardFundData: 3x Account(32) + 2x uint64(8) = 112 bytes
        const boxCost: uint64 = 2500 + 400 * (1 + 32 + cardFundSize);

        itxn.payment({
            receiver: Txn.sender,
            amount: boxCost,
        }).submit();

        // Delete the card from the box
        this.card_funds(cardFund).delete();

        // Decrement active card funds
        this.card_funds_active_count.value = this.card_funds_active_count.value - 1;
    }

    /**
     * Recovers funds from an old card and transfers them to a new card.
     * Only the owner of the contract can perform this operation.
     *
     * @param cardFund - The card fund to recover.
     * @param newCardFundHolder - The address of the new card holder.
     */
    cardFundRecover(cardFund: Account, newCardFundHolder: Account): void {
        this.onlyOwner();

        // eslint-disable-next-line no-unused-vars
        const oldCardFundHolder = this.card_funds(cardFund).value.owner;
        this.card_funds(cardFund).value.owner = newCardFundHolder;

        // TODO: Emit CardFundRecovered
    }

    /**
     * Retrieves the minimum balance requirement for adding an asset to the allowlist.
     * @returns Minimum balance requirement for adding an asset to the allowlist
     */
    getAssetAllowlistMbr(): uint64 {
        // Box Cost: 2500 + 400 * (Prefix + AssetID + Address)
        const ASSET_SETTLEMENT_ADDRESS_COST: uint64 = 2500 + 400 * (2 + 8 + 32);
        return Global.assetOptInMinBalance + ASSET_SETTLEMENT_ADDRESS_COST;
    }

    /**
     * Allows the master contract to flag intent of accepting an asset.
     *
     * @param mbr Payment transaction of minimum balance requirement.
     * @param asset The AssetID of the asset being transferred.
     */
    assetAllowlistAdd(mbr: gtxn.PaymentTxn, asset: Asset, settlementAddress: Account): void {
        this.onlyOwner();

        assertMatch(mbr, {
            receiver: Global.currentApplicationAddress,
            amount: this.getAssetAllowlistMbr(),
        });

        itxn.assetTransfer({
            sender: Global.currentApplicationAddress,
            assetReceiver: Global.currentApplicationAddress,
            xferAsset: asset,
            assetAmount: 0,
        }).submit();

        emit<AssetAllowlistAdded>({ asset: asset });

        this.updateSettlementAddress(asset, settlementAddress);
    }

    /**
     * Allows the master contract to reject accepting an asset.
     *
     * @param asset - The AssetID of the asset being transferred.
     */
    assetAllowlistRemove(asset: Asset): void {
        this.onlyOwner();

        // Asset balance must be zero to close out of it. Consider settling the asset balance before revoking it.
        itxn.assetTransfer({
            sender: Global.currentApplicationAddress,
            assetReceiver: Global.currentApplicationAddress,
            assetCloseTo: Global.currentApplicationAddress,
            xferAsset: asset,
            assetAmount: 0,
        }).submit();

        // Delete the settlement address, freeing up MBR
        this.settlement_address(asset).delete();

        itxn.payment({
            receiver: Txn.sender,
            amount: this.getAssetAllowlistMbr(),
        }).submit();

        emit<AssetAllowlistRemoved>({ asset: asset });
    }

    /**
     * Debits the specified amount of the given asset from the card account.
     * Only the owner of the contract can perform this operation.
     *
     * @param cardFund The card fund from which the asset will be debited.
     * @param asset The asset to be debited.
     * @param amount The amount of the asset to be debited.
     */
    cardFundDebit(cardFund: Account, asset: Asset, amount: uint64, nonce: uint64, ref: string): void {
        this.whenNotPaused();
        this.onlyOwner();

        // Ensure the nonce is correct
        const nextNonce: uint64 = this.card_funds(cardFund).value.nonce;
        assert(nextNonce === nonce, 'NONCE_INVALID');

        itxn.assetTransfer({
            sender: cardFund,
            assetReceiver: Global.currentApplicationAddress,
            xferAsset: asset,
            assetAmount: amount,
            note: ref,
        }).submit();

        emit<Debit>({
            card: cardFund,
            asset: asset,
            amount: amount,
            nonce: nonce,
            reference: ref,
        });

        // Increment the nonce
        this.card_funds(cardFund).value.nonce = nextNonce + 1;
    }

    /**
     * Retrieves the refund address.
     *
     * @returns The refund address.
     */
    @abimethod({ readonly: true })
    getRefundAddress(): Account {
        return this.refund_address.value;
    }

    /**
     * Sets the refund address.
     * Only the owner of the contract can call this method.
     *
     * @param newRefundAddress The new refund address to be set.
     */
    setRefundAddress(newRefundAddress: Account): void {
        this.onlyOwner();

        this.refund_address.value = newRefundAddress;
    }

    /**
     * Refunds a specified amount of an asset to a card account.
     * Only the owner of the contract can perform this operation.
     *
     * @param cardFund - The card account to refund the asset to.
     * @param asset - The asset to refund.
     * @param amount - The amount of the asset to refund.
     */
    cardFundRefund(cardFund: Account, asset: Asset, amount: uint64, nonce: uint64): void {
        this.whenNotPaused();

        assert(Txn.sender === this.refund_address.value, 'SENDER_NOT_ALLOWED');

        // Ensure the nonce is correct
        const nextNonce: uint64 = this.card_funds(cardFund).value.nonce;
        assert(nextNonce === nonce, 'NONCE_INVALID');

        itxn.assetTransfer({
            sender: Global.currentApplicationAddress,
            assetReceiver: cardFund,
            xferAsset: asset,
            assetAmount: amount,
        }).submit();

        emit<Refund>({
            card: cardFund,
            asset: asset,
            amount: amount,
            nonce: nonce,
        });

        // Increment the nonce
        this.card_funds(cardFund).value.nonce = nextNonce + 1;
    }

    /**
     * Retrieves the next available nonce for settlements.
     *
     * @returns The settlement nonce.
     */
    @abimethod({ readonly: true })
    getNextSettlementNonce(): uint64 {
        return this.settlement_nonce.value;
    }

    /**
     * Retrieves the next available nonce for the card fund.
     *
     * @param cardFund The card fund address.
     * @returns The nonce for the card fund.
     */
    @abimethod({ readonly: true })
    getNextCardFundNonce(cardFund: Account): uint64 {
        return this.card_funds(cardFund).value.nonce;
    }

    /**
     * Retrieves the next available nonce for the card fund.
     *
     * @param cardFund The card fund address.
     * @returns The nonce for the card fund.
     */
    @abimethod({ readonly: true })
    getCardFundWithdrawalNonce(cardFund: Account): uint64 {
        return this.card_funds(cardFund).value.withdrawalNonce;
    }

    /**
     * Retrieves the card fund data for a given card fund address.
     *
     * @param cardFund The address of the card fund.
     * @returns The card fund data.
     */
    @abimethod({ readonly: true })
    getCardFundData(cardFund: Account): CardFundData {
        return this.card_funds(cardFund).value;
    }

    /**
     * Retrieves the settlement address for the specified asset.
     *
     * @param asset The ID of the asset.
     * @returns The settlement address for the asset.
     */
    @abimethod({ readonly: true })
    getSettlementAddress(asset: Asset): Account {
        return this.settlement_address(asset).value;
    }

    /**
     * Sets the settlement address for a given settlement asset.
     * Only the owner of the contract can call this method.
     *
     * @param settlementAsset The ID of the settlement asset.
     * @param newSettlementAddress The new settlement address to be set.
     */
    setSettlementAddress(settlementAsset: Asset, newSettlementAddress: Account): void {
        this.onlyOwner();

        this.updateSettlementAddress(settlementAsset, newSettlementAddress);
    }

    /**
     * Settles a payment by transferring an asset to the specified recipient.
     * Only the owner of the contract can call this function.
     *
     * @param asset The asset to be transferred.
     * @param amount The amount of the asset to be transferred.
     * @param nonce The nonce to prevent duplicate settlements.
     */
    settle(asset: Asset, amount: uint64, nonce: uint64): void {
        this.whenNotPaused();
        this.onlyOwner();

        // Ensure the nonce is correct
        assert(this.settlement_nonce.value === nonce, 'NONCE_INVALID');

        itxn.assetTransfer({
            sender: Global.currentApplicationAddress,
            assetReceiver: this.settlement_address(asset).value,
            xferAsset: asset,
            assetAmount: amount,
        }).submit();

        emit<Settlement>({
            recipient: this.settlement_address(asset).value,
            asset: asset,
            amount: amount,
            nonce: nonce,
        });

        // Increment the settlement nonce
        this.settlement_nonce.value = this.settlement_nonce.value + 1;
    }

    /**
     * Retrieves the minimum balance requirement for adding an asset to the card fund.
     * @returns The minimum balance requirement for adding an asset to the card fund.
     */
    getCardFundAssetMbr(): uint64 {
        return Global.assetOptInMinBalance;
    }

    // ===== Card Holder Methods =====
    /**
     * Allows the depositor (or owner) to OptIn to an asset, increasing the minimum balance requirement of the account
     *
     * @param cardFund Address to add asset to
     * @param asset Asset to add
     */
    cardFundEnableAsset(mbr: gtxn.PaymentTxn, cardFund: Account, asset: Asset): void {
        assert(this.isOwner() || this.isCardFundOwner(cardFund), 'SENDER_NOT_ALLOWED');

        assertMatch(mbr, {
            receiver: Global.currentApplicationAddress,
            amount: this.getCardFundAssetMbr(),
        });

        itxn.payment({
            receiver: cardFund,
            amount: this.getCardFundAssetMbr(),
        }).submit();

        this.cardFundAssetOptIn(cardFund, asset);
    }

    /**
     * Allows the depositor (or owner) to CloseOut of an asset, reducing the minimum balance requirement of the account
     *
     * @param cardFund - The address of the card.
     * @param asset - The ID of the asset to be removed.
     */
    cardFundDisableAsset(cardFund: Account, asset: Asset): void {
        assert(this.isOwner() || this.isCardFundOwner(cardFund), 'SENDER_NOT_ALLOWED');

        this.cardFundAssetCloseOut(cardFund, asset);
    }

    /**
     * Allows the Card Holder (or contract owner) to send an amount of assets from the account
     * @param cardFund Address to withdraw from
     * @param asset Asset to withdraw
     * @param amount Amount to withdraw
     */
    @abimethod({ allowActions: ['NoOp'] })
    cardFundInitPermissionlessWithdrawal(
        cardFund: Account,
        asset: Asset,
        amount: uint64
    ): PermissionlessWithdrawalRequest {
        assert(this.isCardFundOwner(cardFund), 'SENDER_NOT_ALLOWED');
        const cardFundData = clone(this.card_funds(cardFund).value);
        const [balance, _optedIn] = op.AssetHolding.assetBalance(cardFund, asset);
        assert(amount <= balance, 'INSUFFICIENT_BALANCE');

        const withdrawal: PermissionlessWithdrawalRequest = {
            cardFund: cardFund,
            recipient: Txn.sender,
            asset: asset,
            amount: amount,
            createdAt: Global.latestTimestamp,
            nonce: cardFundData.withdrawalNonce,
        };

        this.withdrawals(Txn.sender).value = clone(withdrawal);

        emit<WithdrawalRequest>(withdrawal);

        return withdrawal;
    }

    /**
     * Allows the Card Holder (or contract owner) to cancel a withdrawal request
     * @param cardFund Address to withdraw from
     */
    cardFundWithdrawalCancel(cardFund: Account): void {
        assert(this.isCardFundOwner(cardFund), 'SENDER_NOT_ALLOWED');
        assert(this.withdrawals(Txn.sender).exists, 'WITHDRAWAL_REQUEST_NOT_FOUND');
        const withdrawal = clone(this.withdrawals(Txn.sender).value);
        this.withdrawals(Txn.sender).delete();
        emit<WithdrawalRequestCancelled>(withdrawal);
    }

    /**
     * Allows the Card Holder to send an amount of assets from the account
     * @param cardFund Address to withdraw from
     */
    @abimethod({ allowActions: ['NoOp'] })
    cardFundExecutePermissionlessWithdrawal(cardFund: Account, amount: uint64): void {
        assert(this.isCardFundOwner(cardFund), 'SENDER_NOT_ALLOWED');
        assert(this.withdrawals(Txn.sender).exists, 'WITHDRAWAL_REQUEST_NOT_FOUND');
        const cardFundData = clone(this.card_funds(cardFund).value);
        const withdrawal = clone(this.withdrawals(Txn.sender).value);
        assert(amount <= withdrawal.amount, 'AMOUNT_INVALID');
        assert(cardFundData.withdrawalNonce === withdrawal.nonce, 'NONCE_INVALID');

        const releaseTime: uint64 = withdrawal.createdAt + this.withdrawal_wait_time.value;
        assert(Global.latestTimestamp >= releaseTime, 'WITHDRAWAL_TIME_INVALID');

        // Issue the withdrawal
        this.withdrawFunds(
            cardFund,
            withdrawal.asset,
            amount,
            withdrawal.createdAt,
            withdrawal.nonce,
            WithdrawalTypePermissionLess
        );
        this.withdrawals(Txn.sender).delete();
    }

    /**
     * Withdraws funds before the withdrawal timestamp has lapsed, by using the early withdrawal signature provided by baanx.
     * @param cardFund - The address of the card.
     * @param asset - The ID of the asset to be withdrawn.
     * @param amount - The amount of the withdrawal.
     * @param expiresAt - The expiry of the withdrawal signature.
     * @param signature - The signature for early withdrawal.
     */
    cardFundExecuteApprovedWithdrawal(
        cardFund: Account,
        asset: Asset,
        amount: uint64,
        expiresAt: uint64,
        nonce: uint64,
        signature: bytes<64>
    ): void {
        assert(this.isCardFundOwner(cardFund), 'SENDER_NOT_ALLOWED');
        const cardFundData = clone(this.card_funds(cardFund).value);

        assert(Global.latestTimestamp < expiresAt, 'WITHDRAWAL_TIME_INVALID');
        assert(cardFundData.withdrawalNonce === nonce, 'NONCE_INVALID');

        // Build withdrawal bytes for hashing: cardFund(32) + recipient(32) + asset(8) + amount(8) + expiresAt(8) + nonce(8) + genesisHash(32)
        const withdrawalBytes: bytes = Bytes(cardFund.bytes)
            .concat(Bytes(Txn.sender.bytes))
            .concat(op.itob(asset.id))
            .concat(op.itob(amount))
            .concat(op.itob(expiresAt))
            .concat(op.itob(nonce))
            .concat(Bytes(Global.genesisHash));

        const withdrawal_hash = op.sha256(withdrawalBytes);

        // Need at least 2000 Opcode budget
        ensureBudget(2500);

        assert(
            op.ed25519verifyBare(withdrawal_hash, signature, this.early_withdrawal_pubkey.value),
            'SIGNATURE_INVALID'
        );

        // Issue the withdrawal
        this.withdrawFunds(cardFund, asset, amount, expiresAt, cardFundData.withdrawalNonce, WithdrawalTypeApproved);

        // An approved (early) withdrawal supersedes any pending permissionless request for
        // the sender. Clean it up to release its box MBR and avoid orphaning the box, since
        // issuing the withdrawal increments the nonce and makes the request un-executable.
        if (this.withdrawals(Txn.sender).exists) {
            this.withdrawals(Txn.sender).delete();
        }
    }
}
