/**
 * Vendor-neutral error types for payment operations.
 *
 * These errors form the failure channel of every operation exposed by the
 * payments core. Concrete providers translate their vendor's error responses
 * into these variants, so a program never depends on one vendor's error
 * taxonomy.
 *
 * @module
 */

import * as Schema from "effect/Schema";

/**
 * Raised when the payment provider rejects a request for a reason that does
 * not map onto a more specific variant (the catch-all API error).
 */
export class PaymentProviderError extends Schema.TaggedError<PaymentProviderError>()(
  "PaymentProviderError",
  {
    message: Schema.String,
    /** The provider that produced the error, e.g. `"stripe"`. */
    provider: Schema.String,
    /** Provider-specific error code, when available. */
    code: Schema.optional(Schema.String),
    /** HTTP status code returned by the provider, when available. */
    statusCode: Schema.optional(Schema.Number),
    /** The original, provider-specific error object. */
    cause: Schema.optional(Schema.Defect()),
  },
) {}

/**
 * Raised when the provider could not authenticate the request (e.g. an
 * invalid or revoked API key).
 */
export class PaymentAuthenticationError extends Schema.TaggedError<PaymentAuthenticationError>()(
  "PaymentAuthenticationError",
  {
    message: Schema.String,
    statusCode: Schema.optional(Schema.Number),
  },
) {}

/**
 * Raised when the provider rejects a request because too many requests have
 * been made in a short window.
 */
export class PaymentRateLimitError extends Schema.TaggedError<PaymentRateLimitError>()(
  "PaymentRateLimitError",
  {
    message: Schema.String,
    /** Seconds to wait before retrying, when the provider advertises it. */
    retryAfter: Schema.optional(Schema.Number),
  },
) {}

/**
 * Raised when the request parameters are invalid.
 */
export class PaymentInvalidRequestError extends Schema.TaggedError<PaymentInvalidRequestError>()(
  "PaymentInvalidRequestError",
  {
    message: Schema.String,
    /** The offending parameter, when the provider identifies one. */
    param: Schema.optional(Schema.String),
    statusCode: Schema.optional(Schema.Number),
  },
) {}

/**
 * Raised when a transport-level/network failure occurs while talking to the
 * provider.
 */
export class PaymentNetworkError extends Schema.TaggedError<PaymentNetworkError>()(
  "PaymentNetworkError",
  {
    message: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {}

/**
 * Raised when no provider is available to serve the call — typically because
 * its credential is not configured in this environment. It is raised at CALL
 * time, never while building a layer, so an application without payments
 * configured still starts and serves everything else; "not configured"
 * behaves exactly like "the provider is down" (an HTTP API would answer it
 * with a 503). The message never carries a secret.
 */
export class PaymentsUnavailable extends Schema.TaggedError<PaymentsUnavailable>()(
  "PaymentsUnavailable",
  {
    message: Schema.String,
    /** The provider that is unavailable, e.g. `"stripe"`, when known. */
    provider: Schema.optional(Schema.String),
  },
) {}

/**
 * Raised when a provider client/layer is misconfigured. This occurs during
 * layer construction rather than during an individual API call, which is why
 * it is not part of {@link PaymentsError}.
 */
export class PaymentConfigError extends Schema.TaggedError<PaymentConfigError>()(
  "PaymentConfigError",
  {
    message: Schema.String,
  },
) {}

/**
 * Raised when verifying the signature of an incoming webhook fails.
 */
export class SignatureVerificationError extends Schema.TaggedError<SignatureVerificationError>()(
  "SignatureVerificationError",
  {
    message: Schema.String,
    header: Schema.optional(Schema.String),
    payload: Schema.optional(Schema.String),
  },
) {}

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
