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
    assert,
    BoxMap,
    FixedArray,
    Global,
    Txn,
    uint64,
    Uint64,
} from '@algorandfoundation/algorand-typescript';
import { Pausable } from './roles/Pausable.algo';

const USER_INDEX = Uint64(0);
const INSTITUTION_INDEX = Uint64(1);

export class Killswitch extends Pausable {
    // ========== Storage ==========
    accounts = BoxMap<Account, FixedArray<boolean, 2>>({ keyPrefix: '' });

    // ========== Access Checks ==========
    /**
     * Assert the box for the account exists.
     */
    private accountExists(account: Account): void {
        assert(this.accounts(account).exists, 'NOT_REGISTERED');
    }

    // ========== Internal Utils ==========
    private _setSwitch(account: Account, index: uint64, val: boolean): void {
        this.accountExists(account);
        this.accounts(account).value[index] = val;
    }

    // ========== External Functions ==========
    /**
     * Deploy the contract, setting the owner as provided and initializing global state.
     */
    @abimethod({ allowActions: ['NoOp'], onCreate: 'require' })
    deploy(owner: Account): Account {
        this._transferOwnership(owner);
        this._pauser.value = Txn.sender;
        this.paused.value = false;
        return Global.currentApplicationAddress;
    }

    register(): void {
        const account = Txn.sender;
        assert(!this.accounts(account).exists, 'ALREADY_REGISTERED');
        this.accounts(account).create();
        this.accounts(account).value = new FixedArray<boolean, 2>(true, true);
    }
    /**
     * Checks if the delegation is authorized for the account.
     *
     * @param account The address of the user to check.
     */
    authorize(account: Account): void {
        this.whenNotPaused();
        this.accountExists(account);
        assert(this.accounts(account).value[USER_INDEX], 'USER_REFUSED');
        assert(this.accounts(account).value[INSTITUTION_INDEX], 'INSTITUTION_REFUSED');
    }

    /**
     * Enables the user's switch
     */
    enable(): void {
        this._setSwitch(Txn.sender, USER_INDEX, true);
    }

    /**
     * Disables the user's switch
     */
    disable(): void {
        this._setSwitch(Txn.sender, USER_INDEX, false);
    }

    /**
     * Enables the institution's switch for the user
     */
    enableUser(account: Account): void {
        this.onlyOwner();
        this._setSwitch(account, INSTITUTION_INDEX, true);
    }

    /**
     * Disables the institution's switch for the user
     */
    disableUser(account: Account): void {
        this.onlyOwner();
        this._setSwitch(account, INSTITUTION_INDEX, false);
    }
}
