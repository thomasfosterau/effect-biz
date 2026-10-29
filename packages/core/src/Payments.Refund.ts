/**
 * Vendor-neutral refund resource.
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
 * The refund statuses that this library models, normalized across providers.
 */
export const KnownRefundStatus = Schema.Literals([
  "pending",
  "requires_action",
  "succeeded",
  "failed",
  "canceled",
]);
export type KnownRefundStatus = typeof KnownRefundStatus.Type;

/**
 * The status of a refund: a {@link KnownRefundStatus}, or `Other` carrying the
 * raw status a provider sent that is not modelled.
 */
export const RefundStatus = Enumeration.lenient(KnownRefundStatus);
export type RefundStatus = typeof RefundStatus.Type;

/**
 * A refund of a previously captured payment.
 */
export class Refund extends Schema.Class<Refund>("@effect-biz/payments/Refund")({
  id: Schema.String,
  /** Amount refunded in the smallest currency unit. */
  amount: Schema.Number,
  currency: Schema.String,
  status: RefundStatus,
  /** The payment intent being refunded, if the refund targets one. */
  paymentIntentId: Schema.NullOr(Schema.String),
  /** The charge being refunded, if the refund targets one. */
  chargeId: Schema.NullOr(Schema.String),
  reason: Schema.NullOr(Schema.String),
  metadata: Metadata,
  /** Creation time as a Unix timestamp in seconds. */
  created: Schema.Number,
}) {}

/** Parameters for creating a refund. Provide either a payment intent or charge. */
export interface CreateParams {
  readonly paymentIntent?: string | undefined;
  readonly charge?: string | undefined;
  /** Amount to refund in the smallest currency unit; omit for a full refund. */
  readonly amount?: number | undefined;
  readonly reason?: string | undefined;
  readonly metadata?: Record<string, string> | undefined;
  /**
   * Makes this write safe to repeat: create one with `IdempotencyKey.generate`
   * before the first attempt and pass the same key on every retry (see
   * `IdempotencyKey` for the contract).
   */
  readonly idempotencyKey?: IdempotencyKey | undefined;
}

/** Parameters for updating a refund. */
export interface UpdateParams {
  readonly metadata?: Record<string, string> | undefined;
}

/** Parameters for listing refunds. */
export interface ListParams {
  readonly limit?: number | undefined;
  readonly paymentIntent?: string | undefined;
  readonly charge?: string | undefined;
  /**
   * The previous page's `nextCursor`, to list the page after it. A provider
   * whose cursor is an item id also takes any item id here.
   */
  readonly startingAfter?: string | undefined;
}

/**
 * The refund capability.
 */
export class Refunds extends Context.Service<
  Refunds,
  {
    readonly create: (params: CreateParams) => Effect.Effect<Refund, PaymentsError>;
    readonly retrieve: (id: string) => Effect.Effect<Refund, PaymentsError>;
    readonly update: (id: string, params: UpdateParams) => Effect.Effect<Refund, PaymentsError>;
    readonly list: (params?: ListParams) => Effect.Effect<Page<Refund>, PaymentsError>;
  }
>()("@effect-biz/payments/Refunds") {}

/**
 * Create a refund. Fails with `PaymentInvalidRequestError` when the provider
 * cannot refund the given reference (a `charge` where it needs a
 * `paymentIntent`, or a `paymentIntent` with nothing captured).
 */
export const create = (params: CreateParams): Effect.Effect<Refund, PaymentsError, Refunds> =>
  Effect.flatMap(Refunds, (service) => service.create(params));
/** Retrieve a refund by id. */
export const retrieve = (id: string): Effect.Effect<Refund, PaymentsError, Refunds> =>
  Effect.flatMap(Refunds, (service) => service.retrieve(id));
/**
 * Update a refund. Fails with `PaymentInvalidRequestError` on a provider
 * without this operation.
 */
export const update = (
  id: string,
  params: UpdateParams,
): Effect.Effect<Refund, PaymentsError, Refunds> =>
  Effect.flatMap(Refunds, (service) => service.update(id, params));
/**
 * List refunds. Fails with `PaymentInvalidRequestError` on a provider
 * without this operation.
 */
export const list = (params?: ListParams): Effect.Effect<Page<Refund>, PaymentsError, Refunds> =>
  Effect.flatMap(Refunds, (service) => service.list(params));
