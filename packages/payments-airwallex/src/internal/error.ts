/**
 * Translation of Airwallex HTTP error responses into the vendor-neutral error
 * channel.
 *
 * @module
 */

import * as Schema from "effect/Schema";
import type { PaymentsError } from "@thomasfosterau/effect-biz/Payments";
import { errorFromStatus } from "@thomasfosterau/effect-biz/Payments.internal";

/** The provider tag attached to neutral errors raised by this implementation. */
export const PROVIDER = "airwallex";

/** The shape of an Airwallex API error body (every member optional). */
export const AirwallexErrorBody = Schema.Struct({
  code: Schema.optional(Schema.String),
  message: Schema.optional(Schema.String),
  source: Schema.optional(Schema.String),
});
export type AirwallexErrorBody = typeof AirwallexErrorBody.Type;

/**
 * Map an Airwallex HTTP status + error body onto a neutral payments error:
 * the status picks the class (`errorFromStatus`), the body's `source` names
 * the offending parameter, its `code` the provider error code, and a 429's
 * `Retry-After` header (whole seconds) becomes the rate limit's `retryAfter`.
 */
export const handleAirwallexError = (
  status: number,
  body: AirwallexErrorBody | undefined,
  retryAfter?: string,
): PaymentsError =>
  errorFromStatus(status, {
    provider: PROVIDER,
    message: body?.message ?? `Airwallex request failed with status ${status}`,
    code: body?.code,
    param: body?.source,
    retryAfter,
  });
