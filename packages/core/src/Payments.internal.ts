/**
 * Helpers shared by the provider packages in this repository.
 *
 * **Internal, and exempt from semver.** This subpath exists only so the
 * providers in this repository can share code, since a provider may import
 * nothing but this package. It is not part of the public API: its exports can
 * change or disappear in any release, minor and patch included. Do not import
 * it from application code.
 *
 * It holds these vendor-neutral pieces:
 *
 * - {@link shareLogin}: one in-flight token login shared by every caller that
 *   needs a token while it runs.
 * - The integer money core: {@link exponentFrom}, {@link scaleToMinor}, {@link parseDecimal},
 *   {@link decimalText}, {@link formatDecimal} and {@link checkMinorUnits}.
 *   Everything is parameterised by a fraction-digit count, so the per-currency
 *   exponent tables and the wire adapters stay in each provider.
 * - The token-login plumbing of an OAuth-style provider: {@link tokenCache},
 *   {@link send} (with {@link networkError} and {@link timedOut}),
 *   {@link timeoutOf}, {@link isAbsoluteHttpUrl} and {@link isOk}. Each takes
 *   the provider's name for its messages; the login request, its response
 *   schema and the vendor error mapping stay in each provider.
 * - The request helpers of a provider built over a generated operation
 *   client: {@link omitUndefined}, {@link checkId}, {@link stringField},
 *   {@link observeResponses} and {@link rejectedError}. None names a vendor or
 *   a client library: each provider keeps its own client wiring, retry and
 *   validation policy, and error classification.
 * - The response handling of a REST provider: {@link responseDecoder} (a
 *   wire body decoded and mapped onto a neutral value), {@link epochSecondsOf}
 *   (an ISO-8601 timestamp as the neutral Unix seconds) and
 *   {@link errorFromStatus} (an HTTP error status as the neutral error). Each
 *   provider keeps its wire schemas, its status spellings and the reading of
 *   its own error body.
 * - The paging of a page-numbered list: {@link pageNumberedList} (a
 *   `startingAfter` cursor as the vendor page to request, and the page's
 *   `nextCursor`). Each provider keeps its first page number, its page
 *   parameters and the filters it refuses.
 *
 * @module
 */

import * as Arr from "effect/Array";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as HashSet from "effect/HashSet";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as R from "effect/Record";
import * as Ref from "effect/Ref";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as Struct from "effect/Struct";
import {
  HttpClient,
  type HttpClientError,
  type HttpClientRequest,
  type HttpClientResponse,
} from "effect/http";
import {
  PaymentAuthenticationError,
  PaymentConfigError,
  PaymentInvalidRequestError,
  PaymentNetworkError,
  PaymentProviderError,
  PaymentRateLimitError,
  type PaymentsError,
} from "./Payments.PaymentsError.js";
import type { Page } from "./Payments.Page.js";

/**
 * What a leader publishes: the login's exit, or `None` when the leader was
 * interrupted before the login settled.
 */
type Outcome<E> = Option.Option<Exit.Exit<string, E>>;

/** The in-flight login's published outcome. */
type Slot<E> = Deferred.Deferred<Outcome<E>>;

/**
 * One in-flight login, shared by every caller that needs a token while it runs.
 *
 * The first caller without a usable token becomes the *leader*: it installs a
 * `Deferred` in the in-flight slot and runs the login. Every caller that
 * arrives while the slot is occupied awaits that `Deferred` instead of logging
 * in itself, so it observes the same outcome — the same token, or the very
 * same error (a login timeout's `PaymentNetworkError`, a 401's
 * `PaymentAuthenticationError`, …) after roughly one login's duration rather
 * than one login per queued caller. When the login settles the slot is
 * cleared *before* its outcome is published, so a caller that arrives after a
 * failure starts a fresh attempt; nothing is cached on failure.
 *
 * If the leader itself is interrupted (its caller gave up), the login it was
 * running is interrupted with it and the slot is cleared; the callers that
 * were waiting on it are told the login was abandoned and try again, so one of
 * them becomes the next leader. Nobody is left waiting on a login no one runs.
 * A login that fails on its own — whatever its cause — is shared, never
 * retried by the callers that waited on it.
 *
 * Builds a `getToken` effect from `cached` (the stored token, if still usable)
 * and `login` (which fetches and stores a new one).
 *
 * Internal, and exempt from semver: see the module documentation.
 */
export const shareLogin = <E>(
  cached: Effect.Effect<Option.Option<string>>,
  login: Effect.Effect<string, E>,
): Effect.Effect<Effect.Effect<string, E>> =>
  Effect.map(Ref.make(Option.none<Slot<E>>()), (inFlight) => {
    const loginUnlessCached: Effect.Effect<string, E> = Effect.flatMap(
      cached,
      Option.match({ onNone: () => login, onSome: Effect.succeed }),
    );

    /**
     * Run the login as the leader and publish its outcome through `slot`.
     *
     * The login runs in a child fiber, so its exit — whatever its cause, even
     * one containing an interruption of its own — arrives here as a *value*.
     * The only way awaiting it can fail is this leader being interrupted: that
     * alone is published as "abandoned" (after interrupting the login, which
     * aborts its fetch), so waiters retry only when no one is left to finish
     * the login, never after a login that failed on its own.
     *
     * The leader re-checks the cache: a previous leader may have stored a
     * token between this caller's first check and its taking the slot.
     */
    const lead = (slot: Slot<E>, restore: Restore): Effect.Effect<string, E> =>
      Effect.gen(function* () {
        const running = yield* Effect.forkChild(loginUnlessCached, { startImmediately: true });
        const exit = yield* restore(Fiber.await(running)).pipe(
          Effect.onInterrupt(() => Fiber.interrupt(running)),
          // Clear the slot BEFORE publishing, so a caller that arrives after
          // the outcome (even one resumed synchronously by the publish) never
          // joins a settled login: it sees the token, or logs in afresh.
          Effect.onExit((awaited) =>
            Ref.set(inFlight, Option.none()).pipe(
              Effect.andThen(
                Deferred.succeed(
                  slot,
                  Exit.isSuccess(awaited) ? Option.some(awaited.value) : Option.none(),
                ),
              ),
            ),
          ),
        );
        return yield* exit;
      });

    /** Take the slot for `fresh`, or return the login already in it. */
    const join = (fresh: Slot<E>): Effect.Effect<Option.Option<Slot<E>>> =>
      Ref.modify(inFlight, (current): readonly [Option.Option<Slot<E>>, Option.Option<Slot<E>>] =>
        Option.isSome(current) ? [current, current] : [Option.none(), Option.some(fresh)],
      );

    const getToken: () => Effect.Effect<string, E> = Effect.fnUntraced(function* () {
      const token = yield* cached;
      if (Option.isSome(token)) return token.value;
      const fresh = yield* Deferred.make<Outcome<E>>();
      // Taking the slot and attaching its release happen without an
      // interruption point between them, so a slot is never orphaned.
      return yield* Effect.uninterruptibleMask((restore) =>
        Effect.gen(function* () {
          const running = yield* join(fresh);
          if (Option.isNone(running)) return yield* lead(fresh, restore);
          const outcome = yield* restore(Deferred.await(running.value));
          // `None`: the leader gave up, so try again (as leader or waiter).
          return yield* Option.isSome(outcome) ? outcome.value : restore(getToken());
        }),
      );
    });
    return getToken();
  });

/** The `restore` an `Effect.uninterruptibleMask` body receives. */
type Restore = <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>;

/**
 * Build a provider's `exponent(currency)` from its own currency tables: the
 * codes (lower case) with no minor unit, and those with three fraction digits.
 * Every other currency has two. The lookup is case-insensitive. The tables are
 * the provider's, since they follow each vendor's own currency reference.
 *
 * Internal, and exempt from semver: see the module documentation.
 */
export const exponentFrom =
  (zeroDecimal: HashSet.HashSet<string>, threeDecimal: HashSet.HashSet<string>) =>
  (currency: string): 0 | 2 | 3 => {
    const code = currency.toLowerCase();
    if (HashSet.has(zeroDecimal, code)) return 0;
    if (HashSet.has(threeDecimal, code)) return 3;
    return 2;
  };

/** The largest minor-unit magnitude a neutral amount may have. */
const MAX_SAFE = BigInt(Number.MAX_SAFE_INTEGER);

/**
 * Scale the decimal `mantissa × 10^-scale` to minor units for a currency with
 * `digits` fraction digits, using integer (`BigInt`) arithmetic only. Returns
 * the magnitude, or `undefined` when the value has more fraction digits than
 * the currency allows (`scale > digits`, so nothing is rounded) or exceeds the
 * safe-integer range as minor units.
 *
 * Internal, and exempt from semver: see the module documentation.
 */
export const scaleToMinor = (
  mantissa: bigint,
  scale: number,
  digits: number,
): bigint | undefined => {
  if (scale > digits) return undefined;
  const magnitude = mantissa * 10n ** BigInt(digits - scale);
  return magnitude > MAX_SAFE ? undefined : magnitude;
};

/** An optionally negative decimal: whole digits and an optional fraction. */
const DECIMAL = /^(-?)(\d+)(?:\.(\d+))?$/;

/**
 * Parse a major-unit decimal string into minor units for a currency with
 * `digits` fraction digits, or `undefined` when it is malformed, has more
 * fraction digits than `digits`, or is outside the safe-integer range as minor
 * units. Never produces `-0`.
 *
 * Internal, and exempt from semver: see the module documentation.
 */
export const parseDecimal = (text: string, digits: number): number | undefined => {
  const match = DECIMAL.exec(text);
  if (match === null) return undefined;
  const [, sign, whole, fraction = ""] = match;
  const magnitude = scaleToMinor(BigInt(`${whole}${fraction}`), fraction.length, digits);
  if (magnitude === undefined) return undefined;
  // `magnitude` is 0 for "-0.00"; never produce -0.
  return sign === "-" && magnitude !== 0n ? -Number(magnitude) : Number(magnitude);
};

/**
 * The decimal text of `sign · magnitude × 10^-digits`, e.g. `-12.34`.
 *
 * Internal, and exempt from semver: see the module documentation.
 */
export const decimalText = (negative: boolean, magnitude: bigint, digits: number): string => {
  const text = magnitude.toString().padStart(digits + 1, "0");
  const point = text.length - digits;
  const body = digits === 0 ? text : `${text.slice(0, point)}.${text.slice(point)}`;
  return negative ? `-${body}` : body;
};

/**
 * Format minor units as a major-unit decimal string with `digits` fraction
 * digits, or `undefined` when `minor` is not a safe integer (such an amount has
 * no exact decimal form, and sending a rounded one would charge a different
 * amount).
 *
 * Internal, and exempt from semver: see the module documentation.
 */
export const formatDecimal = (minor: number, digits: number): string | undefined =>
  Number.isSafeInteger(minor) ? decimalText(minor < 0, BigInt(Math.abs(minor)), digits) : undefined;

/**
 * Check a request amount without needing its currency, failing with
 * {@link PaymentInvalidRequestError} (naming `param`) unless it is a
 * non-negative safe integer (a price, an order or a refund amount is never
 * below zero). Callers run it before sending anything.
 *
 * Internal, and exempt from semver: see the module documentation.
 */
export const checkMinorUnits = (
  minor: number,
  param: string,
): Effect.Effect<void, PaymentInvalidRequestError> =>
  Number.isSafeInteger(minor) && minor >= 0
    ? Effect.void
    : Effect.fail(
        new PaymentInvalidRequestError({
          message: `\`${param}\` must be a non-negative whole number of minor units within the safe-integer range`,
          param,
        }),
      );

// ---------------------------------------------------------------------------
// Token-login plumbing
// ---------------------------------------------------------------------------

/**
 * Whether `status` is a 2xx.
 *
 * Internal, and exempt from semver: see the module documentation.
 */
export const isOk = (status: number): boolean => status >= 200 && status < 300;

/**
 * Whether `value` parses as an absolute `http:` or `https:` URL (an empty
 * string does not): what a configured `baseUrl` must be.
 *
 * Internal, and exempt from semver: see the module documentation.
 */
export const isAbsoluteHttpUrl = (value: string): boolean =>
  Result.match(
    Result.try(() => new URL(value)),
    {
      onFailure: () => false,
      onSuccess: ({ protocol }) => protocol === "https:" || protocol === "http:",
    },
  );

/**
 * A configured timeout as a `Duration`: a positive, finite number of
 * milliseconds, or `Infinity` for no timeout. Anything else (`0`, a negative
 * number, `NaN`) fails with {@link PaymentConfigError}, naming `provider` and
 * the option `name`.
 *
 * Internal, and exempt from semver: see the module documentation.
 */
export const timeoutOf = (
  provider: string,
  name: string,
  millis: number,
): Effect.Effect<Duration.Duration, PaymentConfigError> =>
  millis === Number.POSITIVE_INFINITY || (Number.isFinite(millis) && millis > 0)
    ? Effect.succeed(Duration.millis(millis))
    : Effect.fail(
        new PaymentConfigError({
          message: `${provider} ${name} must be a positive number of milliseconds, or Infinity for none (got ${millis})`,
        }),
      );

/**
 * The underlying failure of an `HttpClientError`, without the request it
 * carries, whose headers hold the credentials.
 */
const causeOf = (error: HttpClientError.HttpClientError): unknown =>
  "cause" in error.reason ? error.reason.cause : undefined;

/**
 * An `HttpClientError` as a {@link PaymentNetworkError}, keeping only its
 * message and underlying cause: never the request, whose headers carry the
 * credentials.
 *
 * Internal, and exempt from semver: see the module documentation.
 */
export const networkError = (error: HttpClientError.HttpClientError): PaymentNetworkError =>
  new PaymentNetworkError({ message: error.message, cause: causeOf(error) });

/**
 * The failure of a `provider` exchange (`what`: `"login"`, `"request"`)
 * still unanswered after `limit`.
 *
 * Internal, and exempt from semver: see the module documentation.
 */
export const timedOut = (
  provider: string,
  what: string,
  limit: Duration.Duration,
): PaymentNetworkError =>
  new PaymentNetworkError({
    message: `${provider} ${what} timed out after ${Duration.toMillis(limit)} ms`,
  });

/**
 * A response reduced to its status and JSON body.
 *
 * Internal, and exempt from semver: see the module documentation.
 */
export interface Reply {
  readonly status: number;
  /** The response headers, keyed in lower case. */
  readonly headers: Readonly<Record<string, string | undefined>>;
  /** The JSON body, or `{}` when it is empty or not JSON. */
  readonly json: unknown;
}

/** The response body as JSON, or `{}` when it is empty or not JSON. */
const readJson = (response: HttpClientResponse.HttpClientResponse): Effect.Effect<unknown> =>
  response.json.pipe(Effect.orElseSucceed(() => ({})));

/**
 * Send `request` through `http` and read its JSON body, all within `limit`.
 * A request that has not finished by then is interrupted (which aborts the
 * fetch) and fails with {@link timedOut}; a connection failure fails with
 * {@link networkError}. Any status is a {@link Reply}: classifying it is the
 * provider's.
 *
 * Internal, and exempt from semver: see the module documentation.
 */
export const send = (
  http: HttpClient.HttpClient,
  request: HttpClientRequest.HttpClientRequest,
  options: {
    /** The provider's name, for the timeout message. */
    readonly provider: string;
    /** What the request is, for the timeout message: `"login"`, `"request"`. */
    readonly what: string;
    readonly limit: Duration.Duration;
  },
): Effect.Effect<Reply, PaymentNetworkError> =>
  http.execute(request).pipe(
    Effect.flatMap((response) =>
      Effect.map(readJson(response), (json): Reply => ({
        status: response.status,
        headers: response.headers,
        json,
      })),
    ),
    // The error's request carries the credentials in its headers: keep only
    // the underlying failure.
    Effect.mapError(networkError),
    Effect.timeoutOption(options.limit),
    Effect.flatMap(
      Option.match({
        onSome: Effect.succeed,
        onNone: () => Effect.fail(timedOut(options.provider, options.what, options.limit)),
      }),
    ),
  );

/** A token is treated as expired this long before it expires, to avoid using one mid-rotation. */
const REFRESH_MARGIN_MS = 60_000;

/**
 * A provider's access-token cache: what a login stores, what {@link shareLogin}
 * reads as `cached`, and what a 401 forgets.
 *
 * Internal, and exempt from semver: see the module documentation.
 */
export interface TokenCache {
  /** The stored token while it is fresh: a minute short of its expiry. */
  readonly cached: Effect.Effect<Option.Option<string>>;
  /** Store `token`, which expires at `expiresAt` (epoch milliseconds). */
  readonly store: (token: string, expiresAt: number) => Effect.Effect<void>;
  /**
   * Forget `token` after the provider refused it (a 401), so the next call
   * logs in again instead of replaying it until it expires, but only while it
   * is still the stored token: a late 401 for a token another caller has
   * already replaced must not clear the new one.
   */
  readonly forget: (token: string) => Effect.Effect<void>;
}

/**
 * An empty {@link TokenCache}. Freshness is read from the `Clock`.
 *
 * Internal, and exempt from semver: see the module documentation.
 */
export const tokenCache: Effect.Effect<TokenCache> = /* @__PURE__ */ Effect.map(
  /* @__PURE__ */ Ref.make(
    /* @__PURE__ */ Option.none<{ readonly token: string; readonly expiresAt: number }>(),
  ),
  (ref): TokenCache => ({
    cached: Effect.gen(function* () {
      const current = yield* Ref.get(ref);
      const now = yield* Clock.currentTimeMillis;
      return Option.filter(current, (stored) => stored.expiresAt - REFRESH_MARGIN_MS > now).pipe(
        Option.map((stored) => stored.token),
      );
    }),
    store: (token, expiresAt) => Ref.set(ref, Option.some({ token, expiresAt })),
    forget: (used) =>
      Ref.update(
        ref,
        Option.filter((stored) => stored.token !== used),
      ),
  }),
);

// ---------------------------------------------------------------------------
// Request helpers of a provider over a generated operation client
// ---------------------------------------------------------------------------

/**
 * `T` with every key whose type admits `undefined` made optional and
 * `undefined`-free: the shape a generated operation input takes when it
 * declares optional members `key?: T`, never `key?: T | undefined`, under
 * `exactOptionalPropertyTypes`.
 *
 * Internal, and exempt from semver: see the module documentation.
 */
export type OmitUndefined<T> = {
  [K in keyof T as undefined extends T[K] ? never : K]: T[K];
} & {
  [K in keyof T as undefined extends T[K] ? K : never]?: Exclude<T[K], undefined>;
};

/**
 * Drop the keys whose value is `undefined`, so an input assembled from
 * optional neutral parameters type-checks against an input type that
 * declares bare `key?: T` members. A client whose encoder already skips
 * `undefined` members sends the same request either way.
 *
 * Internal, and exempt from semver: see the module documentation.
 */
export const omitUndefined = <T extends object>(record: T): OmitUndefined<T> =>
  // SAFETY: the filter removes exactly the `undefined`-valued keys, which is
  // what `OmitUndefined<T>` describes.
  R.fromEntries(
    Arr.map(
      Arr.filter(Struct.keys(record), (key) => record[key] !== undefined),
      (key): readonly [string, unknown] => [key, record[key]],
    ),
  ) as OmitUndefined<T>;

/**
 * Refuse a path id that is not a non-empty string before anything is sent,
 * with {@link PaymentInvalidRequestError} naming the `resource` (`param:
 * "id"`): a client would splice `""` into the path (where the collection's
 * own path often lists it), and an `undefined` from untyped code would leave
 * the label in it.
 *
 * Internal, and exempt from semver: see the module documentation.
 */
export const checkId = (
  resource: string,
  id: string,
): Effect.Effect<void, PaymentInvalidRequestError> =>
  Predicate.isString(id) && id !== ""
    ? Effect.void
    : Effect.fail(
        new PaymentInvalidRequestError({
          message: `The ${resource} id must be a non-empty string`,
          param: "id",
        }),
      );

/**
 * A string field of an unknown value, if it has one.
 *
 * Internal, and exempt from semver: see the module documentation.
 */
export const stringField = (value: unknown, field: string): string | undefined =>
  Predicate.hasProperty(value, field) && Predicate.isString(value[field])
    ? value[field]
    : undefined;

/**
 * What a client saw of a response before anything else read it.
 *
 * Internal, and exempt from semver: see the module documentation.
 */
export interface ObservedResponse {
  readonly status: number;
  readonly headers: Readonly<Record<string, string | undefined>>;
  /** The JSON body, or `None` for an empty body or one that is not JSON. */
  readonly body: Option.Option<unknown>;
}

// A pure IIFE rather than annotated calls: `Schema.Unknown`, a property read
// on an import, would keep the whole expression in a bundle that never
// imports `observeResponses`.
const decodeJson = /* @__PURE__ */ (() =>
  Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Unknown)))();

/**
 * `http`, watched: the returned `client` records the status, headers and
 * JSON body of every response it receives (the last one wins) before handing
 * it on, and `last` reads that record. A generated client that keeps neither
 * the status nor the whole vendor body on its errors runs over `client`, and
 * the provider classifies the failure from `last` instead.
 *
 * The body is read first; the response caches it, so the generated client
 * reads it again unchanged. Build one per call: the record is shared by every
 * request sent through `client`.
 *
 * Internal, and exempt from semver: see the module documentation.
 */
export const observeResponses = (
  http: HttpClient.HttpClient,
): Effect.Effect<{
  readonly client: HttpClient.HttpClient;
  readonly last: Effect.Effect<Option.Option<ObservedResponse>>;
}> =>
  Effect.map(Ref.make(Option.none<ObservedResponse>()), (observed) => ({
    client: HttpClient.transform(http, (response) =>
      Effect.tap(response, (seen) =>
        Effect.flatMap(seen.text, (text) =>
          Ref.set(
            observed,
            Option.some({ status: seen.status, headers: seen.headers, body: decodeJson(text) }),
          ),
        ),
      ),
    ),
    last: Ref.get(observed),
  }));

/**
 * A client failure with no response behind it (neither a connection failure
 * nor a vendor's error response), as a {@link PaymentProviderError} named by
 * its `_tag` and carrying its `message`, or `fallback`'s when it has none.
 * The failure is kept as the `cause`.
 *
 * Internal, and exempt from semver: see the module documentation.
 */
export const rejectedError = (
  error: unknown,
  provider: string,
  fallback: { readonly message: string; readonly code: string },
): PaymentProviderError =>
  new PaymentProviderError({
    message: stringField(error, "message") ?? fallback.message,
    provider,
    code: stringField(error, "_tag") ?? fallback.code,
    cause: error,
  });

// ---------------------------------------------------------------------------
// Response handling of a REST provider
// ---------------------------------------------------------------------------

/**
 * Build a provider's response decoders. The returned `decoder(what, schema,
 * map)` decodes a response body with `schema` (the wire shape, narrowed to the
 * fields `map` reads) and maps it onto a neutral value; a body that does not
 * decode fails with {@link PaymentProviderError} tagged `provider`, whose
 * message reads "`name` returned a malformed `what` response" and whose cause
 * is the decode failure.
 *
 * Internal, and exempt from semver: see the module documentation.
 */
export const responseDecoder =
  (options: {
    /** The provider tag of the error, e.g. `"acme"`. */
    readonly provider: string;
    /** The provider's display name, for the message, e.g. `"Acme"`. */
    readonly name: string;
  }) =>
  <S extends Schema.Codec<unknown, unknown>, A>(
    what: string,
    schema: S,
    map: (value: S["Type"]) => A,
  ) =>
  (body: unknown): Effect.Effect<A, PaymentProviderError> =>
    Schema.decodeUnknownEffect(schema)(body).pipe(
      Effect.mapError(
        (cause) =>
          new PaymentProviderError({
            message: `${options.name} returned a malformed ${what} response`,
            provider: options.provider,
            cause,
          }),
      ),
      Effect.map(map),
    );

/**
 * An ISO-8601 timestamp as Unix seconds (rounded down), or `0` when it is
 * absent, empty or does not parse: a neutral entity's timestamps are always a
 * number. A timestamp without a zone is read as UTC.
 *
 * Internal, and exempt from semver: see the module documentation.
 */
export const epochSecondsOf = (value: string | null | undefined): number =>
  Option.fromNullishOr(value).pipe(
    Option.filter((text) => text !== ""),
    Option.flatMap(DateTime.make),
    Option.match({
      onNone: () => 0,
      onSome: (dateTime) => Math.floor(DateTime.toEpochMillis(dateTime) / 1000),
    }),
  );

/** A `Retry-After` header given in whole seconds, or `undefined`. */
const retryAfterSeconds = (header: string | undefined): number | undefined =>
  header !== undefined && /^\d+$/.test(header.trim())
    ? Number.parseInt(header.trim(), 10)
    : undefined;

/**
 * Classify a provider's HTTP error `status` onto the neutral error channel.
 * The status alone decides the class:
 *
 * - 401 / 403: {@link PaymentAuthenticationError};
 * - 429: {@link PaymentRateLimitError}, carrying `retryAfter`;
 * - 400 / 404 / 422: {@link PaymentInvalidRequestError}, carrying `param`;
 * - anything else: {@link PaymentProviderError} tagged `provider`, carrying
 *   `code`.
 *
 * Every class but the rate limit carries the status. Reading `message`,
 * `code` and `param` out of the vendor's error body, and the fallback message
 * when it has none, stay with the provider.
 *
 * Internal, and exempt from semver: see the module documentation.
 */
export const errorFromStatus = (
  status: number,
  details: {
    /** The provider tag of a {@link PaymentProviderError}, e.g. `"acme"`. */
    readonly provider: string;
    readonly message: string;
    /** The vendor's error code, for a {@link PaymentProviderError}. */
    readonly code?: string | undefined;
    /** The offending parameter, for a {@link PaymentInvalidRequestError}. */
    readonly param?: string | undefined;
    /**
     * The response's `Retry-After` header, for a {@link PaymentRateLimitError}:
     * read as whole seconds, and left out when it is absent or not a number
     * of seconds (an HTTP date, say).
     */
    readonly retryAfter?: string | undefined;
  },
): PaymentsError => {
  const { message } = details;
  if (status === 401 || status === 403) {
    return new PaymentAuthenticationError({ message, statusCode: status });
  }
  if (status === 429) {
    return new PaymentRateLimitError({
      message,
      retryAfter: retryAfterSeconds(details.retryAfter),
    });
  }
  if (status === 400 || status === 404 || status === 422) {
    return new PaymentInvalidRequestError({ message, param: details.param, statusCode: status });
  }
  return new PaymentProviderError({
    message,
    provider: details.provider,
    code: details.code,
    statusCode: status,
  });
};

// ---------------------------------------------------------------------------
// Paging of a page-numbered list
// ---------------------------------------------------------------------------

/** A page cursor: the vendor page number, and the explicit `limit` it was made for. */
const PAGE_CURSOR = /^page=(\d+)(?:&size=(\d+))?$/;

/**
 * The vendor page number `startingAfter` (a `nextCursor` from
 * {@link pageNumberedList}) names, or `firstPage` without one.
 */
const readPageCursor = (
  startingAfter: string | undefined,
  options: {
    readonly provider: string;
    readonly firstPage: number;
    readonly limit: number | undefined;
  },
): Effect.Effect<number, PaymentInvalidRequestError> => {
  if (startingAfter === undefined) return Effect.succeed(options.firstPage);
  const refuse = (message: string) =>
    Effect.fail(new PaymentInvalidRequestError({ message, param: "startingAfter" }));
  const match = PAGE_CURSOR.exec(startingAfter);
  const page = match === null ? Number.NaN : Number(match[1]);
  if (match === null || !Number.isSafeInteger(page) || page < options.firstPage) {
    return refuse(
      `${options.provider} startingAfter must be the nextCursor of a previous page, not an item id`,
    );
  }
  const size = match[2];
  const limit = options.limit === undefined ? undefined : String(options.limit);
  return size === limit
    ? Effect.succeed(page)
    : refuse(
        `${options.provider} startingAfter is a cursor for ${
          size === undefined ? "no limit" : `limit ${size}`
        }: list the next page with the same limit`,
      );
};

/** `page`, vendor page `pageNumber`, with the cursor of the next one when it has more. */
const withPageCursor = <A>(
  page: Page<A>,
  pageNumber: number,
  limit: number | undefined,
): Page<A> =>
  page.hasMore
    ? {
        ...page,
        nextCursor:
          limit === undefined ? `page=${pageNumber + 1}` : `page=${pageNumber + 1}&size=${limit}`,
      }
    : { data: page.data, hasMore: false };

/**
 * One page of a vendor list that pages by page number, as a neutral page
 * whose `nextCursor` encodes the next page number and the explicit `limit`.
 *
 * `startingAfter` must be such a cursor: it names the vendor page `list`
 * requests. Without one, `list` gets `undefined` and requests the vendor's
 * first page (`firstPage`) by default. An item id, a malformed cursor, one
 * below `firstPage`, or one made for a different `limit` fails with
 * {@link PaymentInvalidRequestError} (`param: "startingAfter"`) before `list`
 * runs: a page number read with another page size would skip or repeat items.
 *
 * Internal, and exempt from semver: see the module documentation.
 */
export const pageNumberedList = <A, E>(
  params:
    | { readonly limit?: number | undefined; readonly startingAfter?: string | undefined }
    | undefined,
  options: {
    /** The provider's name, for the message: `"Acme"`. */
    readonly provider: string;
    /** The vendor's first page number: `0` or `1`. */
    readonly firstPage: number;
  },
  list: (page: number | undefined) => Effect.Effect<Page<A>, E>,
): Effect.Effect<Page<A>, E | PaymentInvalidRequestError> =>
  Effect.flatMap(
    readPageCursor(params?.startingAfter, { ...options, limit: params?.limit }),
    (page) =>
      Effect.map(list(params?.startingAfter === undefined ? undefined : page), (result) =>
        withPageCursor(result, page, params?.limit),
      ),
  );
