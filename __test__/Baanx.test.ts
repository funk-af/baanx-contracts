/* eslint-disable import/no-extraneous-dependencies */
import { describe, test, expect, beforeAll } from '@jest/globals';
import algosdk from 'algosdk';
import nacl from 'tweetnacl';
import { Config } from '@algorandfoundation/algokit-utils';
import { AlgoAmount } from '@algorandfoundation/algokit-utils/types/amount';
import { algorandFixture } from '@algorandfoundation/algokit-utils/testing';
import { MasterClient } from '../client/MasterClient';
import type { PermissionlessWithdrawalRequest } from '../client/MasterClient';
import { PlaceholderFactory, PlaceholderClient } from '../client/PlaceholderClient';

const fixture = algorandFixture({ testAccountFunding: AlgoAmount.MicroAlgos(0) });

let placeholderClient: PlaceholderClient;
let appClient: MasterClient;

describe('Baanx', () => {
    let circle: algosdk.Account & algosdk.Address;
    let baanx: algosdk.Account & algosdk.Address;
    let user: algosdk.Account & algosdk.Address;
    let user2: algosdk.Account & algosdk.Address;
    let withdrawalAcc: algosdk.Account & algosdk.Address;

    let fakeUSDC: bigint;
    let newPartnerChannel: string;
    let newCardAddress: string;
    let withdrawalRequest: PermissionlessWithdrawalRequest;

    beforeAll(async () => {
        await fixture.beforeEach();
        Config.configure({ populateAppCallResources: true });
        const { algorand, generateAccount } = fixture.context;

        [baanx, user, user2, circle, withdrawalAcc] = await Promise.all([
            generateAccount({ initialFunds: AlgoAmount.Algos(10) }),
            generateAccount({ initialFunds: AlgoAmount.Algos(10) }),
            generateAccount({ initialFunds: AlgoAmount.Algos(10) }),
            generateAccount({ initialFunds: AlgoAmount.Algos(10) }),
            generateAccount({ initialFunds: AlgoAmount.Algos(10) }),
        ]);

        // Create FakeUSDC
        const created = await algorand.send.assetCreate({
            sender: circle.addr,
            assetName: 'FakeUSDC',
            unitName: 'FUSDC',
            total: BigInt(2) ** BigInt(64) - BigInt(1),
            decimals: 6,
            defaultFrozen: false,
            manager: circle.addr,
            reserve: circle.addr,
            freeze: circle.addr,
        });
        fakeUSDC = created.assetId;

        // OptIn and Send FUSDC
        await Promise.all([
            algorand.send.assetOptIn({ sender: baanx.addr, assetId: fakeUSDC }),
            algorand.send.assetOptIn({ sender: user.addr, assetId: fakeUSDC }),
            algorand.send.assetOptIn({ sender: user2.addr, assetId: fakeUSDC }),
        ]);
        await algorand.send.assetTransfer({
            sender: circle.addr,
            receiver: user.addr,
            assetId: fakeUSDC,
            amount: 100_000_000n,
        });

        // Deploy the Placeholder contract
        const factory = algorand.client.getTypedAppFactory(PlaceholderFactory, {
            defaultSender: baanx.addr,
        });

        const deployment = await factory.send.create.deploy({
            args: [],
            extraProgramPages: 3,
            schema: {
                globalInts: 32,
                globalByteSlices: 32,
                localInts: 8,
                localByteSlices: 8,
            },
        });
        placeholderClient = deployment.appClient;

        // FIX: Do I need to fund the app account?
        await placeholderClient.appClient.fundAppAccount({ amount: AlgoAmount.MicroAlgos(100_000) });
    });

    test('Upgrade Placeholder with Master', async () => {
        const { algorand } = fixture.context;

        appClient = algorand.client.getTypedAppClientById(MasterClient, {
            appId: placeholderClient.appId,
            defaultSender: baanx.addr,
        });

        const result = await appClient.send.update.update({
            args: [],
            staticFee: AlgoAmount.MicroAlgos(1_000),
        });

        expect(result.confirmation.poolError).toBe('');
    });

    test('Initialize Master state', async () => {
        // The first upgrade is authorized by the Placeholder's `update`, so the Master's
        // `update` (which zero-inits the global counters) does not run until the next
        // update call. Run it once now to initialize state before using the contract.
        const result = await appClient.send.update.update({
            args: [],
            staticFee: AlgoAmount.MicroAlgos(1_000),
        });

        expect(result.confirmation.poolError).toBe('');
    });

    test('Set withdrawal rounds to 0', async () => {
        // A real value would be:
        // 60 * 60 * 24 * 5 = 432_000 seconds = 5 days
        // We're using 0 seconds to allow for instant withdrawals
        const result = await appClient.send.setWithdrawalTimeout({ args: { seconds: 0 } });

        expect(result.confirmation.poolError).toBe('');
    });

    test('Set early withdrawal public key', async () => {
        const result = await appClient.send.setEarlyWithdrawalPubkey({
            args: { pubkey: withdrawalAcc.addr.publicKey },
            staticFee: AlgoAmount.MicroAlgos(1_000),
        });

        expect(result.confirmation.poolError).toBe('');
    });

    test('Allowlist Add FakeUSDC', async () => {
        const { algorand } = fixture.context;

        const mbr = await algorand.createTransaction.payment({
            sender: baanx.addr,
            receiver: appClient.appAddress,
            amount: AlgoAmount.MicroAlgos(100_000 + (2_500 + 400 * (2 + 8 + 32))), // Asset MBR + Box Cost
        });

        const result = await appClient.send.assetAllowlistAdd({
            args: {
                mbr,
                asset: fakeUSDC,
                settlementAddress: baanx.addr.toString(),
            },
            staticFee: AlgoAmount.MicroAlgos(2_000),
        });

        expect(result.confirmation.poolError).toBe('');
    });

    test('Recover Algo from Master', async () => {
        const { algorand } = fixture.context;

        await algorand.send.payment({
            sender: baanx.addr,
            receiver: appClient.appAddress,
            amount: AlgoAmount.MicroAlgos(1_000_000),
        });

        const recover = await appClient.send.recoverAsset({
            args: {
                amount: 1_000_000,
                asset: 0,
                recipient: baanx.addr.toString(),
            },
            staticFee: AlgoAmount.MicroAlgos(2_000),
        });

        expect(recover.confirmation.poolError).toBe('');
    });

    test('Recover ASA from Master', async () => {
        const { algorand } = fixture.context;

        await algorand.send.assetTransfer({
            sender: circle.addr,
            receiver: appClient.appAddress,
            assetId: fakeUSDC,
            amount: 10_000_000_000n,
        });

        const recover = await appClient.send.recoverAsset({
            args: {
                amount: 10_000_000_000,
                asset: fakeUSDC,
                recipient: baanx.addr.toString(),
            },
            staticFee: AlgoAmount.MicroAlgos(2_000),
        });

        expect(recover.confirmation.poolError).toBe('');
    });

    test('Create new partner', async () => {
        const { algorand } = fixture.context;

        const CHANNEL_NAME = 'Pera';

        const getMbr = await appClient.send.getPartnerChannelMbr({
            args: { partnerChannelName: CHANNEL_NAME },
            staticFee: AlgoAmount.MicroAlgos(1_000),
        });

        const mbr = await algorand.createTransaction.payment({
            sender: baanx.addr,
            receiver: appClient.appAddress,
            amount: AlgoAmount.MicroAlgos(getMbr.return!),
        });

        const result = await appClient.send.partnerChannelCreate({
            args: { mbr, partnerChannelName: CHANNEL_NAME },
            staticFee: AlgoAmount.MicroAlgos(5_000),
        });
        expect(result.return).toBeDefined();

        newPartnerChannel = result.return!;
    });

    test('Create new card without assets', async () => {
        const { algorand } = fixture.context;

        const getMbr = await appClient.send.getCardFundMbr({
            args: { asset: 0 },
            staticFee: AlgoAmount.MicroAlgos(1_000),
        });

        const mbr = await algorand.createTransaction.payment({
            sender: user2.addr,
            receiver: appClient.appAddress,
            amount: AlgoAmount.MicroAlgos(getMbr.return!),
        });
        const result = await appClient.send.cardFundCreate({
            args: {
                mbr,
                partnerChannel: newPartnerChannel,
                asset: 0,
            },
            sender: user2.addr,
            staticFee: AlgoAmount.MicroAlgos(4_000),
        });
        expect(result.return).toBeDefined();

        newCardAddress = result.return!;
    });

    test('Close card without assets', async () => {
        const result = await appClient.send.cardFundClose({
            args: { cardFund: newCardAddress },
            staticFee: AlgoAmount.MicroAlgos(3_000),
        });

        expect(result.confirmation.poolError).toBe('');
    });

    test('Create new card with FakeUSDC', async () => {
        const { algorand } = fixture.context;

        const getMbr = await appClient.send.getCardFundMbr({
            args: { asset: fakeUSDC },
            staticFee: AlgoAmount.MicroAlgos(1_000),
        });

        const mbr = await algorand.createTransaction.payment({
            sender: user.addr,
            receiver: appClient.appAddress,
            amount: AlgoAmount.MicroAlgos(getMbr.return!),
        });
        const result = await appClient.send.cardFundCreate({
            args: {
                mbr,
                partnerChannel: newPartnerChannel,
                asset: fakeUSDC,
            },
            sender: user.addr,
            staticFee: AlgoAmount.MicroAlgos(5_000),
        });
        expect(result.return).toBeDefined();

        newCardAddress = result.return!;
    });

    test('Disable FakeUSDC for card', async () => {
        const result = await appClient.send.cardFundDisableAsset({
            args: {
                cardFund: newCardAddress,
                asset: fakeUSDC,
            },
            sender: user.addr,
            staticFee: AlgoAmount.MicroAlgos(3_000),
        });

        expect(result.confirmation.poolError).toBe('');
    });

    test('Enable FakeUSDC for card', async () => {
        const { algorand } = fixture.context;

        const getMbr = await appClient.send.getCardFundAssetMbr({
            args: {},
            staticFee: AlgoAmount.MicroAlgos(1_000),
        });

        const mbr = await algorand.createTransaction.payment({
            sender: user.addr,
            receiver: appClient.appAddress,
            amount: AlgoAmount.MicroAlgos(getMbr.return!),
        });

        const result = await appClient.send.cardFundEnableAsset({
            args: {
                mbr,
                cardFund: newCardAddress,
                asset: fakeUSDC,
            },
            sender: user.addr,
            staticFee: AlgoAmount.MicroAlgos(3_000),
        });

        expect(result.confirmation.poolError).toBe('');
    });

    test('Deposit FakeUSDC to card', async () => {
        const { algorand } = fixture.context;

        const result = await algorand.send.assetTransfer({
            sender: user.addr,
            receiver: newCardAddress,
            assetId: fakeUSDC,
            amount: 10_000_000n,
        });

        expect(result.confirmation.poolError).toBeDefined();
    });

    test('User spends, Baanx debits', async () => {
        const nextNonce = await appClient.send.getNextCardFundNonce({
            args: { cardFund: newCardAddress },
        });

        const result = await appClient.send.cardFundDebit({
            args: {
                cardFund: newCardAddress,
                asset: fakeUSDC,
                amount: 5_000_000,
                nonce: nextNonce.return!,
                ref: 'Test Transaction REF-1234567890',
            },
            staticFee: AlgoAmount.MicroAlgos(2_000),
        });

        expect(result.confirmation.poolError).toBeDefined();
    });

    test('Get CardFundData', async () => {
        const result = await appClient.send.getCardFundData({
            args: { cardFund: newCardAddress },
            staticFee: AlgoAmount.MicroAlgos(1_000),
        });

        expect(result.return?.partnerChannel).toBe(newPartnerChannel);
        expect(result.return?.owner).toBe(user.addr.toString());
        expect(result.return?.address).toBe(newCardAddress);
        expect(result.return?.nonce).toEqual(BigInt(1));
    });

    test('Update Contract', async () => {
        const result = await appClient.send.update.update({
            args: [],
            staticFee: AlgoAmount.MicroAlgos(1_000),
        });

        expect(result.confirmation.poolError).toBe('');
    });

    test('Recover Card', async () => {
        const result = await appClient.send.cardFundRecover({
            args: {
                cardFund: newCardAddress,
                newCardFundHolder: user2.addr.toString(),
            },
            staticFee: AlgoAmount.MicroAlgos(1_000),
        });

        expect(result.confirmation.poolError).toBe('');
    });

    test('User creates withdrawal request', async () => {
        const result = await appClient.send.cardFundInitPermissionlessWithdrawal({
            args: {
                cardFund: newCardAddress,
                asset: fakeUSDC,
                amount: 3_000_000,
            },
            sender: user2.addr,
        });

        expect(result.return).toBeDefined();

        withdrawalRequest = result.return!;
    });

    test('Settle debits', async () => {
        const settlementNonce = await appClient.send.getNextSettlementNonce({
            args: {},
            staticFee: AlgoAmount.MicroAlgos(1_000),
        });

        const result = await appClient.send.settle({
            args: {
                asset: fakeUSDC,
                amount: 5_000_000,
                nonce: settlementNonce.return!,
            },
            staticFee: AlgoAmount.MicroAlgos(2_000),
        });

        expect(result.confirmation.poolError).toBe('');
    });

    test('Complete withdrawal request', async () => {
        const result = await appClient.send.cardFundExecutePermissionlessWithdrawal({
            args: {
                cardFund: newCardAddress,
                amount: withdrawalRequest.amount,
            },
            sender: user2.addr,
            staticFee: AlgoAmount.MicroAlgos(2_000),
        });

        expect(result.confirmation.poolError).toBe('');
    });

    test('Set withdrawal rounds to 10', async () => {
        // A real value would be:
        // 60 * 60 * 24 * 5 = 432_000 seconds = 5 days
        // We're using 0 seconds to allow for instant withdrawals
        const result = await appClient.send.setWithdrawalTimeout({ args: { seconds: 10 } });

        expect(result.confirmation.poolError).toBe('');
    });

    // TODO: cardWithdrawEarly test
    test('User creates another withdrawal request', async () => {
        const result = await appClient.send.cardFundInitPermissionlessWithdrawal({
            args: {
                cardFund: newCardAddress,
                asset: fakeUSDC,
                amount: 2_000_000,
            },
            sender: user2.addr,
        });

        expect(result.return).toBeDefined();

        withdrawalRequest = result.return!;
    });

    // Early Withdrawal Test
    test('Request early withdrawal', async () => {
        const { algorand } = fixture.context;
        const suggestedParams = await algorand.client.algod.getTransactionParams().do();
        const genesisHash = Buffer.from(suggestedParams.genesisHash!);

        const { cardFund: cardFundAddr, asset: withdrawalAsset, amount, nonce } = withdrawalRequest;
        const expiresAt = BigInt(Math.floor(Date.now() / 1000)) + BigInt(3600);

        // Build withdrawal bytes matching the contract: cardFund(32) + recipient(32) + asset(8) + amount(8) + expiresAt(8) + nonce(8) + genesisHash(32)
        const withdrawalBytes = Buffer.concat([
            algosdk.decodeAddress(cardFundAddr).publicKey,
            user2.addr.publicKey,
            algosdk.encodeUint64(withdrawalAsset),
            algosdk.encodeUint64(amount),
            algosdk.encodeUint64(expiresAt),
            algosdk.encodeUint64(nonce),
            genesisHash,
        ]);

        // SHA256 hash the bytes, then sign with ed25519
        const { createHash } = await import('crypto');
        const withdrawalHash = createHash('sha256').update(withdrawalBytes).digest();
        const sig = nacl.sign.detached(withdrawalHash, withdrawalAcc.sk);

        const result = await appClient.send.cardFundExecuteApprovedWithdrawal({
            args: {
                cardFund: newCardAddress,
                asset: fakeUSDC,
                amount,
                expiresAt,
                nonce,
                signature: sig,
            },
            sender: user2.addr,
            staticFee: AlgoAmount.MicroAlgos(2_000 + 3_000),
        });
        console.log(result.transaction.txID());

        expect(result.confirmation.poolError).toBe('');
    });

    test('Disable FakeUSDC for card', async () => {
        const result = await appClient.send.cardFundDisableAsset({
            args: {
                cardFund: newCardAddress,
                asset: fakeUSDC,
            },
            sender: user2.addr,
            staticFee: AlgoAmount.MicroAlgos(3_000),
        });

        expect(result.confirmation.poolError).toBe('');
    });

    test('Close card', async () => {
        const result = await appClient.send.cardFundClose({
            args: { cardFund: newCardAddress },
            staticFee: AlgoAmount.MicroAlgos(3_000),
        });

        expect(result.confirmation.poolError).toBe('');
    });

    test('Close Partner', async () => {
        const result = await appClient.send.partnerChannelClose({
            args: { partnerChannel: newPartnerChannel },
            staticFee: AlgoAmount.MicroAlgos(3_000),
        });

        expect(result.confirmation.poolError).toBe('');
    });

    test('Allowlist Remove FakeUSDC', async () => {
        const result = await appClient.send.assetAllowlistRemove({
            args: { asset: fakeUSDC },
            staticFee: AlgoAmount.MicroAlgos(3_000),
        });

        expect(result.confirmation.poolError).toBe('');
    });

    test('Destroy Contract', async () => {
        const result = await appClient.send.delete.destroy({
            args: [],
            staticFee: AlgoAmount.MicroAlgos(2_000),
        });

        expect(result.confirmation.poolError).toBe('');
    });
});
