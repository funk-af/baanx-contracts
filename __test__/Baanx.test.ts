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
import type { WithdrawalRequest } from '../client/MasterClient';

const fixture = algorandFixture({ testAccountFunding: AlgoAmount.MicroAlgos(0) });

let appClient: MasterClient;
let ksClient: KillswitchClient;

describe('Baanx', () => {
    let circle: algosdk.Account & algosdk.Address;
    let baanx: algosdk.Account & algosdk.Address;
    let user: algosdk.Account & algosdk.Address;
    let user2: algosdk.Account & algosdk.Address;
    let withdrawalAcc: algosdk.Account & algosdk.Address;
    let omnibus: algosdk.Account & algosdk.Address;

    let fakeUSDC: bigint;
    let newCardAddress: string;
    let withdrawalRequest: WithdrawalRequest;

    // AutoDraw-specific state (uses a separate card so the main flow stays intact)
    let autoDrawCardAddress: string;
    let autoDrawLsig: algosdk.LogicSigAccount;
    const AUTO_DRAW_DEBIT_AMOUNT = 5_000_000n;

    beforeAll(async () => {
        await fixture.beforeEach();
        Config.configure({ populateAppCallResources: true });
        const { algorand, generateAccount } = fixture.context;

        [baanx, user, user2, circle, withdrawalAcc, omnibus] = await Promise.all([
            generateAccount({ initialFunds: AlgoAmount.Algos(100) }),
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
            algorand.send.assetOptIn({ sender: omnibus.addr, assetId: fakeUSDC }),
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
            args: [baanx.addr.toString(), omnibus.addr.toString()],
            extraProgramPages: 3,
            schema: {
                globalInts: 32,
                globalByteSlices: 32,
                localInts: 8,
                localByteSlices: 8,
            },
        });
        appClient = deployment.appClient;

        // Fund the app account so the owner pre-funds all box MBR and account minimum balances
        await appClient.appClient.fundAppAccount({ amount: AlgoAmount.MicroAlgos(10_000_000) });

        // Deploy the Killswitch contract (used by the AutoDraw delegation flow)
        const ksFactory = algorand.client.getTypedAppFactory(KillswitchFactory, {
            defaultSender: baanx.addr,
        });
        const ksDeployment = await ksFactory.send.create.deploy({
            args: [baanx.addr.toString(), appClient.appId],
            schema: {
                globalInts: 8,
                globalByteSlices: 8,
                localInts: 0,
                localByteSlices: 0,
            },
        });
        ksClient = ksDeployment.appClient;

        // Fund Killswitch app for box MBR (2_500 + 400 * (32 + 8) = 18_500 per enabled account)
        await ksClient.appClient.fundAppAccount({ amount: AlgoAmount.MicroAlgos(200_000) });
    });

    /**
     * Sets the withdrawal timeout to 0 seconds so the test suite can complete withdrawals
     * instantly. In production this value is the mandatory delay between requesting and
     * completing a withdrawal (e.g. 5 days = 432_000 seconds), giving Baanx time to react
     * to fraud before funds leave a card.
     */
    test('Set withdrawal rounds to 0', async () => {
        // A real value would be:
        // 60 * 60 * 24 * 5 = 432_000 seconds = 5 days
        // We're using 0 seconds to allow for instant withdrawals
        const result = await appClient.send.setWithdrawalTimeout({ args: { seconds: 0 } });

        expect(result.confirmation.poolError).toBe('');
    });

    /**
     * Registers the ed25519 public key whose signatures authorize permissioned (early)
     * withdrawals. The matching private key lives off-chain with Baanx; the contract verifies
     * signatures against this key in `withdrawPermissioned` to let users skip the timeout.
     */
    test('Set withdrawal public key', async () => {
        const result = await appClient.send.setWithdrawalPubkey({
            args: { pubkey: withdrawalAcc.addr.publicKey },
            staticFee: AlgoAmount.MicroAlgos(1_000),
        });

        expect(result.confirmation.poolError).toBe('');
    });

    /**
     * Confirms the omnibus settlement address is persisted from the deploy arguments.
     * The omnibus account is where debited card funds ultimately settle, so it must be
     * readable on-chain immediately after creation.
     */
    test('Omnibus address set at deploy', async () => {
        const result = await appClient.send.getOmnibusAddress({
            args: {},
            staticFee: AlgoAmount.MicroAlgos(1_000),
        });

        expect(result.return).toBe(omnibus.addr.toString());
    });

    /**
     * Exercises the owner-only setter that rotates the omnibus address, reads it back to
     * confirm the change, then restores the original. Restoring matters because the rest of
     * the suite relies on the debit flow settling into the omnibus account that is opted in
     * to FakeUSDC.
     */
    test('Update and restore omnibus address', async () => {
        const updated = await appClient.send.setOmnibusAddress({
            args: { newOmnibusAddress: circle.addr.toString() },
        });
        expect(updated.confirmation.poolError).toBe('');

        const afterUpdate = await appClient.send.getOmnibusAddress({
            args: {},
            staticFee: AlgoAmount.MicroAlgos(1_000),
        });
        expect(afterUpdate.return).toBe(circle.addr.toString());

        // Restore so the debit flow settles into the opted-in omnibus account
        const restored = await appClient.send.setOmnibusAddress({
            args: { newOmnibusAddress: omnibus.addr.toString() },
        });
        expect(restored.confirmation.poolError).toBe('');
    });

    /**
     * Verifies the owner can sweep stray Algo (asset 0) that lands on the Master app account.
     * Funds a payment into the app, then recovers it to the Baanx owner, guarding against
     * value being permanently stranded in the contract.
     */
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

    /**
     * Creates a card account for a holder without opting into any asset (asset 0). This is
     * the lightweight card-creation path; the returned address is the freshly minted card
     * account that can later be opted into assets or closed.
     */
    test('Create new card without assets', async () => {
        const result = await appClient.send.cardCreate({
            args: {
                cardOwner: user2.addr.toString(),
                asset: 0,
            },
            sender: baanx.addr,
            staticFee: AlgoAmount.MicroAlgos(4_000),
        });
        expect(result.return).toBeDefined();

        newCardAddress = result.return!;
    });

    /**
     * Closes the asset-less card created above and reclaims its minimum balance back to the
     * funder, confirming the create/close lifecycle works for cards holding no assets.
     */
    test('Close card without assets', async () => {
        const result = await appClient.send.cardClose({
            args: { card: newCardAddress },
            staticFee: AlgoAmount.MicroAlgos(2_000),
        });

        expect(result.confirmation.poolError).toBe('');
    });

    /**
     * Creates a card and opts it into FakeUSDC in a single call. The returned address is
     * reused throughout the main spend/withdraw flow below, so this card is the primary
     * subject of the asset-bearing tests.
     */
    test('Create new card with FakeUSDC', async () => {
        const result = await appClient.send.cardCreate({
            args: {
                cardOwner: user.addr.toString(),
                asset: fakeUSDC,
            },
            sender: baanx.addr,
            staticFee: AlgoAmount.MicroAlgos(5_000),
        });
        expect(result.return).toBeDefined();

        newCardAddress = result.return!;
    });

    /**
     * Funds the card by transferring FakeUSDC straight to the card account. Cards are plain
     * asset holders, so a deposit is just a standard asset transfer from the holder's wallet
     * to the card address.
     */
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

    /**
     * Simulates the core spend flow: the user has spent on their card, and Baanx debits the
     * card for the matching FakeUSDC amount. The current nonce is fetched first and passed in
     * for replay protection; the ref carries the off-chain transaction identifier.
     */
    test('User spends, Baanx debits', async () => {
        const nextNonce = await appClient.send.getNextCardNonce({
            args: { card: newCardAddress },
        });

        const result = await appClient.send.cardDebit({
            args: {
                card: newCardAddress,
                asset: fakeUSDC,
                amount: 5_000_000,
                nonce: nextNonce.return!,
                ref: 'Test Transaction REF-1234567890',
            },
            staticFee: AlgoAmount.MicroAlgos(2_000),
        });

        expect(result.confirmation.poolError).toBeDefined();
    });

    /**
     * Reads back the card's stored data and asserts the owner, address, and nonce. The nonce
     * is expected to be 1 because the single debit above incremented it, proving replay
     * protection state advanced.
     */
    test('Get CardData', async () => {
        const result = await appClient.send.getCardData({
            args: { card: newCardAddress },
            staticFee: AlgoAmount.MicroAlgos(1_000),
        });

        expect(result.return?.owner).toBe(user.addr.toString());
        expect(result.return?.address).toBe(newCardAddress);
        expect(result.return?.nonce).toEqual(BigInt(1));
    });

    /**
     * Upgrades the Master contract program in place via the owner-only update path. Confirms
     * the contract can be patched without redeploying or losing existing card/global state.
     */
    test('Update Contract', async () => {
        const result = await appClient.send.update.update({
            args: [],
            staticFee: AlgoAmount.MicroAlgos(1_000),
        });

        expect(result.confirmation.poolError).toBe('');
    });

    /**
     * Owner-driven account recovery: reassigns an existing card to a new card holder. Used
     * when a user loses access to their wallet but should retain control of the card's funds.
     */
    test('Recover Card', async () => {
        const result = await appClient.send.cardRecover({
            args: {
                card: newCardAddress,
                newCardHolder: user2.addr.toString(),
            },
            staticFee: AlgoAmount.MicroAlgos(1_000),
        });

        expect(result.confirmation.poolError).toBe('');
    });

    /**
     * The (newly recovered) card holder initiates a withdrawal request. This records the
     * pending request on-chain; with the timeout at 0 it can be completed immediately in the
     * next test.
     */
    test('User creates withdrawal request', async () => {
        const result = await appClient.send.withdrawalRequest({
            args: {
                card: newCardAddress,
                asset: fakeUSDC,
                amount: 3_000_000,
            },
            sender: user2.addr,
        });

        expect(result.return).toBeDefined();

        withdrawalRequest = result.return!;
    });

    /**
     * Completes the pending withdrawal. Because the timeout is 0, the request is immediately
     * eligible and funds move from the card to the holder, closing the happy-path withdrawal
     * lifecycle.
     */
    test('Complete withdrawal request', async () => {
        const result = await appClient.send.withdraw({
            args: {
                card: newCardAddress,
                amount: withdrawalRequest.amount,
            },
            sender: user2.addr,
            staticFee: AlgoAmount.MicroAlgos(2_000),
        });

        expect(result.confirmation.poolError).toBe('');
    });

    /**
     * Raises the withdrawal timeout to a non-zero value (10 seconds) so the following tests
     * can exercise the permissioned early-withdrawal path, which only matters when a real
     * timeout would otherwise block an immediate withdrawal.
     */
    test('Set withdrawal rounds to 10', async () => {
        // A real value would be:
        // 60 * 60 * 24 * 5 = 432_000 seconds = 5 days
        // We're using 0 seconds to allow for instant withdrawals
        const result = await appClient.send.setWithdrawalTimeout({ args: { seconds: 10 } });

        expect(result.confirmation.poolError).toBe('');
    });

    // TODO: withdrawEarly test
    /**
     * Creates a fresh withdrawal request now that the timeout is non-zero. This request can
     * NOT be completed via the normal `withdraw` path until the timeout elapses, setting up
     * the permissioned early-withdrawal scenario below.
     */
    test('User creates another withdrawal request', async () => {
        const result = await appClient.send.withdrawalRequest({
            args: {
                card: newCardAddress,
                asset: fakeUSDC,
                amount: 2_000_000,
            },
            sender: user2.addr,
        });

        expect(result.return).toBeDefined();

        withdrawalRequest = result.return!;
    });

    // Early Withdrawal Test
    /**
     * Demonstrates the permissioned early withdrawal. The test reconstructs the exact byte
     * layout the contract hashes — card(32) + recipient(32) + asset(8) + amount(8) +
     * expiresAt(8) + nonce(8) + genesisHash(32) — SHA256-hashes it, and signs the digest with
     * the withdrawal authority key registered earlier. A valid signature lets the holder skip
     * the 10-second timeout. The genesis hash binds the signature to this specific network,
     * and expiresAt bounds how long the off-chain approval stays valid.
     */
    test('Request early withdrawal', async () => {
        const { algorand } = fixture.context;
        const suggestedParams = await algorand.client.algod.getTransactionParams().do();
        const genesisHash = Buffer.from(suggestedParams.genesisHash!);

        const { card: cardAddr, asset: withdrawalAsset, amount, nonce } = withdrawalRequest;
        const expiresAt = BigInt(Math.floor(Date.now() / 1000)) + BigInt(3600);

        // Build withdrawal bytes matching the contract: card(32) + recipient(32) + asset(8) + amount(8) + expiresAt(8) + nonce(8) + genesisHash(32)
        const withdrawalBytes = Buffer.concat([
            algosdk.decodeAddress(cardAddr).publicKey,
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

        const result = await appClient.send.withdrawPermissioned({
            args: {
                card: newCardAddress,
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

    /**
     * The card holder opts the card out of FakeUSDC. An ASA opt-out is required before the
     * card account can be closed, since Algorand forbids closing an account still opted into
     * an asset.
     */
    test('Disable FakeUSDC for card', async () => {
        const result = await appClient.send.cardDisableAsset({
            args: {
                card: newCardAddress,
                asset: fakeUSDC,
            },
            sender: user2.addr,
            staticFee: AlgoAmount.MicroAlgos(2_000),
        });

        expect(result.confirmation.poolError).toBe('');
    });

    /**
     * Closes the now asset-free card and reclaims its minimum balance, completing the full
     * lifecycle (create → fund → debit → recover → withdraw → disable asset → close) for the
     * primary FakeUSDC card.
     */
    test('Close card', async () => {
        const result = await appClient.send.cardClose({
            args: { card: newCardAddress },
            staticFee: AlgoAmount.MicroAlgos(2_000),
        });

        expect(result.confirmation.poolError).toBe('');
    });

    // ========== Killswitch unit tests ==========

    /**
     * Test setup for the Killswitch suite: a card owned by `user` must exist before that user
     * can enable delegation, because `enable` checks card ownership. The created address is
     * reused as the AutoDraw card in the integration tests further down.
     */
    test('Killswitch: create card for user (required to enable delegation)', async () => {
        const result = await appClient.send.cardCreate({
            args: {
                cardOwner: user.addr.toString(),
                asset: fakeUSDC,
            },
            sender: baanx.addr,
            staticFee: AlgoAmount.MicroAlgos(5_000),
        });
        expect(result.return).toBeDefined();

        autoDrawCardAddress = result.return!;
    });

    /**
     * The card owner enables delegation for their own card, writing a local/box switch that
     * later authorizes automated draws. This is the opt-in step a user takes to allow
     * AutoDraw to pull funds on their behalf.
     */
    test('Killswitch: enable user', async () => {
        const result = await ksClient.send.enable({
            args: { card: autoDrawCardAddress },
            sender: user.addr,
            staticFee: AlgoAmount.MicroAlgos(2_000),
        });
        expect(result.confirmation.poolError).toBe('');
    });

    /**
     * Negative case: a non-owner cannot enable delegation on someone else's card. Enforces
     * that only the card owner can opt their card into the killswitch, reverting with
     * NOT_CARD_OWNER otherwise.
     */
    test('Killswitch: enable fails for account that does not own the card', async () => {
        await expect(
            ksClient.send.enable({
                args: { card: autoDrawCardAddress },
                sender: user2.addr,
                staticFee: AlgoAmount.MicroAlgos(2_000),
            })
        ).rejects.toThrow('NOT_CARD_OWNER');
    });

    /**
     * Happy path for the killswitch gate: an enabled user passes `authorize`, the check the
     * AutoDraw group relies on to confirm the user still consents to automated debits.
     */
    test('Killswitch: authorize enabled user succeeds', async () => {
        const result = await ksClient.send.authorize({
            args: { account: user.addr.toString() },
        });
        expect(result.confirmation.poolError).toBe('');
    });

    /**
     * The killswitch in action: once a user calls `kill`, their consent is revoked and
     * `authorize` reverts with REFUSED. This is the emergency off-switch that lets a user
     * instantly stop any further automated draws.
     */
    test('Killswitch: user kills their delegation — authorize fails with REFUSED', async () => {
        await ksClient.send.kill({ args: [], sender: user.addr });

        await expect(ksClient.send.authorize({ args: { account: user.addr.toString() } })).rejects.toThrow('REFUSED');
    });

    /**
     * Confirms the kill is reversible: a user can re-enable their card after killing and
     * `authorize` succeeds again, so the off-switch is a pause rather than a permanent
     * lockout.
     */
    test('Killswitch: user re-enables themselves — authorize succeeds', async () => {
        await ksClient.send.enable({
            args: { card: autoDrawCardAddress },
            sender: user.addr,
            staticFee: AlgoAmount.MicroAlgos(2_000),
        });

        const result = await ksClient.send.authorize({
            args: { account: user.addr.toString() },
        });
        expect(result.confirmation.poolError).toBe('');
    });

    /**
     * Idempotency guard: enabling a card that is already enabled reverts with
     * ALREADY_ENABLED, preventing duplicate box state or double-charged MBR.
     */
    test('Killswitch: enabling again fails with ALREADY_ENABLED', async () => {
        await expect(
            ksClient.send.enable({
                args: { card: autoDrawCardAddress },
                sender: user.addr,
                staticFee: AlgoAmount.MicroAlgos(2_000),
            })
        ).rejects.toThrow('ALREADY_ENABLED');
    });

    /**
     * Default-deny behavior: an account that never opted in is refused by `authorize`. Only
     * users who explicitly enabled delegation can be authorized.
     */
    test('Killswitch: authorize non-enabled account fails with REFUSED', async () => {
        await expect(ksClient.send.authorize({ args: { account: user2.addr.toString() } })).rejects.toThrow('REFUSED');
    });

    /**
     * Global circuit breaker: while the contract is paused, even a properly enabled user is
     * refused. This lets Baanx halt all automated draws system-wide in an incident, on top of
     * the per-user killswitch.
     */
    test('Killswitch: pause contract — authorize fails', async () => {
        await ksClient.send.pause({ args: [] });

        await expect(ksClient.send.authorize({ args: { account: user.addr.toString() } })).rejects.toThrow();
    });

    /**
     * Confirms the global pause is reversible: after `unpause`, enabled users are authorized
     * again and normal operation resumes.
     */
    test('Killswitch: unpause contract — authorize succeeds', async () => {
        await ksClient.send.unpause({ args: [] });

        const result = await ksClient.send.authorize({
            args: { account: user.addr.toString() },
        });
        expect(result.confirmation.poolError).toBe('');
    });

    // ========== AutoDraw integration tests ==========

    /**
     * Builds the AutoDraw delegated logic signature. The TEAL template is hydrated with the
     * concrete asset id, killswitch app id, master app id, and genesis hash, compiled, then
     * signed by the user so it acts as a delegated approval. The lsig can only ever move the
     * configured asset into the configured card under the configured apps, which is what
     * makes delegating it to Baanx safe.
     */
    test('AutoDraw: compile lsig and user signs for delegation', async () => {
        const { algorand } = fixture.context;
        const algod = algorand.client.algod;

        const suggestedParams = await algod.getTransactionParams().do();
        const genesisHashHex = Buffer.from(suggestedParams.genesisHash!).toString('hex');

        const tealTemplate = readFileSync(join(__dirname, '../dist/AutoDraw.teal'), 'utf-8');
        const teal = tealTemplate
            .replace('TMPL_ASSET', String(fakeUSDC))
            .replace('TMPL_KILLSWITCH_APP', String(ksClient.appId))
            .replace('TMPL_MASTER_APP', String(appClient.appId))
            .replace('TMPL_GENESIS_HASH', `0x${genesisHashHex}`);

        const compiled = await algod.compile(teal).do();
        const program = Buffer.from(compiled.result, 'base64');

        autoDrawLsig = new algosdk.LogicSigAccount(program);
        autoDrawLsig.sign(user.sk);

        expect(autoDrawLsig.lsig.sig).toBeDefined();
    });

    /**
     * The core AutoDraw integration: a single atomic group [axfer, authorize, cardDebit]
     * debits a card that starts at zero balance. Transaction [0] uses the delegated lsig to
     * pull funds from the user's wallet into the card (fee=0), [1] checks the killswitch
     * consent, and [2] debits the now-funded card. Bundling them atomically means the card is
     * funded just-in-time and the whole draw fails together if any guard rejects.
     */
    test('AutoDraw: group debit succeeds from zero-balance card', async () => {
        const { algorand } = fixture.context;
        const algod = algorand.client.algod;

        const nonceResult = await appClient.send.getNextCardNonce({
            args: { card: autoDrawCardAddress },
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
        // [2] cardDebit: inner txn card→Master now sees the card funded by [0]
        composer.addAppCallMethodCall(
            await appClient.params.cardDebit({
                args: {
                    card: autoDrawCardAddress,
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

    /**
     * Confirms the delegated debit advanced replay-protection state: the card nonce is now 1
     * after the single successful AutoDraw group.
     */
    test('AutoDraw: card nonce incremented after debit', async () => {
        const result = await appClient.send.getCardData({
            args: { card: autoDrawCardAddress },
        });
        expect(result.return?.nonce).toEqual(1n);
    });

    /**
     * Security check: if the user has killed their delegation, the whole AutoDraw group is
     * rejected with REFUSED at the `authorize` step, so no funds move even though the lsig and
     * debit are otherwise valid. Re-enables the user afterward to restore state for following
     * tests.
     */
    test('AutoDraw: group fails when user has disabled themselves', async () => {
        const { algorand } = fixture.context;
        const algod = algorand.client.algod;

        await ksClient.send.kill({ args: [], sender: user.addr });

        const nonceResult = await appClient.send.getNextCardNonce({
            args: { card: autoDrawCardAddress },
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
            await appClient.params.cardDebit({
                args: {
                    card: autoDrawCardAddress,
                    asset: fakeUSDC,
                    amount: AUTO_DRAW_DEBIT_AMOUNT,
                    nonce: nonceResult.return!,
                    ref: 'AutoDraw Test REF-002',
                },
                staticFee: AlgoAmount.MicroAlgos(3_000),
            })
        );

        await expect(composer.send()).rejects.toThrow('REFUSED');

        await ksClient.send.enable({
            args: { card: autoDrawCardAddress },
            sender: user.addr,
            staticFee: AlgoAmount.MicroAlgos(2_000),
        });
    });

    /**
     * System-wide guard: while the Killswitch contract is globally paused, the AutoDraw group
     * is rejected at `authorize` regardless of individual user consent. Unpauses afterward to
     * leave the contract in a clean state.
     */
    test('AutoDraw: group fails when Killswitch is paused', async () => {
        const { algorand } = fixture.context;
        const algod = algorand.client.algod;

        await ksClient.send.pause({ args: [] });

        const nonceResult = await appClient.send.getNextCardNonce({
            args: { card: autoDrawCardAddress },
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
            await appClient.params.cardDebit({
                args: {
                    card: autoDrawCardAddress,
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

    /**
     * Opts the AutoDraw card out of FakeUSDC, the required precondition before the card
     * account can be closed.
     */
    test('AutoDraw: disable FakeUSDC for card', async () => {
        const result = await appClient.send.cardDisableAsset({
            args: {
                card: autoDrawCardAddress,
                asset: fakeUSDC,
            },
            sender: user.addr,
            staticFee: AlgoAmount.MicroAlgos(2_000),
        });

        expect(result.confirmation.poolError).toBe('');
    });

    /**
     * Closes the AutoDraw card and reclaims its minimum balance, tearing down the integration
     * fixture.
     */
    test('AutoDraw: close card', async () => {
        const result = await appClient.send.cardClose({
            args: { card: autoDrawCardAddress },
            staticFee: AlgoAmount.MicroAlgos(2_000),
        });

        expect(result.confirmation.poolError).toBe('');
    });

    /**
     * Final lifecycle step: the owner destroys the Master contract and reclaims any remaining
     * balance, verifying the app can be cleanly deleted once all cards are closed.
     */
    test('Destroy Contract', async () => {
        const result = await appClient.send.delete.destroy({
            args: [],
            staticFee: AlgoAmount.MicroAlgos(2_000),
        });

        expect(result.confirmation.poolError).toBe('');
    });
});
