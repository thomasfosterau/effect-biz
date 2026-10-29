/**
 * The `@thomasfosterau/effect-biz/Payments.internal` subpath resolves against the
 * EMITTED declarations, and its helpers keep the shapes the providers rely on.
 * The subpath is internal and exempt from semver; this fixture is the provider
 * contract, not a consumer-facing promise. Never executed; type-checked only.
 */

import type { Duration, Effect, HashSet, Option, Schema } from "effect";
import type { HttpClient, HttpClientError, HttpClientRequest } from "effect/http";
import type {
  Page,
  PaymentConfigError,
  PaymentInvalidRequestError,
  PaymentNetworkError,
  PaymentProviderError,
  PaymentsError,
} from "@thomasfosterau/effect-biz/Payments";
import {
  checkId,
  checkMinorUnits,
  decimalText,
  epochSecondsOf,
  errorFromStatus,
  exponentFrom,
  formatDecimal,
  isAbsoluteHttpUrl,
  isOk,
  networkError,
  observeResponses,
  omitUndefined,
  pageNumberedList,
  parseDecimal,
  rejectedError,
  responseDecoder,
  scaleToMinor,
  send,
  shareLogin,
  stringField,
  timedOut,
  timeoutOf,
  tokenCache,
  type ObservedResponse,
  type OmitUndefined,
  type Reply,
  type TokenCache,
} from "@thomasfosterau/effect-biz/Payments.internal";

declare const cached: Effect.Effect<Option.Option<string>>;
declare const login: Effect.Effect<string, "denied">;

/** `shareLogin` yields a `getToken` carrying the login's own error type. */
export const getToken: Effect.Effect<Effect.Effect<string, "denied">> = shareLogin(cached, login);

/** The money core's declared shapes. */
export const parsed: number | undefined = parseDecimal("10.00", 2);
export const formatted: string | undefined = formatDecimal(1000, 2);
export const text: string = decimalText(false, 1000n, 2);
export const scaled: bigint | undefined = scaleToMinor(1000n, 2, 2);
export const checked: Effect.Effect<void, PaymentInvalidRequestError> = checkMinorUnits(
  1,
  "amount",
);
declare const zeroDecimal: HashSet.HashSet<string>;
declare const threeDecimal: HashSet.HashSet<string>;
export const exponent: (currency: string) => 0 | 2 | 3 = exponentFrom(zeroDecimal, threeDecimal);

declare const http: HttpClient.HttpClient;
declare const request: HttpClientRequest.HttpClientRequest;
declare const httpError: HttpClientError.HttpClientError;
declare const limit: Duration.Duration;

/** The token-login plumbing's declared shapes. */
export const ok: boolean = isOk(200);
export const absolute: boolean = isAbsoluteHttpUrl("https://example.com");
export const timeout: Effect.Effect<Duration.Duration, PaymentConfigError> = timeoutOf(
  "Provider",
  "timeout",
  1000,
);
export const network: PaymentNetworkError = networkError(httpError);
export const late: PaymentNetworkError = timedOut("Provider", "login", limit);
export const reply: Effect.Effect<Reply, PaymentNetworkError> = send(http, request, {
  provider: "Provider",
  what: "login",
  limit,
});
declare const answered: Reply;
export const replyStatus: number = answered.status;
export const replyJson: unknown = answered.json;
export const replyHeaders: Readonly<Record<string, string | undefined>> = answered.headers;
export const cache: Effect.Effect<TokenCache> = tokenCache;
declare const cacheValue: TokenCache;
export const cachedToken: Effect.Effect<Option.Option<string>> = cacheValue.cached;
export const store: (token: string, expiresAt: number) => Effect.Effect<void> = cacheValue.store;
export const forget: (token: string) => Effect.Effect<void> = cacheValue.forget;

/** `omitUndefined` keeps the defined keys required and makes the others bare optionals. */
declare const optionals: { readonly id: string; readonly name: string | undefined };
export const omitted: OmitUndefined<typeof optionals> = omitUndefined(optionals);
export const omittedId: string = omitted.id;
export const omittedOptional: string | undefined = omitted.name;
// @ts-expect-error -- `name` is a bare optional: an explicit `undefined` is refused.
export const omittedName: OmitUndefined<typeof optionals> = { id: "c", name: undefined };

/** The Distilled-wrapper request helpers' declared shapes. */
export const idChecked: Effect.Effect<void, PaymentInvalidRequestError> = checkId("customer", "c");
export const field: string | undefined = stringField({ message: "m" }, "message");
export const observed: Effect.Effect<{
  readonly client: HttpClient.HttpClient;
  readonly last: Effect.Effect<Option.Option<ObservedResponse>>;
}> = observeResponses(http);
declare const response: ObservedResponse;
export const responseStatus: number = response.status;
export const responseHeaders: Readonly<Record<string, string | undefined>> = response.headers;
export const responseBody: Option.Option<unknown> = response.body;
export const rejected: PaymentProviderError = rejectedError(new Error("boom"), "Provider", {
  message: "fallback",
  code: "Unknown",
});

/** The REST response helpers' declared shapes: a decoder keeps its map's result type. */
declare const thingSchema: Schema.Struct<{ readonly id: Schema.String }>;
export const decodeThing: (body: unknown) => Effect.Effect<number, PaymentProviderError> =
  responseDecoder({ provider: "provider", name: "Provider" })(
    "thing",
    thingSchema,
    (thing) => thing.id.length,
  );
export const seconds: number = epochSecondsOf(null);
export const classified: PaymentsError = errorFromStatus(500, {
  provider: "provider",
  message: "m",
  code: undefined,
  param: undefined,
  retryAfter: undefined,
});

declare const listOne: (page: number | undefined) => Effect.Effect<Page<string>, "boom">;
export const numbered: Effect.Effect<
  Page<string>,
  "boom" | PaymentInvalidRequestError
> = pageNumberedList({ limit: 10 }, { provider: "Provider", firstPage: 1 }, listOne);
