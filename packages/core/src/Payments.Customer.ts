/**
 * Vendor-neutral customer resource.
 *
 * Defines the neutral {@link Customer} entity, the {@link Customers} capability
 * (an abstract service that a provider implements), and accessor functions that
 * dispatch to whichever provider has been supplied to the environment.
 *
 * See {@link create} for an example.
 *
 * @module
 */

import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { Metadata } from "./Payments.Money.js";
import type { Page, Deleted } from "./Payments.Page.js";
import type { IdempotencyKey } from "./Payments.IdempotencyKey.js";
import type { PaymentsError } from "./Payments.PaymentsError.js";

/**
 * A customer of the payments platform.
 */
export class Customer extends Schema.Class<Customer>("@effect-biz/payments/Customer")({
  id: Schema.String,
  email: Schema.NullOr(Schema.String),
  name: Schema.NullOr(Schema.String),
  phone: Schema.NullOr(Schema.String),
  description: Schema.NullOr(Schema.String),
  metadata: Metadata,
  /** Creation time as a Unix timestamp in seconds. */
  created: Schema.Number,
  /** Whether the customer exists in live (non-test) mode. */
  livemode: Schema.Boolean,
}) {}

/** Parameters for creating a customer. */
export interface CreateParams {
  readonly email?: string | undefined;
  readonly name?: string | undefined;
  readonly phone?: string | undefined;
  readonly description?: string | undefined;
  readonly metadata?: Record<string, string> | undefined;
  /**
   * Makes this write safe to repeat: create one with `IdempotencyKey.generate`
   * before the first attempt and pass the same key on every retry (see
   * `IdempotencyKey` for the contract).
   */
  readonly idempotencyKey?: IdempotencyKey | undefined;
}

/** Parameters for updating a customer. */
export interface UpdateParams {
  readonly email?: string | undefined;
  readonly name?: string | undefined;
  readonly phone?: string | undefined;
  readonly description?: string | undefined;
  readonly metadata?: Record<string, string> | undefined;
}

/** Parameters for listing customers. */
export interface ListParams {
  readonly limit?: number | undefined;
  readonly email?: string | undefined;
  /**
   * The previous page's `nextCursor`, to list the page after it. A provider
   * whose cursor is an item id also takes any item id here.
   */
  readonly startingAfter?: string | undefined;
}

/**
 * The customer capability. A provider supplies a `Layer` implementing this
 * service; programs depend only on this abstract interface.
 */
export class Customers extends Context.Service<
  Customers,
  {
    readonly create: (params: CreateParams) => Effect.Effect<Customer, PaymentsError>;
    readonly retrieve: (id: string) => Effect.Effect<Customer, PaymentsError>;
    readonly update: (id: string, params: UpdateParams) => Effect.Effect<Customer, PaymentsError>;
    readonly del: (id: string) => Effect.Effect<Deleted, PaymentsError>;
    readonly list: (params?: ListParams) => Effect.Effect<Page<Customer>, PaymentsError>;
  }
>()("@effect-biz/payments/Customers") {}

/**
 * Create a customer.
 *
 * @example
 * ```typescript
 * import { Effect } from "effect";
 * import * as Customer from "@thomasfosterau/effect-biz/Payments.Customer";
 *
 * const program = Effect.gen(function* () {
 *   const customer = yield* Customer.create({ email: "jane@example.com" });
 *   return customer;
 * });
 * // Provide a concrete implementation, e.g. the Stripe provider, to run it.
 * ```
 */
export const create = (params: CreateParams): Effect.Effect<Customer, PaymentsError, Customers> =>
  Effect.flatMap(Customers, (service) => service.create(params));
/** Retrieve a customer by id. */
export const retrieve = (id: string): Effect.Effect<Customer, PaymentsError, Customers> =>
  Effect.flatMap(Customers, (service) => service.retrieve(id));
/** Update a customer. */
export const update = (
  id: string,
  params: UpdateParams,
): Effect.Effect<Customer, PaymentsError, Customers> =>
  Effect.flatMap(Customers, (service) => service.update(id, params));
/**
 * Delete a customer. Fails with `PaymentInvalidRequestError` on a provider
 * without this operation.
 */
export const del = (id: string): Effect.Effect<Deleted, PaymentsError, Customers> =>
  Effect.flatMap(Customers, (service) => service.del(id));
/** List customers. */
export const list = (
  params?: ListParams,
): Effect.Effect<Page<Customer>, PaymentsError, Customers> =>
  Effect.flatMap(Customers, (service) => service.list(params));
