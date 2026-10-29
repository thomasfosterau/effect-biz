/**
 * Vendor-neutral payment intent resource.
 *
 * A payment intent tracks the lifecycle of collecting a payment from a
 * customer, from creation through confirmation to a terminal state.
 *
 * @module
 */

import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Enumeration from "./Payments.Enumeration.js";
import { Metadata } from "./Payments.Money.js";
import type { Page } from "./Payments.Page.js";
import type { IdempotencyKey } from "./Payments.IdempotencyKey.js";
import type { PaymentsError } from "./Payments.PaymentsError.js";

/**
 * The lifecycle statuses of a payment intent that this library models,
 * normalized across providers.
 */
export const KnownPaymentStatus = Schema.Literals([
  "requires_payment_method",
  "requires_confirmation",
  "requires_action",
  "processing",
  "requires_capture",
  "canceled",
  "succeeded",
]);
export type KnownPaymentStatus = typeof KnownPaymentStatus.Type;

/**
 * The lifecycle status of a payment intent: a {@link KnownPaymentStatus}, or
 * `Other` carrying the raw status a provider sent that is not modelled.
 */
export const PaymentStatus = Enumeration.lenient(KnownPaymentStatus);
export type PaymentStatus = typeof PaymentStatus.Type;

/**
 * An attempt to collect a payment of a given amount and currency.
 */
export class PaymentIntent extends Schema.Class<PaymentIntent>(
  "@effect-biz/payments/PaymentIntent",
)({
  id: Schema.String,
  /** Amount in the smallest currency unit. */
  amount: Schema.Number,
  currency: Schema.String,
  status: PaymentStatus,
  customerId: Schema.NullOr(Schema.String),
  paymentMethodId: Schema.NullOr(Schema.String),
  /** Client secret used to complete the payment on the client side. */
  clientSecret: Schema.NullOr(Schema.String),
  description: Schema.NullOr(Schema.String),
  metadata: Metadata,
  /** Creation time as a Unix timestamp in seconds. */
  created: Schema.Number,
}) {}

/** Parameters for creating a payment intent. */
export interface CreateParams {
  /** Amount in the smallest currency unit (e.g. `2000` = $20.00). */
  readonly amount: number;
  /** Lower-cased ISO 4217 currency code, e.g. `"usd"`. */
  readonly currency: string;
  readonly customer?: string | undefined;
  readonly paymentMethod?: string | undefined;
  readonly description?: string | undefined;
  readonly metadata?: Record<string, string> | undefined;
  /**
   * Makes this write safe to repeat: create one with `IdempotencyKey.generate`
   * before the first attempt and pass the same key on every retry (see
   * `IdempotencyKey` for the contract).
   */
  readonly idempotencyKey?: IdempotencyKey | undefined;
}

/** Parameters for updating a payment intent. */
export interface UpdateParams {
  /** Amount in the smallest currency unit (e.g. `2000` = $20.00). */
  readonly amount?: number | undefined;
  readonly description?: string | undefined;
  readonly metadata?: Record<string, string> | undefined;
}

/** Parameters for confirming a payment intent. */
export interface ConfirmParams {
  readonly paymentMethod?: string | undefined;
  /**
   * Makes this write safe to repeat: create one with `IdempotencyKey.generate`
   * before the first attempt and pass the same key on every retry (see
   * `IdempotencyKey` for the contract).
   */
  readonly idempotencyKey?: IdempotencyKey | undefined;
}

/** Parameters for listing payment intents. */
export interface ListParams {
  readonly limit?: number | undefined;
  readonly customer?: string | undefined;
  /**
   * The previous page's `nextCursor`, to list the page after it. A provider
   * whose cursor is an item id also takes any item id here.
   */
  readonly startingAfter?: string | undefined;
}

/**
 * The payment intent capability.
 */
export class PaymentIntents extends Context.Service<
  PaymentIntents,
  {
    readonly create: (params: CreateParams) => Effect.Effect<PaymentIntent, PaymentsError>;
    readonly retrieve: (id: string) => Effect.Effect<PaymentIntent, PaymentsError>;
    readonly update: (
      id: string,
      params: UpdateParams,
    ) => Effect.Effect<PaymentIntent, PaymentsError>;
    readonly confirm: (
      id: string,
      params?: ConfirmParams,
    ) => Effect.Effect<PaymentIntent, PaymentsError>;
    readonly cancel: (id: string) => Effect.Effect<PaymentIntent, PaymentsError>;
    readonly list: (params?: ListParams) => Effect.Effect<Page<PaymentIntent>, PaymentsError>;
  }
>()("@effect-biz/payments/PaymentIntents") {}

/** Create a payment intent. */
export const create = (
  params: CreateParams,
): Effect.Effect<PaymentIntent, PaymentsError, PaymentIntents> =>
  Effect.flatMap(PaymentIntents, (service) => service.create(params));
/** Retrieve a payment intent by id. */
export const retrieve = (id: string): Effect.Effect<PaymentIntent, PaymentsError, PaymentIntents> =>
  Effect.flatMap(PaymentIntents, (service) => service.retrieve(id));
/**
 * Update a payment intent. Fails with `PaymentInvalidRequestError` on a provider
 * without this operation.
 */
export const update = (
  id: string,
  params: UpdateParams,
): Effect.Effect<PaymentIntent, PaymentsError, PaymentIntents> =>
  Effect.flatMap(PaymentIntents, (service) => service.update(id, params));
/** Confirm a payment intent. */
export const confirm = (
  id: string,
  params?: ConfirmParams,
): Effect.Effect<PaymentIntent, PaymentsError, PaymentIntents> =>
  Effect.flatMap(PaymentIntents, (service) => service.confirm(id, params));
/**
 * Cancel a payment intent. Fails with `PaymentInvalidRequestError` on a provider
 * without this operation.
 */
export const cancel = (id: string): Effect.Effect<PaymentIntent, PaymentsError, PaymentIntents> =>
  Effect.flatMap(PaymentIntents, (service) => service.cancel(id));
/**
 * List payment intents. Fails with `PaymentInvalidRequestError` on a provider
 * without this operation.
 */
export const list = (
  params?: ListParams,
): Effect.Effect<Page<PaymentIntent>, PaymentsError, PaymentIntents> =>
  Effect.flatMap(PaymentIntents, (service) => service.list(params));
