/// <reference types="node" />
/* eslint-disable import/no-extraneous-dependencies */
import { describe, test, expect, beforeAll } from '@jest/globals';
import { readFileSync } from 'fs';
import { join } from 'path';
import algosdk from 'algosdk';
import { Config } from '@algorandfoundation/algokit-utils';
import { AlgoAmount } from '@algorandfoundation/algokit-utils/types/amount';
import { algorandFixture } from '@algorandfoundation/algokit-utils/testing';
import { KillswitchClient, KillswitchFactory } from '../client/KillswitchClient';
import { MasterClient, MasterFactory } from '../client/MasterClient';

const fixture = algorandFixture({ testAccountFunding: AlgoAmount.MicroAlgos(0) });

let ksClient: KillswitchClient;
let masterClient: MasterClient;

describe('Killswitch', () => {
    let baanx: algosdk.Account & algosdk.Address;
    let user: algosdk.Account & algosdk.Address;
    let circle: algosdk.Account & algosdk.Address;

    let fakeUSDC: bigint;
    let newPartnerChannel: string;
    let newCardAddress: string;
    let lsig: algosdk.LogicSigAccount;

    const DEBIT_AMOUNT = 5_000_000n;

    beforeAll(async () => {
        await fixture.beforeEach();
        Config.configure({ populateAppCallResources: true });
        const { algorand, generateAccount } = fixture.context;

        [baanx, user, circle] = await Promise.all([
            generateAccount({ initialFunds: AlgoAmount.Algos(10) }),
            generateAccount({ initialFunds: AlgoAmount.Algos(10) }),
            generateAccount({ initialFunds: AlgoAmount.Algos(10) }),
        ]);

        // Create FakeUSDC and fund user
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
            clawback: user.addr,
        });
        fakeUSDC = created.assetId;

        await algorand.send.assetOptIn({ sender: user.addr, assetId: fakeUSDC });
        await algorand.send.assetTransfer({
            sender: circle.addr,
            receiver: user.addr,
            assetId: fakeUSDC,
            amount: 100_000_000n,
        });

        // Deploy Killswitch
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

        // Deploy Master
        const masterFactory = algorand.client.getTypedAppFactory(MasterFactory, {
            defaultSender: baanx.addr,
        });
        const masterDeployment = await masterFactory.send.create.deploy({
            args: [baanx.addr.toString()],
            extraProgramPages: 3,
            schema: {
                globalInts: 32,
                globalByteSlices: 32,
                localInts: 8,
                localByteSlices: 8,
            },
        });
        masterClient = masterDeployment.appClient;
        await masterClient.appClient.fundAppAccount({ amount: AlgoAmount.MicroAlgos(100_000) });

        // Master: set withdrawal timeout
        await masterClient.send.setWithdrawalTimeout({ args: { seconds: 0 } });

        // Master: allowlist FakeUSDC
        const allowlistMbr = await algorand.createTransaction.payment({
            sender: baanx.addr,
            receiver: masterClient.appAddress,
            amount: AlgoAmount.MicroAlgos(100_000 + (2_500 + 400 * (2 + 8 + 32))),
        });
        await masterClient.send.assetAllowlistAdd({
            args: { mbr: allowlistMbr, asset: fakeUSDC, settlementAddress: baanx.addr.toString() },
            staticFee: AlgoAmount.MicroAlgos(2_000),
        });

        // Master: create partner channel
        const channelMbrResult = await masterClient.send.getPartnerChannelMbr({
            args: { partnerChannelName: 'Pera' },
            staticFee: AlgoAmount.MicroAlgos(1_000),
        });
        const channelMbr = await algorand.createTransaction.payment({
            sender: baanx.addr,
            receiver: masterClient.appAddress,
            amount: AlgoAmount.MicroAlgos(channelMbrResult.return!),
        });
        const channelResult = await masterClient.send.partnerChannelCreate({
            args: { mbr: channelMbr, partnerChannelName: 'Pera' },
            staticFee: AlgoAmount.MicroAlgos(5_000),
        });
        newPartnerChannel = channelResult.return!;

        // Master: create card for user with FakeUSDC (card is opted-in, zero balance is fine)
        const cardMbrResult = await masterClient.send.getCardFundMbr({
            args: { asset: fakeUSDC },
            staticFee: AlgoAmount.MicroAlgos(1_000),
        });
        const cardMbr = await algorand.createTransaction.payment({
            sender: user.addr,
            receiver: masterClient.appAddress,
            amount: AlgoAmount.MicroAlgos(cardMbrResult.return!),
        });
        const cardResult = await masterClient.send.cardFundCreate({
            args: { mbr: cardMbr, partnerChannel: newPartnerChannel, asset: fakeUSDC },
            sender: user.addr,
            staticFee: AlgoAmount.MicroAlgos(5_000),
        });
        newCardAddress = cardResult.return!;
    });

    // ========== Phase 1: Killswitch unit tests ==========

    test('Register user', async () => {
        const result = await ksClient.send.register({
            args: [],
            sender: user.addr,
        });
        expect(result.confirmation.poolError).toBe('');
    });

    test('Authorize registered user succeeds', async () => {
        const result = await ksClient.send.authorize({
            args: { account: user.addr.toString() },
        });
        expect(result.confirmation.poolError).toBe('');
    });

    test('User disables themselves — authorize fails with USER_REFUSED', async () => {
        await ksClient.send.disable({ args: [], sender: user.addr });

        await expect(ksClient.send.authorize({ args: { account: user.addr.toString() } })).rejects.toThrow(
            'USER_REFUSED'
        );
    });

    test('User re-enables themselves — authorize succeeds', async () => {
        await ksClient.send.enable({ args: [], sender: user.addr });

        const result = await ksClient.send.authorize({
            args: { account: user.addr.toString() },
        });
        expect(result.confirmation.poolError).toBe('');
    });

    test('Institution disables user — authorize fails with INSTITUTION_REFUSED', async () => {
        await ksClient.send.disableUser({ args: { account: user.addr.toString() } });

        await expect(ksClient.send.authorize({ args: { account: user.addr.toString() } })).rejects.toThrow(
            'INSTITUTION_REFUSED'
        );
    });

    test('Institution re-enables user — authorize succeeds', async () => {
        await ksClient.send.enableUser({ args: { account: user.addr.toString() } });

        const result = await ksClient.send.authorize({
            args: { account: user.addr.toString() },
        });
        expect(result.confirmation.poolError).toBe('');
    });

    test('Registering again fails with ALREADY_REGISTERED', async () => {
        await expect(ksClient.send.register({ args: [], sender: user.addr })).rejects.toThrow('ALREADY_REGISTERED');
    });

    test('Authorize unregistered account fails with NOT_REGISTERED', async () => {
        const { generateAccount } = fixture.context;
        const unregistered = await generateAccount({ initialFunds: AlgoAmount.MicroAlgos(0) });

        await expect(ksClient.send.authorize({ args: { account: unregistered.addr.toString() } })).rejects.toThrow(
            'NOT_REGISTERED'
        );
    });

    test('Pause contract — authorize fails', async () => {
        await ksClient.send.pause({ args: [] });

        await expect(ksClient.send.authorize({ args: { account: user.addr.toString() } })).rejects.toThrow();
    });

    test('Unpause contract — authorize succeeds', async () => {
        await ksClient.send.unpause({ args: [] });

        const result = await ksClient.send.authorize({
            args: { account: user.addr.toString() },
        });
        expect(result.confirmation.poolError).toBe('');
    });

    // ========== Phase 2: AutoDraw integration tests ==========

    test('Compile AutoDraw lsig and user signs for delegation', async () => {
        const { algorand } = fixture.context;
        const algod = algorand.client.algod;

        const tealTemplate = readFileSync(join(__dirname, '../dist/AutoDraw.teal'), 'utf-8');
        const teal = tealTemplate
            .replace('TMPL_ASSET', String(fakeUSDC))
            .replace('TMPL_KILLSWITCH_APP', String(ksClient.appId))
            .replace('TMPL_MASTER_APP', String(masterClient.appId));

        const compiled = await algod.compile(teal).do();
        const program = Buffer.from(compiled.result, 'base64');

        lsig = new algosdk.LogicSigAccount(program);
        lsig.sign(user.sk);

        expect(lsig.lsig.sig).toBeDefined();
    });

    test('AutoDraw group — debit succeeds from zero-balance card', async () => {
        const { algorand } = fixture.context;
        const algod = algorand.client.algod;

        const nonceResult = await masterClient.send.getNextCardFundNonce({
            args: { cardFund: newCardAddress },
        });

        const suggestedParams = await algod.getTransactionParams().do();
        const axferTxn = algosdk.makeAssetTransferTxnWithSuggestedParamsFromObject({
            sender: user.addr.toString(),
            assetSender: user.addr.toString(),
            receiver: newCardAddress,
            assetIndex: Number(fakeUSDC),
            amount: DEBIT_AMOUNT,
            suggestedParams: { ...suggestedParams, flatFee: true, fee: 0 },
        });

        const composer = algorand.newGroup();
        // [0] AutoDraw lsig axfer: user's main account → card (fee=0)
        composer.addTransaction(axferTxn, algosdk.makeLogicSigAccountTransactionSigner(lsig));
        // [1] Killswitch.authorize: validates user's switches and paused state
        composer.addAppCallMethodCall(
            await ksClient.params.authorize({
                args: { account: user.addr.toString() },
                staticFee: AlgoAmount.MicroAlgos(1_000),
            })
        );
        // [2] cardFundDebit: inner txn card→Master now sees the card funded by [0]
        composer.addAppCallMethodCall(
            await masterClient.params.cardFundDebit({
                args: {
                    cardFund: newCardAddress,
                    asset: fakeUSDC,
                    amount: DEBIT_AMOUNT,
                    nonce: nonceResult.return!,
                    ref: 'AutoDraw Test REF-001',
                },
                staticFee: AlgoAmount.MicroAlgos(3_000),
            })
        );

        const result = await composer.send();
        expect(result.confirmations.every((c) => c.poolError === '')).toBe(true);
    });

    test('Card nonce incremented after AutoDraw debit', async () => {
        const result = await masterClient.send.getCardFundData({
            args: { cardFund: newCardAddress },
        });
        expect(result.return?.nonce).toEqual(1n);
    });

    test('AutoDraw group fails when user has disabled themselves', async () => {
        const { algorand } = fixture.context;
        const algod = algorand.client.algod;

        await ksClient.send.disable({ args: [], sender: user.addr });

        const nonceResult = await masterClient.send.getNextCardFundNonce({
            args: { cardFund: newCardAddress },
        });

        const suggestedParams = await algod.getTransactionParams().do();
        const axferTxn = algosdk.makeAssetTransferTxnWithSuggestedParamsFromObject({
            sender: user.addr.toString(),
            assetSender: user.addr.toString(),
            receiver: newCardAddress,
            assetIndex: Number(fakeUSDC),
            amount: DEBIT_AMOUNT,
            suggestedParams: { ...suggestedParams, flatFee: true, fee: 0 },
        });

        const composer = algorand.newGroup();
        composer.addTransaction(axferTxn, algosdk.makeLogicSigAccountTransactionSigner(lsig));
        composer.addAppCallMethodCall(
            await ksClient.params.authorize({
                args: { account: user.addr.toString() },
                staticFee: AlgoAmount.MicroAlgos(1_000),
            })
        );
        composer.addAppCallMethodCall(
            await masterClient.params.cardFundDebit({
                args: {
                    cardFund: newCardAddress,
                    asset: fakeUSDC,
                    amount: DEBIT_AMOUNT,
                    nonce: nonceResult.return!,
                    ref: 'AutoDraw Test REF-002',
                },
                staticFee: AlgoAmount.MicroAlgos(3_000),
            })
        );

        await expect(composer.send()).rejects.toThrow('USER_REFUSED');

        await ksClient.send.enable({ args: [], sender: user.addr });
    });

    test('AutoDraw group fails when Killswitch is paused', async () => {
        const { algorand } = fixture.context;
        const algod = algorand.client.algod;

        await ksClient.send.pause({ args: [] });

        const nonceResult = await masterClient.send.getNextCardFundNonce({
            args: { cardFund: newCardAddress },
        });

        const suggestedParams = await algod.getTransactionParams().do();
        const axferTxn = algosdk.makeAssetTransferTxnWithSuggestedParamsFromObject({
            sender: user.addr.toString(),
            assetSender: user.addr.toString(),
            receiver: newCardAddress,
            assetIndex: Number(fakeUSDC),
            amount: DEBIT_AMOUNT,
            suggestedParams: { ...suggestedParams, flatFee: true, fee: 0 },
        });

        const composer = algorand.newGroup();
        composer.addTransaction(axferTxn, algosdk.makeLogicSigAccountTransactionSigner(lsig));
        composer.addAppCallMethodCall(
            await ksClient.params.authorize({
                args: { account: user.addr.toString() },
                staticFee: AlgoAmount.MicroAlgos(1_000),
            })
        );
        composer.addAppCallMethodCall(
            await masterClient.params.cardFundDebit({
                args: {
                    cardFund: newCardAddress,
                    asset: fakeUSDC,
                    amount: DEBIT_AMOUNT,
                    nonce: nonceResult.return!,
                    ref: 'AutoDraw Test REF-003',
                },
                staticFee: AlgoAmount.MicroAlgos(3_000),
            })
        );

        await expect(composer.send()).rejects.toThrow();

        await ksClient.send.unpause({ args: [] });
    });
});
