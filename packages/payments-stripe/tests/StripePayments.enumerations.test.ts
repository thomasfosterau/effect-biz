import type * as Schema from "effect/Schema";
import { describe, expect } from "vite-plus/test";
import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Price from "@thomasfosterau/effect-biz/Payments.Price";
import * as PaymentIntent from "@thomasfosterau/effect-biz/Payments.PaymentIntent";
import * as Subscription from "@thomasfosterau/effect-biz/Payments.Subscription";
import * as Refund from "@thomasfosterau/effect-biz/Payments.Refund";
import * as StripePayments from "../src/StripePayments.ts";
import { stubStripe } from "./support.ts";

/**
 * A value Stripe adds to an enumeration later must decode to `Other` carrying
 * the raw string, never fail the object or the list page it sits in (effect-finance#58).
 */
const run = <A, E>(
  effect: Effect.Effect<A, E, Layer.Success<typeof StripePayments.capabilities>>,
  body: Schema.Json,
): Effect.Effect<A, E> => {
  const stub = stubStripe(() => body);
  return effect.pipe(Effect.provide(Layer.provideMerge(StripePayments.capabilities, stub.layer)));
};

const page = (...data: Array<Schema.Json>) => ({ object: "list", has_more: false, data });

const intent = (id: string, status: string) => ({
  id,
  amount: 100,
  currency: "usd",
  status,
  metadata: {},
  created: 1,
});

const subscription = (id: string, status: string) => ({
  id,
  customer: "cus_1",
  status,
  items: { data: [{ id: "si_1", price: { id: "price_1" }, quantity: 1 }] },
  current_period_start: 1,
  current_period_end: 2,
  cancel_at_period_end: false,
  metadata: {},
  created: 1,
});

const refund = (id: string, status: string) => ({
  id,
  amount: 100,
  currency: "usd",
  status,
  metadata: {},
  created: 1,
});

const price = (id: string, type: string, interval: string) => ({
  id,
  product: "prod_1",
  active: true,
  currency: "usd",
  unit_amount: 100,
  type,
  recurring: { interval, interval_count: 1 },
  metadata: {},
  created: 1,
});

const other = (raw: string) => ({ _tag: "Other", raw });

describe("StripePayments lenient enumerations", () => {
  it.effect("decodes an unknown payment status to Other with the raw value", () =>
    Effect.gen(function* () {
      const result = yield* run(PaymentIntent.retrieve("pi_1"), intent("pi_1", "brand_new_status"));
      expect(result.status).toEqual(other("brand_new_status"));
    }),
  );

  it.effect("decodes an unknown subscription status to Other with the raw value", () =>
    Effect.gen(function* () {
      const result = yield* run(
        Subscription.retrieve("sub_1"),
        subscription("sub_1", "brand_new_status"),
      );
      expect(result.status).toEqual(other("brand_new_status"));
    }),
  );

  it.effect("decodes an unknown refund status to Other with the raw value", () =>
    Effect.gen(function* () {
      const result = yield* run(Refund.retrieve("re_1"), refund("re_1", "brand_new_status"));
      expect(result.status).toEqual(other("brand_new_status"));
    }),
  );

  it.effect("decodes an unknown price type and recurring interval to Other", () =>
    Effect.gen(function* () {
      const result = yield* run(Price.retrieve("price_1"), price("price_1", "metered", "decade"));
      expect(result.type).toEqual(other("metered"));
      expect(result.recurring?.interval).toEqual(other("decade"));
    }),
  );

  it.effect("leaves the rest of a payment intent page decoding around an unknown status", () =>
    Effect.gen(function* () {
      const result = yield* run(
        PaymentIntent.list(),
        page(
          intent("pi_1", "succeeded"),
          intent("pi_2", "brand_new_status"),
          intent("pi_3", "canceled"),
        ),
      );
      expect(result.data.map((item) => item.status)).toEqual([
        "succeeded",
        other("brand_new_status"),
        "canceled",
      ]);
    }),
  );

  it.effect("leaves the rest of a subscription page decoding around an unknown status", () =>
    Effect.gen(function* () {
      const result = yield* run(
        Subscription.list(),
        page(subscription("sub_1", "active"), subscription("sub_2", "brand_new_status")),
      );
      expect(result.data.map((item) => item.status)).toEqual(["active", other("brand_new_status")]);
    }),
  );

  it.effect("leaves the rest of a refund page decoding around an unknown status", () =>
    Effect.gen(function* () {
      const result = yield* run(
        Refund.list(),
        page(refund("re_1", "brand_new_status"), refund("re_2", "succeeded")),
      );
      expect(result.data.map((item) => item.status)).toEqual([
        other("brand_new_status"),
        "succeeded",
      ]);
    }),
  );

  it.effect("leaves the rest of a price page decoding around an unknown type or interval", () =>
    Effect.gen(function* () {
      const result = yield* run(
        Price.list(),
        page(price("price_1", "one_time", "month"), price("price_2", "metered", "decade")),
      );
      expect(result.data.map((item) => item.type)).toEqual(["one_time", other("metered")]);
      expect(result.data[1]?.recurring?.interval).toEqual(other("decade"));
    }),
  );

  it.effect("keeps every known value unchanged", () =>
    Effect.gen(function* () {
      const statuses = [
        "requires_payment_method",
        "requires_confirmation",
        "requires_action",
        "processing",
        "requires_capture",
        "canceled",
        "succeeded",
      ];
      const result = yield* run(
        PaymentIntent.list(),
        page(...statuses.map((status, index) => intent(`pi_${index}`, status))),
      );
      expect(result.data.map((item) => item.status)).toEqual(statuses);

      const subscriptionStatuses = [
        "active",
        "past_due",
        "unpaid",
        "canceled",
        "incomplete",
        "incomplete_expired",
        "trialing",
        "paused",
      ];
      const subscriptions = yield* run(
        Subscription.list(),
        page(...subscriptionStatuses.map((status, index) => subscription(`sub_${index}`, status))),
      );
      expect(subscriptions.data.map((item) => item.status)).toEqual(subscriptionStatuses);

      const refundStatuses = ["pending", "requires_action", "succeeded", "failed", "canceled"];
      const refunds = yield* run(
        Refund.list(),
        page(...refundStatuses.map((status, index) => refund(`re_${index}`, status))),
      );
      expect(refunds.data.map((item) => item.status)).toEqual(refundStatuses);

      const prices = yield* run(
        Price.list(),
        page(
          price("price_1", "one_time", "day"),
          price("price_2", "recurring", "week"),
          price("price_3", "recurring", "month"),
          price("price_4", "recurring", "year"),
        ),
      );
      expect(prices.data.map((item) => item.type)).toEqual([
        "one_time",
        "recurring",
        "recurring",
        "recurring",
      ]);
      expect(prices.data.map((item) => item.recurring?.interval)).toEqual([
        "day",
        "week",
        "month",
        "year",
      ]);
    }),
  );

  it.effect("still fails a status that is not a string", () =>
    Effect.gen(function* () {
      const error = yield* run(
        Effect.flip(PaymentIntent.retrieve("pi_1")),
        // SAFETY: a wire status that is not a string, which the fixture's type rules out.
        intent("pi_1", 7 as never),
      );
      expect(error).toMatchObject({
        message: "Stripe returned a malformed payment intent response",
      });
    }),
  );
});
