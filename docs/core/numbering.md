# Document numbering

How invoices, orders and every other document get their numbers: a sequence per company and document type, formatted from a pattern, reset by period in the company's time zone, and taken inside the command's [unit of work](unit-of-work.md) so a rolled-back command consumes nothing (#31). See also [tenancy and companies](tenancy.md).

## Numbers are attributes, not identities

A document keeps its UUIDv7 id as its identity; its number (`INV-2027-0042`) is a unique, searchable attribute. A sequence never issues the same number twice, but making the number unique among the stored documents (a unique index, a guarded insert) is the document repository's concern, as is refusing a hand-typed number that collides with one the sequence issued.

## Defining a sequence (`./NumberSequence`)

A `SequenceDefinition` says how one company numbers one document type (a `DocumentType` such as `"sales.invoice"`):

| Field         | Meaning                                                                    |
| ------------- | -------------------------------------------------------------------------- |
| `pattern`     | Literal text and tokens, with exactly one `{#}`: `"INV-{YYYY}-{#}"`.       |
| `padding`     | The counter's minimum width (1 to 18, default 4): `4` formats 7 as `0007`. |
| `reset`       | `"never"` (default), `"yearly"`, `"fiscal-yearly"` or `"monthly"`.         |
| `mode`        | `"gap-less"` (default) or `"gaps-allowed"`.                                |
| `companyCode` | The text `{COMPANY}` stands for; required when the pattern has it.         |

`NumberSequence.define` creates the definition, or updates the stored one at its next version (its counter carries on). Definitions are stored per tenant, company and document type behind `SequenceDefinitions`; `get` and `list` read them, and `next` on a type without one is `NotFound`.

### The pattern grammar

A `Pattern` is text with tokens in braces. Dates are the company's, in its IANA `timeZone`, at the moment the number is issued.

| Token       | Value                                                           |
| ----------- | --------------------------------------------------------------- |
| `{YYYY}`    | The calendar year, four digits.                                 |
| `{YY}`      | The calendar year's last two digits.                            |
| `{MM}`      | The month, two digits.                                          |
| `{FY}`      | The fiscal year, four digits, named by the year it **ends** in. |
| `{FYY}`     | The fiscal year's last two digits.                              |
| `{COMPANY}` | The definition's `companyCode`.                                 |
| `{#}`       | The counter, zero-padded to `padding` (never truncated).        |

Decoding fails for an unknown token (`{DD}`), a brace outside a token, and a pattern without exactly one `{#}`. A definition also fails (a `ValidationError` from `define`) when its pattern cannot tell its periods apart, since the number would repeat: `"yearly"` needs `{YYYY}` or `{YY}`, `"monthly"` one of those and `{MM}`, and `"fiscal-yearly"` `{FY}` or `{FYY}`.

**Fiscal years** start on the company's `fiscalYearStart` and are named by the calendar year they end in, the Australian convention: with a 1 July start, 1 July 2026 to 30 June 2027 is FY2027 (`{FY}` = `2027`, `{FYY}` = `27`). A fiscal year that starts on 1 January is the calendar year.

### Resets follow the company's time zone

A resetting counter goes back to 1 when the period changes, and the period is computed in the company's time zone. At 2026-12-31T13:30Z it is already 00:30 on 1 January 2027 in `Australia/Sydney`, so a Sydney company's yearly sequence starts again at 1, while a UTC company is still in 2026 and counts on. An unknown time zone is a `BusinessRuleViolation` (`core.unknown-time-zone`).

## Taking a number

`NumberSequence.next(companyId, documentType)` issues the next number. Call it inside the command's `UnitOfWork.transaction`; outside one it runs a transaction of its own.

- **Gap-less** (`"gap-less"`). `next` reads the committed counter, decides the number purely (the definition, the counter and the period from `Clock`), and stages a write guarded by the counter it read (the same period and value) into the command's batch. In SQL that is `UPDATE … SET last = ? WHERE period = ? AND last = ?` in the command's batch (on D1 too, #128). A concurrent command that took the number first makes the batch conflict, and the command is retried from its load step, so two commands never commit the same number; a command that fails or is interrupted applies nothing, so it consumes no number.
- **Gaps allowed** (`"gaps-allowed"`). The increment commits at once, outside the command's batch: it never conflicts and is cheaper under contention, but a rolled-back command leaves a gap. It still never issues a number twice.

Take **at most one number per sequence per command**. With no read-your-writes, a second gap-less `next` in the same transaction reads the same committed counter, and its guard conflicts with the first.

```ts
import { Effect, Layer, Option } from "effect";
import * as Actor from "@thomasfosterau/effect-biz/Actor";
import * as Company from "@thomasfosterau/effect-biz/Company";
import * as Currency from "@thomasfosterau/effect-biz/Currency";
import * as Id from "@thomasfosterau/effect-biz/Id";
import * as NumberSequence from "@thomasfosterau/effect-biz/NumberSequence";
import * as Rounding from "@thomasfosterau/effect-biz/Rounding";
import * as Tenancy from "@thomasfosterau/effect-biz/Tenancy";
import * as UnitOfWork from "@thomasfosterau/effect-biz/UnitOfWork";

const invoice = NumberSequence.DocumentType.make("sales.invoice");

const program = Effect.gen(function* () {
  const company = yield* Company.create({
    legalName: "Example Pty Ltd",
    tradingName: Option.none(),
    registrations: [],
    baseCurrency: Currency.make("AUD"),
    country: Company.CountryCode.make("AU"),
    locale: "en-AU",
    timeZone: "Australia/Sydney",
    fiscalYearStart: new Company.FiscalYearStart({ month: 7, day: 1 }),
    rounding: new Rounding.RoundingPolicy({ mode: "half-even", scale: 2 }),
  });
  yield* NumberSequence.define({
    companyId: company.id,
    documentType: invoice,
    pattern: NumberSequence.Pattern.make("{COMPANY}-INV-{#}"),
    companyCode: "SYD",
  });
  const first = yield* UnitOfWork.transaction(NumberSequence.next(company.id, invoice));
  // A command that takes a number and then fails consumes nothing.
  yield* Effect.flip(
    UnitOfWork.transaction(
      Effect.andThen(NumberSequence.next(company.id, invoice), Effect.fail("rejected")),
    ),
  );
  const second = yield* UnitOfWork.transaction(NumberSequence.next(company.id, invoice));
  return [first, second];
});

const layer = NumberSequence.layerMemory.pipe(
  Layer.provideMerge(
    Layer.mergeAll(Company.layerMemory, UnitOfWork.layerMemory, Id.layerSequential),
  ),
);
const tenant = Tenancy.TenantId.make("0190a6e4-1c2d-7abc-8def-0123456789ab");
const numbers = Effect.runSync(
  program.pipe(
    Effect.provide(layer),
    Tenancy.withTenant(tenant),
    Actor.withActor(Actor.system("example")),
  ),
);
console.log(numbers); // ["SYD-INV-0001", "SYD-INV-0002"]
```

A yearly sequence in Sydney, across the UTC instant that is already the new year there:

```ts
import { DateTime, Effect, Layer, Option } from "effect";
import { TestClock } from "effect/testing";
import * as Actor from "@thomasfosterau/effect-biz/Actor";
import * as Company from "@thomasfosterau/effect-biz/Company";
import * as Currency from "@thomasfosterau/effect-biz/Currency";
import * as Id from "@thomasfosterau/effect-biz/Id";
import * as NumberSequence from "@thomasfosterau/effect-biz/NumberSequence";
import * as Rounding from "@thomasfosterau/effect-biz/Rounding";
import * as Tenancy from "@thomasfosterau/effect-biz/Tenancy";
import * as UnitOfWork from "@thomasfosterau/effect-biz/UnitOfWork";

const invoice = NumberSequence.DocumentType.make("sales.invoice");
const at = (iso: string) => TestClock.setTime(DateTime.toEpochMillis(DateTime.makeUnsafe(iso)));

const program = Effect.gen(function* () {
  const company = yield* Company.create({
    legalName: "Example Pty Ltd",
    tradingName: Option.none(),
    registrations: [],
    baseCurrency: Currency.make("AUD"),
    country: Company.CountryCode.make("AU"),
    locale: "en-AU",
    timeZone: "Australia/Sydney",
    fiscalYearStart: new Company.FiscalYearStart({ month: 7, day: 1 }),
    rounding: new Rounding.RoundingPolicy({ mode: "half-even", scale: 2 }),
  });
  yield* NumberSequence.define({
    companyId: company.id,
    documentType: invoice,
    pattern: NumberSequence.Pattern.make("INV-{YYYY}-{#}"),
    reset: "yearly",
  });
  const take = UnitOfWork.transaction(NumberSequence.next(company.id, invoice));
  yield* at("2026-12-31T12:00:00Z"); // 23:00 on 31 December in Sydney
  const before = yield* take;
  yield* at("2026-12-31T13:30:00Z"); // 00:30 on 1 January 2027 in Sydney
  const after = yield* take;
  return [before, after];
});

const layer = NumberSequence.layerMemory.pipe(
  Layer.provideMerge(
    Layer.mergeAll(
      Company.layerMemory,
      UnitOfWork.layerMemory,
      Id.layerSequential,
      TestClock.layer(),
    ),
  ),
);
const tenant = Tenancy.TenantId.make("0190a6e4-1c2d-7abc-8def-0123456789ab");
Effect.runPromise(
  program.pipe(
    Effect.provide(layer),
    Tenancy.withTenant(tenant),
    Actor.withActor(Actor.system("example")),
  ),
).then((numbers) => console.log(numbers)); // ["INV-2026-0001", "INV-2027-0001"]
```

## Implementations

`NumberSequence.layerMemory` provides `NumberSequences` and `SequenceDefinitions` over `./Memory` stores, reading companies from `Company.CompanyRepository` and staging gap-less counter writes into the in-memory `UnitOfWork`. The pure steps a SQL layer (#40) shares are exported: `periodOf` (the period in the company's time zone), `advance` (the counter after one number: one on, or 1 in a new period), `format` and `fiscalYearOf`. Every implementation runs `./testing`'s `numberSequencesContract`: no duplicates under concurrent `next` calls in either mode, no gap after rolled-back commands in gap-less mode, and the yearly reset in the company's time zone.
