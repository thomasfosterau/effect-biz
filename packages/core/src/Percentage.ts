/**
 * A percentage: `"12.5"` means 12.5 percent, a factor of `0.125`.
 *
 * The value is an exact {@link Decimal}; converting to and from a factor is
 * exact (a shift of two digits), and {@link of} rounds with the policy it is
 * given.
 *
 * See {@link of} for an example.
 *
 * @module
 */

import * as BigDecimal from "effect/BigDecimal";
import * as Schema from "effect/Schema";
import { Decimal } from "./Decimal.js";
import { round, type RoundingPolicy } from "./Rounding.js";

/** A percentage of some base, as a number of percent (`"12.5"` is 12.5%). */
export class Percentage extends Schema.Class<Percentage, { readonly brand: unique symbol }>(
  "@effect-biz/Percentage/Percentage",
)({
  /** The number of percent. */
  value: Decimal,
}) {}

/** The factor a percentage stands for, exactly: 12.5% is `0.125`. */
export const toFactor = (percentage: Percentage): BigDecimal.BigDecimal =>
  BigDecimal.make(percentage.value.value, percentage.value.scale + 2);

/** The percentage a factor stands for, exactly: `0.125` is 12.5%. */
export const fromFactor = (factor: BigDecimal.BigDecimal): Percentage =>
  new Percentage({ value: BigDecimal.make(factor.value, factor.scale - 2) });

/**
 * The given percentage of a base, rounded with a policy.
 *
 * @example
 * ```ts
 * import { BigDecimal } from "effect";
 * import * as Decimal from "@thomasfosterau/effect-biz/Decimal";
 * import * as Percentage from "@thomasfosterau/effect-biz/Percentage";
 * import * as Rounding from "@thomasfosterau/effect-biz/Rounding";
 *
 * const gst = new Percentage.Percentage({ value: Decimal.make("10") });
 * const cents = new Rounding.RoundingPolicy({ mode: "half-even", scale: 2 });
 *
 * console.log(BigDecimal.format(Percentage.of(Decimal.make("12.345"), gst, cents))); // "1.23"
 * ```
 */
export const of = (
  base: BigDecimal.BigDecimal,
  percentage: Percentage,
  policy: RoundingPolicy,
): BigDecimal.BigDecimal => round(BigDecimal.multiply(base, toFactor(percentage)), policy);
