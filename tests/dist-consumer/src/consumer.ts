/**
 * A consumer's view of all four packages, imported through their EMITTED
 * declarations (`paths` in tsconfig.json points the package names at
 * `dist/*.d.ts`). Each block exercises the types a real consumer depends on,
 * so a declaration that degrades to `any` — or a subpath export whose `.d.ts`
 * the bundler dropped — fails here rather than in an application. Never
 * executed; type-checked only.
 */

import type * as Effect from "effect/Effect";
import type * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import type { HttpClient } from "effect/http";
import type { Credentials as PayPalCredentials } from "@distilled.cloud/paypal/Credentials";
import type { Credentials } from "@distilled.cloud/stripe/Credentials";
import type * as Distilled from "@distilled.cloud/stripe/stripe";
import type Stripe from "stripe";
import {
  money,
  type Money,
  type Page,
  type PaymentConfigError,
  type PaymentsError,
  type PaymentsUnavailable,
  type SignatureVerificationError,
} from "@thomasfosterau/effect-biz/Payments";
import * as Customer from "@thomasfosterau/effect-biz/Payments.Customer";
import type * as PaymentIntent from "@thomasfosterau/effect-biz/Payments.PaymentIntent";
import type * as Price from "@thomasfosterau/effect-biz/Payments.Price";
import type * as Product from "@thomasfosterau/effect-biz/Payments.Product";
import type * as Refund from "@thomasfosterau/effect-biz/Payments.Refund";
import type * as Subscription from "@thomasfosterau/effect-biz/Payments.Subscription";
import * as CheckoutSession from "@thomasfosterau/effect-biz/Payments.CheckoutSession";
import * as BillingPortal from "@thomasfosterau/effect-biz/Payments.BillingPortal";
import * as Stub from "@thomasfosterau/effect-biz/Payments.Stub";
import * as StripePayments from "@thomasfosterau/effect-biz-payments-stripe/StripePayments";
import * as StripeCustomer from "@thomasfosterau/effect-biz-payments-stripe/Customer";
import * as StripeCheckoutSession from "@thomasfosterau/effect-biz-payments-stripe/CheckoutSession";
import * as StripeBillingPortalSession from "@thomasfosterau/effect-biz-payments-stripe/BillingPortal.Session";
import * as StripeVerificationSession from "@thomasfosterau/effect-biz-payments-stripe/Identity.VerificationSession";
import * as StripeInvoice from "@thomasfosterau/effect-biz-payments-stripe/Invoice";
import * as BillingMeter from "@thomasfosterau/effect-biz-payments-stripe/Billing.Meter";
import * as V2CoreAccount from "@thomasfosterau/effect-biz-payments-stripe/V2.Core.Account";
import * as Webhook from "@thomasfosterau/effect-biz-payments-stripe/Webhook";
import * as StripeHttp from "@thomasfosterau/effect-biz-payments-stripe/StripeHttp";
import * as PayPalPayments from "@thomasfosterau/effect-biz-payments-paypal/PayPalPayments";
import * as AirwallexPayments from "@thomasfosterau/effect-biz-payments-airwallex/AirwallexPayments";

/** A compile-time assertion: `T` must be exactly `true`. */
type Assert<T extends true> = T;
type Equals<A, B> =
  (<X>() => X extends A ? 1 : 2) extends <X>() => X extends B ? 1 : 2 ? true : false;

// ── core ──────────────────────────────────────────────────────────────────

export const created = Customer.create({ email: "reader@example.com" });
export const listed = Customer.list({ limit: 10 });
export const price: Money = money(2000, "usd");
export const checkout = CheckoutSession.create({
  mode: "subscription",
  customer: "cus_123",
  lineItems: [{ price: "price_123" }],
  successUrl: "https://example.com/ok",
  cancelUrl: "https://example.com/cancel",
});
export const portal = BillingPortal.create({
  customer: "cus_123",
  returnUrl: "https://example.com/account",
});

// ── providers ─────────────────────────────────────────────────────────────

export const stripeLayer = StripePayments.layer({ apiKey: Redacted.make("sk_test_123") });
export const stripeConfigLayer = StripePayments.layerConfig({ envVar: "BILLING_STRIPE_KEY" });
export const stripeHttpConfigLayer = StripeHttp.layerConfig();
export const unavailableLayer = Stub.unavailable("stripe");
export const stripeHttpLayer = StripeHttp.layer({ apiKey: Redacted.make("sk_test_123") });
export const paypalLayer = PayPalPayments.layer({
  clientId: "id",
  clientSecret: Redacted.make("secret"),
});
export const paypalEnvLayer = PayPalPayments.layerFromEnv();
export const airwallexLayer = AirwallexPayments.layer({
  clientId: "id",
  apiKey: Redacted.make("key"),
});
export const stripeCustomer = StripeCustomer.retrieve("cus_123");
/** A resource-module operation with every `RequestOptions` field, the per-call version included. */
export const stripeCustomerAtVersion = StripeCustomer.retrieve(
  "cus_123",
  { expand: ["test_clock"] },
  {
    apiVersion: StripePayments.DISTILLED_API_VERSION,
    idempotencyKey: "key-1",
    stripeAccount: "acct_123",
  },
);
/** An Invoice action the modules did not expose before they re-exported Distilled (effect-finance#142). */
export const stripeInvoicePaid = StripeInvoice.pay("in_123");
export const stripeCheckoutSession = StripeCheckoutSession.create({
  mode: "payment",
  line_items: [{ price: "price_123", quantity: 1 }],
  success_url: "https://example.com/success",
});
export const stripePortalSession = StripeBillingPortalSession.create({
  customer: "cus_123",
  return_url: "https://example.com/account",
});
/**
 * A resource module the `stripe` package's types described before effect-finance#146,
 * checked so its emitted `.d.ts` resolves Distilled's type rather than a
 * silent `any`: every resource module is Distilled-typed now.
 */
export const stripeVerificationSession = StripeVerificationSession.retrieve("vs_123");
/** A namespaced resource module published by effect-finance#154. */
export const stripeBillingMeter = BillingMeter.retrieve("mtr_123");
/** A `/v2` resource module (effect-finance#154), whose params go out as a JSON body. */
export const stripeV2Account = V2CoreAccount.retrieve("acct_123", { include: ["identity"] });
export const event = Webhook.constructEvent("{}", "t=1,v1=sig", "whsec_123");

/**
 * Every compile-time assertion, exported so `noUnusedLocals` keeps them and a
 * failing one names itself in the error.
 */
export type Checks = [
  /** _createSucceeds */ Assert<Equals<Effect.Success<typeof created>, Customer.Customer>>,
  /** _createFails */ Assert<Equals<Effect.Error<typeof created>, PaymentsError>>,
  /** _createRequires */ Assert<Equals<Effect.Services<typeof created>, Customer.Customers>>,
  /** _listPages */ Assert<Equals<Effect.Success<typeof listed>, Page<Customer.Customer>>>,
  /** _stripeProvides */ Assert<
    Equals<
      Layer.Success<typeof stripeLayer>,
      | Customer.Customers
      | Product.Products
      | Price.Prices
      | PaymentIntent.PaymentIntents
      | Subscription.Subscriptions
      | Refund.Refunds
      | CheckoutSession.CheckoutSessions
      | BillingPortal.BillingPortalSessions
    >
  >,
  /** _stripeFailsWithConfig */ Assert<Equals<Layer.Error<typeof stripeLayer>, PaymentConfigError>>,
  /** _stripeCapabilitiesRequireDistilled */ Assert<
    Equals<Layer.Services<typeof StripePayments.capabilities>, Credentials | HttpClient.HttpClient>
  >,
  /** _paypalProvidesRefunds */ Assert<
    Refund.Refunds extends Layer.Success<typeof paypalLayer> ? true : false
  >,
  /** _paypalHasNoCustomers */ Assert<
    Customer.Customers extends Layer.Success<typeof paypalLayer> ? false : true
  >,
  /** _airwallexProvidesCustomers */ Assert<
    Customer.Customers extends Layer.Success<typeof airwallexLayer> ? true : false
  >,
  /** _checkoutSucceeds */ Assert<
    Equals<Effect.Success<typeof checkout>, CheckoutSession.CheckoutSession>
  >,
  /** _checkoutRequires */ Assert<
    Equals<Effect.Services<typeof checkout>, CheckoutSession.CheckoutSessions>
  >,
  /** _portalSucceeds */ Assert<
    Equals<Effect.Success<typeof portal>, BillingPortal.BillingPortalSession>
  >,
  /** _checkoutFails */ Assert<Equals<Effect.Error<typeof checkout>, PaymentsError>>,
  /** _portalFails */ Assert<Equals<Effect.Error<typeof portal>, PaymentsError>>,
  /** _paypalHasNoCheckoutByDefault */ Assert<
    CheckoutSession.CheckoutSessions extends Layer.Success<typeof paypalLayer> ? false : true
  >,
  /** _paypalCheckoutStub */ Assert<
    Equals<
      Layer.Success<typeof PayPalPayments.checkoutSessionsLayer>,
      CheckoutSession.CheckoutSessions
    >
  >,
  /** _airwallexPortalStub */ Assert<
    Equals<
      Layer.Success<typeof AirwallexPayments.billingPortalSessionsLayer>,
      BillingPortal.BillingPortalSessions
    >
  >,
  /** _stripeResourceRequiresTransport */ Assert<
    Equals<Effect.Services<typeof stripeCustomer>, StripeHttp.StripeHttp>
  >,
  /** _stripeResourceFailsNeutrally */ Assert<
    Equals<Effect.Error<typeof stripeCustomer>, PaymentsError>
  >,
  /** _stripeCustomerIsDistilled */ Assert<
    Equals<Effect.Success<typeof stripeCustomer>, Distilled.GetCustomerResponse>
  >,
  /** _stripeCustomerSchemaIsReexported */ Assert<
    Equals<StripeCustomer.Customer, Distilled.Customer>
  >,
  /** _stripeOptionsKeepTheType */ Assert<
    Equals<Effect.Success<typeof stripeCustomerAtVersion>, Distilled.GetCustomerResponse>
  >,
  /** _stripeInvoicePayIsDistilled */ Assert<
    Equals<Effect.Success<typeof stripeInvoicePaid>, Distilled.Invoice>
  >,
  /** _stripeVerificationSessionIsDistilled */ Assert<
    Equals<Effect.Success<typeof stripeVerificationSession>, Distilled.IdentityVerificationSession>
  >,
  /** _stripeBillingMeterIsDistilled */ Assert<
    Equals<Effect.Success<typeof stripeBillingMeter>, Distilled.BillingMeter>
  >,
  /** _stripeV2AccountIsDistilled */ Assert<
    Equals<Effect.Success<typeof stripeV2Account>, Distilled.V2CoreAccount>
  >,
  /** _stripeV2RequiresTransport */ Assert<
    Equals<Effect.Services<typeof stripeV2Account>, StripeHttp.StripeHttp>
  >,
  /** _stripeCheckoutIsDistilled */ Assert<
    Equals<Effect.Success<typeof stripeCheckoutSession>, StripeCheckoutSession.CheckoutSession>
  >,
  /** _stripeCheckoutRequiresTransport */ Assert<
    Equals<Effect.Services<typeof stripeCheckoutSession>, StripeHttp.StripeHttp>
  >,
  /** _stripePortalIsDistilled */ Assert<
    Equals<
      Effect.Success<typeof stripePortalSession>,
      StripeBillingPortalSession.BillingPortalSession
    >
  >,
  /** _stripePortalUrlIsRequired */ Assert<
    Equals<StripeBillingPortalSession.BillingPortalSession["url"], string>
  >,
  /** _stripeHttpNeedsHttpClient */ Assert<
    Equals<Layer.Services<typeof stripeHttpLayer>, HttpClient.HttpClient>
  >,
  /** _webhookEvent */ Assert<Equals<Effect.Success<typeof event>, Stripe.Event>>,
  /** _webhookNeedsTheProgramsSdkClient */ Assert<
    Equals<Effect.Services<typeof event>, Webhook.StripeService>
  >,
  /** _stripeNeedsHttpClient */ Assert<
    Equals<Layer.Services<typeof stripeLayer>, HttpClient.HttpClient>
  >,
  /** _paypalNeedsHttpClient */ Assert<
    Equals<Layer.Services<typeof paypalLayer>, HttpClient.HttpClient>
  >,
  /** _airwallexNeedsHttpClient */ Assert<
    Equals<Layer.Services<typeof airwallexLayer>, HttpClient.HttpClient>
  >,
  /** _paypalFailsWithConfig */ Assert<Equals<Layer.Error<typeof paypalLayer>, PaymentConfigError>>,
  /** _paypalCapabilitiesRequireDistilled */ Assert<
    Equals<
      Layer.Services<typeof PayPalPayments.capabilities>,
      PayPalCredentials | HttpClient.HttpClient
    >
  >,
  /** _paypalProductsRequireDistilled */ Assert<
    Equals<
      Layer.Services<typeof PayPalPayments.productsLayer>,
      PayPalCredentials | HttpClient.HttpClient
    >
  >,
  /** _paypalEnvMatchesLayer */ Assert<Equals<typeof paypalEnvLayer, typeof paypalLayer>>,
  /** _unavailableIsPaymentsError */ Assert<
    PaymentsUnavailable extends PaymentsError ? true : false
  >,
  /** _stripeConfigProvidesEverything */ Assert<
    Equals<Layer.Success<typeof stripeConfigLayer>, Layer.Success<typeof stripeLayer>>
  >,
  /** _stripeConfigNeverFailsToBuild */ Assert<
    Equals<Layer.Error<typeof stripeConfigLayer>, never>
  >,
  /** _stripeConfigNeedsHttpClient */ Assert<
    Equals<Layer.Services<typeof stripeConfigLayer>, HttpClient.HttpClient>
  >,
  /** _stripeHttpConfigNeverFailsToBuild */ Assert<
    Equals<Layer.Error<typeof stripeHttpConfigLayer>, never>
  >,
  /** _stubProvidesEverything */ Assert<
    Equals<Layer.Success<typeof unavailableLayer>, Layer.Success<typeof stripeLayer>>
  >,
  /** _stubNeedsNothing */ Assert<Equals<Layer.Services<typeof unavailableLayer>, never>>,
  /** _webhookFails */ Assert<Equals<Effect.Error<typeof event>, SignatureVerificationError>>,
];
