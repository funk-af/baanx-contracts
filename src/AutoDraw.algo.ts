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
    Account,
    Application,
    Asset,
    Bytes,
    bytes,
    Global,
    gtxn,
    LogicSig,
    op,
    TemplateVar,
    TransactionType,
    Txn,
} from '@algorandfoundation/algorand-typescript';

export class AutoDraw extends LogicSig {
    program() {
        const prevTxn = gtxn.Transaction(Txn.groupIndex - 1);
        const twoBeforeTxn = gtxn.Transaction(Txn.groupIndex - 2);
        const ASSET = TemplateVar<Asset>('ASSET');
        return (
            // Safety checks
            Txn.rekeyTo === Global.zeroAddress &&
            Txn.assetCloseTo === Global.zeroAddress &&
            // Enforce this transaction is an axfer with criteria
            Txn.typeEnum === TransactionType.AssetTransfer &&
            Txn.xferAsset === ASSET &&
            Txn.fee === 0 &&
            // Enforce the previous transaction is a Killswitch call
            prevTxn.type === TransactionType.ApplicationCall &&
            prevTxn.appId === TemplateVar<Application>('KILLSWITCH_APP') &&
            prevTxn.appArgs(0) === Bytes.fromHex('73bc6501') && // authorize
            prevTxn.appArgs(1) === Txn.assetSender.bytes &&
            // Enforce the two before transaction is a Master call
            twoBeforeTxn.type === TransactionType.ApplicationCall &&
            twoBeforeTxn.appId === TemplateVar<Application>('MASTER_APP') &&
            twoBeforeTxn.appArgs(0) === Bytes.fromHex('06755B0D') && // cardFundDebit
            Txn.assetReceiver.bytes === twoBeforeTxn.appArgs(1) &&
            Txn.xferAsset.id === op.btoi(twoBeforeTxn.appArgs(2)) &&
            Txn.assetAmount <= op.btoi(twoBeforeTxn.appArgs(3))
        );
    }
}
