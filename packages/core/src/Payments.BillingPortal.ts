/**
 * Vendor-neutral hosted billing portal.
 *
 * A billing portal session is a self-service page the provider hosts, where an
 * existing customer updates their payment method, reviews invoices or cancels a
 * subscription. The program creates one for a customer and redirects them to
 * its {@link BillingPortalSession.url}; the provider sends them back to
 * `returnUrl`, and any change they made arrives through the provider's
 * webhooks.
 *
 * See {@link create} for an example.
 *
 * @module
 */

import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type { PaymentsError } from "./Payments.PaymentsError.js";

/** A hosted billing portal session: the page to redirect the customer to. */
export class BillingPortalSession extends Schema.Class<BillingPortalSession>(
  "@effect-biz/payments/BillingPortalSession",
)({
  id: Schema.String,
  /** The hosted portal page. Redirect the customer here. */
  url: Schema.String,
}) {}

/** Parameters for creating a billing portal session. */
export interface CreateParams {
  /** The customer whose billing the portal manages. */
  readonly customer: string;
  /** Where the provider sends the customer when they leave the portal. */
  readonly returnUrl: string;
}

/**
 * The hosted billing portal capability. A provider supplies a `Layer`
 * implementing this service; programs depend only on this abstract interface.
 */
export class BillingPortalSessions extends Context.Service<
  BillingPortalSessions,
  {
    readonly create: (params: CreateParams) => Effect.Effect<BillingPortalSession, PaymentsError>;
  }
>()("@effect-biz/payments/BillingPortalSessions") {}

/**
 * Create a hosted billing portal session; redirect the customer to its `url`.
 *
 * @example
 * ```typescript
 * import { Effect } from "effect";
 * import * as BillingPortal from "@thomasfosterau/effect-biz/Payments.BillingPortal";
 *
 * const program = Effect.gen(function* () {
 *   const session = yield* BillingPortal.create({
 *     customer: "cus_123",
 *     returnUrl: "https://example.com/account/billing",
 *   });
 *   return session.url; // redirect the customer here
 * });
 * ```
 */
export const create = (
  params: CreateParams,
): Effect.Effect<BillingPortalSession, PaymentsError, BillingPortalSessions> =>
  Effect.flatMap(BillingPortalSessions, (service) => service.create(params));
