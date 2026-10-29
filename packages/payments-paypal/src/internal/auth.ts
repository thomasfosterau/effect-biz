/**
 * The PayPal OAuth session the Distilled client the capability layers run on
 * (`internal/distilled.ts`) authenticates with.
 *
 * A session validates a {@link PayPalConfig}, resolves the API base URL from
 * its `environment` / `baseUrl`, and owns the client-credentials login: the
 * access token is cached in a `Ref`, refreshed a minute before expiry, and
 * fetched by one shared, time-boxed login at a time (`shareLogin`). The
 * client secret stays `Redacted` until the login request is built.
 *
 * @module
 */

import * as Clock from "effect/Clock";
import * as Config from "effect/Config";
import type * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import { Base64 } from "effect/encoding";
import { HttpClient, HttpClientRequest } from "effect/http";
import {
  PaymentConfigError,
  type PaymentNetworkError,
  PaymentProviderError,
  type PaymentsError,
} from "@thomasfosterau/effect-biz/Payments";
import {
  isAbsoluteHttpUrl,
  isOk,
  type Reply,
  send as sendWithin,
  shareLogin,
  timedOut as timedOutAfter,
  timeoutOf,
  tokenCache,
} from "@thomasfosterau/effect-biz/Payments.internal";
import type { PayPalConfig, PayPalEnvironment } from "../PayPalPayments.js";
import { errorBodyOf, handlePayPalError, PROVIDER } from "./error.js";

/** The REST API base URL of each {@link PayPalEnvironment}; request paths carry `/v1` or `/v2`. */
const BASE_URLS: Readonly<Record<PayPalEnvironment, string>> = {
  live: "https://api-m.paypal.com",
  sandbox: "https://api-m.sandbox.paypal.com",
};
/** A login that has not answered after 30 s is abandoned. */
const DEFAULT_LOGIN_TIMEOUT_MS = 30_000;
/** A resource request is abandoned after 80 s, the Stripe client's default. */
const DEFAULT_TIMEOUT_MS = 80_000;
/** The token lifetime assumed when PayPal's response states none, in seconds. */
const DEFAULT_TOKEN_LIFETIME_S = 1800;
/** The provider's name in configuration and timeout messages. */
const NAME = "PayPal";

/** A configured client's authentication and request policy. */
export interface Session {
  /** The API base URL: `baseUrl` when configured, else the `environment`'s endpoint. */
  readonly baseUrl: string;
  /** How long one resource request may take; it does not cover getting a token. */
  readonly timeout: Duration.Duration;
  /**
   * The current access token: the cached one while it is fresh, otherwise
   * the outcome of the one login in flight (shared by every caller waiting
   * on it), or of a new one.
   */
  readonly token: Effect.Effect<string, PaymentsError>;
  /**
   * Forget `token` after PayPal refused it (a 401), so the next call logs in
   * again instead of replaying it until it expires, but only while it is
   * still the stored token: a late 401 for a token another caller has already
   * replaced must not clear the new one.
   */
  readonly forget: (token: string) => Effect.Effect<void>;
}

/** The failure of a PayPal exchange (`what`) still unanswered after `limit`. */
export const timedOut = (what: string, limit: Duration.Duration): PaymentNetworkError =>
  timedOutAfter(NAME, what, limit);

/**
 * Send `request` and read its JSON body, all within `limit`. A request that
 * has not finished by then is interrupted (which aborts the fetch) and fails
 * with {@link PaymentNetworkError}.
 */
export const send = (
  http: HttpClient.HttpClient,
  request: HttpClientRequest.HttpClientRequest,
  limit: Duration.Duration,
  what: string,
): Effect.Effect<Reply, PaymentNetworkError> =>
  sendWithin(http, request, { provider: NAME, what, limit });

/** The OAuth token response, decoded rather than trusted. */
const TokenResponse = Schema.Struct({
  access_token: Schema.String,
  expires_in: Schema.optional(Schema.Number),
});

/**
 * Build a session from configuration. Fails with {@link PaymentConfigError}
 * when the id or secret is empty, the `baseUrl` is not an absolute http(s)
 * URL, or a timeout is not a positive number of milliseconds (or `Infinity`).
 * Nothing is sent until the first {@link Session.token}.
 */
export const sessionOf = (
  config: PayPalConfig,
): Effect.Effect<Session, PaymentConfigError, HttpClient.HttpClient> =>
  Effect.gen(function* () {
    if (!config.clientId || !Redacted.value(config.clientSecret)) {
      return yield* new PaymentConfigError({
        message: "PayPal clientId and clientSecret are required",
      });
    }

    if (config.baseUrl !== undefined && !isAbsoluteHttpUrl(config.baseUrl)) {
      return yield* new PaymentConfigError({
        message:
          "PayPal baseUrl must be an absolute http(s) URL (omit it for the environment's endpoint)",
      });
    }

    const http = yield* HttpClient.HttpClient;
    const baseUrl = config.baseUrl ?? BASE_URLS[config.environment ?? "live"];
    const basicAuth = Redacted.make(
      Base64.encode(`${config.clientId}:${Redacted.value(config.clientSecret)}`),
    );
    const cache = yield* tokenCache;

    const loginTimeout = yield* timeoutOf(
      NAME,
      "loginTimeout",
      config.loginTimeout ?? DEFAULT_LOGIN_TIMEOUT_MS,
    );
    const timeout = yield* timeoutOf(NAME, "timeout", config.timeout ?? DEFAULT_TIMEOUT_MS);

    const login = Effect.fn("PayPal.login")(function* (): Effect.fn.Return<string, PaymentsError> {
      const reply = yield* send(
        http,
        HttpClientRequest.post(`${baseUrl}/v1/oauth2/token`).pipe(
          HttpClientRequest.setHeader("Authorization", `Basic ${Redacted.value(basicAuth)}`),
          HttpClientRequest.bodyText(
            "grant_type=client_credentials",
            "application/x-www-form-urlencoded",
          ),
        ),
        loginTimeout,
        "login",
      );
      if (!isOk(reply.status)) {
        return yield* handlePayPalError(
          reply.status,
          errorBodyOf(reply.json),
          reply.headers["retry-after"],
        );
      }
      const body = yield* Schema.decodeUnknownEffect(TokenResponse)(reply.json).pipe(
        Effect.mapError(
          (cause) =>
            new PaymentProviderError({
              message: "PayPal returned a malformed OAuth token response",
              provider: PROVIDER,
              statusCode: reply.status,
              cause,
            }),
        ),
      );
      const now = yield* Clock.currentTimeMillis;
      const expiresAt = now + (body.expires_in ?? DEFAULT_TOKEN_LIFETIME_S) * 1000;
      yield* cache.store(body.access_token, expiresAt);
      return body.access_token;
    });

    // One login at a time, and its outcome is shared: concurrent first calls
    // (or calls racing an expiry) await the in-flight login and reuse its
    // token, or all fail with its error, after which the next call retries.
    const token = yield* shareLogin(cache.cached, login());

    return { baseUrl, timeout, token, forget: cache.forget };
  });

/**
 * Read a {@link PayPalConfig} from configuration variables (through the
 * current `ConfigProvider`): the id and secret from `clientIdVar` /
 * `clientSecretVar`, the required `PAYPAL_ENV` (`live` | `sandbox`) and the
 * optional `PAYPAL_BASE_URL` override. A `ConfigError` (a misspelt or missing
 * `PAYPAL_ENV`) fails with {@link PaymentConfigError}; an empty id or secret
 * is left for {@link sessionOf} to refuse.
 */
export const configFromEnv = (
  clientIdVar: string,
  clientSecretVar: string,
): Effect.Effect<PayPalConfig, PaymentConfigError> =>
  Effect.gen(function* () {
    const clientId = yield* Config.String(clientIdVar).pipe(Config.withDefault(""));
    const clientSecret = yield* Config.Redacted(clientSecretVar).pipe(
      Config.withDefault(Redacted.make("")),
    );
    const environment = yield* Config.Literals(["live", "sandbox"], "PAYPAL_ENV");
    const baseUrl = yield* Config.option(Config.String("PAYPAL_BASE_URL"));
    return {
      clientId,
      clientSecret,
      environment,
      baseUrl: Option.getOrUndefined(baseUrl),
    };
  }).pipe(
    Effect.catchTag("ConfigError", (error) =>
      Effect.fail(new PaymentConfigError({ message: error.message })),
    ),
  );
