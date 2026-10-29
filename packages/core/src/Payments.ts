/**
 * `@thomasfosterau/effect-biz/Payments`
 *
 * A vendor-neutral payments core for Effect. It defines:
 *
 * - **Capabilities** — abstract services (`Customers`, `Products`, `Prices`,
 *   `PaymentIntents`, `Subscriptions`, `Refunds`, `CheckoutSessions`,
 *   `BillingPortalSessions`) that programs depend on.
 * - **Domain types** — provider-agnostic entities (`Customer`, `Product`,
 *   `Price`, `PaymentIntent`, `Subscription`, `Refund`, `CheckoutSession`,
 *   `BillingPortalSession`, `Money`).
 * - **Errors** — a neutral error channel (`PaymentsError` and friends).
 * - **Idempotency keys** — `IdempotencyKey`, the branded key a caller passes
 *   on the create and confirm operations to make a retried write safe.
 * - **Stubs** — capability layers whose every call fails with one error
 *   (`Stub`), including the "not configured ≡ down" `Stub.unavailable`.
 *
 * A concrete provider package (e.g.
 * `@thomasfosterau/effect-biz-payments-stripe`) supplies `Layer`s that implement
 * these capabilities. Programs written against this core can therefore run on
 * any provider without modification — the payments analogue of Effect's AI
 * modules: one abstraction, one package per provider.
 *
 * See `Subscription.create` for an example of a program written against the core.
 *
 * @module
 */

// A named export first: docgen also reads the module doc above as the first
// statement's doc, and an `export * from` there yields an unusable example
// file name (see AGENTS.md, `vp run docgen`).
export { Money, Metadata, make as money } from "./Payments.Money.js";
export * from "./Payments.PaymentsError.js";
export * from "./Payments.Page.js";

export * as Enumeration from "./Payments.Enumeration.js";
export * as IdempotencyKey from "./Payments.IdempotencyKey.js";
export * as Customer from "./Payments.Customer.js";
export * as Product from "./Payments.Product.js";
export * as Price from "./Payments.Price.js";
export * as PaymentIntent from "./Payments.PaymentIntent.js";
export * as Subscription from "./Payments.Subscription.js";
export * as Refund from "./Payments.Refund.js";
export * as CheckoutSession from "./Payments.CheckoutSession.js";
export * as BillingPortal from "./Payments.BillingPortal.js";
export * as Stub from "./Payments.Stub.js";
