/**
 * The client the capability layers (`PayPalPayments`) reach PayPal through:
 * Distilled's generated operations (`@distilled.cloud/paypal`), run under the
 * request policy below (the one the package's hand-written REST client
 * applied before effect-finance#146 removed it).
 *
 * Distilled builds and sends each request (the URI template and its path ids,
 * the query string, the JSON body, the `PayPal-Request-Id` header of a write)
 * with the access token and base URL its `Credentials` resolve to, and reads
 * the response. Around every operation this module:
 *
 * - **authenticates from the session** (`internal/auth.ts`): the token comes
 *   from the shared OAuth login and its cache, never from Distilled's
 *   `CredentialsFromEnv`, and a 401 forgets the token that request used;
 * - **sends `Content-Type: application/json` and `Accept: application/json`
 *   on every request**: Distilled sends no body (and so no content type) on
 *   a `POST` without body members, and PayPal answers a bodyless
 *   `POST /v1/billing/plans/{id}/activate` without one with 415;
 * - **pins lenient response validation**, so a response is never refused over
 *   a field this package does not read; the capability layers decode the
 *   fields they map instead;
 * - **switches Distilled's retries off**: it never repeats a request, so a
 *   write is retried only by its caller, with the `PayPal-Request-Id` it
 *   chose;
 * - **times out** each request (default 80 s, not including the login);
 * - **classifies failures** onto the neutral {@link PaymentsError} channel
 *   from the response's status and PayPal's error body. Distilled's error
 *   classes keep neither the status nor the whole vendor body, so the client
 *   watches the response through the `HttpClient` it hands Distilled and
 *   classifies that with `handlePayPalError`. A failure with no response
 *   behind it is a connection failure ({@link PaymentNetworkError}), or a
 *   Distilled error mapped to {@link PaymentProviderError} by its tag.
 *
 * The token is a `Redacted` until Distilled sets the header; a connection
 * failure keeps only the underlying cause, never the request that carries it.
 *
 * @module
 */

import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import { HttpClient, HttpClientError, HttpClientRequest } from "effect/http";
import { ResponseValidation } from "@distilled.cloud/core/response-validation";
import { Credentials, type Config as PayPalCredentials } from "@distilled.cloud/paypal/Credentials";
import type { PaypalOpContext } from "@distilled.cloud/paypal/Protocol";
import { Retry } from "@distilled.cloud/paypal/Retry";
import type { PaymentConfigError, PaymentsError } from "@thomasfosterau/effect-biz/Payments";
import {
  isOk,
  networkError,
  type ObservedResponse,
  observeResponses,
  rejectedError,
} from "@thomasfosterau/effect-biz/Payments.internal";
import type { PayPalConfig } from "../PayPalPayments.js";
import { configFromEnv, sessionOf, type Session, timedOut } from "./auth.js";
import { errorBodyOf, handlePayPalError, PROVIDER } from "./error.js";

/** A request is abandoned after 80 s unless configured. */
const DEFAULT_TIMEOUT = /* @__PURE__ */ Duration.millis(80_000);

/** One Distilled operation, as the generated `@distilled.cloud/paypal/<service>` modules export it. */
export type Operation<I, O, E> = (input: I) => Effect.Effect<O, E, PaypalOpContext>;

/**
 * The client service the capability layers are built over. `call` resolves
 * to the body of a 2xx as Distilled read it, **unchecked**: Distilled
 * validates nothing in lenient mode (its JSON, `{}` when it is empty, its
 * text when it is not JSON), so the caller decodes the fields it maps.
 */
export class DistilledClient extends Context.Service<
  DistilledClient,
  {
    readonly call: <I, O, E>(
      operation: Operation<I, O, E>,
      input: I,
    ) => Effect.Effect<unknown, PaymentsError>;
  }
>()("@effect-biz/payments-paypal/internal/DistilledClient") {}

/** What one call saw of a response, read before Distilled reads it. */
type Observed = ObservedResponse;

/** One call's outcome, before it is judged. */
type Outcome = Data.TaggedEnum<{
  /** Distilled succeeded: a 2xx, its body as Distilled read it. */
  Success: { readonly body: unknown };
  /** A non-2xx response, which decides the outcome. */
  Response: Observed;
  /** No response: the request could not be sent or its response not read. */
  Transport: { readonly error: HttpClientError.HttpClientError };
  /** No response within `after`, the request timeout. */
  TimedOut: { readonly after: Duration.Duration };
  /** A Distilled failure with no non-2xx response behind it. */
  Rejected: { readonly error: unknown };
}>;
const Outcome = /* @__PURE__ */ Data.taggedEnum<Outcome>();

/** Distilled's retries, switched off: a request is never repeated by this client. */
const NO_RETRY = { while: () => false };

/**
 * A Distilled failure as an outcome. An `HttpClientError` means no response
 * arrived (or its body could not be read).
 */
const failureOf = (error: unknown): Outcome =>
  HttpClientError.isHttpClientError(error)
    ? Outcome.Transport({ error })
    : Outcome.Rejected({ error });

/**
 * The outcome of one call. A non-2xx response, once seen, decides it whatever
 * Distilled made of it: it is classified from its status and body.
 */
const judge = (outcome: Outcome, observed: Option.Option<Observed>): Outcome =>
  Option.match(observed, {
    onNone: () => outcome,
    onSome: (response) => (isOk(response.status) ? outcome : Outcome.Response(response)),
  });

/**
 * The message and code of a Distilled failure with no response behind it
 * that carries neither, mapped by `rejectedError` to a neutral error named by
 * its tag.
 */
const REJECTED = { message: "The PayPal request failed", code: "UnknownPaypalError" };

/** Judge a final outcome: the body of a 2xx, or a neutral error. */
const settle = (outcome: Outcome): Effect.Effect<unknown, PaymentsError> =>
  Outcome.$match(outcome, {
    Success: ({ body }) => Effect.succeed(body),
    Response: ({ status, headers, body }) =>
      Effect.fail(
        handlePayPalError(status, errorBodyOf(Option.getOrUndefined(body)), headers["retry-after"]),
      ),
    Transport: ({ error }) => Effect.fail(networkError(error)),
    TimedOut: ({ after }) => Effect.fail(timedOut("request", after)),
    Rejected: ({ error }) => Effect.fail(rejectedError(error, PROVIDER, REJECTED)),
  });

/**
 * `Content-Type: application/json` on a request Distilled sends without a
 * body (a JSON body carries its own), and `Accept: application/json` on
 * every request.
 */
const withJsonHeaders = (
  request: HttpClientRequest.HttpClientRequest,
): HttpClientRequest.HttpClientRequest => {
  const accepting = HttpClientRequest.acceptJson(request);
  return request.body._tag === "Empty"
    ? HttpClientRequest.setHeader(accepting, "Content-Type", "application/json")
    : accepting;
};

/** What one call authenticates with: the credentials, and what to do on a 401. */
interface Grant {
  /** Distilled's `Credentials`: resolved by its protocol when it builds the request. */
  readonly credentials: Effect.Effect<PayPalCredentials>;
  /** Run after PayPal answered 401 to these credentials. */
  readonly refused: Effect.Effect<void>;
}

/** The client's authentication and request policy. */
interface MakeOptions {
  /** Resolved before every call; may fail (a refused or timed-out login). */
  readonly grant: Effect.Effect<Grant, PaymentsError>;
  readonly timeout: Duration.Duration;
}

/** Build the client over the `HttpClient` in context. */
const make = (
  options: MakeOptions,
): Effect.Effect<DistilledClient["Service"], never, HttpClient.HttpClient> =>
  Effect.map(HttpClient.HttpClient, (http) => {
    const { timeout } = options;

    /** One call of `operation`, reduced to an {@link Outcome}; fails only by defect. */
    const attempt = <I, O, E>(
      operation: Operation<I, O, E>,
      input: I,
      credentials: Effect.Effect<PayPalCredentials>,
    ): Effect.Effect<readonly [Outcome, Option.Option<Observed>]> =>
      Effect.gen(function* () {
        // Keep what the classification needs of the response, read before
        // Distilled reads it.
        const watched = yield* observeResponses(HttpClient.mapRequest(http, withJsonHeaders));
        const outcome = yield* operation(input).pipe(
          // Every typed failure becomes an outcome to judge; defects stay defects.
          Effect.match({
            onSuccess: (body) => Outcome.Success({ body }),
            onFailure: failureOf,
          }),
          Effect.provideService(Credentials, credentials),
          Effect.provideService(HttpClient.HttpClient, watched.client),
          Effect.provideService(Retry, NO_RETRY),
          Effect.provideService(ResponseValidation, "lenient"),
          Effect.timeoutOption(timeout),
          Effect.map(Option.getOrElse(() => Outcome.TimedOut({ after: timeout }))),
        );
        const seen = yield* watched.last;
        return [judge(outcome, seen), seen] as const;
      });

    const call = Effect.fn("DistilledClient.call")(function* <I, O, E>(
      operation: Operation<I, O, E>,
      input: I,
    ) {
      const grant = yield* options.grant;
      const [outcome, seen] = yield* attempt(operation, input, grant.credentials);
      if (Option.isSome(seen) && seen.value.status === 401) yield* grant.refused;
      return yield* settle(outcome);
    });

    return DistilledClient.of({ call });
  });

/**
 * The client over Distilled's `Credentials` in context (an access token and
 * base URL, resolved on every call), with the default 80 s timeout. There is
 * no login to refresh, so a 401 changes nothing.
 */
export const layerFromContext: Layer.Layer<
  DistilledClient,
  never,
  Credentials | HttpClient.HttpClient
> = /* @__PURE__ */ Layer.effect(
  DistilledClient,
  /* @__PURE__ */ Effect.flatMap(Credentials, (resolve) =>
    make({
      grant: Effect.succeed({ credentials: resolve, refused: Effect.void }),
      timeout: DEFAULT_TIMEOUT,
    }),
  ),
);

/**
 * The client over a session: every call resolves the session's token (the
 * cached one, or one shared login) into Distilled's `Credentials`, at the
 * session's base URL, and a 401 forgets that token.
 */
const fromSession = (
  session: Session,
): Effect.Effect<DistilledClient["Service"], never, HttpClient.HttpClient> =>
  make({
    grant: Effect.map(session.token, (token) => ({
      credentials: Effect.succeed({ apiKey: Redacted.make(token), apiBaseUrl: session.baseUrl }),
      refused: session.forget(token),
    })),
    timeout: session.timeout,
  });

/**
 * The client from configuration, logging in with the client credentials.
 * Fails with {@link PaymentConfigError} when the session refuses `config`.
 */
export const layer = (
  config: PayPalConfig,
): Layer.Layer<DistilledClient, PaymentConfigError, HttpClient.HttpClient> =>
  Layer.effect(DistilledClient, Effect.flatMap(sessionOf(config), fromSession));

/**
 * The client with its configuration read from configuration variables while
 * the layer is built (`configFromEnv`).
 */
export const layerFromEnv = (
  clientIdVar: string,
  clientSecretVar: string,
): Layer.Layer<DistilledClient, PaymentConfigError, HttpClient.HttpClient> =>
  Layer.effect(
    DistilledClient,
    configFromEnv(clientIdVar, clientSecretVar).pipe(
      Effect.flatMap(sessionOf),
      Effect.flatMap(fromSession),
    ),
  );
