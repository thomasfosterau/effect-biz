# @thomasfosterau/effect-biz-payments-airwallex

An Airwallex implementation of effect-biz's vendor-neutral payments core.

It implements the capabilities Airwallex supports from [`@thomasfosterau/effect-biz/Payments`](https://www.npmjs.com/package/@thomasfosterau/effect-biz) over Airwallex's REST API, through `effect/http` with no vendor SDK.

The same neutral program runs on Airwallex, Stripe or PayPal — only the layer you provide changes.

## Install

```bash
pnpm add @thomasfosterau/effect-biz @thomasfosterau/effect-biz-payments-airwallex effect
```

`effect` is a peer dependency (`^4.0.0`). The core (`@thomasfosterau/effect-biz`) is a dependency of this package; install it yourself too, since your program imports its capability modules. No vendor SDK, and nothing reads `process`: the layers need only an `HttpClient` (`effect/http`), so they run on Node, Bun, Deno and Workers alike.

## Usage

```typescript
import { Effect, Layer, Redacted } from "effect";
import { FetchHttpClient } from "effect/http";
import * as Customer from "@thomasfosterau/effect-biz/Payments.Customer";
import * as AirwallexPayments from "@thomasfosterau/effect-biz-payments-airwallex/AirwallexPayments";

const program = Customer.create({ email: "jane@example.com" });

// The Airwallex layer speaks `effect/http`: it requires an
// `HttpClient`, which `FetchHttpClient.layer` supplies on any fetch runtime.
const layer = AirwallexPayments.layer({
  clientId: process.env.AIRWALLEX_CLIENT_ID!,
  apiKey: Redacted.make(process.env.AIRWALLEX_API_KEY!),
  environment: "sandbox", // or "live" (the default)
}).pipe(Layer.provide(FetchHttpClient.layer));
// from AIRWALLEX_CLIENT_ID / AIRWALLEX_API_KEY / AIRWALLEX_ENV (required: live | sandbox):
// const layer = AirwallexPayments.layerFromEnv().pipe(Layer.provide(FetchHttpClient.layer));

// Calls Airwallex when invoked: `const customer = await createCustomer();`
const createCustomer = () => Effect.runPromise(program.pipe(Effect.provide(layer)));
```

### Configuration

`AirwallexPayments.layer` (and `Airwallex.layer` / `make`) takes an `AirwallexConfig`:

| Field | Required | Meaning |
| --- | --- | --- |
| `clientId` | yes | The API client id. |
| `apiKey` | yes | The API key, a `Redacted<string>`. |
| `environment` | no | `"live"` (default) or `"sandbox"`; selects the endpoint. |
| `baseUrl` | no | An absolute http(s) URL that overrides the environment's endpoint (a proxy, a mock server). |
| `loginTimeout` | no | Milliseconds the token login may take (default 30 000). |
| `timeout` | no | Milliseconds a resource request may take (default 80 000). |

An empty `clientId` or `apiKey`, a bad `baseUrl` or a bad timeout fails the layer build with `PaymentConfigError`.

`layerFromEnv(clientIdVar?, apiKeyVar?)` reads the same configuration through `Config` (the current `ConfigProvider`, by default the process environment):

| Variable | Required | Maps to |
| --- | --- | --- |
| `AIRWALLEX_CLIENT_ID` (or `clientIdVar`) | yes | `clientId` |
| `AIRWALLEX_API_KEY` (or `apiKeyVar`) | yes | `apiKey` (read with `Config.Redacted`) |
| `AIRWALLEX_ENV` | yes: `live` or `sandbox` | `environment` |
| `AIRWALLEX_BASE_URL` | no | `baseUrl` |

The timeouts keep their defaults there. Every problem (a missing, empty or misspelt variable) fails the layer build with `PaymentConfigError` (the Environment and Empty variables notes below).

## Supported capabilities

Airwallex's payment-acceptance API maps onto a subset of the core capabilities:

| Capability | Status |
| --- | --- |
| `Customers` | ✅ (no `del` — Airwallex has no delete-customer endpoint; `name` is sent as `first_name`; a `create` or `update` that sets `description` fails with `PaymentInvalidRequestError`, since this provider maps no Airwallex field to it) |
| `PaymentIntents` | ✅ (no `update` — confirm/cancel instead; `confirm`'s `paymentMethod` becomes `payment_method.id`) |
| `Refunds` | ✅ (no `update`; a refund needs a `paymentIntent`, and one with only a `charge` fails; a partial `amount` first reads the payment intent for its currency) |
| `Products` / `Prices` / `Subscriptions` | ❌ not provided |
| `CheckoutSessions` / `BillingPortalSessions` | ❌ not in `capabilities`; `checkoutSessionsLayer` / `billingPortalSessionsLayer` stubs fail every call with `PaymentInvalidRequestError` |

Because each capability is an independent Effect service, this provider simply doesn't supply layers for the capabilities Airwallex lacks. A program that only uses the supported capabilities is fully satisfied; one that needs, say, `Subscriptions` will not type-check against the Airwallex layer alone. The few individual operations without an Airwallex equivalent fail with a neutral `PaymentInvalidRequestError` rather than pretending to succeed.

**Lists page by page number.** `list` sends `limit` as `page_size`, plus `PaymentIntent.list`'s `customer` and `Refund.list`'s `paymentIntent` as filters. `hasMore` reports whether Airwallex has more, and `nextCursor` then encodes the next `page_num` and the `limit`. Pass it back as `startingAfter`, with the same `limit` and filters, to list that page. An item id, or a cursor made for another `limit`, fails with `PaymentInvalidRequestError` (`param: "startingAfter"`). So do `Customer.list`'s `email` filter and `Refund.list`'s `charge` filter, which this provider cannot apply. Pages are numbered, so an item created or removed between two calls can shift a later page by one.

## Errors

Every capability call fails with the core's `PaymentsError` and nothing else. Airwallex error responses map by status:

| Airwallex answer | Neutral error |
| --- | --- |
| 401, 403 | `PaymentAuthenticationError` (and a 401 forgets the cached token, so the next call logs in again) |
| 429 | `PaymentRateLimitError`, with `retryAfter` from a `Retry-After` header given in whole seconds |
| 400, 404, 422 | `PaymentInvalidRequestError` (`param` from the body's `source`) |
| any other non-2xx | `PaymentProviderError` (`provider: "airwallex"`, `code` from the body's `code`) |
| a 2xx that does not decode | `PaymentProviderError` |
| a connection failure or timeout | `PaymentNetworkError` |

The message is Airwallex's own `message` when it sends one. A failed login maps the same way. Building a layer fails only with `PaymentConfigError`.

## Calls of your own

`AirwallexClient.request` is the client every capability goes through, and the escape hatch for an Airwallex endpoint the capabilities do not cover: it logs in, sends the bearer token, applies the timeout and maps failures onto `PaymentsError`, and resolves to the response's JSON body as `unknown` (decode it yourself).

```typescript
import { Effect, Layer } from "effect";
import { FetchHttpClient } from "effect/http";
import * as Airwallex from "@thomasfosterau/effect-biz-payments-airwallex/Airwallex";

// Effect<unknown, PaymentsError, AirwallexClient>
const balances = Effect.flatMap(Airwallex.AirwallexClient, (client) =>
  client.request({ method: "GET", path: "/api/v1/balances/current" }),
);

const client = Airwallex.layerFromEnv().pipe(Layer.provide(FetchHttpClient.layer));
const run = () => Effect.runPromise(balances.pipe(Effect.provide(client)));
```

`AirwallexPayments.capabilities` builds the capabilities over an `AirwallexClient` you provide, so a program can share one client (and one cached token) between the capabilities and its own calls: `AirwallexPayments.capabilities.pipe(Layer.provideMerge(Airwallex.layerFromEnv()), Layer.provide(FetchHttpClient.layer))`. In a test, provide a fake `AirwallexClient` (`Layer.succeed(Airwallex.AirwallexClient, { request })`) instead.

## Notes

- **Money** — the core uses minor units (e.g. cents); Airwallex uses major-unit decimals sent as JSON numbers (e.g. `20.5`). This provider scales in both directions with integer arithmetic, based on each currency's number of decimal places. `JSON.parse` has already rounded a response amount to a double, so the amount is read from that double's shortest decimal form (exponent notation included). It fails with `PaymentProviderError` instead of being rounded when it has more decimals than its currency allows, when it is beyond the safe-integer range in minor units, or when the double is ambiguous: a different amount, or one with excess decimals, parses to the same double. The guarantee is: **an accepted amount is the wire value rounded to the nearest minor unit, and exact when the wire text has at most `exponent` decimals.** Excess decimals are not always caught: `10721136062241.369` shares a double with `10721136062241.37` and is accepted as `.37`. Amounts are rejected as ambiguous from about 2^45 major units (about 35 trillion) for two-decimal currencies (e.g. `35184372088832.01` USD), 2^42 for three-decimal ones, and 2^52 for zero-decimal ones (even integers only). A request amount is held to the same rule: one that is negative or not a safe integer, or whose JSON number the parser would refuse to read back (the thresholds above, or more significant digits than a double keeps), fails with `PaymentInvalidRequestError` before anything is sent, so Airwallex is never asked to create something whose response cannot be decoded. The currency table (zero-decimal `JPY`, `KRW`, `ISK` and others; three-decimal `KWD`, `BHD` and others) was reviewed against summaries of Airwallex's currency pages, not the live pages (effect-finance#74). `HUF`, `IDR` and `TWD` keep two decimals (ISO 4217), although Airwallex's fee-rounding page lists them as zero-decimal; `IQD` and `LYD` keep three (ISO 4217).
- **`Airwallex`** — the client service performs the token handshake and caches the bearer token. Every request goes through `effect/http`'s `HttpClient`, which the layer requires — provide `FetchHttpClient.layer` in production, or a stub `HttpClient` (or a stub `FetchHttpClient.Fetch`) in tests.
- **Timeouts** — the token login fails with `PaymentNetworkError` after `loginTimeout` ms (default 30 000) and any other request after `timeout` ms (default 80 000, as in the Stripe client). Only one login is in flight at a time, so without a bound one hung login would stall every request on the client; after a timeout the next caller logs in afresh. `layerFromEnv` uses the defaults; pass `loginTimeout` / `timeout` to `layer` to change them (`Infinity` disables one; `0`, a negative number or `NaN` fails with `PaymentConfigError`). Two things to know:
  - `timeout` covers the resource request only, not getting a token. Callers that arrive while a login is in flight share its outcome: they get its token, or they all fail with its error after about one `loginTimeout`. The next call after a failure starts a fresh login.
  - A **non-GET that times out has an unknown outcome**: the vendor may have applied the write. Don't blindly retry a create, capture or refund without a key: the client's `requestId` (below) is what lets the vendor recognise the repeat.
- **Neutral `idempotencyKey`** — `Customer.create`, `PaymentIntent.create` / `confirm` and `Refund.create` accept the core's `idempotencyKey` and send it as the body's `request_id` (see "Retrying a write safely" in the core package's README). With no key the layer keeps its fresh per-call `request_id`, which deduplicates nothing across your retry. `PaymentIntent.cancel` and the updates take none.
- **`requestId`** — `AirwallexClient.request({ method: "POST", …, requestId })` writes `requestId` into the JSON body as `request_id`, replacing the fresh id the capability layers put there. Create one id per logical write, before the first attempt, and send the same one on every retry; Airwallex then returns the original result for the same parameters (and, unverified, rejects the id with different ones). An empty id, a non-`POST` request or a non-object body fails with `PaymentInvalidRequestError` before anything is sent. The vendor's length limit (about 64 characters) and how long it remembers an id are unverified ([effect-finance#93](https://github.com/thomasfosterau/effect-finance/issues/93)); stay within 1–64 characters of `[A-Za-z0-9_-]` and retry within hours, not days.
- **Environment** — `AIRWALLEX_ENV` is **required** by `layerFromEnv` and must be `live` or `sandbox`; a missing, empty or misspelt value fails with `PaymentConfigError`, so a deployment never reaches the live endpoint by default. `live` selects `https://api.airwallex.com`, `sandbox` selects `https://api.sandbox.airwallex.com`. `AIRWALLEX_BASE_URL`, when set, overrides the endpoint `AIRWALLEX_ENV` selects (a proxy or a mock server); `AIRWALLEX_ENV` is still required. With `layer` / `make`, pass `environment: "live" | "sandbox"` (it defaults to `live` there) and optionally `baseUrl`, which wins.
- **Empty variables** — `layerFromEnv` reads `AIRWALLEX_CLIENT_ID`, `AIRWALLEX_API_KEY`, `AIRWALLEX_ENV` and the optional `AIRWALLEX_BASE_URL` through `Config`. Effect treats a literal empty string as a missing value, so an empty id, key or `AIRWALLEX_ENV` fails with `PaymentConfigError`, and an empty `AIRWALLEX_BASE_URL` means the `AIRWALLEX_ENV` endpoint, not a blank URL. `make` refuses a `baseUrl` that is blank or not an absolute http(s) URL with `PaymentConfigError`.
- **Secrets** — `apiKey` is a `Redacted<string>` (`Redacted.make(...)`; `layerFromEnv` reads it with `Config.Redacted`), so the API key never reaches a log line or an error.
- **Decoded responses** — every Airwallex response the capabilities read is decoded with a `Schema` at the boundary; a response that does not match fails with `PaymentProviderError` instead of producing a half-built entity. `AirwallexClient.request` returns `unknown`.

## API

| Module | Purpose |
| --- | --- |
| `AirwallexPayments` | `layer` / `layerFromEnv` (client + every supported capability; need an `HttpClient`), `capabilities` (over an existing `AirwallexClient`), the individual capability layers (`customersLayer`, `paymentIntentsLayer`, `refundsLayer`), and the `checkoutSessionsLayer` / `billingPortalSessionsLayer` stubs. |
| `Airwallex` | The `AirwallexClient` service (token handshake, cached token, `request`), `layer` / `layerFromEnv` / `make`, and the `AirwallexConfig` / `AirwallexEnvironment` / `AirwallexRequest` types. |

The root entry re-exports both as namespaces, the core as `Payments`, and the `AirwallexConfig` / `AirwallexEnvironment` / `AirwallexRequest` types.

## License

MIT © Thomas Foster
