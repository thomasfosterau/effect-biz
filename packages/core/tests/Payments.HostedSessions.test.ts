import { describe, it, expect } from "vite-plus/test";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as CheckoutSession from "../src/Payments.CheckoutSession.ts";
import * as BillingPortal from "../src/Payments.BillingPortal.ts";

describe("CheckoutSession accessors", () => {
  it("create dispatches to whichever CheckoutSessions service is provided", async () => {
    const seen: Array<CheckoutSession.CreateParams> = [];
    const fake = CheckoutSession.CheckoutSessions.of({
      create: (params) => {
        seen.push(params);
        return Effect.succeed(
          new CheckoutSession.CheckoutSession({ id: "cs_1", url: "https://pay.example/cs_1" }),
        );
      },
    });
    const params: CheckoutSession.CreateParams = {
      mode: "subscription",
      customer: "cus_1",
      lineItems: [{ price: "price_1" }],
      successUrl: "https://example.test/ok",
      cancelUrl: "https://example.test/no",
    };
    const session = await Effect.runPromise(
      CheckoutSession.create(params).pipe(
        Effect.provideService(CheckoutSession.CheckoutSessions, fake),
      ),
    );
    expect(session.url).toBe("https://pay.example/cs_1");
    expect(seen).toEqual([params]);
  });

  it("models only the neutral modes", () => {
    const isMode = Schema.is(CheckoutSession.CheckoutMode);
    expect(isMode("payment")).toBe(true);
    expect(isMode("subscription")).toBe(true);
    expect(isMode("setup")).toBe(false);
  });

  it("requires a URL on the entity", () => {
    // SAFETY: deliberately ill-typed, to exercise the constructor's own check.
    expect(() => new CheckoutSession.CheckoutSession({ id: "cs_1", url: 1 as never })).toThrow(
      "Schema validation failed",
    );
  });
});

describe("BillingPortal accessors", () => {
  it("create dispatches to whichever BillingPortalSessions service is provided", async () => {
    const fake = BillingPortal.BillingPortalSessions.of({
      create: (params) =>
        Effect.succeed(
          new BillingPortal.BillingPortalSession({
            id: "bps_1",
            url: `https://portal.example/${params.customer}`,
          }),
        ),
    });
    const session = await Effect.runPromise(
      BillingPortal.create({ customer: "cus_1", returnUrl: "https://example.test/back" }).pipe(
        Effect.provideService(BillingPortal.BillingPortalSessions, fake),
      ),
    );
    expect(session).toBeInstanceOf(BillingPortal.BillingPortalSession);
    expect(session.url).toBe("https://portal.example/cus_1");
  });
});
