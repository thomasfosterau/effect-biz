import { describe, it, expect } from "vite-plus/test";
import * as Effect from "effect/Effect";
import type * as Layer from "effect/Layer";
import * as Customer from "@thomasfosterau/effect-biz/Payments.Customer";
import * as Product from "@thomasfosterau/effect-biz/Payments.Product";
import * as Price from "@thomasfosterau/effect-biz/Payments.Price";
import * as PaymentIntent from "@thomasfosterau/effect-biz/Payments.PaymentIntent";
import * as Subscription from "@thomasfosterau/effect-biz/Payments.Subscription";
import * as Refund from "@thomasfosterau/effect-biz/Payments.Refund";
import { PaymentNetworkError, PaymentProviderError } from "@thomasfosterau/effect-biz/Payments";
import * as StripePayments from "../src/StripePayments.ts";
import { formOf, stubStripe, stubStripeTable, withTestClock } from "./support.ts";

/**
 * Canned Stripe objects, keyed by `METHOD /path`, so the neutral mapping is
 * asserted without touching the network. The stubbed API records the request
 * each capability sent.
 */
const responses = {
  "POST /v1/customers": {
    id: "cus_1",
    email: "jane@example.com",
    name: "Jane",
    phone: null,
    description: null,
    metadata: { tier: "pro" },
    created: 1700000000,
    livemode: false,
  },
  "GET /v1/customers/cus_1": {
    id: "cus_1",
    email: null,
    name: null,
    phone: null,
    description: null,
    metadata: {},
    created: 1,
    livemode: true,
  },
  "DELETE /v1/customers/cus_1": { id: "cus_1", object: "customer", deleted: true },
  "GET /v1/customers": {
    object: "list",
    has_more: true,
    data: [
      {
        id: "cus_2",
        email: null,
        name: null,
        phone: null,
        description: null,
        metadata: {},
        created: 2,
        livemode: false,
      },
    ],
  },
  "POST /v1/products": {
    id: "prod_1",
    name: "Pro Plan",
    description: "desc",
    active: true,
    metadata: {},
    created: 3,
  },
  "POST /v1/prices": {
    id: "price_1",
    product: "prod_1",
    active: true,
    currency: "usd",
    unit_amount: 1999,
    type: "recurring",
    recurring: { interval: "month", interval_count: 3 },
    metadata: {},
    created: 4,
  },
  "POST /v1/payment_intents": {
    id: "pi_1",
    amount: 2000,
    currency: "usd",
    status: "requires_confirmation",
    customer: "cus_1",
    payment_method: { id: "pm_1" },
    client_secret: "pi_1_secret",
    description: null,
    metadata: {},
    created: 5,
  },
  "POST /v1/subscriptions": {
    id: "sub_1",
    customer: "cus_1",
    status: "active",
    items: {
      object: "list",
      data: [{ id: "si_1", price: { id: "price_1" }, quantity: 2 }],
    },
    current_period_start: 100,
    current_period_end: 200,
    cancel_at_period_end: false,
    metadata: {},
    created: 6,
  },
  "POST /v1/refunds": {
    id: "re_1",
    amount: 500,
    currency: "usd",
    status: "succeeded",
    payment_intent: "pi_1",
    charge: null,
    reason: "requested_by_customer",
    metadata: {},
    created: 7,
  },
} satisfies Record<string, unknown>;

/** Run `effect` against the capabilities over a stubbed API answering from `answers`. */
const run = <A, E>(
  effect: Effect.Effect<A, E, Layer.Success<typeof StripePayments.capabilities>>,
  answers: Record<string, unknown> = responses,
) => {
  const stub = stubStripeTable(answers);
  return {
    calls: stub.calls,
    result: Effect.runPromise(
      withTestClock(
        effect.pipe(Effect.provide(StripePayments.capabilities), Effect.provide(stub.layer)),
      ),
    ),
  };
};

describe("StripePayments capabilities", () => {
  it("maps a created customer to the neutral entity", async () => {
    const { result, calls } = run(
      Customer.create({ email: "jane@example.com", metadata: { tier: "pro" } }),
    );
    const customer = await result;
    expect(customer).toBeInstanceOf(Customer.Customer);
    expect(customer.id).toBe("cus_1");
    expect(customer.email).toBe("jane@example.com");
    expect(customer.metadata.tier).toBe("pro");
    // Neutral params translated to Stripe's snake_case shape.
    expect(calls[0]).toMatchObject({
      method: "POST",
      path: "/v1/customers",
      params: formOf({ email: "jane@example.com", metadata: { tier: "pro" } }),
    });
  });

  it("maps a deleted customer", async () => {
    const { result, calls } = run(Customer.del("cus_1"));
    expect(await result).toEqual({ id: "cus_1", deleted: true });
    expect(calls[0]).toMatchObject({ method: "DELETE", path: "/v1/customers/cus_1" });
  });

  it("maps a deleted customer read back to an empty entity", async () => {
    const { result } = run(Customer.retrieve("cus_1"), {
      "GET /v1/customers/cus_1": { id: "cus_1", object: "customer", deleted: true },
    });
    const customer = await result;
    expect(customer.id).toBe("cus_1");
    expect(customer.email).toBeNull();
    expect(customer.created).toBe(0);
  });

  it("maps a customer list into a neutral page and forwards the cursor", async () => {
    const { result, calls } = run(Customer.list({ limit: 1, startingAfter: "cus_0" }));
    const page = await result;
    expect(page.hasMore).toBe(true);
    expect(page.data).toHaveLength(1);
    expect(page.data[0].id).toBe("cus_2");
    expect(calls[0]).toMatchObject({
      method: "GET",
      path: "/v1/customers",
      params: formOf({ limit: 1, starting_after: "cus_0" }),
    });
    // The next page's cursor is the last item's id.
    expect(page.nextCursor).toBe("cus_2");
  });

  it("gives the last page of a list no cursor", async () => {
    const { result } = run(Customer.list(), {
      "GET /v1/customers": { object: "list", data: [], has_more: false },
    });
    const page = await result;
    expect(page).toEqual({ data: [], hasMore: false });
    expect(page).not.toHaveProperty("nextCursor");
  });

  it("maps a product", async () => {
    const product = await run(Product.create({ name: "Pro Plan" })).result;
    expect(product.id).toBe("prod_1");
    expect(product.name).toBe("Pro Plan");
  });

  it("maps a recurring price, including the schedule", async () => {
    const { result, calls } = run(
      Price.create({
        product: "prod_1",
        currency: "usd",
        unitAmount: 1999,
        recurring: { interval: "month", intervalCount: 3 },
      }),
    );
    const price = await result;
    expect(price.unitAmount).toBe(1999);
    expect(price.type).toBe("recurring");
    expect(price.recurring?.interval).toBe("month");
    expect(price.recurring?.intervalCount).toBe(3);
    expect(calls[0]?.params).toMatchObject(
      formOf({
        product: "prod_1",
        unit_amount: 1999,
        recurring: { interval: "month", interval_count: 3 },
      }),
    );
  });

  it("sends no schedule for a forwarded `recurring: undefined`", async () => {
    const recurring: Price.CreateParams["recurring"] = undefined;
    const { result, calls } = run(
      Price.create({ product: "prod_1", currency: "usd", unitAmount: 1999, recurring }),
    );
    await result;
    expect(calls[0]?.params).toEqual(
      formOf({ product: "prod_1", currency: "usd", unit_amount: 1999 }),
    );
  });

  it("maps a payment intent and resolves expanded references to ids", async () => {
    const intent = await run(PaymentIntent.create({ amount: 2000, currency: "usd" })).result;
    expect(intent.status).toBe("requires_confirmation");
    expect(intent.customerId).toBe("cus_1");
    expect(intent.paymentMethodId).toBe("pm_1");
    expect(intent.clientSecret).toBe("pi_1_secret");
  });

  it("confirms and cancels a payment intent on their action paths", async () => {
    const answers = {
      "POST /v1/payment_intents/pi_1/confirm": responses["POST /v1/payment_intents"],
      "POST /v1/payment_intents/pi_1/cancel": responses["POST /v1/payment_intents"],
    };
    const confirmed = run(PaymentIntent.confirm("pi_1", { paymentMethod: "pm_2" }), answers);
    await confirmed.result;
    expect(confirmed.calls[0]).toMatchObject({
      method: "POST",
      path: "/v1/payment_intents/pi_1/confirm",
      params: formOf({ payment_method: "pm_2" }),
    });
    const canceled = run(PaymentIntent.cancel("pi_1"), answers);
    await canceled.result;
    expect(canceled.calls[0]).toMatchObject({
      method: "POST",
      path: "/v1/payment_intents/pi_1/cancel",
    });
  });

  it("maps a subscription, flattening items and periods", async () => {
    const { result, calls } = run(
      Subscription.create({
        customer: "cus_1",
        items: [{ price: "price_1", quantity: 2 }],
      }),
    );
    const subscription = await result;
    expect(subscription.status).toBe("active");
    expect(subscription.items).toHaveLength(1);
    expect(subscription.items[0].priceId).toBe("price_1");
    expect(subscription.items[0].quantity).toBe(2);
    expect(subscription.currentPeriodStart).toBe(100);
    expect(subscription.currentPeriodEnd).toBe(200);
    expect(calls[0]?.params).toMatchObject(formOf({ items: [{ price: "price_1", quantity: 2 }] }));
  });

  it("reads the billing period from the item on API versions that moved it there", async () => {
    const { result } = run(Subscription.retrieve("sub_1"), {
      "GET /v1/subscriptions/sub_1": {
        id: "sub_1",
        customer: { id: "cus_1" },
        status: "active",
        cancel_at_period_end: true,
        items: {
          data: [
            {
              id: "si_1",
              price: { id: "price_1" },
              current_period_start: 1_750_000_000,
              current_period_end: 1_760_000_000,
            },
          ],
        },
        created: 6,
      },
    });
    const subscription = await result;
    expect(subscription.customerId).toBe("cus_1");
    expect(subscription.currentPeriodStart).toBe(1_750_000_000);
    expect(subscription.currentPeriodEnd).toBe(1_760_000_000);
    expect(subscription.cancelAtPeriodEnd).toBe(true);
    expect(subscription.items[0].quantity).toBeNull();
  });

  it("cancels a subscription with a DELETE", async () => {
    const { result, calls } = run(Subscription.cancel("sub_1"), {
      "DELETE /v1/subscriptions/sub_1": responses["POST /v1/subscriptions"],
    });
    await result;
    expect(calls[0]).toMatchObject({ method: "DELETE", path: "/v1/subscriptions/sub_1" });
  });

  it("lists products, prices, payment intents, subscriptions and refunds with their filters", async () => {
    const answers = {
      "GET /v1/products": {
        has_more: false,
        data: [responses["POST /v1/products"]],
      },
      "GET /v1/prices": { has_more: false, data: [responses["POST /v1/prices"]] },
      "GET /v1/payment_intents": {
        has_more: false,
        data: [responses["POST /v1/payment_intents"]],
      },
      "GET /v1/subscriptions": {
        has_more: true,
        data: [responses["POST /v1/subscriptions"]],
      },
      "GET /v1/refunds": { has_more: false, data: [responses["POST /v1/refunds"]] },
    };

    const products = run(
      Product.list({ limit: 5, active: true, startingAfter: "prod_0" }),
      answers,
    );
    expect((await products.result).data[0].id).toBe("prod_1");
    expect(products.calls[0]?.params).toEqual(
      formOf({
        limit: 5,
        active: true,
        starting_after: "prod_0",
      }),
    );

    const prices = run(
      Price.list({ limit: 2, product: "prod_1", active: false, startingAfter: "price_0" }),
      answers,
    );
    expect((await prices.result).data[0].recurring?.intervalCount).toBe(3);
    expect(prices.calls[0]?.params).toEqual(
      formOf({
        limit: 2,
        product: "prod_1",
        active: false,
        starting_after: "price_0",
      }),
    );
    const allPrices = run(Price.list(), answers);
    await allPrices.result;
    expect(allPrices.calls[0]?.params).toEqual({});

    const intents = run(
      PaymentIntent.list({ limit: 1, customer: "cus_1", startingAfter: "pi_0" }),
      answers,
    );
    expect((await intents.result).data[0].id).toBe("pi_1");
    expect(intents.calls[0]?.params).toEqual(
      formOf({
        limit: 1,
        customer: "cus_1",
        starting_after: "pi_0",
      }),
    );

    const subscriptions = run(
      Subscription.list({ limit: 3, customer: "cus_1", status: "active", startingAfter: "sub_0" }),
      answers,
    );
    const page = await subscriptions.result;
    expect(page.hasMore).toBe(true);
    expect(page.data[0].id).toBe("sub_1");
    expect(subscriptions.calls[0]?.params).toEqual(
      formOf({
        limit: 3,
        customer: "cus_1",
        status: "active",
        starting_after: "sub_0",
      }),
    );
    const allSubscriptions = run(Subscription.list(), answers);
    await allSubscriptions.result;
    expect(allSubscriptions.calls[0]?.params).toEqual({});

    const refunds = run(
      Refund.list({ limit: 4, paymentIntent: "pi_1", charge: "ch_1", startingAfter: "re_0" }),
      answers,
    );
    expect((await refunds.result).data[0].id).toBe("re_1");
    expect(refunds.calls[0]?.params).toEqual(
      formOf({
        limit: 4,
        payment_intent: "pi_1",
        charge: "ch_1",
        starting_after: "re_0",
      }),
    );
  });

  it("maps a refund", async () => {
    const refund = await run(Refund.create({ paymentIntent: "pi_1", amount: 500 })).result;
    expect(refund.status).toBe("succeeded");
    expect(refund.paymentIntentId).toBe("pi_1");
    expect(refund.chargeId).toBeNull();
  });

  it("passes a transport failure through the neutral channel", async () => {
    const stub = stubStripe(() => {
      throw new TypeError("network down");
    });
    const error = await Effect.runPromise(
      withTestClock(
        Effect.flip(Customer.create({ email: "x@example.com" })).pipe(
          Effect.provide(StripePayments.capabilities),
          Effect.provide(stub.layer),
        ),
      ),
    );
    expect(error).toBeInstanceOf(PaymentNetworkError);
    expect(error.message).toContain("network down");
    // The default policy retries a connection failure twice.
    expect(stub.calls).toHaveLength(3);
  });

  it("fails a 2xx that does not decode instead of building an entity from undefined", async () => {
    const error = await run(Effect.flip(Customer.create({ email: "x@example.com" })), {
      "POST /v1/customers": { id: "cus_1", object: "customer" },
    }).result;
    expect(error).toBeInstanceOf(PaymentProviderError);
    expect(error.message).toBe("Stripe returned a malformed customer response");
  });

  it("fails a subscription with no billing period anywhere", async () => {
    const error = await run(Effect.flip(Subscription.retrieve("sub_1")), {
      "GET /v1/subscriptions/sub_1": {
        id: "sub_1",
        customer: "cus_1",
        status: "active",
        cancel_at_period_end: false,
        items: { data: [] },
        created: 6,
      },
    }).result;
    expect(error).toBeInstanceOf(PaymentProviderError);
    expect(error.message).toBe("Stripe returned a malformed subscription response");
  });

  it("fails a page whose items do not decode", async () => {
    const error = await run(Effect.flip(Refund.list()), {
      "GET /v1/refunds": { object: "list", has_more: false, data: [{ id: "re_1" }] },
    }).result;
    expect(error).toBeInstanceOf(PaymentProviderError);
    expect(error.message).toBe("Stripe returned a malformed refund list response");
  });
});
