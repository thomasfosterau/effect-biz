/**
 * Exact decimal numbers: `effect/BigDecimal` values that cross every boundary
 * as a canonical decimal string.
 *
 * A quantity, price, rate or percentage is never a JavaScript `number`. The
 * {@link Decimal} schema decodes `"12.50"` to a `BigDecimal` and encodes it
 * back as plain digits (never an exponent, never a JSON number), so a value
 * loses nothing between a database, an event payload and a screen. Arithmetic
 * stays Effect's own (`BigDecimal.sum`, `subtract`, `multiply`): addition,
 * subtraction and multiplication are exact. Division is the one operation that
 * cannot be, so {@link divide} always takes a `RoundingPolicy`.
 *
 * See {@link Decimal} for an example.
 *
 * @module
 */

import * as BigDecimal from "effect/BigDecimal";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SchemaIssue from "effect/SchemaIssue";
import * as SchemaTransformation from "effect/SchemaTransformation";
import { round, type RoundingPolicy } from "./Rounding.js";

/** The canonical text of a decimal: an optional minus, digits, and an optional `.` with digits. */
const CANONICAL = /^-?\d+(?:\.\d+)?$/;

/** The digits of a value at `scale` fraction digits, which must not be fewer than the value's own. */
const fixed = (value: BigDecimal.BigDecimal, scale: number): string => {
  const scaled = BigDecimal.scale(value, scale).value;
  const digits = (scaled < 0n ? -scaled : scaled).toString().padStart(scale + 1, "0");
  const point = digits.length - scale;
  const text = scale > 0 ? `${digits.slice(0, point)}.${digits.slice(point)}` : digits;
  return scaled < 0n ? `-${text}` : text;
};

/** A value's canonical text: the fewest fraction digits that represent it, in plain notation. */
const canonical = (value: BigDecimal.BigDecimal): string =>
  fixed(value, Math.max(0, BigDecimal.normalize(value).scale));

/**
 * The schema of an exact decimal. The Type is a `BigDecimal`; the Encoded form
 * is a canonical decimal string (`-?digits` with an optional `.digits`, no
 * exponent, no leading `+`, no empty string), so `"1e5"`, `""`, `"+1"`,
 * `"1,000"` and a JSON number are all rejected. Encoding writes the shortest
 * plain form (`"1.50"` round-trips as `"1.5"`), which is also valid for a
 * value outside the exponent range `BigDecimal.format` switches to scientific
 * notation for.
 *
 * @example
 * ```ts
 * import { BigDecimal, Schema } from "effect";
 * import * as Decimal from "@thomasfosterau/effect-biz/Decimal";
 *
 * const price = Schema.decodeUnknownSync(Decimal.Decimal)("12.50");
 * const total = BigDecimal.multiply(price, Decimal.make("3"));
 *
 * console.log(Schema.encodeSync(Decimal.Decimal)(total)); // "37.5"
 * console.log(Schema.is(Decimal.Decimal)(1.5)); // false
 * console.log(Schema.decodeUnknownExit(Decimal.Decimal)("1e5")._tag); // "Failure"
 * ```
 */
export const Decimal = Schema.String.check(Schema.isPattern(CANONICAL)).pipe(
  Schema.decodeTo(
    Schema.BigDecimal,
    SchemaTransformation.transformEffect({
      decode: (text: string, options) =>
        Effect.fromOption(BigDecimal.fromString(text)).pipe(
          Effect.mapError(
            () =>
              new SchemaIssue.InvalidValue(
                { message: "a decimal within scale ±10,000" },
                text,
                options,
              ),
          ),
        ),
      encode: (value: BigDecimal.BigDecimal) => Effect.succeed(canonical(value)),
    }),
  ),
);

/** An exact decimal. */
export type Decimal = typeof Decimal.Type;

/** Parses a canonical decimal string, or `None` when it is not one (the {@link Decimal} grammar). */
export const fromString = (text: string): Option.Option<BigDecimal.BigDecimal> =>
  CANONICAL.test(text) ? BigDecimal.fromString(text) : Option.none();

/**
 * Parses a canonical decimal string and throws on anything else: for
 * literals in code and tests, never for input (decode that with
 * {@link Decimal}).
 */
export const make = (text: string): BigDecimal.BigDecimal => Schema.decodeSync(Decimal)(text);

/** The decimal zero. */
export const zero: BigDecimal.BigDecimal = BigDecimal.fromBigInt(0n);

/** The decimal one. */
export const one: BigDecimal.BigDecimal = BigDecimal.fromBigInt(1n);

/**
 * A value as plain text with exactly `scale` fraction digits (`"2.50"`), or
 * `None` when the value has more fraction digits than that: formatting never
 * rounds (use `Rounding.round` first).
 */
export const format = (value: BigDecimal.BigDecimal, scale: number): Option.Option<string> =>
  Number.isInteger(scale) && scale >= 0 && BigDecimal.normalize(value).scale <= scale
    ? Option.some(fixed(value, scale))
    : Option.none();

/**
 * Divides one decimal by another and rounds the quotient with a policy, or
 * `None` when the divisor is zero. The quotient is computed to Effect's
 * division precision before rounding, so a tie is never invented.
 */
export const divide = (
  dividend: BigDecimal.BigDecimal,
  divisor: BigDecimal.BigDecimal,
  policy: RoundingPolicy,
): Option.Option<BigDecimal.BigDecimal> =>
  Option.map(BigDecimal.divide(dividend, divisor), (quotient) => round(quotient, policy));
