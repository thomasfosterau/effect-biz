# effect-biz

Modular ERP and business-process services for [Effect](https://effect.website), built to be embedded in other applications: parties, the catalogue, sales, purchasing, inventory and payroll, plus the money side (vendor-neutral payments today; the ledger and invoicing to come), each as Effect services and layers.

> [!WARNING]
> This is an experiment and is **not production-ready**: don't use it to handle real money or real business records. It is pre-1.0, largely written with Claude Code, and its API may change at any time.

## Install

```sh
pnpm add effect @thomasfosterau/effect-biz
```

`effect` is a peer. For payments, add a provider too (`@thomasfosterau/effect-biz-payments-stripe`).

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

## Packages

| Package | What it is |
| --- | --- |
| [`@thomasfosterau/effect-biz`](packages/core) | The foundation (ids, tenancy, errors, events and outbox, repositories, exact money), the vendor-neutral payments core (`./Payments*`) and authorisation through effect-auth (`./Authorization`) |
| [`@thomasfosterau/effect-biz-payments-stripe`](packages/payments-stripe) | The Stripe payments provider, plus generated Stripe resource modules |
| [`@thomasfosterau/effect-biz-sql`](packages/sql) | The `effect/sql` foundation for repository layers (Postgres, D1, SQLite). Not published yet |

## Docs

Guides are in [`docs/`](docs) (one directory per package) and each export's doc comment; the design is in [docs/architecture.md](docs/architecture.md). See [docs/CONTRIBUTING.md](docs/CONTRIBUTING.md) to contribute, [docs/PUBLISHING.md](docs/PUBLISHING.md) for releases and [docs/SECURITY.md](docs/SECURITY.md) to report a vulnerability.

## License

[MIT](LICENSE.md)
