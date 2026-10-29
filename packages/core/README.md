# @thomasfosterau/effect-biz

**Disclaimer:** This is an experiment. Don't use it in production.

The foundation of the effect-biz package family: the identifiers, tenancy context, error channel, domain events and repository conventions every effect-biz domain package builds on, and the vendor-neutral payments core (`@thomasfosterau/effect-biz/Payments`; see [Payments](#payments)).

## Install

```sh
pnpm add effect @thomasfosterau/effect-biz
```

`effect` is a peer (`^4.0.0`): your application owns the single copy.

## Status

The platform foundation is a placeholder, tracked in the repository's issues.

```ts
import { name } from "@thomasfosterau/effect-biz";

console.log(name);
```

## Payments

A vendor-neutral payments core for Effect, under `@thomasfosterau/effect-biz/Payments` (the barrel) and `@thomasfosterau/effect-biz/Payments.<Module>` (one module each).

Write your payment workflows against provider-agnostic capabilities, and choose the provider at the edge of your application by the layer you provide: [`@thomasfosterau/effect-biz-payments-stripe`](https://www.npmjs.com/package/@thomasfosterau/effect-biz-payments-stripe), [`-paypal`](https://www.npmjs.com/package/@thomasfosterau/effect-biz-payments-paypal) or [`-airwallex`](https://www.npmjs.com/package/@thomasfosterau/effect-biz-payments-airwallex). It is the payments analogue of Effect's AI modules: one abstraction, one package per provider.

Add a provider package to run a program.

### Usage

A program depends only on the **capabilities** it uses; it never imports a provider:

```typescript
import { Effect } from "effect";
import * as Customer from "@thomasfosterau/effect-biz/Payments.Customer";
import * as Subscription from "@thomasfosterau/effect-biz/Payments.Subscription";

// Effect<{ customer, subscription }, PaymentsError, Customers | Subscriptions>
const onboard = (email: string, priceId: string) =>
  Effect.gen(function* () {
    const customer = yield* Customer.create({ email });
    const subscription = yield* Subscription.create({
      customer: customer.id,
      items: [{ price: priceId }],
    });
    return { customer, subscription };
  });
```

Run it by providing a provider's layer, for example `StripePayments.layer` from `@thomasfosterau/effect-biz-payments-stripe`. Swapping providers means swapping the layer, not the program.

Providers may implement only the capabilities they support: Airwallex covers customers, payment intents and refunds; PayPal covers products, prices, payment intents, subscriptions and refunds, but has no customers. The type system enforces this: a program that needs a capability the provided layer doesn't supply does not type-check. An individual operation a provider lacks (deleting an Airwallex customer, listing PayPal orders) fails with `PaymentInvalidRequestError`; each provider's README lists them.

### Capabilities

Each resource is an abstract Effect service (a `Context.Service`). A program that calls `Customer.create(...)` requires the `Customers` capability in its environment, and nothing more.

| Module | Capability | Operations |
| --- | --- | --- |
| `Customer` | `Customers` | `create`, `retrieve`, `update`, `del`, `list` |
| `Product` | `Products` | `create`, `retrieve`, `update`, `del`, `list` |
| `Price` | `Prices` | `create`, `retrieve`, `update`, `list` |
| `PaymentIntent` | `PaymentIntents` | `create`, `retrieve`, `update`, `confirm`, `cancel`, `list` |
| `Subscription` | `Subscriptions` | `create`, `retrieve`, `update`, `cancel`, `list` |
| `Refund` | `Refunds` | `create`, `retrieve`, `update`, `list` |
| `CheckoutSession` | `CheckoutSessions` | `create` (a hosted checkout page → its `url`) |
| `BillingPortal` | `BillingPortalSessions` | `create` (a hosted billing portal page → its `url`) |

Every operation returns `Effect<Entity, PaymentsError, Capability>`. List operations return a neutral `Page<Entity>` (`{ data, hasMore, nextCursor }`; request the next page by passing `nextCursor` as `startingAfter`, with the same `limit` and filters); deletions return `Deleted` (`{ id, deleted: true }`).

#### Hosted checkout and billing portal

`CheckoutSession.create` and `BillingPortal.create` return an entity whose `url` you redirect the buyer to. A checkout never takes an amount: it names the provider's price ids (`lineItems`, at least one), so the buyer pays the price's amount. `mode` is `"payment"` or `"subscription"` (which also takes `subscriptionMetadata`, stored on the subscription the checkout creates).

```typescript
import { Effect } from "effect";
import * as BillingPortal from "@thomasfosterau/effect-biz/Payments.BillingPortal";
import * as CheckoutSession from "@thomasfosterau/effect-biz/Payments.CheckoutSession";

// Effect<string, PaymentsError, CheckoutSessions>
const checkout = (customer: string, priceId: string) =>
  CheckoutSession.create({
    mode: "subscription",
    customer,
    lineItems: [{ price: priceId }],
    successUrl: "https://example.com/billing?checkout=success",
    cancelUrl: "https://example.com/pricing",
  }).pipe(Effect.map((session) => session.url));

// Effect<string, PaymentsError, BillingPortalSessions>
const portal = (customer: string) =>
  BillingPortal.create({ customer, returnUrl: "https://example.com/account" }).pipe(
    Effect.map((session) => session.url),
  );
```

### Domain types

Entities are provider-agnostic `effect/Schema` classes: `Customer`, `Product`, `Price`, `PaymentIntent`, `Subscription`, `Refund`, `CheckoutSession`, `BillingPortalSession` and `Money`. They contain only fields that are meaningful across providers, in a normalized shape (`camelCase`, neutral status enums). **Amounts are always in the smallest currency unit** (`2000` = $20.00), and currencies are lower-cased ISO 4217 codes (`"usd"`).

Status and type enums are lenient: each is the known literals plus `Other` (`{ _tag: "Other", raw }`), carrying a provider value the library does not model, so an unexpected value never fails a whole list page. Match exhaustively with a case for `Other` (`Enumeration.isOther`). Each module exports the enum twice: `Known<Name>` (the literals, the type a request filter takes) and `<Name>` (the lenient union, the type of the entity field): `PaymentIntent.PaymentStatus`, `Subscription.SubscriptionStatus`, `Refund.RefundStatus`, `Price.PriceType` and `Price.RecurringInterval`. `CheckoutSession.CheckoutMode` is a request input and stays closed.

### Errors

The failure channel is the neutral `PaymentsError` union:

- `PaymentProviderError` — a provider rejected the request for a reason no other variant covers, or answered with a response that does not decode (carries `provider`, `code`, `statusCode`, `cause`).
- `PaymentAuthenticationError` — authentication failed (carries `statusCode`).
- `PaymentRateLimitError` — too many requests (carries `retryAfter`, in seconds, when the provider sends one).
- `PaymentInvalidRequestError` — invalid parameters, or an operation the provider does not support (carries `param`, `statusCode`).
- `PaymentNetworkError` — transport-level failure, including a timeout (carries `cause`).
- `PaymentsUnavailable` — no provider can serve the call, typically because its credential is not configured (carries `provider`). This is "not configured ≡ down": it is raised at call time, never while a layer is built, so an application without payments configured still starts and answers the call as it would an outage (an HTTP API answers it with a 503).

Outside the union: `PaymentConfigError` (raised while building a provider layer) and `SignatureVerificationError` (webhook verification).

```typescript
import { Effect } from "effect";
import * as Customer from "@thomasfosterau/effect-biz/Payments.Customer";

const program = Customer.create({ email: "jane@example.com" }).pipe(
  Effect.catchTags({
    PaymentAuthenticationError: (e) => Effect.logError(`Auth failed: ${e.message}`),
    PaymentRateLimitError: (e) => Effect.logError(`Rate limited; retry after ${e.retryAfter}s`),
  }),
);
```

### Retrying a write safely

A write that fails with a `PaymentNetworkError` (a timeout, a dropped connection), or a provider 5xx, has an **unknown outcome**: the provider may have applied it. Repeating it blindly can charge, refund or create twice. Pass an `idempotencyKey` and the provider recognises the repeat as the same write and answers with the original outcome instead of applying it again.

```typescript
import { Effect, Schedule } from "effect";
import * as IdempotencyKey from "@thomasfosterau/effect-biz/Payments.IdempotencyKey";
import * as Refund from "@thomasfosterau/effect-biz/Payments.Refund";
import type { PaymentsError } from "@thomasfosterau/effect-biz/Payments";

// The outcome may be unknown (or the write not applied): safe to repeat with the same key.
const isUnknownOutcome = (error: PaymentsError) =>
  error._tag === "PaymentNetworkError" ||
  error._tag === "PaymentRateLimitError" ||
  (error._tag === "PaymentProviderError" && (error.statusCode ?? 0) >= 500);

const refund = (paymentIntent: string) =>
  Effect.gen(function* () {
    const idempotencyKey = yield* IdempotencyKey.generate; // once per logical write
    return yield* Refund.create({ paymentIntent, idempotencyKey }).pipe(
      Effect.retry({
        while: isUnknownOutcome, // see "Retry only when" below
        schedule: Schedule.exponential("200 millis"),
        times: 3,
      }),
    ); // the same key on every attempt
  });
```

The rules:

- **One key per logical write**, created by the caller _before the first attempt_ (`IdempotencyKey.generate`, or your own id for the operation, such as `refund-${orderId}`) and passed unchanged on every retry. A key generated inside the retried effect is a new key per attempt and protects nothing. Never reuse a key for a different write: a provider answers the same key with different parameters with an error rather than the original outcome. Stripe's is `idempotency_error`, which surfaces as `PaymentProviderError` with code `StripeIdempotencyError` (not `PaymentInvalidRequestError`). PayPal's API specifications do not say what it answers, and Airwallex's behaviour here is unverified.
- **Accepted on the create and confirm operations** that every provider implementing them can honour: `Customer.create`, `Product.create`, `Price.create`, `PaymentIntent.create` / `confirm`, `Subscription.create`, `Refund.create`, `CheckoutSession.create`. It is optional, and a program that passes none behaves as before. Updates are set-semantics and repeatable. `Subscription.cancel` and `PaymentIntent.cancel` do **not** take one (PayPal cannot honour a key there), and neither does `BillingPortal.create`: the option is absent from their types, so passing one does not compile.
- **Retry only when the outcome is unknown or the write was not applied**: `PaymentNetworkError`, `PaymentProviderError` with `statusCode >= 500` (a vendor 5xx surfaces as this, not as `PaymentNetworkError`) and `PaymentRateLimitError` (back off for `retryAfter` first). Do not retry `PaymentInvalidRequestError`, `PaymentAuthenticationError`, or a `PaymentProviderError` below 500 (including Stripe's `StripeIdempotencyError`): they fail the same way again.
- **The shape is the lowest common denominator**: 1 to 64 characters from `A-Z a-z 0-9 _ -` (a UUID is 36). `IdempotencyKey.IdempotencyKey` is the branded `Schema`; `IdempotencyKey.IdempotencyKey.make` (throws on a bad shape) or `IdempotencyKey.validate` (fails with `PaymentInvalidRequestError`) check a value of your own, and a raw string that slips past the types fails with `PaymentInvalidRequestError` before anything is sent.
- **A window, not forever**: providers remember a key for a limited time, differing per provider and, on PayPal, per API. Treat a retry within a few hours as safe, and a later one as a new write. On PayPal a `PaymentIntent.create` / `confirm` retry is deduplicated only within 6 hours, the Orders API's default. The figures, PayPal's from its published OpenAPI specifications (pinned at commit `90e8041`):

  | Provider and API | Key length | Kept for | Source |
  | --- | --- | --- | --- |
  | PayPal Orders (`PaymentIntent.create` / `confirm`) | 1 to 108 characters | 6 hours (up to 72 on request to PayPal) | [`checkout_orders_v2.json`](https://raw.githubusercontent.com/paypal/paypal-rest-api-specifications/90e8041ffe02d80c452d2b476bedd59a8d219bdc/openapi/checkout_orders_v2.json) |
  | PayPal Catalog Products (`Product.create`) | not stated | 72 hours | [`catalogs_products_v1.json`](https://raw.githubusercontent.com/paypal/paypal-rest-api-specifications/90e8041ffe02d80c452d2b476bedd59a8d219bdc/openapi/catalogs_products_v1.json) |
  | PayPal Subscriptions (`Price.create`, `Subscription.create`) | not stated | 72 hours | [`billing_subscriptions_v1.json`](https://raw.githubusercontent.com/paypal/paypal-rest-api-specifications/90e8041ffe02d80c452d2b476bedd59a8d219bdc/openapi/billing_subscriptions_v1.json) |
  | PayPal Payments (`Refund.create`) | 1 to 10 000 characters | not stated | [`payments_payment_v2.json`](https://raw.githubusercontent.com/paypal/paypal-rest-api-specifications/90e8041ffe02d80c452d2b476bedd59a8d219bdc/openapi/payments_payment_v2.json) |
  | Stripe | 255 characters | at least 24 hours | unverified ([effect-finance#93](https://github.com/thomasfosterau/effect-finance/issues/93)) |
  | Airwallex | about 64 characters | unknown | unverified ([effect-finance#93](https://github.com/thomasfosterau/effect-finance/issues/93)) |

  The 1 to 64 character shape fits PayPal's Orders (1 to 108) and Payments (refunds, 1 to 10 000) limits; PayPal states no limit for Catalog Products and Subscriptions. It stays within the unverified Stripe and Airwallex figures.

Mapping: Stripe sends `Idempotency-Key`; PayPal sends `PayPal-Request-Id` (on the `POST`); Airwallex sends `request_id` in place of its fresh per-call id. Without a key, PayPal sends no id, Airwallex keeps a fresh per-call `request_id` and Stripe's client generates a key of its own per call (for its own internal retries); none of those deduplicates your retry.

### Stubs

`Stub` builds capability layers whose every call fails with one given failing `Effect` (`Stub.Failure`): `Stub.layer(failure)` for every capability, one constructor per capability (`Stub.customers`, …, `Stub.billingPortalSessions`), and `Stub.unavailable(provider?)`, every capability failing with `PaymentsUnavailable`, for an environment with no provider configured or a unit suite with no transport at all.

```typescript
import { Effect } from "effect";
import * as Customer from "@thomasfosterau/effect-biz/Payments.Customer";
import * as Stub from "@thomasfosterau/effect-biz/Payments.Stub";

// Fails with PaymentsUnavailable, as if the provider were down.
const exit = await Effect.runPromiseExit(
  Customer.create({ email: "jane@example.com" }).pipe(Effect.provide(Stub.unavailable("stripe"))),
);
```

### API

Every module is its own subpath (`@thomasfosterau/effect-biz/Payments.<Module>`). `@thomasfosterau/effect-biz/Payments` re-exports the capability modules, `Enumeration`, `IdempotencyKey` and `Stub` as namespaces, and flattens the errors, `Page` / `Deleted`, `Money`, `Metadata` and `money` (`Money.make`).

| Module | Purpose |
| --- | --- |
| `Customer`, `Product`, `Price`, `PaymentIntent`, `Subscription`, `Refund` | The capability, its entity, its params (`CreateParams`, `UpdateParams`, `ListParams`, …), its enums and the accessor functions. |
| `CheckoutSession`, `BillingPortal` | Hosted checkout and billing portal sessions: an entity whose `url` you redirect to. |
| `Money` | `Money` (minor-unit amount + currency), `make`, `Metadata`. |
| `Page` | `Page<A>` and `Deleted`. |
| `PaymentsError` | The error classes and the `PaymentsError` union. |
| `IdempotencyKey` | The branded key, `generate` and `validate`. |
| `Enumeration` | The lenient-enum helpers: `Other`, `other`, `isOther`, `lenient`, `parse` (a raw string → a known literal or `Other`) and `fromWire` (the same as a `Schema` codec, for a provider's wire schema). |
| `Stub` | Capability layers that fail every call with one error: `layer`, one constructor per capability, `unavailable`, and the `Failure` / `Capabilities` types. |

### Internal subpath (not public API)

`@thomasfosterau/effect-biz/Payments.internal` holds helpers that the provider packages in this repository share (`shareLogin`, one in-flight token login shared by every waiting caller; the integer money core used to convert between minor units and major-unit decimals; the token cache and time-boxed request helpers of an OAuth-style login; the request helpers of a provider built over a generated operation client; and the response decoding, timestamp reading and HTTP error-status classification of a REST provider). It exists only because a provider may import nothing else of this workspace. It is **internal and exempt from semver**: its exports can change or disappear in any release, minor and patch included. Do not import it from application code.

## License

MIT © Thomas Foster
