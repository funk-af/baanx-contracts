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
    ensureBudget,
    arc4,
    itxn,
    op,
    compile,
    OnCompleteAction,
    clone,
    uint64,
    bytes,
} from '@algorandfoundation/algorand-typescript';
import { Recoverable } from './roles/Recoverable.algo';

// CardData
type CardData = {
    owner: Account;
    address: Account;
    nonce: uint64;
    withdrawalNonce: uint64;
};

// Withdrawal request for an amount of an asset, where the timestamp indicates the earliest it can be made
type PermissionlessWithdrawalRequest = {
    card: Account;
    recipient: Account;
    asset: Asset;
    amount: uint64;
    createdAt: uint64;
    nonce: uint64;
};

const WithdrawalTypeApproved = 'approved';
const WithdrawalTypePermissionLess = 'permissionless';

// ========== Event Types ==========
type CardCreated = {
    cardOwner: Account;
    card: Account;
};

type CardAssetEnabled = {
    card: Account;
    asset: Asset;
};

type CardAssetDisabled = {
    card: Account;
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
    card: Account;
    recipient: Account;
    asset: Asset;
    amount: uint64;
    createdAt: uint64;
    nonce: uint64;
};

type WithdrawalRequestCancelled = {
    card: Account;
    recipient: Account;
    asset: Asset;
    amount: uint64;
    createdAt: uint64;
    nonce: uint64;
};

type Withdrawal = {
    card: Account;
    recipient: Account;
    asset: Asset;
    amount: uint64;
    createdAt: uint64;
    expiresAt: uint64;
    nonce: uint64;
    type: string;
};

type ApprovedWithdrawalRequest = {
    card: Account;
    recipient: Account;
    asset: Asset;
    amount: uint64;
    expiresAt: uint64;
    nonce: uint64;
    genesisHash: bytes<32>;
};

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
    // Cards
    cards = BoxMap<Account, CardData>({ keyPrefix: 'cf' });

    cards_active_count = GlobalState<uint64>({ key: 'cfac' });

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
     * Check if the current transaction sender is the card holder/owner
     * @param card Card address
     * @returns True if the sender is the Card Holder of the card
     */
    private isCardOwner(card: Account): boolean {
        assert(this.cards(card).exists, 'CARD_NOT_FOUND');
        return this.cards(card).value.owner === Txn.sender;
    }

    /**
     * Opt-in a card into an asset. Minimum balance requirement must be met prior to calling this function.
     * @param card Card address
     * @param asset Asset to opt-in to
     */
    private cardAssetOptIn(card: Account, asset: Asset): void {
        // Only proceed if the master allowlist accepts it
        const [_assetBal, optedIn] = op.AssetHolding.assetBalance(Global.currentApplicationAddress, asset);
        assert(optedIn, 'ASSET_NOT_OPTED_IN');

        itxn.assetTransfer({
            sender: card,
            assetReceiver: card,
            xferAsset: asset,
            assetAmount: 0,
        }).submit();

        emit<CardAssetEnabled>({
            card: card,
            asset: asset,
        });
    }

    private cardAssetCloseOut(card: Account, asset: Asset): void {
        itxn.assetTransfer({
            sender: card,
            assetReceiver: card,
            assetCloseTo: card,
            xferAsset: asset,
            assetAmount: 0,
        }).submit();

        emit<CardAssetDisabled>({
            card: card,
            asset: asset,
        });
    }

    private withdrawFunds(
        card: Account,
        asset: Asset,
        amount: uint64,
        timestamp: uint64,
        nonce: uint64,
        withdrawalType: string
    ): void {
        // if amount is zero, we skip the asset transfer
        if (amount > 0) {
            itxn.assetTransfer({
                sender: card,
                assetReceiver: Txn.sender,
                xferAsset: asset,
                assetAmount: amount,
            }).submit();
        }

        // Emit withdrawal event
        emit<Withdrawal>({
            card: card,
            recipient: Txn.sender,
            asset: asset,
            amount: amount,
            createdAt: withdrawalType === WithdrawalTypePermissionLess ? timestamp : 0,
            expiresAt: withdrawalType === WithdrawalTypeApproved ? timestamp : 0,
            nonce: nonce,
            type: withdrawalType,
        });

        this.cards(card).value.withdrawalNonce = nonce + 1;
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
     * Deploy the contract, setting the owner as provided and initializing global state.
     */
    @abimethod({ allowActions: ['NoOp'], onCreate: 'require' })
    deploy(owner: Account): Account {
        this._transferOwnership(owner);
        this._pauser.value = Txn.sender;

        // puya-ts does not auto-zero-init GlobalState, so set the counters explicitly
        // at creation time.
        this.cards_active_count.value = 0;
        this.settlement_nonce.value = 0;
        this.paused.value = false;

        return Global.currentApplicationAddress;
    }

    /**
     * Allows the owner to update the smart contract
     */
    @abimethod({ allowActions: ['UpdateApplication'] })
    update(): void {
        this.onlyOwner();
    }

    /**
     * Destroy the smart contract, sending all Algo to the owner account. This can only be done if there are no active cards
     */
    @abimethod({ allowActions: ['DeleteApplication'] })
    destroy(): void {
        this.onlyOwner();

        // There must not be any active card
        assert(!this.cards_active_count.value, 'CARDS_STILL_ACTIVE');

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
     * Create a card. This generates a brand new account and funds the minimum balance requirement
     * from the contract (owner-sponsored). Only the owner can call this function.
     * @param cardOwner The card holder who will own/control the card
     * @param asset Asset to opt-in to. 0 = No asset opt-in
     * @returns Newly generated account used by their card
     */
    cardCreate(cardOwner: Account, asset: Asset): Account {
        this.onlyOwner();

        const cardData: CardData = {
            owner: cardOwner,
            address: Global.zeroAddress,
            nonce: 0,
            withdrawalNonce: 0,
        };

        // Create a new account
        const compiledCard = compile(ControlledAddress);
        const cardAddr = arc4.abiCall<typeof ControlledAddress.prototype.new>({
            approvalProgram: compiledCard.approvalProgram,
            clearStateProgram: compiledCard.clearStateProgram,
            onCompletion: OnCompleteAction.DeleteApplication,
        }).returnValue;

        // Update the card data with the newly generated address
        cardData.address = cardAddr;

        // Fund the account with a minimum balance
        const assetMbr: uint64 = asset.id ? Global.assetOptInMinBalance : 0;
        itxn.payment({
            receiver: cardAddr,
            amount: Global.minBalance + assetMbr,
        }).submit();

        // Opt-in to the asset if provided
        if (asset.id) {
            this.cardAssetOptIn(cardAddr, asset);
        }

        // Store new card along with Card Holder
        this.cards(cardAddr).value = clone(cardData);

        // Increment active cards
        this.cards_active_count.value = this.cards_active_count.value + 1;

        emit<CardCreated>({
            cardOwner: cardOwner,
            card: cardAddr,
        });

        // Return the new account address
        return cardAddr;
    }

    /**
     * Close account. This permanently removes the rekey and deletes the account from the ledger
     * @param card Address to close
     */
    cardClose(card: Account): void {
        assert(this.isOwner() || this.isCardOwner(card), 'SENDER_NOT_ALLOWED');

        // Close the card account back to the contract, returning its balance to the
        // owner-funded pool. Deleting the box releases its MBR back to the contract too.
        itxn.payment({
            sender: card,
            receiver: Global.currentApplicationAddress,
            amount: 0,
            closeRemainderTo: Global.currentApplicationAddress,
        }).submit();

        // Delete the card from the box
        this.cards(card).delete();

        // Decrement active cards
        this.cards_active_count.value = this.cards_active_count.value - 1;
    }

    /**
     * Recovers funds from an old card and transfers them to a new card.
     * Only the owner of the contract can perform this operation.
     *
     * @param card - The card to recover.
     * @param newCardHolder - The address of the new card holder.
     */
    cardRecover(card: Account, newCardHolder: Account): void {
        this.onlyOwner();

        // eslint-disable-next-line no-unused-vars
        const oldCardHolder = this.cards(card).value.owner;
        this.cards(card).value.owner = newCardHolder;

        // TODO: Emit CardRecovered
    }

    /**
     * Allows the master contract to flag intent of accepting an asset. The box MBR and asset
     * opt-in are funded from the contract (owner-sponsored).
     *
     * @param asset The AssetID of the asset being transferred.
     * @param settlementAddress The address settlements for this asset are sent to.
     */
    assetAllowlistAdd(asset: Asset, settlementAddress: Account): void {
        this.onlyOwner();

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
     * Allows the master contract to reject accepting an asset. The freed MBR remains in the
     * contract (owner-sponsored pool).
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

        emit<AssetAllowlistRemoved>({ asset: asset });
    }

    /**
     * Debits the specified amount of the given asset from the card account.
     * Only the owner of the contract can perform this operation.
     *
     * @param card The card from which the asset will be debited.
     * @param asset The asset to be debited.
     * @param amount The amount of the asset to be debited.
     */
    cardDebit(card: Account, asset: Asset, amount: uint64, nonce: uint64, ref: string): void {
        this.whenNotPaused();
        this.onlyOwner();

        // Ensure the nonce is correct
        const nextNonce: uint64 = this.cards(card).value.nonce;
        assert(nextNonce === nonce, 'NONCE_INVALID');

        itxn.assetTransfer({
            sender: card,
            assetReceiver: Global.currentApplicationAddress,
            xferAsset: asset,
            assetAmount: amount,
            note: ref,
        }).submit();

        emit<Debit>({
            card: card,
            asset: asset,
            amount: amount,
            nonce: nonce,
            reference: ref,
        });

        // Increment the nonce
        this.cards(card).value.nonce = nextNonce + 1;
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
     * @param card - The card account to refund the asset to.
     * @param asset - The asset to refund.
     * @param amount - The amount of the asset to refund.
     */
    cardRefund(card: Account, asset: Asset, amount: uint64, nonce: uint64): void {
        this.whenNotPaused();

        assert(Txn.sender === this.refund_address.value, 'SENDER_NOT_ALLOWED');

        // Ensure the nonce is correct
        const nextNonce: uint64 = this.cards(card).value.nonce;
        assert(nextNonce === nonce, 'NONCE_INVALID');

        itxn.assetTransfer({
            sender: Global.currentApplicationAddress,
            assetReceiver: card,
            xferAsset: asset,
            assetAmount: amount,
        }).submit();

        emit<Refund>({
            card: card,
            asset: asset,
            amount: amount,
            nonce: nonce,
        });

        // Increment the nonce
        this.cards(card).value.nonce = nextNonce + 1;
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
     * Retrieves the next available nonce for the card.
     *
     * @param card The card address.
     * @returns The nonce for the card.
     */
    @abimethod({ readonly: true })
    getNextCardNonce(card: Account): uint64 {
        return this.cards(card).value.nonce;
    }

    /**
     * Retrieves the next available withdrawal nonce for the card.
     *
     * @param card The card address.
     * @returns The withdrawal nonce for the card.
     */
    @abimethod({ readonly: true })
    getCardWithdrawalNonce(card: Account): uint64 {
        return this.cards(card).value.withdrawalNonce;
    }

    /**
     * Retrieves the card data for a given card address.
     *
     * @param card The address of the card.
     * @returns The card data.
     */
    @abimethod({ readonly: true })
    getCardData(card: Account): CardData {
        return this.cards(card).value;
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

    // ===== Card Holder Methods =====
    /**
     * Opts a card into an asset, increasing its minimum balance requirement. The opt-in MBR is
     * funded from the contract (owner-sponsored). Only the owner can call this function.
     *
     * @param card Address to add asset to
     * @param asset Asset to add
     */
    cardEnableAsset(card: Account, asset: Asset): void {
        this.onlyOwner();

        itxn.payment({
            receiver: card,
            amount: Global.assetOptInMinBalance,
        }).submit();

        this.cardAssetOptIn(card, asset);
    }

    /**
     * Allows the card holder (or owner) to CloseOut of an asset, reducing the minimum balance
     * requirement of the account. The freed MBR remains within the card account.
     *
     * @param card - The address of the card.
     * @param asset - The ID of the asset to be removed.
     */
    cardDisableAsset(card: Account, asset: Asset): void {
        assert(this.isOwner() || this.isCardOwner(card), 'SENDER_NOT_ALLOWED');

        this.cardAssetCloseOut(card, asset);
    }

    /**
     * Allows the card holder to request a withdrawal of an amount of assets from the account
     * @param card Address to withdraw from
     * @param asset Asset to withdraw
     * @param amount Amount to withdraw
     */
    @abimethod({ allowActions: ['NoOp'] })
    cardWithdrawalRequest(card: Account, asset: Asset, amount: uint64): PermissionlessWithdrawalRequest {
        assert(this.isCardOwner(card), 'SENDER_NOT_ALLOWED');
        const cardData = clone(this.cards(card).value);
        const [balance, _optedIn] = op.AssetHolding.assetBalance(card, asset);
        assert(amount <= balance, 'INSUFFICIENT_BALANCE');

        const withdrawal: PermissionlessWithdrawalRequest = {
            card: card,
            recipient: Txn.sender,
            asset: asset,
            amount: amount,
            createdAt: Global.latestTimestamp,
            nonce: cardData.withdrawalNonce,
        };

        this.withdrawals(Txn.sender).value = clone(withdrawal);

        emit<WithdrawalRequest>(withdrawal);

        return withdrawal;
    }

    /**
     * Allows the card holder to cancel a withdrawal request
     * @param card Address to withdraw from
     */
    cardWithdrawalCancel(card: Account): void {
        assert(this.isCardOwner(card), 'SENDER_NOT_ALLOWED');
        assert(this.withdrawals(Txn.sender).exists, 'WITHDRAWAL_REQUEST_NOT_FOUND');
        const withdrawal = clone(this.withdrawals(Txn.sender).value);
        this.withdrawals(Txn.sender).delete();
        emit<WithdrawalRequestCancelled>(withdrawal);
    }

    /**
     * Allows the card holder to send an amount of assets from the account
     * @param card Address to withdraw from
     */
    @abimethod({ allowActions: ['NoOp'] })
    cardWithdraw(card: Account, amount: uint64): void {
        assert(this.isCardOwner(card), 'SENDER_NOT_ALLOWED');
        assert(this.withdrawals(Txn.sender).exists, 'WITHDRAWAL_REQUEST_NOT_FOUND');
        const cardData = clone(this.cards(card).value);
        const withdrawal = clone(this.withdrawals(Txn.sender).value);
        assert(amount <= withdrawal.amount, 'AMOUNT_INVALID');
        assert(cardData.withdrawalNonce === withdrawal.nonce, 'NONCE_INVALID');

        const releaseTime: uint64 = withdrawal.createdAt + this.withdrawal_wait_time.value;
        assert(Global.latestTimestamp >= releaseTime, 'WITHDRAWAL_TIME_INVALID');

        // Issue the withdrawal
        this.withdrawFunds(
            card,
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
     * @param card - The address of the card.
     * @param asset - The ID of the asset to be withdrawn.
     * @param amount - The amount of the withdrawal.
     * @param expiresAt - The expiry of the withdrawal signature.
     * @param signature - The signature for early withdrawal.
     */
    cardWithdrawPermissioned(
        card: Account,
        asset: Asset,
        amount: uint64,
        expiresAt: uint64,
        nonce: uint64,
        signature: bytes<64>
    ): void {
        assert(this.isCardOwner(card), 'SENDER_NOT_ALLOWED');
        const cardData = clone(this.cards(card).value);

        assert(Global.latestTimestamp < expiresAt, 'WITHDRAWAL_TIME_INVALID');
        assert(cardData.withdrawalNonce === nonce, 'NONCE_INVALID');

        const withdrawal: ApprovedWithdrawalRequest = {
            card,
            recipient: Txn.sender,
            asset,
            amount,
            expiresAt,
            nonce,
            genesisHash: Global.genesisHash,
        };

        const withdrawal_hash = op.sha256(arc4.encodeArc4(withdrawal));

        // Need at least 2000 Opcode budget
        ensureBudget(2500);

        assert(
            op.ed25519verifyBare(withdrawal_hash, signature, this.early_withdrawal_pubkey.value),
            'SIGNATURE_INVALID'
        );

        // Issue the withdrawal
        this.withdrawFunds(card, asset, amount, expiresAt, cardData.withdrawalNonce, WithdrawalTypeApproved);

        // An approved (early) withdrawal supersedes any pending permissionless request for
        // the sender. Clean it up to release its box MBR and avoid orphaning the box, since
        // issuing the withdrawal increments the nonce and makes the request un-executable.
        if (this.withdrawals(Txn.sender).exists) {
            this.withdrawals(Txn.sender).delete();
        }
    }
}
