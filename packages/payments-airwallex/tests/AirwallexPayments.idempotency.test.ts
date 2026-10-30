import { assert, describe, it, expect } from "vite-plus/test";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as MutableHashMap from "effect/MutableHashMap";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import { FetchHttpClient } from "effect/http";
import * as Customer from "@thomasfosterau/effect-biz/Payments.Customer";
import * as PaymentIntent from "@thomasfosterau/effect-biz/Payments.PaymentIntent";
import * as Refund from "@thomasfosterau/effect-biz/Payments.Refund";
import * as IdempotencyKey from "@thomasfosterau/effect-biz/Payments.IdempotencyKey";
import {
  PaymentInvalidRequestError,
  PaymentNetworkError,
} from "@thomasfosterau/effect-biz/Payments";
import { AirwallexClient, type AirwallexRequest } from "../src/Airwallex.ts";
import * as AirwallexPayments from "../src/AirwallexPayments.ts";

/**
 * The neutral `idempotencyKey` (effect-finance#55, closing effect-finance#66) on the create and confirm
 * operations: mapped onto Airwallex's `request_id`, and a retried write after a
 * lost response is one logical write.
 */

const KEY = IdempotencyKey.IdempotencyKey.make("write-0001");

type Capabilities = Layer.Success<typeof AirwallexPayments.capabilities>;

/** Run `operation` over a fake client answering `{}` (the decode fails; the request was recorded first). */
const requestsOf = async (operation: Effect.Effect<unknown, unknown, Capabilities>) => {
  const calls: Array<AirwallexRequest> = [];
  const client = AirwallexClient.of({
    request: (request) => Effect.sync(() => (calls.push(request), {})),
  });
  const exit = await Effect.runPromise(
    Effect.exit(
      operation.pipe(
        Effect.provide(
          Layer.provide(AirwallexPayments.capabilities, Layer.succeed(AirwallexClient, client)),
        ),
      ),
    ),
  );
  return { calls, exit };
};

const operations = (idempotencyKey: IdempotencyKey.IdempotencyKey | undefined) =>
  [
    [
      "Customer.create",
      "/api/v1/pa/customers",
      Customer.create({ email: "a@b.com", idempotencyKey }),
    ],
    [
      "PaymentIntent.create",
      "/api/v1/pa/payment_intents",
      PaymentIntent.create({ amount: 100, currency: "usd", idempotencyKey }),
    ],
    [
      "PaymentIntent.confirm",
      "/api/v1/pa/payment_intents/int_1/confirm",
      PaymentIntent.confirm("int_1", { idempotencyKey }),
    ],
    [
      "Refund.create",
      "/api/v1/pa/refunds",
      Refund.create({ paymentIntent: "int_1", idempotencyKey }),
    ],
  ] as const;

/** `JSON.stringify` through `Schema`. */
const toJsonText = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

/** The `request_id` of a JSON request body, decoded through `Schema`. */
const RequestIdBody = Schema.fromJsonString(Schema.Struct({ request_id: Schema.String }));

describe("Airwallex maps the neutral idempotencyKey to request_id", () => {
  it.each(operations(KEY).map(([name]) => name))("%s", async (name) => {
    const found = operations(KEY).find(([candidate]) => candidate === name);
    assert.isDefined(found);
    const [, path, op] = found;
    const { calls } = await requestsOf(op);
    expect(calls.map((call) => [call.method, call.path, call.requestId])).toEqual([
      ["POST", path, KEY],
    ]);
  });

  it.each(operations(undefined).map(([name]) => name))(
    "%s keeps its fresh per-call request_id without a key",
    async (name) => {
      const found = operations(undefined).find(([candidate]) => candidate === name);
      assert.isDefined(found);
      const [, , op] = found;
      const { calls } = await requestsOf(op);
      expect(calls.map((call) => call.requestId)).toEqual([undefined]);
      const body = calls[0]?.body as { request_id: string } | undefined;
      expect(body?.request_id).toMatch(/^[0-9a-f-]{36}$/);
    },
  );

  it.each(operations(undefined).map(([name]) => name))(
    "%s refuses a raw string before sending anything",
    async (name) => {
      // Untyped code can still pass a string the brand would have refused.
      const bad = "not a valid key" as IdempotencyKey.IdempotencyKey;
      const found = operations(bad).find(([candidate]) => candidate === name);
      assert.isDefined(found);
      const [, , op] = found;
      const { calls, exit } = await requestsOf(op);
      expect(calls).toEqual([]);
      expect(exit._tag).toBe("Failure");
      expect(toJsonText(exit)).toContain("PaymentInvalidRequestError");
    },
  );

  it("sends the key on the refund POST only, not on the currency lookup of a partial refund", async () => {
    const calls: Array<AirwallexRequest> = [];
    const client = AirwallexClient.of({
      request: (request) =>
        Effect.sync(() => {
          calls.push(request);
          return request.method === "GET"
            ? { id: "int_1", amount: 10, currency: "USD", status: "SUCCEEDED" }
            : { id: "ref_1", amount: 1, currency: "USD", status: "SUCCEEDED" };
        }),
    });
    await Effect.runPromise(
      Refund.create({ paymentIntent: "int_1", amount: 100, idempotencyKey: KEY }).pipe(
        Effect.provide(
          Layer.provide(AirwallexPayments.capabilities, Layer.succeed(AirwallexClient, client)),
        ),
      ),
    );
    expect(calls.map((call) => [call.method, call.requestId])).toEqual([
      ["GET", undefined],
      ["POST", KEY],
    ]);
  });

  it("the cancel operation takes no key and keeps a fresh request_id", async () => {
    const { calls } = await requestsOf(PaymentIntent.cancel("int_1"));
    expect(calls.map((call) => call.requestId)).toEqual([undefined]);
  });
});

describe("a retried write after a lost response is one logical write (effect-finance#66)", () => {
  const LOGIN_PATH = "/api/v1/authentication/login";

  /**
   * A fake Airwallex behind the real client: it dedupes `POST /customers` by the
   * body's `request_id` (the first request with an id applies the write, a repeat
   * returns the remembered customer). `loseFirstResponse` drops the answer to the
   * first write, as a timeout would: the customer exists, the caller never saw it.
   */
  const dedupingAirwallex = (loseFirstResponse: boolean) => {
    const seen = MutableHashMap.empty<string, string>();
    const sent: Array<string> = [];
    let writes = 0;
    let attempts = 0;
    const fetchImpl: typeof globalThis.fetch = async (input, init) => {
      const url = input instanceof Request ? input.url : String(input);
      if (url.endsWith(LOGIN_PATH)) {
        return Response.json(
          {
            token: "tok_1",
            expires_at: DateTime.formatIso(DateTime.add(DateTime.nowUnsafe(), { minutes: 30 })),
          },
          { status: 201 },
        );
      }
      attempts += 1;
      const text = await new Response(init?.body).text();
      const requestId = Schema.decodeUnknownSync(RequestIdBody)(text).request_id;
      sent.push(requestId);
      const customerId = Option.getOrElse(
        MutableHashMap.get(seen, requestId),
        () => `cus_${(writes += 1)}`,
      );
      MutableHashMap.set(seen, requestId, customerId);
      if (loseFirstResponse && attempts === 1) throw new TypeError("fetch failed");
      return Response.json({
        id: customerId,
        email: "a@b.com",
        created_at: "2026-01-01T00:00:00Z",
      });
    };
    const http = FetchHttpClient.layer.pipe(
      Layer.provide(Layer.succeed(FetchHttpClient.Fetch, fetchImpl)),
    );
    return { http, sent, writes: () => writes };
  };

  const config = { clientId: "client_1", apiKey: Redacted.make("key_1") };

  const createWithRetry = (idempotencyKey: IdempotencyKey.IdempotencyKey | undefined) =>
    Customer.create({ email: "a@b.com", idempotencyKey }).pipe(
      Effect.retry({
        while: (error) => Predicate.isTagged(error, "PaymentNetworkError"),
        times: 1,
      }),
    );

  it("with one key reused on the retry, Airwallex applies it once", async () => {
    const fake = dedupingAirwallex(true);
    const customer = await Effect.runPromise(
      Effect.gen(function* () {
        const key = yield* IdempotencyKey.generate; // once per logical write
        return yield* createWithRetry(key);
      }).pipe(Effect.provide(AirwallexPayments.layer(config)), Effect.provide(fake.http)),
    );
    expect(customer.id).toBe("cus_1");
    expect(fake.writes()).toBe(1);
    expect(fake.sent).toHaveLength(2);
    expect(fake.sent[1]).toBe(fake.sent[0]);
  });

  it("without a key, the same retry creates a duplicate (the hazard being fixed)", async () => {
    const fake = dedupingAirwallex(true);
    const customer = await Effect.runPromise(
      createWithRetry(undefined).pipe(
        Effect.provide(AirwallexPayments.layer(config)),
        Effect.provide(fake.http),
      ),
    );
    expect(fake.sent[1]).not.toBe(fake.sent[0]);
    expect(fake.writes()).toBe(2);
    expect(customer.id).toBe("cus_2");
  });

  it("surfaces the lost response as PaymentNetworkError when the caller does not retry", async () => {
    const fake = dedupingAirwallex(true);
    const error = await Effect.runPromise(
      Customer.create({ email: "a@b.com", idempotencyKey: KEY }).pipe(
        Effect.flip,
        Effect.provide(AirwallexPayments.layer(config)),
        Effect.provide(fake.http),
      ),
    );
    expect(error).toBeInstanceOf(PaymentNetworkError);
    expect(fake.sent).toEqual([KEY]);
    expect(fake.writes()).toBe(1);
  });

  it("refuses a raw string key with PaymentInvalidRequestError before any request", async () => {
    const fake = dedupingAirwallex(false);
    const error = await Effect.runPromise(
      Customer.create({
        email: "a@b.com",
        idempotencyKey: "bad key" as IdempotencyKey.IdempotencyKey,
      }).pipe(
        Effect.flip,
        Effect.provide(AirwallexPayments.layer(config)),
        Effect.provide(fake.http),
      ),
    );
    expect(error).toBeInstanceOf(PaymentInvalidRequestError);
    expect(fake.sent).toEqual([]);
  });
});
