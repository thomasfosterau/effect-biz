import { describe, it, expect } from "vite-plus/test";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Rec from "effect/Record";
import * as BillingPortal from "@thomasfosterau/effect-biz/Payments.BillingPortal";
import * as CheckoutSession from "@thomasfosterau/effect-biz/Payments.CheckoutSession";
import * as Customer from "@thomasfosterau/effect-biz/Payments.Customer";
import * as PaymentIntent from "@thomasfosterau/effect-biz/Payments.PaymentIntent";
import * as Price from "@thomasfosterau/effect-biz/Payments.Price";
import * as Product from "@thomasfosterau/effect-biz/Payments.Product";
import * as Refund from "@thomasfosterau/effect-biz/Payments.Refund";
import * as Subscription from "@thomasfosterau/effect-biz/Payments.Subscription";
import { PaymentsUnavailable } from "@thomasfosterau/effect-biz/Payments";
import * as StripeCustomer from "../src/Customer.ts";
import * as StripeHttp from "../src/StripeHttp.ts";
import * as StripePayments from "../src/StripePayments.ts";
import { jsonResponse, stubFetch } from "./support.ts";

/**
 * The "not configured ≡ down" posture (effect-finance#42). The behavioural spec is
 * gardeneria's `stripeStubLayer` / call-time `STRIPE_SECRET_KEY` read: with no
 * key the layer still builds, every call fails with the same typed
 * "unavailable" failure (a 503 to an HTTP API), and the key is read on each
 * call, so a key configured later is picked up without rebuilding anything.
 */

const KEY = "sk_test_not_a_real_key_4242";

type Capabilities = Layer.Success<ReturnType<typeof StripePayments.layerConfig>>;

/** Configuration holding `values`, for one call. */
const withConfig = (values: Record<string, string>) =>
  Effect.provide(ConfigProvider.layer(ConfigProvider.fromUnknown(values)));

/** Every neutral capability operation, keyed by name. */
const everyCall = {
  "Customer.create": Customer.create({ email: "a@example.test" }),
  "Customer.retrieve": Customer.retrieve("cus_1"),
  "Customer.update": Customer.update("cus_1", { name: "A" }),
  "Customer.del": Customer.del("cus_1"),
  "Customer.list": Customer.list({ limit: 1 }),
  "Product.create": Product.create({ name: "P" }),
  "Product.retrieve": Product.retrieve("prod_1"),
  "Product.update": Product.update("prod_1", { active: false }),
  "Product.del": Product.del("prod_1"),
  "Product.list": Product.list({ limit: 1 }),
  "Price.create": Price.create({ product: "prod_1", currency: "aud", unitAmount: 500 }),
  "Price.retrieve": Price.retrieve("price_1"),
  "Price.update": Price.update("price_1", { metadata: {} }),
  "Price.list": Price.list({ limit: 1 }),
  "PaymentIntent.create": PaymentIntent.create({ amount: 500, currency: "aud" }),
  "PaymentIntent.retrieve": PaymentIntent.retrieve("pi_1"),
  "PaymentIntent.update": PaymentIntent.update("pi_1", { description: "d" }),
  "PaymentIntent.confirm": PaymentIntent.confirm("pi_1", { paymentMethod: "pm_1" }),
  "PaymentIntent.cancel": PaymentIntent.cancel("pi_1"),
  "PaymentIntent.list": PaymentIntent.list({ limit: 1 }),
  "Subscription.create": Subscription.create({ customer: "cus_1", items: [{ price: "p_1" }] }),
  "Subscription.retrieve": Subscription.retrieve("sub_1"),
  "Subscription.update": Subscription.update("sub_1", { metadata: {} }),
  "Subscription.cancel": Subscription.cancel("sub_1"),
  "Subscription.list": Subscription.list({ limit: 1 }),
  "Refund.create": Refund.create({ charge: "ch_1" }),
  "Refund.retrieve": Refund.retrieve("re_1"),
  "Refund.update": Refund.update("re_1", { metadata: {} }),
  "Refund.list": Refund.list({ limit: 1 }),
  "CheckoutSession.create": CheckoutSession.create({
    mode: "subscription",
    customer: "cus_1",
    lineItems: [{ price: "price_monthly" }],
    successUrl: "https://example.test/ok",
    cancelUrl: "https://example.test/cancel",
  }),
  "BillingPortal.create": BillingPortal.create({
    customer: "cus_1",
    returnUrl: "https://example.test/account",
  }),
} satisfies Record<string, Effect.Effect<unknown, unknown, Capabilities>>;

const customer = () =>
  jsonResponse(200, { id: "cus_1", object: "customer", created: 1_700_000_000, livemode: false });

describe("StripePayments.layerConfig", () => {
  it("builds with no key configured, without reading it or sending anything", async () => {
    const { http, calls } = stubFetch(customer);
    await Effect.runPromise(
      Layer.build(StripePayments.layerConfig()).pipe(
        Effect.scoped,
        Effect.provide(http),
        withConfig({}),
      ),
    );
    expect(calls).toHaveLength(0);
  });

  it.each(Rec.toEntries<string, Effect.Effect<unknown, unknown, Capabilities>>(everyCall))(
    "fails %s with PaymentsUnavailable while the key is absent",
    async (_, call) => {
      const { http, calls } = stubFetch(customer);
      const error = await Effect.runPromise(
        Effect.flip(call).pipe(
          Effect.provide(StripePayments.layerConfig()),
          Effect.provide(http),
          withConfig({}),
        ),
      );
      expect(error).toBeInstanceOf(PaymentsUnavailable);
      expect(error).toMatchObject({
        provider: "stripe",
        message:
          "Stripe is not configured in this environment (STRIPE_API_KEY is not set or is empty)",
      });
      expect(calls).toHaveLength(0);
    },
  );

  it("reads the key at call time: absent, then present, then absent again", async () => {
    const { http, calls } = stubFetch(customer);
    const program = Effect.fn("program")(function* () {
      const before = yield* Effect.flip(Customer.retrieve("cus_1").pipe(withConfig({})));
      const during = yield* Customer.retrieve("cus_1").pipe(withConfig({ STRIPE_API_KEY: KEY }));
      const after = yield* Effect.flip(Customer.retrieve("cus_1").pipe(withConfig({})));
      return { before, during, after };
    });
    const { before, during, after } = await Effect.runPromise(
      program().pipe(Effect.provide(StripePayments.layerConfig()), Effect.provide(http)),
    );
    expect(before).toBeInstanceOf(PaymentsUnavailable);
    expect(during).toBeInstanceOf(Customer.Customer);
    expect(during.id).toBe("cus_1");
    expect(after).toBeInstanceOf(PaymentsUnavailable);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url.toString()).toBe("https://api.stripe.com/v1/customers/cus_1");
    expect(calls[0]?.headers.get("authorization")).toBe(`Bearer ${KEY}`);
  });

  it("uses whichever key is configured at each call", async () => {
    const { http, calls } = stubFetch(customer);
    await Effect.runPromise(
      Effect.gen(function* () {
        yield* Customer.retrieve("cus_1").pipe(withConfig({ STRIPE_API_KEY: "sk_test_one" }));
        yield* Customer.retrieve("cus_1").pipe(withConfig({ STRIPE_API_KEY: "sk_test_two" }));
      }).pipe(Effect.provide(StripePayments.layerConfig()), Effect.provide(http)),
    );
    expect(calls.map((call) => call.headers.get("authorization"))).toEqual([
      "Bearer sk_test_one",
      "Bearer sk_test_two",
    ]);
  });

  it("treats an empty key as absent", async () => {
    const { http, calls } = stubFetch(customer);
    const error = await Effect.runPromise(
      Effect.flip(Customer.retrieve("cus_1")).pipe(
        Effect.provide(StripePayments.layerConfig()),
        Effect.provide(http),
        withConfig({ STRIPE_API_KEY: "" }),
      ),
    );
    expect(error).toBeInstanceOf(PaymentsUnavailable);
    expect(calls).toHaveLength(0);
  });

  it("treats an empty key a preserveEmptyStrings provider keeps as absent", async () => {
    const { http, calls } = stubFetch(customer);
    const error = await Effect.runPromise(
      Effect.flip(Customer.retrieve("cus_1")).pipe(
        Effect.provide(StripePayments.layerConfig()),
        Effect.provide(http),
        Effect.provide(
          ConfigProvider.layer(
            ConfigProvider.fromEnv({ env: { STRIPE_API_KEY: "" }, preserveEmptyStrings: true }),
          ),
        ),
      ),
    );
    expect(error).toBeInstanceOf(PaymentsUnavailable);
    expect(calls).toHaveLength(0);
  });

  it("reads a named variable and forwards the transport options", async () => {
    const { http, calls } = stubFetch(customer);
    const layer = StripePayments.layerConfig({
      envVar: "BILLING_STRIPE_KEY",
      apiVersion: "2025-08-27.basil",
      baseUrl: "http://localhost:12111",
    });
    const missing = await Effect.runPromise(
      Effect.flip(Customer.retrieve("cus_1")).pipe(
        Effect.provide(layer),
        Effect.provide(http),
        withConfig({ STRIPE_API_KEY: KEY }),
      ),
    );
    expect(missing).toBeInstanceOf(PaymentsUnavailable);
    expect(missing.message).toContain("BILLING_STRIPE_KEY");
    expect(missing.message).not.toContain(KEY);
    expect(calls).toHaveLength(0);

    await Effect.runPromise(
      Customer.retrieve("cus_1").pipe(
        Effect.provide(layer),
        Effect.provide(http),
        withConfig({ BILLING_STRIPE_KEY: KEY }),
      ),
    );
    expect(calls[0]?.url.toString()).toBe("http://localhost:12111/v1/customers/cus_1");
    expect(calls[0]?.headers.get("stripe-version")).toBe("2025-08-27.basil");
  });
});

describe("StripePayments.layerConfig and ConfigProvider", () => {
  it("honours a ConfigProvider attached to the layer when the caller's has no key", async () => {
    const { http, calls } = stubFetch(customer);
    const layer = StripePayments.layerConfig().pipe(
      Layer.provide(ConfigProvider.layer(ConfigProvider.fromUnknown({ STRIPE_API_KEY: KEY }))),
    );
    const result = await Effect.runPromise(
      Customer.retrieve("cus_1").pipe(Effect.provide(layer), Effect.provide(http)),
    );
    expect(result.id).toBe("cus_1");
    expect(calls[0]?.headers.get("authorization")).toBe(`Bearer ${KEY}`);
  });

  it("prefers the caller's ConfigProvider over the layer's", async () => {
    const { http, calls } = stubFetch(customer);
    const layer = StripePayments.layerConfig().pipe(
      Layer.provide(
        ConfigProvider.layer(ConfigProvider.fromUnknown({ STRIPE_API_KEY: "sk_test_layer" })),
      ),
    );
    await Effect.runPromise(
      Customer.retrieve("cus_1").pipe(
        withConfig({ STRIPE_API_KEY: "sk_test_caller" }),
        Effect.provide(layer),
        Effect.provide(http),
      ),
    );
    expect(calls[0]?.headers.get("authorization")).toBe("Bearer sk_test_caller");
  });

  it("serves concurrent calls under different ConfigProviders independently", async () => {
    const { http, calls } = stubFetch(customer);
    const [configured, unconfigured] = await Effect.runPromise(
      Effect.all(
        [
          Customer.retrieve("cus_1").pipe(withConfig({ STRIPE_API_KEY: KEY })),
          Effect.flip(Customer.retrieve("cus_1").pipe(withConfig({}))),
        ],
        { concurrency: "unbounded" },
      ).pipe(Effect.provide(StripePayments.layerConfig()), Effect.provide(http), withConfig({})),
    );
    expect(configured.id).toBe("cus_1");
    expect(unconfigured).toBeInstanceOf(PaymentsUnavailable);
    expect(calls).toHaveLength(1);
  });

  it("treats an unreadable key as absent", async () => {
    const { http, calls } = stubFetch(customer);
    const error = await Effect.runPromise(
      Effect.flip(Customer.retrieve("cus_1")).pipe(
        Effect.provide(StripePayments.layerConfig()),
        Effect.provide(http),
        Effect.provide(
          ConfigProvider.layer(ConfigProvider.fromUnknown({ STRIPE_API_KEY: { nested: true } })),
        ),
      ),
    );
    expect(error).toBeInstanceOf(PaymentsUnavailable);
    expect(calls).toHaveLength(0);
  });

  it("sends a POST with a generated Idempotency-Key once the key is present", async () => {
    const { http, calls } = stubFetch(customer);
    await Effect.runPromise(
      Customer.create({ email: "a@example.test" }).pipe(
        Effect.provide(StripePayments.layerConfig()),
        Effect.provide(http),
        withConfig({ STRIPE_API_KEY: KEY }),
      ),
    );
    expect(calls[0]?.method).toBe("POST");
    expect(calls[0]?.headers.get("idempotency-key")).toMatch(
      /^effect-payments-retry-[0-9a-f-]{36}$/,
    );
  });
});

describe("StripeHttp.layerConfig", () => {
  it("fails a resource module with PaymentsUnavailable while the key is absent", async () => {
    const { http, calls } = stubFetch(customer);
    const error = await Effect.runPromise(
      Effect.flip(StripeCustomer.retrieve("cus_1")).pipe(
        Effect.provide(StripeHttp.layerConfig()),
        Effect.provide(http),
        withConfig({}),
      ),
    );
    expect(error).toBeInstanceOf(PaymentsUnavailable);
    expect(calls).toHaveLength(0);
  });

  it("sends a resource module's request once the key is present", async () => {
    const { http, calls } = stubFetch(customer);
    const result = await Effect.runPromise(
      StripeCustomer.retrieve("cus_1").pipe(
        Effect.provide(StripeHttp.layerConfig()),
        Effect.provide(http),
        withConfig({ STRIPE_API_KEY: KEY }),
      ),
    );
    expect(result).toMatchObject({ id: "cus_1" });
    expect(calls[0]?.headers.get("authorization")).toBe(`Bearer ${KEY}`);
  });
});
