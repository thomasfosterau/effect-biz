/**
 * Translation of Stripe failures into the vendor-neutral error channel:
 * `StripeHttp` classifies an HTTP status plus the decoded error envelope and
 * hands it to {@link toPaymentsError}.
 *
 * @module
 */

import * as Match from "effect/Match";
import * as Option from "effect/Option";
import * as P from "effect/Predicate";
import * as R from "effect/Record";
import * as Schema from "effect/Schema";
import {
  PaymentAuthenticationError,
  PaymentInvalidRequestError,
  PaymentNetworkError,
  PaymentProviderError,
  PaymentRateLimitError,
  type PaymentsError,
} from "@thomasfosterau/effect-biz/Payments";

/**
 * The provider tag attached to neutral errors raised by this implementation.
 */
export const PROVIDER = "stripe";

/**
 * The classification `StripeHttp` produces, named after the Stripe SDK's error
 * classes. A {@link PaymentProviderError} carries one as its
 * `code` when Stripe sent no error code of its own.
 */
type StripeErrorKind =
  | "StripeCardError"
  | "StripeInvalidRequestError"
  | "StripeAPIError"
  | "StripeAuthenticationError"
  | "StripePermissionError"
  | "StripeRateLimitError"
  | "StripeIdempotencyError"
  | "StripeInvalidGrantError"
  | "StripeConnectionError"
  | "StripeUnknownError";

/** A classified Stripe failure. */
export interface StripeFailure {
  /** A {@link StripeErrorKind}. */
  readonly kind: string;
  readonly message: string;
  /** Stripe's own error code (`resource_missing`, `card_declined`, …). */
  readonly code: Option.Option<string>;
  readonly statusCode: Option.Option<number>;
  /** The offending parameter, when Stripe names one. */
  readonly param: Option.Option<string>;
  /** Seconds to wait, from a `Retry-After` header. */
  readonly retryAfter: Option.Option<number>;
  /** The vendor error object (never the request, never the key). */
  readonly raw?: unknown;
}

/** A failure with only a kind and a message (no response behind it): no code, status, parameter or retry delay. */
export const bareFailure = (kind: string, message: string): StripeFailure => ({
  kind,
  message,
  code: Option.none(),
  statusCode: Option.none(),
  param: Option.none(),
  retryAfter: Option.none(),
  raw: undefined,
});

/** A string Stripe may send, omit, or send as `null` (`"code": null`). */
const Text = Schema.optional(Schema.NullOr(Schema.String));

/**
 * The `error` member of a Stripe error response, narrowed to the fields the
 * classification reads. Every field is optional and nullable, and unknown
 * fields are ignored: the envelope is decoded leniently, and a body that does
 * not decode is classified from its status alone.
 */
const StripeErrorObject = Schema.Struct({
  type: Text,
  code: Text,
  message: Text,
  param: Text,
});

/**
 * A Stripe error response: `{ error: { type, code, message, param, … } }`,
 * or the OAuth form `{ error: "invalid_grant", error_description }`.
 */
const StripeErrorEnvelope = Schema.Struct({
  error: Schema.Union([StripeErrorObject, Schema.String]),
  error_description: Text,
});

/** The classification's view of an error body, `null`s read as absent. */
interface StripeErrorFields {
  readonly type: Option.Option<string>;
  readonly code: Option.Option<string>;
  readonly message: Option.Option<string>;
  readonly param: Option.Option<string>;
  /**
   * The vendor error object exactly as received — every field, including the
   * ones not decoded (`decline_code`, `payment_intent`, `advice_code`, …) —
   * or the whole body for the OAuth form.
   */
  readonly raw: unknown;
}

const decodeEnvelope = Schema.decodeUnknownOption(StripeErrorEnvelope);

/** The error fields of a response body, normalising the OAuth form. */
const errorFieldsOf = (body: Option.Option<Schema.Json>): Option.Option<StripeErrorFields> =>
  Option.map(
    Option.flatMap(body, decodeEnvelope),
    ({ error, error_description }): StripeErrorFields =>
      P.isString(error)
        ? {
            type: Option.some(error),
            code: Option.none(),
            message: Option.fromNullishOr(error_description),
            param: Option.none(),
            raw: Option.getOrUndefined(body),
          }
        : {
            type: Option.fromNullishOr(error.type),
            code: Option.fromNullishOr(error.code),
            message: Option.fromNullishOr(error.message),
            param: Option.fromNullishOr(error.param),
            raw: Option.getOrUndefined(
              Option.flatMap(body, (json) =>
                P.hasProperty(json, "error") ? Option.some(json.error) : Option.none(),
              ),
            ),
          },
  );

/** The SDK's `type` → error class dispatch (`StripeError.generate`). */
const KIND_BY_TYPE: R.ReadonlyRecord<string, StripeErrorKind> = {
  card_error: "StripeCardError",
  invalid_request_error: "StripeInvalidRequestError",
  api_error: "StripeAPIError",
  authentication_error: "StripeAuthenticationError",
  rate_limit_error: "StripeRateLimitError",
  idempotency_error: "StripeIdempotencyError",
  invalid_grant: "StripeInvalidGrantError",
};

/** The statuses whose class the SDK's response handler fixes regardless of `type`. */
const KIND_BY_STATUS: R.ReadonlyRecord<string, StripeErrorKind> = {
  401: "StripeAuthenticationError",
  403: "StripePermissionError",
  429: "StripeRateLimitError",
};

/**
 * The status wins over the body's `type` for 401 / 403 / 429, as in the SDK's
 * response handler; otherwise the body's `type` decides.
 */
const kindOf = (status: number, type: Option.Option<string>): StripeErrorKind =>
  R.get(KIND_BY_STATUS, String(status)).pipe(
    Option.orElse(() => Option.flatMap(type, (known) => R.get(KIND_BY_TYPE, known))),
    Option.getOrElse((): StripeErrorKind => "StripeUnknownError"),
  );

/** Parse a `Retry-After` header given in whole seconds. */
export const retryAfterOf = (header: Option.Option<string>): Option.Option<number> =>
  Option.filter(
    Option.map(header, (text) => Number.parseInt(text, 10)),
    (parsed) => !Number.isNaN(parsed),
  );

/**
 * Classify a non-2xx HTTP response from its status, its `Retry-After` header
 * and its (JSON-parsed, still unknown) body.
 */
export const classifyResponse = (
  status: number,
  retryAfter: Option.Option<string>,
  body: Option.Option<Schema.Json>,
): StripeFailure => {
  const fallback = `Stripe request failed with status ${status}`;
  const error = errorFieldsOf(body);
  if (Option.isNone(error)) {
    // Not a Stripe error envelope — typically a proxy or load-balancer page.
    return {
      kind: kindOf(status, Option.some("api_error")),
      message: fallback,
      code: Option.none(),
      statusCode: Option.some(status),
      param: Option.none(),
      retryAfter: retryAfterOf(retryAfter),
      raw: undefined,
    };
  }
  return {
    kind: kindOf(status, error.value.type),
    message: Option.getOrElse(error.value.message, () => fallback),
    code: error.value.code,
    statusCode: Option.some(status),
    param: error.value.param,
    retryAfter: retryAfterOf(retryAfter),
    raw: error.value.raw,
  };
};

/**
 * Map a classified Stripe failure onto the neutral error channel. The mapping
 * `handleStripeError` has always applied to SDK errors:
 *
 * - authentication → {@link PaymentAuthenticationError}
 * - rate limit → {@link PaymentRateLimitError} (with `Retry-After`)
 * - invalid request → {@link PaymentInvalidRequestError} (with `param`)
 * - connection → {@link PaymentNetworkError}
 * - everything else (card, permission, idempotency, API, unknown) →
 *   {@link PaymentProviderError} with Stripe's code, or the kind when it sent
 *   none.
 */
export const toPaymentsError = (failure: StripeFailure): PaymentsError => {
  const { kind, message } = failure;
  const statusCode = Option.getOrUndefined(failure.statusCode);
  return Match.value(kind).pipe(
    Match.when(
      "StripeAuthenticationError",
      (): PaymentsError => new PaymentAuthenticationError({ message, statusCode }),
    ),
    Match.when(
      "StripeRateLimitError",
      (): PaymentsError =>
        new PaymentRateLimitError({
          message,
          retryAfter: Option.getOrUndefined(failure.retryAfter),
        }),
    ),
    Match.when(
      "StripeInvalidRequestError",
      (): PaymentsError =>
        new PaymentInvalidRequestError({
          message,
          param: Option.getOrUndefined(failure.param),
          statusCode,
        }),
    ),
    Match.when(
      "StripeConnectionError",
      (): PaymentsError => new PaymentNetworkError({ message, cause: failure.raw }),
    ),
    Match.orElse(
      (): PaymentsError =>
        new PaymentProviderError({
          message,
          provider: PROVIDER,
          code: Option.getOrElse(failure.code, () => kind),
          statusCode,
          cause: failure.raw,
        }),
    ),
  );
};
