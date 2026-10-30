import { describe, expect, expectTypeOf, it } from "vite-plus/test";
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as HashSet from "effect/HashSet";
import * as Schema from "effect/Schema";
import * as IdempotencyKey from "@thomasfosterau/effect-biz/Payments.IdempotencyKey";
import * as Customer from "@thomasfosterau/effect-biz/Payments.Customer";
import * as CheckoutSession from "@thomasfosterau/effect-biz/Payments.CheckoutSession";
import * as PaymentIntent from "@thomasfosterau/effect-biz/Payments.PaymentIntent";
import * as Price from "@thomasfosterau/effect-biz/Payments.Price";
import * as Product from "@thomasfosterau/effect-biz/Payments.Product";
import * as Refund from "@thomasfosterau/effect-biz/Payments.Refund";
import * as Subscription from "@thomasfosterau/effect-biz/Payments.Subscription";
import * as BillingPortal from "@thomasfosterau/effect-biz/Payments.BillingPortal";
import { PaymentInvalidRequestError } from "@thomasfosterau/effect-biz/Payments";

const decodes = Schema.is(IdempotencyKey.IdempotencyKey);

describe("IdempotencyKey", () => {
  it("generates a valid, distinct key each time it runs", () => {
    const keys = Array.from({ length: 50 }, () => Effect.runSync(IdempotencyKey.generate));
    Arr.forEach(keys, (key) => {
      expect(key).toMatch(/^[0-9a-f-]{36}$/);
      expect(decodes(key)).toBe(true);
    });
    expect(HashSet.size(HashSet.fromIterable(keys))).toBe(50);
  });

  it("accepts 1 to 64 characters of A-Z a-z 0-9 _ -", () => {
    Arr.forEach(["a", "order_42", "Order-42", "x".repeat(64), "0123456789_-ABCxyz"], (ok) => {
      expect(decodes(ok)).toBe(true);
    });
  });

  it("rejects anything else", () => {
    Arr.forEach(
      ["", "x".repeat(65), "has space", "slash/slash", "dot.dot", "naïve", "a\nb"],
      (bad) => {
        expect(decodes(bad)).toBe(false);
      },
    );
  });

  it("validate passes none through, passes a good key, and refuses a bad one", async () => {
    expect(await Effect.runPromise(IdempotencyKey.validate(undefined))).toBeUndefined();
    expect(await Effect.runPromise(IdempotencyKey.validate("order-42"))).toBe("order-42");
    const bads = ["", "x".repeat(65), "bad key"];
    const errors = await Effect.runPromise(
      Effect.forEach(bads, (bad) => Effect.flip(IdempotencyKey.validate(bad)), {
        concurrency: 1,
      }),
    );
    Arr.forEach(errors, (error) => {
      expect(error).toBeInstanceOf(PaymentInvalidRequestError);
      expect(error).toMatchObject({ param: "idempotencyKey" });
    });
    // The refused value is not echoed back (every message contains "").
    const echoed = Arr.filter(
      Arr.zip(bads, errors),
      ([bad, error]) => bad !== "" && error.message.includes(bad),
    );
    expect(echoed).toEqual([]);
  });

  it("make throws on a bad shape", () => {
    expect(() => IdempotencyKey.IdempotencyKey.make("bad key")).toThrow("Schema validation failed");
  });
});

describe("where the neutral key is accepted (type level)", () => {
  type Key = IdempotencyKey.IdempotencyKey | undefined;

  it("is an optional branded key on every create and confirm operation", () => {
    expectTypeOf<Customer.CreateParams["idempotencyKey"]>().toEqualTypeOf<Key>();
    expectTypeOf<Product.CreateParams["idempotencyKey"]>().toEqualTypeOf<Key>();
    expectTypeOf<Price.CreateParams["idempotencyKey"]>().toEqualTypeOf<Key>();
    expectTypeOf<PaymentIntent.CreateParams["idempotencyKey"]>().toEqualTypeOf<Key>();
    expectTypeOf<PaymentIntent.ConfirmParams["idempotencyKey"]>().toEqualTypeOf<Key>();
    expectTypeOf<Subscription.CreateParams["idempotencyKey"]>().toEqualTypeOf<Key>();
    expectTypeOf<Refund.CreateParams["idempotencyKey"]>().toEqualTypeOf<Key>();
    expectTypeOf<CheckoutSession.CreateParams["idempotencyKey"]>().toEqualTypeOf<Key>();
    // Optional: a call without a key compiles.
    expectTypeOf<{ email: string }>().toExtend<Customer.CreateParams>();
    expectTypeOf<Record<string, never>>().toExtend<PaymentIntent.ConfirmParams>();
  });

  it("is not a plain string", () => {
    expectTypeOf<string>().not.toExtend<IdempotencyKey.IdempotencyKey>();
    expectTypeOf<{ idempotencyKey: string }>().not.toExtend<Customer.CreateParams>();
  });

  it("is not accepted by the cancel operations", () => {
    // `Subscription.cancel` and `PaymentIntent.cancel` take the id and nothing else:
    // PayPal cannot honour a key there, and a dropped key is worse than none.
    expectTypeOf(Subscription.cancel).parameters.toEqualTypeOf<[id: string]>();
    expectTypeOf(PaymentIntent.cancel).parameters.toEqualTypeOf<[id: string]>();
    expectTypeOf<Subscription.Subscriptions["Service"]["cancel"]>().parameters.toEqualTypeOf<
      [id: string]
    >();
    expectTypeOf<PaymentIntent.PaymentIntents["Service"]["cancel"]>().parameters.toEqualTypeOf<
      [id: string]
    >();
  });

  it("is not accepted by updates, which are set-semantics and repeatable", () => {
    expectTypeOf<"idempotencyKey">().not.toExtend<keyof Customer.UpdateParams>();
    expectTypeOf<"idempotencyKey">().not.toExtend<keyof Product.UpdateParams>();
    expectTypeOf<"idempotencyKey">().not.toExtend<keyof Price.UpdateParams>();
    expectTypeOf<"idempotencyKey">().not.toExtend<keyof PaymentIntent.UpdateParams>();
    expectTypeOf<"idempotencyKey">().not.toExtend<keyof Subscription.UpdateParams>();
    expectTypeOf<"idempotencyKey">().not.toExtend<keyof Refund.UpdateParams>();
  });

  it("is not accepted by the billing portal, which is not a repeat-sensitive write", () => {
    expectTypeOf<"idempotencyKey">().not.toExtend<keyof BillingPortal.CreateParams>();
  });
});
