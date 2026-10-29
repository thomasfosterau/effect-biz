/**
 * Test doubles shared by the PayPal capability suites: {@link stubPayPal}, a
 * stubbed `fetch` decoded into PayPal calls for the capability layers (which
 * run on Distilled's operations), beside the vendor-neutral doubles every
 * provider suite shares (`tests/stubs.ts` at the repository root,
 * re-exported here). No test reaches `api-m.paypal.com`.
 */

import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Record from "effect/Record";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import { Credentials } from "@distilled.cloud/paypal/Credentials";
import * as PayPalPayments from "../src/PayPalPayments.ts";
import { type CapturedRequest, stubApi } from "../../../tests/stubs.ts";

export {
  type CapturedRequest,
  jsonResponse,
  reachableFrom,
  stubFetch,
  withTestClock,
} from "../../../tests/stubs.ts";

/** The access token {@link stubPayPal} authenticates with. */
export const TEST_TOKEN = "A21AA_not_a_real_access_token";

/** One request to the stubbed PayPal API, as PayPal would read it. */
export interface PayPalCall {
  readonly method: string;
  /** The path, e.g. `/v1/catalogs/products/PROD-1`. */
  readonly path: string;
  /** The query string, as a record. */
  readonly query: Readonly<Record<string, string>>;
  /** The JSON body, parsed; `undefined` for none. */
  readonly body: unknown;
  /** The `PayPal-Request-Id` header, if sent. */
  readonly requestId: string | undefined;
  readonly headers: Headers;
}

const JsonText = Schema.fromJsonString(Schema.Unknown);
const decodeJson = Schema.decodeUnknownSync(JsonText);
const encodeJson = Schema.encodeSync(JsonText);

/** Parse a JSON text (a request body, say); throws on malformed JSON. */
const parseJson = (text: string) => decodeJson(text);

/** Serialise a value as JSON text, honouring `toJSON` as `JSON.stringify` does. */
export const toJson = <A>(value: A): string => encodeJson(value);

/** A captured request as a {@link PayPalCall}. */
export const callOf = (request: CapturedRequest): PayPalCall => ({
  method: request.method,
  path: request.url.pathname,
  query: Record.fromEntries(request.url.searchParams),
  body: request.body === undefined || request.body === "" ? undefined : parseJson(request.body),
  requestId: request.headers.get("paypal-request-id") ?? undefined,
  headers: request.headers,
});

/**
 * A stubbed PayPal API for the capability layers: `answer` maps each call to a
 * body (served as a 200) or a whole `Response`, and may throw to simulate a
 * connection failure. `layer` is what the capability layers require:
 * Distilled's `Credentials` (holding {@link TEST_TOKEN}) and the stubbed
 * `HttpClient`.
 */
export const stubPayPal = (answer: (call: PayPalCall, attempt: number) => unknown) => {
  const stub = stubApi(callOf, answer);
  const credentials = Layer.succeed(
    Credentials,
    Effect.succeed({ apiKey: Redacted.make(TEST_TOKEN), apiBaseUrl: "https://api-m.paypal.com" }),
  );
  return { calls: stub.calls, requests: stub.requests, layer: Layer.merge(stub.http, credentials) };
};

/** What the capability layers require, as {@link stubPayPal} provides it. */
type Requirements = Layer.Services<typeof PayPalPayments.capabilities>;

/** Every PayPal capability over a stub's layer. */
export const capabilitiesOver = (layer: Layer.Layer<Requirements>) =>
  Layer.provide(PayPalPayments.capabilities, layer);
