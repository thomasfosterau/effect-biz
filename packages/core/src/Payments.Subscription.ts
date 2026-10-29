/**
 * Vendor-neutral subscription resource.
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
 * The subscription statuses that this library models, normalized across
 * providers.
 */
export const KnownSubscriptionStatus = Schema.Literals([
  "active",
  "past_due",
  "unpaid",
  "canceled",
  "incomplete",
  "incomplete_expired",
  "trialing",
  "paused",
]);
export type KnownSubscriptionStatus = typeof KnownSubscriptionStatus.Type;

/**
 * The status of a subscription: a {@link KnownSubscriptionStatus}, or `Other`
 * carrying the raw status a provider sent that is not modelled.
 */
export const SubscriptionStatus = Enumeration.lenient(KnownSubscriptionStatus);
export type SubscriptionStatus = typeof SubscriptionStatus.Type;

/** A single line item of a subscription, billed against a price. */
export class SubscriptionItem extends Schema.Class<SubscriptionItem>(
  "@effect-biz/payments/SubscriptionItem",
)({
  id: Schema.String,
  priceId: Schema.String,
  quantity: Schema.NullOr(Schema.Number),
}) {}

/**
 * A recurring agreement to bill a customer for one or more prices.
 */
export class Subscription extends Schema.Class<Subscription>("@effect-biz/payments/Subscription")({
  id: Schema.String,
  customerId: Schema.String,
  status: SubscriptionStatus,
  items: Schema.Array(SubscriptionItem),
  /** Start of the current billing period (Unix timestamp in seconds). */
  currentPeriodStart: Schema.Number,
  /** End of the current billing period (Unix timestamp in seconds). */
  currentPeriodEnd: Schema.Number,
  cancelAtPeriodEnd: Schema.Boolean,
  metadata: Metadata,
  /** Creation time as a Unix timestamp in seconds. */
  created: Schema.Number,
}) {}

/** A price/quantity pair used when creating a subscription. */
export interface ItemParams {
  readonly price: string;
  readonly quantity?: number | undefined;
}

/** Parameters for creating a subscription. */
export interface CreateParams {
  readonly customer: string;
  readonly items: ReadonlyArray<ItemParams>;
  readonly cancelAtPeriodEnd?: boolean | undefined;
  readonly metadata?: Record<string, string> | undefined;
  /**
   * Makes this write safe to repeat: create one with `IdempotencyKey.generate`
   * before the first attempt and pass the same key on every retry (see
   * `IdempotencyKey` for the contract).
   */
  readonly idempotencyKey?: IdempotencyKey | undefined;
}

/** Parameters for updating a subscription. */
export interface UpdateParams {
  readonly cancelAtPeriodEnd?: boolean | undefined;
  readonly metadata?: Record<string, string> | undefined;
}

/** Parameters for listing subscriptions. */
export interface ListParams {
  readonly limit?: number | undefined;
  readonly customer?: string | undefined;
  /** A status to filter by; only a known status can be requested. */
  readonly status?: KnownSubscriptionStatus | undefined;
  /**
   * The previous page's `nextCursor`, to list the page after it. A provider
   * whose cursor is an item id also takes any item id here.
   */
  readonly startingAfter?: string | undefined;
}

/**
 * The subscription capability.
 */
export class Subscriptions extends Context.Service<
  Subscriptions,
  {
    readonly create: (params: CreateParams) => Effect.Effect<Subscription, PaymentsError>;
    readonly retrieve: (id: string) => Effect.Effect<Subscription, PaymentsError>;
    readonly update: (
      id: string,
      params: UpdateParams,
    ) => Effect.Effect<Subscription, PaymentsError>;
    readonly cancel: (id: string) => Effect.Effect<Subscription, PaymentsError>;
    readonly list: (params?: ListParams) => Effect.Effect<Page<Subscription>, PaymentsError>;
  }
>()("@effect-biz/payments/Subscriptions") {}

/**
 * Create a subscription.
 *
 * For example, onboarding a new customer onto a price:
 *
 * @example
 * ```typescript
 * import { Effect } from "effect";
 * import * as Customer from "@thomasfosterau/effect-biz/Payments.Customer";
 * import * as Subscription from "@thomasfosterau/effect-biz/Payments.Subscription";
 *
 * const onboard = (email: string, priceId: string) =>
 *   Effect.gen(function* () {
 *     const customer = yield* Customer.create({ email });
 *     const subscription = yield* Subscription.create({
 *       customer: customer.id,
 *       items: [{ price: priceId }],
 *     });
 *     return { customer, subscription };
 *   });
 * ```
 */
export const create = (
  params: CreateParams,
): Effect.Effect<Subscription, PaymentsError, Subscriptions> =>
  Effect.flatMap(Subscriptions, (service) => service.create(params));
/** Retrieve a subscription by id. */
export const retrieve = (id: string): Effect.Effect<Subscription, PaymentsError, Subscriptions> =>
  Effect.flatMap(Subscriptions, (service) => service.retrieve(id));
/**
 * Update a subscription. Fails with `PaymentInvalidRequestError` on a provider
 * without this operation.
 */
export const update = (
  id: string,
  params: UpdateParams,
): Effect.Effect<Subscription, PaymentsError, Subscriptions> =>
  Effect.flatMap(Subscriptions, (service) => service.update(id, params));
/** Cancel a subscription. */
export const cancel = (id: string): Effect.Effect<Subscription, PaymentsError, Subscriptions> =>
  Effect.flatMap(Subscriptions, (service) => service.cancel(id));
/**
 * List subscriptions. Fails with `PaymentInvalidRequestError` on a provider
 * without this operation.
 */
export const list = (
  params?: ListParams,
): Effect.Effect<Page<Subscription>, PaymentsError, Subscriptions> =>
  Effect.flatMap(Subscriptions, (service) => service.list(params));
