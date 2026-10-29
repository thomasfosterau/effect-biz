/**
 * `@thomasfosterau/effect-biz-payments-stripe`
 *
 * The Stripe implementation of the vendor-neutral
 * `@thomasfosterau/effect-biz/Payments` core. It provides:
 *
 * - **`StripePayments`** — `Layer`s that implement every neutral capability
 *   (including `CheckoutSessions` and `BillingPortalSessions`) over
 *   Distilled's Stripe operations (`@distilled.cloud/stripe`), with a pinned
 *   `Stripe-Version`, the SDK's retry policy and Stripe's failures mapped onto
 *   the neutral errors, plus the `layer` / `layerFromEnv` / `layerConfig`
 *   bundles that build every capability from configuration.
 * - **`StripeHttp`** — the client the resource modules run on: Distilled's
 *   operations under the same request policy as the capabilities, over
 *   `effect/http`'s `HttpClient`, with no Node API and no SDK.
 * - **Raw resource modules** (`Customer`, `Invoice`, `Charge`, `Treasury`, …) —
 *   the Stripe escape hatch for what the neutral capabilities do not cover:
 *   every Distilled operation on each resource, typed with Distilled's
 *   declarations and wrapped with the pinned `Stripe-Version` and
 *   {@link RequestOptions}.
 * - **`Webhook`** — the WebCrypto webhook verifier, and the SDK-based one for
 *   a program that provides its own `stripe` client.
 *
 * This entry point re-exports every resource module, so its declarations
 * reach Distilled's whole operations module (about 7.5 MB); a program that
 * needs one resource imports its subpath (or only `StripePayments`, whose
 * declarations stay small).
 *
 * This is the payments analogue of Effect's AI modules: one abstraction, one
 * package per provider, with provider-specific APIs still exposed.
 *
 * See `StripePayments.layer` for an example of running a neutral program on Stripe.
 *
 * @module
 */

// Re-export the vendor-neutral core for convenience (capabilities, entities,
// and the neutral error channel).
export * as Payments from "@thomasfosterau/effect-biz/Payments";

// The neutral capability implementations + the raw modules' client.
export * as StripeHttp from "./StripeHttp.js";
export * as StripePayments from "./StripePayments.js";

// Raw Stripe resource modules (provider-specific escape hatch).
export * as Customer from "./Customer.js";
export * as Product from "./Product.js";
export * as Price from "./Price.js";
export * as PaymentIntent from "./PaymentIntent.js";
export * as Subscription from "./Subscription.js";
export * as Treasury from "./Treasury.js";
export * as Balance from "./Balance.js";
export * as Event from "./Event.js";
export * as WebhookEndpoint from "./WebhookEndpoint.js";
export * as Review from "./Review.js";
export * as CountrySpec from "./CountrySpec.js";
export * as IssuingCard from "./Issuing.Card.js";
export * as IssuingCardholder from "./Issuing.Cardholder.js";
export * as IssuingAuthorization from "./Issuing.Authorization.js";
export * as IssuingTransaction from "./Issuing.Transaction.js";
export * as IssuingDispute from "./Issuing.Dispute.js";
export * as IdentityVerificationSession from "./Identity.VerificationSession.js";
export * as IdentityVerificationReport from "./Identity.VerificationReport.js";
export * as TerminalReader from "./Terminal.Reader.js";
export * as TerminalLocation from "./Terminal.Location.js";
export * as TerminalConnectionToken from "./Terminal.ConnectionToken.js";
export * as Account from "./Account.js";
export * as AccountLink from "./AccountLink.js";
export * as Person from "./Person.js";
export * as ExternalAccount from "./ExternalAccount.js";
export * as Transfer from "./Transfer.js";
export * as Topup from "./Topup.js";
export * as PaymentMethod from "./PaymentMethod.js";
export * as Invoice from "./Invoice.js";
export * as Charge from "./Charge.js";
export * as Refund from "./Refund.js";
export * as BalanceTransaction from "./BalanceTransaction.js";
export * as SetupIntent from "./SetupIntent.js";
export * as Payout from "./Payout.js";
export * as Dispute from "./Dispute.js";
export * as File from "./File.js";
export * as TaxRate from "./TaxRate.js";
export * as PromotionCode from "./PromotionCode.js";
export * as Coupon from "./Coupon.js";
export * as CheckoutSession from "./CheckoutSession.js";
export * as BillingPortalSession from "./BillingPortal.Session.js";
export * as SubscriptionSchedule from "./SubscriptionSchedule.js";
// Every other resource module.
export * as AccountSession from "./AccountSession.js";
export * as ApplePayDomain from "./ApplePayDomain.js";
export * as ApplicationFee from "./ApplicationFee.js";
export * as AppsInstall from "./Apps.Install.js";
export * as AppsSecret from "./Apps.Secret.js";
export * as BalanceSettings from "./BalanceSettings.js";
export * as BillingAlert from "./Billing.Alert.js";
export * as BillingCreditBalanceSummary from "./Billing.CreditBalanceSummary.js";
export * as BillingCreditBalanceTransaction from "./Billing.CreditBalanceTransaction.js";
export * as BillingCreditGrant from "./Billing.CreditGrant.js";
export * as BillingFeedbackOption from "./Billing.FeedbackOption.js";
export * as BillingMeter from "./Billing.Meter.js";
export * as BillingMeterEvent from "./Billing.MeterEvent.js";
export * as BillingMeterEventAdjustment from "./Billing.MeterEventAdjustment.js";
export * as BillingPortalConfiguration from "./BillingPortal.Configuration.js";
export * as ClimateOrder from "./Climate.Order.js";
export * as ClimateProduct from "./Climate.Product.js";
export * as ClimateSupplier from "./Climate.Supplier.js";
export * as ConfirmationToken from "./ConfirmationToken.js";
export * as CreditNote from "./CreditNote.js";
export * as CustomerSession from "./CustomerSession.js";
export * as EntitlementsActiveEntitlement from "./Entitlements.ActiveEntitlement.js";
export * as EntitlementsFeature from "./Entitlements.Feature.js";
export * as EphemeralKey from "./EphemeralKey.js";
export * as ExchangeRate from "./ExchangeRate.js";
export * as FileLink from "./FileLink.js";
export * as FinancialConnectionsAccount from "./FinancialConnections.Account.js";
export * as FinancialConnectionsSession from "./FinancialConnections.Session.js";
export * as FinancialConnectionsTransaction from "./FinancialConnections.Transaction.js";
export * as ForwardingRequest from "./Forwarding.Request.js";
export * as InvoiceItem from "./InvoiceItem.js";
export * as InvoicePayment from "./InvoicePayment.js";
export * as InvoiceRenderingTemplate from "./InvoiceRenderingTemplate.js";
export * as IssuingPersonalizationDesign from "./Issuing.PersonalizationDesign.js";
export * as IssuingPhysicalBundle from "./Issuing.PhysicalBundle.js";
export * as IssuingToken from "./Issuing.Token.js";
export * as Mandate from "./Mandate.js";
export * as PaymentAttemptRecord from "./PaymentAttemptRecord.js";
export * as PaymentLink from "./PaymentLink.js";
export * as PaymentMethodConfiguration from "./PaymentMethodConfiguration.js";
export * as PaymentMethodDomain from "./PaymentMethodDomain.js";
export * as PaymentRecord from "./PaymentRecord.js";
export * as Plan from "./Plan.js";
export * as ProductCatalogTrialOffer from "./ProductCatalog.TrialOffer.js";
export * as Quote from "./Quote.js";
export * as RadarEarlyFraudWarning from "./Radar.EarlyFraudWarning.js";
export * as RadarPaymentEvaluation from "./Radar.PaymentEvaluation.js";
export * as RadarValueList from "./Radar.ValueList.js";
export * as RadarValueListItem from "./Radar.ValueListItem.js";
export * as ReportingReportRun from "./Reporting.ReportRun.js";
export * as ReportingReportType from "./Reporting.ReportType.js";
export * as SetupAttempt from "./SetupAttempt.js";
export * as ShippingRate from "./ShippingRate.js";
export * as SigmaScheduledQueryRun from "./Sigma.ScheduledQueryRun.js";
export * as Source from "./Source.js";
export * as SubscriptionItem from "./SubscriptionItem.js";
export * as TaxAssociation from "./Tax.Association.js";
export * as TaxCalculation from "./Tax.Calculation.js";
export * as TaxLocation from "./Tax.Location.js";
export * as TaxRegistration from "./Tax.Registration.js";
export * as TaxSettings from "./Tax.Settings.js";
export * as TaxTransaction from "./Tax.Transaction.js";
export * as TaxCode from "./TaxCode.js";
export * as TaxId from "./TaxId.js";
export * as TerminalConfiguration from "./Terminal.Configuration.js";
export * as TerminalOnboardingLink from "./Terminal.OnboardingLink.js";
export * as TestHelpersTestClock from "./TestHelpers.TestClock.js";
export * as ThreeDSecureAuthentication from "./ThreeDSecure.Authentication.js";
export * as Token from "./Token.js";
export * as V2BillingMeterEvent from "./V2.Billing.MeterEvent.js";
export * as V2BillingMeterEventAdjustment from "./V2.Billing.MeterEventAdjustment.js";
export * as V2BillingMeterEventSession from "./V2.Billing.MeterEventSession.js";
export * as V2CommerceProductCatalogImport from "./V2.Commerce.ProductCatalogImport.js";
export * as V2CoreAccount from "./V2.Core.Account.js";
export * as V2CoreAccountLink from "./V2.Core.AccountLink.js";
export * as V2CoreAccountPerson from "./V2.Core.AccountPerson.js";
export * as V2CoreAccountPersonToken from "./V2.Core.AccountPersonToken.js";
export * as V2CoreAccountToken from "./V2.Core.AccountToken.js";
export * as V2CoreEvent from "./V2.Core.Event.js";
export * as V2CoreEventDestination from "./V2.Core.EventDestination.js";
export * as Webhook from "./Webhook.js";

/** Every failure of a Stripe call: the neutral `PaymentsError` channel. */
export type { PaymentsError as StripeErrors } from "@thomasfosterau/effect-biz/Payments";
export type { RequestOptions, StripeHttpConfig } from "./StripeHttp.js";
