import { describe, it, expect } from "vite-plus/test";
import * as Arr from "effect/Array";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import { HttpClient, HttpClientError, HttpClientRequest } from "effect/http";
import { TestClock } from "effect/testing";
import { strict as strictValidation } from "@distilled.cloud/core/response-validation";
import { ConfigError } from "@distilled.cloud/paypal/Errors";
import { Credentials } from "@distilled.cloud/paypal/Credentials";
import { Retry } from "@distilled.cloud/paypal/Retry";
import { getProduct } from "@distilled.cloud/paypal/catalogs_products_v1";
import * as IdempotencyKey from "@thomasfosterau/effect-biz/Payments.IdempotencyKey";
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
import * as PayPalPayments from "../src/PayPalPayments.ts";
import type { PayPalConfig } from "../src/PayPalPayments.ts";
import { send } from "../src/internal/auth.ts";
import { errorBodyOf, handlePayPalError } from "../src/internal/error.ts";
import {
  type CapturedRequest,
  callOf,
  capabilitiesOver,
  jsonResponse,
  reachableFrom,
  stubFetch,
  stubPayPal,
  TEST_TOKEN,
  toJson,
  withTestClock,
} from "./support.ts";

/**
 * `PayPalPayments` on Distilled's operations (effect-finance#146): what reaches the wire,
 * where the access token comes from, and how each failure Distilled reports
 * lands on the neutral channel. The expectations are those of the
 * hand-written `PayPalClient` the capability layers ran on before (removed in
 * effect-finance#146; its session cases are in `PayPalPayments.session.test.ts`).
 */

type Capabilities = Layer.Success<typeof PayPalPayments.capabilities>;

const CLIENT_SECRET = "client_secret_not_a_real_one";
const config = (over: Partial<PayPalConfig> = {}): PayPalConfig => ({
  clientId: "client_1",
  clientSecret: Redacted.make(CLIENT_SECRET),
  ...over,
});

/** The access tokens the stubbed login hands out: `${TOKEN}1`, `${TOKEN}2`, … */
const TOKEN = "A21AA_access_token_not_real_";

const LIVE = "https://api-m.paypal.com";
const SANDBOX = "https://api-m.sandbox.paypal.com";
const LOGIN_PATH = "/v1/oauth2/token";

const PRODUCT = { id: "PROD-1", name: "Premium", create_time: "2026-01-01T00:00:00Z" };
const PLAN = {
  id: "P-1",
  product_id: "PROD-1",
  status: "ACTIVE",
  billing_cycles: [
    {
      tenure_type: "REGULAR",
      sequence: 1,
      frequency: { interval_unit: "MONTH", interval_count: 1 },
      pricing_scheme: { fixed_price: { currency_code: "USD", value: "10.00" } },
    },
  ],
};
const ORDER = {
  id: "ORD-1",
  status: "CREATED",
  purchase_units: [{ amount: { currency_code: "USD", value: "1.00" } }],
};

/**
 * A stubbed PayPal behind the OAuth login: the token endpoint answers with
 * `login(attempt)` (by default `${TOKEN}<n>` for the n-th login, for an hour), and
 * every other request with `answer`.
 */
const paypal = (
  answer: (request: CapturedRequest) => Response | Promise<Response>,
  login: (attempt: number) => Response = (attempt) =>
    jsonResponse(200, { access_token: `${TOKEN}${attempt}`, expires_in: 3600 }),
) => {
  let logins = 0;
  const stub = stubFetch((request) => {
    if (request.url.pathname === LOGIN_PATH) return login((logins += 1));
    return answer(request);
  });
  const resources = () => stub.calls.filter((request) => request.url.pathname !== LOGIN_PATH);
  const loginRequests = () => stub.calls.filter((request) => request.url.pathname === LOGIN_PATH);
  return { ...stub, resources, loginRequests };
};

/** `effect` over `PayPalPayments.layer(config(over))` and `http`. */
const provided = <A, E>(
  effect: Effect.Effect<A, E, Capabilities>,
  http: Layer.Layer<HttpClient.HttpClient>,
  over: Partial<PayPalConfig> = {},
): Effect.Effect<A, E | PaymentConfigError> =>
  effect.pipe(Effect.provide(PayPalPayments.layer(config(over))), Effect.provide(http));

/** Run `effect` over `PayPalPayments.layer(config(over))` and `http`. */
const run = <A, E>(
  effect: Effect.Effect<A, E, Capabilities>,
  http: Layer.Layer<HttpClient.HttpClient>,
  over: Partial<PayPalConfig> = {},
): Promise<A> => Effect.runPromise(provided(effect, http, over));

describe("PayPalPayments authentication", () => {
  it("logs in with the client credentials and sends the cached token on every call", async () => {
    const api = paypal(() => jsonResponse(200, PRODUCT));
    await run(
      Effect.gen(function* () {
        yield* Product.retrieve("PROD-1");
        yield* Product.retrieve("PROD-1");
      }),
      api.http,
    );
    const [login] = api.loginRequests();
    expect(api.loginRequests()).toHaveLength(1);
    expect(login?.url.origin).toBe(LIVE);
    expect(login?.method).toBe("POST");
    expect(login?.headers.get("authorization")).toBe(`Basic ${btoa(`client_1:${CLIENT_SECRET}`)}`);
    expect(login?.body).toBe("grant_type=client_credentials");
    expect(api.resources().map((request) => request.headers.get("authorization"))).toEqual([
      `Bearer ${TOKEN}1`,
      `Bearer ${TOKEN}1`,
    ]);
  });

  it("logs in once for concurrent first calls", async () => {
    const api = paypal(() => jsonResponse(200, PRODUCT));
    await run(
      Effect.all([Product.retrieve("PROD-1"), Product.retrieve("PROD-2")], {
        concurrency: "unbounded",
      }),
      api.http,
    );
    expect(api.loginRequests()).toHaveLength(1);
  });

  it("refreshes the token a minute before it expires", async () => {
    const api = paypal(
      () => jsonResponse(200, PRODUCT),
      (attempt) => jsonResponse(200, { access_token: `${TOKEN}${attempt}`, expires_in: 120 }),
    );
    await Effect.runPromise(
      Effect.gen(function* () {
        yield* Product.retrieve("PROD-1");
        // 59 s on, the token has 61 s left: still used.
        yield* TestClock.adjust("59 seconds");
        yield* Product.retrieve("PROD-1");
        // 2 s more and it is inside the minute's margin: refreshed.
        yield* TestClock.adjust("2 seconds");
        yield* Product.retrieve("PROD-1");
      }).pipe(
        Effect.provide(PayPalPayments.layer(config())),
        Effect.provide(api.http),
        Effect.provide(TestClock.layer()),
      ),
    );
    expect(api.resources().map((request) => request.headers.get("authorization"))).toEqual([
      `Bearer ${TOKEN}1`,
      `Bearer ${TOKEN}1`,
      `Bearer ${TOKEN}2`,
    ]);
  });

  it("forgets the token after a 401 and logs in again on the next call", async () => {
    let calls = 0;
    const api = paypal(() =>
      (calls += 1) === 1
        ? jsonResponse(401, { name: "AUTHENTICATION_FAILURE", message: "Token revoked" })
        : jsonResponse(200, PRODUCT),
    );
    const [first, second] = await run(
      Effect.all([Effect.flip(Product.retrieve("PROD-1")), Product.retrieve("PROD-1")]),
      api.http,
    );
    expect(first).toBeInstanceOf(PaymentAuthenticationError);
    expect(first).toMatchObject({ message: "Token revoked", statusCode: 401 });
    expect(second.id).toBe("PROD-1");
    expect(api.resources().map((request) => request.headers.get("authorization"))).toEqual([
      `Bearer ${TOKEN}1`,
      `Bearer ${TOKEN}2`,
    ]);
  });

  it("keeps a token that a 403 refused: only a 401 means the token is bad", async () => {
    const api = paypal(() => jsonResponse(403, { name: "NOT_AUTHORIZED", message: "No scope" }));
    await run(
      Effect.all([
        Effect.flip(Product.retrieve("PROD-1")),
        Effect.flip(Product.retrieve("PROD-1")),
      ]),
      api.http,
    );
    expect(api.loginRequests()).toHaveLength(1);
  });

  it("fails every call with the login's error when PayPal refuses the credentials", async () => {
    const api = paypal(
      () => jsonResponse(200, PRODUCT),
      () => jsonResponse(401, { name: "invalid_client", message: "Client Authentication failed" }),
    );
    const error = await run(Effect.flip(Product.retrieve("PROD-1")), api.http);
    expect(error).toBeInstanceOf(PaymentAuthenticationError);
    expect(error.message).toBe("Client Authentication failed");
    expect(api.resources()).toEqual([]);
  });

  it("sends the credentials' token as it is over Distilled's Credentials in context", async () => {
    const stub = stubPayPal(() => PRODUCT);
    await Effect.runPromise(
      Product.retrieve("PROD-1").pipe(Effect.provide(capabilitiesOver(stub.layer))),
    );
    expect(stub.calls.map((call) => call.headers.get("authorization"))).toEqual([
      `Bearer ${TEST_TOKEN}`,
    ]);
  });
});

describe("PayPalPayments endpoints", () => {
  /** The origins one call through `layer` reached: the login's, then the resource's. */
  const originsOf = async (
    layer: Layer.Layer<Capabilities, PaymentConfigError, HttpClient.HttpClient>,
  ) => {
    const api = paypal(() => jsonResponse(200, PRODUCT));
    await Effect.runPromise(
      Product.retrieve("PROD-1").pipe(Effect.provide(layer), Effect.provide(api.http)),
    );
    return api.calls.map((request) => `${request.url.origin}${request.url.pathname}`);
  };
  const fromEnv = (values: Record<string, string>) =>
    PayPalPayments.layerFromEnv().pipe(
      Layer.provide(
        ConfigProvider.layer(
          ConfigProvider.fromUnknown({
            PAYPAL_CLIENT_ID: "client_1",
            PAYPAL_CLIENT_SECRET: CLIENT_SECRET,
            ...values,
          }),
        ),
      ),
    );

  it.each([
    ["live", LIVE],
    ["sandbox", SANDBOX],
  ])("PAYPAL_ENV=%s logs in and calls at %s", async (environment, origin) => {
    expect(await originsOf(fromEnv({ PAYPAL_ENV: environment }))).toEqual([
      `${origin}${LOGIN_PATH}`,
      `${origin}/v1/catalogs/products/PROD-1`,
    ]);
  });

  it("PAYPAL_BASE_URL overrides the PAYPAL_ENV endpoint for the login and the call", async () => {
    expect(
      await originsOf(fromEnv({ PAYPAL_ENV: "live", PAYPAL_BASE_URL: "http://localhost:4010" })),
    ).toEqual([
      `http://localhost:4010${LOGIN_PATH}`,
      "http://localhost:4010/v1/catalogs/products/PROD-1",
    ]);
  });

  it("an empty PAYPAL_BASE_URL selects the PAYPAL_ENV endpoint", async () => {
    expect(await originsOf(fromEnv({ PAYPAL_ENV: "sandbox", PAYPAL_BASE_URL: "" }))).toEqual([
      `${SANDBOX}${LOGIN_PATH}`,
      `${SANDBOX}/v1/catalogs/products/PROD-1`,
    ]);
  });

  it("layer selects the environment's endpoint, live by default, with baseUrl winning", async () => {
    const layerAt = (over: Partial<PayPalConfig>) => PayPalPayments.layer(config(over));
    expect(await originsOf(layerAt({}))).toContain(`${LIVE}/v1/catalogs/products/PROD-1`);
    expect(await originsOf(layerAt({ environment: "sandbox" }))).toContain(
      `${SANDBOX}/v1/catalogs/products/PROD-1`,
    );
    expect(
      await originsOf(layerAt({ environment: "sandbox", baseUrl: "https://proxy.example" })),
    ).toContain("https://proxy.example/v1/catalogs/products/PROD-1");
  });

  it("fails with PaymentConfigError, sending nothing, when PAYPAL_ENV is missing or misspelt", async () => {
    await Effect.runPromise(
      Effect.forEach(
        [{}, { PAYPAL_ENV: "production" }, { PAYPAL_ENV: "" }],
        (values) => {
          const api = paypal(() => jsonResponse(200, PRODUCT));
          return Effect.flip(
            Product.retrieve("PROD-1").pipe(
              Effect.provide(fromEnv(values)),
              Effect.provide(api.http),
            ),
          ).pipe(
            Effect.map((error) => {
              expect(error).toBeInstanceOf(PaymentConfigError);
              expect(error.message).toContain("PAYPAL_ENV");
              expect(api.calls).toEqual([]);
            }),
          );
        },
        { concurrency: 1, discard: true },
      ),
    );
  });

  it("refuses a missing secret, a relative baseUrl and a zero timeout with PaymentConfigError", async () => {
    await Effect.runPromise(
      Effect.forEach(
        [
          { clientSecret: Redacted.make("") },
          { baseUrl: "/v1" },
          { timeout: 0 },
          { loginTimeout: Number.NaN },
        ],
        (over) => {
          const api = paypal(() => jsonResponse(200, PRODUCT));
          return Effect.flip(provided(Product.retrieve("PROD-1"), api.http, over)).pipe(
            Effect.map((error) => {
              expect(error).toBeInstanceOf(PaymentConfigError);
              expect(api.calls).toEqual([]);
            }),
          );
        },
        { concurrency: 1, discard: true },
      ),
    );
  });
});

describe("PayPalPayments requests", () => {
  const KEY = IdempotencyKey.IdempotencyKey.make("write-0001");

  /** Every request `effect` made through `layer(config())`, answered from `answers` by path. */
  const requestsOf = <A, E>(
    effect: Effect.Effect<A, E, Capabilities>,
    answer?: (path: string) => unknown,
  ) =>
    Effect.suspend(() => {
      const api = paypal((request) =>
        jsonResponse(200, answer === undefined ? {} : answer(request.url.pathname)),
      );
      return Effect.exit(provided(effect, api.http)).pipe(
        Effect.map(() => api.resources().map(callOf)),
      );
    });

  /** {@link requestsOf}, run. */
  const sent = <A, E>(
    effect: Effect.Effect<A, E, Capabilities>,
    answer?: (path: string) => unknown,
  ) => Effect.runPromise(requestsOf(effect, answer));

  it("sends the key as PayPal-Request-Id on each write, and none without one", async () => {
    const writes: ReadonlyArray<
      readonly [
        string,
        (
          key: IdempotencyKey.IdempotencyKey | undefined,
        ) => Effect.Effect<unknown, unknown, Capabilities>,
      ]
    > = [
      ["/v1/catalogs/products", (idempotencyKey) => Product.create({ name: "P", idempotencyKey })],
      [
        "/v1/billing/plans",
        (idempotencyKey) =>
          Price.create({
            product: "PROD-1",
            currency: "usd",
            unitAmount: 100,
            recurring: { interval: "month" },
            idempotencyKey,
          }),
      ],
      [
        "/v2/checkout/orders",
        (idempotencyKey) => PaymentIntent.create({ amount: 100, currency: "usd", idempotencyKey }),
      ],
      [
        "/v2/checkout/orders/ORD-1/capture",
        (idempotencyKey) => PaymentIntent.confirm("ORD-1", { idempotencyKey }),
      ],
      [
        "/v1/billing/subscriptions",
        (idempotencyKey) =>
          Subscription.create({ customer: "cus_1", items: [{ price: "P-1" }], idempotencyKey }),
      ],
      [
        "/v2/payments/captures/CAP-1/refund",
        (idempotencyKey) => Refund.create({ charge: "CAP-1", idempotencyKey }),
      ],
    ];
    await Effect.runPromise(
      Effect.forEach(
        writes,
        ([path, write]) =>
          requestsOf(write(KEY)).pipe(
            Effect.map((keyed) =>
              expect(keyed.map((call) => [call.method, call.path, call.requestId])).toEqual([
                ["POST", path, KEY],
              ]),
            ),
            Effect.andThen(requestsOf(write(undefined))),
            Effect.map((unkeyed) =>
              expect(unkeyed.map((call) => [call.path, call.requestId])).toEqual([
                [path, undefined],
              ]),
            ),
          ),
        { concurrency: 1, discard: true },
      ),
    );
  });

  it("sends no PayPal-Request-Id on a lookup, a cancel or an activate", async () => {
    const calls = [
      ...(await sent(
        Refund.create({ paymentIntent: "ORD-1", amount: 50, idempotencyKey: KEY }),
        (path) =>
          path.startsWith("/v2/checkout/orders/")
            ? {
                id: "ORD-1",
                status: "COMPLETED",
                purchase_units: [{ payments: { captures: [{ id: "CAP-2" }] } }],
              }
            : { id: "CAP-2", amount: { currency_code: "USD", value: "1.00" } },
      )),
      ...(await sent(Subscription.cancel("SUB-1"))),
      ...(await sent(Price.update("P-1", { active: true }))),
    ];
    expect(calls.map((call) => [call.method, call.path, call.requestId])).toEqual([
      ["GET", "/v2/checkout/orders/ORD-1", undefined],
      ["GET", "/v2/payments/captures/CAP-2", undefined],
      ["POST", "/v2/payments/captures/CAP-2/refund", KEY],
      ["POST", "/v1/billing/subscriptions/SUB-1/cancel", undefined],
      ["GET", "/v1/billing/subscriptions/SUB-1", undefined],
      ["POST", "/v1/billing/plans/P-1/activate", undefined],
      ["GET", "/v1/billing/plans/P-1", undefined],
    ]);
  });

  it("sends Content-Type and Accept: application/json on every request, a bodyless POST included", async () => {
    const calls = [
      ...(await sent(Price.update("P-1", { active: false }), () => PLAN)),
      ...(await sent(PaymentIntent.create({ amount: 100, currency: "usd" }), () => ORDER)),
    ];
    expect(calls.map((call) => [call.method, call.path, call.body])).toEqual([
      ["POST", "/v1/billing/plans/P-1/deactivate", undefined],
      ["GET", "/v1/billing/plans/P-1", undefined],
      [
        "POST",
        "/v2/checkout/orders",
        {
          intent: "CAPTURE",
          purchase_units: [{ amount: { currency_code: "USD", value: "1.00" } }],
        },
      ],
    ]);
    Arr.forEach(calls, (call) => {
      expect(call.headers.get("content-type")).toBe("application/json");
      expect(call.headers.get("accept")).toBe("application/json");
    });
  });

  it("sends the request bodies and queries the capabilities always sent", async () => {
    const calls = [
      ...(await sent(Product.update("PROD-1", { description: "New" }), () => PRODUCT)),
      ...(await sent(Product.list({ limit: 5 }), () => ({ products: [] }))),
      ...(await sent(Price.list({ limit: 2, product: "PROD-1" }), () => ({ plans: [] }))),
      ...(await sent(PaymentIntent.confirm("ORD-1"), () => ORDER)),
      ...(await sent(Subscription.cancel("SUB-1"))),
      ...(await sent(Refund.create({ charge: "CAP-1" }))),
    ];
    expect(calls.map((call) => [call.method, call.path, call.query, call.body])).toEqual([
      [
        "PATCH",
        "/v1/catalogs/products/PROD-1",
        {},
        [{ op: "replace", path: "/description", value: "New" }],
      ],
      ["GET", "/v1/catalogs/products/PROD-1", {}, undefined],
      ["GET", "/v1/catalogs/products", { page_size: "5" }, undefined],
      ["GET", "/v1/billing/plans", { page_size: "2", product_id: "PROD-1" }, undefined],
      ["POST", "/v2/checkout/orders/ORD-1/capture", {}, {}],
      [
        "POST",
        "/v1/billing/subscriptions/SUB-1/cancel",
        {},
        { reason: "Canceled via effect-payments" },
      ],
      ["GET", "/v1/billing/subscriptions/SUB-1", {}, undefined],
      ["POST", "/v2/payments/captures/CAP-1/refund", {}, {}],
    ]);
  });

  it("refuses an empty id before sending anything", async () => {
    await Effect.runPromise(
      Effect.forEach(
        [
          Product.retrieve(""),
          Price.update("", { active: true }),
          PaymentIntent.confirm(""),
          Subscription.cancel(""),
          Refund.retrieve(""),
        ],
        (operation) => {
          const api = paypal(() => jsonResponse(200, {}));
          return provided(
            Effect.flip(operation as Effect.Effect<unknown, PaymentsError, Capabilities>),
            api.http,
          ).pipe(
            Effect.map((error) => {
              expect(error).toBeInstanceOf(PaymentInvalidRequestError);
              expect(error).toMatchObject({ param: "id" });
              expect(api.calls).toEqual([]);
            }),
          );
        },
        { concurrency: 1, discard: true },
      ),
    );
  });

  it("refuses a subscription without an item before sending anything", async () => {
    const api = paypal(() => jsonResponse(200, {}));
    const error = await run(
      Effect.flip(Subscription.create({ customer: "cus_1", items: [] })),
      api.http,
    );
    expect(error).toBeInstanceOf(PaymentInvalidRequestError);
    expect(error).toMatchObject({ param: "items" });
    expect(api.calls).toEqual([]);
  });

  it("never retries a request itself", async () => {
    const api = paypal(() => jsonResponse(503, { name: "SERVICE_UNAVAILABLE", message: "Down" }));
    const error = await run(
      Effect.flip(PaymentIntent.create({ amount: 100, currency: "usd" })),
      api.http,
    );
    expect(error).toBeInstanceOf(PaymentProviderError);
    expect(api.resources()).toHaveLength(1);
  });

  it("decodes only the fields it maps, even under Distilled's strict validation", async () => {
    // A plan without the `sequence` Distilled's schema requires of a billing cycle.
    const { sequence: _, ...cycle } = PLAN.billing_cycles[0];
    const api = paypal(() => jsonResponse(200, { ...PLAN, billing_cycles: [cycle] }));
    const price = await run(Price.retrieve("P-1").pipe(Effect.provide(strictValidation)), api.http);
    expect(price.unitAmount).toBe(1000);
  });
});

describe("PayPalPayments errors", () => {
  /**
   * The error `response` maps onto read directly, without Distilled: sent
   * and read by the session's `send`, a non-2xx classified from its status
   * and error body. This is the mapping the hand-written `PayPalClient`
   * applied, which the capabilities ran on before effect-finance#146.
   */
  const viaSession = (response: () => Response | Promise<Response>) =>
    Effect.runPromise(
      Effect.flip(
        Effect.gen(function* () {
          const http = yield* HttpClient.HttpClient;
          const reply = yield* send(
            http,
            HttpClientRequest.get(`${LIVE}/v1/catalogs/products/PROD-1`),
            Duration.infinity,
            "request",
          );
          return yield* handlePayPalError(
            reply.status,
            errorBodyOf(reply.json),
            reply.headers["retry-after"],
          );
        }).pipe(Effect.provide(paypal(response).http)),
      ),
    );
  /** The error `Product.retrieve` fails with on `response`. */
  const viaCapability = (response: () => Response | Promise<Response>) =>
    run(Effect.flip(Product.retrieve("PROD-1")), paypal(response).http);
  /** The tag Distilled's own `getProduct` fails with on `response`. */
  const viaDistilled = (response: () => Response) =>
    Effect.runPromise(
      Effect.flip(getProduct({ product_id: "PROD-1" })).pipe(
        Effect.provideService(Retry, { while: () => false }),
        Effect.provide(stubPayPal(response).layer),
        Effect.map((error) => error._tag),
      ),
    );

  /** A neutral error's class and fields, for comparison. */
  // `Object.assign`, not a spread: a tagged error is iterable (yieldable),
  // and only its own enumerable fields are wanted here.
  const fieldsOf = (error: PaymentsError | PaymentConfigError) =>
    Object.assign({ constructor: error.constructor }, error);

  const body = (name: string, message: string, details?: unknown) =>
    details === undefined
      ? { name, message, debug_id: "d1" }
      : { name, message, debug_id: "d1", details };

  it.each([
    [
      400,
      body("INVALID_REQUEST", "Bad", [{ field: "/name", issue: "MISSING" }]),
      "BadRequest",
      PaymentInvalidRequestError,
    ],
    [401, body("AUTHENTICATION_FAILURE", "Expired"), "Unauthorized", PaymentAuthenticationError],
    [403, body("NOT_AUTHORIZED", "No scope"), "Forbidden", PaymentAuthenticationError],
    [404, body("RESOURCE_NOT_FOUND", "Missing"), "NotFound", PaymentInvalidRequestError],
    [409, body("CONFLICT", "Busy"), "Conflict", PaymentProviderError],
    [415, body("UNSUPPORTED_MEDIA_TYPE", "No"), "UnknownPaypalError", PaymentProviderError],
    [
      422,
      body("UNPROCESSABLE_ENTITY", "Nope", [{ issue: "DUPLICATE" }]),
      "UnprocessableEntity",
      PaymentInvalidRequestError,
    ],
    [423, body("LOCKED", "Locked"), "Locked", PaymentProviderError],
    [429, body("RATE_LIMIT_REACHED", "Slow down"), "TooManyRequests", PaymentRateLimitError],
    [500, body("INTERNAL_SERVER_ERROR", "Oops"), "InternalServerError", PaymentProviderError],
    [502, body("BAD_GATEWAY", "Gateway"), "BadGateway", PaymentProviderError],
    [503, body("SERVICE_UNAVAILABLE", "Down"), "ServiceUnavailable", PaymentProviderError],
    [504, body("GATEWAY_TIMEOUT", "Slow"), "GatewayTimeout", PaymentProviderError],
    [507, body("INSUFFICIENT_STORAGE", "Full"), "InternalServerError", PaymentProviderError],
    [418, { message: 7, details: "not an array" }, "UnknownPaypalError", PaymentProviderError],
  ] as const)(
    "a %i (Distilled: %#) maps as PayPalClient mapped it",
    async (status, payload, tag, neutral) => {
      const response = () => jsonResponse(status, payload);
      expect(await viaDistilled(response)).toBe(tag);
      const capability = await viaCapability(response);
      expect(capability).toBeInstanceOf(neutral);
      expect(fieldsOf(capability)).toEqual(fieldsOf(await viaSession(response)));
    },
  );

  it("maps the status, param and code as PayPalClient did", async () => {
    const bad = await viaCapability(() =>
      jsonResponse(400, body("INVALID_REQUEST", "Bad", [{ field: "/name", issue: "MISSING" }])),
    );
    expect(bad).toMatchObject({ message: "Bad", param: "/name", statusCode: 400 });
    const down = await viaCapability(() => jsonResponse(503, body("SERVICE_UNAVAILABLE", "Down")));
    expect(down).toMatchObject({
      provider: "paypal",
      code: "SERVICE_UNAVAILABLE",
      statusCode: 503,
    });
    const limited = await viaCapability(() =>
      jsonResponse(429, body("RATE_LIMIT_REACHED", "Slow down")),
    );
    expect(limited).toMatchObject({ message: "Slow down", retryAfter: undefined });
  });

  it("carries a 429's Retry-After, in whole seconds, as the session reads it", async () => {
    const response = () =>
      jsonResponse(429, body("RATE_LIMIT_REACHED", "Slow down"), { "Retry-After": "30" });
    const capability = await viaCapability(response);
    expect(capability).toBeInstanceOf(PaymentRateLimitError);
    expect(capability).toMatchObject({ message: "Slow down", retryAfter: 30 });
    expect(fieldsOf(capability)).toEqual(fieldsOf(await viaSession(response)));
  });

  it("a non-JSON error body maps as PayPalClient mapped it", async () => {
    const response = () => new Response("<html>Bad Gateway</html>", { status: 502 });
    const capability = await viaCapability(response);
    expect(capability).toBeInstanceOf(PaymentProviderError);
    expect(capability.message).toBe("PayPal request failed with status 502");
    expect(fieldsOf(capability)).toEqual(fieldsOf(await viaSession(response)));
  });

  it("a 2xx whose body is not JSON fails to decode, as PayPalClient's {} did", async () => {
    const error = await viaCapability(() => new Response("not json", { status: 200 }));
    expect(error).toBeInstanceOf(PaymentProviderError);
    expect(error.message).toBe("PayPal returned a malformed product response");
  });

  it("a 204 to a patch or an activate succeeds, and the read-back maps", async () => {
    const api = paypal((request) =>
      request.method === "GET" ? jsonResponse(200, PLAN) : new Response(null, { status: 204 }),
    );
    const price = await run(Price.update("P-1", { active: true }), api.http);
    expect(price.id).toBe("P-1");
  });

  it("a connection failure is a PaymentNetworkError, as PayPalClient reported it", async () => {
    const response = () => {
      throw new TypeError("fetch failed");
    };
    const capability = await viaCapability(response);
    expect(capability).toBeInstanceOf(PaymentNetworkError);
    expect(fieldsOf(capability)).toEqual(fieldsOf(await viaSession(response)));
  });

  it("a request that never answers fails with PaymentNetworkError after the timeout", async () => {
    const api = paypal(
      (request) =>
        new Promise<Response>((_resolve, reject) => {
          request.init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
        }),
    );
    const error = await Effect.runPromise(
      withTestClock(
        Effect.flip(Product.retrieve("PROD-1")).pipe(
          Effect.provide(PayPalPayments.layer(config({ timeout: 5_000 }))),
          Effect.provide(api.http),
        ),
      ),
    );
    expect(error).toBeInstanceOf(PaymentNetworkError);
    expect(error.message).toBe("PayPal request timed out after 5000 ms");
  });

  it("a Distilled failure with no response is a PaymentProviderError named by its tag", async () => {
    // Credentials whose effect fails: Distilled's protocol fails the call
    // before anything is sent.
    const noToken: Effect.Effect<Effect.Success<Credentials["Service"]>, ConfigError> = Effect.fail(
      new ConfigError({ message: "No token" }),
    );
    const failing = Layer.succeed(
      Credentials,
      // SAFETY: a consumer's credentials effect that fails at run time, which
      // its type rules out, to reach the no-response path.
      noToken as Credentials["Service"],
    );
    const stub = stubFetch(() => jsonResponse(200, PRODUCT));
    const error = await Effect.runPromise(
      Effect.flip(Product.retrieve("PROD-1")).pipe(
        Effect.provide(capabilitiesOver(Layer.merge(stub.http, failing))),
      ),
    );
    expect(error).toBeInstanceOf(PaymentProviderError);
    expect(error).toMatchObject({ code: "ConfigError", message: "No token", provider: "paypal" });
    expect(stub.calls).toEqual([]);
  });

  it("never carries the access token or the client secret in an error, at any depth", async () => {
    const auth = await viaCapability(() =>
      jsonResponse(401, body("AUTHENTICATION_FAILURE", "Expired")),
    );
    const invalid = await viaCapability(() =>
      jsonResponse(400, body("INVALID_REQUEST", "Bad", [{ field: "/name", issue: "MISSING" }])),
    );
    const network = await viaCapability(() => {
      throw new TypeError("fetch failed");
    });
    const loginRefused = await run(
      Effect.flip(Product.retrieve("PROD-1")),
      paypal(
        () => jsonResponse(200, PRODUCT),
        () =>
          jsonResponse(401, { name: "invalid_client", message: "Client Authentication failed" }),
      ).http,
    );
    const loginDown = await run(
      Effect.flip(Product.retrieve("PROD-1")),
      paypal(
        () => jsonResponse(200, PRODUCT),
        () => {
          throw new TypeError("fetch failed");
        },
      ).http,
    );
    const timeout = await Effect.runPromise(
      withTestClock(
        Effect.flip(Product.retrieve("PROD-1")).pipe(
          Effect.provide(PayPalPayments.layer(config({ timeout: 5_000 }))),
          Effect.provide(
            paypal(
              (request) =>
                new Promise<Response>((_resolve, reject) => {
                  request.init?.signal?.addEventListener("abort", () =>
                    reject(new Error("aborted")),
                  );
                }),
            ).http,
          ),
        ),
      ),
    );
    // A token response that does not decode, one of them carrying a token.
    const loginMalformed = await Promise.all(
      [{ access_token: 42 }, { access_token: `${TOKEN}leak`, expires_in: "x" }].map((answer) =>
        run(
          Effect.flip(Product.retrieve("PROD-1")),
          paypal(
            () => jsonResponse(200, PRODUCT),
            () => jsonResponse(200, answer),
          ).http,
        ),
      ),
    );
    const basic = btoa(`client_1:${CLIENT_SECRET}`);
    Arr.forEach(
      [auth, invalid, network, loginRefused, loginDown, timeout, ...loginMalformed],
      (error) => {
        // The JSON form (`JSON.stringify`, which `toJson` runs) and `String` go
        // through Effect's `Headers` redaction, so they would miss a request
        // kept anywhere in the error; walk every value it holds instead.
        const reachable = reachableFrom(error);
        Arr.forEach([TOKEN, CLIENT_SECRET, basic], (secret) => {
          expect(reachable.strings.filter((value) => value.includes(secret))).toEqual([]);
          expect(toJson(error)).not.toContain(secret);
          expect(String(error)).not.toContain(secret);
        });
        expect(reachable.objects.filter(HttpClientError.isHttpClientError)).toEqual([]);
        expect(reachable.objects.filter(HttpClientRequest.isHttpClientRequest)).toEqual([]);
      },
    );
  });
});
