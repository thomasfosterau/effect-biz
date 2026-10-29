/**
 * Test doubles shared by the Stripe suites: {@link stubStripe}, a stubbed
 * `fetch` decoded into Stripe calls for the capability layers and resource
 * modules (which run on Distilled's operations), beside the vendor-neutral
 * doubles every provider suite shares (`tests/stubs.ts` at the
 * repository root, re-exported here). No test reaches `api.stripe.com`.
 */

import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Predicate from "effect/Predicate";
import * as Rec from "effect/Record";
import * as Redacted from "effect/Redacted";
import { Credentials } from "@distilled.cloud/stripe/Credentials";
import { jsonResponse, stubApi } from "../../../tests/stubs.ts";

export {
  type CapturedRequest,
  jsonResponse,
  reachableFrom,
  stubFetch,
  withTestClock,
} from "../../../tests/stubs.ts";

/** The secret key {@link stubStripe} authenticates with. */
export const TEST_KEY = "sk_test_not_a_real_key_4242";

/** One request to the stubbed Stripe API, as Stripe would read it. */
export interface StripeCall {
  readonly method: string;
  /** The path, e.g. `/v1/customers/cus_1`. */
  readonly path: string;
  /**
   * The parameters, flat as they travel (`{ "metadata[tier]": "pro" }`): the
   * form body of a `POST`, the query string otherwise. Compare with
   * {@link formOf}.
   */
  readonly params: Readonly<Record<string, string>>;
  readonly headers: Headers;
}

/** One parameter flattened into its bracketed form fields. */
const fieldsOf = (key: string, value: unknown): ReadonlyArray<readonly [string, string]> =>
  value === undefined || value === null
    ? []
    : Array.isArray(value)
      ? value.flatMap((item, index) => fieldsOf(`${key}[${index}]`, item))
      : Predicate.isObject(value)
        ? Arr.flatMap(Rec.toEntries(value), ([name, item]) => fieldsOf(`${key}[${name}]`, item))
        : [[key, String(value)]];

/**
 * `params` flattened the way Stripe reads a form body, for comparison with a
 * {@link StripeCall}'s `params`: undefined members vanish, `metadata: { tier:
 * "pro" }` becomes `"metadata[tier]": "pro"` and `items: [{ price }]`
 * becomes `"items[0][price]"`.
 */
export const formOf = (params: Readonly<Record<string, unknown>>): Record<string, string> =>
  Rec.fromEntries(Arr.flatMap(Rec.toEntries(params), ([key, value]) => fieldsOf(key, value)));

/**
 * A stubbed Stripe API for the capability layers: `answer` maps each call to a
 * body (served as a 200) or a whole `Response`, and may throw to simulate a
 * connection failure. `layer` is what the capability layers require:
 * Distilled's `Credentials` (holding {@link TEST_KEY}) and the stubbed
 * `HttpClient`; `fetch` is the stub alone, for a program that builds its own
 * client and credentials.
 */
export const stubStripe = (answer: (call: StripeCall, attempt: number) => unknown) => {
  const stub = stubApi(
    (request): StripeCall => ({
      method: request.method,
      path: request.url.pathname,
      params: Rec.fromEntries(
        request.method === "POST"
          ? new URLSearchParams(request.body ?? "")
          : request.url.searchParams,
      ),
      headers: request.headers,
    }),
    answer,
  );
  const credentials = Layer.succeed(
    Credentials,
    Effect.succeed({ apiKey: Redacted.make(TEST_KEY), apiBaseUrl: "https://api.stripe.com" }),
  );
  return {
    calls: stub.calls,
    requests: stub.requests,
    fetch: stub.fetch,
    layer: Layer.merge(stub.http, credentials),
  };
};

/** `stubStripe` answering from a table keyed by `METHOD /path`; a miss is a 404. */
export const stubStripeTable = (answers: Readonly<Record<string, unknown>>) =>
  stubStripe(
    (call) =>
      answers[`${call.method} ${call.path}`] ??
      jsonResponse(404, {
        error: {
          type: "invalid_request_error",
          message: `No stub for ${call.method} ${call.path}`,
        },
      }),
  );
