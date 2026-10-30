/**
 * Translation of PayPal HTTP error responses into the vendor-neutral error
 * channel.
 *
 * @module
 */

import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import type { PaymentsError } from "@thomasfosterau/effect-biz/Payments";
import { errorFromStatus } from "@thomasfosterau/effect-biz/Payments.internal";

/** The provider tag attached to neutral errors raised by this implementation. */
export const PROVIDER = "paypal";

/** The shape of a PayPal API error body (every member optional). */
const PayPalErrorBody = Schema.Struct({
  name: Schema.optional(Schema.String),
  message: Schema.optional(Schema.String),
  details: Schema.optional(
    Schema.Array(
      Schema.Struct({
        field: Schema.optional(Schema.String),
        issue: Schema.optional(Schema.String),
      }),
    ),
  ),
});
type PayPalErrorBody = typeof PayPalErrorBody.Type;

/** A vendor error body, decoded leniently: an unexpected shape maps as absent. */
export const errorBodyOf = (json: unknown): PayPalErrorBody | undefined =>
  Option.getOrUndefined(Schema.decodeUnknownOption(PayPalErrorBody)(json));

/**
 * Map a PayPal HTTP status + error body onto a neutral payments error: the
 * status picks the class (`errorFromStatus`), the first detail's `field`
 * names the offending parameter, the body's `name` the provider error code,
 * and a 429's `Retry-After` header (whole seconds) becomes the rate limit's
 * `retryAfter`.
 */
export const handlePayPalError = (
  status: number,
  body: PayPalErrorBody | undefined,
  retryAfter?: string,
): PaymentsError =>
  errorFromStatus(status, {
    provider: PROVIDER,
    message: body?.message ?? `PayPal request failed with status ${status}`,
    code: body?.name,
    param: body?.details?.[0]?.field,
    retryAfter,
  });
