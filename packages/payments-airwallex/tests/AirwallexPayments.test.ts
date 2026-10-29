import { describe, it, expect } from "vite-plus/test";
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Customer from "@thomasfosterau/effect-biz/Payments.Customer";
import * as PaymentIntent from "@thomasfosterau/effect-biz/Payments.PaymentIntent";
import * as Refund from "@thomasfosterau/effect-biz/Payments.Refund";
import {
  PaymentInvalidRequestError,
  PaymentProviderError,
} from "@thomasfosterau/effect-biz/Payments";
import { AirwallexClient, type AirwallexRequest } from "../src/Airwallex.ts";
import * as AirwallexPayments from "../src/AirwallexPayments.ts";

/** `JSON.stringify` through `Schema`: the JSON text a request body is sent as. */
const toJsonText = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

/**
 * A fake Airwallex client. It records every request and returns whatever the
 * provided responder produces, so we can assert both the neutral mapping and
 * the request bodies the layers build — without any network.
 */
const makeFakeClient = (responder: (req: AirwallexRequest) => unknown) => {
  const calls: AirwallexRequest[] = [];
  const client = AirwallexClient.of({
    request: (req: AirwallexRequest) => {
      calls.push(req);
      return Effect.succeed(responder(req));
    },
  });
  return { client, calls };
};

const provide = (client: typeof AirwallexClient.Service) =>
  Layer.provide(AirwallexPayments.capabilities, Layer.succeed(AirwallexClient, client));

describe("AirwallexPayments capabilities", () => {
  it("maps a created customer, composing the name from first/last", async () => {
    const { client, calls } = makeFakeClient(() => ({
      id: "cus_aw",
      email: "jane@example.com",
      first_name: "Jane",
      last_name: "Smith",
      phone_number: "+15555550123",
      metadata: { tier: "pro" },
      created_at: "2026-01-01T00:00:00Z",
    }));

    const customer = await Effect.runPromise(
      Customer.create({ email: "jane@example.com", name: "Jane Smith" }).pipe(
        Effect.provide(provide(client)),
      ),
    );

    expect(customer).toBeInstanceOf(Customer.Customer);
    expect(customer.id).toBe("cus_aw");
    expect(customer.name).toBe("Jane Smith");
    expect(customer.phone).toBe("+15555550123");
    // 2026-01-01T00:00:00Z in Unix seconds.
    expect(customer.created).toBe(1_767_225_600);
    // Neutral `name` is sent as Airwallex `first_name`.
    expect(calls[0].body).toMatchObject({ first_name: "Jane Smith" });
  });

  it("converts minor units to major units on the way out, and back on the way in", async () => {
    const { client, calls } = makeFakeClient((req) => ({
      id: "int_aw",
      amount: (req.body as { amount: number }).amount,
      currency: "USD",
      status: "SUCCEEDED",
      customer_id: "cus_aw",
      created_at: "2026-01-02T00:00:00Z",
    }));

    const intent = await Effect.runPromise(
      PaymentIntent.create({ amount: 2000, currency: "usd" }).pipe(Effect.provide(provide(client))),
    );

    // 2000 minor units -> 20.00 major units on the request...
    expect(calls[0].body).toMatchObject({ amount: 20, currency: "usd" });
    // ...and 20.00 major units -> 2000 minor units on the response.
    expect(intent.amount).toBe(2000);
    expect(intent.status).toBe("succeeded");
    expect(intent.currency).toBe("usd");
  });

  it("treats zero-decimal currencies (JPY) as 1:1", async () => {
    const { client, calls } = makeFakeClient((req) => ({
      id: "int_jpy",
      amount: (req.body as { amount: number }).amount,
      currency: "JPY",
      status: "REQUIRES_PAYMENT_METHOD",
      created_at: "2026-01-02T00:00:00Z",
    }));

    const intent = await Effect.runPromise(
      PaymentIntent.create({ amount: 2000, currency: "jpy" }).pipe(Effect.provide(provide(client))),
    );

    expect(calls[0].body).toMatchObject({ amount: 2000 });
    expect(intent.amount).toBe(2000);
    expect(intent.status).toBe("requires_payment_method");
  });

  it("resolves the currency from the payment intent for a partial refund", async () => {
    const { client, calls } = makeFakeClient((req) => {
      if (req.method === "GET") {
        return { id: "int_aw", amount: 20, currency: "USD", status: "SUCCEEDED" };
      }
      return {
        id: "ref_aw",
        amount: (req.body as { amount: number }).amount,
        currency: "USD",
        status: "RECEIVED",
        payment_intent_id: "int_aw",
      };
    });

    const refund = await Effect.runPromise(
      Refund.create({ paymentIntent: "int_aw", amount: 500 }).pipe(Effect.provide(provide(client))),
    );

    // The layer looked up the intent (GET) then posted the refund (POST).
    expect(calls[0].method).toBe("GET");
    expect(calls[1].method).toBe("POST");
    // 500 minor units -> 5.00 major units in the request body.
    expect(calls[1].body).toMatchObject({ amount: 5, payment_intent_id: "int_aw" });
    expect(refund.amount).toBe(500);
    expect(refund.status).toBe("pending"); // RECEIVED -> pending
    expect(refund.paymentIntentId).toBe("int_aw");
  });

  it("fails neutrally for operations Airwallex does not support", async () => {
    const { client } = makeFakeClient(() => ({}));

    const delError = await Effect.runPromise(
      Customer.del("cus_aw").pipe(Effect.provide(provide(client)), Effect.flip),
    );
    expect(delError).toBeInstanceOf(PaymentInvalidRequestError);
    expect(delError.message).toContain("does not support");

    const updateError = await Effect.runPromise(
      PaymentIntent.update("int_aw", {}).pipe(Effect.provide(provide(client)), Effect.flip),
    );
    expect(updateError).toBeInstanceOf(PaymentInvalidRequestError);
  });

  it("refuses a customer description on create and update, sending nothing", async () => {
    const { client, calls } = makeFakeClient(() => ({ id: "cus_aw" }));

    const createError = await Effect.runPromise(
      Customer.create({ email: "jane@example.com", description: "VIP" }).pipe(
        Effect.provide(provide(client)),
        Effect.flip,
      ),
    );
    expect(createError).toBeInstanceOf(PaymentInvalidRequestError);
    expect(createError.message).toBe("Airwallex does not support customer descriptions");

    const updateError = await Effect.runPromise(
      Customer.update("cus_aw", { description: "VIP" }).pipe(
        Effect.provide(provide(client)),
        Effect.flip,
      ),
    );
    expect(updateError).toBeInstanceOf(PaymentInvalidRequestError);
    expect(calls).toEqual([]);
  });
});

describe("AirwallexPayments list paging", () => {
  const customer = (id: string) => ({ id, created_at: "2026-01-01T00:00:00Z" });
  /** A two-page customer list, answered by `page_num` (0 when absent). */
  const twoPages = (req: AirwallexRequest) =>
    req.query?.page_num === 1
      ? { items: [customer("cus_3")], has_more: false }
      : { items: [customer("cus_1"), customer("cus_2")], has_more: true };

  it("lists the next page with the previous page's nextCursor", async () => {
    const { client, calls } = makeFakeClient(twoPages);
    const list = (startingAfter?: string) =>
      Effect.runPromise(
        Customer.list({ limit: 2, startingAfter }).pipe(Effect.provide(provide(client))),
      );

    const first = await list();
    expect(first.hasMore).toBe(true);
    expect(first.nextCursor).toBe("page=1&size=2");
    // The first page sends no `page_num`: Airwallex starts at 0.
    expect(calls[0].query).toEqual({ page_size: 2, page_num: undefined });

    const second = await list(first.nextCursor);
    expect(calls[1].query).toEqual({ page_size: 2, page_num: 1 });
    expect(second.data.map((item) => item.id)).toEqual(["cus_3"]);
    expect(second.hasMore).toBe(false);
    expect(second).not.toHaveProperty("nextCursor");
  });

  it("pages payment intents and refunds the same way, keeping their filters", async () => {
    const { client, calls } = makeFakeClient(() => ({ items: [], has_more: false }));
    const run = <A, E>(
      effect: Effect.Effect<A, E, Layer.Success<typeof AirwallexPayments.capabilities>>,
    ) => Effect.runPromise(effect.pipe(Effect.provide(provide(client))));
    await run(PaymentIntent.list({ customer: "cus_1", startingAfter: "page=2" }));
    await run(Refund.list({ paymentIntent: "int_1", startingAfter: "page=4" }));
    expect(calls[0].query).toEqual({ page_size: undefined, customer_id: "cus_1", page_num: 2 });
    expect(calls[1].query).toEqual({
      page_size: undefined,
      payment_intent_id: "int_1",
      page_num: 4,
    });
  });

  it.each<
    readonly [
      string,
      Effect.Effect<unknown, unknown, Layer.Success<typeof AirwallexPayments.capabilities>>,
    ]
  >([
    ["an item id", Customer.list({ startingAfter: "cus_1" })],
    ["a cursor for another limit", Customer.list({ limit: 5, startingAfter: "page=1&size=2" })],
    ["the email filter on customers", Customer.list({ email: "jane@example.com" })],
    ["the charge filter on refunds", Refund.list({ charge: "ch_1" })],
  ])("refuses %s, sending nothing", async (_name, effect) => {
    const { client, calls } = makeFakeClient(twoPages);
    const error = await Effect.runPromise(
      Effect.flip(effect).pipe(Effect.provide(provide(client))),
    );
    expect(error).toBeInstanceOf(PaymentInvalidRequestError);
    expect(calls).toEqual([]);
  });
});

describe("AirwallexPayments decoding", () => {
  /** Run `effect` against a client answering `body`, to its failure. */
  const failure = <E>(
    effect: Effect.Effect<unknown, E, Layer.Success<typeof AirwallexPayments.capabilities>>,
    body: (req: AirwallexRequest) => unknown,
  ): Promise<E> =>
    Effect.runPromise(
      Effect.flip(effect).pipe(Effect.provide(provide(makeFakeClient(body).client))),
    );

  it("fails a customer missing its id with a provider error", async () => {
    const error = await failure(Customer.retrieve("cus_aw"), () => ({ email: "a@b.com" }));
    expect(error).toBeInstanceOf(PaymentProviderError);
    expect(error).toMatchObject({
      provider: "airwallex",
      message: "Airwallex returned a malformed customer response",
    });
  });

  it("fails a payment intent whose amount is a string with a provider error", async () => {
    const error = await failure(PaymentIntent.retrieve("int_aw"), () => ({
      id: "int_aw",
      amount: "10.00",
      currency: "USD",
      status: "SUCCEEDED",
    }));
    expect(error).toBeInstanceOf(PaymentProviderError);
    expect(error).toMatchObject({
      message: "Airwallex returned a malformed payment intent response",
    });
  });

  it("fails a list without has_more with a provider error", async () => {
    const error = await failure(Refund.list(), () => ({ items: [] }));
    expect(error).toBeInstanceOf(PaymentProviderError);
    expect(error).toMatchObject({ message: "Airwallex returned a malformed refund list response" });
  });

  it("fails a whole page when one item is malformed", async () => {
    const error = await failure(Customer.list(), () => ({
      items: [{ id: "cus_1" }, { email: "no-id@example.com" }],
      has_more: false,
    }));
    expect(error).toBeInstanceOf(PaymentProviderError);
  });

  it("fails a partial refund whose payment intent lookup is malformed, before refunding", async () => {
    const { client, calls } = makeFakeClient(() => ({ id: "int_aw" }));
    const error = await Effect.runPromise(
      Refund.create({ paymentIntent: "int_aw", amount: 500 }).pipe(
        Effect.provide(provide(client)),
        Effect.flip,
      ),
    );
    expect(error).toBeInstanceOf(PaymentProviderError);
    expect(calls.map((call) => call.path)).toEqual(["/api/v1/pa/payment_intents/int_aw"]);
  });

  it("keeps only the string metadata values instead of failing on others", async () => {
    const { client } = makeFakeClient(() => ({
      id: "cus_aw",
      metadata: { tier: "pro", seats: 3, flags: { beta: true }, note: null },
    }));
    const customer = await Effect.runPromise(
      Customer.retrieve("cus_aw").pipe(Effect.provide(provide(client))),
    );
    expect(customer.metadata).toEqual({ tier: "pro" });
  });
});

describe("AirwallexPayments money (effect-finance#68)", () => {
  const intent =
    (amount: number, currency = "USD") =>
    () => ({
      id: "int_aw",
      amount,
      currency,
      status: "SUCCEEDED",
    });

  const retrieveFailure = (body: () => unknown) =>
    Effect.runPromise(
      PaymentIntent.retrieve("int_aw").pipe(
        Effect.provide(provide(makeFakeClient(body).client)),
        Effect.flip,
      ),
    );

  it("fails a payment intent with more decimals than its currency allows (10.005 USD)", async () => {
    const error = await retrieveFailure(intent(10.005));
    expect(error).toBeInstanceOf(PaymentProviderError);
    expect(error).toMatchObject({
      message: "Airwallex returned a malformed payment intent response",
    });
  });

  it("fails a refund with more decimals than its currency allows", async () => {
    const error = await Effect.runPromise(
      Refund.retrieve("rfd_aw").pipe(
        Effect.provide(
          provide(
            makeFakeClient(() => ({
              id: "rfd_aw",
              amount: 10.5,
              currency: "JPY",
              status: "SUCCEEDED",
            })).client,
          ),
        ),
        Effect.flip,
      ),
    );
    expect(error).toBeInstanceOf(PaymentProviderError);
    expect(error).toMatchObject({ message: "Airwallex returned a malformed refund response" });
  });

  it("decodes a large unambiguous amount exactly (35184372088831.99 USD)", async () => {
    const { client } = makeFakeClient(intent(35184372088831.99));
    const result = await Effect.runPromise(
      PaymentIntent.retrieve("int_aw").pipe(Effect.provide(provide(client))),
    );
    expect(result.amount).toBe(3518437208883199);
  });

  it("fails an amount whose double is ambiguous (45035996273704.95 USD) instead of guessing", async () => {
    const error = await retrieveFailure(intent(45035996273704.95));
    expect(error).toBeInstanceOf(PaymentProviderError);
  });

  it("fails amounts in exponent notation instead of rounding them", async () => {
    const errors = await Promise.all(
      Arr.map(
        [
          [1e-7, "USD"],
          [1e21, "JPY"],
        ] as const,
        ([amount, currency]) => retrieveFailure(intent(amount, currency)),
      ),
    );
    expect(errors).toHaveLength(2);
    Arr.forEach(errors, (error) => expect(error).toBeInstanceOf(PaymentProviderError));
  });

  it("fails an amount beyond the safe-integer range in minor units", async () => {
    const error = await retrieveFailure(intent(90071992547410));
    expect(error).toBeInstanceOf(PaymentProviderError);
  });

  it("sends a large amount as a number whose JSON text is the exact decimal", async () => {
    const { client, calls } = makeFakeClient((req) => ({
      id: "int_aw",
      amount: (req.body as { amount: number }).amount,
      currency: "USD",
      status: "REQUIRES_PAYMENT_METHOD",
    }));
    const result = await Effect.runPromise(
      PaymentIntent.create({ amount: 3518437208883199, currency: "usd" }).pipe(
        Effect.provide(provide(client)),
      ),
    );
    expect(toJsonText(calls[0].body)).toContain('"amount":35184372088831.99,');
    expect(result.amount).toBe(3518437208883199);
  });

  it("rejects a negative, fractional or inexact payment intent amount before sending anything", async () => {
    const { client, calls } = makeFakeClient(intent(1));
    const errors = await Effect.runPromise(
      Effect.forEach(
        [-100, 10.5, Number.MAX_SAFE_INTEGER],
        (amount) =>
          PaymentIntent.create({ amount, currency: "usd" }).pipe(
            Effect.provide(provide(client)),
            Effect.flip,
          ),
        { concurrency: 1 },
      ),
    );
    Arr.forEach(errors, (error) => {
      expect(error).toBeInstanceOf(PaymentInvalidRequestError);
      expect(error).toMatchObject({ param: "amount" });
    });
    expect(calls).toEqual([]);
  });

  it("rejects an amount the parser would refuse before sending anything", async () => {
    const { client, calls } = makeFakeClient(intent(1));
    const error = await Effect.runPromise(
      PaymentIntent.create({ amount: 4503599627370495, currency: "usd" }).pipe(
        Effect.provide(provide(client)),
        Effect.flip,
      ),
    );
    expect(error).toBeInstanceOf(PaymentInvalidRequestError);
    expect(error).toMatchObject({ param: "amount" });
    expect(calls).toEqual([]);
  });

  it("rejects a negative or fractional partial-refund amount before any request", async () => {
    const outcomes = await Effect.runPromise(
      Effect.forEach(
        [-500, 10.5],
        (amount) => {
          const { client, calls } = makeFakeClient(intent(20));
          return Refund.create({ paymentIntent: "int_aw", amount }).pipe(
            Effect.provide(provide(client)),
            Effect.flip,
            Effect.map((error) => ({ error, calls })),
          );
        },
        { concurrency: 1 },
      ),
    );
    Arr.forEach(outcomes, ({ error, calls }) => {
      expect(error).toBeInstanceOf(PaymentInvalidRequestError);
      expect(error).toMatchObject({ param: "amount" });
      expect(calls).toEqual([]);
    });
  });
});
