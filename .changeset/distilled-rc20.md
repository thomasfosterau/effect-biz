---
"@thomasfosterau/effect-biz-payments-stripe": patch
---

Move Distilled (`@distilled.cloud/stripe` and `-core`) from `1.0.0-rc.18` to `1.0.0-rc.20`. `DISTILLED_API_VERSION`, the `Stripe-Version` every request pins unless configured, moves from `2026-09-30.endive` to `2026-10-28.endive`, and the optional `stripe` peer moves to `^23.1.0` (stripe-node 23.1.0 is the release for that version). Fifteen new resource modules wrap the operations Distilled adds: `V2.Core.Vault.GbBankAccount` and `V2.Core.Vault.UsBankAccount`, and `V2.MoneyManagement.*` (`Adjustment`, `FinancialAccount`, `FinancialAddress`, `InboundTransfer`, `OutboundPayment`, `OutboundSetupIntent`, `PayoutIntent`, `PayoutMethod`, `PayoutMethodsBankAccountSpec`, `ReceivedCredit`, `RecipientVerification`, `Transaction`, `TransactionEntry`), each on its own subpath and re-exported from the root.
