/// <reference types="node" />
/* eslint-disable import/no-extraneous-dependencies */
import { describe, test, expect, beforeAll } from '@jest/globals';
import { readFileSync } from 'fs';
import { join } from 'path';
import algosdk from 'algosdk';
import nacl from 'tweetnacl';
import { Config } from '@algorandfoundation/algokit-utils';
import { AlgoAmount } from '@algorandfoundation/algokit-utils/types/amount';
import { algorandFixture } from '@algorandfoundation/algokit-utils/testing';
import { MasterClient, MasterFactory } from '../client/MasterClient';
import { KillswitchClient, KillswitchFactory } from '../client/KillswitchClient';
import type { PermissionlessWithdrawalRequest } from '../client/MasterClient';

const fixture = algorandFixture({ testAccountFunding: AlgoAmount.MicroAlgos(0) });

let appClient: MasterClient;
let ksClient: KillswitchClient;

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

    // AutoDraw-specific state (uses a separate card so the main flow stays intact)
    let autoDrawCardAddress: string;
    let autoDrawLsig: algosdk.LogicSigAccount;
    const AUTO_DRAW_DEBIT_AMOUNT = 5_000_000n;

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

        // Deploy the Master contract directly
        const factory = algorand.client.getTypedAppFactory(MasterFactory, {
            defaultSender: baanx.addr,
        });

        const deployment = await factory.send.create.deploy({
            args: [baanx.addr.toString()],
            extraProgramPages: 3,
            schema: {
                globalInts: 32,
                globalByteSlices: 32,
                localInts: 8,
                localByteSlices: 8,
            },
        });
        appClient = deployment.appClient;

        // Fund the app account to cover minimum balance requirements
        await appClient.appClient.fundAppAccount({ amount: AlgoAmount.MicroAlgos(100_000) });

        // Deploy the Killswitch contract (used by the AutoDraw delegation flow)
        const ksFactory = algorand.client.getTypedAppFactory(KillswitchFactory, {
            defaultSender: baanx.addr,
        });
        const ksDeployment = await ksFactory.send.create.deploy({
            args: [baanx.addr.toString()],
            schema: {
                globalInts: 8,
                globalByteSlices: 8,
                localInts: 0,
                localByteSlices: 0,
            },
        });
        ksClient = ksDeployment.appClient;

        // Fund Killswitch app for box MBR (2_500 + 400 * (32 + 2) = 16_100 per registration)
        await ksClient.appClient.fundAppAccount({ amount: AlgoAmount.MicroAlgos(200_000) });
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

    // ========== Killswitch unit tests ==========

    test('Killswitch: register user', async () => {
        const result = await ksClient.send.register({
            args: [],
            sender: user.addr,
        });
        expect(result.confirmation.poolError).toBe('');
    });

    test('Killswitch: authorize registered user succeeds', async () => {
        const result = await ksClient.send.authorize({
            args: { account: user.addr.toString() },
        });
        expect(result.confirmation.poolError).toBe('');
    });

    test('Killswitch: user disables themselves — authorize fails with USER_REFUSED', async () => {
        await ksClient.send.disable({ args: [], sender: user.addr });

        await expect(ksClient.send.authorize({ args: { account: user.addr.toString() } })).rejects.toThrow(
            'USER_REFUSED'
        );
    });

    test('Killswitch: user re-enables themselves — authorize succeeds', async () => {
        await ksClient.send.enable({ args: [], sender: user.addr });

        const result = await ksClient.send.authorize({
            args: { account: user.addr.toString() },
        });
        expect(result.confirmation.poolError).toBe('');
    });

    test('Killswitch: institution disables user — authorize fails with INSTITUTION_REFUSED', async () => {
        await ksClient.send.disableUser({ args: { account: user.addr.toString() } });

        await expect(ksClient.send.authorize({ args: { account: user.addr.toString() } })).rejects.toThrow(
            'INSTITUTION_REFUSED'
        );
    });

    test('Killswitch: institution re-enables user — authorize succeeds', async () => {
        await ksClient.send.enableUser({ args: { account: user.addr.toString() } });

        const result = await ksClient.send.authorize({
            args: { account: user.addr.toString() },
        });
        expect(result.confirmation.poolError).toBe('');
    });

    test('Killswitch: registering again fails with ALREADY_REGISTERED', async () => {
        await expect(ksClient.send.register({ args: [], sender: user.addr })).rejects.toThrow('ALREADY_REGISTERED');
    });

    test('Killswitch: authorize unregistered account fails with NOT_REGISTERED', async () => {
        await expect(ksClient.send.authorize({ args: { account: user2.addr.toString() } })).rejects.toThrow(
            'NOT_REGISTERED'
        );
    });

    test('Killswitch: pause contract — authorize fails', async () => {
        await ksClient.send.pause({ args: [] });

        await expect(ksClient.send.authorize({ args: { account: user.addr.toString() } })).rejects.toThrow();
    });

    test('Killswitch: unpause contract — authorize succeeds', async () => {
        await ksClient.send.unpause({ args: [] });

        const result = await ksClient.send.authorize({
            args: { account: user.addr.toString() },
        });
        expect(result.confirmation.poolError).toBe('');
    });

    // ========== AutoDraw integration tests ==========

    test('AutoDraw: create card for user', async () => {
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

        autoDrawCardAddress = result.return!;
    });

    test('AutoDraw: compile lsig and user signs for delegation', async () => {
        const { algorand } = fixture.context;
        const algod = algorand.client.algod;

        const tealTemplate = readFileSync(join(__dirname, '../dist/AutoDraw.teal'), 'utf-8');
        const teal = tealTemplate
            .replace('TMPL_ASSET', String(fakeUSDC))
            .replace('TMPL_KILLSWITCH_APP', String(ksClient.appId))
            .replace('TMPL_MASTER_APP', String(appClient.appId));

        const compiled = await algod.compile(teal).do();
        const program = Buffer.from(compiled.result, 'base64');

        autoDrawLsig = new algosdk.LogicSigAccount(program);
        autoDrawLsig.sign(user.sk);

        expect(autoDrawLsig.lsig.sig).toBeDefined();
    });

    test('AutoDraw: group debit succeeds from zero-balance card', async () => {
        const { algorand } = fixture.context;
        const algod = algorand.client.algod;

        const nonceResult = await appClient.send.getNextCardFundNonce({
            args: { cardFund: autoDrawCardAddress },
        });

        const suggestedParams = await algod.getTransactionParams().do();
        const axferTxn = algosdk.makeAssetTransferTxnWithSuggestedParamsFromObject({
            sender: user.addr.toString(),
            receiver: autoDrawCardAddress,
            assetIndex: Number(fakeUSDC),
            amount: AUTO_DRAW_DEBIT_AMOUNT,
            suggestedParams: { ...suggestedParams, flatFee: true, fee: 0 },
        });

        const composer = algorand.newGroup();
        // [0] AutoDraw lsig axfer: user's main account → card (fee=0)
        composer.addTransaction(axferTxn, algosdk.makeLogicSigAccountTransactionSigner(autoDrawLsig));
        // [1] Killswitch.authorize: validates user's switches and paused state
        composer.addAppCallMethodCall(
            await ksClient.params.authorize({
                args: { account: user.addr.toString() },
                staticFee: AlgoAmount.MicroAlgos(1_000),
            })
        );
        // [2] cardFundDebit: inner txn card→Master now sees the card funded by [0]
        composer.addAppCallMethodCall(
            await appClient.params.cardFundDebit({
                args: {
                    cardFund: autoDrawCardAddress,
                    asset: fakeUSDC,
                    amount: AUTO_DRAW_DEBIT_AMOUNT,
                    nonce: nonceResult.return!,
                    ref: 'AutoDraw Test REF-001',
                },
                staticFee: AlgoAmount.MicroAlgos(3_000),
            })
        );

        const result = await composer.send();
        expect(result.confirmations.every((c) => c.poolError === '')).toBe(true);
    });

    test('AutoDraw: card nonce incremented after debit', async () => {
        const result = await appClient.send.getCardFundData({
            args: { cardFund: autoDrawCardAddress },
        });
        expect(result.return?.nonce).toEqual(1n);
    });

    test('AutoDraw: group fails when user has disabled themselves', async () => {
        const { algorand } = fixture.context;
        const algod = algorand.client.algod;

        await ksClient.send.disable({ args: [], sender: user.addr });

        const nonceResult = await appClient.send.getNextCardFundNonce({
            args: { cardFund: autoDrawCardAddress },
        });

        const suggestedParams = await algod.getTransactionParams().do();
        const axferTxn = algosdk.makeAssetTransferTxnWithSuggestedParamsFromObject({
            sender: user.addr.toString(),
            receiver: autoDrawCardAddress,
            assetIndex: Number(fakeUSDC),
            amount: AUTO_DRAW_DEBIT_AMOUNT,
            suggestedParams: { ...suggestedParams, flatFee: true, fee: 0 },
        });

        const composer = algorand.newGroup();
        composer.addTransaction(axferTxn, algosdk.makeLogicSigAccountTransactionSigner(autoDrawLsig));
        composer.addAppCallMethodCall(
            await ksClient.params.authorize({
                args: { account: user.addr.toString() },
                staticFee: AlgoAmount.MicroAlgos(1_000),
            })
        );
        composer.addAppCallMethodCall(
            await appClient.params.cardFundDebit({
                args: {
                    cardFund: autoDrawCardAddress,
                    asset: fakeUSDC,
                    amount: AUTO_DRAW_DEBIT_AMOUNT,
                    nonce: nonceResult.return!,
                    ref: 'AutoDraw Test REF-002',
                },
                staticFee: AlgoAmount.MicroAlgos(3_000),
            })
        );

        await expect(composer.send()).rejects.toThrow('USER_REFUSED');

        await ksClient.send.enable({ args: [], sender: user.addr });
    });

    test('AutoDraw: group fails when Killswitch is paused', async () => {
        const { algorand } = fixture.context;
        const algod = algorand.client.algod;

        await ksClient.send.pause({ args: [] });

        const nonceResult = await appClient.send.getNextCardFundNonce({
            args: { cardFund: autoDrawCardAddress },
        });

        const suggestedParams = await algod.getTransactionParams().do();
        const axferTxn = algosdk.makeAssetTransferTxnWithSuggestedParamsFromObject({
            sender: user.addr.toString(),
            receiver: autoDrawCardAddress,
            assetIndex: Number(fakeUSDC),
            amount: AUTO_DRAW_DEBIT_AMOUNT,
            suggestedParams: { ...suggestedParams, flatFee: true, fee: 0 },
        });

        const composer = algorand.newGroup();
        composer.addTransaction(axferTxn, algosdk.makeLogicSigAccountTransactionSigner(autoDrawLsig));
        composer.addAppCallMethodCall(
            await ksClient.params.authorize({
                args: { account: user.addr.toString() },
                staticFee: AlgoAmount.MicroAlgos(1_000),
            })
        );
        composer.addAppCallMethodCall(
            await appClient.params.cardFundDebit({
                args: {
                    cardFund: autoDrawCardAddress,
                    asset: fakeUSDC,
                    amount: AUTO_DRAW_DEBIT_AMOUNT,
                    nonce: nonceResult.return!,
                    ref: 'AutoDraw Test REF-003',
                },
                staticFee: AlgoAmount.MicroAlgos(3_000),
            })
        );

        await expect(composer.send()).rejects.toThrow();

        await ksClient.send.unpause({ args: [] });
    });

    test('AutoDraw: settle debits', async () => {
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

    test('AutoDraw: disable FakeUSDC for card', async () => {
        const result = await appClient.send.cardFundDisableAsset({
            args: {
                cardFund: autoDrawCardAddress,
                asset: fakeUSDC,
            },
            sender: user.addr,
            staticFee: AlgoAmount.MicroAlgos(3_000),
        });

        expect(result.confirmation.poolError).toBe('');
    });

    test('AutoDraw: close card', async () => {
        const result = await appClient.send.cardFundClose({
            args: { cardFund: autoDrawCardAddress },
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
