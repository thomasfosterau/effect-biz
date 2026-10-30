/**
 * The Airwallex client service.
 *
 * Airwallex authenticates with a short-lived bearer token obtained by exchanging
 * a client id + API key. This service hides that handshake: it lazily logs in,
 * caches the token until shortly before it expires, and exposes a single
 * {@link AirwallexClient.request} method that the capability layers build upon.
 *
 * Every call goes through `effect/http`'s `HttpClient`, which the
 * layers require: provide `FetchHttpClient.layer` in production, or a stub
 * `HttpClient` (or a stub `FetchHttpClient.Fetch`) in tests.
 *
 * @module
 */

import * as Arr from "effect/Array";
import * as Clock from "effect/Clock";
import * as Config from "effect/Config";
import * as Context from "effect/Context";
import type * as Duration from "effect/Duration";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as R from "effect/Record";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import { HttpClient, HttpClientRequest } from "effect/http";
import {
  PaymentConfigError,
  PaymentInvalidRequestError,
  PaymentProviderError,
  type PaymentsError,
} from "@thomasfosterau/effect-biz/Payments";
import {
  isAbsoluteHttpUrl,
  isOk,
  send as sendWithin,
  shareLogin,
  timeoutOf,
  tokenCache,
} from "@thomasfosterau/effect-biz/Payments.internal";
import { AirwallexErrorBody, handleAirwallexError, PROVIDER } from "./internal/error.js";

/**
 * Which Airwallex environment a client talks to: `live` (real money) or
 * `sandbox` (Airwallex's test environment).
 */
export type AirwallexEnvironment = "live" | "sandbox";

/** The API base URL of each {@link AirwallexEnvironment}; request paths carry `/api/v1`. */
const BASE_URLS: Readonly<Record<AirwallexEnvironment, string>> = {
  live: "https://api.airwallex.com",
  sandbox: "https://api.sandbox.airwallex.com",
};
/** A login that has not answered after 30 s is abandoned. */
const DEFAULT_LOGIN_TIMEOUT_MS = 30_000;
/** A resource request is abandoned after 80 s, the Stripe client's default. */
const DEFAULT_TIMEOUT_MS = 80_000;
/** The provider's name in configuration and timeout messages. */
const NAME = "Airwallex";

/** Configuration for the Airwallex client. */
export interface AirwallexConfig {
  readonly clientId: string;
  /** The API key, kept `Redacted` so it never reaches a log line or an error. */
  readonly apiKey: Redacted.Redacted;
  /**
   * The environment to talk to, which selects the API base URL: `live`
   * (`https://api.airwallex.com`) or `sandbox`
   * (`https://api.sandbox.airwallex.com`). Defaults to `live`; `baseUrl`, when
   * set, wins over it. `layerFromEnv` always passes it (`AIRWALLEX_ENV` is
   * required there).
   */
  readonly environment?: AirwallexEnvironment | undefined;
  /**
   * Override the API base URL (by default the {@link AirwallexConfig.environment}'s
   * endpoint). Must be an absolute http(s) URL: an empty or relative value
   * fails `make` with {@link PaymentConfigError} rather than falling back to
   * an environment's endpoint.
   */
  readonly baseUrl?: string | undefined;
  /**
   * How long the token login may take, in milliseconds, before it fails with
   * `PaymentNetworkError`. Defaults to 30 000; `Infinity` disables it, and
   * `0`, a negative number or `NaN` fails with `PaymentConfigError`. Only one
   * login is in flight at a time, so a login that never answers would otherwise stall every
   * request on the client. Callers that arrive while a login is in flight
   * share its outcome, so each waits at most about one `loginTimeout`; the next
   * call after a failure logs in afresh (effect-finance#65).
   */
  readonly loginTimeout?: number | undefined;
  /**
   * How long a resource request may take (response headers and body), in
   * milliseconds, before it fails with `PaymentNetworkError`. Defaults to
   * 80 000, the Stripe client's per-attempt timeout; `Infinity` disables it.
   * It does not include acquiring a token (see `loginTimeout`). A non-GET that
   * times out has an unknown outcome — the vendor may have applied it — so do
   * not blindly retry a write (effect-finance#66).
   */
  readonly timeout?: number | undefined;
}

/** A request issued through the Airwallex client. */
export interface AirwallexRequest {
  readonly method: "GET" | "POST" | "DELETE";
  /** Path beginning with a slash, e.g. `/api/v1/pa/customers`. */
  readonly path: string;
  readonly query?: Record<string, string | number | undefined> | undefined;
  readonly body?: unknown;
  /**
   * The `request_id` of a `POST`, written into the JSON body in place of any
   * `request_id` already there (the capability layers put a fresh one on every
   * call). Makes one logical write safe to repeat: create it once, before the
   * first attempt, and send the same value on every retry of that write;
   * Airwallex then returns the original result for the same parameters (and,
   * unverified, rejects the same id with different ones); it limits the id to
   * about 64 characters. Both claims are unverified (effect-finance#93). An empty string, a non-`POST`
   * request, or a body that is present but not a JSON object fails with
   * `PaymentInvalidRequestError` before anything is sent, rather than
   * silently dropping the id.
   */
  readonly requestId?: string | undefined;
}

/**
 * The Airwallex client. Capability layers depend on this service; tests can
 * provide a fake implementation of {@link AirwallexClient.request}.
 */
export class AirwallexClient extends Context.Service<
  AirwallexClient,
  {
    /**
     * Send `request` and succeed with the response's JSON body (`{}` when it
     * is empty), unchecked: each capability layer decodes the body with the
     * `Schema` for the shape it reads (`internal/mapping.ts`).
     */
    readonly request: (request: AirwallexRequest) => Effect.Effect<unknown, PaymentsError>;
  }
>()("@effect-biz/payments-airwallex/AirwallexClient") {}

const buildUrl = (baseUrl: string, path: string, query: AirwallexRequest["query"]): string => {
  const url = new URL(path, baseUrl);
  Arr.forEach(R.toEntries(query ?? {}), ([key, value]) => {
    if (value !== undefined) url.searchParams.set(key, String(value));
  });
  return url.toString();
};

/** The login response, decoded rather than trusted. */
const LoginResponse = Schema.Struct({
  token: Schema.String,
  expires_at: Schema.optional(Schema.String),
});

/** A vendor error body, decoded leniently: an unexpected shape maps as absent. */
const errorBodyOf = (json: unknown): AirwallexErrorBody | undefined =>
  Option.getOrUndefined(Schema.decodeUnknownOption(AirwallexErrorBody)(json));

/** Tokens without a parseable `expires_at` are assumed to last 25 minutes. */
const DEFAULT_TOKEN_LIFETIME_MS = 25 * 60 * 1000;

/**
 * The request body with the caller's `requestId` written into it as
 * `request_id`, or the invalid-request error when the id cannot be honoured
 * (empty, not a `POST`, or a body that is not an object). Without a
 * `requestId` the body is returned as it is.
 */
const withRequestId = (
  req: AirwallexRequest,
): Effect.Effect<unknown, PaymentInvalidRequestError> => {
  if (req.requestId === undefined) return Effect.succeed(req.body);
  if (req.requestId === "") {
    return Effect.fail(
      new PaymentInvalidRequestError({ message: "Airwallex requestId must not be empty" }),
    );
  }
  if (req.method !== "POST") {
    return Effect.fail(
      new PaymentInvalidRequestError({
        message: `Airwallex requestId applies to POST requests only (got ${req.method})`,
      }),
    );
  }
  if (req.body != null && !Predicate.isObject(req.body)) {
    return Effect.fail(
      new PaymentInvalidRequestError({
        message: "Airwallex requestId needs a JSON object body to carry request_id",
      }),
    );
  }
  return Effect.succeed({ ...req.body, request_id: req.requestId });
};

/**
 * Build an Airwallex client from configuration.
 */
export const make = (
  config: AirwallexConfig,
): Effect.Effect<AirwallexClient["Service"], PaymentConfigError, HttpClient.HttpClient> =>
  Effect.gen(function* () {
    if (!config.clientId || !Redacted.value(config.apiKey)) {
      return yield* new PaymentConfigError({
        message: "Airwallex clientId and apiKey are required",
      });
    }

    if (config.baseUrl !== undefined && !isAbsoluteHttpUrl(config.baseUrl)) {
      return yield* new PaymentConfigError({
        message:
          "Airwallex baseUrl must be an absolute http(s) URL (omit it for the environment's endpoint)",
      });
    }

    const http = yield* HttpClient.HttpClient;
    const baseUrl = config.baseUrl ?? BASE_URLS[config.environment ?? "live"];
    const cache = yield* tokenCache;

    const loginTimeout = yield* timeoutOf(
      NAME,
      "loginTimeout",
      config.loginTimeout ?? DEFAULT_LOGIN_TIMEOUT_MS,
    );
    const timeout = yield* timeoutOf(NAME, "timeout", config.timeout ?? DEFAULT_TIMEOUT_MS);

    /**
     * Send `request` and read its JSON body, all within `limit`. A request that
     * has not finished by then is interrupted (which aborts the fetch) and
     * fails with `PaymentNetworkError`.
     */
    const send = (
      request: HttpClientRequest.HttpClientRequest,
      limit: Duration.Duration,
      what: string,
    ) => sendWithin(http, request, { provider: NAME, what, limit });

    const login = Effect.fn("Airwallex.login")(function* () {
      const reply = yield* send(
        HttpClientRequest.post(`${baseUrl}/api/v1/authentication/login`).pipe(
          HttpClientRequest.setHeaders({
            "Content-Type": "application/json",
            "x-client-id": config.clientId,
            "x-api-key": Redacted.value(config.apiKey),
          }),
        ),
        loginTimeout,
        "login",
      );
      if (!isOk(reply.status)) {
        return yield* handleAirwallexError(
          reply.status,
          errorBodyOf(reply.json),
          reply.headers["retry-after"],
        );
      }
      const body = yield* Schema.decodeUnknownEffect(LoginResponse)(reply.json).pipe(
        Effect.mapError(
          (cause) =>
            new PaymentProviderError({
              message: "Airwallex returned a malformed login response",
              provider: PROVIDER,
              statusCode: reply.status,
              cause,
            }),
        ),
      );
      const now = yield* Clock.currentTimeMillis;
      const expiresAt = Option.fromNullishOr(body.expires_at).pipe(
        Option.flatMap(DateTime.make),
        Option.map(DateTime.toEpochMillis),
        Option.getOrElse(() => now + DEFAULT_TOKEN_LIFETIME_MS),
      );
      yield* cache.store(body.token, expiresAt);
      return body.token;
    });

    // The cache refreshes a minute before expiry, to avoid using a token
    // mid-rotation. One login at a time, and its outcome is shared: concurrent
    // first calls (or calls racing an expiry) await the in-flight login and
    // reuse its token — or all fail with its error, after which the next call
    // retries.
    const getToken = yield* shareLogin(cache.cached, login());

    const request = (req: AirwallexRequest): Effect.Effect<unknown, PaymentsError> =>
      Effect.gen(function* () {
        const body = yield* withRequestId(req);
        const token = yield* getToken;
        const base = HttpClientRequest.make(req.method)(
          buildUrl(baseUrl, req.path, req.query),
        ).pipe(HttpClientRequest.bearerToken(token), HttpClientRequest.acceptJson);
        // `Content-Type: application/json` goes on EVERY request, body or not:
        // this restores the pre-HttpClient behaviour and keeps the client
        // consistent with the PayPal one.
        const reply = yield* send(
          body != null
            ? HttpClientRequest.bodyJsonUnsafe(base, body)
            : HttpClientRequest.setHeader(base, "Content-Type", "application/json"),
          timeout,
          "request",
        );
        if (reply.status === 401) {
          // A revoked or rotated token: forget it, so the next call logs in
          // again instead of replaying the rejected token until it expires —
          // but only if it is still the stored one. A late 401 for a token
          // another caller has already replaced must not clear the new one.
          yield* cache.forget(token);
        }
        if (!isOk(reply.status)) {
          return yield* handleAirwallexError(
            reply.status,
            errorBodyOf(reply.json),
            reply.headers["retry-after"],
          );
        }
        return reply.json;
      });

    return { request };
  });

/** Create an Airwallex client layer from configuration. */
export const layer = (
  config: AirwallexConfig,
): Layer.Layer<AirwallexClient, PaymentConfigError, HttpClient.HttpClient> =>
  Layer.effect(AirwallexClient, make(config));

/**
 * Create an Airwallex client layer from configuration variables (read through
 * the current `ConfigProvider`, which defaults to the process environment).
 * `AIRWALLEX_ENV` is required and must be `live` or `sandbox`: it selects the
 * endpoint, so a missing or misspelt value fails with
 * {@link PaymentConfigError} instead of silently selecting live.
 * `AIRWALLEX_BASE_URL`, when set, overrides the endpoint `AIRWALLEX_ENV`
 * selects (`AIRWALLEX_ENV` is still required).
 * An empty variable counts as unset (Effect rc.118 reads an empty string as
 * missing): an empty id, key or `AIRWALLEX_ENV` fails with
 * {@link PaymentConfigError}, an empty `AIRWALLEX_BASE_URL` selects the
 * `AIRWALLEX_ENV` endpoint.
 */
export const layerFromEnv = (
  clientIdVar = "AIRWALLEX_CLIENT_ID",
  apiKeyVar = "AIRWALLEX_API_KEY",
): Layer.Layer<AirwallexClient, PaymentConfigError, HttpClient.HttpClient> =>
  Layer.effect(AirwallexClient, makeFromEnv(clientIdVar, apiKeyVar));

/**
 * Read the client configuration through `Config` and build the client, as
 * {@link layerFromEnv} describes; a `ConfigError` becomes {@link PaymentConfigError}.
 */
const makeFromEnv = Effect.fn("Airwallex.makeFromEnv")(
  function* (clientIdVar: string, apiKeyVar: string) {
    const clientId = yield* Config.String(clientIdVar).pipe(Config.withDefault(""));
    const apiKey = yield* Config.Redacted(apiKeyVar).pipe(Config.withDefault(Redacted.make("")));
    const environment = yield* Config.Literals(["live", "sandbox"], "AIRWALLEX_ENV");
    const baseUrl = yield* Config.option(Config.String("AIRWALLEX_BASE_URL"));
    return yield* make({
      clientId,
      apiKey,
      environment,
      baseUrl: Option.getOrUndefined(baseUrl),
    });
  },
  Effect.catchTag("ConfigError", (error) =>
    Effect.fail(new PaymentConfigError({ message: error.message })),
  ),
);
