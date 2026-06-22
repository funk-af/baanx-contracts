/*
 * MIT License
 *
 * Copyright (c) 2026 Algorand Foundation
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
    Application,
    arc4,
    Asset,
    bytes,
    Global,
    gtxn,
    LogicSig,
    op,
    TemplateVar,
    TransactionType,
    Txn,
} from '@algorandfoundation/algorand-typescript';
import { Killswitch } from './Killswitch.algo';
import { Master } from './Master.algo';

export class AutoDraw extends LogicSig {
    program() {
        const txnKillswitch = gtxn.Transaction(Txn.groupIndex + 1);
        const txnMasterDebit = gtxn.Transaction(Txn.groupIndex + 2);
        const ASSET = TemplateVar<Asset>('ASSET');
        return (
            // Safety checks
            Txn.rekeyTo === Global.zeroAddress &&
            Txn.assetCloseTo === Global.zeroAddress &&
            Global.genesisHash === TemplateVar<bytes>('GENESIS_HASH') &&
            // Enforce this transaction is an axfer with criteria
            Txn.typeEnum === TransactionType.AssetTransfer &&
            Txn.xferAsset === ASSET &&
            Txn.fee === 0 &&
            // Enforce the next transaction is a Killswitch call
            txnKillswitch.type === TransactionType.ApplicationCall &&
            txnKillswitch.appId === TemplateVar<Application>('KILLSWITCH_APP') &&
            txnKillswitch.appArgs(0) === arc4.methodSelector<typeof Killswitch.prototype.authorize>() &&
            txnKillswitch.appArgs(1) === Txn.sender.bytes &&
            // Enforce the second next transaction is a Master call
            txnMasterDebit.type === TransactionType.ApplicationCall &&
            txnMasterDebit.appId === TemplateVar<Application>('MASTER_APP') &&
            txnMasterDebit.appArgs(0) === arc4.methodSelector<typeof Master.prototype.cardDebit>() &&
            Txn.assetReceiver.bytes === txnMasterDebit.appArgs(1) &&
            Txn.xferAsset.id === op.btoi(txnMasterDebit.appArgs(2)) &&
            Txn.assetAmount <= op.btoi(txnMasterDebit.appArgs(3))
        );
    }
}
