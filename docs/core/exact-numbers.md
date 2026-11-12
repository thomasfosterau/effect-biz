# Exact numbers

Decimals, rounding, quantities, percentages, rates, currency and money. See also [identifiers and errors](ids-and-errors.md).

A quantity, price, rate or percentage is never a JavaScript `number`. Every one is an `effect/BigDecimal`, and crosses a boundary (a SQL row, an event, an HTTP body) as a canonical decimal string. Arithmetic stays Effect's own `BigDecimal.sum`, `subtract` and `multiply`, which are exact; the one inexact operation, division, always takes a rounding policy, and so does every other place that rounds. Pure functions that can fail return a `Result` whose failure is a `BizError.BusinessRuleViolation` with a `core.*` code, and never throw.

## Decimals (`./Decimal`)

`Decimal` is a schema whose Type is a `BigDecimal` and whose Encoded form is `-?digits` with an optional `.digits`: no exponent, no empty string, no leading `+`, never a JSON number. Encoding writes the shortest plain form and loses no precision (`BigDecimal.format` alone switches to an exponent for very small or large scales).

```ts
import { BigDecimal, Schema } from "effect";
import * as Decimal from "@thomasfosterau/effect-biz/Decimal";

const price = Schema.decodeUnknownSync(Decimal.Decimal)("12.50");
const total = BigDecimal.multiply(price, Decimal.make("3"));

console.log(Schema.encodeSync(Decimal.Decimal)(total)); // "37.5"
console.log(Schema.decodeUnknownExit(Decimal.Decimal)("1e5")._tag); // "Failure"
console.log(Schema.decodeUnknownExit(Decimal.Decimal)(1.5)._tag); // "Failure"
```

`make(text)` parses a literal (and throws), `fromString` returns an `Option`, `zero` and `one` are constants, `format(value, scale)` pads to a fixed scale (and is `None` rather than rounding), and `divide(a, b, policy)` is `None` for a zero divisor.

## Rounding (`./Rounding`)

`RoundingMode` is Effect's `BigDecimal` rounding modes. The common names map onto them: half-even is `"half-even"`, half-up is `"half-from-zero"`, up is `"from-zero"` and down is `"to-zero"`. A `RoundingPolicy` is a mode and a scale (fraction digits kept); a company configures one wherever it rounds.

```ts
import { BigDecimal } from "effect";
import * as Rounding from "@thomasfosterau/effect-biz/Rounding";

const halfEven = new Rounding.RoundingPolicy({ mode: "half-even", scale: 0 });
const halfUp = new Rounding.RoundingPolicy({ mode: "half-from-zero", scale: 0 });
const tie = BigDecimal.fromStringUnsafe("2.5");

console.log(BigDecimal.format(Rounding.round(tie, halfEven))); // "2"
console.log(BigDecimal.format(Rounding.round(tie, halfUp))); // "3"
```

## Quantities (`./Quantity`)

A `Quantity` is an exact `amount` of a `unit`. Core carries only the `UnitCode`; the catalogue owns the units and their conversions. `NonNegativeQuantity` refuses a negative amount. `add` and `subtract` fail with `core.unit-mismatch` (both codes in `details`) when the units differ.

```ts
import { Result, Schema } from "effect";
import * as Decimal from "@thomasfosterau/effect-biz/Decimal";
import * as Quantity from "@thomasfosterau/effect-biz/Quantity";

const unit = Schema.decodeSync(Quantity.UnitCode);
const kg = new Quantity.Quantity({ amount: Decimal.make("1.25"), unit: unit("kg") });
const each = new Quantity.Quantity({ amount: Decimal.make("1"), unit: unit("each") });

const mismatch = Quantity.add(kg, each);
console.log(Result.isFailure(mismatch) && mismatch.failure.code); // "core.unit-mismatch"
```

## Percentages and rates (`./Percentage`, `./Rate`)

`Percentage` holds a number of percent (`"12.5"` is 12.5%); `toFactor` (`0.125`) and `fromFactor` are exact, and `of(base, percentage, policy)` rounds. `Rate` is a positive dimensionless factor (an exchange rate, a multiplier); `apply(value, rate, policy)` and `invert(rate, policy)` round with the policy given, and `invert` fails with `core.rate-not-positive` if the result rounds to zero.

```ts
import { BigDecimal, Result } from "effect";
import * as Decimal from "@thomasfosterau/effect-biz/Decimal";
import * as Percentage from "@thomasfosterau/effect-biz/Percentage";
import * as Rate from "@thomasfosterau/effect-biz/Rate";
import * as Rounding from "@thomasfosterau/effect-biz/Rounding";

const cents = new Rounding.RoundingPolicy({ mode: "half-even", scale: 2 });
const gst = new Percentage.Percentage({ value: Decimal.make("10") });
console.log(BigDecimal.format(Percentage.of(Decimal.make("12.345"), gst, cents))); // "1.23"

const rate = new Rate.Rate({ value: Decimal.make("1.5432") });
console.log(BigDecimal.format(Rate.apply(Decimal.make("100"), rate, cents))); // "154.32"
const back = Rate.invert(rate, new Rounding.RoundingPolicy({ mode: "half-even", scale: 6 }));
console.log(Result.isSuccess(back) && BigDecimal.format(back.success.value)); // "0.648004"
```

## Currency and money (`./Currency`, `./Money`)

`CurrencyCode` is three upper-case letters, branded. `Currency.minorUnits(code)` is the one ISO 4217 minor-unit table (2 by default; 0 for `JPY`, `KRW`, …; 3 for `KWD`, `BHD`, …; 4 for `CLF`, `UYW`).

`Money` is an exact `{ amount, currency }`, encoded as `{ "amount": "12.5", "currency": "AUD" }`. It is not the payments `Money` (`./Payments.Money`: integer minor units in a `number`, the providers' wire format); convert at the gateway edge with `toMinorUnits` and `fromMinorUnits`. `add`, `subtract` and `sum` fail with `core.currency-mismatch`; `multiply` by an exact factor never rounds; `round` defaults to the currency's minor units, half-even; `toMinorUnits` fails with `core.money-scale` rather than drop digits; `allocate` splits by the largest-remainder method so the parts sum exactly to the rounded total. `isZero`, `isNegative`, `Order` (within one currency) and `Equivalence` are there too.

```ts
import { BigDecimal, Result } from "effect";
import * as Currency from "@thomasfosterau/effect-biz/Currency";
import * as Decimal from "@thomasfosterau/effect-biz/Decimal";
import * as Money from "@thomasfosterau/effect-biz/Money";

const aud = Currency.make("AUD");
const total = Money.make(Decimal.make("100"), aud);

const parts = Money.allocate(total, [Decimal.make("1"), Decimal.make("1"), Decimal.make("1")]);
console.log(Result.isSuccess(parts) && parts.success.map((part) => BigDecimal.format(part.amount))); // ["33.34", "33.33", "33.33"]

const yen = Money.make(Decimal.make("1234.5"), Currency.make("JPY"));
console.log(Result.isFailure(Money.toMinorUnits(yen))); // true: round first
console.log(Result.getOrUndefined(Money.toMinorUnits(Money.round(yen)))); // 1234n

const mixed = Money.add(total, Money.zero(Currency.make("USD")));
console.log(Result.isFailure(mixed) && mixed.failure.code); // "core.currency-mismatch"
```
