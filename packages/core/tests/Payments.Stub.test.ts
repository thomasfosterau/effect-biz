import { assert, expect } from "vite-plus/test";
import { layer } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Layer from "effect/Layer";
import * as BillingPortal from "../src/Payments.BillingPortal.ts";
import * as CheckoutSession from "../src/Payments.CheckoutSession.ts";
import * as Customer from "../src/Payments.Customer.ts";
import * as PaymentIntent from "../src/Payments.PaymentIntent.ts";
import {
  PaymentInvalidRequestError,
  type PaymentsError,
  PaymentsUnavailable,
} from "../src/Payments.PaymentsError.ts";
import * as Price from "../src/Payments.Price.ts";
import * as Product from "../src/Payments.Product.ts";
import * as Refund from "../src/Payments.Refund.ts";
import * as Stub from "../src/Payments.Stub.ts";
import * as Subscription from "../src/Payments.Subscription.ts";

/** Every operation of every capability, by name. */
const everyCall: ReadonlyArray<
  readonly [
    string,
    Effect.Effect<unknown, PaymentsError, Layer.Success<ReturnType<typeof Stub.layer>>>,
  ]
> = [
  ["Customer.create", Customer.create({ email: "a@example.test" })],
  ["Customer.retrieve", Customer.retrieve("cus_1")],
  ["Customer.update", Customer.update("cus_1", { name: "A" })],
  ["Customer.del", Customer.del("cus_1")],
  ["Customer.list", Customer.list()],
  ["Product.create", Product.create({ name: "P" })],
  ["Product.retrieve", Product.retrieve("prod_1")],
  ["Product.update", Product.update("prod_1", { name: "Q" })],
  ["Product.del", Product.del("prod_1")],
  ["Product.list", Product.list()],
  ["Price.create", Price.create({ product: "prod_1", currency: "usd", unitAmount: 100 })],
  ["Price.retrieve", Price.retrieve("price_1")],
  ["Price.update", Price.update("price_1", { active: false })],
  ["Price.list", Price.list()],
  ["PaymentIntent.create", PaymentIntent.create({ amount: 100, currency: "usd" })],
  ["PaymentIntent.retrieve", PaymentIntent.retrieve("pi_1")],
  ["PaymentIntent.update", PaymentIntent.update("pi_1", { amount: 200 })],
  ["PaymentIntent.confirm", PaymentIntent.confirm("pi_1")],
  ["PaymentIntent.cancel", PaymentIntent.cancel("pi_1")],
  ["PaymentIntent.list", PaymentIntent.list()],
  ["Subscription.create", Subscription.create({ customer: "cus_1", items: [{ price: "p" }] })],
  ["Subscription.retrieve", Subscription.retrieve("sub_1")],
  ["Subscription.update", Subscription.update("sub_1", { cancelAtPeriodEnd: true })],
  ["Subscription.cancel", Subscription.cancel("sub_1")],
  ["Subscription.list", Subscription.list()],
  ["Refund.create", Refund.create({ paymentIntent: "pi_1" })],
  ["Refund.retrieve", Refund.retrieve("re_1")],
  ["Refund.update", Refund.update("re_1", { metadata: {} })],
  ["Refund.list", Refund.list()],
  [
    "CheckoutSession.create",
    CheckoutSession.create({
      mode: "payment",
      lineItems: [{ price: "price_1" }],
      successUrl: "https://example.test/ok",
      cancelUrl: "https://example.test/no",
    }),
  ],
  [
    "BillingPortal.create",
    BillingPortal.create({ customer: "cus_1", returnUrl: "https://example.test/account" }),
  ],
];

const failure = new PaymentInvalidRequestError({ message: "nope" });

layer(Stub.layer(Effect.fail(failure)))("Stub.layer", (it) => {
  it.effect.each(everyCall)("fails %s with the given failure", ([_, call]) =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(Effect.asVoid(call));
      expect(error).toBe(failure);
    }),
  );
});

layer(Stub.unavailable("stripe"))("Stub.unavailable", (it) => {
  it.effect.each(everyCall)("fails %s with PaymentsUnavailable", ([_, call]) =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(Effect.asVoid(call));
      expect(error).toBeInstanceOf(PaymentsUnavailable);
      expect(error).toMatchObject({
        provider: Option.some("stripe"),
        message: "stripe is not configured in this environment",
      });
    }),
  );

  it.effect("constructs a fresh error for each call", () =>
    Effect.gen(function* () {
      const [first, second] = yield* Effect.all(
        [Effect.flip(Customer.retrieve("a")), Effect.flip(Customer.retrieve("b"))],
        {
          concurrency: 1,
        },
      );
      expect(first).toBeInstanceOf(PaymentsUnavailable);
      expect(first).not.toBe(second);
    }),
  );
});

layer(Stub.unavailable())("Stub.unavailable without a provider", (it) => {
  it.effect("names none", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(Customer.retrieve("cus_1"));
      expect(error).toBeInstanceOf(PaymentsUnavailable);
      expect(error).toMatchObject({ message: "Payments are not configured in this environment" });
      assert(error instanceof PaymentsUnavailable);
      expect(error.provider).toEqual(Option.none());
    }),
  );
});
