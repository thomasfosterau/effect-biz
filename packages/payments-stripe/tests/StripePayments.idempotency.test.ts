import { describe, expect } from "vite-plus/test";
import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as HashMap from "effect/HashMap";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as P from "effect/Predicate";
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
import { omitUndefined } from "@thomasfosterau/effect-biz/Payments.internal";
import {
  type PaymentConfigError,
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
const requestOf = (
  operation: Effect.Effect<unknown, PaymentsError, Capabilities>,
  capabilities: Layer.Layer<
    Capabilities,
    PaymentConfigError,
    HttpClient.HttpClient | Credentials
  > = noRetries,
): Effect.Effect<{ readonly idempotencyKey: Option.Option<string>; readonly count: number }> =>
  Effect.gen(function* () {
    const stub = stubStripe(() => ({}));
    // The empty answer fails the decode; the request was recorded before that.
    yield* Effect.exit(
      operation.pipe(Effect.provide(Layer.provideMerge(capabilities, stub.layer))),
    );
    return {
      idempotencyKey: Option.fromNullishOr(stub.calls[0]?.headers.get("idempotency-key")),
      count: stub.calls.length,
    };
  });
type Capabilities = Layer.Success<typeof StripePayments.capabilities>;

const operations = (
  key?: IdempotencyKey.IdempotencyKey,
): ReadonlyArray<readonly [string, Effect.Effect<unknown, PaymentsError, Capabilities>]> => {
  // A caller without a key omits the member.
  const keyed = omitUndefined({ idempotencyKey: key });
  return [
    ["Customer.create", Customer.create({ email: "a@example.com", ...keyed })],
    ["Product.create", Product.create({ name: "P", ...keyed })],
    [
      "Price.create",
      Price.create({ product: "prod_1", currency: "usd", unitAmount: 100, ...keyed }),
    ],
    ["PaymentIntent.create", PaymentIntent.create({ amount: 100, currency: "usd", ...keyed })],
    ["PaymentIntent.confirm", PaymentIntent.confirm("pi_1", keyed)],
    [
      "Subscription.create",
      Subscription.create({ customer: "cus_1", items: [{ price: "price_1" }], ...keyed }),
    ],
    ["Refund.create", Refund.create({ paymentIntent: "pi_1", ...keyed })],
    [
      "CheckoutSession.create",
      CheckoutSession.create({
        mode: "payment",
        lineItems: [{ price: "price_1" }],
        successUrl: "https://example.com/ok",
        cancelUrl: "https://example.com/no",
        ...keyed,
      }),
    ],
  ];
};

describe("Stripe maps the neutral idempotencyKey to Idempotency-Key", () => {
  it.effect.each(operations(KEY))("%s", ([_name, op]) =>
    Effect.gen(function* () {
      expect(yield* requestOf(op)).toEqual({ idempotencyKey: Option.some(KEY), count: 1 });
    }),
  );

  it.effect.each(operations())("%s sends none without a key", ([_name, op]) =>
    Effect.gen(function* () {
      expect(yield* requestOf(op)).toEqual({ idempotencyKey: Option.none(), count: 1 });
    }),
  );

  it.effect.each(operations())(
    "%s sends a generated retry key without a caller's key, when it may be retried",
    ([_name, op]) =>
      Effect.gen(function* () {
        const { idempotencyKey } = yield* requestOf(op, StripePayments.capabilities);
        expect(Option.getOrElse(idempotencyKey, () => "")).toMatch(
          /^effect-payments-retry-[0-9a-f-]{36}$/,
        );
      }),
  );

  // SAFETY: untyped code can still pass a string the brand would have refused.
  const bad = "not a valid key" as IdempotencyKey.IdempotencyKey;

  it.effect.each(operations(bad))(
    "%s refuses a raw string before sending anything",
    ([_name, op]) =>
      Effect.gen(function* () {
        const stub = stubStripe(() => ({}));
        const error = yield* Effect.flip(
          Effect.asVoid(
            op.pipe(Effect.provide(Layer.provideMerge(StripePayments.capabilities, stub.layer))),
          ),
        );
        expect(error).toBeInstanceOf(PaymentInvalidRequestError);
        expect(stub.calls).toEqual([]);
      }),
  );

  it.effect("sends none on the cancel operations", () =>
    Effect.gen(function* () {
      const stub = stubStripe(() => ({}));
      yield* Effect.exit(
        Effect.gen(function* () {
          yield* Effect.exit(Subscription.cancel("sub_1"));
          yield* Effect.exit(PaymentIntent.cancel("pi_1"));
        }).pipe(Effect.provide(Layer.provideMerge(noRetries, stub.layer))),
      );
      expect(stub.calls.map((call) => [call.method, call.headers.get("idempotency-key")])).toEqual([
        ["DELETE", null],
        ["POST", null],
      ]);
    }),
  );
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
  const createWithRetry = (key?: IdempotencyKey.IdempotencyKey) =>
    Customer.create({ email: "a@example.com", ...omitUndefined({ idempotencyKey: key }) }).pipe(
      Effect.retry({
        while: (error) => P.isTagged(error, "PaymentNetworkError"),
        times: 1,
      }),
    );

  it.effect("with one key reused on the retry, the provider applies it once", () =>
    Effect.gen(function* () {
      const fake = dedupingStripe(true);
      const created = yield* Effect.gen(function* () {
        const key = yield* IdempotencyKey.generate; // once per logical write
        return yield* createWithRetry(key);
      }).pipe(
        Effect.provide(
          Layer.provideMerge(
            Layer.provideMerge(
              StripePayments.layer({
                apiKey: Redacted.make("sk_test_not_a_real_key"),
                maxNetworkRetries: 0,
              }),
              fake.http,
            ),
            fake.http,
          ),
        ),
      );
      expect(created.id).toBe("cus_1");
      expect(fake.writes()).toBe(1);
      const keys = fake.calls.map((call) => call.headers.get("idempotency-key"));
      expect(keys).toHaveLength(2);
      expect(keys[0]).toBe(keys[1]);
    }),
  );

  it.effect(
    "a vendor 5xx surfaces as PaymentProviderError (not PaymentNetworkError); retrying it with the same key is still one write",
    () =>
      Effect.gen(function* () {
        const fake = dedupingStripe(false, true);
        const key = IdempotencyKey.IdempotencyKey.make("write-5xx");
        const created = yield* Customer.create({
          email: "a@example.com",
          idempotencyKey: key,
        }).pipe(
          Effect.retry({
            while: (error) =>
              P.isTagged(error, "PaymentProviderError") &&
              Option.exists(error.statusCode, (status) => status >= 500),
            times: 1,
          }),
          Effect.provide(
            Layer.provideMerge(
              StripePayments.layer({
                apiKey: Redacted.make("sk_test_not_a_real_key"),
                maxNetworkRetries: 0,
              }),
              fake.http,
            ),
          ),
        );
        expect(created.id).toBe("cus_1");
        expect(fake.writes()).toBe(1);
      }),
  );

  it.effect("without a key, the same retry creates a duplicate (the hazard being fixed)", () =>
    Effect.gen(function* () {
      const fake = dedupingStripe(true);
      const created = yield* createWithRetry().pipe(
        Effect.provide(
          Layer.provideMerge(
            Layer.provideMerge(
              StripePayments.layer({
                apiKey: Redacted.make("sk_test_not_a_real_key"),
                maxNetworkRetries: 0,
              }),
              fake.http,
            ),
            fake.http,
          ),
        ),
      );
      expect(fake.writes()).toBe(2);
      expect(created.id).toBe("cus_2");
    }),
  );

  it.effect(
    "surfaces the lost response as PaymentNetworkError when the caller does not retry",
    () =>
      Effect.gen(function* () {
        const fake = dedupingStripe(true);
        const error = yield* Customer.create({ email: "a@example.com", idempotencyKey: KEY }).pipe(
          Effect.flip,
          Effect.provide(
            Layer.provideMerge(
              StripePayments.layer({
                apiKey: Redacted.make("sk_test_not_a_real_key"),
                maxNetworkRetries: 0,
              }),
              fake.http,
            ),
          ),
        );
        expect(error).toBeInstanceOf(PaymentNetworkError);
        expect(fake.writes()).toBe(1);
      }),
  );
});
