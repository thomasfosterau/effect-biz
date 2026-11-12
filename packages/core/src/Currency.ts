/**
 * Currency codes and the one ISO 4217 minor-unit table.
 *
 * A {@link CurrencyCode} is three upper-case letters, branded. {@link minorUnits}
 * is the number of fraction digits the currency's smallest unit has (2 for the
 * dollar, 0 for the yen, 3 for the dinar); every module that converts between
 * major and minor units reads it from here.
 *
 * See {@link minorUnits} for an example.
 *
 * @module
 */

import * as HashSet from "effect/HashSet";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

/** The shape of an ISO 4217 alphabetic code: three upper-case letters. */
export const CurrencyCode = Schema.String.check(Schema.isPattern(/^[A-Z]{3}$/)).pipe(
  Schema.brand("CurrencyCode"),
);

/** An ISO 4217 alphabetic currency code, such as `"AUD"`. */
export type CurrencyCode = typeof CurrencyCode.Type;

/**
 * Parses a currency code and throws when it is not three upper-case letters:
 * for literals in code and tests, never for input (decode that with
 * {@link CurrencyCode}).
 */
export const make = (text: string): CurrencyCode => Schema.decodeSync(CurrencyCode)(text);

/** Currencies with no minor unit. */
const ZERO = HashSet.make(
  "JPY",
  "KRW",
  "VND",
  "CLP",
  "ISK",
  "UGX",
  "XAF",
  "XOF",
  "XPF",
  "KMF",
  "GNF",
  "PYG",
  "RWF",
  "VUV",
  "BIF",
  "DJF",
);

/** Currencies whose minor unit is a thousandth. */
const THREE = HashSet.make("BHD", "IQD", "JOD", "KWD", "LYD", "OMR", "TND");

/** Currencies whose minor unit is a ten-thousandth. */
const FOUR = HashSet.make("CLF", "UYW");

/**
 * The number of minor-unit digits of a currency (its ISO 4217 exponent): 0 for
 * `JPY`, 3 for `KWD`, 4 for `CLF`, and 2 for every other code.
 *
 * @example
 * ```ts
 * import * as Currency from "@thomasfosterau/effect-biz/Currency";
 *
 * console.log(Currency.minorUnits(Currency.make("AUD"))); // 2
 * console.log(Currency.minorUnits(Currency.make("JPY"))); // 0
 * console.log(Currency.minorUnits(Currency.make("KWD"))); // 3
 * ```
 */
export const minorUnits = (code: CurrencyCode): 0 | 2 | 3 | 4 =>
  Option.match(
    Option.firstSomeOf([
      Option.liftPredicate(0 as const, () => HashSet.has(ZERO, code)),
      Option.liftPredicate(3 as const, () => HashSet.has(THREE, code)),
      Option.liftPredicate(4 as const, () => HashSet.has(FOUR, code)),
    ]),
    { onNone: () => 2 as const, onSome: (digits) => digits },
  );
