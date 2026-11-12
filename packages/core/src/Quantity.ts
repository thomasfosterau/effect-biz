/**
 * A quantity: an exact amount of a unit.
 *
 * Core carries only the unit's {@link UnitCode}; the catalogue owns the units
 * themselves (their names, their conversions). Arithmetic across two units
 * is a mistake, so {@link add} and {@link subtract} refuse it with a
 * `BusinessRuleViolation` (code `"core.unit-mismatch"`) in a `Result`
 * rather than throwing.
 *
 * See {@link Quantity} for an example.
 *
 * @module
 */

import * as BigDecimal from "effect/BigDecimal";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import { BusinessRuleViolation } from "./BizError.js";
import { Decimal } from "./Decimal.js";

/** The code of a unit of measure (`"kg"`, `"each"`): a non-empty string, branded so it is not mixed up with other text. */
export const UnitCode = Schema.NonEmptyString.pipe(Schema.brand("UnitCode"));

/** The code of a unit of measure. */
export type UnitCode = typeof UnitCode.Type;

/**
 * An exact amount of one unit. The amount may be negative (an adjustment, a
 * return); {@link NonNegativeQuantity} refuses that.
 *
 * @example
 * ```ts
 * import { Result, Schema } from "effect";
 * import * as Decimal from "@thomasfosterau/effect-biz/Decimal";
 * import * as Quantity from "@thomasfosterau/effect-biz/Quantity";
 *
 * const kg = Schema.decodeUnknownSync(Quantity.UnitCode)("kg");
 * const a = new Quantity.Quantity({ amount: Decimal.make("1.25"), unit: kg });
 * const b = new Quantity.Quantity({ amount: Decimal.make("0.75"), unit: kg });
 *
 * const sum = Quantity.add(a, b);
 * console.log(Result.isSuccess(sum) && Schema.encodeSync(Decimal.Decimal)(sum.success.amount)); // "2"
 *
 * const each = new Quantity.Quantity({ amount: Decimal.make("1"), unit: Schema.decodeUnknownSync(Quantity.UnitCode)("each") });
 * const mismatch = Quantity.add(a, each);
 * console.log(Result.isFailure(mismatch) && mismatch.failure.code); // "core.unit-mismatch"
 * ```
 */
export class Quantity extends Schema.Class<Quantity, { readonly brand: unique symbol }>(
  "@effect-biz/Quantity/Quantity",
)({
  /** The exact amount. */
  amount: Decimal,
  /** The unit the amount is measured in. */
  unit: UnitCode,
}) {}

/** A {@link Quantity} that is zero or more: stock on hand, an ordered amount. */
export const NonNegativeQuantity = Quantity.check(
  Schema.makeFilter((quantity: Quantity) => !BigDecimal.isNegative(quantity.amount), {
    identifier: "NonNegativeQuantity",
    title: "Non-negative quantity",
    description: "A quantity whose amount is zero or more",
    expected: "a non-negative quantity",
  }),
);

/** The violation for two quantities in different units. */
const unitMismatch = (left: UnitCode, right: UnitCode): BusinessRuleViolation =>
  new BusinessRuleViolation({
    code: "core.unit-mismatch",
    reason: `Cannot combine quantities in ${left} and ${right}`,
    details: Option.some({ left, right }),
  });

/** Combines two quantities' amounts, or fails when their units differ. */
const combine = (
  left: Quantity,
  right: Quantity,
  operation: (a: BigDecimal.BigDecimal, b: BigDecimal.BigDecimal) => BigDecimal.BigDecimal,
): Result.Result<Quantity, BusinessRuleViolation> =>
  left.unit === right.unit
    ? Result.succeed(
        new Quantity({ amount: operation(left.amount, right.amount), unit: left.unit }),
      )
    : Result.fail(unitMismatch(left.unit, right.unit));

/** The sum of two quantities in the same unit, or a `core.unit-mismatch` violation. */
export const add = (
  left: Quantity,
  right: Quantity,
): Result.Result<Quantity, BusinessRuleViolation> => combine(left, right, BigDecimal.sum);

/** The difference of two quantities in the same unit, or a `core.unit-mismatch` violation. */
export const subtract = (
  left: Quantity,
  right: Quantity,
): Result.Result<Quantity, BusinessRuleViolation> => combine(left, right, BigDecimal.subtract);
