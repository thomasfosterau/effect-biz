/**
 * Vendor-neutral hosted checkout.
 *
 * A checkout session is a payment page the provider hosts: the program creates
 * one for a customer and a set of prices, then redirects the buyer to its
 * {@link CheckoutSession.url}. The provider collects payment details and sends
 * the buyer back to `successUrl` or `cancelUrl`; the outcome arrives through the
 * provider's webhooks, not through this call.
 *
 * **No amount is ever an input.** Line items name price ids, so what the buyer
 * pays is whatever the provider's price says, and a client cannot choose it.
 *
 * See {@link create} for an example.
 *
 * @module
 */

import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type { IdempotencyKey } from "./Payments.IdempotencyKey.js";
import type { PaymentsError } from "./Payments.PaymentsError.js";

/**
 * What a checkout session collects: a one-off payment, or the first payment of
 * a subscription the provider creates when the buyer completes it.
 */
export const CheckoutMode = Schema.Literals(["payment", "subscription"]);
export type CheckoutMode = typeof CheckoutMode.Type;

/** A hosted checkout session: the page to redirect the buyer to. */
export class CheckoutSession extends Schema.Class<CheckoutSession>(
  "@effect-biz/payments/CheckoutSession",
)({
  id: Schema.String,
  /** The hosted checkout page. Redirect the buyer here. */
  url: Schema.String,
}) {}

/** One line of a checkout: a price, and how many of it. */
export interface LineItemParams {
  /** The provider's price id. The amount is the price's, never the caller's. */
  readonly price: string;
  /** How many of the price. Defaults to 1. */
  readonly quantity?: number | undefined;
}

/** At least one line item: a checkout with nothing to buy is not a checkout. */
export type LineItems = readonly [LineItemParams, ...ReadonlyArray<LineItemParams>];

/** The parameters every checkout session takes, whatever its mode. */
export interface CommonParams {
  /** The customer to bill. Omitted, the provider collects the buyer's details. */
  readonly customer?: string | undefined;
  readonly lineItems: LineItems;
  /** Where the provider sends the buyer after a completed checkout. */
  readonly successUrl: string;
  /** Where the provider sends the buyer after abandoning the checkout. */
  readonly cancelUrl: string;
  /** Metadata stored on the checkout session itself. */
  readonly metadata?: Record<string, string> | undefined;
  /**
   * Makes this write safe to repeat: create one with `IdempotencyKey.generate`
   * before the first attempt and pass the same key on every retry (see
   * `IdempotencyKey` for the contract).
   */
  readonly idempotencyKey?: IdempotencyKey | undefined;
}

/** A checkout for a one-off payment. */
export interface PaymentParams extends CommonParams {
  readonly mode: "payment";
}

/** A checkout that starts a subscription when the buyer completes it. */
export interface SubscriptionParams extends CommonParams {
  readonly mode: "subscription";
  /**
   * Metadata stored on the subscription the checkout creates, so a webhook
   * for that subscription can be attributed without reading the checkout
   * session back.
   */
  readonly subscriptionMetadata?: Record<string, string> | undefined;
}

/** Parameters for creating a checkout session, keyed on its `mode`. */
export type CreateParams = PaymentParams | SubscriptionParams;

/**
 * The hosted checkout capability. A provider supplies a `Layer` implementing
 * this service; programs depend only on this abstract interface.
 */
export class CheckoutSessions extends Context.Service<
  CheckoutSessions,
  {
    readonly create: (params: CreateParams) => Effect.Effect<CheckoutSession, PaymentsError>;
  }
>()("@effect-biz/payments/CheckoutSessions") {}

/**
 * Create a hosted checkout session; redirect the buyer to its `url`.
 *
 * @example
 * ```typescript
 * import { Effect } from "effect";
 * import * as CheckoutSession from "@thomasfosterau/effect-biz/Payments.CheckoutSession";
 *
 * const program = Effect.gen(function* () {
 *   const session = yield* CheckoutSession.create({
 *     mode: "subscription",
 *     customer: "cus_123",
 *     lineItems: [{ price: "price_monthly" }],
 *     successUrl: "https://example.com/billing?checkout=success",
 *     cancelUrl: "https://example.com/pricing",
 *   });
 *   return session.url; // redirect the buyer here
 * });
 * ```
 */
export const create = (
  params: CreateParams,
): Effect.Effect<CheckoutSession, PaymentsError, CheckoutSessions> =>
  Effect.flatMap(CheckoutSessions, (service) => service.create(params));
