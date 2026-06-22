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
    abimethod,
    Account,
    Application,
    arc4,
    assert,
    BoxMap,
    Global,
    GlobalState,
    Txn,
} from '@algorandfoundation/algorand-typescript';
import { Recoverable } from './roles/Recoverable.algo';
import type { Master } from './Baanx.algo';

export class Killswitch extends Recoverable {
    // ========== Storage ==========
    accounts = BoxMap<Account, boolean>({ keyPrefix: '' });

    // The Master card-management contract, used to verify card ownership before enabling.
    master_app = GlobalState<Application>({ key: 'ma' });

    // ========== External Functions ==========
    /**
     * Deploy the contract, setting the owner as provided and initializing global state.
     *
     * @param owner The account to set as the contract owner.
     * @param master The Master contract used to verify card ownership when enabling delegation.
     */
    @abimethod({ allowActions: ['NoOp'], onCreate: 'require' })
    deploy(owner: Account, master: Application): Account {
        this._transferOwnership(owner);
        this._pauser.value = Txn.sender;
        this.paused.value = false;
        this.master_app.value = master;
        return Global.currentApplicationAddress;
    }

    /**
     * Checks if the delegation is authorized for the account.
     *
     * @param account The address of the user to check.
     */
    authorize(account: Account): void {
        this.whenNotPaused();
        assert(this.accounts(account).exists, 'REFUSED');
    }

    /**
     * Enables AutoDraw delegation.
     *
     * Gated to accounts that own a card in the Master contract, to prevent abuse of the
     * owner-funded box MBR. The caller must supply a card address they own; ownership is
     * verified against the Master contract via a cross-contract call.
     *
     * @param card A card address owned by the caller, used to prove card ownership.
     */
    enable(card: Account): void {
        assert(!this.accounts(Txn.sender).exists, 'ALREADY_ENABLED');

        const cardData = arc4.abiCall<typeof Master.prototype.getCardData>({
            appId: this.master_app.value,
            args: [card],
        }).returnValue;
        assert(cardData.owner === Txn.sender, 'NOT_CARD_OWNER');

        this.accounts(Txn.sender).create();
    }

    /**
     * Disables AutoDraw delegation
     */
    kill(): void {
        assert(this.accounts(Txn.sender).exists, 'ALREADY_DISABLED');
        this.accounts(Txn.sender).delete();
    }
}
