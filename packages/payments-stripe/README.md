# @thomasfosterau/effect-biz-payments-stripe

A Stripe implementation of effect-biz's vendor-neutral payments core.

It provides `Layer`s that satisfy the neutral capabilities of [`@thomasfosterau/effect-biz/Payments`](https://www.npmjs.com/package/@thomasfosterau/effect-biz) over [Distilled's Stripe operations](https://www.npmjs.com/package/@distilled.cloud/stripe) (`@distilled.cloud/stripe`, on `effect/http`: no SDK, and no Node API but a `process` global; see [Runtime: a `process` global](#runtime-a-process-global)), one resource module per Stripe API resource as a provider escape hatch (every Distilled operation on the resource, through the same request policy, over the `StripeHttp` client), and a WebCrypto webhook verifier.

## Install

```bash
pnpm add @thomasfosterau/effect-biz @thomasfosterau/effect-biz-payments-stripe effect
```

`effect` is a peer dependency, at `^4.0.0`: that is the peer range `@distilled.cloud/stripe` and `@distilled.cloud/core` declare, and no `4.0.0-rc.*` prerelease satisfies it. Those two are dependencies, pinned exactly (they are pre-1.0): about 30 MB installed with core's `graphql` dependency, of which a bundler keeps only the operations the capabilities you use call. The official `stripe` package is an **optional** peer (`^23.0.0`: stripe-node 23.0.0 is the release for `2026-09-30.endive`, the `Stripe-Version` every request pins, so the verifier's `Stripe.Event` describes the payloads your endpoints receive at that version: an exact match on 23.0.x; a later 23.x types events at its own, newer endive version), for the SDK-based webhook verifier only:

- **At runtime** this package never loads it. `Webhook.constructEvent*` runs on an SDK client your program builds and provides (`Webhook.StripeService`); everything else runs without it.
- **For types** it is needed by `./Webhook` (its `constructEvent` signature names `Stripe.Event`, so `Webhook.verify` users need it too) and the package root, which re-exports it. Add it as a dev dependency when you import either; otherwise, with `skipLibCheck: false`, the declarations fail to resolve `stripe`, and with it on, its types silently become `any`. No other entry declares an import of it.

## Usage

Write your program against the neutral core, then provide a Stripe layer:

```typescript
import { Effect, Layer, Redacted } from "effect";
import { FetchHttpClient } from "effect/http";
import * as Customer from "@thomasfosterau/effect-biz/Payments.Customer";
import * as StripePayments from "@thomasfosterau/effect-biz-payments-stripe/StripePayments";

const program = Customer.create({ email: "jane@example.com" });

const layer = StripePayments.layer({ apiKey: Redacted.make("sk_test_...") }).pipe(
  Layer.provide(FetchHttpClient.layer), // every provider speaks effect/http
);

// Calls Stripe when invoked: `const customer = await createCustomer();`
const createCustomer = () => Effect.runPromise(program.pipe(Effect.provide(layer)));
```

## Providing the capabilities

`StripePayments.layer` builds every capability from configuration, so a neutral program is satisfied with a single `Effect.provide` (plus an `HttpClient`):

```typescript
import { Layer, Redacted } from "effect";
import { FetchHttpClient } from "effect/http";
import * as StripePayments from "@thomasfosterau/effect-biz-payments-stripe/StripePayments";

const layer = StripePayments.layer({
  apiKey: Redacted.make("sk_test_..."),
  apiVersion: StripePayments.DISTILLED_API_VERSION, // pinned in Stripe-Version; this is also the default
  maxNetworkRetries: 3,
  timeout: 10_000,
}).pipe(Layer.provide(FetchHttpClient.layer));

// Or from a configuration variable (STRIPE_API_KEY by default), read as a Redacted.
// A missing or empty variable fails the layer build with PaymentConfigError.
const fromEnv = StripePayments.layerFromEnv().pipe(Layer.provide(FetchHttpClient.layer));
```

`layer` (and `StripeHttp.layer` / `make`) takes a `StripeHttpConfig`:

| Field | Default | Meaning |
| --- | --- | --- |
| `apiKey` | required | The secret or restricted key (`sk_…` / `rk_…`), a `Redacted<string>`; an empty one fails the build with `PaymentConfigError`. |
| `apiVersion` | `DISTILLED_API_VERSION` | The `Stripe-Version` every request pins. |
| `maxNetworkRetries` | 2 | Retries after a retryable failure, as in the SDK. |
| `timeout` | 80 000 | Per-attempt timeout in milliseconds, as in the SDK. |
| `stripeAccount` | none | A connected account to act as on every call (`Stripe-Account`). |
| `baseUrl` | `https://api.stripe.com` | The API origin (a `stripe-mock` server, say). |
| `uploadsBaseUrl` | `https://files.stripe.com` | The file-uploads origin (`File.create`; unused by the capabilities). |

`layerFromEnv(envVar?)` reads only the key, from `STRIPE_API_KEY` by default, while the layer is built, and keeps every other default. `layerConfig(options?)` takes the same fields as `StripeHttpConfig` minus `apiKey`, plus `envVar` (default `STRIPE_API_KEY`), and reads the key at call time (["Not configured ≡ down"](#not-configured--down)).

Each capability call is one of Distilled's generated operations (`CreateCustomer`, `GetSubscription`, …), which form-encode the request with Stripe's bracketed nesting and send the key as a bearer token. Around every call the layers apply this package's request policy: `Stripe-Version` pinned to `DISTILLED_API_VERSION` (`2026-09-30.endive`) unless configured, since Distilled sends none of its own and the account's dashboard default would otherwise decide the wire shape; the SDK's retry policy (connection failures, `409`, `5xx`, `Stripe-Should-Retry`, `Retry-After`) with one `Idempotency-Key` across the attempts of a `POST` (and of a `/v2` `DELETE`), in place of Distilled's own; a per-attempt timeout; redirects refused; and every failure (Distilled's `CardError`, `InvalidRequestError`, …, an HTTP status error or a connection failure) mapped onto the neutral errors, from the response's status and Stripe's error envelope. Responses are decoded with `Schema` over the fields the layers read; a malformed one fails with `PaymentProviderError`. The layers keep Distilled's response validation lenient even under its `ResponseValidation.strict`, so a response is never refused over a field they do not read (Distilled's schemas mark fields required that a response at an older configured `apiVersion` lacks).

### Errors

Every capability and resource-module call fails with the core's `PaymentsError` and nothing else; Distilled's error classes never escape. A failure is classified from the response's status and Stripe's error envelope (`{ error: { type, code, message, param } }`), the status winning for 401, 403 and 429 as in the SDK:

| Stripe failure | Neutral error |
| --- | --- |
| 401, or `type: "authentication_error"` | `PaymentAuthenticationError` |
| 429, or `type: "rate_limit_error"` | `PaymentRateLimitError` (`retryAfter` from `Retry-After`) |
| `type: "invalid_request_error"` | `PaymentInvalidRequestError` (`param` from the envelope) |
| a connection failure or timeout | `PaymentNetworkError` |
| anything else: a card error, 403 (permission), an idempotency error, an API error, a non-Stripe error page | `PaymentProviderError` (`provider: "stripe"`, `code` Stripe's `code`, or the kind when it sent none: `StripeCardError`, `StripePermissionError`, `StripeIdempotencyError`, `StripeAPIError`, …) |
| a 2xx a capability cannot decode | `PaymentProviderError` |

A failure the client retries (a connection failure, `409`, a `5xx`, `Stripe-Should-Retry: true`) surfaces only after the last attempt. The key never reaches an error or a log line.

### API versions

Every request, from a capability layer or a resource module, pins `Stripe-Version` to `DISTILLED_API_VERSION` (exported by `StripePayments` and `StripeHttp`), **`2026-09-30.endive`**: the version `@distilled.cloud/stripe` `1.0.0-rc.15`'s schemas are generated from. It follows Distilled, so a release of this package that moves the Distilled pin moves it too, and its changelog says so. An explicit `apiVersion` passed to `layer` or `layerConfig` wins, and a resource-module call can override both (`RequestOptions.apiVersion`).

Stripe delivers a webhook event at the receiving endpoint's API version (or the account default), not at this one. Create the endpoints whose events you read at `DISTILLED_API_VERSION`, and keep any code of yours that reads Stripe's JSON directly (event payloads) on the same version.

For finer control, `StripePayments.capabilities` provides every capability over Distilled's `Credentials` and an `HttpClient` in context, at the default policy, and the individual layers (`customersLayer`, `productsLayer`, …, `checkoutSessionsLayer`, `billingPortalSessionsLayer`) are exported too:

```typescript
import { Layer, Redacted } from "effect";
import { FetchHttpClient } from "effect/http";
import * as Credentials from "@distilled.cloud/stripe/Credentials";
import * as StripePayments from "@thomasfosterau/effect-biz-payments-stripe/StripePayments";

const customers = StripePayments.customersLayer.pipe(
  Layer.provide(Credentials.credentials({ apiKey: Redacted.make("sk_test_...") })),
  Layer.provide(FetchHttpClient.layer),
);
```

Importing `@distilled.cloud/stripe/Credentials` yourself means adding `@distilled.cloud/stripe` as your own dependency, at **exactly** the version in this package's `dependencies`, and moving it in step whenever you upgrade this package. Only at that version is its `Credentials` guaranteed to be the service the layers require: Distilled is pre-1.0 and may change it in any release (its `credentials` takes the key as a `Redacted<string>`), and another version installs a second copy of Distilled beside this package's. `layer` / `layerFromEnv` / `layerConfig` need no Distilled import.

### Runtime: a `process` global

The capability layers need a `process` global with an `env` object. Distilled reads `process.env.DISTILLED_DEBUG_HTTP`, unguarded, each time it builds a request and each time it reads a response, so where there is no `process` global every call that reaches Distilled dies with a defect, not a `PaymentsError`. Node, Bun and Deno have one; on **Cloudflare Workers, enable the `nodejs_compat` compatibility flag**. The resource modules run on Distilled too, so the same holds for each of their calls. Loading the package and building the layers do not touch `process`, and neither does `Webhook.verify`.

**Leave `DISTILLED_DEBUG_HTTP` unset outside local debugging.** While it is set, Distilled writes to `console.error`, for every request, the method and full URL (a `GET`'s query string included) and the first 400 characters of the request body (as JSON), and for every response the status and the first 400 characters of the body. Those characters can hold part or all of a payment intent's or checkout session's `client_secret`, and whatever customer data the call carries. The `Authorization` header, and so the API key, is not logged.

### "Not configured ≡ down"

`StripePayments.layerConfig` reads the key (`STRIPE_API_KEY` by default, or `envVar`) on **every call**, never while the layer is built: from the calling fiber's `ConfigProvider` first, then from the one the layer was built under (so `layerConfig().pipe(Layer.provide(ConfigProvider.layer(…)))` works as it does for `layerFromEnv`). The layer therefore always builds, and a call made while the key is absent or empty fails with `PaymentsUnavailable` before Distilled runs, exactly as if Stripe were down (answer it with a 503). So a Worker without billing configured still boots and serves everything else, with or without `nodejs_compat`. Once the key is set, the calls need the `process` global (see [Runtime: a `process` global](#runtime-a-process-global)): without it, each one dies with a defect instead of reaching Stripe.

```typescript
import { Effect, Layer } from "effect";
import { FetchHttpClient } from "effect/http";
import * as CheckoutSession from "@thomasfosterau/effect-biz/Payments.CheckoutSession";
import * as StripePayments from "@thomasfosterau/effect-biz-payments-stripe/StripePayments";

const billing = StripePayments.layerConfig({ envVar: "STRIPE_SECRET_KEY" }).pipe(
  Layer.provide(FetchHttpClient.layer),
);

const checkout = (params: CheckoutSession.CreateParams) =>
  CheckoutSession.create(params).pipe(
    Effect.map((session) => Response.redirect(session.url, 303)),
    Effect.catchTag("PaymentsUnavailable", () =>
      Effect.succeed(new Response(null, { status: 503 })),
    ),
    Effect.provide(billing),
  );
```

`StripeHttp.layerConfig` is the same posture for the resource modules' client. For a provider-neutral stub with no transport at all, use `Stub.unavailable("stripe")` from `@thomasfosterau/effect-biz/Payments.Stub`.

## The Stripe escape hatch

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

Each module is a thin wrapper of **every** `@distilled.cloud/stripe` operation on its resource, its sub-resources and test helpers included (`Invoice.finalize` / `pay` / `voidInvoice` / `send` / `listLines` / `search`, `Subscription.resume` / `migrate` / `search`, `Customer.listPaymentMethods`, `Treasury.InboundTransfer.testHelpersSucceed`, …), and re-exports Distilled's input and output types (each also its `Schema`: `Customer.Customer`, `Customer.CreateCustomerRequest`, `Customer.GetCustomersResponse`, …). An operation:

- takes the resource's **path ids first, as strings, in path order** (`Person.retrieve(accountId, personId)`), then the rest of Distilled's input as `params` (optional unless Distilled requires a member; absent when the operation takes nothing else), then **`options?: RequestOptions`**: `idempotencyKey`, `stripeAccount` and `apiVersion`, each overriding the client's;
- requires `StripeHttp` (`StripeHttp.layer` / `layerFromEnv` / `layerConfig`, or `layerFromContext` over Distilled's `Credentials`), which runs it under the same request policy as the capabilities: the pinned `Stripe-Version`, the SDK's retries with one `Idempotency-Key` per write (every `POST`, and a `/v2` `DELETE`), a `/v2` request's array query params indexed as the SDKs send them (`include[0]=…`), a per-attempt timeout, redirects refused, the uploads origin for `File.create`;
- fails only with the neutral `PaymentsError` channel (an empty id fails with `PaymentInvalidRequestError` before anything is sent, as does an empty option);
- resolves to the response **as Stripe sent it**, typed with Distilled's declarations and **not validated**. Distilled's response enumerations are plain strings, and its types describe `DISTILLED_API_VERSION`: at an older `apiVersion`, a field they mark required may be absent.

Gaps in Distilled's typing that the modules inherit (`@distilled.cloud/stripe` `1.0.0-rc.15`):

- **`Transfer.create` / `retrieve` / `update` resolve to `unknown`, and `Transfer.list`'s `data` to `Array<unknown>`**: Distilled declares no Transfer schema. Decode the result yourself.
- **Input types declare optional members as bare `?: T`**, as Distilled generates them. Under `exactOptionalPropertyTypes`, a caller forwarding an optional of its own (`Customer.create({ email })` with `email: string | undefined`) fails to type-check: omit an absent member rather than pass `undefined`. The neutral capabilities are unaffected; their params take `?: T | undefined`.
- **`File.create`'s `file` is retyped `string | Blob`** (a `File` is a `Blob`): Distilled declares it `string`, but sends a `Blob` as the multipart file part, which is how a file is uploaded. No cast is needed.

The names follow the path (`create` / `retrieve` / `update` / `del` / `list`, an action by its name, a sub-resource's operation by its singular, `testHelpers…` for a test helper), keeping every name a module had before it re-exported Distilled; `del` because `delete` is reserved, and likewise `Invoice.voidInvoice`. A raw module is also the full-fidelity alternative where a neutral capability exists: the raw `CheckoutSession` module takes every Stripe Checkout parameter where `StripePayments.checkoutSessionsLayer` takes only the neutral ones. Some raw modules share a name with a neutral core module (`Customer`, `CheckoutSession`, …), so alias one of them when a program imports both.

Make one `idempotencyKey` per logical write before the first attempt and reuse it on every retry; it is sent verbatim as `Idempotency-Key` on any method. Because of the trailing arguments, wrap an operation before passing it to an index-supplying iterator: `Effect.forEach(ids, (id) => Customer.del(id))`. The neutral capabilities take the neutral `idempotencyKey` on their create / confirm operations; the retry rules are in the core package's README ("Retrying a write safely").

**Type-checking cost.** A resource module's declarations name Distilled's operations module, one declaration file of about 7.5 MB, which a consumer that imports any resource module (or the package root) type-checks once. Measured for a one-line consumer of one module (`./Customer`, `./Treasury.FinancialAccount`, `skipLibCheck`) against the modules before effect-finance#146 (which pulled in the `stripe` SDK's types or the generated schemas instead): about 0.45–0.5 s with the native `tsc` (+0.1–0.2 s, no more memory) and 1.9–2.0 s with TypeScript 6's `tsc` (+0.2–0.3 s, about +10 MiB). `./StripePayments`, `./StripeHttp` and `./Webhook` never reach it.

**Every resource has a module.** The 131 resource subpaths wrap 587 of Distilled `1.0.0-rc.15`'s 589 Stripe operations:

- **Top level:** `Account`, `AccountLink`, `AccountSession`, `ApplePayDomain`, `ApplicationFee`, `Balance`, `BalanceSettings`, `BalanceTransaction`, `Charge`, `CheckoutSession`, `ConfirmationToken`, `CountrySpec`, `Coupon`, `CreditNote`, `Customer`, `CustomerSession`, `Dispute`, `EphemeralKey`, `Event`, `ExchangeRate`, `ExternalAccount`, `File`, `FileLink`, `Invoice`, `InvoiceItem`, `InvoicePayment`, `InvoiceRenderingTemplate`, `Mandate`, `PaymentAttemptRecord`, `PaymentIntent`, `PaymentLink`, `PaymentMethod`, `PaymentMethodConfiguration`, `PaymentMethodDomain`, `PaymentRecord`, `Payout`, `Person`, `Plan`, `Price`, `Product`, `PromotionCode`, `Quote`, `Refund`, `Review`, `SetupAttempt`, `SetupIntent`, `ShippingRate`, `Source`, `Subscription`, `SubscriptionItem`, `SubscriptionSchedule`, `TaxCode`, `TaxId`, `TaxRate`, `Token`, `Topup`, `Transfer`, `WebhookEndpoint`.
- **Namespaced** (one subpath each, `./<Namespace>.<Resource>`): `Apps.*` (`Install`, `Secret`), `Billing.*` (`Alert`, `CreditBalanceSummary`, `CreditBalanceTransaction`, `CreditGrant`, `FeedbackOption`, `Meter`, `MeterEvent`, `MeterEventAdjustment`), `BillingPortal.*` (`Configuration`, `Session`), `Climate.*` (`Order`, `Product`, `Supplier`), `Entitlements.*` (`ActiveEntitlement`, `Feature`), `FinancialConnections.*` (`Account`, `Session`, `Transaction`), `Forwarding.Request`, `Identity.*` (`VerificationReport`, `VerificationSession`), `Issuing.*` (`Authorization`, `Card`, `Cardholder`, `Dispute`, `PersonalizationDesign`, `PhysicalBundle`, `Token`, `Transaction`), `ProductCatalog.TrialOffer`, `Radar.*` (`EarlyFraudWarning`, `PaymentEvaluation`, `ValueList`, `ValueListItem`), `Reporting.*` (`ReportRun`, `ReportType`), `Sigma.ScheduledQueryRun`, `Tax.*` (`Association`, `Calculation`, `Location`, `Registration`, `Settings`, `Transaction`), `Terminal.*` (`Configuration`, `ConnectionToken`, `Location`, `OnboardingLink`, `Reader`), `TestHelpers.TestClock`, `ThreeDSecure.Authentication`, and `Treasury.*` (`CreditReversal`, `DebitReversal`, `FinancialAccount`, `InboundTransfer`, `OutboundPayment`, `OutboundTransfer`, `ReceivedCredit`, `ReceivedDebit`, `Transaction`, `TransactionEntry`; `./Treasury` re-exports all ten).
- **The `/v2` APIs:** `V2.Billing.*` (`MeterEvent`, `MeterEventAdjustment`, `MeterEventSession`), `V2.Commerce.ProductCatalogImport` and `V2.Core.*` (`Account`, `AccountLink`, `AccountPerson`, `AccountPersonToken`, `AccountToken`, `Event`, `EventDestination`). They run under the same request policy; Distilled sends their params as a JSON body rather than form-encoded, and a `/v2` list is a `{ data, next_page_url, previous_page_url }` page.

The package root re-exports every one of them, flattened (`BillingMeter`, `TaxCalculation`, `V2CoreAccount`, …). A singleton's `POST` is `update` (`BalanceSettings.update`, `Tax.Settings.update`), `Apps.Secret.delWhere` deletes a secret by name and scope (stripe-node's `deleteWhere`; every `del` deletes by id), `CreditNote.voidCreditNote` follows `Invoice.voidInvoice`, `Billing.CreditGrant.voidGrant` is stripe-node's name, and `CreditNote.listPreviewLines` lists a preview's lines. `EphemeralKey.create` needs the mobile SDK's API version: pass it as `options.apiVersion`.

Two operations stay unwrapped, because `StripeHttp`'s request policy cannot run them (call `@distilled.cloud/stripe` directly, at the version this package pins):

- **`GET /v1/quotes/{quote}/pdf`** (Distilled's `GetQuotePdf`): a binary PDF streamed from `files.stripe.com`, where `StripeHttp` sends every non-upload request to the API origin and reads every 2xx as JSON (Distilled types the result `{}`).
- **`POST /v2/billing/meter_event_stream`** (`CreateBillingMeterEventStream`): sent to `meter-events.stripe.com` with a meter event session's token rather than the account key. `V2.Billing.MeterEventSession.create` makes the session.

## Webhooks

`Webhook.verify` is a Workers-safe WebCrypto verifier (HMAC-SHA256, constant-time compare, ±300 s tolerance by default, "now" from `Clock`) that needs neither the SDK nor any Node API. Pass the raw body bytes; nothing is decoded until the signature verifies, and every refusal is a `SignatureVerificationError` that never carries the secret. `decodeHandledEvent` narrows a verified event to the handled event types (`handledEventTypes`: `checkout.session.completed`, `customer.subscription.created` / `updated` / `deleted` and `invoice.payment_failed`), decoding the fields of its `data.object` a handler reads; any other type is `Option.none()`.

Stripe treats every non-2xx answer as a failed delivery and retries it for a limited period (see [Stripe's webhook docs](https://docs.stripe.com/webhooks)), so the status mostly tells the operator which side is at fault: a 400 for a bad delivery (an unreadable body, a signature refusal, a signed body that is not an event envelope), a 500 for breakage on this side (a handled event that fails to decode, say after a field moved in a new API version). A fix that ships after the retries stop needs the event resent from the Dashboard.

```typescript
import { Effect, Option, Redacted, Schema } from "effect";
import * as Webhook from "@thomasfosterau/effect-biz-payments-stripe/Webhook";

class UnreadableBodyError extends Schema.TaggedError<UnreadableBodyError>()(
  "UnreadableBodyError",
  {},
) {}

const status = (code: number) => Effect.succeed(new Response(null, { status: code }));

const handle = Effect.fn("handleStripeWebhook")(
  function* (request: Request, secret: Redacted.Redacted<string>) {
    const payload = new Uint8Array(
      yield* Effect.tryPromise({
        try: () => request.arrayBuffer(),
        catch: () => new UnreadableBodyError(),
      }),
    );
    const event = yield* Webhook.verify({
      payload,
      header: request.headers.get(Webhook.SIGNATURE_HEADER),
      secret,
    });
    return yield* Webhook.decodeHandledEvent(event).pipe(
      Effect.flatMap((handled) => {
        if (Option.isSome(handled)) {
          // Act on handled.value: its `type` narrows `data.object`.
        }
        // Acknowledge every other type: refusing it makes Stripe retry it.
        return status(200);
      }),
      // Breakage on this side: log the id and type, never the payload.
      Effect.catchTag("SchemaError", () =>
        Effect.logError("Handled Stripe event failed to decode").pipe(
          Effect.annotateLogs({ id: event.id, type: event.type }),
          Effect.andThen(status(500)),
        ),
      ),
    );
  },
  Effect.catchTags({
    SignatureVerificationError: () => status(400), // bare: never say which check failed
    SchemaError: () => status(400), // signed, but not an event envelope
    UnreadableBodyError: () => status(400),
  }),
);
```

[`examples/webhooks.ts`](https://github.com/thomasfosterau/effect-biz/blob/main/packages/payments-stripe/examples/webhooks.ts) is the full version: the secret read through `Config`, an exhaustive `Match` over the handled types, and a demo that signs its own test deliveries with `Webhook.signatureHeader`.

The SDK-based `Webhook.constructEvent` / `constructEventAsync` remain as an optional alternative; they run on an SDK client you provide, `Layer.succeed(Webhook.StripeService, new Stripe(key))` (the verifier uses only the endpoint secret, never the key). For them, a `tolerance` of `0` means the default 300 s; a negative tolerance skips the timestamp check. `Webhook.verify` reads `0` as "this second only".

## API

| Module | Purpose |
| --- | --- |
| `StripePayments` | `layer` / `layerFromEnv` / `layerConfig` (every capability, from configuration), `capabilities` (every capability over Distilled's `Credentials` and an `HttpClient`), the individual capability layers, and `DISTILLED_API_VERSION` (the `Stripe-Version` they pin). |
| `StripeHttp` | The client the resource modules run on: the `StripeHttp` service (`call`), `layer` / `layerFromEnv` / `layerConfig` / `layerFromContext` / `make`, the `StripeHttpConfig` / `LayerConfigOptions` / `RequestOptions` types and `DISTILLED_API_VERSION`. |
| `Webhook` | `verify` (and `verifySignature`, the check alone), `decodeEvent`, `decodeHandledEvent` with `handledEventTypes` / `HandledEvent` and the per-object decoders, `SIGNATURE_HEADER`, `DEFAULT_TOLERANCE`, `signatureHeader` (signs a test delivery); the SDK-based `constructEvent` / `constructEventAsync`, `generateTestHeaderString` / `generateTestHeaderStringAsync` and the `StripeService` they need. |
| `Customer`, `Invoice`, `CheckoutSession`, `BillingPortal.Session`, `Treasury`, `Billing.*`, `Tax.*`, `Issuing.*`, `Terminal.*`, `V2.Core.*`, … | Raw resource modules, one per Stripe API resource, 131 in all (listed under [The Stripe escape hatch](#the-stripe-escape-hatch)), generated from Distilled's operations. |

The root entry re-exports the core (`Payments`), `StripeHttp`, `StripePayments`, `Webhook` and the raw modules as namespaces (flattened: `BillingMeter`, `V2CoreAccount`, …; the ten `Treasury.*` modules under `Treasury`), plus the `StripeErrors` (= `PaymentsError`), `RequestOptions` and `StripeHttpConfig` types; it never loads the SDK. Its declarations reach Distilled's whole operations module, so import a subpath when you need only part of it.

## License

MIT © Thomas Foster
