# @thomasfosterau/effect-biz-payments-stripe

**Disclaimer:** This is an experiment. Don't use it in production.

A Stripe implementation of effect-biz's vendor-neutral payments core. It provides `Layer`s that satisfy the neutral capabilities of [`@thomasfosterau/effect-biz/Payments`](https://www.npmjs.com/package/@thomasfosterau/effect-biz) over [Distilled's Stripe operations](https://www.npmjs.com/package/@distilled.cloud/stripe) on `effect/http` (no SDK), one resource module per Stripe API resource as a provider escape hatch, and a WebCrypto webhook verifier.

## Install

```bash
pnpm add @thomasfosterau/effect-biz @thomasfosterau/effect-biz-payments-stripe effect
```

`effect` is a peer (`^4.0.5`). See [Install](https://github.com/thomasfosterau/effect-biz/blob/trunk/docs/payments-stripe/install.md) for the peer and dependency ranges, including the optional `stripe` peer.

## Example

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

## Entry points

Guides are in [`docs/payments-stripe`](https://github.com/thomasfosterau/effect-biz/tree/trunk/docs/payments-stripe).

| Subpath | Purpose | Guide |
| --- | --- | --- |
| `./StripePayments` | Every neutral capability as a `Layer`, from configuration. | [Configuration](https://github.com/thomasfosterau/effect-biz/blob/trunk/docs/payments-stripe/configuration.md), [errors](https://github.com/thomasfosterau/effect-biz/blob/trunk/docs/payments-stripe/errors.md), [API versions](https://github.com/thomasfosterau/effect-biz/blob/trunk/docs/payments-stripe/api-versions.md), [runtime](https://github.com/thomasfosterau/effect-biz/blob/trunk/docs/payments-stripe/runtime.md), [not configured](https://github.com/thomasfosterau/effect-biz/blob/trunk/docs/payments-stripe/not-configured.md) |
| `./StripeHttp` | The client the resource modules run on. | [Configuration](https://github.com/thomasfosterau/effect-biz/blob/trunk/docs/payments-stripe/configuration.md) |
| `./Webhook` | Webhook signature verification and event decoding. | [Webhooks](https://github.com/thomasfosterau/effect-biz/blob/trunk/docs/payments-stripe/webhooks.md) |
| `./Customer`, `./Invoice`, `./Treasury`, … | Raw modules, one per Stripe resource (131). | [Resource modules](https://github.com/thomasfosterau/effect-biz/blob/trunk/docs/payments-stripe/resource-modules.md) |
| `.` | The root barrel. | [API](https://github.com/thomasfosterau/effect-biz/blob/trunk/docs/payments-stripe/api.md) |

## Links

- [Runnable examples](https://github.com/thomasfosterau/effect-biz/tree/trunk/packages/payments-stripe/examples)
- [Core package](https://www.npmjs.com/package/@thomasfosterau/effect-biz) and its [payments guides](https://github.com/thomasfosterau/effect-biz/blob/trunk/docs/core/payments.md)
- [Repository and issues](https://github.com/thomasfosterau/effect-biz)

## License

MIT © Thomas Foster
