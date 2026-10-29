import { describe, it, expect } from "vite-plus/test";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Product from "@thomasfosterau/effect-biz/Payments.Product";
import * as Price from "@thomasfosterau/effect-biz/Payments.Price";
import * as PaymentIntent from "@thomasfosterau/effect-biz/Payments.PaymentIntent";
import * as Subscription from "@thomasfosterau/effect-biz/Payments.Subscription";
import * as Refund from "@thomasfosterau/effect-biz/Payments.Refund";
import {
  PaymentInvalidRequestError,
  PaymentProviderError,
} from "@thomasfosterau/effect-biz/Payments";
import type * as PayPalPayments from "../src/PayPalPayments.ts";
import { capabilitiesOver, type PayPalCall, stubPayPal } from "./support.ts";

/**
 * A stubbed PayPal API: records every request and answers whatever
 * `responder` produces, so we can assert both the neutral mapping and the
 * request bodies the layers build — without any network.
 */
const makeFakeClient = (responder: (req: PayPalCall) => unknown) => {
  const { calls, layer } = stubPayPal(responder);
  return { client: layer, calls };
};

const provide = capabilitiesOver;

/** An RFC 3339 timestamp as whole epoch seconds, as the mapping reads it. */
const epochSeconds = (timestamp: string): number =>
  Math.floor(DateTime.toEpochMillis(DateTime.makeUnsafe(timestamp)) / 1000);

/** Run `effect` against a stub answering `body`, and return its failure. */
const failureOf = <A, E, Body>(
  effect: Effect.Effect<A, E, Layer.Success<typeof PayPalPayments.capabilities>>,
  body: (req: PayPalCall) => Body,
): Effect.Effect<E, A> =>
  Effect.flip(effect).pipe(Effect.provide(provide(makeFakeClient(body).client)));

/** {@link failureOf}, run. */
const failure = <A, E, Body>(
  effect: Effect.Effect<A, E, Layer.Success<typeof PayPalPayments.capabilities>>,
  body: (req: PayPalCall) => Body,
): Promise<E> => Effect.runPromise(failureOf(effect, body));

describe("PayPalPayments capabilities", () => {
  it("maps a catalog product", async () => {
    const { client } = makeFakeClient(() => ({
      id: "PROD-1",
      name: "Premium",
      description: "Premium plan",
      create_time: "2026-01-01T00:00:00Z",
    }));

    const product = await Effect.runPromise(
      Product.create({ name: "Premium" }).pipe(Effect.provide(provide(client))),
    );
    expect(product).toBeInstanceOf(Product.Product);
    expect(product.id).toBe("PROD-1");
    expect(product.active).toBe(true);
    expect(product.created).toBe(epochSeconds("2026-01-01T00:00:00Z"));
  });

  it("maps a billing plan to a price, formatting the amount as a decimal string", async () => {
    const { client, calls } = makeFakeClient((req) => ({
      id: "P-1",
      product_id: "PROD-1",
      status: "ACTIVE",
      billing_cycles: [
        {
          tenure_type: "REGULAR",
          frequency: { interval_unit: "MONTH", interval_count: 1 },
          pricing_scheme: {
            fixed_price: (
              req.body as { billing_cycles: { pricing_scheme: { fixed_price: unknown } }[] }
            ).billing_cycles[0].pricing_scheme.fixed_price,
          },
        },
      ],
      create_time: "2026-01-01T00:00:00Z",
    }));

    const price = await Effect.runPromise(
      Price.create({
        product: "PROD-1",
        currency: "usd",
        unitAmount: 1000,
        recurring: { interval: "month" },
      }).pipe(Effect.provide(provide(client))),
    );

    // 1000 minor units -> "10.00" major-unit string on the request...
    const body = calls[0].body as {
      billing_cycles: { pricing_scheme: { fixed_price: { value: string } } }[];
    };
    expect(body.billing_cycles[0].pricing_scheme.fixed_price.value).toBe("10.00");
    // ...and back to 1000 minor units on the response.
    expect(price.unitAmount).toBe(1000);
    expect(price.type).toBe("recurring");
    expect(price.recurring?.interval).toBe("month");
    expect(price.active).toBe(true);
  });

  it("rejects one-time prices (PayPal plans are recurring)", async () => {
    const { client } = makeFakeClient(() => ({}));
    const error = await Effect.runPromise(
      Price.create({ product: "PROD-1", currency: "usd", unitAmount: 1000 }).pipe(
        Effect.provide(provide(client)),
        Effect.flip,
      ),
    );
    expect(error).toBeInstanceOf(PaymentInvalidRequestError);
  });

  it("treats a forwarded `recurring: undefined` as a one-time price and sends nothing", async () => {
    const { client, calls } = makeFakeClient(() => ({}));
    const recurring: Price.CreateParams["recurring"] = undefined;
    const error = await Effect.runPromise(
      Price.create({ product: "PROD-1", currency: "usd", unitAmount: 1000, recurring }).pipe(
        Effect.provide(provide(client)),
        Effect.flip,
      ),
    );
    expect(error).toBeInstanceOf(PaymentInvalidRequestError);
    expect(calls).toHaveLength(0);
  });

  it("maps an order to a payment intent and converts the amount", async () => {
    const { client, calls } = makeFakeClient((req) => ({
      id: "ORD-1",
      status: "COMPLETED",
      purchase_units: [
        {
          amount: (req.body as { purchase_units: { amount: unknown }[] }).purchase_units[0].amount,
          custom_id: "cus_x",
        },
      ],
      create_time: "2026-01-02T00:00:00Z",
    }));

    const intent = await Effect.runPromise(
      PaymentIntent.create({
        amount: 2000,
        currency: "usd",
        customer: "cus_x",
      }).pipe(Effect.provide(provide(client))),
    );

    const body = calls[0].body as {
      purchase_units: { amount: { value: string } }[];
    };
    expect(body.purchase_units[0].amount.value).toBe("20.00");
    expect(intent.amount).toBe(2000);
    expect(intent.status).toBe("succeeded");
    expect(intent.customerId).toBe("cus_x");
  });

  it("captures an order when a payment intent is confirmed", async () => {
    const { client, calls } = makeFakeClient(() => ({
      id: "ORD-1",
      status: "COMPLETED",
      purchase_units: [{ amount: { currency_code: "USD", value: "20.00" } }],
    }));

    const intent = await Effect.runPromise(
      PaymentIntent.confirm("ORD-1").pipe(Effect.provide(provide(client))),
    );
    expect(calls[0].method).toBe("POST");
    expect(calls[0].path).toBe("/v2/checkout/orders/ORD-1/capture");
    expect(intent.status).toBe("succeeded");
  });

  it("maps a subscription, using the first item's price as the plan", async () => {
    const { client, calls } = makeFakeClient(() => ({
      id: "SUB-1",
      status: "ACTIVE",
      plan_id: "P-1",
      custom_id: "cus_x",
      quantity: "2",
      start_time: "2026-01-01T00:00:00Z",
      billing_info: { next_billing_time: "2026-02-01T00:00:00Z" },
      create_time: "2026-01-01T00:00:00Z",
    }));

    const subscription = await Effect.runPromise(
      Subscription.create({
        customer: "cus_x",
        items: [{ price: "P-1", quantity: 2 }],
      }).pipe(Effect.provide(provide(client))),
    );

    expect(calls[0].body).toMatchObject({
      plan_id: "P-1",
      quantity: "2",
      custom_id: "cus_x",
    });
    expect(subscription.status).toBe("active");
    expect(subscription.items[0].priceId).toBe("P-1");
    expect(subscription.items[0].quantity).toBe(2);
    expect(subscription.customerId).toBe("cus_x");
    expect(subscription.currentPeriodEnd).toBe(epochSeconds("2026-02-01T00:00:00Z"));
  });

  it("refunds a capture, resolving the currency for a partial amount", async () => {
    const { client, calls } = makeFakeClient((req) => {
      if (req.method === "GET") {
        return { id: "CAP-1", amount: { currency_code: "USD", value: "20.00" } };
      }
      return {
        id: "REF-1",
        status: "COMPLETED",
        amount: (req.body as { amount: { currency_code: string; value: string } }).amount,
      };
    });

    const refund = await Effect.runPromise(
      Refund.create({ charge: "CAP-1", amount: 500 }).pipe(Effect.provide(provide(client))),
    );

    // Looked up the capture (GET) to learn the currency, then posted the refund.
    expect(calls[0]).toMatchObject({
      method: "GET",
      path: "/v2/payments/captures/CAP-1",
    });
    expect(calls[1].path).toBe("/v2/payments/captures/CAP-1/refund");
    expect((calls[1].body as { amount: { value: string } }).amount.value).toBe("5.00");
    expect(refund.amount).toBe(500);
    expect(refund.status).toBe("succeeded");
  });

  it("resolves the capture id from an order when refunding a payment intent", async () => {
    const { client, calls } = makeFakeClient((req) => {
      if (req.path.startsWith("/v2/checkout/orders/")) {
        return {
          id: "ORD-1",
          status: "COMPLETED",
          purchase_units: [{ payments: { captures: [{ id: "CAP-2" }] } }],
        };
      }
      return { id: "REF-2", status: "PENDING", amount: { currency_code: "USD", value: "20.00" } };
    });

    const refund = await Effect.runPromise(
      Refund.create({ paymentIntent: "ORD-1" }).pipe(Effect.provide(provide(client))),
    );

    expect(calls[0].path).toBe("/v2/checkout/orders/ORD-1");
    expect(calls[1].path).toBe("/v2/payments/captures/CAP-2/refund");
    expect(refund.status).toBe("pending");
  });

  it("fails neutrally for operations PayPal does not support", async () => {
    const { client } = makeFakeClient(() => ({}));

    const listError = await Effect.runPromise(
      Subscription.list().pipe(Effect.provide(provide(client)), Effect.flip),
    );
    expect(listError).toBeInstanceOf(PaymentInvalidRequestError);

    const cancelError = await Effect.runPromise(
      PaymentIntent.cancel("ORD-1").pipe(Effect.provide(provide(client)), Effect.flip),
    );
    expect(cancelError).toBeInstanceOf(PaymentInvalidRequestError);
  });
});

describe("PayPalPayments create and update options", () => {
  const PRODUCT = { id: "PROD-1", name: "Premium", create_time: "2026-01-01T00:00:00Z" };
  const PLAN = {
    id: "P-1",
    product_id: "PROD-1",
    status: "CREATED",
    billing_cycles: [
      {
        tenure_type: "REGULAR",
        frequency: { interval_unit: "MONTH", interval_count: 1 },
        pricing_scheme: { fixed_price: { currency_code: "USD", value: "10.00" } },
      },
    ],
    create_time: "2026-01-01T00:00:00Z",
  };
  const monthly = {
    product: "PROD-1",
    currency: "usd",
    unitAmount: 1000,
    recurring: { interval: "month" },
  } as const;

  /** The failure of `effect` and the calls it sent. */
  const refused = async (
    effect: Effect.Effect<unknown, unknown, Layer.Success<typeof PayPalPayments.capabilities>>,
  ) => {
    const { client, calls } = makeFakeClient(() => PRODUCT);
    const error = await Effect.runPromise(
      Effect.flip(effect).pipe(Effect.provide(provide(client))),
    );
    return { error, calls };
  };

  it.each([
    ["an inactive product", Product.create({ name: "P", active: false }), "inactive products"],
    [
      "product metadata on create",
      Product.create({ name: "P", metadata: { tier: "pro" } }),
      "product metadata",
    ],
    [
      "a product rename",
      Product.update("PROD-1", { name: "New", description: "d" }),
      "renaming a product",
    ],
    [
      "deactivating a product",
      Product.update("PROD-1", { active: false, description: "d" }),
      "inactive products",
    ],
    [
      "product metadata on update",
      Product.update("PROD-1", { metadata: { tier: "pro" }, description: "d" }),
      "product metadata",
    ],
    [
      "price metadata on create",
      Price.create({ ...monthly, metadata: { a: "b" } }),
      "price metadata",
    ],
    [
      "price metadata on update",
      Price.update("P-1", { active: true, metadata: { a: "b" } }),
      "price metadata",
    ],
  ] as const)("refuses %s, sending nothing", async (_name, effect, operation) => {
    const { error, calls } = await refused(effect);
    expect(error).toBeInstanceOf(PaymentInvalidRequestError);
    expect(error).toMatchObject({ message: `PayPal does not support ${operation}` });
    expect(calls).toEqual([]);
  });

  it("accepts what PayPal already holds: an active product and empty metadata", async () => {
    const { client, calls } = makeFakeClient(() => PRODUCT);
    const product = await Effect.runPromise(
      Product.create({ name: "Premium", active: true, metadata: {} }).pipe(
        Effect.provide(provide(client)),
      ),
    );
    expect(product.active).toBe(true);
    expect(calls).toHaveLength(1);
  });

  it("creates an inactive price as a plan in PayPal's CREATED state", async () => {
    const { client, calls } = makeFakeClient(() => PLAN);
    const price = await Effect.runPromise(
      Price.create({ ...monthly, active: false }).pipe(Effect.provide(provide(client))),
    );
    expect(calls[0].body).toMatchObject({ status: "CREATED" });
    expect(price.active).toBe(false);
  });

  it("sends no plan status for an active price, which PayPal creates active", async () => {
    const { client, calls } = makeFakeClient(() => ({ ...PLAN, status: "ACTIVE" }));
    await Effect.runPromise(Price.create(monthly).pipe(Effect.provide(provide(client))));
    expect(calls[0].body).not.toHaveProperty("status");
  });
});

describe("PayPalPayments list paging", () => {
  const product = (id: string) => ({ id, name: id, create_time: "2026-01-01T00:00:00Z" });
  /** A two-page product collection, answered by the `page` query (1 when absent). */
  const twoPages = (call: PayPalCall) =>
    call.query.page === "2"
      ? { products: [product("PROD-3")], links: [] }
      : {
          products: [product("PROD-1"), product("PROD-2")],
          links: [{ rel: "next", href: "https://api-m.paypal.com/v1/catalogs/products?page=2" }],
        };

  it("lists the next page with the previous page's nextCursor", async () => {
    const { client, calls } = makeFakeClient(twoPages);
    const list = (startingAfter?: string) =>
      Effect.runPromise(
        Product.list({ limit: 2, startingAfter }).pipe(Effect.provide(provide(client))),
      );

    const first = await list();
    expect(first.hasMore).toBe(true);
    expect(first.nextCursor).toBe("page=2&size=2");
    // The first page sends no `page`: PayPal starts at 1.
    expect(calls[0].query).toEqual({ page_size: "2" });

    const second = await list(first.nextCursor);
    expect(calls[1].query).toEqual({ page_size: "2", page: "2" });
    expect(second.data.map((item) => item.id)).toEqual(["PROD-3"]);
    expect(second.hasMore).toBe(false);
    expect(second).not.toHaveProperty("nextCursor");
  });

  it("pages prices (billing plans) the same way, keeping the product filter", async () => {
    const { client, calls } = makeFakeClient(() => ({ plans: [], links: [] }));
    await Effect.runPromise(
      Price.list({ product: "PROD-1", startingAfter: "page=3" }).pipe(
        Effect.provide(provide(client)),
      ),
    );
    expect(calls[0].query).toEqual({ product_id: "PROD-1", page: "3" });
  });

  it.each<
    readonly [
      string,
      Effect.Effect<unknown, unknown, Layer.Success<typeof PayPalPayments.capabilities>>,
    ]
  >([
    ["an item id", Product.list({ startingAfter: "PROD-1" })],
    ["a cursor for another limit", Product.list({ limit: 5, startingAfter: "page=2&size=2" })],
    ["the active filter on products", Product.list({ active: true })],
    ["the active filter on prices", Price.list({ active: false })],
  ])("refuses %s, sending nothing", async (_name, effect) => {
    const { client, calls } = makeFakeClient(twoPages);
    const error = await Effect.runPromise(
      Effect.flip(effect).pipe(Effect.provide(provide(client))),
    );
    expect(error).toBeInstanceOf(PaymentInvalidRequestError);
    expect(calls).toEqual([]);
  });
});

describe("PayPalPayments decoding", () => {
  /** Run `effect` against a client answering `body`, to its failure. */

  it("fails a product missing its name with a provider error", async () => {
    const error = await failure(Product.retrieve("PROD-1"), () => ({ id: "PROD-1" }));
    expect(error).toBeInstanceOf(PaymentProviderError);
    expect(error).toMatchObject({
      provider: "paypal",
      message: "PayPal returned a malformed product response",
    });
  });

  it("fails a plan whose price is not a decimal string with a provider error", async () => {
    const error = await failure(Price.retrieve("P-1"), () => ({
      id: "P-1",
      billing_cycles: [
        {
          tenure_type: "REGULAR",
          pricing_scheme: { fixed_price: { currency_code: "USD", value: "ten" } },
        },
      ],
    }));
    expect(error).toBeInstanceOf(PaymentProviderError);
    expect(error).toMatchObject({ message: "PayPal returned a malformed plan response" });
  });

  it("fails a plan whose fixed price has more decimals than its currency allows", async () => {
    const error = await failure(Price.retrieve("P-1"), () => ({
      id: "P-1",
      billing_cycles: [
        {
          tenure_type: "REGULAR",
          pricing_scheme: { fixed_price: { currency_code: "USD", value: "10.005" } },
        },
      ],
    }));
    expect(error).toBeInstanceOf(PaymentProviderError);
    expect(error).toMatchObject({ message: "PayPal returned a malformed plan response" });
  });

  it("fails a product list whose collection is not an array with a provider error", async () => {
    const error = await failure(Product.list(), () => ({ products: "PROD-1" }));
    expect(error).toBeInstanceOf(PaymentProviderError);
    expect(error).toMatchObject({ message: "PayPal returned a malformed product list response" });
  });

  it("reads a list page without its collection as an empty page", async () => {
    const { client } = makeFakeClient(() => ({ links: [] }));
    const products = await Effect.runPromise(Product.list().pipe(Effect.provide(provide(client))));
    const prices = await Effect.runPromise(Price.list().pipe(Effect.provide(provide(client))));
    expect(products).toEqual({ data: [], hasMore: false });
    expect(prices).toEqual({ data: [], hasMore: false });
  });

  it("fails a plan whose interval count is not a positive integer with a provider error", async () => {
    await Effect.runPromise(
      Effect.forEach(
        [0, -1, 1.5],
        (interval_count) =>
          failureOf(Price.retrieve("P-1"), () => ({
            id: "P-1",
            billing_cycles: [
              { tenure_type: "REGULAR", frequency: { interval_unit: "MONTH", interval_count } },
            ],
          })).pipe(Effect.map((error) => expect(error).toBeInstanceOf(PaymentProviderError))),
        { concurrency: 1, discard: true },
      ),
    );
  });

  it("fails a subscription whose quantity is not a whole number with a provider error", async () => {
    await Effect.runPromise(
      Effect.forEach(
        ["2.5", "two", "-1"],
        (quantity) =>
          failureOf(Subscription.retrieve("I-1"), () => ({
            id: "I-1",
            status: "ACTIVE",
            quantity,
          })).pipe(
            Effect.map((error) => {
              expect(error).toBeInstanceOf(PaymentProviderError);
              expect(error).toMatchObject({
                message: "PayPal returned a malformed subscription response",
              });
            }),
          ),
        { concurrency: 1, discard: true },
      ),
    );
  });

  it("fails a partial refund whose capture has no amount, rather than assuming USD", async () => {
    const { client, calls } = makeFakeClient(() => ({ id: "CAP-1", status: "COMPLETED" }));
    const error = await Effect.runPromise(
      Refund.create({ charge: "CAP-1", amount: 500 }).pipe(
        Effect.provide(provide(client)),
        Effect.flip,
      ),
    );
    expect(error).toBeInstanceOf(PaymentProviderError);
    expect(error).toMatchObject({ message: "PayPal returned a malformed capture response" });
    expect(calls.map((call) => call.path)).toEqual(["/v2/payments/captures/CAP-1"]);
  });

  it("fails an order whose status is not a string with a provider error", async () => {
    const error = await failure(PaymentIntent.retrieve("ORD-1"), () => ({
      id: "ORD-1",
      status: 1,
    }));
    expect(error).toBeInstanceOf(PaymentProviderError);
    expect(error).toMatchObject({ message: "PayPal returned a malformed order response" });
  });

  it("fails a subscription and a refund answered with an empty body with a provider error", async () => {
    const subscription = await failure(Subscription.retrieve("I-1"), () => ({}));
    expect(subscription).toBeInstanceOf(PaymentProviderError);
    const refund = await failure(Refund.retrieve("REF-1"), () => ({}));
    expect(refund).toBeInstanceOf(PaymentProviderError);
  });

  it("fails a refund whose order lookup is malformed, before refunding anything", async () => {
    const { client, calls } = makeFakeClient(() => ({ id: "ORD-1" }));
    const error = await Effect.runPromise(
      Refund.create({ paymentIntent: "ORD-1" }).pipe(Effect.provide(provide(client)), Effect.flip),
    );
    expect(error).toBeInstanceOf(PaymentProviderError);
    expect(calls.map((call) => call.path)).toEqual(["/v2/checkout/orders/ORD-1"]);
  });

  it("fails a partial refund whose capture lookup is malformed, before refunding anything", async () => {
    const { client, calls } = makeFakeClient(() => ({
      id: "CAP-1",
      amount: { currency_code: "USD" },
    }));
    const error = await Effect.runPromise(
      Refund.create({ charge: "CAP-1", amount: 500 }).pipe(
        Effect.provide(provide(client)),
        Effect.flip,
      ),
    );
    expect(error).toBeInstanceOf(PaymentProviderError);
    expect(error).toMatchObject({ message: "PayPal returned a malformed capture response" });
    expect(calls.map((call) => call.path)).toEqual(["/v2/payments/captures/CAP-1"]);
  });
});

describe("PayPalPayments money", () => {
  /** An order echoing the amount it was created with. */
  const echoOrder = (req: PayPalCall) => ({
    id: "ORD-1",
    status: "CREATED",
    purchase_units: [
      { amount: (req.body as { purchase_units: { amount: unknown }[] }).purchase_units[0].amount },
    ],
  });

  it("formats HUF, TWD and JPY without decimals, as PayPal requires", async () => {
    await Effect.runPromise(
      Effect.forEach(
        ["huf", "twd", "jpy"],
        (currency) => {
          const { client, calls } = makeFakeClient(echoOrder);
          return PaymentIntent.create({ amount: 1000, currency }).pipe(
            Effect.provide(provide(client)),
            Effect.map((intent) => {
              const body = calls[0].body as { purchase_units: { amount: { value: string } }[] };
              expect(body.purchase_units[0].amount.value).toBe("1000");
              expect(intent.amount).toBe(1000);
            }),
          );
        },
        { concurrency: 1, discard: true },
      ),
    );
  });

  it("formats and reads back a three-decimal currency exactly", async () => {
    const { client, calls } = makeFakeClient(echoOrder);
    const intent = await Effect.runPromise(
      PaymentIntent.create({ amount: 12345, currency: "kwd" }).pipe(
        Effect.provide(provide(client)),
      ),
    );
    const body = calls[0].body as { purchase_units: { amount: { value: string } }[] };
    expect(body.purchase_units[0].amount.value).toBe("12.345");
    expect(intent.amount).toBe(12345);
  });

  it("fails an order whose amount has more decimals than its currency allows", async () => {
    await Effect.runPromise(
      Effect.forEach(
        [
          { currency_code: "USD", value: "10.005" },
          { currency_code: "HUF", value: "10.00" },
          { currency_code: "USD", value: "90071992547409.93" },
        ],
        (amount) =>
          failureOf(PaymentIntent.retrieve("ORD-1"), () => ({
            id: "ORD-1",
            status: "COMPLETED",
            purchase_units: [{ amount }],
          })).pipe(
            Effect.map((error) => {
              expect(error).toBeInstanceOf(PaymentProviderError);
              expect(error).toMatchObject({
                message: "PayPal returned a malformed order response",
              });
            }),
          ),
        { concurrency: 1, discard: true },
      ),
    );
  });

  it("fails a refund whose amount has excess decimals with a provider error", async () => {
    const { client } = makeFakeClient(() => ({
      id: "REF-1",
      status: "COMPLETED",
      amount: { currency_code: "JPY", value: "100.5" },
    }));
    const error = await Effect.runPromise(
      Refund.retrieve("REF-1").pipe(Effect.provide(provide(client)), Effect.flip),
    );
    expect(error).toBeInstanceOf(PaymentProviderError);
    expect(error).toMatchObject({ message: "PayPal returned a malformed refund response" });
  });

  it("rejects a fractional amount before sending anything", async () => {
    const { client, calls } = makeFakeClient(echoOrder);
    const orderError = await Effect.runPromise(
      PaymentIntent.create({ amount: 10.5, currency: "usd" }).pipe(
        Effect.provide(provide(client)),
        Effect.flip,
      ),
    );
    expect(orderError).toBeInstanceOf(PaymentInvalidRequestError);
    expect(orderError).toMatchObject({ param: "amount" });

    const priceError = await Effect.runPromise(
      Price.create({
        product: "PROD-1",
        currency: "usd",
        unitAmount: Number.MAX_SAFE_INTEGER + 2,
        recurring: { interval: "month" },
      }).pipe(Effect.provide(provide(client)), Effect.flip),
    );
    expect(priceError).toBeInstanceOf(PaymentInvalidRequestError);
    expect(priceError).toMatchObject({ param: "unitAmount" });
    expect(calls).toEqual([]);
  });

  it("rejects a negative order or price amount before sending anything", async () => {
    const { client, calls } = makeFakeClient(echoOrder);
    const orderError = await Effect.runPromise(
      PaymentIntent.create({ amount: -100, currency: "usd" }).pipe(
        Effect.provide(provide(client)),
        Effect.flip,
      ),
    );
    expect(orderError).toBeInstanceOf(PaymentInvalidRequestError);
    expect(orderError).toMatchObject({ param: "amount" });

    const priceError = await Effect.runPromise(
      Price.create({
        product: "PROD-1",
        currency: "jpy",
        unitAmount: -1,
        recurring: { interval: "month" },
      }).pipe(Effect.provide(provide(client)), Effect.flip),
    );
    expect(priceError).toBeInstanceOf(PaymentInvalidRequestError);
    expect(priceError).toMatchObject({ param: "unitAmount" });
    expect(calls).toEqual([]);
  });

  it("rejects a negative partial-refund amount before sending anything", async () => {
    const { client, calls } = makeFakeClient(() => ({
      id: "CAP-1",
      amount: { currency_code: "USD", value: "10.00" },
    }));
    const error = await Effect.runPromise(
      Refund.create({ charge: "CAP-1", amount: -500 }).pipe(
        Effect.provide(provide(client)),
        Effect.flip,
      ),
    );
    expect(error).toBeInstanceOf(PaymentInvalidRequestError);
    expect(error).toMatchObject({ param: "amount" });

    // Resolving the capture from an order is skipped too.
    const viaOrder = await Effect.runPromise(
      Refund.create({ paymentIntent: "ORD-1", amount: -500 }).pipe(
        Effect.provide(provide(client)),
        Effect.flip,
      ),
    );
    expect(viaOrder).toBeInstanceOf(PaymentInvalidRequestError);
    expect(calls).toEqual([]);
  });

  it("rejects a fractional partial-refund amount before sending anything", async () => {
    const { client, calls } = makeFakeClient(() => ({
      id: "CAP-1",
      amount: { currency_code: "USD", value: "10.00" },
    }));
    const error = await Effect.runPromise(
      Refund.create({ charge: "CAP-1", amount: 2.5 }).pipe(
        Effect.provide(provide(client)),
        Effect.flip,
      ),
    );
    expect(error).toBeInstanceOf(PaymentInvalidRequestError);
    expect(calls).toEqual([]);
  });
});
