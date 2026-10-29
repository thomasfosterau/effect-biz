import { describe, it, expect } from "vite-plus/test";
import * as Effect from "effect/Effect";
import * as HashMap from "effect/HashMap";
import type * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Redacted from "effect/Redacted";
import type { HttpClient } from "effect/http";
import type { Credentials } from "@distilled.cloud/stripe/Credentials";
import * as Customer from "@thomasfosterau/effect-biz/Payments.Customer";
import * as Product from "@thomasfosterau/effect-biz/Payments.Product";
import * as Price from "@thomasfosterau/effect-biz/Payments.Price";
import * as PaymentIntent from "@thomasfosterau/effect-biz/Payments.PaymentIntent";
import * as Subscription from "@thomasfosterau/effect-biz/Payments.Subscription";
import * as Refund from "@thomasfosterau/effect-biz/Payments.Refund";
import * as CheckoutSession from "@thomasfosterau/effect-biz/Payments.CheckoutSession";
import * as IdempotencyKey from "@thomasfosterau/effect-biz/Payments.IdempotencyKey";
import {
  PaymentInvalidRequestError,
  PaymentNetworkError,
  type PaymentsError,
} from "@thomasfosterau/effect-biz/Payments";
import * as StripePayments from "../src/StripePayments.ts";
import { jsonResponse, stubFetch, stubStripe } from "./support.ts";

/**
 * The neutral `idempotencyKey` (effect-finance#55, closing effect-finance#66) on the create and confirm
 * operations: mapped onto Stripe's `Idempotency-Key`, and a retried write
 * after a lost response is one logical write.
 */

const KEY = IdempotencyKey.IdempotencyKey.make("write-0001");

/**
 * The capabilities with no retries, so a `POST` sent without a caller's key
 * carries none (a retryable one carries a generated key; see below).
 */
const noRetries = StripePayments.layer({
  apiKey: Redacted.make("sk_test_not_a_real_key"),
  maxNetworkRetries: 0,
});

/** Run one operation against a stubbed API and return the `Idempotency-Key` it sent. */
const requestOf = async (
  operation: Effect.Effect<unknown, unknown, Capabilities>,
  capabilities: Layer.Layer<Capabilities, unknown, HttpClient.HttpClient | Credentials> = noRetries,
): Promise<{ readonly idempotencyKey: string | undefined; readonly count: number }> => {
  const stub = stubStripe(() => ({}));
  // The empty answer fails the decode; the request was recorded before that.
  await Effect.runPromise(
    Effect.exit(operation.pipe(Effect.provide(capabilities), Effect.provide(stub.layer))),
  );
  return {
    idempotencyKey: stub.calls[0]?.headers.get("idempotency-key") ?? undefined,
    count: stub.calls.length,
  };
};
type Capabilities = Layer.Success<typeof StripePayments.capabilities>;

const operations = (
  idempotencyKey: IdempotencyKey.IdempotencyKey | undefined,
): ReadonlyArray<readonly [string, Effect.Effect<unknown, PaymentsError, Capabilities>]> => [
  ["Customer.create", Customer.create({ email: "a@example.com", idempotencyKey })],
  ["Product.create", Product.create({ name: "P", idempotencyKey })],
  [
    "Price.create",
    Price.create({ product: "prod_1", currency: "usd", unitAmount: 100, idempotencyKey }),
  ],
  ["PaymentIntent.create", PaymentIntent.create({ amount: 100, currency: "usd", idempotencyKey })],
  ["PaymentIntent.confirm", PaymentIntent.confirm("pi_1", { idempotencyKey })],
  [
    "Subscription.create",
    Subscription.create({ customer: "cus_1", items: [{ price: "price_1" }], idempotencyKey }),
  ],
  ["Refund.create", Refund.create({ paymentIntent: "pi_1", idempotencyKey })],
  [
    "CheckoutSession.create",
    CheckoutSession.create({
      mode: "payment",
      lineItems: [{ price: "price_1" }],
      successUrl: "https://example.com/ok",
      cancelUrl: "https://example.com/no",
      idempotencyKey,
    }),
  ],
];

describe("Stripe maps the neutral idempotencyKey to Idempotency-Key", () => {
  it.each(operations(KEY))("%s", async (_name, op) => {
    expect(await requestOf(op)).toEqual({ idempotencyKey: KEY, count: 1 });
  });

  it.each(operations(undefined))("%s sends none without a key", async (_name, op) => {
    expect(await requestOf(op)).toEqual({ idempotencyKey: undefined, count: 1 });
  });

  it.each(operations(undefined))(
    "%s sends a generated retry key without a caller's key, when it may be retried",
    async (_name, op) => {
      const { idempotencyKey } = await requestOf(op, StripePayments.capabilities);
      expect(idempotencyKey).toMatch(/^effect-payments-retry-[0-9a-f-]{36}$/);
    },
  );

  // SAFETY: untyped code can still pass a string the brand would have refused.
  const bad = "not a valid key" as IdempotencyKey.IdempotencyKey;

  it.each(operations(bad))("%s refuses a raw string before sending anything", async (_name, op) => {
    const stub = stubStripe(() => ({}));
    const error = await Effect.runPromise(
      Effect.flip(op.pipe(Effect.provide(StripePayments.capabilities), Effect.provide(stub.layer))),
    );
    expect(error).toBeInstanceOf(PaymentInvalidRequestError);
    expect(stub.calls).toEqual([]);
  });

  it("sends none on the cancel operations", async () => {
    const stub = stubStripe(() => ({}));
    await Effect.runPromise(
      Effect.exit(
        Effect.gen(function* () {
          yield* Effect.exit(Subscription.cancel("sub_1"));
          yield* Effect.exit(PaymentIntent.cancel("pi_1"));
        }).pipe(Effect.provide(noRetries), Effect.provide(stub.layer)),
      ),
    );
    expect(stub.calls.map((call) => [call.method, call.headers.get("idempotency-key")])).toEqual([
      ["DELETE", null],
      ["POST", null],
    ]);
  });
});

describe("a retried write after a lost response is one logical write (effect-finance#66)", () => {
  const customer = {
    id: "cus_1",
    email: "a@example.com",
    name: null,
    phone: null,
    description: null,
    metadata: {},
    created: 1,
    livemode: false,
  };

  /**
   * A fake Stripe that dedupes by `Idempotency-Key`: the first request with a
   * key applies the write and remembers the answer, a repeat returns the
   * remembered answer. `loseFirstResponse` drops the answer to the first
   * attempt, as a timeout would: the write happened, the caller never saw it.
   */
  const dedupingStripe = (loseFirstResponse: boolean, answerFirstWith500 = false) => {
    let seen = HashMap.empty<string, Response>();
    let writes = 0;
    let attempts = 0;
    const stub = stubFetch((request) => {
      attempts += 1;
      const key = request.headers.get("idempotency-key");
      const remembered = key === null ? Option.none<Response>() : HashMap.get(seen, key);
      const response = Option.getOrElse(
        remembered,
        () => ((writes += 1), jsonResponse(200, { ...customer, id: `cus_${writes}` })),
      );
      if (key !== null && Option.isNone(remembered)) {
        seen = HashMap.set(seen, key, response.clone());
      }
      if (loseFirstResponse && attempts === 1) throw new TypeError("fetch failed");
      // The write was applied, but the caller is told the server failed.
      if (answerFirstWith500 && attempts === 1) {
        return jsonResponse(500, { error: { type: "api_error", message: "boom" } });
      }
      return response.clone();
    });
    return { ...stub, writes: () => writes };
  };

  /** Create a customer, retrying once on a network error, with `key` for every attempt. */
  const createWithRetry = (key: IdempotencyKey.IdempotencyKey | undefined) =>
    Customer.create({ email: "a@example.com", idempotencyKey: key }).pipe(
      Effect.retry({
        while: (error) => Predicate.isTagged(error, "PaymentNetworkError"),
        times: 1,
      }),
    );

  it("with one key reused on the retry, the provider applies it once", async () => {
    const fake = dedupingStripe(true);
    const created = await Effect.runPromise(
      Effect.gen(function* () {
        const key = yield* IdempotencyKey.generate; // once per logical write
        return yield* createWithRetry(key);
      }).pipe(
        Effect.provide(
          StripePayments.layer({
            apiKey: Redacted.make("sk_test_not_a_real_key"),
            maxNetworkRetries: 0,
          }),
        ),
        Effect.provide(fake.http),
      ),
    );
    expect(created.id).toBe("cus_1");
    expect(fake.writes()).toBe(1);
    const keys = fake.calls.map((call) => call.headers.get("idempotency-key"));
    expect(keys).toHaveLength(2);
    expect(keys[0]).toBe(keys[1]);
  });

  it("a vendor 5xx surfaces as PaymentProviderError (not PaymentNetworkError); retrying it with the same key is still one write", async () => {
    const fake = dedupingStripe(false, true);
    const key = IdempotencyKey.IdempotencyKey.make("write-5xx");
    const created = await Effect.runPromise(
      Customer.create({ email: "a@example.com", idempotencyKey: key }).pipe(
        Effect.retry({
          while: (error) =>
            Predicate.isTagged(error, "PaymentProviderError") && (error.statusCode ?? 0) >= 500,
          times: 1,
        }),
        Effect.provide(
          StripePayments.layer({
            apiKey: Redacted.make("sk_test_not_a_real_key"),
            maxNetworkRetries: 0,
          }),
        ),
        Effect.provide(fake.http),
      ),
    );
    expect(created.id).toBe("cus_1");
    expect(fake.writes()).toBe(1);
  });

  it("without a key, the same retry creates a duplicate (the hazard being fixed)", async () => {
    const fake = dedupingStripe(true);
    const created = await Effect.runPromise(
      createWithRetry(undefined).pipe(
        Effect.provide(
          StripePayments.layer({
            apiKey: Redacted.make("sk_test_not_a_real_key"),
            maxNetworkRetries: 0,
          }),
        ),
        Effect.provide(fake.http),
      ),
    );
    expect(fake.writes()).toBe(2);
    expect(created.id).toBe("cus_2");
  });

  it("surfaces the lost response as PaymentNetworkError when the caller does not retry", async () => {
    const fake = dedupingStripe(true);
    const error = await Effect.runPromise(
      Customer.create({ email: "a@example.com", idempotencyKey: KEY }).pipe(
        Effect.flip,
        Effect.provide(
          StripePayments.layer({
            apiKey: Redacted.make("sk_test_not_a_real_key"),
            maxNetworkRetries: 0,
          }),
        ),
        Effect.provide(fake.http),
      ),
    );
    expect(error).toBeInstanceOf(PaymentNetworkError);
    expect(fake.writes()).toBe(1);
  });
});
