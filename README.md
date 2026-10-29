# effect-biz

**Disclaimer:** This is an experiment. Don't use it in production.

Modular ERP and business-process services for [Effect](https://effect.website), built to be embedded in other applications: parties, the product catalogue, sales, purchasing, inventory, manufacturing, CRM, HR, projects and payroll, plus the money side (payments today; the ledger, invoices, AR/AP and tax as the roadmap lands them), each as a package of Effect services you compose with the layers you choose.

Payments are vendor-neutral: write a program against the core's payment capabilities and choose Stripe, PayPal or Airwallex by the layer you provide. (These packages began in the effect-finance repository, which this one has absorbed.)

| Package | Purpose |
| --- | --- |
| [`@thomasfosterau/effect-biz`](packages/core) | The foundation: identifiers, tenancy context, error channel, domain events and repository conventions; and, under `./Payments`, the vendor-neutral payments core (capability services, neutral entities, `Money`, `Page`, `IdempotencyKey`, `Stub` and the `PaymentsError` channel). Peer: `effect`. |
| [`@thomasfosterau/effect-biz-payments-stripe`](packages/payments-stripe) | Every payment capability over Distilled's Stripe operations (`@distilled.cloud/stripe`), plus the raw Stripe resource modules (thin wrappers of every Distilled operation on each resource) and the WebCrypto webhook verifier. Peer: `effect`; optional peer: `stripe`. |
| [`@thomasfosterau/effect-biz-payments-paypal`](packages/payments-paypal) | `Products`, `Prices`, `PaymentIntents`, `Subscriptions`, `Refunds` over Distilled's PayPal operations (`@distilled.cloud/paypal`), with the package's own OAuth login. Peer: `effect`. |
| [`@thomasfosterau/effect-biz-payments-airwallex`](packages/payments-airwallex) | `Customers`, `PaymentIntents`, `Refunds` over Airwallex. Peer: `effect`. |

More packages arrive as the roadmap's slices land; see the issue tracker.

## Design

- **Ports and adapters.** Each module defines its repositories as Effect services, with an in-memory layer for tests and an `@effect/sql` layer (Postgres, SQLite) for production. Bring your own if you need to.
- **Multi-tenant, multi-company.** Every call runs under a tenant context; a tenant holds one or more companies.
- **Event-driven integration.** Modules publish typed domain events through a transactional outbox; cross-module flows subscribe to them, and long-running ones run as durable `effect/workflow`s.
- **Mountable APIs.** Each module ships an optional `effect/http-api` group and an `effect/rpc` group.
- **Localisable.** The core is jurisdiction-neutral; Australian localisation comes first.

## Install

```sh
pnpm add effect @thomasfosterau/effect-biz
```

`effect` is a peer: your application owns the single copy. For payments, add the provider you use too (`@thomasfosterau/effect-biz-payments-stripe`, say).

## Example

```typescript
import { Effect, Layer, Redacted } from "effect";
import { FetchHttpClient } from "effect/http";
import * as Customer from "@thomasfosterau/effect-biz/Payments.Customer";
import * as StripePayments from "@thomasfosterau/effect-biz-payments-stripe/StripePayments";

const program = Customer.create({ email: "jane@example.com" }); // needs only `Customers`

const layer = StripePayments.layer({ apiKey: Redacted.make("sk_test_...") }).pipe(
  Layer.provide(FetchHttpClient.layer),
);

// Calls Stripe when invoked: `const customer = await createCustomer();`
const createCustomer = () => Effect.runPromise(program.pipe(Effect.provide(layer)));
```

Each package's README is its API reference. Runnable payments examples are in [`packages/payments-stripe/examples`](packages/payments-stripe/examples).

## Development

See [CONTRIBUTING.md](CONTRIBUTING.md); conventions for agents are in [AGENTS.md](AGENTS.md). Releases go through Changesets ([PUBLISHING.md](PUBLISHING.md)); report vulnerabilities as [SECURITY.md](SECURITY.md) describes.

## License

MIT © Thomas Foster
