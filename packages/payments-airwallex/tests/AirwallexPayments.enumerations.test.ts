import { describe, it, expect } from "vite-plus/test";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as PaymentIntent from "@thomasfosterau/effect-biz/Payments.PaymentIntent";
import * as Refund from "@thomasfosterau/effect-biz/Payments.Refund";
import { AirwallexClient } from "../src/Airwallex.ts";
import * as AirwallexPayments from "../src/AirwallexPayments.ts";

/**
 * A status Airwallex sends that the neutral model does not cover must decode
 * to `Other` carrying the raw string, never fail the object or the page (effect-finance#58).
 */
const run = <A, E>(
  effect: Effect.Effect<A, E, Layer.Success<typeof AirwallexPayments.capabilities>>,
  body: unknown,
): Promise<A> =>
  Effect.runPromise(
    effect.pipe(
      Effect.provide(
        Layer.provide(
          AirwallexPayments.capabilities,
          Layer.succeed(
            AirwallexClient,
            AirwallexClient.of({ request: () => Effect.succeed(body) }),
          ),
        ),
      ),
    ),
  );

const other = (raw: string) => ({ _tag: "Other", raw });

const intent = (id: string, status: string) => ({
  id,
  amount: 20,
  currency: "USD",
  status,
  created_at: "2026-01-01T00:00:00Z",
});

const refund = (id: string, status: string) => ({
  id,
  amount: 5,
  currency: "USD",
  status,
  payment_intent_id: "int_aw",
  created_at: "2026-01-01T00:00:00Z",
});

const items = (...values: Array<unknown>) => ({ items: values, has_more: false });

describe("AirwallexPayments lenient enumerations", () => {
  it("decodes an unknown payment intent status to Other with the raw value", async () => {
    const result = await run(PaymentIntent.retrieve("int_1"), intent("int_1", "BRAND_NEW"));
    expect(result.status).toEqual(other("BRAND_NEW"));
  });

  it("decodes an unknown refund status to Other with the raw value", async () => {
    const result = await run(Refund.retrieve("ref_1"), refund("ref_1", "BRAND_NEW"));
    expect(result.status).toEqual(other("BRAND_NEW"));
  });

  it("leaves the rest of a payment intent page decoding around an unknown status", async () => {
    const page = await run(
      PaymentIntent.list(),
      items(
        intent("int_1", "SUCCEEDED"),
        intent("int_2", "BRAND_NEW"),
        intent("int_3", "CANCELLED"),
      ),
    );
    expect(page.data.map((item) => item.status)).toEqual([
      "succeeded",
      other("BRAND_NEW"),
      "canceled",
    ]);
  });

  it("leaves the rest of a refund page decoding around an unknown status", async () => {
    const page = await run(
      Refund.list(),
      items(refund("ref_1", "BRAND_NEW"), refund("ref_2", "SUCCEEDED")),
    );
    expect(page.data.map((item) => item.status)).toEqual([other("BRAND_NEW"), "succeeded"]);
  });

  it("keeps every known payment intent and refund status unchanged", async () => {
    const intents: Array<[string, string]> = [
      ["REQUIRES_PAYMENT_METHOD", "requires_payment_method"],
      ["REQUIRES_CUSTOMER_ACTION", "requires_action"],
      ["REQUIRES_CAPTURE", "requires_capture"],
      ["SUCCEEDED", "succeeded"],
      ["CANCELLED", "canceled"],
      ["PENDING", "processing"],
      ["RECEIVED", "processing"],
    ];
    const intentPage = await run(
      PaymentIntent.list(),
      items(...intents.map(([wire], index) => intent(`int_${index}`, wire))),
    );
    expect(intentPage.data.map((item) => item.status)).toEqual(intents.map(([, n]) => n));

    const refunds: Array<[string, string]> = [
      ["SUCCEEDED", "succeeded"],
      ["FAILED", "failed"],
      ["CANCELLED", "canceled"],
      ["RECEIVED", "pending"],
      ["ACCEPTED", "pending"],
      ["PENDING", "pending"],
    ];
    const refundPage = await run(
      Refund.list(),
      items(...refunds.map(([wire], index) => refund(`ref_${index}`, wire))),
    );
    expect(refundPage.data.map((item) => item.status)).toEqual(refunds.map(([, n]) => n));
  });
});
