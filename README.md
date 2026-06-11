# Concept

This concept uses a single contract that "generates" new addresses for each partner and card that's created.

## Usage

To install dependencies:

```bash
pnpm install
```

To run a full test:

```bash
pnpm test
```

## Methods

### deploy()void

Deploy the smart contract, setting the transaction sender as the admin

### update()void

Allows the admin to update the smart contract

### destroy()void

Destroy the smart contract, sending all Algo to the admin account. This can only be done if there are no active cards

### setWithdrawalRounds(uint64)void

Set the number of rounds a withdrawal request must wait until being withdrawn

### cardCreate(pay,string,address)address

Create account. This generates a brand new account and funds the minimum balance requirement

### cardClose(string,address,account)void

Close account. This permanently removes the rekey and deletes the account from the ledger

### cardAddAsset(pay,string,account,asset)void

Allows the owner (or admin) to OptIn to an asset, increasing the minimum balance requirement of the account

### cardRemoveAsset(string,account,asset)void

Allows the owner (or admin) to CloseOut of an asset, reducing the minimum balance requirement of the account

### cardDebit(account,account,asset,uint64)void

Allows the admin to send an amount of assets from the account

### cardWithdrawalRequest(string,account,asset,uint64)byte[32]

Allows the owner to send an amount of assets from the account

### cardWithdrawalCancel(string,account,byte[32])void

Allows the owner (or admin) to cancel a withdrawal request

### cardWithdraw(string,account,account,asset,byte[32])void

Allows the owner to send an amount of assets from the account

```mermaid
classDiagram
    BaanxContract : +box cards
    BaanxContract : +box partners
    BaanxContract : +int active_cards
    BaanxContract : +int active_partners
    BaanxContract : +int withdrawal_wait_time
    BaanxContract : deploy()

    BaanxContract <|-- Owner
    BaanxContract <|-- Users

    class Owner {
        +bytes withdrawals
        update()
        destroy()
        setWithdrawalRounds()
        partnerCreate()
        partnerClose()
        cardCreate()
        cardClose()
        partnerAcceptAsset()
        partnerRejectAsset()
        partnerSettle()
        cardDebit()
        cardRefund()
        cardWithdrawalRequest()
        cardWithdrawalCancel()
        cardWithdraw()
    }

    class Users {
        +bytes withdrawals
        cardEnableAsset()
        cardDisableAsset()
        cardWithdrawalRequest()
        cardWithdrawalCancel()
        cardWithdraw()
    }
```

```mermaid
sequenceDiagram
    actor Merchant
    actor MasterCard
    actor Circle
    actor User
    actor Baanx
    Baanx->>Contract: deploy()
    Baanx->>Contract: setWithdrawalRounds()
    Baanx->>Contract: partnerCreate()
    activate Contract
    create participant Partner
    Contract-->>Partner: Create Partner
    Partner-->>Contract: Rekey to Baanx
    Contract-->>Partner: Fund MBR
    deactivate Contract
    Baanx->>Contract: partnerAcceptAsset()
    activate Contract
    Contract-->>Partner: Fund OptIn MBR
    Partner-->>Partner: OptIn Asset
    deactivate Contract
    Baanx->>Contract: cardCreate()
    activate Contract
    create participant CardFunds
    Contract-->>CardFunds: Create Card
    CardFunds-->>Contract: Rekey to Baanx
    Contract-->>CardFunds: Fund MBR
    deactivate Contract
    User->>Contract: cardEnableAsset()
    activate Contract
    Contract-->>CardFunds: Fund OptIn MBR
    CardFunds-->>CardFunds: OptIn Asset
    deactivate Contract
    User->>CardFunds: Axfer (Deposit)
    User->>Merchant: *taps card*
    activate Merchant
    Merchant-->>MasterCard: can pay?
    MasterCard-->>Baanx: auth?
    activate Baanx
    Baanx-->>Baanx: Check local DB
    Baanx-->>MasterCard: Yes
    MasterCard-->>Merchant: Yes
    Baanx->>Contract: cardDebit()
    activate Contract
    CardFunds-->>Partner: axfer (Debit)
    deactivate Baanx
    deactivate Merchant
    deactivate Contract
    Baanx->>Contract: partnerSettle()
    activate Contract
    Partner-->>Circle: axfer (Settle)
    deactivate Contract
    Circle-->>MasterCard:
    MasterCard-->>Merchant:
    User->>Contract: cardWithdrawalRequest()
    User->>Contract: cardWithdraw()
    activate Contract
    CardFunds-->>User: axfer (Withdrawal)
    User->>Contract: cardDisableAsset()
    activate Contract
    CardFunds-->>User: Refund OptIn MBR
    deactivate Contract
    Baanx->>Contract: cardClose()
    activate Contract
    destroy CardFunds
    CardFunds-->>Baanx: pay
    deactivate Contract
    Baanx->>Contract: partnerRejectAsset()
    activate Contract
    Partner-->>Baanx: Refund OptIn MBR
    deactivate Contract
    Baanx->>Contract: partnerClose()
    activate Contract
    destroy Partner
    Partner-->>Baanx: pay
    deactivate Contract
```
