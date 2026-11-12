import { assert, describe, expect } from "vite-plus/test";
import { it } from "@effect/vitest";
import * as Arr from "effect/Array";
import * as Option from "effect/Option";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as R from "effect/Record";
import * as Redacted from "effect/Redacted";
import { strict as strictValidation } from "@distilled.cloud/core/response-validation";
import {
  PaymentConfigError,
  PaymentInvalidRequestError,
  type PaymentsError,
} from "@thomasfosterau/effect-biz/Payments";
import * as Customer from "../src/Customer.ts";
import * as File from "../src/File.ts";
import * as Person from "../src/Person.ts";
import * as Subscription from "../src/Subscription.ts";
import * as V2CoreAccount from "../src/V2.Core.Account.ts";
import * as V2CoreEvent from "../src/V2.Core.Event.ts";
import * as V2CoreEventDestination from "../src/V2.Core.EventDestination.ts";
import {
  DISTILLED_API_VERSION,
  layer,
  layerFromContext,
  layerFromEnv,
  make,
  type RequestOptions,
  type StripeHttp,
  type StripeHttpConfig,
} from "../src/StripeHttp.ts";
import {
  type CapturedRequest,
  jsonResponse,
  stubFetch,
  stubStripe,
  TEST_KEY,
  withTestClock,
} from "./support.ts";
import basilSubscription from "./fixtures/basil/subscription.json" with { type: "json" };

/**
 * `StripeHttp` as the resource modules use it (effect-finance#146): Distilled's operations
 * called with path ids first, then params, then {@link RequestOptions}, under
 * the request policy `tests/StripePayments.wire.test.ts` checks for the
 * capability layers (the same client). `tests/resources.wire.test.ts` covers
 * every operation of every module.
 */

const config = (over: Partial<StripeHttpConfig> = {}): StripeHttpConfig => ({
  apiKey: Redacted.make(TEST_KEY),
  ...over,
});

/**
 * Run `effect` over `StripeHttp.layer(config(over))` and a stubbed `fetch`
 * answering with `handler`, under a `TestClock` so backoff elapses at once.
 */
const over = <A, E>(
  effect: Effect.Effect<A, E, StripeHttp>,
  handler: (request: CapturedRequest, attempt: number) => Response | Promise<Response> = () =>
    jsonResponse(200, { id: "obj_1" }),
  options: Partial<StripeHttpConfig> = {},
) => {
  const { http, calls } = stubFetch(handler);
  const result = withTestClock(
    effect.pipe(Effect.provide(Layer.provideMerge(layer(config(options)), http))),
  );
  return { result, calls };
};

/** The neutral failure of `effect`, answered by `handler`. */
const failure = <A>(
  effect: Effect.Effect<A, PaymentsError, StripeHttp>,
  handler?: (request: CapturedRequest, attempt: number) => Response | Promise<Response>,
) => {
  const run = over(Effect.flip(effect), handler);
  return { error: run.result, calls: run.calls };
};

describe("resource modules over StripeHttp", () => {
  it.effect("runs a resource module end to end, returning the body as Stripe sent it", () =>
    Effect.gen(function* () {
      const body = { ...basilSubscription, cancel_at_period_end: true };
      const { result, calls } = over(
        Subscription.update("sub_1", { cancel_at_period_end: true }),
        () => jsonResponse(200, body),
      );
      expect(yield* result).toEqual(body);
      expect(calls[0]?.method).toBe("POST");
      expect(calls[0]?.url.toString()).toBe("https://api.stripe.com/v1/subscriptions/sub_1");
      expect(calls[0]?.body).toBe("cancel_at_period_end=true");
      expect(calls[0]?.headers.get("authorization")).toBe(`Bearer ${TEST_KEY}`);
      expect(calls[0]?.headers.get("stripe-version")).toBe(DISTILLED_API_VERSION);
    }),
  );

  it.effect("puts a GET's params in the query string, with no body", () =>
    Effect.gen(function* () {
      const { result, calls } = over(Customer.list({ limit: 3, email: "a@example.com" }));
      yield* result;
      expect(calls[0]?.method).toBe("GET");
      expect(calls[0]?.url.pathname).toBe("/v1/customers");
      expect(R.fromEntries(calls[0]?.url.searchParams ?? [])).toEqual({
        limit: "3",
        email: "a@example.com",
      });
      expect(calls[0]?.body).toBeUndefined();
    }),
  );

  it.effect("puts a DELETE's params in the query string, with no body, as the SDKs do", () =>
    Effect.gen(function* () {
      const { result, calls } = over(
        Subscription.cancel("sub_1", {
          invoice_now: true,
          prorate: false,
          cancellation_details: { comment: "Too pricey (for now)!", feedback: "too_expensive" },
          expand: ["latest_invoice"],
        }),
      );
      yield* result;
      expect(calls[0]?.method).toBe("DELETE");
      expect(calls[0]?.url.pathname).toBe("/v1/subscriptions/sub_1");
      expect(calls[0]?.url.search).toBe(
        "?cancellation_details[comment]=Too%20pricey%20%28for%20now%29%21" +
          "&cancellation_details[feedback]=too_expensive" +
          "&expand[0]=latest_invoice&invoice_now=true&prorate=false",
      );
      expect(calls[0]?.body).toBeUndefined();
      expect(calls[0]?.init.body).toBeUndefined();
      expect(calls[0]?.headers.get("content-type")).toBeNull();
    }),
  );

  it.effect("puts the params of a DELETE with two ids in the query string", () =>
    Effect.gen(function* () {
      const { result, calls } = over(
        Customer.delSource("cus_1", "card_1", { expand: ["customer"] }),
      );
      yield* result;
      expect(calls[0]?.method).toBe("DELETE");
      expect(calls[0]?.url.toString()).toBe(
        "https://api.stripe.com/v1/customers/cus_1/sources/card_1?expand[0]=customer",
      );
      expect(calls[0]?.init.body).toBeUndefined();
      expect(calls[0]?.headers.get("content-type")).toBeNull();
    }),
  );

  it.effect("sends a DELETE without params with no query and no body", () =>
    Effect.gen(function* () {
      const { result, calls } = over(Subscription.cancel("sub_1"));
      yield* result;
      expect(calls[0]?.url.toString()).toBe("https://api.stripe.com/v1/subscriptions/sub_1");
      expect(calls[0]?.init.body).toBeUndefined();
      expect(calls[0]?.headers.get("content-type")).toBeNull();
    }),
  );

  it.effect("orders several ids as the path does", () =>
    Effect.gen(function* () {
      const { result, calls } = over(Person.retrieve("acct_1", "person_1"));
      yield* result;
      expect(calls[0]?.url.pathname).toBe("/v1/accounts/acct_1/persons/person_1");
    }),
  );

  it.effect("lets a path id win over a params member of the same name", () =>
    Effect.gen(function* () {
      // Untyped code passing the id again in its params: a variable, so no excess-property check.
      const untypedParams = { customer: "cus_2", name: "A" };
      const { result, calls } = over(Customer.update("cus_1", untypedParams));
      yield* result;
      expect(calls[0]?.url.pathname).toBe("/v1/customers/cus_1");
    }),
  );

  it.effect.each([
    ["an empty", ""],
    // SAFETY: untyped code passing no id where the signature requires one.
    ["a missing", undefined as never],
  ])("fails %s id instead of addressing another endpoint", ([_label, id]) =>
    Effect.gen(function* () {
      const { error, calls } = failure(Customer.retrieve(id));
      const failed = yield* error;
      expect(failed).toBeInstanceOf(PaymentInvalidRequestError);
      expect(failed.message).toBe(
        "Path segment 1 of /v1/customers/{customer} must be a non-empty string",
      );
      expect(failed).toMatchObject({ param: Option.some("customer") });
      expect(calls).toHaveLength(0);
    }),
  );

  it.effect("names the id that is missing among several", () =>
    Effect.gen(function* () {
      const { error, calls } = failure(Person.retrieve("acct_1", ""));
      expect(yield* error).toMatchObject({
        _tag: "PaymentInvalidRequestError",
        message:
          "Path segment 2 of /v1/accounts/{account}/persons/{person} must be a non-empty string",
        param: Option.some("person"),
      });
      expect(calls).toHaveLength(0);
    }),
  );

  it.effect("encodes an id as one path segment", () =>
    Effect.gen(function* () {
      const { result, calls } = over(Customer.retrieve("cus_1/../balance"));
      yield* result;
      expect(calls[0]?.url.pathname).toBe("/v1/customers/cus_1%2F..%2Fbalance");
    }),
  );

  it.effect(
    "returns a body Distilled's schema would refuse, even when the caller asks for strict",
    () =>
      Effect.gen(function* () {
        // Distilled's `Customer` requires `livemode`, `created`, … : strict
        // validation would fail this body, and the client pins lenient.
        const { http } = stubFetch(() => jsonResponse(200, { id: "cus_1", object: "customer" }));
        const result = yield* Customer.retrieve("cus_1").pipe(
          Effect.provide(
            Layer.provideMerge(Layer.provideMerge(layer(config()), http), strictValidation),
          ),
        );
        expect(result).toEqual({ id: "cus_1", object: "customer" });
      }),
  );

  it.effect("runs over Distilled's Credentials in context (layerFromContext)", () =>
    Effect.gen(function* () {
      const stub = stubStripe(() => ({ id: "cus_1" }));
      const result = yield* Customer.retrieve("cus_1").pipe(
        Effect.provide(Layer.provideMerge(layerFromContext, stub.layer)),
      );
      expect(result).toEqual({ id: "cus_1" });
      expect(stub.calls[0]?.headers.get("stripe-version")).toBe(DISTILLED_API_VERSION);
    }),
  );
});

describe("RequestOptions on a resource-module operation", () => {
  it.effect("sends the Idempotency-Key and Stripe-Account headers", () =>
    Effect.gen(function* () {
      const { result, calls } = over(
        Customer.create(
          { email: "a@example.com" },
          { idempotencyKey: "k-1", stripeAccount: "acct_1" },
        ),
      );
      yield* result;
      expect(calls[0]?.headers.get("idempotency-key")).toBe("k-1");
      expect(calls[0]?.headers.get("stripe-account")).toBe("acct_1");
    }),
  );

  it.effect("takes the options as the trailing argument of an operation without params", () =>
    Effect.gen(function* () {
      const { result, calls } = over(Customer.del("cus_1", { idempotencyKey: "k-del" }));
      yield* result;
      expect(calls[0]?.method).toBe("DELETE");
      expect(calls[0]?.headers.get("idempotency-key")).toBe("k-del");
    }),
  );

  it.effect("overrides the pinned Stripe-Version for one call", () =>
    Effect.gen(function* () {
      const { result, calls } = over(
        Effect.all(
          [
            Customer.retrieve("cus_1", undefined, { apiVersion: "2025-08-27.basil" }),
            Customer.retrieve("cus_1"),
          ],
          { concurrency: 1 },
        ),
      );
      yield* result;
      expect(calls.map((call) => call.headers.get("stripe-version"))).toEqual([
        "2025-08-27.basil",
        DISTILLED_API_VERSION,
      ]);
    }),
  );

  it.effect("prefers the call's version and account over the configured ones", () =>
    Effect.gen(function* () {
      const { result, calls } = over(
        Effect.all(
          [
            Customer.retrieve("cus_1", undefined, {
              apiVersion: "2025-08-27.basil",
              stripeAccount: "acct_call",
            }),
            Customer.retrieve("cus_1"),
          ],
          { concurrency: 1 },
        ),
        undefined,
        { apiVersion: "2025-07-30.basil", stripeAccount: "acct_config" },
      );
      yield* result;
      expect(calls.map((call) => call.headers.get("stripe-version"))).toEqual([
        "2025-08-27.basil",
        "2025-07-30.basil",
      ]);
      expect(calls.map((call) => call.headers.get("stripe-account"))).toEqual([
        "acct_call",
        "acct_config",
      ]);
    }),
  );

  it.effect("generates one key for a retryable POST and reuses it across its attempts", () =>
    Effect.gen(function* () {
      const { result, calls } = over(
        Customer.create({ email: "a@example.com" }),
        (_request, attempt) =>
          attempt < 3 ? jsonResponse(503, {}) : jsonResponse(200, { id: "cus_1" }),
      );
      yield* result;
      const keys = calls.map((call) => call.headers.get("idempotency-key"));
      expect(keys).toHaveLength(3);
      expect(keys[0]).toMatch(/^effect-payments-retry-[0-9a-f-]{36}$/);
      expect(Arr.dedupe(keys)).toHaveLength(1);
    }),
  );

  it.effect("keeps a caller's key across the client's own retries", () =>
    Effect.gen(function* () {
      const { result, calls } = over(
        Customer.create({ email: "a@example.com" }, { idempotencyKey: "k-retry" }),
        (_request, attempt) =>
          attempt < 2 ? jsonResponse(500, {}) : jsonResponse(200, { id: "cus_1" }),
      );
      yield* result;
      expect(calls.map((call) => call.headers.get("idempotency-key"))).toEqual([
        "k-retry",
        "k-retry",
      ]);
    }),
  );

  it.effect("sends no key on a GET", () =>
    Effect.gen(function* () {
      const { result, calls } = over(Customer.retrieve("cus_1"));
      yield* result;
      expect(calls[0]?.headers.get("idempotency-key")).toBeNull();
    }),
  );

  it.effect.each([["idempotencyKey"], ["stripeAccount"], ["apiVersion"]] as const)(
    "refuses an empty %s before sending anything",
    ([name]) =>
      Effect.gen(function* () {
        const options: RequestOptions = { [name]: "" };
        const { error, calls } = failure(Customer.create({}, options));
        expect(yield* error).toMatchObject({
          _tag: "PaymentInvalidRequestError",
          message: `${name} must not be empty`,
          param: Option.some(name),
        });
        expect(calls).toHaveLength(0);
      }),
  );

  it.effect("passes on only the documented fields", () =>
    Effect.gen(function* () {
      // Untyped code handing an options object with an extra field: a variable
      // is not excess-property checked.
      const loose = { idempotencyKey: "k-2", upload: true };
      const { result, calls } = over(Customer.create({}, loose));
      yield* result;
      expect(calls[0]?.url.origin).toBe("https://api.stripe.com");
      expect(calls[0]?.headers.get("idempotency-key")).toBe("k-2");
    }),
  );
});

/**
 * Where stripe-node 23 sends a `/v2` request differently from `/v1` (effect-finance#181):
 * it keys every `/v2` `DELETE` (`_defaultIdempotencyKey`), and it indexes
 * array query params (`include[0]=…`), where Distilled repeats `include[]`.
 */
describe("the /v2 request policy", () => {
  const retried = (_request: CapturedRequest, attempt: number) =>
    attempt < 3 ? jsonResponse(503, {}) : jsonResponse(200, { id: "ed_1", object: "v2.deleted" });

  it.effect("generates one key for a /v2 DELETE and reuses it across its attempts", () =>
    Effect.gen(function* () {
      const { result, calls } = over(V2CoreEventDestination.del("ed_1"), retried);
      yield* result;
      expect(calls.map((call) => [call.method, call.url.pathname])).toEqual(
        Array.from({ length: 3 }, () => ["DELETE", "/v2/core/event_destinations/ed_1"]),
      );
      const keys = calls.map((call) => call.headers.get("idempotency-key"));
      expect(keys[0]).toMatch(/^effect-payments-retry-[0-9a-f-]{36}$/);
      expect(Arr.dedupe(keys)).toHaveLength(1);
    }),
  );

  it.effect("generates a fresh key for each /v2 DELETE call", () =>
    Effect.gen(function* () {
      const { result, calls } = over(
        Effect.all([V2CoreEventDestination.del("ed_1"), V2CoreEventDestination.del("ed_1")], {
          concurrency: 1,
        }),
      );
      yield* result;
      const keys = calls.map((call) => call.headers.get("idempotency-key"));
      expect(keys).toHaveLength(2);
      expect(Arr.dedupe(keys)).toHaveLength(2);
    }),
  );

  it.effect("keys a /v2 DELETE under a configured origin", () =>
    Effect.gen(function* () {
      const { result, calls } = over(V2CoreEventDestination.del("ed_1"), undefined, {
        baseUrl: "http://localhost:12111",
      });
      yield* result;
      expect(calls[0]?.url.toString()).toBe(
        "http://localhost:12111/v2/core/event_destinations/ed_1",
      );
      expect(calls[0]?.headers.get("idempotency-key")).toMatch(/^effect-payments-retry-/);
    }),
  );

  it.effect("keeps a caller's key on a /v2 DELETE across the client's retries", () =>
    Effect.gen(function* () {
      const { result, calls } = over(
        V2CoreEventDestination.del("ed_1", { idempotencyKey: "k-v2-del" }),
        retried,
      );
      yield* result;
      expect(calls.map((call) => call.headers.get("idempotency-key"))).toEqual([
        "k-v2-del",
        "k-v2-del",
        "k-v2-del",
      ]);
    }),
  );

  it.effect("generates no key for a /v1 DELETE, as the SDK does not", () =>
    Effect.gen(function* () {
      const { result, calls } = over(Customer.del("cus_1"), (_request, attempt) =>
        attempt < 2 ? jsonResponse(503, {}) : jsonResponse(200, { id: "cus_1", deleted: true }),
      );
      yield* result;
      expect(calls.map((call) => call.headers.get("idempotency-key"))).toEqual([null, null]);
    }),
  );

  it.effect("generates no key for a /v2 DELETE the client will not retry", () =>
    Effect.gen(function* () {
      const { result, calls } = over(V2CoreEventDestination.del("ed_1"), undefined, {
        maxNetworkRetries: 0,
      });
      yield* result;
      expect(calls[0]?.headers.get("idempotency-key")).toBeNull();
    }),
  );

  it.effect("sends no key on a /v2 GET", () =>
    Effect.gen(function* () {
      const { result, calls } = over(V2CoreAccount.retrieve("acct_1"));
      yield* result;
      expect(calls[0]?.url.toString()).toBe("https://api.stripe.com/v2/core/accounts/acct_1");
      expect(calls[0]?.headers.get("idempotency-key")).toBeNull();
    }),
  );

  it.effect("indexes a /v2 GET's array query params, as the SDKs send them", () =>
    Effect.gen(function* () {
      const { result, calls } = over(
        V2CoreAccount.retrieve("acct_1", { include: ["identity", "configuration.customer"] }),
      );
      yield* result;
      expect(calls[0]?.url.pathname).toBe("/v2/core/accounts/acct_1");
      expect(calls[0]?.url.search).toBe("?include[0]=identity&include[1]=configuration.customer");
    }),
  );

  it.effect("indexes each array of a /v2 list, leaving its other params alone", () =>
    Effect.gen(function* () {
      const { result, calls } = over(
        V2CoreEvent.list({
          limit: 2,
          object_id: "ed (1)",
          types: ["v1.billing.meter.error_report_triggered", "v2.core.event_destination.ping"],
        }),
        () => jsonResponse(200, { data: [], next_page_url: null, previous_page_url: null }),
      );
      yield* result;
      expect(calls[0]?.url.pathname).toBe("/v2/core/events");
      expect(calls[0]?.url.search).toBe(
        "?limit=2&object_id=ed%20%281%29" +
          "&types[0]=v1.billing.meter.error_report_triggered" +
          "&types[1]=v2.core.event_destination.ping",
      );
    }),
  );

  it.effect("leaves a /v2 query without arrays as Distilled sent it", () =>
    Effect.gen(function* () {
      const { result, calls } = over(V2CoreEvent.list({ limit: 2, object_id: "ed (1)" }), () =>
        jsonResponse(200, { data: [], next_page_url: null, previous_page_url: null }),
      );
      yield* result;
      expect(calls[0]?.url.search).toBe("?limit=2&object_id=ed+%281%29");
    }),
  );

  it.effect("leaves a /v1 GET's array query params as Distilled sends them", () =>
    Effect.gen(function* () {
      const { result, calls } = over(Customer.retrieve("cus_1", { expand: ["default_source"] }));
      yield* result;
      expect([...(calls[0]?.url.searchParams ?? [])]).toEqual([["expand[]", "default_source"]]);
    }),
  );
});

describe("file uploads", () => {
  it.effect("sends File.create as multipart/form-data to the uploads origin", () =>
    Effect.gen(function* () {
      const { result, calls } = over(
        File.create({ purpose: "dispute_evidence", file: "evidence" }),
      );
      yield* result;
      expect(calls[0]?.url.toString()).toBe("https://files.stripe.com/v1/files");
      expect(calls[0]?.form?.get("purpose")).toBe("dispute_evidence");
      expect(calls[0]?.headers.get("stripe-version")).toBe(DISTILLED_API_VERSION);
    }),
  );

  it.effect(
    "sends a File as the file part, typed without a cast (Distilled declares `file: string`)",
    () =>
      Effect.gen(function* () {
        const pdf = new globalThis.File(["%PDF-1.4"], "evidence.pdf", { type: "application/pdf" });
        const { result, calls } = over(File.create({ purpose: "dispute_evidence", file: pdf }));
        yield* result;
        const part = calls[0]?.form?.get("file");
        assert(part instanceof globalThis.File, "the file part is a File");
        expect(part.name).toBe("evidence.pdf");
      }),
  );

  it.effect("sends an upload's nested params as bracketed form fields", () =>
    Effect.gen(function* () {
      const pdf = new Blob(["%PDF-1.4"], { type: "application/pdf" });
      const { result, calls } = over(
        File.create({
          purpose: "dispute_evidence",
          file: pdf,
          file_link_data: { create: true, metadata: { case: "dp_1" } },
          expand: ["links"],
        }),
      );
      yield* result;
      const form = calls[0]?.form;
      expect(form?.get("file")).toBeInstanceOf(Blob);
      expect(form?.get("file_link_data[create]")).toBe("true");
      expect(form?.get("file_link_data[metadata][case]")).toBe("dp_1");
      expect(form?.get("expand[0]")).toBe("links");
      expect(form?.get("file_link_data")).toBeNull();
      expect(form?.get("expand")).toBeNull();
    }),
  );

  it.effect("honours a configured uploads origin, and keeps the API origin for the rest", () =>
    Effect.gen(function* () {
      const { result, calls } = over(
        Effect.all([File.create({ purpose: "dispute_evidence", file: "evidence" }), File.list()], {
          concurrency: 1,
        }),
        undefined,
        { uploadsBaseUrl: "http://localhost:12112", baseUrl: "http://localhost:12111" },
      );
      yield* result;
      expect(calls.map((call) => call.url.origin)).toEqual([
        "http://localhost:12112",
        "http://localhost:12111",
      ]);
    }),
  );
});

describe("StripeHttp configuration", () => {
  it.effect("fails an empty key with PaymentConfigError", () =>
    Effect.gen(function* () {
      const { http } = stubFetch(() => jsonResponse(200, {}));
      const error = yield* Effect.flip(
        make({ apiKey: Redacted.make("") }).pipe(Effect.provide(http)),
      );
      expect(error).toBeInstanceOf(PaymentConfigError);
    }),
  );

  it.effect("reads the key for layerFromEnv from configuration, while the layer is built", () =>
    Effect.gen(function* () {
      const { http, calls } = stubFetch(() => jsonResponse(200, { id: "cus_1" }));
      yield* Customer.retrieve("cus_1").pipe(
        Effect.provide(
          Layer.provideMerge(
            Layer.provideMerge(layerFromEnv(), http),
            Layer.provideMerge(
              Layer.provideMerge(layerFromEnv(), http),
              ConfigProvider.layer(ConfigProvider.fromUnknown({ STRIPE_API_KEY: TEST_KEY })),
            ),
          ),
        ),
      );
      expect(calls[0]?.headers.get("authorization")).toBe(`Bearer ${TEST_KEY}`);
    }),
  );

  it.effect("fails layerFromEnv with PaymentConfigError naming an absent variable", () =>
    Effect.gen(function* () {
      const { http } = stubFetch(() => jsonResponse(200, {}));
      const error = yield* Effect.flip(
        Layer.build(layerFromEnv("MY_STRIPE_KEY")).pipe(
          Effect.scoped,
          Effect.provide(
            Layer.provideMerge(http, ConfigProvider.layer(ConfigProvider.fromUnknown({}))),
          ),
        ),
      );
      expect(error).toBeInstanceOf(PaymentConfigError);
      expect(error.message).toContain("MY_STRIPE_KEY");
    }),
  );

  // Effect's ConfigProvider treats a literal empty string as a MISSING value,
  // so an empty key variable is indistinguishable from an unset one.
  it.effect.each([
    ["by default", ConfigProvider.fromUnknown({ STRIPE_API_KEY: "" })],
    [
      "under preserveEmptyStrings",
      ConfigProvider.fromEnv({ env: { STRIPE_API_KEY: "" }, preserveEmptyStrings: true }),
    ],
  ] as const)("treats an empty key variable as absent, %s", ([_label, provider]) =>
    Effect.gen(function* () {
      const { http, calls } = stubFetch(() => jsonResponse(200, {}));
      const error = yield* Effect.flip(
        Layer.build(layerFromEnv()).pipe(
          Effect.scoped,
          Effect.provide(Layer.provideMerge(http, ConfigProvider.layer(provider))),
        ),
      );
      expect(error).toBeInstanceOf(PaymentConfigError);
      expect(error.message).toContain("STRIPE_API_KEY");
      expect(calls).toHaveLength(0);
    }),
  );
});
