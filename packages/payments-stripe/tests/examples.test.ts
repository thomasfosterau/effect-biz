/**
 * Runs every example in `examples/` (effect-finance#127): each file exports its Effect
 * program, and this suite runs it over a stubbed `fetch` answering with canned
 * Stripe responses, then asserts what a reader would see: the requests sent,
 * the result, and the lines printed. `examples covered` fails when a file in
 * `examples/` has no suite here, so a new example cannot ship unrun.
 */

// oxlint-disable-next-line effect/use-filesystem-service -- a test listing the examples on disk, outside any Effect runtime
import { readdirSync } from "node:fs";
import { afterAll, afterEach, describe, expect, it, vi } from "vite-plus/test";
import * as Arr from "effect/Array";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Order from "effect/Order";
import * as Rec from "effect/Record";
import { FetchHttpClient } from "effect/http";
import * as basic from "../examples/basic.ts";
import * as subscription from "../examples/subscription.ts";
import * as webhooks from "../examples/webhooks.ts";
import { formOf, jsonResponse, stubStripeTable, TEST_KEY } from "./support.ts";

// The examples are imported statically below, before any test can spy on
// `fetch`: an example that ran on import would reach the live API (with
// whatever key the environment holds). Hoisted above those imports, this
// stub refuses instead. `vi.stubGlobal` (undone in `afterAll`) keeps the stub
// from leaking into other files sharing this worker under `isolate: false`.
// The suites run over `FetchHttpClient.Fetch`, never the global.
vi.hoisted(() => {
  vi.stubGlobal("fetch", () => Promise.reject(new Error("an example called fetch on import")));
});

afterAll(() => {
  vi.unstubAllGlobals();
});

const EXAMPLES = new URL("../examples/", import.meta.url);

/** Every runnable example on disk. */
// oxlint-disable-next-line effect/avoid-sync-fs -- see the import
const onDisk = readdirSync(EXAMPLES);
const exampleFiles = Arr.sort(
  Arr.filter(onDisk, (name) => /\.(m|c)?tsx?$/.test(name)),
  Order.String,
);

/**
 * Run an example's program with its console captured and `fetch` stubbed, as
 * `FetchHttpClient.Fetch`: the examples bring their own
 * `FetchHttpClient.layer`, which reads the implementation per request.
 */
const runExample = async <A, E>(
  program: Effect.Effect<A, E>,
  fetch: typeof globalThis.fetch,
): Promise<{ readonly exit: Exit.Exit<A, E>; readonly lines: ReadonlyArray<string> }> => {
  const lines: Array<string> = [];
  const record = (...args: ReadonlyArray<unknown>) => {
    lines.push(args.map(String).join(" "));
  };
  const console: Console.Console = { ...globalThis.console, log: record, error: record };
  const exit = await Effect.runPromiseExit(
    program.pipe(
      Effect.provideService(Console.Console, console),
      Effect.provideService(FetchHttpClient.Fetch, fetch),
    ),
  );
  return { exit, lines };
};

/** A `fetch` that fails the test if anything reaches the network. */
const noNetwork: typeof globalThis.fetch = () =>
  Promise.reject(new Error("an offline example called fetch"));

/** The typed failure of an exit expected to fail; `undefined` for a success or a defect. */
const failureOf = <A, E>(exit: Exit.Exit<A, E>): E | undefined =>
  Option.getOrUndefined(Exit.findErrorOption(exit));

const customer = {
  id: "cus_1",
  email: "customer@example.com",
  name: "John Doe",
  phone: null,
  description: null,
  metadata: { userId: "user_123" },
  created: 1700000000,
  livemode: false,
};

const paymentIntent = {
  id: "pi_1",
  amount: 2000,
  currency: "usd",
  status: "requires_payment_method",
  customer: "cus_1",
  payment_method: null,
  client_secret: "pi_1_secret_x",
  description: null,
  metadata: { orderId: "order_456" },
  created: 1700000001,
};

const product = {
  id: "prod_1",
  name: "Premium Subscription",
  description: "Monthly premium subscription",
  active: true,
  metadata: {},
  created: 1700000002,
};

const price = {
  id: "price_1",
  product: "prod_1",
  active: true,
  currency: "usd",
  unit_amount: 1999,
  type: "recurring",
  recurring: { interval: "month", interval_count: 1 },
  metadata: {},
  created: 1700000003,
};

const stripeSubscription = {
  id: "sub_1",
  customer: "cus_1",
  status: "incomplete",
  items: { object: "list", data: [{ id: "si_1", price: { id: "price_1" }, quantity: 1 }] },
  current_period_start: 1700000004,
  current_period_end: 1702592004,
  cancel_at_period_end: false,
  metadata: {},
  created: 1700000004,
};

/** A Stripe error envelope (`{ error: { type, message, code? } }`) with `status`. */
const stripeError = (status: number, error: Readonly<Record<string, string>>) =>
  jsonResponse(status, { error });

/**
 * One suite per file in `examples/`, keyed by file name. A new example needs
 * an entry here (`examples covered` enforces it).
 */
const suites = {
  "basic.ts": () => {
    it("creates the customer, then a payment intent for it", async () => {
      const stripe = stubStripeTable({
        "POST /v1/customers": customer,
        "POST /v1/payment_intents": paymentIntent,
      });
      const { exit, lines } = await runExample(
        basic.program.pipe(Effect.provide(basic.layer)),
        stripe.fetch,
      );

      expect(Exit.isSuccess(exit) && exit.value.customer.id).toBe("cus_1");
      expect(Exit.isSuccess(exit) && exit.value.paymentIntent.id).toBe("pi_1");
      expect(stripe.calls.map((call) => [call.method, call.path, call.params])).toEqual([
        [
          "POST",
          "/v1/customers",
          formOf({
            email: "customer@example.com",
            name: "John Doe",
            metadata: { userId: "user_123" },
          }),
        ],
        [
          "POST",
          "/v1/payment_intents",
          formOf({
            amount: 2000,
            currency: "usd",
            customer: "cus_1",
            metadata: { orderId: "order_456" },
          }),
        ],
      ]);
      expect(lines).toEqual([
        "Creating customer...",
        "Customer created: cus_1",
        "Creating payment intent...",
        "Payment intent created: pi_1",
        "Status: requires_payment_method",
        "Amount: $20",
      ]);
    });

    it("logs a rejected key as a neutral authentication failure and keeps the failure", async () => {
      const stripe = stubStripeTable({
        "POST /v1/customers": stripeError(401, {
          type: "invalid_request_error",
          message: "Invalid API Key provided",
        }),
      });
      const { exit, lines } = await runExample(
        basic.program.pipe(Effect.provide(basic.layer)),
        stripe.fetch,
      );

      expect(failureOf(exit)).toMatchObject({ _tag: "PaymentAuthenticationError" });
      expect(stripe.calls).toHaveLength(1);
      expect(lines.at(-1)).toMatch(/^Authentication failed: /);
    });

    it("logs a declined payment as a neutral provider error and keeps the failure", async () => {
      const stripe = stubStripeTable({
        "POST /v1/customers": customer,
        "POST /v1/payment_intents": stripeError(402, {
          type: "card_error",
          message: "Your card was declined.",
          code: "card_declined",
        }),
      });
      const { exit, lines } = await runExample(
        basic.program.pipe(Effect.provide(basic.layer)),
        stripe.fetch,
      );

      expect(failureOf(exit)).toMatchObject({ _tag: "PaymentProviderError" });
      expect(lines.at(-1)).toMatch(/^Provider error from stripe \(card_declined\): /);
    });
  },

  "subscription.ts": () => {
    it("creates a customer, product, recurring price and subscription with the key from STRIPE_API_KEY", async () => {
      const stripe = stubStripeTable({
        "POST /v1/customers": { ...customer, email: "subscriber@example.com", name: "Jane Smith" },
        "POST /v1/products": product,
        "POST /v1/prices": price,
        "POST /v1/subscriptions": stripeSubscription,
      });
      const env = ConfigProvider.layer(ConfigProvider.fromUnknown({ STRIPE_API_KEY: TEST_KEY }));
      const { exit, lines } = await runExample(
        subscription.program.pipe(Effect.provide(subscription.layer.pipe(Layer.provide(env)))),
        stripe.fetch,
      );

      expect(Exit.isSuccess(exit) && exit.value.subscription.id).toBe("sub_1");
      expect(stripe.calls.map((call) => [call.method, call.path, call.params])).toEqual([
        ["POST", "/v1/customers", formOf({ email: "subscriber@example.com", name: "Jane Smith" })],
        [
          "POST",
          "/v1/products",
          formOf({ name: "Premium Subscription", description: "Monthly premium subscription" }),
        ],
        [
          "POST",
          "/v1/prices",
          formOf({
            product: "prod_1",
            unit_amount: 1999,
            currency: "usd",
            recurring: { interval: "month" },
          }),
        ],
        ["POST", "/v1/subscriptions", formOf({ customer: "cus_1", items: [{ price: "price_1" }] })],
      ]);
      expect(stripe.calls.map((call) => call.headers.get("authorization"))).toEqual(
        Array.from({ length: 4 }, () => `Bearer ${TEST_KEY}`),
      );
      expect(lines).toEqual([
        "Creating customer...",
        "Customer created: cus_1",
        "Creating product...",
        "Product created: prod_1",
        "Creating price...",
        "Price created: price_1",
        "Creating subscription...",
        "Subscription created: sub_1",
        "Status: incomplete",
      ]);
    });

    it("fails with PaymentConfigError, sending nothing, when STRIPE_API_KEY is unset", async () => {
      const stripe = stubStripeTable({});
      const env = ConfigProvider.layer(ConfigProvider.fromUnknown({}));
      const { exit } = await runExample(
        subscription.program.pipe(Effect.provide(subscription.layer.pipe(Layer.provide(env)))),
        stripe.fetch,
      );

      expect(failureOf(exit)).toMatchObject({ _tag: "PaymentConfigError" });
      expect(stripe.calls).toHaveLength(0);
    });
  },

  "webhooks.ts": () => {
    it("answers each signed or refused test delivery with its documented status, offline", async () => {
      const { exit, lines } = await runExample(webhooks.program, noNetwork);

      expect(Exit.isSuccess(exit)).toBe(true);
      expect(lines.filter((line) => /: \d{3}$/.test(line))).toEqual([
        "Signed checkout.session.completed: 200",
        "Signed charge.succeeded (unhandled type): 200",
        "Signed customer.subscription.updated that fails to decode: 500",
        "Tampered body: 400",
        "Missing header: 400",
        "Signed with another secret: 400",
        "Signed ten minutes ago: 400",
      ]);
      expect(lines).toContain(
        "Checkout session cs_test_123 completed (customer cus_test_123, subscription sub_test_123)",
      );
      expect(lines).toContain("Acknowledged unhandled event type charge.succeeded");
      // The undecodable delivery's error log goes through the captured console.
      expect(lines.some((line) => line.includes("Handled Stripe event failed to decode"))).toBe(
        true,
      );
    });

    it("fails to build the handler with a ConfigError when STRIPE_WEBHOOK_SECRET is unset", async () => {
      const { exit } = await runExample(
        webhooks
          .makeWebhookHandler()
          .pipe(Effect.provide(ConfigProvider.layer(ConfigProvider.fromUnknown({})))),
        noNetwork,
      );

      expect(failureOf(exit)).toMatchObject({ _tag: "ConfigError" });
    });
  },
} satisfies Record<string, () => void>;

describe("examples", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("examples covered: every file in examples/ has a suite here", () => {
    expect(exampleFiles.length).toBeGreaterThan(0);
    expect(Arr.sort(Rec.keys(suites), Order.String)).toEqual(exampleFiles);
  });

  it.each(exampleFiles)("importing %s runs nothing", async (file) => {
    // Mocked, never spied through: an example that ran on import would
    // otherwise reach the live API (with whatever key the environment holds)
    // and print into the test output.
    const fetch = vi
      .spyOn(globalThis, "fetch")
      .mockRejectedValue(new Error("an example called fetch on import"));
    const log = vi.spyOn(globalThis.console, "log").mockImplementation(() => {});
    const error = vi.spyOn(globalThis.console, "error").mockImplementation(() => {});
    vi.resetModules();

    await import(new URL(file, EXAMPLES).href);
    // A top-level `Effect.runPromise(program)` starts its fiber on import but
    // reaches `fetch` or the console only after a few turns of the event loop;
    // waiting a little gives it the time to do so, so it cannot slip past the
    // assertions below.
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(fetch).not.toHaveBeenCalled();
    expect(log).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
  });

  Arr.forEach(Rec.toEntries(suites), ([file, suite]) => {
    describe(`examples/${file}`, suite);
  });
});
