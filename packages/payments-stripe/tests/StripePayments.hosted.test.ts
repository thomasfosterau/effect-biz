import { describe, it, expect } from "vite-plus/test";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Rec from "effect/Record";
import * as Redacted from "effect/Redacted";
import * as CheckoutSession from "@thomasfosterau/effect-biz/Payments.CheckoutSession";
import * as BillingPortal from "@thomasfosterau/effect-biz/Payments.BillingPortal";
import {
  PaymentInvalidRequestError,
  PaymentProviderError,
} from "@thomasfosterau/effect-biz/Payments";
import * as StripePayments from "../src/StripePayments.ts";
import { formOf, jsonResponse, stubFetch, stubStripeTable, withTestClock } from "./support.ts";

/**
 * The hosted-page capabilities (effect-finance#40): Checkout and the Billing Portal. The
 * behavioural spec is gardeneria's `createCheckoutSession` → URL and
 * `createPortalSession`: a price id (never an amount) with quantity 1, the
 * account id carried as subscription metadata, the return URL forwarded, and a
 * 2xx with no URL a failure rather than an invented redirect.
 */

const checkout: CheckoutSession.SubscriptionParams = {
  mode: "subscription",
  customer: "cus_1",
  lineItems: [{ price: "price_monthly" }],
  successUrl: "https://example.test/account/billing?checkout=success",
  cancelUrl: "https://example.test/pricing",
  subscriptionMetadata: { user_id: "user-1" },
};

const portal: BillingPortal.CreateParams = {
  customer: "cus_1",
  returnUrl: "https://example.test/account/billing",
};

/** Run `effect` against the capabilities over a stubbed API answering from `answers`. */
const run = <A, E>(
  effect: Effect.Effect<A, E, Layer.Success<typeof StripePayments.capabilities>>,
  answers: Record<string, unknown>,
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

describe("StripePayments checkoutSessionsLayer", () => {
  it("creates a hosted Checkout session and returns its URL", async () => {
    const { result, calls } = run(CheckoutSession.create(checkout), {
      "POST /v1/checkout/sessions": {
        id: "cs_1",
        object: "checkout.session",
        url: "https://checkout.stripe.com/c/pay/cs_1",
      },
    });
    const session = await result;
    expect(session).toBeInstanceOf(CheckoutSession.CheckoutSession);
    expect(session.id).toBe("cs_1");
    expect(session.url).toBe("https://checkout.stripe.com/c/pay/cs_1");
    expect(calls[0]).toMatchObject({ method: "POST", path: "/v1/checkout/sessions" });
    expect(calls[0]?.params).toEqual(
      formOf({
        mode: "subscription",
        customer: "cus_1",
        line_items: [{ price: "price_monthly", quantity: 1 }],
        success_url: "https://example.test/account/billing?checkout=success",
        cancel_url: "https://example.test/pricing",
        metadata: undefined,
        subscription_data: { metadata: { user_id: "user-1" } },
      }),
    );
  });

  it("forwards explicit quantities and session metadata, and omits subscription data when absent", async () => {
    const { result, calls } = run(
      CheckoutSession.create({
        mode: "payment",
        lineItems: [{ price: "price_a", quantity: 3 }, { price: "price_b" }],
        successUrl: "https://example.test/ok",
        cancelUrl: "https://example.test/no",
        metadata: { order: "o-1" },
      }),
      { "POST /v1/checkout/sessions": { id: "cs_2", url: "https://checkout.stripe.com/cs_2" } },
    );
    await result;
    expect(calls[0]?.params).toEqual(
      formOf({
        mode: "payment",
        customer: undefined,
        line_items: [
          { price: "price_a", quantity: 3 },
          { price: "price_b", quantity: 1 },
        ],
        success_url: "https://example.test/ok",
        cancel_url: "https://example.test/no",
        metadata: { order: "o-1" },
        subscription_data: undefined,
      }),
    );
  });

  it.each([{ id: "cs_1" }, { id: "cs_1", url: null }, { id: "cs_1", url: "" }])(
    "fails rather than inventing a URL when a 2xx carries none (%o)",
    async (body) => {
      const error = await run(Effect.flip(CheckoutSession.create(checkout)), {
        "POST /v1/checkout/sessions": body,
      }).result;
      expect(error).toBeInstanceOf(PaymentProviderError);
      expect(error.message).toBe("Stripe returned a malformed checkout session response");
    },
  );

  it("never sends subscription data for a payment checkout, even from an untyped caller", async () => {
    // SAFETY: deliberately ill-typed — `subscriptionMetadata` is not a
    // `PaymentParams` field — to model a caller outside the type system.
    const untyped: CheckoutSession.CreateParams = { ...checkout, mode: "payment" } as never;
    const { result, calls } = run(CheckoutSession.create(untyped), {
      "POST /v1/checkout/sessions": { id: "cs_3", url: "https://checkout.stripe.com/cs_3" },
    });
    await result;
    expect(calls[0]?.params).toMatchObject({ mode: "payment" });
    expect(
      Rec.keys(calls[0]?.params ?? {}).some((key) => key.startsWith("subscription_data")),
    ).toBe(false);
  });

  it("passes a Stripe rejection through the neutral channel", async () => {
    const error = await run(Effect.flip(CheckoutSession.create(checkout)), {
      "POST /v1/checkout/sessions": jsonResponse(400, {
        error: {
          type: "invalid_request_error",
          code: "resource_missing",
          message: "No such price: 'price_monthly'",
          param: "line_items[0][price]",
        },
      }),
    }).result;
    expect(error).toBeInstanceOf(PaymentInvalidRequestError);
    expect(error.message).toContain("No such price");
    expect(error).toMatchObject({ param: "line_items[0][price]", statusCode: 400 });
  });
});

describe("StripePayments billingPortalSessionsLayer", () => {
  it("creates a portal session for the customer and returns its URL", async () => {
    const { result, calls } = run(BillingPortal.create(portal), {
      "POST /v1/billing_portal/sessions": {
        id: "bps_1",
        object: "billing_portal.session",
        url: "https://billing.stripe.com/p/session/bps_1",
      },
    });
    const session = await result;
    expect(session).toBeInstanceOf(BillingPortal.BillingPortalSession);
    expect(session.id).toBe("bps_1");
    expect(session.url).toBe("https://billing.stripe.com/p/session/bps_1");
    expect(calls[0]).toMatchObject({ method: "POST", path: "/v1/billing_portal/sessions" });
    expect(calls[0]?.params).toEqual(
      formOf({ customer: "cus_1", return_url: "https://example.test/account/billing" }),
    );
  });

  it.each([{ id: "bps_1" }, { id: "bps_1", url: "" }])(
    "fails rather than inventing a URL when a 2xx carries none (%o)",
    async (body) => {
      const error = await run(Effect.flip(BillingPortal.create(portal)), {
        "POST /v1/billing_portal/sessions": body,
      }).result;
      expect(error).toBeInstanceOf(PaymentProviderError);
      expect(error.message).toBe("Stripe returned a malformed billing portal session response");
    },
  );
});

describe("hosted sessions over StripePayments.layer", () => {
  /** `StripePayments.layer` over a stubbed `fetch` answering `body` to every request. */
  const wire = (body: unknown) => {
    const { http, calls } = stubFetch(() => jsonResponse(200, body));
    const layer = StripePayments.layer({ apiKey: Redacted.make("sk_test_not_real") }).pipe(
      Layer.provide(http),
    );
    return { layer, calls };
  };

  it("form-encodes a checkout the way Stripe expects, with no amount", async () => {
    const { layer, calls } = wire({ id: "cs_1", url: "https://checkout.stripe.com/cs_1" });
    const session = await Effect.runPromise(
      withTestClock(CheckoutSession.create(checkout).pipe(Effect.provide(layer))),
    );
    expect(session.url).toBe("https://checkout.stripe.com/cs_1");
    const call = calls[0];
    expect(call?.method).toBe("POST");
    expect(call?.url.href).toBe("https://api.stripe.com/v1/checkout/sessions");
    const form = new URLSearchParams(call?.body);
    expect(form.get("mode")).toBe("subscription");
    expect(form.get("customer")).toBe("cus_1");
    expect(form.get("line_items[0][price]")).toBe("price_monthly");
    expect(form.get("line_items[0][quantity]")).toBe("1");
    expect(form.get("success_url")).toBe(checkout.successUrl);
    expect(form.get("cancel_url")).toBe(checkout.cancelUrl);
    expect(form.get("subscription_data[metadata][user_id]")).toBe("user-1");
    expect([...form.keys()].some((key) => key.includes("amount"))).toBe(false);
  });

  it("form-encodes a payment checkout's metadata and sends no subscription data", async () => {
    const { layer, calls } = wire({ id: "cs_2", url: "https://checkout.stripe.com/cs_2" });
    await Effect.runPromise(
      withTestClock(
        CheckoutSession.create({
          mode: "payment",
          lineItems: [{ price: "price_a", quantity: 3 }, { price: "price_b" }],
          successUrl: "https://example.test/ok",
          cancelUrl: "https://example.test/no",
          metadata: { order: "o-1" },
        }).pipe(Effect.provide(layer)),
      ),
    );
    const form = new URLSearchParams(calls[0]?.body);
    expect(form.get("mode")).toBe("payment");
    expect(form.get("metadata[order]")).toBe("o-1");
    expect(form.get("line_items[0][quantity]")).toBe("3");
    expect(form.get("line_items[1][price]")).toBe("price_b");
    expect(form.get("line_items[1][quantity]")).toBe("1");
    expect(form.has("customer")).toBe(false);
    expect([...form.keys()].some((key) => key.startsWith("subscription_data"))).toBe(false);
  });

  it("form-encodes a portal session", async () => {
    const { layer, calls } = wire({ id: "bps_1", url: "https://billing.stripe.com/bps_1" });
    const session = await Effect.runPromise(
      withTestClock(BillingPortal.create(portal).pipe(Effect.provide(layer))),
    );
    expect(session.url).toBe("https://billing.stripe.com/bps_1");
    expect(calls[0]?.url.href).toBe("https://api.stripe.com/v1/billing_portal/sessions");
    const form = new URLSearchParams(calls[0]?.body);
    expect(form.get("customer")).toBe("cus_1");
    expect(form.get("return_url")).toBe(portal.returnUrl);
  });
});
