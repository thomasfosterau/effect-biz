# The Stripe escape hatch

Raw resource modules for everything the neutral core does not cover.

The neutral core deliberately covers only concepts common to payment providers. Stripe-specific resources — Treasury, Issuing, Terminal, Identity, Connect, Invoices and many more — remain available as raw resource modules, one subpath each:

```typescript
import { Effect, Layer, Redacted } from "effect";
import { FetchHttpClient } from "effect/http";
import * as Invoice from "@thomasfosterau/effect-biz-payments-stripe/Invoice";
import * as StripeHttp from "@thomasfosterau/effect-biz-payments-stripe/StripeHttp";

const stripe = StripeHttp.layer({ apiKey: Redacted.make("sk_test_...") }).pipe(
  Layer.provide(FetchHttpClient.layer),
);

const collect = (invoiceId: string) =>
  Invoice.finalize(invoiceId, { auto_advance: false }).pipe(
    Effect.andThen(Invoice.pay(invoiceId, {}, { idempotencyKey: `pay-${invoiceId}` })),
    Effect.provide(stripe),
  );
```

Each module is a thin wrapper of **every** `@distilled.cloud/stripe` operation on its resource, its sub-resources and test helpers included (`Invoice.finalize` / `pay` / `voidInvoice` / `send` / `listLines` / `search`, `Subscription.resume` / `migrate` / `search`, `Customer.listPaymentMethods`, `Treasury.InboundTransfer.testHelpersSucceed`, …), and re-exports Distilled's input and output types (`Customer.Customer`, `Customer.CreateCustomerRequest`, `Customer.GetCustomersResponse`, …), as types only: from `@distilled.cloud/stripe` `1.0.0-rc.18` the schemas are private to Distilled, which exposes an operation's through its `input` and `output` (`GetCustomer.output` from `@distilled.cloud/stripe/stripe`). An operation:

- takes the resource's **path ids first, as strings, in path order** (`Person.retrieve(accountId, personId)`), then the rest of Distilled's input as `params` (optional unless Distilled requires a member; absent when the operation takes nothing else), then **`options?: RequestOptions`**: `idempotencyKey`, `stripeAccount` and `apiVersion`, each overriding the client's;
- requires `StripeHttp` (`StripeHttp.layer` / `layerFromEnv` / `layerConfig`, or `layerFromContext` over Distilled's `Credentials`), which runs it under the same request policy as the capabilities: the pinned `Stripe-Version`, the SDK's retries with one `Idempotency-Key` per write (every `POST`, and a `/v2` `DELETE`), a `/v2` request's array query params indexed as the SDKs send them (`include[0]=…`), a per-attempt timeout, redirects refused, the uploads origin for `File.create`;
- fails only with the neutral `PaymentsError` channel (an empty id fails with `PaymentInvalidRequestError` before anything is sent, as does an empty option);
- resolves to the response **as Stripe sent it**, typed with Distilled's declarations and **not validated**. Distilled's response enumerations are plain strings, and its types describe `DISTILLED_API_VERSION`: at an older `apiVersion`, a field they mark required may be absent.

Gaps in Distilled's typing that the modules inherit (`@distilled.cloud/stripe` `1.0.0-rc.18`):

- **`Transfer.create` / `retrieve` / `update` resolve to `unknown`, and `Transfer.list`'s `data` to `Array<unknown>`**: Distilled declares no Transfer schema. Decode the result yourself.
- **Input types declare optional members as bare `?: T`**, as Distilled generates them. Under `exactOptionalPropertyTypes`, a caller forwarding an optional of its own (`Customer.create({ email })` with `email: string | undefined`) fails to type-check: omit an absent member rather than pass `undefined`. The neutral capabilities are unaffected; their params take `?: T | undefined`.
- **`File.create`'s `file` is retyped `string | Blob`** (a `File` is a `Blob`): Distilled declares it `string`, but sends a `Blob` as the multipart file part, which is how a file is uploaded. No cast is needed.

The names follow the path (`create` / `retrieve` / `update` / `del` / `list`, an action by its name, a sub-resource's operation by its singular, `testHelpers…` for a test helper), keeping every name a module had before it re-exported Distilled; `del` because `delete` is reserved, and likewise `Invoice.voidInvoice`. A raw module is also the full-fidelity alternative where a neutral capability exists: the raw `CheckoutSession` module takes every Stripe Checkout parameter where `StripePayments.checkoutSessionsLayer` takes only the neutral ones. Some raw modules share a name with a neutral core module (`Customer`, `CheckoutSession`, …), so alias one of them when a program imports both.

Make one `idempotencyKey` per logical write before the first attempt and reuse it on every retry; it is sent verbatim as `Idempotency-Key` on any method. Because of the trailing arguments, wrap an operation before passing it to an index-supplying iterator: `Effect.forEach(ids, (id) => Customer.del(id))`. The neutral capabilities take the neutral `idempotencyKey` on their create / confirm operations; the retry rules are in the core guide [Retrying a write safely](../core/retrying-writes.md).

**Type-checking cost.** A resource module's declarations name Distilled's operations module, one declaration file of about 7.5 MB, which a consumer that imports any resource module (or the package root) type-checks once. Measured for a one-line consumer of one module (`./Customer`, `./Treasury.FinancialAccount`, `skipLibCheck`) against the modules before effect-finance#146 (which pulled in the `stripe` SDK's types or the generated schemas instead): about 0.45–0.5 s with the native `tsc` (+0.1–0.2 s, no more memory) and 1.9–2.0 s with TypeScript 6's `tsc` (+0.2–0.3 s, about +10 MiB). `./StripePayments`, `./StripeHttp` and `./Webhook` never reach it.

**Every resource has a module.** The 131 resource subpaths wrap 587 of Distilled `1.0.0-rc.18`'s 589 Stripe operations:

- **Top level:** `Account`, `AccountLink`, `AccountSession`, `ApplePayDomain`, `ApplicationFee`, `Balance`, `BalanceSettings`, `BalanceTransaction`, `Charge`, `CheckoutSession`, `ConfirmationToken`, `CountrySpec`, `Coupon`, `CreditNote`, `Customer`, `CustomerSession`, `Dispute`, `EphemeralKey`, `Event`, `ExchangeRate`, `ExternalAccount`, `File`, `FileLink`, `Invoice`, `InvoiceItem`, `InvoicePayment`, `InvoiceRenderingTemplate`, `Mandate`, `PaymentAttemptRecord`, `PaymentIntent`, `PaymentLink`, `PaymentMethod`, `PaymentMethodConfiguration`, `PaymentMethodDomain`, `PaymentRecord`, `Payout`, `Person`, `Plan`, `Price`, `Product`, `PromotionCode`, `Quote`, `Refund`, `Review`, `SetupAttempt`, `SetupIntent`, `ShippingRate`, `Source`, `Subscription`, `SubscriptionItem`, `SubscriptionSchedule`, `TaxCode`, `TaxId`, `TaxRate`, `Token`, `Topup`, `Transfer`, `WebhookEndpoint`.
- **Namespaced** (one subpath each, `./<Namespace>.<Resource>`): `Apps.*` (`Install`, `Secret`), `Billing.*` (`Alert`, `CreditBalanceSummary`, `CreditBalanceTransaction`, `CreditGrant`, `FeedbackOption`, `Meter`, `MeterEvent`, `MeterEventAdjustment`), `BillingPortal.*` (`Configuration`, `Session`), `Climate.*` (`Order`, `Product`, `Supplier`), `Entitlements.*` (`ActiveEntitlement`, `Feature`), `FinancialConnections.*` (`Account`, `Session`, `Transaction`), `Forwarding.Request`, `Identity.*` (`VerificationReport`, `VerificationSession`), `Issuing.*` (`Authorization`, `Card`, `Cardholder`, `Dispute`, `PersonalizationDesign`, `PhysicalBundle`, `Token`, `Transaction`), `ProductCatalog.TrialOffer`, `Radar.*` (`EarlyFraudWarning`, `PaymentEvaluation`, `ValueList`, `ValueListItem`), `Reporting.*` (`ReportRun`, `ReportType`), `Sigma.ScheduledQueryRun`, `Tax.*` (`Association`, `Calculation`, `Location`, `Registration`, `Settings`, `Transaction`), `Terminal.*` (`Configuration`, `ConnectionToken`, `Location`, `OnboardingLink`, `Reader`), `TestHelpers.TestClock`, `ThreeDSecure.Authentication`, and `Treasury.*` (`CreditReversal`, `DebitReversal`, `FinancialAccount`, `InboundTransfer`, `OutboundPayment`, `OutboundTransfer`, `ReceivedCredit`, `ReceivedDebit`, `Transaction`, `TransactionEntry`; `./Treasury` re-exports all ten).
- **The `/v2` APIs:** `V2.Billing.*` (`MeterEvent`, `MeterEventAdjustment`, `MeterEventSession`), `V2.Commerce.ProductCatalogImport` and `V2.Core.*` (`Account`, `AccountLink`, `AccountPerson`, `AccountPersonToken`, `AccountToken`, `Event`, `EventDestination`). They run under the same request policy; Distilled sends their params as a JSON body rather than form-encoded, and a `/v2` list is a `{ data, next_page_url, previous_page_url }` page.

The package root re-exports every one of them, flattened (`BillingMeter`, `TaxCalculation`, `V2CoreAccount`, …). A singleton's `POST` is `update` (`BalanceSettings.update`, `Tax.Settings.update`), `Apps.Secret.delWhere` deletes a secret by name and scope (stripe-node's `deleteWhere`; every `del` deletes by id), `CreditNote.voidCreditNote` follows `Invoice.voidInvoice`, `Billing.CreditGrant.voidGrant` is stripe-node's name, and `CreditNote.listPreviewLines` lists a preview's lines. `EphemeralKey.create` needs the mobile SDK's API version: pass it as `options.apiVersion`.

Two operations stay unwrapped, because `StripeHttp`'s request policy cannot run them (call `@distilled.cloud/stripe` directly, at the version this package pins):

- **`GET /v1/quotes/{quote}/pdf`** (Distilled's `GetQuotePdf`): a binary PDF streamed from `files.stripe.com`, where `StripeHttp` sends every non-upload request to the API origin and reads every 2xx as JSON (Distilled types the result `{}`).
- **`POST /v2/billing/meter_event_stream`** (`CreateBillingMeterEventStream`): sent to `meter-events.stripe.com` with a meter event session's token rather than the account key. `V2.Billing.MeterEventSession.create` makes the session.
