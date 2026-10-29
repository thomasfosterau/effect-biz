import { describe, it, expect } from "vite-plus/test";
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as MutableHashMap from "effect/MutableHashMap";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Record from "effect/Record";
import * as Redacted from "effect/Redacted";
import { FetchHttpClient } from "effect/http";
import * as Product from "@thomasfosterau/effect-biz/Payments.Product";
import * as Price from "@thomasfosterau/effect-biz/Payments.Price";
import * as PaymentIntent from "@thomasfosterau/effect-biz/Payments.PaymentIntent";
import * as Subscription from "@thomasfosterau/effect-biz/Payments.Subscription";
import * as Refund from "@thomasfosterau/effect-biz/Payments.Refund";
import * as IdempotencyKey from "@thomasfosterau/effect-biz/Payments.IdempotencyKey";
import {
  PaymentInvalidRequestError,
  PaymentNetworkError,
} from "@thomasfosterau/effect-biz/Payments";
import * as PayPalPayments from "../src/PayPalPayments.ts";
import { capabilitiesOver, stubPayPal, toJson } from "./support.ts";

/**
 * The neutral `idempotencyKey` (effect-finance#55, closing effect-finance#66) on the create and confirm
 * operations: mapped onto `PayPal-Request-Id`, and a retried write after a lost
 * response is one logical write.
 */

const KEY = IdempotencyKey.IdempotencyKey.make("write-0001");

type Capabilities = Layer.Success<typeof PayPalPayments.capabilities>;

/** Run `operation` over a stubbed API answering `{}` (the decode fails; the request was recorded first). */
const requestsOf = async (operation: Effect.Effect<unknown, unknown, Capabilities>) => {
  const { calls, layer } = stubPayPal(() => ({}));
  const exit = await Effect.runPromise(
    Effect.exit(operation.pipe(Effect.provide(capabilitiesOver(layer)))),
  );
  return { calls, exit };
};

const operations = (idempotencyKey: IdempotencyKey.IdempotencyKey | undefined) =>
  [
    ["Product.create", "/v1/catalogs/products", Product.create({ name: "P", idempotencyKey })],
    [
      "Price.create",
      "/v1/billing/plans",
      Price.create({
        product: "PROD-1",
        currency: "usd",
        unitAmount: 100,
        recurring: { interval: "month" },
        idempotencyKey,
      }),
    ],
    [
      "PaymentIntent.create",
      "/v2/checkout/orders",
      PaymentIntent.create({ amount: 100, currency: "usd", idempotencyKey }),
    ],
    [
      "PaymentIntent.confirm",
      "/v2/checkout/orders/ORD-1/capture",
      PaymentIntent.confirm("ORD-1", { idempotencyKey }),
    ],
    [
      "Subscription.create",
      "/v1/billing/subscriptions",
      Subscription.create({ customer: "cus_1", items: [{ price: "P-1" }], idempotencyKey }),
    ],
    [
      "Refund.create",
      "/v2/payments/captures/CAP-1/refund",
      Refund.create({ charge: "CAP-1", idempotencyKey }),
    ],
  ] as const;

/** The path and operation {@link operations} lists under `name`. */
const operationNamed = (idempotencyKey: IdempotencyKey.IdempotencyKey | undefined, name: string) =>
  Record.fromEntries(
    Arr.map(operations(idempotencyKey), ([candidate, path, op]) => [candidate, { path, op }]),
  )[name];

describe("PayPal maps the neutral idempotencyKey to PayPal-Request-Id", () => {
  it.each(operations(KEY).map(([name]) => name))("%s", async (name) => {
    const { path, op } = operationNamed(KEY, name);
    const { calls } = await requestsOf(op);
    expect(calls.map((call) => [call.method, call.path, call.requestId])).toEqual([
      ["POST", path, KEY],
    ]);
  });

  it.each(operations(undefined).map(([name]) => name))(
    "%s sends none without a key",
    async (name) => {
      const { op } = operationNamed(undefined, name);
      const { calls } = await requestsOf(op);
      expect(calls.map((call) => call.requestId)).toEqual([undefined]);
    },
  );

  it.each(operations(undefined).map(([name]) => name))(
    "%s refuses a raw string before sending anything",
    async (name) => {
      // Untyped code can still pass a string the brand would have refused.
      const bad = "not a valid key" as IdempotencyKey.IdempotencyKey;
      const { op } = operationNamed(bad, name);
      const { calls, exit } = await requestsOf(op);
      expect(calls).toEqual([]);
      expect(exit._tag).toBe("Failure");
      expect(toJson(exit)).toContain("PaymentInvalidRequestError");
    },
  );

  it("sends no key on a refund's lookups, only on the refund itself", async () => {
    const { calls, layer } = stubPayPal((request) =>
      request.path.startsWith("/v2/checkout/orders/")
        ? {
            id: "ORD-1",
            status: "COMPLETED",
            purchase_units: [{ payments: { captures: [{ id: "CAP-2" }] } }],
          }
        : {
            id: "REF-1",
            status: "PENDING",
            amount: { currency_code: "USD", value: "1.00" },
          },
    );
    await Effect.runPromise(
      Refund.create({ paymentIntent: "ORD-1", idempotencyKey: KEY }).pipe(
        Effect.provide(capabilitiesOver(layer)),
      ),
    );
    expect(calls.map((call) => [call.method, call.requestId])).toEqual([
      ["GET", undefined],
      ["POST", KEY],
    ]);
  });

  it("the cancel operations fail without sending anything, and take no key", async () => {
    const { calls, exit } = await requestsOf(PaymentIntent.cancel("ORD-1"));
    expect(calls).toEqual([]);
    expect(exit._tag).toBe("Failure");
    const sub = await requestsOf(Subscription.cancel("SUB-1"));
    // The cancel is a POST followed by a read-back; neither carries a key.
    expect(sub.calls.length).toBeGreaterThan(0);
    expect(sub.calls.map((call) => call.requestId)).toEqual(sub.calls.map(() => undefined));
  });
});

describe("a retried write after a lost response is one logical write (effect-finance#66)", () => {
  const LOGIN_PATH = "/v1/oauth2/token";
  const ORDER = {
    id: "ORD-1",
    status: "CREATED",
    purchase_units: [{ amount: { currency_code: "USD", value: "1.00" } }],
  };

  /**
   * A fake PayPal behind the real client: it dedupes `POST /v2/checkout/orders`
   * by `PayPal-Request-Id` (the first request with an id applies the write, a
   * repeat returns the remembered order). `loseFirstResponse` drops the answer
   * to the first write, as a timeout would: the order exists, the caller never
   * saw it.
   */
  const dedupingPayPal = (loseFirstResponse: boolean) => {
    const seen = MutableHashMap.empty<string, string>();
    const sent: Array<string | null> = [];
    let writes = 0;
    let attempts = 0;
    const fetchImpl: typeof globalThis.fetch = async (input, init) => {
      const url = String(input);
      if (url.endsWith(LOGIN_PATH)) {
        return Response.json({ access_token: "at_1", expires_in: 3600 });
      }
      attempts += 1;
      const id = new Headers(init?.headers).get("paypal-request-id");
      sent.push(id);
      const remembered = id === null ? Option.none<string>() : MutableHashMap.get(seen, id);
      const orderId = Option.getOrElse(remembered, () => `ORD-${(writes += 1)}`);
      if (id !== null) MutableHashMap.set(seen, id, orderId);
      if (loseFirstResponse && attempts === 1) throw new TypeError("fetch failed");
      return Response.json({ ...ORDER, id: orderId });
    };
    const http = FetchHttpClient.layer.pipe(
      Layer.provide(Layer.succeed(FetchHttpClient.Fetch, fetchImpl)),
    );
    return { http, sent, writes: () => writes };
  };

  const config = { clientId: "client_1", clientSecret: Redacted.make("secret_1") };

  const createWithRetry = (idempotencyKey: IdempotencyKey.IdempotencyKey | undefined) =>
    PaymentIntent.create({ amount: 100, currency: "usd", idempotencyKey }).pipe(
      Effect.retry({ while: Predicate.isTagged("PaymentNetworkError"), times: 1 }),
    );

  it("with one key reused on the retry, PayPal applies it once", async () => {
    const fake = dedupingPayPal(true);
    const intent = await Effect.runPromise(
      Effect.gen(function* () {
        const key = yield* IdempotencyKey.generate; // once per logical write
        return yield* createWithRetry(key);
      }).pipe(Effect.provide(PayPalPayments.layer(config)), Effect.provide(fake.http)),
    );
    expect(intent.id).toBe("ORD-1");
    expect(fake.writes()).toBe(1);
    expect(fake.sent).toHaveLength(2);
    expect(fake.sent[0]).not.toBeNull();
    expect(fake.sent[1]).toBe(fake.sent[0]);
  });

  it("without a key, the same retry creates a duplicate (the hazard being fixed)", async () => {
    const fake = dedupingPayPal(true);
    const intent = await Effect.runPromise(
      createWithRetry(undefined).pipe(
        Effect.provide(PayPalPayments.layer(config)),
        Effect.provide(fake.http),
      ),
    );
    expect(fake.sent).toEqual([null, null]);
    expect(fake.writes()).toBe(2);
    expect(intent.id).toBe("ORD-2");
  });

  it("surfaces the lost response as PaymentNetworkError when the caller does not retry", async () => {
    const fake = dedupingPayPal(true);
    const error = await Effect.runPromise(
      PaymentIntent.create({ amount: 100, currency: "usd", idempotencyKey: KEY }).pipe(
        Effect.flip,
        Effect.provide(PayPalPayments.layer(config)),
        Effect.provide(fake.http),
      ),
    );
    expect(error).toBeInstanceOf(PaymentNetworkError);
    expect(fake.writes()).toBe(1);
  });

  it("refuses a raw string key with PaymentInvalidRequestError before any request", async () => {
    const fake = dedupingPayPal(false);
    const error = await Effect.runPromise(
      PaymentIntent.create({
        amount: 100,
        currency: "usd",
        idempotencyKey: "bad key" as IdempotencyKey.IdempotencyKey,
      }).pipe(Effect.flip, Effect.provide(PayPalPayments.layer(config)), Effect.provide(fake.http)),
    );
    expect(error).toBeInstanceOf(PaymentInvalidRequestError);
    expect(fake.sent).toEqual([]);
  });
});
