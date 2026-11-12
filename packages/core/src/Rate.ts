/**
 * A rate: a positive, dimensionless factor with an explicit scale, such as an
 * exchange rate or an hourly-rate multiplier.
 *
 * A rate is never zero or negative, so it can always be inverted. Applying one
 * rounds with the policy it is given.
 *
 * See {@link apply} for an example.
 *
 * @module
 */

import * as BigDecimal from "effect/BigDecimal";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import { BusinessRuleViolation } from "./BizError.js";
import { Decimal, divide, one } from "./Decimal.js";
import { round, type RoundingPolicy } from "./Rounding.js";

/** A positive factor: the decimal must be greater than zero. */
export class Rate extends Schema.Class<Rate, { readonly brand: unique symbol }>(
  "@effect-biz/Rate/Rate",
)({
  /** The factor, greater than zero. */
  value: Decimal.check(Schema.isGreaterThanBigDecimal(BigDecimal.fromBigInt(0n))),
}) {}

/** The violation for a value that cannot be a rate. */
const notPositive = (value: BigDecimal.BigDecimal): BusinessRuleViolation =>
  new BusinessRuleViolation({
    code: "core.rate-not-positive",
    reason: "A rate must be greater than zero",
    details: Option.some({ value: BigDecimal.format(value) }),
  });

/** A rate from a decimal, or a `core.rate-not-positive` violation when it is zero or negative. */
export const make = (value: BigDecimal.BigDecimal): Result.Result<Rate, BusinessRuleViolation> =>
  BigDecimal.isPositive(value)
    ? Result.succeed(new Rate({ value }))
    : Result.fail(notPositive(value));

/**
 * Multiplies a decimal by a rate and rounds with a policy.
 *
 * @example
 * ```ts
 * import { BigDecimal, Result } from "effect";
 * import * as Decimal from "@thomasfosterau/effect-biz/Decimal";
 * import * as Rate from "@thomasfosterau/effect-biz/Rate";
 * import * as Rounding from "@thomasfosterau/effect-biz/Rounding";
 *
 * const rate = new Rate.Rate({ value: Decimal.make("1.5432") });
 * const cents = new Rounding.RoundingPolicy({ mode: "half-even", scale: 2 });
 *
 * console.log(BigDecimal.format(Rate.apply(Decimal.make("100"), rate, cents))); // "154.32"
 *
 * const back = Rate.invert(rate, new Rounding.RoundingPolicy({ mode: "half-even", scale: 6 }));
 * console.log(Result.isSuccess(back) && BigDecimal.format(back.success.value)); // "0.648004"
 * ```
 */
export const apply = (
  value: BigDecimal.BigDecimal,
  rate: Rate,
  policy: RoundingPolicy,
): BigDecimal.BigDecimal => round(BigDecimal.multiply(value, rate.value), policy);

/**
 * The reciprocal of a rate, rounded with a policy. Fails with
 * `core.rate-not-positive` when the rounded reciprocal would be zero (the
 * policy's scale is too coarse for it).
 */
export const invert = (
  rate: Rate,
  policy: RoundingPolicy,
): Result.Result<Rate, BusinessRuleViolation> =>
  Option.match(divide(one, rate.value, policy), {
    onNone: () => Result.fail(notPositive(rate.value)),
    onSome: make,
  });
