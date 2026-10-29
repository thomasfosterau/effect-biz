/**
 * Stripe implementations of the vendor-neutral payments capabilities.
 *
 * Each capability defined by `@thomasfosterau/effect-biz/Payments` is implemented
 * here as a `Layer` over Distilled's Stripe operations
 * (`@distilled.cloud/stripe`): neutral parameters are mapped onto the
 * operation's input, the call runs under this package's request policy
 * (`Stripe-Version` pinned to {@link DISTILLED_API_VERSION}, the SDK's retries and
 * per-attempt timeout, redirects refused, failures mapped onto the neutral
 * {@link PaymentsError} channel), and every response is decoded with `Schema`
 * before it is mapped onto a neutral entity.
 *
 * The per-capability layers and {@link capabilities} need Distilled's
 * `Credentials` and an `HttpClient`. The {@link layer} / {@link layerFromEnv} /
 * {@link layerConfig} helpers supply the credentials from configuration, so a
 * program written against the neutral core is satisfied by one
 * `Effect.provide` plus an `HttpClient` (e.g. `FetchHttpClient.layer`).
 *
 * @module
 */

import type * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type { HttpClient } from "effect/http";
import type { Credentials } from "@distilled.cloud/stripe/Credentials";
import {
  CreateBillingPortalSession,
  CreateCheckoutSession,
  CreateCustomer,
  CreatePaymentIntent,
  CreatePaymentIntentCancel,
  CreatePaymentIntentConfirm,
  CreatePrice,
  CreateProduct,
  CreateRefund,
  CreateSubscription,
  DeleteCustomer,
  DeleteProduct,
  DeleteSubscription,
  GetCustomer,
  GetCustomers,
  GetPaymentIntent,
  GetPaymentIntents,
  GetPrice,
  GetPrices,
  GetProduct,
  GetProducts,
  GetRefund,
  GetRefunds,
  GetSubscription,
  GetSubscriptions,
  UpdateCustomer,
  UpdatePaymentIntent,
  UpdatePrice,
  UpdateProduct,
  UpdateRefund,
  UpdateSubscription,
} from "@distilled.cloud/stripe/stripe";
// The capability modules are imported by subpath, as namespaces: a bundler can
// then tell that the tags passed to the pure layer constructions below are
// side-effect free, and drop every capability (and the Distilled operations
// it calls) a program does not use.
import * as BillingPortalNS from "@thomasfosterau/effect-biz/Payments.BillingPortal";
import * as CheckoutSessionNS from "@thomasfosterau/effect-biz/Payments.CheckoutSession";
import * as CustomerNS from "@thomasfosterau/effect-biz/Payments.Customer";
import * as IdempotencyKeyNS from "@thomasfosterau/effect-biz/Payments.IdempotencyKey";
import * as PaymentIntentNS from "@thomasfosterau/effect-biz/Payments.PaymentIntent";
import * as PriceNS from "@thomasfosterau/effect-biz/Payments.Price";
import * as ProductNS from "@thomasfosterau/effect-biz/Payments.Product";
import * as RefundNS from "@thomasfosterau/effect-biz/Payments.Refund";
import * as SubscriptionNS from "@thomasfosterau/effect-biz/Payments.Subscription";
import type { PaymentConfigError, PaymentsError } from "@thomasfosterau/effect-biz/Payments";
import { checkId, omitUndefined } from "@thomasfosterau/effect-biz/Payments.internal";
import {
  decodeBillingPortalSession,
  decodeCheckoutSession,
  decodeCustomer,
  decodeCustomerPage,
  decodeDeleted,
  decodePaymentIntent,
  decodePaymentIntentPage,
  decodePrice,
  decodePricePage,
  decodeProduct,
  decodeProductPage,
  decodeRefund,
  decodeRefundPage,
  decodeSubscription,
  decodeSubscriptionPage,
} from "./internal/mapping.js";
import {
  layer as clientLayer,
  layerConfig as clientLayerConfig,
  type LayerConfigOptions,
  layerFromContext as clientLayerFromContext,
  layerFromEnv as clientLayerFromEnv,
  type Method,
  type Operation,
  StripeHttp,
  type StripeHttpConfig,
} from "./StripeHttp.js";

/**
 * The Stripe API version every capability layer pins in `Stripe-Version`
 * unless configured: the one the pinned `@distilled.cloud/stripe` release's
 * schemas are generated from (`2026-09-30.endive` for `1.0.0-rc.15`). It moves
 * whenever this package moves its Distilled pin, so create the webhook
 * endpoints whose events a program reads beside the capabilities at this
 * version. The resource modules and `StripeHttp` pin the same one.
 */
export { DISTILLED_API_VERSION } from "./internal/apiVersion.js";

/**
 * The requirements of a capability layer: Distilled's `Credentials` (the key
 * and API origin, e.g. `Credentials.credentials({ apiKey })`, with `apiKey` a
 * `Redacted<string>`, from
 * `@distilled.cloud/stripe/Credentials`) and an `HttpClient`.
 */
type Requirements = Credentials | HttpClient.HttpClient;

/**
 * One call through the client, its response decoded by `decode`. `id`, when
 * given, names the resource and the path id the input carries, checked
 * first; `idempotencyKey` is the neutral key of a create or confirm
 * operation, sent as the `Idempotency-Key` header after
 * `IdempotencyKey.validate`.
 */
const call =
  (client: StripeHttp["Service"]) =>
  <I, O, E, A>(
    method: Method,
    operation: Operation<I, O, E>,
    input: I,
    decode: (body: unknown) => Effect.Effect<A, PaymentsError>,
    options: {
      readonly id?: readonly [resource: string, id: string] | undefined;
      readonly idempotencyKey?: string | undefined;
    } = {},
  ): Effect.Effect<A, PaymentsError> =>
    // The key is checked before anything is sent: the brand guarantees its
    // shape for typed callers, this refuses a raw string from untyped code.
    Effect.flatMap(IdempotencyKeyNS.validate(options.idempotencyKey), (key) =>
      (options.id === undefined ? Effect.void : checkId(...options.id)).pipe(
        Effect.andThen(client.call(method, operation, input, { idempotencyKey: key })),
        Effect.flatMap(decode),
      ),
    );

/** The request function a capability's implementation is written against. */
type Request = ReturnType<typeof call>;

/** A capability layer over the client, given the service it builds from it. */
const over = <I, S>(
  tag: Context.Key<I, S>,
  build: (request: Request) => NoInfer<S>,
): Layer.Layer<I, never, StripeHttp> =>
  Layer.effect(
    tag,
    Effect.map(StripeHttp, (client) => build(call(client))),
  );

// ---------------------------------------------------------------------------
// Customers
// ---------------------------------------------------------------------------

const customers = /* @__PURE__ */ over(CustomerNS.Customers, (request) => {
  const fields = (params: CustomerNS.UpdateParams) =>
    omitUndefined({
      email: params.email,
      name: params.name,
      phone: params.phone,
      description: params.description,
      metadata: params.metadata,
    });
  return {
    create: (params) =>
      request("POST", CreateCustomer, fields(params), decodeCustomer, {
        idempotencyKey: params.idempotencyKey,
      }),
    retrieve: (id) =>
      request("GET", GetCustomer, { customer: id }, decodeCustomer, { id: ["customer", id] }),
    update: (id, params) =>
      request("POST", UpdateCustomer, { customer: id, ...fields(params) }, decodeCustomer, {
        id: ["customer", id],
      }),
    del: (id) =>
      request("DELETE", DeleteCustomer, { customer: id }, decodeDeleted, { id: ["customer", id] }),
    list: (params) =>
      request(
        "GET",
        GetCustomers,
        omitUndefined({
          limit: params?.limit,
          email: params?.email,
          starting_after: params?.startingAfter,
        }),
        decodeCustomerPage,
      ),
  };
});

/** Stripe implementation of the {@link CustomerNS.Customers} capability. */
export const customersLayer: Layer.Layer<CustomerNS.Customers, never, Requirements> =
  /* @__PURE__ */ Layer.provide(customers, clientLayerFromContext);

// ---------------------------------------------------------------------------
// Products
// ---------------------------------------------------------------------------

const products = /* @__PURE__ */ over(ProductNS.Products, (request) => {
  const fields = (params: ProductNS.UpdateParams) =>
    omitUndefined({
      name: params.name,
      description: params.description,
      active: params.active,
      metadata: params.metadata,
    });
  return {
    create: (params) =>
      request("POST", CreateProduct, { ...fields(params), name: params.name }, decodeProduct, {
        idempotencyKey: params.idempotencyKey,
      }),
    retrieve: (id) => request("GET", GetProduct, { id }, decodeProduct, { id: ["product", id] }),
    update: (id, params) =>
      request("POST", UpdateProduct, { id, ...fields(params) }, decodeProduct, {
        id: ["product", id],
      }),
    del: (id) => request("DELETE", DeleteProduct, { id }, decodeDeleted, { id: ["product", id] }),
    list: (params) =>
      request(
        "GET",
        GetProducts,
        omitUndefined({
          limit: params?.limit,
          active: params?.active,
          starting_after: params?.startingAfter,
        }),
        decodeProductPage,
      ),
  };
});

/** Stripe implementation of the {@link ProductNS.Products} capability. */
export const productsLayer: Layer.Layer<ProductNS.Products, never, Requirements> =
  /* @__PURE__ */ Layer.provide(products, clientLayerFromContext);

// ---------------------------------------------------------------------------
// Prices
// ---------------------------------------------------------------------------

const prices = /* @__PURE__ */ over(PriceNS.Prices, (request) => ({
  create: (params) =>
    request(
      "POST",
      CreatePrice,
      omitUndefined({
        product: params.product,
        currency: params.currency,
        unit_amount: params.unitAmount,
        recurring:
          params.recurring &&
          omitUndefined({
            interval: params.recurring.interval,
            interval_count: params.recurring.intervalCount,
          }),
        active: params.active,
        metadata: params.metadata,
      }),
      decodePrice,
      { idempotencyKey: params.idempotencyKey },
    ),
  retrieve: (id) => request("GET", GetPrice, { price: id }, decodePrice, { id: ["price", id] }),
  update: (id, params) =>
    request(
      "POST",
      UpdatePrice,
      { price: id, ...omitUndefined({ active: params.active, metadata: params.metadata }) },
      decodePrice,
      { id: ["price", id] },
    ),
  list: (params) =>
    request(
      "GET",
      GetPrices,
      omitUndefined({
        limit: params?.limit,
        product: params?.product,
        active: params?.active,
        starting_after: params?.startingAfter,
      }),
      decodePricePage,
    ),
}));

/** Stripe implementation of the {@link PriceNS.Prices} capability. */
export const pricesLayer: Layer.Layer<PriceNS.Prices, never, Requirements> =
  /* @__PURE__ */ Layer.provide(prices, clientLayerFromContext);

// ---------------------------------------------------------------------------
// PaymentIntents
// ---------------------------------------------------------------------------

const paymentIntents = /* @__PURE__ */ over(PaymentIntentNS.PaymentIntents, (request) => ({
  create: (params) =>
    request(
      "POST",
      CreatePaymentIntent,
      omitUndefined({
        amount: params.amount,
        currency: params.currency,
        customer: params.customer,
        payment_method: params.paymentMethod,
        description: params.description,
        metadata: params.metadata,
      }),
      decodePaymentIntent,
      { idempotencyKey: params.idempotencyKey },
    ),
  retrieve: (id) =>
    request("GET", GetPaymentIntent, { intent: id }, decodePaymentIntent, {
      id: ["payment intent", id],
    }),
  update: (id, params) =>
    request(
      "POST",
      UpdatePaymentIntent,
      {
        intent: id,
        ...omitUndefined({
          amount: params.amount,
          description: params.description,
          metadata: params.metadata,
        }),
      },
      decodePaymentIntent,
      { id: ["payment intent", id] },
    ),
  confirm: (id, params) =>
    request(
      "POST",
      CreatePaymentIntentConfirm,
      { intent: id, ...omitUndefined({ payment_method: params?.paymentMethod }) },
      decodePaymentIntent,
      { id: ["payment intent", id], idempotencyKey: params?.idempotencyKey },
    ),
  cancel: (id) =>
    request("POST", CreatePaymentIntentCancel, { intent: id }, decodePaymentIntent, {
      id: ["payment intent", id],
    }),
  list: (params) =>
    request(
      "GET",
      GetPaymentIntents,
      omitUndefined({
        limit: params?.limit,
        customer: params?.customer,
        starting_after: params?.startingAfter,
      }),
      decodePaymentIntentPage,
    ),
}));

/** Stripe implementation of the {@link PaymentIntentNS.PaymentIntents} capability. */
export const paymentIntentsLayer: Layer.Layer<PaymentIntentNS.PaymentIntents, never, Requirements> =
  /* @__PURE__ */ Layer.provide(paymentIntents, clientLayerFromContext);

// ---------------------------------------------------------------------------
// Subscriptions
// ---------------------------------------------------------------------------

const subscriptions = /* @__PURE__ */ over(SubscriptionNS.Subscriptions, (request) => ({
  create: (params) =>
    request(
      "POST",
      CreateSubscription,
      omitUndefined({
        customer: params.customer,
        items: params.items.map((item) =>
          omitUndefined({ price: item.price, quantity: item.quantity }),
        ),
        cancel_at_period_end: params.cancelAtPeriodEnd,
        metadata: params.metadata,
      }),
      decodeSubscription,
      { idempotencyKey: params.idempotencyKey },
    ),
  retrieve: (id) =>
    request("GET", GetSubscription, { subscription_exposed_id: id }, decodeSubscription, {
      id: ["subscription", id],
    }),
  update: (id, params) =>
    request(
      "POST",
      UpdateSubscription,
      {
        subscription_exposed_id: id,
        ...omitUndefined({
          cancel_at_period_end: params.cancelAtPeriodEnd,
          metadata: params.metadata,
        }),
      },
      decodeSubscription,
      { id: ["subscription", id] },
    ),
  cancel: (id) =>
    request("DELETE", DeleteSubscription, { subscription_exposed_id: id }, decodeSubscription, {
      id: ["subscription", id],
    }),
  list: (params) =>
    request(
      "GET",
      GetSubscriptions,
      omitUndefined({
        limit: params?.limit,
        customer: params?.customer,
        status: params?.status,
        starting_after: params?.startingAfter,
      }),
      decodeSubscriptionPage,
    ),
}));

/** Stripe implementation of the {@link SubscriptionNS.Subscriptions} capability. */
export const subscriptionsLayer: Layer.Layer<SubscriptionNS.Subscriptions, never, Requirements> =
  /* @__PURE__ */ Layer.provide(subscriptions, clientLayerFromContext);

// ---------------------------------------------------------------------------
// Refunds
// ---------------------------------------------------------------------------

const refunds = /* @__PURE__ */ over(RefundNS.Refunds, (request) => ({
  create: (params) =>
    request(
      "POST",
      CreateRefund,
      omitUndefined({
        payment_intent: params.paymentIntent,
        charge: params.charge,
        amount: params.amount,
        // Passed through verbatim: Stripe validates `reason` against its
        // enum and answers an unknown value with an invalid-request error.
        reason: params.reason,
        metadata: params.metadata,
      }),
      decodeRefund,
      { idempotencyKey: params.idempotencyKey },
    ),
  retrieve: (id) => request("GET", GetRefund, { refund: id }, decodeRefund, { id: ["refund", id] }),
  update: (id, params) =>
    request(
      "POST",
      UpdateRefund,
      { refund: id, ...omitUndefined({ metadata: params.metadata }) },
      decodeRefund,
      { id: ["refund", id] },
    ),
  list: (params) =>
    request(
      "GET",
      GetRefunds,
      omitUndefined({
        limit: params?.limit,
        payment_intent: params?.paymentIntent,
        charge: params?.charge,
        starting_after: params?.startingAfter,
      }),
      decodeRefundPage,
    ),
}));

/** Stripe implementation of the {@link RefundNS.Refunds} capability. */
export const refundsLayer: Layer.Layer<RefundNS.Refunds, never, Requirements> =
  /* @__PURE__ */ Layer.provide(refunds, clientLayerFromContext);

// ---------------------------------------------------------------------------
// CheckoutSessions
// ---------------------------------------------------------------------------

const checkoutSessions = /* @__PURE__ */ over(CheckoutSessionNS.CheckoutSessions, (request) => ({
  create: (params) =>
    request(
      "POST",
      CreateCheckoutSession,
      omitUndefined({
        mode: params.mode,
        customer: params.customer,
        line_items: params.lineItems.map((item) => ({
          price: item.price,
          quantity: item.quantity ?? 1,
        })),
        success_url: params.successUrl,
        cancel_url: params.cancelUrl,
        metadata: params.metadata,
        subscription_data:
          params.mode === "subscription" && params.subscriptionMetadata
            ? { metadata: params.subscriptionMetadata }
            : undefined,
      }),
      decodeCheckoutSession,
      { idempotencyKey: params.idempotencyKey },
    ),
}));

/**
 * Stripe implementation of the {@link CheckoutSessionNS.CheckoutSessions}
 * capability: a hosted Checkout session (`POST /v1/checkout/sessions`). Each
 * line item names a price, with a quantity of 1 unless given; no amount is
 * ever sent. `subscriptionMetadata` becomes `subscription_data[metadata]`, so
 * it lands on the subscription Stripe creates.
 */
export const checkoutSessionsLayer: Layer.Layer<
  CheckoutSessionNS.CheckoutSessions,
  never,
  Requirements
> = /* @__PURE__ */ Layer.provide(checkoutSessions, clientLayerFromContext);

// ---------------------------------------------------------------------------
// BillingPortalSessions
// ---------------------------------------------------------------------------

const billingPortalSessions = /* @__PURE__ */ over(
  BillingPortalNS.BillingPortalSessions,
  (request) => ({
    create: (params) =>
      request(
        "POST",
        CreateBillingPortalSession,
        { customer: params.customer, return_url: params.returnUrl },
        decodeBillingPortalSession,
      ),
  }),
);

/**
 * Stripe implementation of the {@link BillingPortalNS.BillingPortalSessions}
 * capability: a customer portal session (`POST /v1/billing_portal/sessions`),
 * using the account's default portal configuration.
 */
export const billingPortalSessionsLayer: Layer.Layer<
  BillingPortalNS.BillingPortalSessions,
  never,
  Requirements
> = /* @__PURE__ */ Layer.provide(billingPortalSessions, clientLayerFromContext);

// ---------------------------------------------------------------------------
// Bundles
// ---------------------------------------------------------------------------

/** Every capability over one client. */
const every = /* @__PURE__ */ Layer.mergeAll(
  customers,
  products,
  prices,
  paymentIntents,
  subscriptions,
  refunds,
  checkoutSessions,
  billingPortalSessions,
);

/**
 * Every neutral capability over Distilled's `Credentials` and an `HttpClient`
 * in context, at the default request policy (`Stripe-Version` pinned to
 * {@link DISTILLED_API_VERSION}, two retries, 80 s per attempt). Use {@link layer} to
 * configure the policy.
 */
export const capabilities: Layer.Layer<
  | CustomerNS.Customers
  | ProductNS.Products
  | PriceNS.Prices
  | PaymentIntentNS.PaymentIntents
  | SubscriptionNS.Subscriptions
  | RefundNS.Refunds
  | CheckoutSessionNS.CheckoutSessions
  | BillingPortalNS.BillingPortalSessions,
  never,
  Requirements
> = /* @__PURE__ */ Layer.provide(every, clientLayerFromContext);

/**
 * Every neutral capability, built from configuration: the key and base URL
 * become Distilled's credentials, and the API version, retries, timeout and
 * connected account are the request policy (`uploadsBaseUrl` is unused: no
 * capability uploads). Fails with `PaymentConfigError` for an empty key.
 * Requires an `HttpClient` (`FetchHttpClient.layer`).
 *
 * @example
 * ```typescript
 * import { Effect, Layer, Redacted } from "effect";
 * import { FetchHttpClient } from "effect/http";
 * import * as Customer from "@thomasfosterau/effect-biz/Payments.Customer";
 * import * as StripePayments from "@thomasfosterau/effect-biz-payments-stripe/StripePayments";
 *
 * const program = Customer.create({ email: "jane@example.com" });
 *
 * const layer = StripePayments.layer({ apiKey: Redacted.make("sk_test_...") }).pipe(
 *   Layer.provide(FetchHttpClient.layer),
 * );
 * // Calls Stripe when invoked, so it needs a real key.
 * const run = () => Effect.runPromise(program.pipe(Effect.provide(layer)));
 * ```
 */
export const layer = (
  config: StripeHttpConfig,
): Layer.Layer<Layer.Success<typeof capabilities>, PaymentConfigError, HttpClient.HttpClient> =>
  Layer.provide(every, clientLayer(config));

/**
 * Every neutral capability, with the key read from a configuration variable
 * (`STRIPE_API_KEY` by default) while the layer is built. Requires an
 * `HttpClient` (`FetchHttpClient.layer`).
 */
export const layerFromEnv = (
  envVar: string = "STRIPE_API_KEY",
): Layer.Layer<Layer.Success<typeof capabilities>, PaymentConfigError, HttpClient.HttpClient> =>
  Layer.provide(every, clientLayerFromEnv(envVar));

/**
 * Every neutral capability in the "not configured ≡ down" posture: the key is
 * read from a configuration variable (`STRIPE_API_KEY` by default) at CALL
 * time, never while the layer is built, so building it cannot fail and an
 * application without Stripe configured still starts. While the variable is
 * absent, empty or unreadable every capability call fails with
 * `PaymentsUnavailable` before anything is sent; once it is present, calls go
 * to Stripe with that key. Requires an `HttpClient` (`FetchHttpClient.layer`).
 * Each call reads the calling fiber's `ConfigProvider` first, then falls back
 * to the one the layer was built under, so a provider attached with
 * `Layer.provide` is honoured.
 */
export const layerConfig = (
  options: LayerConfigOptions = {},
): Layer.Layer<Layer.Success<typeof capabilities>, never, HttpClient.HttpClient> =>
  Layer.provide(every, clientLayerConfig(options));
