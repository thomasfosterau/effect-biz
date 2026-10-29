import { describe, it, expect } from "vite-plus/test";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as CheckoutSession from "@thomasfosterau/effect-biz/Payments.CheckoutSession";
import * as BillingPortal from "@thomasfosterau/effect-biz/Payments.BillingPortal";
import { PaymentInvalidRequestError } from "@thomasfosterau/effect-biz/Payments";
import * as PayPalPayments from "../src/PayPalPayments.ts";

/**
 * PayPal has no neutral hosted checkout or billing portal (effect-finance#40): the stub
 * layers fail every call with the neutral unsupported-operation error, and need
 * no client, so nothing reaches the network.
 */
describe("PayPalPayments hosted-page stubs", () => {
  const layer = Layer.mergeAll(
    PayPalPayments.checkoutSessionsLayer,
    PayPalPayments.billingPortalSessionsLayer,
  );

  it("fails a checkout session as unsupported", async () => {
    const error = await Effect.runPromise(
      Effect.flip(
        CheckoutSession.create({
          mode: "subscription",
          customer: "cus_1",
          lineItems: [{ price: "price_1" }],
          successUrl: "https://example.test/ok",
          cancelUrl: "https://example.test/no",
        }),
      ).pipe(Effect.provide(layer)),
    );
    expect(error).toBeInstanceOf(PaymentInvalidRequestError);
    expect(error.message).toBe("PayPal does not support hosted checkout sessions");
  });

  it("fails a billing portal session as unsupported", async () => {
    const error = await Effect.runPromise(
      Effect.flip(
        BillingPortal.create({ customer: "cus_1", returnUrl: "https://example.test/back" }),
      ).pipe(Effect.provide(layer)),
    );
    expect(error).toBeInstanceOf(PaymentInvalidRequestError);
    expect(error.message).toBe("PayPal does not support billing portal sessions");
  });
});
