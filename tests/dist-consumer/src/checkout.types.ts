/**
 * Type-level tests for the neutral checkout parameters, against the EMITTED
 * declarations. Each `@ts-expect-error` is the assertion: the statement below
 * it must fail to compile, and `tsc` reports an unused directive if it ever
 * compiles. Never executed; type-checked only.
 */

import type * as CheckoutSession from "@thomasfosterau/effect-biz/Payments.CheckoutSession";

/** Subscription metadata belongs to a subscription checkout only. */
export const paymentWithSubscriptionMetadata: CheckoutSession.CreateParams = {
  mode: "payment",
  lineItems: [{ price: "price_123" }],
  successUrl: "https://example.com/ok",
  cancelUrl: "https://example.com/cancel",
  // @ts-expect-error -- `subscriptionMetadata` is not a `PaymentParams` field
  subscriptionMetadata: { user_id: "user-1" },
};

/** A checkout needs at least one line item. */
export const emptyCheckout: CheckoutSession.CreateParams = {
  mode: "subscription",
  // @ts-expect-error -- `lineItems` is a non-empty tuple
  lineItems: [],
  successUrl: "https://example.com/ok",
  cancelUrl: "https://example.com/cancel",
};

/** The subscription member accepts subscription metadata. */
export const subscriptionWithMetadata: CheckoutSession.CreateParams = {
  mode: "subscription",
  lineItems: [{ price: "price_123" }],
  successUrl: "https://example.com/ok",
  cancelUrl: "https://example.com/cancel",
  subscriptionMetadata: { user_id: "user-1" },
};
