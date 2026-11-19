# @thomasfosterau/effect-biz-payments-stripe

Stripe: the neutral payments capabilities as `Layer`s (`StripePayments`) over Distilled's generated operations (`@distilled.cloud/stripe`), plus one generated resource module per Stripe API resource as an escape hatch, all run through one client (`StripeHttp`). The `effect` peer is `^4.0.5` (`catalogs.distilled-peers`, Distilled's own floor); `stripe` is an optional peer, for the types of the SDK-based `Webhook.constructEvent*` only.

## Boundary

Imports only core's `./Payments*` subpaths from this workspace. Distilled is imported only by `StripePayments.ts`, `StripeHttp.ts` and the resource modules, through its subpaths. The declarations of `StripePayments`, `StripeHttp` and `Webhook` name only `@distilled.cloud/stripe/Credentials`, since the operations' declaration is 7.5 MB; `tests/dist-consumer` checks this.

## Invariants

- **"Not configured ≡ down."** `layerConfig` never fails to build: it reads the key (`STRIPE_API_KEY`) on every call and, when it is absent or empty, fails with `PaymentsUnavailable` before sending anything. `layer` / `layerFromEnv` fail the build with `PaymentConfigError`.
- **Stripe failures become neutral errors in one place**: `toPaymentsError` (`internal/error.ts`), fed by `classifyResponse`. Distilled's errors carry neither the status nor the vendor error, so the client watches each response through the `HttpClient` it hands Distilled. No module throws or leaks a Distilled error class.
- **`Stripe-Version` follows Distilled.** `DISTILLED_API_VERSION` (`internal/apiVersion.ts`) is the API version the pinned Distilled release is generated from, sent on every request, and moves with every Distilled bump together with the `stripe` dev pin, the endive fixtures and a regeneration; `tests/distilledApiVersion.test.ts` fails until they agree. Distilled's `ResponseValidation` is lenient, so the capability layers decode the fields they map (`internal/mapping.ts`); its retries are off and the client applies the SDK's policy, a per-attempt timeout and redirect refusal.
- **Tree-shakeable.** Top-level layers and wire schemas are `/* @__PURE__ */` calls over namespace imports by subpath, so a bundle keeps only the capabilities it uses.
- **Nothing loads `stripe` at runtime**: only `Webhook.ts` imports it, as a type. `tests/sdkOptional.test.ts` and the dist-consumer check walk the import graphs.
- **Every call needs a `process` global** (`nodejs_compat` on Workers): Distilled reads `process.env.DISTILLED_DEBUG_HTTP` unguarded.
- **The key never reaches an error or a log line.** It is `Redacted` until the header is set; a transport failure's `cause` is the underlying error, never the request (whose headers carry the key).
- **Inputs bound for Distilled go through `omitUndefined`**, since its types declare bare `?: T`.
- **Never hand-edit a resource module.** `src/<Resource>.ts` is written by `generate:resources` from the installed Distilled and `scripts/resources.ts` (placement, names, and the `UNEXPOSED` operations the client cannot run); `tests/resources.test.ts` fails on any drift. A new resource gets a `RESOURCES` entry, an `exports` entry, a barrel line, a line in `docs/payments-stripe/resource-modules.md`, and a regeneration.

## Terms

- **Client** — `StripeHttp`: `call(method, operation, input, options?)` runs one Distilled operation under the request policy and resolves to the unchecked JSON. It moves a `DELETE`'s params to the query string, applies stripe-node's `/v2` encoding, sends uploads to `files.stripe.com`, and generates one `Idempotency-Key` across a retried `POST`.
- **Resource module** — `Customer.ts`, `Treasury.FinancialAccount.ts`, …: one export per operation (path ids, then `params`, then `options?: RequestOptions`), results unvalidated and typed as Distilled's output.
- **Capability layers** — `StripePayments.customersLayer` … `billingPortalSessionsLayer`, `capabilities`, and `layer` / `layerFromEnv` / `layerConfig`: map neutral params onto Distilled's input and decode each response, so a malformed 2xx is a `PaymentProviderError`.
- **Webhook** — `Webhook.verify`: WebCrypto HMAC-SHA256, constant-time compare, a tolerance window from `Clock`, then a lenient decode. The signing secret never reaches a `SignatureVerificationError`.
