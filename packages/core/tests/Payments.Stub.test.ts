import { assert, describe, it, expect } from "vite-plus/test";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as BillingPortal from "../src/Payments.BillingPortal.ts";
import * as CheckoutSession from "../src/Payments.CheckoutSession.ts";
import * as Customer from "../src/Payments.Customer.ts";
import * as PaymentIntent from "../src/Payments.PaymentIntent.ts";
import { PaymentInvalidRequestError, PaymentsUnavailable } from "../src/Payments.PaymentsError.ts";
import * as Price from "../src/Payments.Price.ts";
import * as Product from "../src/Payments.Product.ts";
import * as Refund from "../src/Payments.Refund.ts";
import * as Stub from "../src/Payments.Stub.ts";
import * as Subscription from "../src/Payments.Subscription.ts";

/** Every operation of every capability, by name. */
const everyCall: ReadonlyArray<
  readonly [string, Effect.Effect<unknown, unknown, Layer.Success<ReturnType<typeof Stub.layer>>>]
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

describe("Stub", () => {
  it.each(everyCall)("layer fails %s with the given failure", async (_, call) => {
    const failure = new PaymentInvalidRequestError({ message: "nope" });
    const error = await Effect.runPromise(
      Effect.flip(call).pipe(Effect.provide(Stub.layer(Effect.fail(failure)))),
    );
    expect(error).toBe(failure);
  });

  it.each(everyCall)("unavailable fails %s with PaymentsUnavailable", async (_, call) => {
    const error = await Effect.runPromise(
      Effect.flip(call).pipe(Effect.provide(Stub.unavailable("stripe"))),
    );
    expect(error).toBeInstanceOf(PaymentsUnavailable);
    expect(error).toMatchObject({
      provider: "stripe",
      message: "stripe is not configured in this environment",
    });
  });

  it("unavailable constructs a fresh error for each call", async () => {
    const [first, second] = await Effect.runPromise(
      Effect.all([Effect.flip(Customer.retrieve("a")), Effect.flip(Customer.retrieve("b"))], {
        concurrency: 1,
      }).pipe(Effect.provide(Stub.unavailable("stripe"))),
    );
    expect(first).toBeInstanceOf(PaymentsUnavailable);
    expect(first).not.toBe(second);
  });

  it("unavailable without a provider names none", async () => {
    const error = await Effect.runPromise(
      Effect.flip(Customer.retrieve("cus_1")).pipe(Effect.provide(Stub.unavailable())),
    );
    expect(error).toBeInstanceOf(PaymentsUnavailable);
    expect(error).toMatchObject({ message: "Payments are not configured in this environment" });
    assert(error instanceof PaymentsUnavailable);
    expect(error.provider).toBeUndefined();
  });
});
