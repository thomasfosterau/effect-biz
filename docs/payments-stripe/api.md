# API

Every entry point of the package.

| Module | Purpose |
| --- | --- |
| `StripePayments` | `layer` / `layerFromEnv` / `layerConfig` (every capability, from configuration), `capabilities` (every capability over Distilled's `Credentials` and an `HttpClient`), the individual capability layers, and `DISTILLED_API_VERSION` (the `Stripe-Version` they pin). |
| `StripeHttp` | The client the resource modules run on: the `StripeHttp` service (`call`), `layer` / `layerFromEnv` / `layerConfig` / `layerFromContext` / `make`, the `StripeHttpConfig` / `LayerConfigOptions` / `RequestOptions` types and `DISTILLED_API_VERSION`. |
| `Webhook` | `verify` (and `verifySignature`, the check alone), `decodeEvent`, `decodeHandledEvent` with `handledEventTypes` / `HandledEvent` and the per-object decoders, `SIGNATURE_HEADER`, `DEFAULT_TOLERANCE`, `signatureHeader` (signs a test delivery); the SDK-based `constructEvent` / `constructEventAsync`, `generateTestHeaderString` / `generateTestHeaderStringAsync` and the `StripeService` they need. |
| `Customer`, `Invoice`, `CheckoutSession`, `BillingPortal.Session`, `Treasury`, `Billing.*`, `Tax.*`, `Issuing.*`, `Terminal.*`, `V2.Core.*`, … | Raw resource modules, one per Stripe API resource, 131 in all (listed under [The Stripe escape hatch](resource-modules.md)), generated from Distilled's operations. |

The root entry re-exports the core (`Payments`), `StripeHttp`, `StripePayments`, `Webhook` and the raw modules as namespaces (flattened: `BillingMeter`, `V2CoreAccount`, …; the ten `Treasury.*` modules under `Treasury`), plus the `StripeErrors` (= `PaymentsError`), `RequestOptions` and `StripeHttpConfig` types; it never loads the SDK. Its declarations reach Distilled's whole operations module, so import a subpath when you need only part of it.
