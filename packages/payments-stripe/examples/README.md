# Examples

These examples demonstrate `@thomasfosterau/effect-biz/Payments` (the vendor-neutral core) running on the `@thomasfosterau/effect-biz-payments-stripe` provider.

## Running Examples

1. Install dependencies and build the packages from the repository root (the examples import the packages by name, which resolves to their built `dist/`):

   ```bash
   pnpm install
   vp run -r build
   ```

2. Set your Stripe API key (`basic.ts` and `subscription.ts` call the Stripe test-mode API; `webhooks.ts` runs offline and needs no key):

   ```bash
   export STRIPE_API_KEY=sk_test_your_key_here
   ```

3. Run an example with Node (22.18 or later strips the TypeScript types natively):

   ```bash
   node packages/payments-stripe/examples/basic.ts
   ```

Each example exports its Effect program and runs it only when executed directly, so importing one has no side effects. The unit suite (`tests/examples.test.ts`) imports every example and runs its program over a stubbed `fetch` with canned Stripe responses, so an example whose behaviour drifts fails `vp run -r test:unit`; a new example needs a suite there too.

## Available Examples

### basic.ts

Vendor-neutral usage: the program imports only from `@thomasfosterau/effect-biz/Payments` and selects Stripe at the edge with `StripePayments.layer`. Covers creating a customer, creating a payment intent, and handling neutral errors.

### subscription.ts

Vendor-neutral subscription workflow: create a customer, a product, a recurring price, and a subscription — all through the neutral core.

### webhooks.ts

Stripe-specific: a web-standard `Request` → `Response` webhook endpoint on the default, Workers-safe WebCrypto `Webhook.verify`. It verifies the raw body bytes against the `Stripe-Signature` header (`Webhook.SIGNATURE_HEADER`), reads the signing secret as a `Redacted` through `Config` (`STRIPE_WEBHOOK_SECRET`), answers every `SignatureVerificationError` with a bare 400, and narrows verified events to the handled types with `Webhook.decodeHandledEvent`, acknowledging the rest. A handled event that fails to decode is logged with its id and type as log annotations and answered with a 500. Stripe retries a failed delivery for a limited period (see https://docs.stripe.com/webhooks), so a fix that ships after that needs the event resent from the Dashboard. Its demo signs test deliveries with `Webhook.signatureHeader` (a valid one, an unhandled type, a handled type that fails to decode, a tampered body, a missing header, the wrong secret, a stale timestamp), so it needs neither a Stripe API key nor the network, and the optional `stripe` peer is not used. The SDK-based `Webhook.constructEvent` / `constructEventAsync` remain as an alternative that needs `stripe` and an SDK client provided as `Webhook.StripeService`.

## Note

These examples use Stripe test mode. Use test keys (starting with `sk_test_`), not live keys.
