# @thomasfosterau/effect-biz

**Disclaimer:** This is an experiment. Don't use it in production.

The foundation of the effect-biz package family: the identifiers, error channel, tenancy context and exact numbers (decimals, rounding, quantities, rates, money) every effect-biz domain package builds on, and the vendor-neutral payments core (`@thomasfosterau/effect-biz/Payments`). More foundation modules (repositories, events) land as the roadmap does.

## Install

```sh
pnpm add effect @thomasfosterau/effect-biz
```

`effect` is a peer (`^4.0.0`): your application owns the single copy.

## Example

```ts
import { BigDecimal, Result } from "effect";
import * as Currency from "@thomasfosterau/effect-biz/Currency";
import * as Decimal from "@thomasfosterau/effect-biz/Decimal";
import * as Money from "@thomasfosterau/effect-biz/Money";

const total = Money.make(Decimal.make("100"), Currency.make("AUD"));

// Split exactly: the parts sum to the total.
const parts = Money.allocate(total, [Decimal.make("1"), Decimal.make("1"), Decimal.make("1")]);
console.log(Result.isSuccess(parts) && parts.success.map((part) => BigDecimal.format(part.amount))); // ["33.34", "33.33", "33.33"]
```

## Entry points

Each module is its own subpath. Guides are in [`docs/core`](https://github.com/thomasfosterau/effect-biz/tree/trunk/docs/core).

| Subpath | Purpose | Guide |
| --- | --- | --- |
| `./Id` | Branded UUIDv7 identifiers and the `IdGenerator` service. | [Identifiers and errors](https://github.com/thomasfosterau/effect-biz/blob/trunk/docs/core/ids-and-errors.md) |
| `./BizError` | The shared tagged errors, `isRetryable` and `httpStatus`. | [Identifiers and errors](https://github.com/thomasfosterau/effect-biz/blob/trunk/docs/core/ids-and-errors.md) |
| `./Tenancy` | The tenant and company a call acts for: `TenantContext`, `CompanyContext`, `withTenant`, `withCompany`. | [Tenancy](https://github.com/thomasfosterau/effect-biz/blob/trunk/docs/core/tenancy.md) |
| `./Company` | Companies (legal entities) and their tenant-scoped repository port. | [Tenancy](https://github.com/thomasfosterau/effect-biz/blob/trunk/docs/core/tenancy.md) |
| `./Actor` | Who is acting: the `CurrentActor` a command records. | [Tenancy](https://github.com/thomasfosterau/effect-biz/blob/trunk/docs/core/tenancy.md) |
| `./Decimal` | Exact decimals (`BigDecimal`) and their canonical string codec. | [Exact numbers](https://github.com/thomasfosterau/effect-biz/blob/trunk/docs/core/exact-numbers.md) |
| `./Rounding` | Rounding policies, required wherever a value is rounded. | [Exact numbers](https://github.com/thomasfosterau/effect-biz/blob/trunk/docs/core/exact-numbers.md) |
| `./Quantity` | Exact quantities. | [Exact numbers](https://github.com/thomasfosterau/effect-biz/blob/trunk/docs/core/exact-numbers.md) |
| `./Percentage`, `./Rate` | Exact percentages and rates. | [Exact numbers](https://github.com/thomasfosterau/effect-biz/blob/trunk/docs/core/exact-numbers.md) |
| `./Currency` | ISO 4217 currency codes and the minor-unit table. | [Exact numbers](https://github.com/thomasfosterau/effect-biz/blob/trunk/docs/core/exact-numbers.md) |
| `./Money` | Exact money: arithmetic, rounding and allocation within one currency. | [Exact numbers](https://github.com/thomasfosterau/effect-biz/blob/trunk/docs/core/exact-numbers.md) |
| `./Payments`, `./Payments.<Module>` | The vendor-neutral payments core: capabilities, entities, `Money`, `Page`, errors, `IdempotencyKey`, `Stub`. | [Payments](https://github.com/thomasfosterau/effect-biz/blob/trunk/docs/core/payments.md), [errors](https://github.com/thomasfosterau/effect-biz/blob/trunk/docs/core/payments-errors.md), [retrying a write](https://github.com/thomasfosterau/effect-biz/blob/trunk/docs/core/retrying-writes.md), [stubs](https://github.com/thomasfosterau/effect-biz/blob/trunk/docs/core/stubs.md), [modules](https://github.com/thomasfosterau/effect-biz/blob/trunk/docs/core/payments-modules.md) |
| `./Payments.internal` | Helpers shared by the providers. Internal, exempt from semver. | [Internal](https://github.com/thomasfosterau/effect-biz/blob/trunk/docs/core/internal.md) |

Payments providers: [`@thomasfosterau/effect-biz-payments-stripe`](https://www.npmjs.com/package/@thomasfosterau/effect-biz-payments-stripe).

## Links

- [Repository and issues](https://github.com/thomasfosterau/effect-biz)
- [All guides](https://github.com/thomasfosterau/effect-biz/tree/trunk/docs)

## License

MIT © Thomas Foster
