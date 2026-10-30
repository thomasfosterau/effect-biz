import { describe, it, expect } from "vite-plus/test";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Price from "@thomasfosterau/effect-biz/Payments.Price";
import * as PaymentIntent from "@thomasfosterau/effect-biz/Payments.PaymentIntent";
import * as Subscription from "@thomasfosterau/effect-biz/Payments.Subscription";
import * as Refund from "@thomasfosterau/effect-biz/Payments.Refund";
import type * as PayPalPayments from "../src/PayPalPayments.ts";
import { capabilitiesOver, stubPayPal } from "./support.ts";

/**
 * A value PayPal sends that the neutral model does not cover must decode to
 * `Other` carrying the raw string, never fail the object or the page (effect-finance#58).
 */
const answering = <A, E>(
  effect: Effect.Effect<A, E, Layer.Success<typeof PayPalPayments.capabilities>>,
  body: unknown,
): Effect.Effect<A, E> =>
  effect.pipe(Effect.provide(capabilitiesOver(stubPayPal(() => body).layer)));

const run = <A, E>(
  effect: Effect.Effect<A, E, Layer.Success<typeof PayPalPayments.capabilities>>,
  body: unknown,
): Promise<A> => Effect.runPromise(answering(effect, body));

/** Check, one case at a time, that each wire status maps onto its neutral one. */
const expectStatuses = <E>(
  cases: ReadonlyArray<readonly [string, string]>,
  retrieve: Effect.Effect<
    { readonly status: unknown },
    E,
    Layer.Success<typeof PayPalPayments.capabilities>
  >,
  body: (wire: string) => unknown,
): Promise<void> =>
  Effect.runPromise(
    Effect.forEach(
      cases,
      ([wire, neutral]) =>
        answering(retrieve, body(wire)).pipe(
          Effect.map((entity) => expect(entity.status).toBe(neutral)),
        ),
      { concurrency: 1, discard: true },
    ),
  );

const other = (raw: string) => ({ _tag: "Other", raw });

const order = (status: string) => ({
  id: "ORD-1",
  status,
  purchase_units: [{ amount: { currency_code: "USD", value: "20.00" } }],
});

const subscription = (status: string) => ({
  id: "SUB-1",
  status,
  plan_id: "P-1",
  start_time: "2026-01-01T00:00:00Z",
  billing_info: { next_billing_time: "2026-02-01T00:00:00Z" },
});

const refund = (status: string) => ({
  id: "REF-1",
  status,
  amount: { currency_code: "USD", value: "5.00" },
});

const plan = (id: string, unit: string) => ({
  id,
  product_id: "PROD-1",
  status: "ACTIVE",
  billing_cycles: [
    {
      tenure_type: "REGULAR",
      frequency: { interval_unit: unit, interval_count: 1 },
      pricing_scheme: { fixed_price: { currency_code: "USD", value: "10.00" } },
    },
  ],
});

describe("PayPalPayments lenient enumerations", () => {
  it("decodes an unknown order status to Other with the raw value", async () => {
    const result = await run(PaymentIntent.retrieve("ORD-1"), order("BRAND_NEW"));
    expect(result.status).toEqual(other("BRAND_NEW"));
  });

  it("decodes an unknown subscription status to Other with the raw value", async () => {
    const result = await run(Subscription.retrieve("SUB-1"), subscription("BRAND_NEW"));
    expect(result.status).toEqual(other("BRAND_NEW"));
  });

  it("decodes an unknown refund status to Other with the raw value", async () => {
    const result = await run(Refund.retrieve("REF-1"), refund("BRAND_NEW"));
    expect(result.status).toEqual(other("BRAND_NEW"));
  });

  it("decodes an unknown billing interval unit to Other inside a plan list, leaving the rest", async () => {
    const page = await run(Price.list(), {
      plans: [plan("P-1", "MONTH"), plan("P-2", "DECADE"), plan("P-3", "YEAR")],
    });
    expect(page.data.map((item) => item.recurring?.interval)).toEqual([
      "month",
      other("DECADE"),
      "year",
    ]);
  });

  it("keeps every known order, subscription and refund status unchanged", async () => {
    const orders: Array<[string, string]> = [
      ["CREATED", "requires_confirmation"],
      ["SAVED", "requires_confirmation"],
      ["PAYER_ACTION_REQUIRED", "requires_action"],
      ["APPROVED", "requires_capture"],
      ["COMPLETED", "succeeded"],
      ["VOIDED", "canceled"],
    ];
    await expectStatuses(orders, PaymentIntent.retrieve("ORD-1"), order);
    const subscriptions: Array<[string, string]> = [
      ["ACTIVE", "active"],
      ["SUSPENDED", "paused"],
      ["CANCELLED", "canceled"],
      ["EXPIRED", "incomplete_expired"],
      ["APPROVAL_PENDING", "incomplete"],
      ["APPROVED", "incomplete"],
    ];
    await expectStatuses(subscriptions, Subscription.retrieve("SUB-1"), subscription);
    const refunds: Array<[string, string]> = [
      ["COMPLETED", "succeeded"],
      ["FAILED", "failed"],
      ["CANCELLED", "canceled"],
      ["PENDING", "pending"],
    ];
    await expectStatuses(refunds, Refund.retrieve("REF-1"), refund);
    const intervals: Array<[string, string]> = [
      ["DAY", "day"],
      ["WEEK", "week"],
      ["MONTH", "month"],
      ["YEAR", "year"],
    ];
    const page = await run(Price.list(), {
      plans: intervals.map(([wire], index) => plan(`P-${index}`, wire)),
    });
    expect(page.data.map((item) => item.recurring?.interval)).toEqual(
      intervals.map(([, neutral]) => neutral),
    );
  });
});
