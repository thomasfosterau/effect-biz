/**
 * Vendor-neutral error types for payment operations.
 *
 * These errors form the failure channel of every operation exposed by the
 * payments core. Concrete providers translate their vendor's error responses
 * into these variants, so a program never depends on one vendor's error
 * taxonomy.
 *
 * A field that may be absent (`code`, `statusCode`, `param`, `retryAfter`,
 * `cause`, `provider`, `header`, `payload`) is an `Option`: `None` in memory,
 * an omitted key on the wire and over RPC, and left out of a constructor call.
 *
 * @module
 */

import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

/**
 * A field that may be absent: an `Option` in memory, an omitted key on the
 * wire (and over RPC). Left out of a constructor call, it is `None`.
 */
const Maybe = <S extends Schema.Constraint>(schema: S) =>
  Schema.OptionFromOptionalKey(schema).pipe(Schema.withConstructorDefault(Effect.succeedNone));

/**
 * Raised when the payment provider rejects a request for a reason that does
 * not map onto a more specific variant (the catch-all API error).
 */
export class PaymentProviderError extends Schema.TaggedError<
  PaymentProviderError,
  { readonly brand: unique symbol }
>()("PaymentProviderError", {
  message: Schema.String,
  /** The provider that produced the error, e.g. `"stripe"`. */
  provider: Schema.String,
  /** Provider-specific error code, when available. */
  code: Maybe(Schema.String),
  /** HTTP status code returned by the provider, when available. */
  statusCode: Maybe(Schema.Int),
  /** The original, provider-specific error object. */
  cause: Maybe(Schema.Defect()),
}) {}

/**
 * Raised when the provider could not authenticate the request (e.g. an
 * invalid or revoked API key).
 */
export class PaymentAuthenticationError extends Schema.TaggedError<
  PaymentAuthenticationError,
  { readonly brand: unique symbol }
>()("PaymentAuthenticationError", {
  message: Schema.String,
  statusCode: Maybe(Schema.Int),
}) {}

/**
 * Raised when the provider rejects a request because too many requests have
 * been made in a short window.
 */
export class PaymentRateLimitError extends Schema.TaggedError<
  PaymentRateLimitError,
  { readonly brand: unique symbol }
>()("PaymentRateLimitError", {
  message: Schema.String,
  /** Seconds to wait before retrying, when the provider advertises it. */
  retryAfter: Maybe(Schema.Finite),
}) {}

/**
 * Raised when the request parameters are invalid.
 */
export class PaymentInvalidRequestError extends Schema.TaggedError<
  PaymentInvalidRequestError,
  { readonly brand: unique symbol }
>()("PaymentInvalidRequestError", {
  message: Schema.String,
  /** The offending parameter, when the provider identifies one. */
  param: Maybe(Schema.String),
  statusCode: Maybe(Schema.Int),
}) {}

/**
 * Raised when a transport-level/network failure occurs while talking to the
 * provider.
 */
export class PaymentNetworkError extends Schema.TaggedError<
  PaymentNetworkError,
  { readonly brand: unique symbol }
>()("PaymentNetworkError", {
  message: Schema.String,
  cause: Maybe(Schema.Defect()),
}) {}

/**
 * Raised when no provider is available to serve the call — typically because
 * its credential is not configured in this environment. It is raised at CALL
 * time, never while building a layer, so an application without payments
 * configured still starts and serves everything else; "not configured"
 * behaves exactly like "the provider is down" (an HTTP API would answer it
 * with a 503). The message never carries a secret.
 */
export class PaymentsUnavailable extends Schema.TaggedError<
  PaymentsUnavailable,
  { readonly brand: unique symbol }
>()("PaymentsUnavailable", {
  message: Schema.String,
  /** The provider that is unavailable, e.g. `"stripe"`, when known. */
  provider: Maybe(Schema.String),
}) {}

/**
 * Raised when a provider client/layer is misconfigured. This occurs during
 * layer construction rather than during an individual API call, which is why
 * it is not part of {@link PaymentsError}.
 */
export class PaymentConfigError extends Schema.TaggedError<
  PaymentConfigError,
  { readonly brand: unique symbol }
>()("PaymentConfigError", {
  message: Schema.String,
}) {}

/**
 * Raised when verifying the signature of an incoming webhook fails.
 */
export class SignatureVerificationError extends Schema.TaggedError<
  SignatureVerificationError,
  { readonly brand: unique symbol }
>()("SignatureVerificationError", {
  message: Schema.String,
  header: Maybe(Schema.String),
  payload: Maybe(Schema.String),
}) {}

/**
 * The union of errors that can occur during a payment API call.
 *
 * {@link PaymentConfigError} and {@link SignatureVerificationError} are
 * intentionally excluded: the former only arises during layer construction and
 * the latter only during webhook verification.
 */
export type PaymentsError =
  | PaymentProviderError
  | PaymentAuthenticationError
  | PaymentRateLimitError
  | PaymentInvalidRequestError
  | PaymentNetworkError
  | PaymentsUnavailable;
