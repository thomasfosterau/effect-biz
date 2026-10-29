/**
 * Stripe Treasury as one namespace: re-exports the `FinancialAccount`,
 * `Transaction`, `TransactionEntry`, `InboundTransfer`, `OutboundTransfer`,
 * `OutboundPayment`, `ReceivedCredit`, `ReceivedDebit`, `CreditReversal` and
 * `DebitReversal` raw resource modules (each also published on its own
 * `./Treasury.<Name>` subpath): Distilled's operations on each, typed with
 * its declarations and not validated.
 *
 * Operations require `StripeHttp`: provide `StripeHttp.layer` (with
 * `FetchHttpClient.layer`), `StripeHttp.layerConfig` or `StripeHttp.layerFromEnv`.
 *
 * @module
 */

export * as FinancialAccount from "./Treasury.FinancialAccount.js";
export * as Transaction from "./Treasury.Transaction.js";
export * as TransactionEntry from "./Treasury.TransactionEntry.js";
export * as InboundTransfer from "./Treasury.InboundTransfer.js";
export * as OutboundTransfer from "./Treasury.OutboundTransfer.js";
export * as OutboundPayment from "./Treasury.OutboundPayment.js";
export * as ReceivedCredit from "./Treasury.ReceivedCredit.js";
export * as ReceivedDebit from "./Treasury.ReceivedDebit.js";
export * as CreditReversal from "./Treasury.CreditReversal.js";
export * as DebitReversal from "./Treasury.DebitReversal.js";
