# Configuration

Building the Stripe layers: `StripePayments.layer`, its configuration and the request policy every call runs under.

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

`layerFromEnv(envVar?)` reads only the key, from `STRIPE_API_KEY` by default, while the layer is built, and keeps every other default. `layerConfig(options?)` takes the same fields as `StripeHttpConfig` minus `apiKey`, plus `envVar` (default `STRIPE_API_KEY`), and reads the key at call time (["Not configured ≡ down"](not-configured.md)).

Each capability call is one of Distilled's generated operations (`CreateCustomer`, `GetSubscription`, …), which form-encode the request with Stripe's bracketed nesting and send the key as a bearer token. Around every call the layers apply this package's request policy: `Stripe-Version` pinned to `DISTILLED_API_VERSION` (`2026-09-30.endive`) unless configured, since Distilled sends none of its own and the account's dashboard default would otherwise decide the wire shape; the SDK's retry policy (connection failures, `409`, `5xx`, `Stripe-Should-Retry`, `Retry-After`) with one `Idempotency-Key` across the attempts of a `POST` (and of a `/v2` `DELETE`), in place of Distilled's own; a per-attempt timeout; redirects refused; and every failure (Distilled's `CardError`, `InvalidRequestError`, …, an HTTP status error or a connection failure) mapped onto the neutral errors, from the response's status and Stripe's error envelope. Responses are decoded with `Schema` over the fields the layers read; a malformed one fails with `PaymentProviderError`. The layers keep Distilled's response validation lenient even under its `ResponseValidation.strict`, so a response is never refused over a field they do not read (Distilled's schemas mark fields required that a response at an older configured `apiVersion` lacks).
