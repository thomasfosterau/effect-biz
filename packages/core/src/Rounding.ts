/**
 * Rounding modes and the policy a company configures.
 *
 * Nothing in effect-biz rounds with a hard-coded mode or scale: every
 * function that can discard digits takes a {@link RoundingPolicy}, which a
 * company stores as a setting (the rounding basis of its tax calculation, the
 * scale of a unit price). The modes are Effect's own `BigDecimal` modes; the
 * names accountants use map onto them as follows.
 *
 * | Common name | {@link RoundingMode} |
 * | --- | --- |
 * | half-even (banker's) | `"half-even"` |
 * | half-up (commercial) | `"half-from-zero"` |
 * | up (away from zero) | `"from-zero"` |
 * | down (truncate) | `"to-zero"` |
 *
 * See {@link round} for an example.
 *
 * @module
 */

import * as BigDecimal from "effect/BigDecimal";
import * as Schema from "effect/Schema";

/**
 * How a discarded fraction is resolved: one of Effect's `BigDecimal` rounding
 * modes. Half-even is `"half-even"`, half-up is `"half-from-zero"`, up is
 * `"from-zero"` and down is `"to-zero"`; `"ceil"` and `"floor"` round towards
 * the infinities, and the remaining `half-*` modes settle ties otherwise.
 */
export const RoundingMode = Schema.Literals([
  "ceil",
  "floor",
  "to-zero",
  "from-zero",
  "half-ceil",
  "half-floor",
  "half-to-zero",
  "half-from-zero",
  "half-even",
  "half-odd",
]);

/** One of the rounding modes. */
export type RoundingMode = typeof RoundingMode.Type;

/**
 * A rounding rule: the `mode` that resolves the discarded fraction and the
 * `scale` (number of fraction digits kept; negative rounds to tens, hundreds,
 * …). A company configures one per use (a currency's minor units for money,
 * four digits for a unit price).
 */
export class RoundingPolicy extends Schema.Class<RoundingPolicy, { readonly brand: unique symbol }>(
  "@effect-biz/Rounding/RoundingPolicy",
)({
  /** How the discarded fraction is resolved. */
  mode: RoundingMode,
  /** The number of fraction digits kept. */
  scale: Schema.Int,
}) {}

/**
 * Rounds a decimal to a policy's scale with its mode. A value that already has
 * no more fraction digits than the scale is returned unchanged.
 *
 * @example
 * ```ts
 * import { BigDecimal } from "effect";
 * import * as Rounding from "@thomasfosterau/effect-biz/Rounding";
 *
 * const halfEven = new Rounding.RoundingPolicy({ mode: "half-even", scale: 0 });
 * const halfUp = new Rounding.RoundingPolicy({ mode: "half-from-zero", scale: 0 });
 * const value = BigDecimal.fromStringUnsafe("2.5");
 *
 * console.log(BigDecimal.format(Rounding.round(value, halfEven))); // "2"
 * console.log(BigDecimal.format(Rounding.round(value, halfUp))); // "3"
 * ```
 */
export const round = (
  value: BigDecimal.BigDecimal,
  policy: RoundingPolicy,
): BigDecimal.BigDecimal => BigDecimal.round(value, { mode: policy.mode, scale: policy.scale });
