# @thomasfosterau/effect-biz-payments-paypal

A PayPal implementation of effect-biz's vendor-neutral payments core.

It implements the capabilities PayPal supports from [`@thomasfosterau/effect-biz/Payments`](https://www.npmjs.com/package/@thomasfosterau/effect-biz) over [Distilled's PayPal operations](https://www.npmjs.com/package/@distilled.cloud/paypal) (`@distilled.cloud/paypal`, on `effect/http`: no vendor SDK, and no Node API but a `process` global; see [Runtime: a `process` global](#runtime-a-process-global)), authenticated by this package's own OAuth login. For a PayPal call the capabilities do not cover, use Distilled directly; see [Calls of your own](#calls-of-your-own).

The same neutral program runs on PayPal, Stripe or Airwallex — only the layer you provide changes.

## Install

```bash
pnpm add @thomasfosterau/effect-biz @thomasfosterau/effect-biz-payments-paypal effect
```

`effect` is a peer dependency, at `^4.0.0`: that is the peer range `@distilled.cloud/paypal` and `@distilled.cloud/core` declare, and no `4.0.0-rc.*` prerelease satisfies it. Those two are dependencies, pinned exactly (they are pre-1.0): about 9 MB installed with core's `graphql` dependency (shared with the Stripe package when both are installed), of which a bundler keeps only the operations the capabilities you use call.

## Usage

```typescript
import { Effect, Layer, Redacted } from "effect";
import { FetchHttpClient } from "effect/http";
import * as Product from "@thomasfosterau/effect-biz/Payments.Product";
import * as PayPalPayments from "@thomasfosterau/effect-biz-payments-paypal/PayPalPayments";

const program = Product.create({ name: "Premium" });

// The PayPal layer speaks `effect/http`: it requires an `HttpClient`,
// which `FetchHttpClient.layer` supplies on Node, Bun, Deno and Workers alike.
const layer = PayPalPayments.layer({
  clientId: process.env.PAYPAL_CLIENT_ID!,
  clientSecret: Redacted.make(process.env.PAYPAL_CLIENT_SECRET!),
  environment: "sandbox", // or "live" (the default)
}).pipe(Layer.provide(FetchHttpClient.layer));
// from PAYPAL_CLIENT_ID / PAYPAL_CLIENT_SECRET / PAYPAL_ENV (required: live | sandbox):
// const layer = PayPalPayments.layerFromEnv().pipe(Layer.provide(FetchHttpClient.layer));

// Calls PayPal when invoked: `const product = await createProduct();`
const createProduct = () => Effect.runPromise(program.pipe(Effect.provide(layer)));
```

### Configuration

`PayPalPayments.layer` takes a `PayPalConfig`:

| Field | Required | Meaning |
| --- | --- | --- |
| `clientId` | yes | The REST app's client id. |
| `clientSecret` | yes | The client secret, a `Redacted<string>`. |
| `environment` | no | `"live"` (default) or `"sandbox"`; selects the endpoint. |
| `baseUrl` | no | An absolute http(s) URL that overrides the environment's endpoint (a proxy, a mock server). |
| `loginTimeout` | no | Milliseconds the OAuth login may take (default 30 000). |
| `timeout` | no | Milliseconds a resource request may take (default 80 000). |

An empty `clientId` or `clientSecret`, a bad `baseUrl` or a bad timeout fails the layer build with `PaymentConfigError`.

`layerFromEnv(clientIdVar?, clientSecretVar?)` reads the same configuration through `Config` (the current `ConfigProvider`, by default the process environment):

| Variable | Required | Maps to |
| --- | --- | --- |
| `PAYPAL_CLIENT_ID` (or `clientIdVar`) | yes | `clientId` |
| `PAYPAL_CLIENT_SECRET` (or `clientSecretVar`) | yes | `clientSecret` (read with `Config.Redacted`) |
| `PAYPAL_ENV` | yes: `live` or `sandbox` | `environment` |
| `PAYPAL_BASE_URL` | no | `baseUrl` |

The timeouts keep their defaults there. Every problem (a missing, empty or misspelt variable) fails the layer build with `PaymentConfigError` (the Environment and Empty variables notes below).

### What the layers require

`PayPalPayments.layer` / `layerFromEnv` need only an `HttpClient`: they log in with the client credentials. The individual capability layers (`productsLayer` … `refundsLayer`) and `capabilities` need Distilled's `Credentials` and an `HttpClient` instead, and send the credentials' access token as it is, with no login and no refresh:

```typescript
import { Layer, Redacted } from "effect";
import { FetchHttpClient } from "effect/http";
import { fromApiKey } from "@distilled.cloud/paypal/Credentials";
import * as PayPalPayments from "@thomasfosterau/effect-biz-payments-paypal/PayPalPayments";

// An access token you obtained yourself; depend on `@distilled.cloud/paypal`
// at exactly this package's version of it to import `fromApiKey`.
const products = PayPalPayments.productsLayer.pipe(
  Layer.provide(
    fromApiKey({
      apiKey: Redacted.make("A21AA…"),
      apiBaseUrl: "https://api-m.sandbox.paypal.com",
    }),
  ),
  Layer.provide(FetchHttpClient.layer),
);
```

### Calls of your own

This package publishes no PayPal REST client of its own: `./PayPal` (`PayPalClient`, `PayPal.layer` / `layerFromEnv` / `make`, `PayPalRequest`) was removed once the capabilities ran on Distilled. For an endpoint the capabilities do not cover, call `@distilled.cloud/paypal`'s operations directly, with an access token you obtained yourself (this package's OAuth login is internal to `layer` / `layerFromEnv`). Depend on `@distilled.cloud/paypal` at exactly this package's version of it (`1.0.0-rc.15` today; check this package's `dependencies` after an upgrade):

```typescript
import { Effect, Layer, Redacted } from "effect";
import { FetchHttpClient } from "effect/http";
import { fromApiKey, SANDBOX_API_BASE_URL } from "@distilled.cloud/paypal/Credentials";
import { getOrder } from "@distilled.cloud/paypal/checkout_orders_v2";

const order = getOrder({ id: "5O190127TN364715T" }).pipe(
  Effect.provide(
    Layer.merge(
      fromApiKey({ apiKey: Redacted.make("A21AA…"), apiBaseUrl: SANDBOX_API_BASE_URL }),
      FetchHttpClient.layer,
    ),
  ),
);
```

Distilled's own request policy then applies, not this package's: its failures are Distilled's error classes, not `PaymentsError`; it retries 5xx and 429 responses by default; and a write is deduplicated only by the `payPalRequestId` you pass.

Distilled's input types (`@distilled.cloud/paypal` `1.0.0-rc.15`) declare optional members as bare `?: T`. Under `exactOptionalPropertyTypes`, a call that forwards an optional of its own (`createProduct({ name, type: "SERVICE", description })` with `description: string | undefined`) fails to type-check: omit an absent member rather than pass `undefined`. The capability layers are unaffected; their params take `?: T | undefined`.

### Runtime: a `process` global

The capability layers need a `process` global with an `env` object. Distilled reads `process.env.DISTILLED_DEBUG_HTTP`, unguarded, each time it builds a request and each time it reads a response, so where there is no `process` global every capability call dies with a defect, not a `PaymentsError`. Node, Bun and Deno have one; on **Cloudflare Workers, enable the `nodejs_compat` compatibility flag**. Loading the package, building the layers and the OAuth login do not touch `process`. While `DISTILLED_DEBUG_HTTP` is set, Distilled writes each request's method and path template (`POST /v2/checkout/orders/{id}/capture`) and each response's status to `console.error`; it logs no header, body or id.

## Supported capabilities

PayPal's billing suite and checkout APIs map onto a subset of the core capabilities — a different subset from Airwallex, which makes it a good test of the abstraction:

| Capability | Maps to | Notes |
| --- | --- | --- |
| `Products` | Catalog Products | created as a `SERVICE` in the `SOFTWARE` category; `update` replaces only the `description` (one without a `description`, or one that sets `name`, fails); a product is always active and keeps no metadata, so `active: false` or a non-empty `metadata` fails on `create` and `update`; no `del` |
| `Prices` | Billing Plans | recurring only (a one-time price fails); every plan is named `"Plan"` (the neutral price has no name); `active: false` on `create` makes the plan in PayPal's not-yet-active `CREATED` state; a non-empty `metadata` fails on `create` and `update`; `update` toggles `active` via activate/deactivate, and any other update fails |
| `PaymentIntents` | Orders | `intent: "CAPTURE"`, `customer` sent as the purchase unit's `custom_id`; `confirm` = capture; no `update` / `cancel` / `list` |
| `Subscriptions` | Subscriptions | the first item's `price` is the plan id (and its `quantity` the quantity), `customer` sent as `custom_id`; no `update` / `list` |
| `Refunds` | Capture refunds | refund a `charge` (capture id) or a captured `paymentIntent`; no `update` / `list` |
| `Customers` | — | **not provided** (PayPal has no first-class customer resource) |
| `CheckoutSessions` / `BillingPortalSessions` | — | not in `capabilities`; `checkoutSessionsLayer` / `billingPortalSessionsLayer` stubs fail every call with `PaymentInvalidRequestError` |

Because each capability is an independent Effect service, a program that only uses the supported capabilities is fully satisfied; one that needs `Customers` will not type-check against the PayPal layer. Individual operations without a PayPal equivalent fail with a neutral `PaymentInvalidRequestError`.

**Lists page by page number.** `Product.list` and `Price.list` send `limit` as `page_size` (and `Price.list`'s `product` as a filter). `hasMore` reports whether PayPal links a next page, and `nextCursor` then encodes that page's number and the `limit`. Pass it back as `startingAfter`, with the same `limit`, to list that page. An item id, or a cursor made for another `limit`, fails with `PaymentInvalidRequestError` (`param: "startingAfter"`), and so does the `active` filter, which PayPal cannot apply. Pages are numbered, so an item created or removed between two calls can shift a later page by one.

## Errors

Every capability call fails with the core's `PaymentsError` and nothing else. PayPal error responses map by status:

| PayPal answer | Neutral error |
| --- | --- |
| 401, 403 | `PaymentAuthenticationError` (and a 401 forgets the cached token, so the next call logs in again) |
| 429 | `PaymentRateLimitError`, with `retryAfter` from a `Retry-After` header given in whole seconds |
| 400, 404, 422 | `PaymentInvalidRequestError` (`param` from the first of the body's `details[].field`) |
| any other non-2xx | `PaymentProviderError` (`provider: "paypal"`, `code` from the body's `name`) |
| a 2xx that does not decode | `PaymentProviderError` |
| a connection failure or timeout | `PaymentNetworkError` |

The message is PayPal's own `message` when it sends one. A failed login maps the same way. Building a layer fails only with `PaymentConfigError`.

## Notes

- **Money** — the core uses minor units (e.g. cents); PayPal uses major-unit decimal _strings_ (e.g. `"10.00"`). This provider converts in both directions with integer arithmetic, using PayPal's own currency table (`HUF`, `JPY` and `TWD` take no decimals; `KWD`, `TND` and the other ISO 4217 three-decimal currencies take three). A response amount with more decimals than its currency allows, or beyond the safe-integer range in minor units, fails with `PaymentProviderError` instead of being rounded; a request amount that is negative or not a safe integer fails with `PaymentInvalidRequestError` before anything is sent.
- **On Distilled** — each capability call is one of Distilled's generated operations (`createOrder`, `getPlan`, …), sent with the access token of this package's OAuth client-credentials login (cached, refreshed a minute before it expires, forgotten after a 401). Around every call the layers apply this package's request policy: `Content-Type` and `Accept: application/json` on every request (PayPal refuses a bodyless `POST` without a content type), no retries (Distilled's are switched off), a per-request timeout, and every failure (an HTTP status, a connection failure, a Distilled error) mapped onto the neutral errors from the response's status and PayPal's error body. The layers keep Distilled's response validation lenient even under its `ResponseValidation.strict`: its schemas mark nested members required (a billing cycle's `sequence`, a link's `href`, …) that the layers never read, and the layers decode the fields they map instead.
- **Timeouts** — the token login fails with `PaymentNetworkError` after `loginTimeout` ms (default 30 000) and any other request after `timeout` ms (default 80 000, as in the Stripe client). Only one login is in flight at a time, so without a bound one hung login would stall every request; after a timeout the next caller logs in afresh. `layerFromEnv` uses the defaults; pass `loginTimeout` / `timeout` to `layer` to change them (`Infinity` disables one; `0`, a negative number or `NaN` fails with `PaymentConfigError`). Two things to know:
  - `timeout` covers the resource request only, not getting a token. Callers that arrive while a login is in flight share its outcome: they get its token, or they all fail with its error after about one `loginTimeout`. The next call after a failure starts a fresh login.
  - A **non-GET that times out has an unknown outcome**: the vendor may have applied the write. Don't blindly retry a create, capture or refund without a key: the neutral `idempotencyKey` (below) is what lets the vendor recognise the repeat.
- **Neutral `idempotencyKey`** — `PaymentIntent.create` / `confirm` (capture), `Product.create`, `Price.create`, `Subscription.create` and `Refund.create` accept the core's `idempotencyKey` and send it as `PayPal-Request-Id` (see "Retrying a write safely" in the core package's README). With no key none is sent. `PaymentIntent.cancel`, `Subscription.cancel` and the plan activate / deactivate calls take none.
- **`PayPal-Request-Id` limits** — create one `idempotencyKey` per logical write, before the first attempt, and pass the same one on every retry; PayPal then returns the original outcome. The header is `POST` only, and not every PayPal endpoint honours it (PayPal's specifications declare none on plan activate / deactivate or subscription cancel), which is why those calls take no key. PayPal sets the length limit and how long it keeps the id per API, as its published OpenAPI specifications state them (pinned at commit `90e8041`):

  | Endpoints this provider sends an id to | Length | Kept for | Source |
  | --- | --- | --- | --- |
  | `POST /v2/checkout/orders`, `/v2/checkout/orders/{id}/capture` | 1 to 108 characters | 6 hours (up to 72 on request to PayPal) | [`checkout_orders_v2.json`](https://raw.githubusercontent.com/paypal/paypal-rest-api-specifications/90e8041ffe02d80c452d2b476bedd59a8d219bdc/openapi/checkout_orders_v2.json) |
  | `POST /v1/catalogs/products` | not stated | 72 hours | [`catalogs_products_v1.json`](https://raw.githubusercontent.com/paypal/paypal-rest-api-specifications/90e8041ffe02d80c452d2b476bedd59a8d219bdc/openapi/catalogs_products_v1.json) |
  | `POST /v1/billing/plans`, `/v1/billing/subscriptions` | not stated | 72 hours | [`billing_subscriptions_v1.json`](https://raw.githubusercontent.com/paypal/paypal-rest-api-specifications/90e8041ffe02d80c452d2b476bedd59a8d219bdc/openapi/billing_subscriptions_v1.json) |
  | `POST /v2/payments/captures/{id}/refund` | 1 to 10 000 characters | not stated | [`payments_payment_v2.json`](https://raw.githubusercontent.com/paypal/paypal-rest-api-specifications/90e8041ffe02d80c452d2b476bedd59a8d219bdc/openapi/payments_payment_v2.json) |

  So an order create or capture is deduplicated only within 6 hours by default. The core's 1 to 64 characters of `[A-Za-z0-9_-]` fit the Orders (1 to 108) and Payments (refunds, 1 to 10 000) limits; no limit is stated for Catalog Products and Subscriptions. The specifications do not say what PayPal answers when an id is reused with a different body.

- **Environment** — `PAYPAL_ENV` is **required** by `layerFromEnv` and must be `live` or `sandbox`; a missing, empty or misspelt value fails with `PaymentConfigError`, so a deployment never reaches the live endpoint by default. `live` selects `https://api-m.paypal.com`, `sandbox` selects `https://api-m.sandbox.paypal.com`. `PAYPAL_BASE_URL`, when set, overrides the endpoint `PAYPAL_ENV` selects (a proxy or a mock server); `PAYPAL_ENV` is still required. With `layer`, pass `environment: "live" | "sandbox"` (it defaults to `live` there) and optionally `baseUrl`, which wins.
- **Empty variables** — `layerFromEnv` reads `PAYPAL_CLIENT_ID`, `PAYPAL_CLIENT_SECRET`, `PAYPAL_ENV` and the optional `PAYPAL_BASE_URL` through `Config`. Effect treats a literal empty string as a missing value, so an empty id, secret or `PAYPAL_ENV` fails with `PaymentConfigError`, and an empty `PAYPAL_BASE_URL` means the `PAYPAL_ENV` endpoint, not a blank URL. `layer` refuses a `baseUrl` that is blank or not an absolute http(s) URL with `PaymentConfigError`.
- **Secrets** — `clientSecret` is a `Redacted<string>` (`Redacted.make(...)`; `layerFromEnv` reads it with `Config.Redacted`), so the client secret never reaches a log line or an error.
- **Decoded responses** — every PayPal response the capabilities read is decoded with a `Schema` at the boundary; a response that does not match fails with `PaymentProviderError` instead of producing a half-built entity.
- **Ids** — a path id (`Product.retrieve(id)`, `Subscription.cancel(id)`, …) that is not a non-empty string fails with `PaymentInvalidRequestError` (`param: "id"`) before anything is sent, and so does `Subscription.create` without an item (`param: "items"`).

## API

| Module | Purpose |
| --- | --- |
| `PayPalPayments` | `layer` / `layerFromEnv` (the OAuth login + every supported capability; need an `HttpClient`), `capabilities` and the individual capability layers (over Distilled's `Credentials` and an `HttpClient`), the `checkoutSessionsLayer` / `billingPortalSessionsLayer` stubs, and the `PayPalConfig` / `PayPalEnvironment` types `layer` takes. |

The root entry re-exports it as a namespace, the core as `Payments`, and the `PayPalConfig` / `PayPalEnvironment` types.

## License

MIT © Thomas Foster
