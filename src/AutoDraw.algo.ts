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
    Asset,
    Bytes,
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
        const nextTxn = gtxn.Transaction(Txn.groupIndex + 1);
        const secondNextTxn = gtxn.Transaction(Txn.groupIndex + 2);
        const ASSET = TemplateVar<Asset>('ASSET');
        return (
            // Safety checks
            Txn.rekeyTo === Global.zeroAddress &&
            Txn.assetCloseTo === Global.zeroAddress &&
            // Enforce this transaction is an axfer with criteria
            Txn.typeEnum === TransactionType.AssetTransfer &&
            Txn.xferAsset === ASSET &&
            Txn.fee === 0 &&
            // Enforce the next transaction is a Killswitch call
            nextTxn.type === TransactionType.ApplicationCall &&
            nextTxn.appId === TemplateVar<Application>('KILLSWITCH_APP') &&
            nextTxn.appArgs(0) === Bytes.fromHex('73BC6501') && // authorize
            nextTxn.appArgs(1) === Txn.sender.bytes &&
            // Enforce the second next transaction is a Master call
            secondNextTxn.type === TransactionType.ApplicationCall &&
            secondNextTxn.appId === TemplateVar<Application>('MASTER_APP') &&
            secondNextTxn.appArgs(0) === Bytes.fromHex('06755B0D') && // cardFundDebit
            Txn.assetReceiver.bytes === secondNextTxn.appArgs(1) &&
            Txn.xferAsset.id === op.btoi(secondNextTxn.appArgs(2)) &&
            Txn.assetAmount <= op.btoi(secondNextTxn.appArgs(3))
        );
    }
}
