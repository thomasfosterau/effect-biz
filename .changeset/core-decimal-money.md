---
"@thomasfosterau/effect-biz": minor
---

Add exact numbers and money. `@thomasfosterau/effect-biz/Decimal` is a `BigDecimal` schema that encodes as a canonical decimal string (never an exponent or a JSON number), with `make`, `fromString`, `zero`, `one`, `format` and a policy-rounded `divide`. `Rounding` carries `RoundingMode` (Effect's modes) and `RoundingPolicy`, and `round`. `Quantity` (an amount of a `UnitCode`, `NonNegativeQuantity`, `add` / `subtract`), `Percentage` (`toFactor`, `fromFactor`, `of`) and `Rate` (a positive factor with `apply` and `invert`) build on them. `Currency` has the branded `CurrencyCode` and the one ISO 4217 `minorUnits` table, and `Money` is the exact money type (`add`, `subtract`, `sum`, `multiply`, `round`, `toMinorUnits`, `fromMinorUnits`, largest-remainder `allocate`, `Order`, `Equivalence`). A unit or currency mismatch is a `BusinessRuleViolation` (`core.unit-mismatch`, `core.currency-mismatch`) in a `Result`, never a throw.
