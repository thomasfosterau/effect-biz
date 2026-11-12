import { expect } from "vite-plus/test";
import { layer } from "@effect/vitest";
import { FetchHttpClient } from "effect/http";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as R from "effect/Record";
import * as BillingPortal from "@thomasfosterau/effect-biz/Payments.BillingPortal";
import * as CheckoutSession from "@thomasfosterau/effect-biz/Payments.CheckoutSession";
import * as Customer from "@thomasfosterau/effect-biz/Payments.Customer";
import * as PaymentIntent from "@thomasfosterau/effect-biz/Payments.PaymentIntent";
import * as Price from "@thomasfosterau/effect-biz/Payments.Price";
import * as Product from "@thomasfosterau/effect-biz/Payments.Product";
import * as Refund from "@thomasfosterau/effect-biz/Payments.Refund";
import * as Subscription from "@thomasfosterau/effect-biz/Payments.Subscription";
import { PaymentsUnavailable, type PaymentsError } from "@thomasfosterau/effect-biz/Payments";
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

type ConfigValues = Readonly<Record<string, string | { readonly nested: boolean }>>;

/** Configuration holding `values`, for one call. */
const withConfig = (values: ConfigValues) =>
  Effect.provideService(ConfigProvider.ConfigProvider, ConfigProvider.fromUnknown(values));

/** A stubbed `fetch` answering {@link customer}, served as `FetchHttpClient.Fetch`. */
const stubbed = () => {
  const { fetch, calls } = stubFetch(customer);
  return { calls, served: Effect.provideService(FetchHttpClient.Fetch, fetch) };
};

/** The capabilities, resolving their key at call time, over an `HttpClient` on `Fetch`. */
const configured = (options?: StripeHttp.LayerConfigOptions) =>
  Layer.provideMerge(StripePayments.layerConfig(options), FetchHttpClient.layer);

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
} satisfies Record<string, Effect.Effect<unknown, PaymentsError, Capabilities>>;

const customer = () =>
  jsonResponse(200, { id: "cus_1", object: "customer", created: 1_700_000_000, livemode: false });

layer(configured())("StripePayments.layerConfig", (it) => {
  it.effect("builds with no key configured, without reading it or sending anything", () =>
    Effect.gen(function* () {
      const { calls, served } = stubbed();
      yield* Layer.build(StripePayments.layerConfig()).pipe(served, withConfig({}));
      expect(calls).toHaveLength(0);
    }),
  );

  it.effect.each(
    R.toEntries<string, Effect.Effect<unknown, PaymentsError, Capabilities>>(everyCall),
  )("fails %s with PaymentsUnavailable while the key is absent", ([_, call]) =>
    Effect.gen(function* () {
      const { calls, served } = stubbed();
      const error = yield* Effect.flip(Effect.asVoid(call)).pipe(served, withConfig({}));
      expect(error).toBeInstanceOf(PaymentsUnavailable);
      expect(error).toMatchObject({
        provider: "stripe",
        message:
          "Stripe is not configured in this environment (STRIPE_API_KEY is not set or is empty)",
      });
      expect(calls).toHaveLength(0);
    }),
  );

  it.effect("reads the key at call time: absent, then present, then absent again", () =>
    Effect.gen(function* () {
      const { calls, served } = stubbed();
      const program = Effect.fn("program")(function* () {
        const before = yield* Effect.flip(Customer.retrieve("cus_1").pipe(withConfig({})));
        const during = yield* Customer.retrieve("cus_1").pipe(withConfig({ STRIPE_API_KEY: KEY }));
        const after = yield* Effect.flip(Customer.retrieve("cus_1").pipe(withConfig({})));
        return { before, during, after };
      });
      const { before, during, after } = yield* program().pipe(served);
      expect(before).toBeInstanceOf(PaymentsUnavailable);
      expect(during).toBeInstanceOf(Customer.Customer);
      expect(during.id).toBe("cus_1");
      expect(after).toBeInstanceOf(PaymentsUnavailable);
      expect(calls).toHaveLength(1);
      expect(calls[0]?.url.toString()).toBe("https://api.stripe.com/v1/customers/cus_1");
      expect(calls[0]?.headers.get("authorization")).toBe(`Bearer ${KEY}`);
    }),
  );

  it.effect("uses whichever key is configured at each call", () =>
    Effect.gen(function* () {
      const { calls, served } = stubbed();
      yield* Effect.gen(function* () {
        yield* Customer.retrieve("cus_1").pipe(withConfig({ STRIPE_API_KEY: "sk_test_one" }));
        yield* Customer.retrieve("cus_1").pipe(withConfig({ STRIPE_API_KEY: "sk_test_two" }));
      }).pipe(served);
      expect(calls.map((call) => call.headers.get("authorization"))).toEqual([
        "Bearer sk_test_one",
        "Bearer sk_test_two",
      ]);
    }),
  );

  it.effect("treats an empty key as absent", () =>
    Effect.gen(function* () {
      const { calls, served } = stubbed();
      const error = yield* Effect.flip(Customer.retrieve("cus_1")).pipe(
        served,
        withConfig({ STRIPE_API_KEY: "" }),
      );
      expect(error).toBeInstanceOf(PaymentsUnavailable);
      expect(calls).toHaveLength(0);
    }),
  );

  it.effect("treats an empty key a preserveEmptyStrings provider keeps as absent", () =>
    Effect.gen(function* () {
      const { calls, served } = stubbed();
      const error = yield* Effect.flip(Customer.retrieve("cus_1")).pipe(
        served,
        Effect.provideService(
          ConfigProvider.ConfigProvider,
          ConfigProvider.fromEnv({ env: { STRIPE_API_KEY: "" }, preserveEmptyStrings: true }),
        ),
      );
      expect(error).toBeInstanceOf(PaymentsUnavailable);
      expect(calls).toHaveLength(0);
    }),
  );
});

layer(
  configured({
    envVar: "BILLING_STRIPE_KEY",
    apiVersion: "2025-08-27.basil",
    baseUrl: "http://localhost:12111",
  }),
)("StripePayments.layerConfig with options", (it) => {
  it.effect("reads a named variable and forwards the transport options", () =>
    Effect.gen(function* () {
      const { calls, served } = stubbed();
      const missing = yield* Effect.flip(Customer.retrieve("cus_1")).pipe(
        served,
        withConfig({ STRIPE_API_KEY: KEY }),
      );
      expect(missing).toBeInstanceOf(PaymentsUnavailable);
      expect(missing.message).toContain("BILLING_STRIPE_KEY");
      expect(missing.message).not.toContain(KEY);
      expect(calls).toHaveLength(0);

      yield* Customer.retrieve("cus_1").pipe(served, withConfig({ BILLING_STRIPE_KEY: KEY }));
      expect(calls[0]?.url.toString()).toBe("http://localhost:12111/v1/customers/cus_1");
      expect(calls[0]?.headers.get("stripe-version")).toBe("2025-08-27.basil");
    }),
  );
});

// The layer carries its own ConfigProvider, so each of these two cases builds its own layer.
layer(
  Layer.provideMerge(
    StripePayments.layerConfig().pipe(
      Layer.provide(ConfigProvider.layer(ConfigProvider.fromUnknown({ STRIPE_API_KEY: KEY }))),
    ),
    FetchHttpClient.layer,
  ),
)("StripePayments.layerConfig and ConfigProvider (layer-attached)", (it) => {
  it.effect("honours a ConfigProvider attached to the layer when the caller's has no key", () =>
    Effect.gen(function* () {
      const { calls, served } = stubbed();
      const result = yield* Customer.retrieve("cus_1").pipe(served);
      expect(result.id).toBe("cus_1");
      expect(calls[0]?.headers.get("authorization")).toBe(`Bearer ${KEY}`);
    }),
  );
});

layer(
  Layer.provideMerge(
    StripePayments.layerConfig().pipe(
      Layer.provide(
        ConfigProvider.layer(ConfigProvider.fromUnknown({ STRIPE_API_KEY: "sk_test_layer" })),
      ),
    ),
    FetchHttpClient.layer,
  ),
)("StripePayments.layerConfig and ConfigProvider (layer-attached)", (it) => {
  it.effect("prefers the caller's ConfigProvider over the layer's", () =>
    Effect.gen(function* () {
      const { calls, served } = stubbed();
      yield* Customer.retrieve("cus_1").pipe(
        withConfig({ STRIPE_API_KEY: "sk_test_caller" }),
        served,
      );
      expect(calls[0]?.headers.get("authorization")).toBe("Bearer sk_test_caller");
    }),
  );
});

layer(configured())("StripePayments.layerConfig and ConfigProvider", (it) => {
  it.effect("serves concurrent calls under different ConfigProviders independently", () =>
    Effect.gen(function* () {
      const { calls, served } = stubbed();
      const [keyed, unkeyed] = yield* Effect.all(
        [
          Customer.retrieve("cus_1").pipe(withConfig({ STRIPE_API_KEY: KEY })),
          Effect.flip(Customer.retrieve("cus_1").pipe(withConfig({}))),
        ],
        { concurrency: "unbounded" },
      ).pipe(served, withConfig({}));
      expect(keyed.id).toBe("cus_1");
      expect(unkeyed).toBeInstanceOf(PaymentsUnavailable);
      expect(calls).toHaveLength(1);
    }),
  );

  it.effect("treats an unreadable key as absent", () =>
    Effect.gen(function* () {
      const { calls, served } = stubbed();
      const error = yield* Effect.flip(Customer.retrieve("cus_1")).pipe(
        served,
        withConfig({ STRIPE_API_KEY: { nested: true } }),
      );
      expect(error).toBeInstanceOf(PaymentsUnavailable);
      expect(calls).toHaveLength(0);
    }),
  );

  it.effect("sends a POST with a generated Idempotency-Key once the key is present", () =>
    Effect.gen(function* () {
      const { calls, served } = stubbed();
      yield* Customer.create({ email: "a@example.test" }).pipe(
        served,
        withConfig({ STRIPE_API_KEY: KEY }),
      );
      expect(calls[0]?.method).toBe("POST");
      expect(calls[0]?.headers.get("idempotency-key")).toMatch(
        /^effect-payments-retry-[0-9a-f-]{36}$/,
      );
    }),
  );
});

layer(Layer.provideMerge(StripeHttp.layerConfig(), FetchHttpClient.layer))(
  "StripeHttp.layerConfig",
  (it) => {
    it.effect("fails a resource module with PaymentsUnavailable while the key is absent", () =>
      Effect.gen(function* () {
        const { calls, served } = stubbed();
        const error = yield* Effect.flip(StripeCustomer.retrieve("cus_1")).pipe(
          served,
          withConfig({}),
        );
        expect(error).toBeInstanceOf(PaymentsUnavailable);
        expect(calls).toHaveLength(0);
      }),
    );

    it.effect("sends a resource module's request once the key is present", () =>
      Effect.gen(function* () {
        const { calls, served } = stubbed();
        const result = yield* StripeCustomer.retrieve("cus_1").pipe(
          served,
          withConfig({ STRIPE_API_KEY: KEY }),
        );
        expect(result).toMatchObject({ id: "cus_1" });
        expect(calls[0]?.headers.get("authorization")).toBe(`Bearer ${KEY}`);
      }),
    );
  },
);
