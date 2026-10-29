/**
 * Conversion between the neutral minor-unit amounts and the major-unit decimal
 * amounts Airwallex uses on the wire.
 *
 * The neutral core represents money in the smallest currency unit (e.g.
 * cents). Airwallex represents money in major units (e.g. `20.5`), sent and
 * received as JSON **numbers**. Neither direction scales with float
 * arithmetic:
 *
 * - **Parse.** By the time a response amount reaches the decoder, `JSON.parse`
 *   has already rounded its wire text to the nearest double; the text itself
 *   is gone. The amount is read from that double's shortest decimal form,
 *   `String(n)`, including exponent notation such as `1e-7` or `1.5e+21`, and
 *   scaled with integer (`BigInt`) arithmetic. It is rejected, not rounded,
 *   when that form has more fraction digits than the currency allows, when it
 *   is beyond the safe-integer range in minor units, or when the double is
 *   **ambiguous**: some decimal at least half a minor unit away (e.g.
 *   `45035996273704.955` USD) rounds to the same double, so the wire amount
 *   cannot be told apart from a different one. An accepted amount is exact
 *   whenever its wire text has no more fraction digits than the currency
 *   allows. Excess digits that change the value by less than the double can
 *   resolve (e.g. `0.30000000000000001`) are undetectable in principle: they
 *   parse to the same double as the amount without them.
 * - **Format.** A request amount must be a non-negative safe integer in minor
 *   units. Its decimal is built as a string and sent as the number whose JSON
 *   text is exactly that decimal, and only when that number also parses back
 *   to the same amount by the rules above. An amount with no such number (a
 *   decimal with more significant digits than a double keeps, or an ambiguous
 *   double) fails before anything is sent, so every amount this module sends
 *   is one it can read back from Airwallex's echo.
 *
 * @module
 */

import * as Effect from "effect/Effect";
import * as HashSet from "effect/HashSet";
import { PaymentInvalidRequestError } from "@thomasfosterau/effect-biz/Payments";
import {
  checkMinorUnits,
  decimalText,
  exponentFrom,
  formatDecimal,
  scaleToMinor,
} from "@thomasfosterau/effect-biz/Payments.internal";

// NOTE: the exponent table below started as Stripe's zero- and three-decimal
// list. The owner reviewed it on effect-finance#74 against search summaries of Airwallex's
// currency pages (the pages themselves were not read from the agent sandbox):
// ISK is zero-decimal; HUF, IDR and TWD keep their ISO 4217 exponent of 2,
// although Airwallex's fee-rounding page lists them as zero-decimal; IQD and
// LYD keep their ISO 4217 exponent of 3, as no Airwallex page covers them.

// Currencies with no minor unit (1 major unit == 1 minor unit).
const ZERO_DECIMAL = HashSet.make(
  "bif",
  "clp",
  "djf",
  "gnf",
  "isk",
  "jpy",
  "kmf",
  "krw",
  "mga",
  "pyg",
  "rwf",
  "ugx",
  "vnd",
  "vuv",
  "xaf",
  "xof",
  "xpf",
);

// Currencies with three decimal places.
const THREE_DECIMAL = HashSet.make("bhd", "iqd", "jod", "kwd", "lyd", "omr", "tnd");

/** The number of fraction digits used for `currency` (case-insensitive). */
export const exponent = exponentFrom(ZERO_DECIMAL, THREE_DECIMAL);

/**
 * A number's shortest decimal form as `String(n)` prints it: an optional sign,
 * whole digits, an optional fraction and an optional exponent.
 */
const NUMBER_TEXT = /^(-?)(\d+)(?:\.(\d+))?(?:e([+-]\d+))?$/;

/**
 * Whether a decimal half a minor unit either side of `magnitude` (in tenths
 * of a minor unit, one digit finer than the currency) rounds to the same
 * double as `major`: then wire amounts that differ in minor units, or that
 * carry excess decimals, all arrive as `major`.
 */
const isAmbiguous = (
  major: number,
  negative: boolean,
  magnitude: bigint,
  digits: number,
): boolean => {
  const tenths = magnitude * 10n;
  return (
    Number(decimalText(negative, tenths + 5n, digits + 1)) === major ||
    (tenths >= 5n && Number(decimalText(negative, tenths - 5n, digits + 1)) === major)
  );
};

/**
 * Parse an Airwallex major-unit amount into neutral minor units, or
 * `undefined` when it is not finite, has more fraction digits than the
 * currency allows, is outside the safe-integer range as minor units, or is a
 * double that more than one amount could have produced (see the module doc).
 *
 * The amount is read from `String(major)`, the shortest text that parses back
 * to the same double, never multiplied as a float.
 */
export const parseMinorUnits = (major: number, currency: string): number | undefined => {
  const match = NUMBER_TEXT.exec(String(major));
  if (match === null) return undefined;
  const [, sign, whole, fraction = "", exp = "0"] = match;
  // The value is `mantissa × 10^-scale`, with `scale` fraction digits.
  const mantissa = BigInt(`${whole}${fraction}`);
  const scale = fraction.length - Number(exp);
  const digits = exponent(currency);
  const magnitude = scaleToMinor(mantissa, scale, digits);
  if (magnitude === undefined) return undefined;
  const negative = sign === "-";
  if (isAmbiguous(major, negative, magnitude, digits)) return undefined;
  return negative ? -Number(magnitude) : Number(magnitude);
};

/**
 * Parse an Airwallex major-unit amount that has already been validated (the
 * response decoders check every amount with {@link parseMinorUnits}). Throws a
 * `RangeError` on an invalid value, which would be a bug in the caller.
 */
export const toMinorUnits = (major: number, currency: string): number => {
  const minor = parseMinorUnits(major, currency);
  if (minor === undefined) {
    throw new RangeError(`Unvalidated Airwallex amount for ${currency.toUpperCase()}`);
  }
  return minor;
};

/**
 * Format neutral minor units as the Airwallex major-unit number whose JSON
 * text is exactly their decimal, or `undefined` when `minor` is not a safe
 * integer or the number would not read back as `minor` through
 * {@link parseMinorUnits}: no double prints as the decimal (it has more
 * significant digits than a double keeps), or the double is ambiguous. An
 * amount this module could not decode from Airwallex's echo is never sent,
 * since a write whose response fails to decode is easy to retry into a
 * duplicate.
 */
export const formatMinorUnits = (minor: number, currency: string): number | undefined => {
  const text = formatDecimal(minor, exponent(currency));
  if (text === undefined) return undefined;
  const major = Number(text);
  // `JSON.stringify(major)` is `String(major)`, which `parseMinorUnits` reads.
  return parseMinorUnits(major, currency) === minor ? major : undefined;
};

/**
 * Format neutral minor units for a request body, failing as
 * `checkMinorUnits` does, or with {@link PaymentInvalidRequestError}
 * when the amount has no exact JSON number form.
 */
export const toMajorNumber = (
  minor: number,
  currency: string,
  param: string,
): Effect.Effect<number, PaymentInvalidRequestError> =>
  Effect.flatMap(checkMinorUnits(minor, param), () => {
    const value = formatMinorUnits(minor, currency);
    return value === undefined
      ? Effect.fail(
          new PaymentInvalidRequestError({
            message: `\`${param}\` cannot be sent to Airwallex as a JSON number that reads back exactly`,
            param,
          }),
        )
      : Effect.succeed(value);
  });
