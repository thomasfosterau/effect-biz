/**
 * The Stripe client every resource module and capability layer runs on:
 * Distilled's generated operations (`@distilled.cloud/stripe`), run under the
 * request policy this package has always applied to Stripe.
 *
 * Distilled builds and sends each request (the bearer key from its
 * `Credentials`, Stripe's bracketed form encoding, the `Idempotency-Key` /
 * `Stripe-Account` / `Stripe-Version` headers from `withRequestOptions`) and
 * reads the response, over `effect/http`'s `HttpClient`: no Node API and no
 * SDK, so it runs in a Cloudflare Worker (with `nodejs_compat`, since
 * Distilled reads `process.env` on every request) — provide
 * `FetchHttpClient.layer` in production, or a stubbed `FetchHttpClient.Fetch`
 * in tests. Around every operation {@link StripeHttp.call}:
 *
 * - **pins `Stripe-Version`** to {@link DISTILLED_API_VERSION}, the version
 *   Distilled's schemas are generated from, unless configured
 *   ({@link StripeHttpConfig.apiVersion}) or overridden for one call
 *   ({@link RequestOptions.apiVersion}). Distilled sends the header only when
 *   asked, and otherwise the account's dashboard default would decide the
 *   wire shape;
 * - **sends a `DELETE`'s params in the query string**, as the Stripe SDKs
 *   do (`Subscription.cancel(id, { invoice_now: true })`), where Distilled
 *   would form-encode them into a body;
 * - **indexes a `/v2` request's array query params**
 *   (`include[0]=a&include[1]=b`), as the SDKs send them, where Distilled
 *   repeats `include[]`;
 * - **pins lenient response validation**, so a response is never refused
 *   over a field nobody reads: Distilled's schemas mark fields required that
 *   a response at an older configured `apiVersion` lacks. The capability
 *   layers decode the fields they map instead; the resource modules return
 *   the response as Stripe sent it;
 * - **owns retries**: Distilled's are switched off, and an attempt that failed
 *   to connect, or answered `409` / `5xx` (as `Stripe-Should-Retry` allows),
 *   is retried with the SDK's backoff, reusing one `Idempotency-Key` across
 *   the attempts of a `POST`, and of a `/v2` `DELETE` (as the SDK keys them);
 * - **times out** each attempt and **refuses redirects**, which would replay
 *   the `Authorization` header to whatever host they named;
 * - **classifies failures** onto the neutral {@link PaymentsError} channel with
 *   the package's one Stripe error mapping. Distilled's error classes carry
 *   neither the HTTP status (which decides 401, 403 and 429 whatever the body
 *   says) nor the whole vendor error object, so the client watches the
 *   response through the `HttpClient` it hands Distilled and classifies that.
 *   A failure with no response behind it is a connection failure
 *   (`PaymentNetworkError`), or a Distilled error mapped to
 *   `PaymentProviderError` by its tag.
 *
 * The key stays a `Redacted` until Distilled sets the header; a connection
 * failure's `cause` is the underlying error, never the request that carries
 * the header.
 *
 * @module
 */

import * as Config from "effect/Config";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Random from "effect/Random";
import * as Redacted from "effect/Redacted";
import { FetchHttpClient, HttpClient, HttpClientError } from "effect/http";
import { ResponseValidation } from "@distilled.cloud/core/response-validation";
import { Credentials, type Config as StripeCredentials } from "@distilled.cloud/stripe/Credentials";
import { type StripeRequestOptions, withRequestOptions } from "@distilled.cloud/stripe/Protocol";
import { Retry } from "@distilled.cloud/stripe/Retry";
import {
  PaymentConfigError,
  type PaymentsError,
  PaymentsUnavailable,
} from "@thomasfosterau/effect-biz/Payments";
import {
  isOk,
  type ObservedResponse,
  observeResponses,
  rejectedError,
  stringField,
} from "@thomasfosterau/effect-biz/Payments.internal";
import { DISTILLED_API_VERSION } from "./internal/apiVersion.js";
import { classifyResponse, PROVIDER, retryAfterOf, toPaymentsError } from "./internal/error.js";
import { deleteParamsToQuery } from "./internal/deleteQuery.js";
import { checkOptions } from "./internal/options.js";
import { v2RequestPolicy } from "./internal/v2Request.js";

export { DISTILLED_API_VERSION };

const DEFAULT_BASE_URL = "https://api.stripe.com";
const DEFAULT_UPLOADS_BASE_URL = "https://files.stripe.com";
/** The SDK's defaults: two retries, an 80 s timeout per attempt. */
const DEFAULT_MAX_NETWORK_RETRIES = 2;
const DEFAULT_TIMEOUT_MS = 80_000;
/** The SDK's backoff bounds, in seconds. */
const INITIAL_RETRY_DELAY_S = 0.5;
const MAX_RETRY_DELAY_S = 5;
const MAX_RETRY_AFTER_S = 60;

/** Configuration for the client. */
export interface StripeHttpConfig {
  /** The secret (or restricted) API key, `sk_…` / `rk_…`. */
  readonly apiKey: Redacted.Redacted<string>;
  /** The `Stripe-Version` to pin. Defaults to {@link DISTILLED_API_VERSION}. */
  readonly apiVersion?: string | undefined;
  /** Retries after a retryable failure. Defaults to 2, as in the SDK. */
  readonly maxNetworkRetries?: number | undefined;
  /** Per-attempt timeout in milliseconds. Defaults to 80 000, as in the SDK. */
  readonly timeout?: number | undefined;
  /** A connected account to act as on every call (`Stripe-Account`). */
  readonly stripeAccount?: string | undefined;
  /** Override the API origin (e.g. a `stripe-mock` server). */
  readonly baseUrl?: string | undefined;
  /** Override the file-uploads origin (`File.create`). Defaults to `https://files.stripe.com`. */
  readonly uploadsBaseUrl?: string | undefined;
}

/**
 * Per-call options for one Stripe request, the trailing argument of every
 * resource-module operation (the `stripe` SDK's `RequestOptions`, narrowed to
 * the three a payments program needs).
 */
export interface RequestOptions {
  /**
   * An `Idempotency-Key` for a `POST`: make one logical write safe to repeat.
   * Create it once, before the first attempt, and pass the same value on
   * every retry of that write; a fresh key per attempt defeats the
   * deduplication. It is sent on whatever method you pass it to; Stripe is
   * understood to ignore it on a `GET` and `DELETE` (unverified, effect-finance#93), unlike
   * the Airwallex client, which refuses a key on a non-`POST`. An
   * empty key, like an empty `stripeAccount` or `apiVersion`, fails with
   * `PaymentInvalidRequestError` before anything is sent. Without one, a
   * `POST` or a `/v2` `DELETE` that may be retried by the client gets a
   * generated key shared by all of its attempts (which covers the client's
   * retries only, never a caller's). The client sends the value verbatim; Stripe accepts up to 255
   * characters (unverified, effect-finance#93) and rejects the same key reused with
   * different parameters.
   */
  readonly idempotencyKey?: string | undefined;
  /** A connected account to act as (`Stripe-Account`), overriding the configured one. */
  readonly stripeAccount?: string | undefined;
  /**
   * The `Stripe-Version` of this one call, overriding the configured one (and
   * {@link DISTILLED_API_VERSION}). Distilled's types describe the default
   * version: a response at another is typed, but not shaped, by them.
   */
  readonly apiVersion?: string | undefined;
}

/** What {@link StripeHttp.call} takes beside the operation: {@link RequestOptions}, and the origin. */
export interface CallOptions extends RequestOptions {
  /** Send the request to the file-uploads origin (`POST /v1/files`). */
  readonly upload?: boolean | undefined;
}

/**
 * An operation's HTTP method. A `POST` (or a `DELETE` to a `/v2` path) sent
 * without a caller's key gets a generated one when it may be retried, so its
 * attempts are one write.
 */
export type Method = "GET" | "POST" | "DELETE";

/**
 * One Distilled operation, as the generated `@distilled.cloud/stripe/stripe`
 * module exports it: an input in, an `Effect` needing Distilled's
 * `Credentials` and an `HttpClient` out.
 */
export type Operation<I, O, E> = (
  input: I,
) => Effect.Effect<O, E, Credentials | HttpClient.HttpClient>;

/**
 * The client the resource modules and capability layers run on. `call` runs
 * one Distilled operation under the request policy above and resolves to the
 * response JSON as Distilled read it, **unchecked**: Distilled validates
 * nothing in lenient mode, so a capability layer decodes the fields it maps,
 * and a resource module returns it typed as Distilled's output. Tests can
 * provide a fake {@link StripeHttp.call}.
 */
export class StripeHttp extends Context.Service<
  StripeHttp,
  {
    readonly call: <I, O, E>(
      method: Method,
      operation: Operation<I, O, E>,
      input: I,
      options?: CallOptions | undefined,
    ) => Effect.Effect<unknown, PaymentsError>;
  }
>()("@effect-biz/payments-stripe/StripeHttp") {}

/** What one attempt saw of the response, read before Distilled reads it. */
type Observed = ObservedResponse;

/** One attempt's outcome, before it is judged. */
type Outcome = Data.TaggedEnum<{
  /** Distilled succeeded on a 2xx with a JSON body. */
  Success: { readonly body: unknown };
  /** A response that decides the outcome: a non-2xx, or a 2xx that is not JSON. */
  Response: Observed;
  /** No response: a connection failure or a timeout. */
  Transport: { readonly message: string; readonly cause: unknown };
  /** A Distilled failure with no non-2xx response behind it. */
  Rejected: { readonly error: unknown };
}>;
const Outcome = /* @__PURE__ */ Data.taggedEnum<Outcome>();

/** Distilled's retries, switched off: this client retries on its own policy. */
const NO_RETRY = { while: () => false };

/**
 * The SDK's retry rule for a response: as the `Stripe-Should-Retry` header
 * says, and without one on a `409` or a `5xx`.
 */
const isRetryableResponse = ({ status, headers }: Observed): boolean => {
  if (isOk(status)) return false;
  const advice = headers["stripe-should-retry"];
  return advice === undefined ? status === 409 || status >= 500 : advice === "true";
};

/** The SDK's retry rule: always after a connection failure, else by the response. */
const isRetryable: (outcome: Outcome) => boolean = /* @__PURE__ */ Outcome.$match({
  Success: () => false,
  Response: isRetryableResponse,
  Transport: () => true,
  Rejected: () => false,
});

/** The `Retry-After` an outcome's response asked for, in seconds. */
const retryAfterOfOutcome = (outcome: Outcome): number | undefined =>
  Outcome.$is("Response")(outcome) ? retryAfterOf(outcome.headers["retry-after"]) : undefined;

/**
 * The SDK's backoff before retry `retries + 1`: exponential from 0.5 s,
 * capped at 5 s, jittered into its upper half, never below 0.5 s, and never
 * shorter than a reasonable (≤ 60 s) `Retry-After`.
 */
const backoff = (retries: number, retryAfter: number | undefined): Effect.Effect<void> =>
  Effect.flatMap(Random.next, (jitter) => {
    const exponential = Math.min(INITIAL_RETRY_DELAY_S * 2 ** (retries - 1), MAX_RETRY_DELAY_S);
    const jittered = Math.max(INITIAL_RETRY_DELAY_S, exponential * 0.5 * (1 + jitter));
    const seconds =
      retryAfter !== undefined && retryAfter <= MAX_RETRY_AFTER_S
        ? Math.max(jittered, retryAfter)
        : jittered;
    return Effect.sleep(Duration.millis(seconds * 1000));
  });

/**
 * A Distilled failure as an outcome. An `HttpClientError` means no response
 * arrived; its `cause` is kept, never the request, whose headers carry the key.
 */
const failureOf = (error: unknown): Outcome => {
  if (!HttpClientError.isHttpClientError(error)) return Outcome.Rejected({ error });
  const reason = error.reason;
  const cause = "cause" in reason ? reason.cause : undefined;
  return Outcome.Transport({
    message: stringField(reason, "description") ?? stringField(cause, "message") ?? reason._tag,
    cause,
  });
};

/**
 * The outcome of one attempt. A response, once seen, decides it whatever
 * Distilled made of it: a non-2xx is classified from its status, headers and
 * body, and a 2xx whose body is not JSON fails as one.
 */
const judge = (outcome: Outcome, observed: Option.Option<Observed>): Outcome =>
  Option.match(observed, {
    onNone: () => outcome,
    onSome: (response) => {
      const decides = Outcome.$is("Success")(outcome)
        ? !isOk(response.status) || Option.isNone(response.body)
        : !isOk(response.status);
      return decides ? Outcome.Response(response) : outcome;
    },
  });

/** A response that decides an outcome, as a neutral error. */
const responseError = ({ status, headers, body }: Observed): PaymentsError =>
  isOk(status)
    ? toPaymentsError({
        kind: "StripeAPIError",
        message: "Invalid JSON received from the Stripe API",
        statusCode: status,
      })
    : toPaymentsError(
        classifyResponse(status, headers["retry-after"], Option.getOrUndefined(body)),
      );

/**
 * The message and code of a Distilled failure with no response behind it
 * that carries neither, mapped by `rejectedError` to a neutral error named by
 * its tag.
 */
const REJECTED = { message: "The Stripe request failed", code: "StripeUnknownError" };

/** Judge a final outcome, after `retries` retries: the JSON of a 2xx, or a neutral error. */
const settle = (outcome: Outcome, retries: number): Effect.Effect<unknown, PaymentsError> =>
  Outcome.$match(outcome, {
    Success: ({ body }) => Effect.succeed(body),
    Response: (response) => Effect.fail(responseError(response)),
    Transport: ({ message, cause }) =>
      Effect.fail(
        toPaymentsError({
          kind: "StripeConnectionError",
          message: `An error occurred with our connection to Stripe (${message}).${
            retries > 0 ? ` Request was retried ${retries} times.` : ""
          }`,
          raw: cause,
        }),
      ),
    Rejected: ({ error }) => Effect.fail(rejectedError(error, PROVIDER, REJECTED)),
  });

/** The client's credentials and request policy. */
interface MakeOptions extends Omit<StripeHttpConfig, "apiKey" | "baseUrl"> {
  /** The key and API origin, resolved on every call; may fail (`PaymentsUnavailable`). */
  readonly credentials: Effect.Effect<StripeCredentials, PaymentsError>;
}

/** Build the client over the `HttpClient` in context. */
const makeWith = (
  options: MakeOptions,
): Effect.Effect<StripeHttp["Service"], never, HttpClient.HttpClient> =>
  Effect.map(HttpClient.HttpClient, (http) => {
    const apiVersion = options.apiVersion || DISTILLED_API_VERSION;
    const uploadsBaseUrl = options.uploadsBaseUrl ?? DEFAULT_UPLOADS_BASE_URL;
    const maxRetries = Math.max(0, options.maxNetworkRetries ?? DEFAULT_MAX_NETWORK_RETRIES);
    const timeout = Duration.millis(options.timeout ?? DEFAULT_TIMEOUT_MS);
    const timedOut = Outcome.Transport({
      message: `request timed out after ${Duration.toMillis(timeout)} ms`,
      cause: undefined,
    });

    /**
     * One attempt of `operation`, reduced to an {@link Outcome}; fails only by
     * defect. `generatedKey` is the call's key for a `/v2` `DELETE`.
     */
    const attempt = <I, O, E>(
      operation: Operation<I, O, E>,
      input: I,
      requestOptions: StripeRequestOptions,
      credentials: StripeCredentials,
      generatedKey: string | undefined,
    ): Effect.Effect<Outcome> =>
      Effect.gen(function* () {
        const v2 = v2RequestPolicy(credentials.apiBaseUrl, generatedKey);
        // Keep what the classification needs of the response, read before
        // Distilled reads it.
        const watched = yield* observeResponses(
          HttpClient.mapRequest(http, (request) => v2(deleteParamsToQuery(request))),
        );
        const init = yield* Effect.serviceOption(FetchHttpClient.RequestInit);
        const outcome = yield* operation(input).pipe(
          // Every typed failure becomes an outcome to judge; defects stay defects.
          Effect.match({
            onSuccess: (body) => Outcome.Success({ body }),
            onFailure: failureOf,
          }),
          withRequestOptions(requestOptions),
          Effect.provideService(Credentials, Effect.succeed(credentials)),
          Effect.provideService(HttpClient.HttpClient, watched.client),
          Effect.provideService(Retry, NO_RETRY),
          Effect.provideService(ResponseValidation, "lenient"),
          Effect.provideService(FetchHttpClient.RequestInit, {
            ...Option.getOrElse(init, () => ({})),
            redirect: "error",
          }),
          Effect.timeoutOption(timeout),
          Effect.map(Option.getOrElse(() => timedOut)),
        );
        return judge(outcome, yield* watched.last);
      });

    const run = (
      once: Effect.Effect<Outcome>,
      retries: number,
    ): Effect.Effect<unknown, PaymentsError> =>
      Effect.flatMap(once, (outcome) =>
        retries < maxRetries && isRetryable(outcome)
          ? Effect.andThen(backoff(retries, retryAfterOfOutcome(outcome)), run(once, retries + 1))
          : settle(outcome, retries),
      );

    const call = Effect.fn("StripeHttp.call")(function* <I, O, E>(
      method: Method,
      operation: Operation<I, O, E>,
      input: I,
      callOptions: CallOptions = {},
    ) {
      const stripeAccount = callOptions.stripeAccount ?? options.stripeAccount;
      yield* checkOptions({
        idempotencyKey: callOptions.idempotencyKey,
        stripeAccount,
        apiVersion: callOptions.apiVersion,
      });
      const resolved = yield* options.credentials;
      const credentials = callOptions.upload
        ? { ...resolved, apiBaseUrl: uploadsBaseUrl }
        : resolved;
      // One key for every attempt of a retryable write: a `POST`'s goes out
      // as a request option; a `DELETE`'s only on a `/v2` path, which the
      // request's URL tells (`v2RequestPolicy`), as in the SDK.
      const generated =
        method !== "GET" && maxRetries > 0
          ? `effect-payments-retry-${yield* Effect.sync(() => globalThis.crypto.randomUUID())}`
          : undefined;
      const requestOptions: StripeRequestOptions = {
        apiVersion: callOptions.apiVersion ?? apiVersion,
        idempotencyKey: callOptions.idempotencyKey ?? (method === "POST" ? generated : undefined),
        stripeAccount,
      };
      return yield* run(attempt(operation, input, requestOptions, credentials, generated), 0);
    });

    return StripeHttp.of({ call });
  });

/**
 * The client over Distilled's `Credentials` in context, at the default
 * request policy ({@link DISTILLED_API_VERSION}, two retries, 80 s per
 * attempt). The capability layers (`StripePayments.customersLayer`, …) are
 * built over this.
 */
export const layerFromContext: Layer.Layer<StripeHttp, never, Credentials | HttpClient.HttpClient> =
  /* @__PURE__ */ Layer.effect(
    StripeHttp,
    /* @__PURE__ */ Effect.flatMap(Credentials, (credentials) => makeWith({ credentials })),
  );

/** The credentials a configuration names. */
const credentialsOf = (
  apiKey: Redacted.Redacted<string>,
  baseUrl: string | undefined,
): StripeCredentials => ({ apiKey, apiBaseUrl: baseUrl ?? DEFAULT_BASE_URL });

/**
 * Build the client from configuration. Fails with {@link PaymentConfigError}
 * when the key is empty.
 */
export const make = (
  config: StripeHttpConfig,
): Effect.Effect<StripeHttp["Service"], PaymentConfigError, HttpClient.HttpClient> =>
  Redacted.value(config.apiKey) === ""
    ? Effect.fail(new PaymentConfigError({ message: "Stripe API key is required" }))
    : makeWith({
        ...config,
        credentials: Effect.succeed(credentialsOf(config.apiKey, config.baseUrl)),
      });

/**
 * The client from configuration, as a layer. Requires an `HttpClient`:
 * provide `FetchHttpClient.layer` (Workers, browsers, Node ≥ 18).
 */
export const layer = (
  config: StripeHttpConfig,
): Layer.Layer<StripeHttp, PaymentConfigError, HttpClient.HttpClient> =>
  Layer.effect(StripeHttp, make(config));

/**
 * The client with its key read from a configuration variable (through the
 * current `ConfigProvider`, which defaults to the process environment) while
 * the layer is built, at the default request policy. Fails with
 * {@link PaymentConfigError} when it is absent or empty.
 */
export const layerFromEnv = (
  envVar: string = "STRIPE_API_KEY",
): Layer.Layer<StripeHttp, PaymentConfigError, HttpClient.HttpClient> =>
  Layer.effect(
    StripeHttp,
    Effect.fn("StripeHttp.layerFromEnv")(function* () {
      const apiKey = yield* Config.Redacted(envVar).pipe(Config.withDefault(Redacted.make("")));
      if (Redacted.value(apiKey) === "") {
        return yield* new PaymentConfigError({
          message: `Environment variable ${envVar} is not set`,
        });
      }
      return yield* make({ apiKey });
    })().pipe(
      Effect.catchTag("ConfigError", (error) =>
        Effect.fail(new PaymentConfigError({ message: error.message })),
      ),
    ),
  );

/** Options for {@link layerConfig}. */
export interface LayerConfigOptions extends Omit<StripeHttpConfig, "apiKey"> {
  /**
   * The configuration variable the key is read from, at call time. Defaults
   * to `STRIPE_API_KEY`, as in {@link layerFromEnv}.
   */
  readonly envVar?: string | undefined;
}

/**
 * Read the key from one `ConfigProvider`: `None` when it is absent, empty or
 * unreadable. An unreadable value is logged at debug level (the variable's
 * name only, never its value) and then treated as absent.
 */
const readKey = (
  envVar: string,
  provider: ConfigProvider.ConfigProvider,
): Effect.Effect<Option.Option<Redacted.Redacted<string>>> =>
  Config.Redacted(envVar)
    .pipe(Config.option)
    .parse(provider)
    .pipe(
      Effect.map(Option.filter((key) => Redacted.value(key) !== "")),
      Effect.catchTag("ConfigError", () =>
        Effect.as(
          Effect.logDebug(`Stripe key ${envVar} could not be read; treating it as not set`),
          Option.none(),
        ),
      ),
    );

/**
 * The client in the "not configured ≡ down" posture: the key is read from a
 * configuration variable on EVERY call, never while the layer is built.
 * Building it therefore cannot fail — an application without Stripe
 * configured still starts — and a call made while the variable is absent,
 * empty or unreadable fails with {@link PaymentsUnavailable} before anything
 * is sent, the same failure a Stripe outage looks like to the program.
 *
 * **Which `ConfigProvider`.** Each call reads the calling fiber's
 * `ConfigProvider` first (so a per-request provider, or one the runtime
 * carries, wins); when the key is not there, it falls back to the
 * `ConfigProvider` the layer was built under. A provider attached to the
 * layer itself (`layerConfig().pipe(Layer.provide(ConfigProvider.layer(…)))`)
 * is therefore honoured, as it is for {@link layerFromEnv}.
 */
export const layerConfig = ({
  envVar = "STRIPE_API_KEY",
  ...options
}: LayerConfigOptions = {}): Layer.Layer<StripeHttp, never, HttpClient.HttpClient> =>
  Layer.effect(
    StripeHttp,
    Effect.gen(function* () {
      const builtUnder = yield* ConfigProvider.ConfigProvider;
      const unavailable = Effect.failSync(
        () =>
          new PaymentsUnavailable({
            message: `Stripe is not configured in this environment (${envVar} is not set or is empty)`,
            provider: PROVIDER,
          }),
      );
      const credentials = Effect.flatMap(ConfigProvider.ConfigProvider, (caller) =>
        Effect.flatMap(readKey(envVar, caller), (key) =>
          Option.isSome(key) || caller === builtUnder
            ? Effect.succeed(key)
            : readKey(envVar, builtUnder),
        ),
      ).pipe(
        Effect.flatMap(
          Option.match({
            onNone: () => unavailable,
            onSome: (apiKey) => Effect.succeed(credentialsOf(apiKey, options.baseUrl)),
          }),
        ),
      );
      return yield* makeWith({ ...options, credentials });
    }),
  );
