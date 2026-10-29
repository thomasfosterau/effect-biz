import { describe, it, expect } from "vite-plus/test";
import * as Arr from "effect/Array";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Predicate from "effect/Predicate";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import { FetchHttpClient, HttpClientError, HttpClientRequest } from "effect/http";
import { strict as strictValidation } from "@distilled.cloud/core/response-validation";
import * as Customer from "@thomasfosterau/effect-biz/Payments.Customer";
import * as PaymentIntent from "@thomasfosterau/effect-biz/Payments.PaymentIntent";
import * as Price from "@thomasfosterau/effect-biz/Payments.Price";
import * as Product from "@thomasfosterau/effect-biz/Payments.Product";
import * as Refund from "@thomasfosterau/effect-biz/Payments.Refund";
import * as Subscription from "@thomasfosterau/effect-biz/Payments.Subscription";
import {
  PaymentAuthenticationError,
  PaymentConfigError,
  PaymentInvalidRequestError,
  PaymentNetworkError,
  PaymentProviderError,
  PaymentRateLimitError,
  type PaymentsError,
} from "@thomasfosterau/effect-biz/Payments";
import type { StripeHttpConfig } from "../src/StripeHttp.ts";
import * as StripePayments from "../src/StripePayments.ts";
import {
  type CapturedRequest,
  jsonResponse,
  reachableFrom,
  stubFetch,
  stubStripe,
  TEST_KEY,
  withTestClock,
} from "./support.ts";
import customer from "./fixtures/basil/customer.json" with { type: "json" };
import basilSubscription from "./fixtures/basil/subscription.json" with { type: "json" };

/**
 * `StripePayments` on Distilled's operations (effect-finance#146): what reaches the wire,
 * and how each failure Distilled reports lands on the neutral channel. The
 * expectations are `StripeHttp`'s (`tests/StripeHttp.test.ts`).
 */

type Capabilities = Layer.Success<typeof StripePayments.capabilities>;

/**
 * The version the capabilities pin; `tests/distilledApiVersion.test.ts`
 * checks it against the installed Distilled release.
 */
const { DISTILLED_API_VERSION } = StripePayments;

const config = (over: Partial<StripeHttpConfig> = {}): StripeHttpConfig => ({
  apiKey: Redacted.make(TEST_KEY),
  ...over,
});

/**
 * Run `effect` over `StripePayments.layer(config(over))` and a stubbed
 * `fetch` answering with `handler`, under a `TestClock` so backoff elapses at
 * once.
 */
const over = <A, E>(
  effect: Effect.Effect<A, E, Capabilities>,
  handler: (request: CapturedRequest, attempt: number) => Response | Promise<Response>,
  options: Partial<StripeHttpConfig> = {},
) => {
  const { http, calls } = stubFetch(handler);
  const result = Effect.runPromise(
    withTestClock(
      effect.pipe(Effect.provide(StripePayments.layer(config(options))), Effect.provide(http)),
    ),
  );
  return { result, calls };
};

/** A value as `JSON.stringify` writes it. */
const toJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

/** The neutral failure of one `Customer.create` answered with `status` and `body`, not retried. */
const failure = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  over(
    Effect.flip(Customer.create({ email: "a@example.com" })),
    () =>
      Predicate.isString(body)
        ? new Response(body, { status, headers })
        : jsonResponse(status, body, headers),
    { maxNetworkRetries: 0 },
  ).result;

/** One call of every operation, with the method and path it must reach. */
const everyCall: ReadonlyArray<
  readonly [string, Effect.Effect<unknown, unknown, Capabilities>, string]
> = [
  ["Customer.create", Customer.create({ email: "a@example.com" }), "POST /v1/customers"],
  ["Customer.retrieve", Customer.retrieve("cus_1"), "GET /v1/customers/cus_1"],
  ["Customer.update", Customer.update("cus_1", { name: "A" }), "POST /v1/customers/cus_1"],
  ["Customer.del", Customer.del("cus_1"), "DELETE /v1/customers/cus_1"],
  ["Customer.list", Customer.list(), "GET /v1/customers"],
  ["Product.retrieve", Product.retrieve("prod_1"), "GET /v1/products/prod_1"],
  ["Product.update", Product.update("prod_1", { active: false }), "POST /v1/products/prod_1"],
  ["Product.del", Product.del("prod_1"), "DELETE /v1/products/prod_1"],
  ["PaymentIntent.retrieve", PaymentIntent.retrieve("pi_1"), "GET /v1/payment_intents/pi_1"],
  ["PaymentIntent.cancel", PaymentIntent.cancel("pi_1"), "POST /v1/payment_intents/pi_1/cancel"],
  ["Subscription.cancel", Subscription.cancel("sub_1"), "DELETE /v1/subscriptions/sub_1"],
];

describe("StripePayments pins the API version", () => {
  it.each(everyCall)("%s sends Stripe-Version: DISTILLED_API_VERSION", async (_, call, route) => {
    const stub = stubStripe(() => ({}));
    await Effect.runPromise(
      Effect.exit(
        call.pipe(Effect.provide(StripePayments.capabilities), Effect.provide(stub.layer)),
      ),
    );
    expect(stub.calls).toHaveLength(1);
    expect(`${stub.calls[0]?.method} ${stub.calls[0]?.path}`).toBe(route);
    expect(stub.calls[0]?.headers.get("stripe-version")).toBe(DISTILLED_API_VERSION);
  });

  it("pins it on every attempt of a retried request", async () => {
    const { result, calls } = over(Customer.retrieve("cus_1"), (_request, attempt) =>
      attempt < 3 ? jsonResponse(503, {}) : jsonResponse(200, customer),
    );
    await result;
    expect(calls.map((call) => call.headers.get("stripe-version"))).toEqual([
      DISTILLED_API_VERSION,
      DISTILLED_API_VERSION,
      DISTILLED_API_VERSION,
    ]);
  });

  it("sends a configured version and base URL instead", async () => {
    const { result, calls } = over(Customer.retrieve("cus_1"), () => jsonResponse(200, customer), {
      apiVersion: "2025-07-30.basil",
      baseUrl: "http://localhost:12111",
    });
    await result;
    expect(calls[0]?.url.toString()).toBe("http://localhost:12111/v1/customers/cus_1");
    expect(calls[0]?.headers.get("stripe-version")).toBe("2025-07-30.basil");
  });
});

describe("StripePayments request policy", () => {
  it("authenticates with the key as a bearer token and accepts JSON", async () => {
    const { result, calls } = over(Customer.retrieve("cus_1"), () => jsonResponse(200, customer));
    await result;
    expect(calls[0]?.headers.get("authorization")).toBe(`Bearer ${TEST_KEY}`);
    expect(calls[0]?.headers.get("accept")).toBe("application/json");
  });

  it("refuses redirects, keeping other fetch defaults", async () => {
    const { http, calls } = stubFetch(() => jsonResponse(200, customer));
    await Effect.runPromise(
      Customer.retrieve("cus_1").pipe(
        Effect.provide(StripePayments.layer(config())),
        Effect.provide(http),
        Effect.provideService(FetchHttpClient.RequestInit, { credentials: "omit" }),
      ),
    );
    expect(calls[0]?.init?.redirect).toBe("error");
    expect(calls[0]?.init?.credentials).toBe("omit");
  });

  it("sends the configured connected account", async () => {
    const { result, calls } = over(Customer.retrieve("cus_1"), () => jsonResponse(200, customer), {
      stripeAccount: "acct_config",
    });
    await result;
    expect(calls[0]?.headers.get("stripe-account")).toBe("acct_config");
  });

  it("refuses an empty connected account before sending anything", async () => {
    const { result, calls } = over(
      Effect.flip(Customer.retrieve("cus_1")),
      () => jsonResponse(200, customer),
      { stripeAccount: "" },
    );
    expect(await result).toBeInstanceOf(PaymentInvalidRequestError);
    expect(calls).toHaveLength(0);
  });

  /** Every operation that takes a path id, as the resource it names and the call for an id. */
  const pathIdCalls: ReadonlyArray<
    readonly [string, string, (id: string) => Effect.Effect<unknown, PaymentsError, Capabilities>]
  > = [
    ["Customer.retrieve", "customer", (id) => Customer.retrieve(id)],
    ["Customer.update", "customer", (id) => Customer.update(id, { name: "A" })],
    ["Customer.del", "customer", (id) => Customer.del(id)],
    ["Product.retrieve", "product", (id) => Product.retrieve(id)],
    ["Product.update", "product", (id) => Product.update(id, { active: false })],
    ["Product.del", "product", (id) => Product.del(id)],
    ["Price.retrieve", "price", (id) => Price.retrieve(id)],
    ["Price.update", "price", (id) => Price.update(id, { active: false })],
    ["PaymentIntent.retrieve", "payment intent", (id) => PaymentIntent.retrieve(id)],
    ["PaymentIntent.update", "payment intent", (id) => PaymentIntent.update(id, { amount: 1 })],
    ["PaymentIntent.confirm", "payment intent", (id) => PaymentIntent.confirm(id)],
    ["PaymentIntent.cancel", "payment intent", (id) => PaymentIntent.cancel(id)],
    ["Subscription.retrieve", "subscription", (id) => Subscription.retrieve(id)],
    [
      "Subscription.update",
      "subscription",
      (id) => Subscription.update(id, { cancelAtPeriodEnd: true }),
    ],
    ["Subscription.cancel", "subscription", (id) => Subscription.cancel(id)],
    ["Refund.retrieve", "refund", (id) => Refund.retrieve(id)],
    ["Refund.update", "refund", (id) => Refund.update(id, { metadata: { a: "b" } })],
  ];
  const badIds = pathIdCalls.flatMap(([name, resource, call]) =>
    (
      [
        ["an empty", ""],
        // SAFETY: `undefined` stands for an id from untyped code.
        ["an undefined", undefined as never],
      ] as const
    ).map(([label, id]) => [name, label, resource, call(id)] as const),
  );
  it.each(badIds)(
    "%s refuses %s id instead of addressing another endpoint",
    async (_, _id, resource, call) => {
      const { result, calls } = over(Effect.flip(call), () => jsonResponse(200, customer));
      const error = await result;
      expect(error).toBeInstanceOf(PaymentInvalidRequestError);
      expect(error).toMatchObject({ param: "id" });
      expect(error.message).toBe(`The ${resource} id must be a non-empty string`);
      expect(calls).toHaveLength(0);
    },
  );

  it("encodes an id as one path segment", async () => {
    const { result, calls } = over(Effect.exit(Customer.retrieve("cus/../1")), () =>
      jsonResponse(200, customer),
    );
    await result;
    expect(calls[0]?.url.pathname).toBe("/v1/customers/cus%2F..%2F1");
  });

  it("retries a 5xx, reusing one generated Idempotency-Key, then succeeds", async () => {
    const { result, calls } = over(Customer.create({ email: "a@example.com" }), (_r, attempt) =>
      attempt < 3
        ? jsonResponse(500, { error: { type: "api_error" } })
        : jsonResponse(200, customer),
    );
    expect((await result).id).toBe(customer.id);
    const keys = calls.map((call) => call.headers.get("idempotency-key"));
    expect(keys).toHaveLength(3);
    expect(keys[0]).toMatch(/^effect-payments-retry-/);
    expect(Arr.dedupe(keys)).toHaveLength(1);
  });

  it("gives up after maxNetworkRetries, failing with the last error", async () => {
    const { result, calls } = over(
      Effect.flip(Customer.create({ email: "a@example.com" })),
      () =>
        jsonResponse(409, { error: { type: "invalid_request_error", message: "Lock timeout" } }),
      { maxNetworkRetries: 1 },
    );
    const error = await result;
    expect(calls).toHaveLength(2);
    expect(error).toBeInstanceOf(PaymentInvalidRequestError);
    expect(error).toMatchObject({ statusCode: 409 });
  });

  it("defers to Stripe-Should-Retry", async () => {
    const never = over(Effect.flip(Customer.create({ email: "a@example.com" })), () =>
      jsonResponse(500, { error: { type: "api_error" } }, { "stripe-should-retry": "false" }),
    );
    await never.result;
    expect(never.calls).toHaveLength(1);

    const always = over(Customer.create({ email: "a@example.com" }), (_r, attempt) =>
      attempt === 1
        ? jsonResponse(
            400,
            { error: { type: "invalid_request_error", message: "retry me" } },
            { "stripe-should-retry": "true" },
          )
        : jsonResponse(200, customer),
    );
    await always.result;
    expect(always.calls).toHaveLength(2);
  });

  it("does not retry a 4xx", async () => {
    const { result, calls } = over(Effect.flip(Customer.retrieve("cus_x")), () =>
      jsonResponse(404, { error: { type: "invalid_request_error", message: "No such customer" } }),
    );
    expect(await result).toMatchObject({ _tag: "PaymentInvalidRequestError", statusCode: 404 });
    expect(calls).toHaveLength(1);
  });

  it("waits out Retry-After before retrying", async () => {
    const { result, calls } = over(Customer.retrieve("cus_1"), (_r, attempt) =>
      attempt === 1 ? jsonResponse(503, {}, { "retry-after": "3" }) : jsonResponse(200, customer),
    );
    await result;
    expect(calls).toHaveLength(2);
  });

  it("retries a connection failure, then reports it as PaymentNetworkError", async () => {
    const { result, calls } = over(Effect.flip(Customer.retrieve("cus_1")), () => {
      throw new TypeError("fetch failed");
    });
    const error = await result;
    expect(calls).toHaveLength(3);
    expect(error).toBeInstanceOf(PaymentNetworkError);
    expect(error.message).toContain("Request was retried 2 times");
  });

  it("times out a hung attempt as a network error", async () => {
    const { result } = over(
      Effect.flip(Customer.retrieve("cus_1")),
      (request) =>
        new Promise<Response>((_resolve, reject) => {
          request.init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
        }),
      { maxNetworkRetries: 0, timeout: 5_000 },
    );
    const error = await result;
    expect(error).toBeInstanceOf(PaymentNetworkError);
    expect(error.message).toContain("timed out after 5000 ms");
  });

  it("keeps lenient validation when the caller asks Distilled for strict", async () => {
    // A layer configured with an older API version than the one Distilled's
    // schemas describe (2025-08-27.basil, before DISTILLED_API_VERSION) gets
    // responses strict validation would refuse: this basil subscription lacks
    // fields Distilled marks required.
    const { http, calls } = stubFetch(() => jsonResponse(200, basilSubscription));
    const subscription = await Effect.runPromise(
      Subscription.retrieve(basilSubscription.id).pipe(
        Effect.provide(StripePayments.layer(config({ apiVersion: "2025-08-27.basil" }))),
        Effect.provide(http),
        Effect.provide(strictValidation),
      ),
    );
    expect(subscription.id).toBe(basilSubscription.id);
    expect(calls[0]?.headers.get("stripe-version")).toBe("2025-08-27.basil");
  });
});

describe("StripePayments maps every Distilled failure onto the neutral channel", () => {
  it("InvalidRequestError → PaymentInvalidRequestError with the param", async () => {
    const error = await failure(400, {
      error: {
        type: "invalid_request_error",
        code: "parameter_invalid_empty",
        message: "You passed an empty string for 'email'.",
        param: "email",
        doc_url: null,
      },
    });
    expect(error).toBeInstanceOf(PaymentInvalidRequestError);
    expect(error).toMatchObject({
      message: "You passed an empty string for 'email'.",
      param: "email",
      statusCode: 400,
    });
  });

  it("CardError → PaymentProviderError with Stripe's code and the whole vendor error", async () => {
    const vendor = {
      type: "card_error",
      code: "card_declined",
      decline_code: "insufficient_funds",
      message: "Your card has insufficient funds.",
      payment_intent: { id: "pi_1", status: "requires_payment_method" },
    };
    const error = await failure(402, { error: vendor });
    expect(error).toBeInstanceOf(PaymentProviderError);
    expect(error).toMatchObject({
      code: "card_declined",
      statusCode: 402,
      provider: "stripe",
      message: "Your card has insufficient funds.",
    });
    expect(error).toHaveProperty("cause", vendor);
  });

  it("IdempotencyError → PaymentProviderError coded as the SDK's error kind", async () => {
    const error = await failure(400, {
      error: { type: "idempotency_error", message: "Keys can only be reused with the same body" },
    });
    expect(error).toBeInstanceOf(PaymentProviderError);
    expect(error).toMatchObject({ code: "StripeIdempotencyError", statusCode: 400 });
  });

  it("ApiError → PaymentProviderError", async () => {
    const error = await failure(500, { error: { type: "api_error", message: "Something broke" } });
    expect(error).toBeInstanceOf(PaymentProviderError);
    expect(error).toMatchObject({
      code: "StripeAPIError",
      message: "Something broke",
      statusCode: 500,
    });
  });

  it("PaymentError (a 402 of no known type) → PaymentProviderError", async () => {
    const error = await failure(402, {
      error: { type: "payment_error", code: "payment_failed", message: "Payment failed" },
    });
    expect(error).toBeInstanceOf(PaymentProviderError);
    expect(error).toMatchObject({ code: "payment_failed", statusCode: 402 });
  });

  it("ExternalDependencyFailed (a 424) → PaymentProviderError", async () => {
    const error = await failure(424, {
      error: { type: "external_dependency_error", message: "Upstream failed" },
    });
    expect(error).toBeInstanceOf(PaymentProviderError);
    expect(error).toMatchObject({ code: "StripeUnknownError", statusCode: 424 });
  });

  it("UnknownStripeError (no error envelope) → PaymentProviderError from the status", async () => {
    const error = await failure(503, "<html>gateway</html>");
    expect(error).toBeInstanceOf(PaymentProviderError);
    expect(error.message).toContain("503");
    expect(error).toMatchObject({ statusCode: 503, code: "StripeAPIError" });
  });

  it.each(["authentication_error", "invalid_request_error"])(
    "Unauthorized → PaymentAuthenticationError, whatever the body's type (%s)",
    async (type) => {
      const error = await failure(401, {
        error: { type, message: "Invalid API Key provided: sk_test_****4242" },
      });
      expect(error).toBeInstanceOf(PaymentAuthenticationError);
      expect(error).toMatchObject({ statusCode: 401 });
    },
  );

  it("Forbidden → PaymentProviderError coded as a permission error", async () => {
    const error = await failure(403, {
      error: { type: "invalid_request_error", message: "The provided key does not have access" },
    });
    expect(error).toBeInstanceOf(PaymentProviderError);
    expect(error).toMatchObject({ code: "StripePermissionError", statusCode: 403 });
  });

  it("TooManyRequests → PaymentRateLimitError with Retry-After", async () => {
    const error = await failure(
      429,
      { error: { type: "rate_limit_error", message: "Too many requests" } },
      { "retry-after": "7" },
    );
    expect(error).toBeInstanceOf(PaymentRateLimitError);
    expect(error).toMatchObject({ message: "Too many requests", retryAfter: 7 });
  });

  it("NotFound → PaymentInvalidRequestError (Stripe's resource_missing)", async () => {
    const error = await failure(404, {
      error: {
        type: "invalid_request_error",
        code: "resource_missing",
        message: "No such customer",
      },
    });
    expect(error).toBeInstanceOf(PaymentInvalidRequestError);
    expect(error).toMatchObject({ statusCode: 404 });
  });

  it("an operation's own error class (ProductHasPrices) → PaymentInvalidRequestError", async () => {
    const { result } = over(Effect.flip(Product.del("prod_1")), () =>
      jsonResponse(400, {
        error: {
          type: "invalid_request_error",
          message: "This product cannot be deleted because it has one or more user-created prices.",
        },
      }),
    );
    const error = await result;
    expect(error).toBeInstanceOf(PaymentInvalidRequestError);
    expect(error.message).toContain("user-created prices");
  });

  it("a 2xx whose body is not JSON → PaymentProviderError", async () => {
    const error = await failure(200, "not json");
    expect(error).toBeInstanceOf(PaymentProviderError);
    expect(error.message).toBe("Invalid JSON received from the Stripe API");
  });

  it("never carries the key in an error, at any depth", async () => {
    const auth = await failure(401, {
      error: { type: "authentication_error", message: "Invalid API Key" },
    });
    const card = await failure(402, {
      error: { type: "card_error", code: "card_declined", message: "Your card was declined." },
    });
    const network = await over(
      Effect.flip(Customer.retrieve("cus_1")),
      () => {
        throw new TypeError("fetch failed");
      },
      { maxNetworkRetries: 0 },
    ).result;
    const timeout = await over(
      Effect.flip(Customer.retrieve("cus_1")),
      (request) =>
        new Promise<Response>((_resolve, reject) => {
          request.init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
        }),
      { maxNetworkRetries: 0, timeout: 5_000 },
    ).result;
    expect(network).toBeInstanceOf(PaymentNetworkError);
    expect(timeout).toBeInstanceOf(PaymentNetworkError);
    Arr.forEach([auth, card, network, timeout], (error) => {
      // `JSON.stringify` (which `toJson` runs) and `String` go through
      // Effect's `Headers` redaction, so they would miss a request kept
      // anywhere in the error; walk every value it holds instead.
      const reachable = reachableFrom(error);
      expect(reachable.strings.filter((value) => value.includes(TEST_KEY))).toEqual([]);
      expect(reachable.objects.filter(HttpClientError.isHttpClientError)).toEqual([]);
      expect(reachable.objects.filter(HttpClientRequest.isHttpClientRequest)).toEqual([]);
      expect(toJson(error)).not.toContain(TEST_KEY);
      expect(String(error)).not.toContain(TEST_KEY);
    });
  });
});

describe("StripePayments configuration", () => {
  it("fails an empty key with PaymentConfigError", async () => {
    const error = await Effect.runPromise(
      Effect.flip(
        Layer.build(StripePayments.layer(config({ apiKey: Redacted.make("") }))).pipe(
          Effect.scoped,
          Effect.provide(stubFetch(() => jsonResponse(200, {})).http),
        ),
      ),
    );
    expect(error).toBeInstanceOf(PaymentConfigError);
  });

  it("reads the key for layerFromEnv while the layer is built", async () => {
    const { http, calls } = stubFetch(() => jsonResponse(200, customer));
    const withKey = (values: Record<string, string>) =>
      Effect.provide(ConfigProvider.layer(ConfigProvider.fromUnknown(values)));
    await Effect.runPromise(
      Customer.retrieve("cus_1").pipe(
        Effect.provide(StripePayments.layerFromEnv("BILLING_KEY")),
        Effect.provide(http),
        withKey({ BILLING_KEY: TEST_KEY }),
      ),
    );
    expect(calls[0]?.headers.get("authorization")).toBe(`Bearer ${TEST_KEY}`);
    const errors = await Effect.runPromise(
      Effect.forEach(
        [{}, { STRIPE_API_KEY: "" }],
        (values) =>
          Effect.flip(
            Customer.retrieve("cus_1").pipe(
              Effect.provide(StripePayments.layerFromEnv()),
              Effect.provide(http),
              withKey(values),
            ),
          ),
        { concurrency: 1 },
      ),
    );
    expect(errors).toHaveLength(2);
    Arr.forEach(errors, (error) => {
      expect(error).toBeInstanceOf(PaymentConfigError);
      expect(error.message).toBe("Environment variable STRIPE_API_KEY is not set");
    });
  });

  it("maps an unreadable key variable for layerFromEnv to PaymentConfigError", async () => {
    const error = await Effect.runPromise(
      Effect.flip(
        Customer.retrieve("cus_1").pipe(
          Effect.provide(StripePayments.layerFromEnv()),
          Effect.provide(stubFetch(() => jsonResponse(200, customer)).http),
          Effect.provide(
            ConfigProvider.layer(ConfigProvider.fromUnknown({ STRIPE_API_KEY: { nested: true } })),
          ),
        ),
      ),
    );
    expect(error).toBeInstanceOf(PaymentConfigError);
  });
});
