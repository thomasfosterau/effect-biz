# API versions

The `Stripe-Version` every request pins, and how to override it.

Every request, from a capability layer or a resource module, pins `Stripe-Version` to `DISTILLED_API_VERSION` (exported by `StripePayments` and `StripeHttp`), **`2026-09-30.endive`**: the version `@distilled.cloud/stripe` `1.0.0-rc.18`'s schemas are generated from. It follows Distilled, so a release of this package that moves the Distilled pin moves it too, and its changelog says so. An explicit `apiVersion` passed to `layer` or `layerConfig` wins, and a resource-module call can override both (`RequestOptions.apiVersion`).

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
