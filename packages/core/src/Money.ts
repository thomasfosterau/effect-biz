/**
 * Exact money: a decimal amount in a currency.
 *
 * An amount is a `BigDecimal`, never a JavaScript `number`, and carries as
 * many fraction digits as the calculation needs; nothing rounds unless asked
 * to ({@link round}, with the currency's minor units and half-even by
 * default). Combining two currencies is a mistake, so {@link add},
 * {@link subtract} and {@link sum} refuse it with a `BusinessRuleViolation`
 * (code `"core.currency-mismatch"`) in a `Result` rather than throwing.
 *
 * This is distinct from the payments `Money` (`./Payments.Money`: integer
 * minor units in a `number`, the providers' wire format). Convert at the
 * gateway edge with {@link toMinorUnits} and {@link fromMinorUnits}.
 *
 * See {@link Money} for an example.
 *
 * @module
 */

import * as Arr from "effect/Array";
import * as BigDecimal from "effect/BigDecimal";
import * as Eq from "effect/Equivalence";
import * as HashSet from "effect/HashSet";
import * as O from "effect/Order";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import { BusinessRuleViolation } from "./BizError.js";
import { CurrencyCode, minorUnits } from "./Currency.js";
import { Decimal } from "./Decimal.js";
import { round as roundDecimal, RoundingPolicy } from "./Rounding.js";

/**
 * An exact amount in a currency. Its encoded form is
 * `{ amount: "12.50", currency: "AUD" }`.
 *
 * @example
 * ```ts
 * import { BigDecimal, Result } from "effect";
 * import * as Currency from "@thomasfosterau/effect-biz/Currency";
 * import * as Decimal from "@thomasfosterau/effect-biz/Decimal";
 * import * as Money from "@thomasfosterau/effect-biz/Money";
 *
 * const aud = Currency.make("AUD");
 * const price = Money.make(Decimal.make("19.99"), aud);
 *
 * // 19.99 x 3.3 = 65.967, rounded to cents only at the end.
 * const gross = Money.multiply(price, Decimal.make("3.3"));
 * console.log(BigDecimal.format(Money.round(gross).amount)); // "65.97"
 *
 * // 100.00 split three ways: the parts sum exactly to the total.
 * const parts = Money.allocate(Money.make(Decimal.make("100"), aud), [
 *   Decimal.make("1"),
 *   Decimal.make("1"),
 *   Decimal.make("1"),
 * ]);
 * console.log(Result.isSuccess(parts) && parts.success.map((part) => BigDecimal.format(part.amount))); // ["33.34", "33.33", "33.33"]
 *
 * const usd = Money.make(Decimal.make("1"), Currency.make("USD"));
 * const mixed = Money.add(price, usd);
 * console.log(Result.isFailure(mixed) && mixed.failure.code); // "core.currency-mismatch"
 * ```
 */
export class Money extends Schema.Class<Money, { readonly brand: unique symbol }>(
  "@effect-biz/Money/Money",
)({
  /** The exact amount, in major units (`"12.50"` dollars). */
  amount: Decimal,
  /** The currency the amount is in. */
  currency: CurrencyCode,
}) {}

/** An amount in a currency. */
export const make = (amount: BigDecimal.BigDecimal, currency: CurrencyCode): Money =>
  new Money({ amount, currency });

/** Zero in a currency. */
export const zero = (currency: CurrencyCode): Money => make(BigDecimal.fromBigInt(0n), currency);

/** The violation for two amounts in different currencies. */
const currencyMismatch = (left: CurrencyCode, right: CurrencyCode): BusinessRuleViolation =>
  new BusinessRuleViolation({
    code: "core.currency-mismatch",
    reason: `Cannot combine amounts in ${left} and ${right}`,
    details: { left, right },
  });

/** Combines two amounts, or fails when their currencies differ. */
const combine = (
  left: Money,
  right: Money,
  operation: (a: BigDecimal.BigDecimal, b: BigDecimal.BigDecimal) => BigDecimal.BigDecimal,
): Result.Result<Money, BusinessRuleViolation> =>
  left.currency === right.currency
    ? Result.succeed(make(operation(left.amount, right.amount), left.currency))
    : Result.fail(currencyMismatch(left.currency, right.currency));

/** The sum of two amounts in the same currency, or a `core.currency-mismatch` violation. */
export const add = (left: Money, right: Money): Result.Result<Money, BusinessRuleViolation> =>
  combine(left, right, BigDecimal.sum);

/** The difference of two amounts in the same currency, or a `core.currency-mismatch` violation. */
export const subtract = (left: Money, right: Money): Result.Result<Money, BusinessRuleViolation> =>
  combine(left, right, BigDecimal.subtract);

/** The running total a {@link sum} starts from. */
const start = (currency: CurrencyCode): Result.Result<Money, BusinessRuleViolation> =>
  Result.succeed(zero(currency));

/**
 * The sum of any number of amounts in a currency (zero for none), or a
 * `core.currency-mismatch` violation when one is in another currency.
 */
export const sum = (
  currency: CurrencyCode,
  amounts: Iterable<Money>,
): Result.Result<Money, BusinessRuleViolation> =>
  Arr.reduce(amounts, start(currency), (total, amount) =>
    Result.flatMap(total, (running) => add(running, amount)),
  );

/** An amount multiplied by an exact factor, unrounded. */
export const multiply = (money: Money, factor: BigDecimal.BigDecimal): Money =>
  make(BigDecimal.multiply(money.amount, factor), money.currency);

/** The policy {@link round} applies when given none: the currency's minor units, half-even. */
const defaultPolicy = (currency: CurrencyCode): RoundingPolicy =>
  new RoundingPolicy({ mode: "half-even", scale: minorUnits(currency) });

/**
 * An amount rounded with a policy; without one, to the currency's minor units
 * with half-even (banker's) rounding.
 */
export const round = (money: Money, policy?: RoundingPolicy): Money =>
  make(roundDecimal(money.amount, policy ?? defaultPolicy(money.currency)), money.currency);

/** The violation for an amount that does not sit on the currency's minor units. */
const moneyScale = (money: Money): BusinessRuleViolation =>
  new BusinessRuleViolation({
    code: "core.money-scale",
    reason: `${money.currency} has ${minorUnits(money.currency)} minor-unit digits`,
    details: { amount: BigDecimal.format(money.amount), currency: money.currency },
  });

/**
 * An amount as a whole number of the currency's minor units (cents), or a
 * `core.money-scale` violation when it has finer fraction digits: round it
 * first, so no digit is ever dropped silently.
 */
export const toMinorUnits = (money: Money): Result.Result<bigint, BusinessRuleViolation> => {
  const digits = minorUnits(money.currency);
  return BigDecimal.normalize(money.amount).scale <= digits
    ? Result.succeed(BigDecimal.scale(money.amount, digits).value)
    : Result.fail(moneyScale(money));
};

/** The amount of a whole number of a currency's minor units (cents). */
export const fromMinorUnits = (minor: bigint, currency: CurrencyCode): Money =>
  make(BigDecimal.make(minor, minorUnits(currency)), currency);

/** The violation for ratios that cannot split an amount. */
const invalidRatios = (reason: string): BusinessRuleViolation =>
  new BusinessRuleViolation({ code: "core.invalid-allocation", reason });

/** The integer weights of ratios at their common scale. */
const weights = (
  ratios: Arr.NonEmptyReadonlyArray<BigDecimal.BigDecimal>,
): Arr.NonEmptyReadonlyArray<bigint> => {
  const scale = Math.max(0, ...Arr.map(ratios, (ratio) => BigDecimal.normalize(ratio).scale));
  return Arr.map(ratios, (ratio) => BigDecimal.scale(ratio, scale).value);
};

/** One ratio's position and its remainder after the whole-unit split. */
interface Share {
  readonly index: number;
  readonly remainder: bigint;
}

/** Splits a non-negative whole number of minor units by weights (largest remainder). */
const split = (
  total: bigint,
  weight: Arr.NonEmptyReadonlyArray<bigint>,
): Arr.NonEmptyReadonlyArray<bigint> => {
  const denominator = Arr.reduce(weight, 0n, (a, b) => a + b);
  const floors = Arr.map(weight, (w) => (total * w) / denominator);
  const leftover = Number(total - Arr.reduce(floors, 0n, (a, b) => a + b));
  const bumped = HashSet.fromIterable(
    Arr.sort(
      Arr.map(weight, (w, index) => ({ index, remainder: (total * w) % denominator })),
      O.combine(
        O.mapInput(O.flip(O.BigInt), (entry: Share) => entry.remainder),
        O.mapInput(O.Number, (entry: Share) => entry.index),
      ),
    )
      .slice(0, leftover)
      .map((entry) => entry.index),
  );
  return Arr.map(floors, (floor, index) => (HashSet.has(bumped, index) ? floor + 1n : floor));
};

/**
 * Splits an amount in proportion to ratios, by the largest-remainder method:
 * the amount is rounded to the currency's minor units first (half-even), each
 * part is a whole number of minor units, and the parts sum exactly to the
 * rounded total. Leftover minor units go to the largest remainders, the
 * earlier ratio first on a tie. Fails with `core.invalid-allocation` when a
 * ratio is negative or the ratios sum to zero.
 */
export const allocate = (
  money: Money,
  ratios: Arr.NonEmptyReadonlyArray<BigDecimal.BigDecimal>,
): Result.Result<Arr.NonEmptyReadonlyArray<Money>, BusinessRuleViolation> => {
  const weight = weights(ratios);
  if (weight.some((w) => w < 0n)) return Result.fail(invalidRatios("A ratio must not be negative"));
  if (Arr.reduce(weight, 0n, (a, b) => a + b) === 0n) {
    return Result.fail(invalidRatios("The ratios must not sum to zero"));
  }
  const total = BigDecimal.scale(round(money).amount, minorUnits(money.currency)).value;
  const negative = total < 0n;
  const parts = split(negative ? -total : total, weight);
  return Result.succeed(
    Arr.map(parts, (part) => fromMinorUnits(negative ? -part : part, money.currency)),
  );
};

/** Whether an amount is exactly zero. */
export const isZero = (money: Money): boolean => BigDecimal.isZero(money.amount);

/** Whether an amount is below zero. */
export const isNegative = (money: Money): boolean => BigDecimal.isNegative(money.amount);

/**
 * Orders amounts by value. Only meaningful within one currency: it compares
 * amounts and ignores the currency, so check currencies match first.
 */
export const Order: O.Order<Money> = O.mapInput(BigDecimal.Order, (money: Money) => money.amount);

/** Amounts are equal when their currencies match and their values are equal (`1.5` equals `1.50`). */
export const Equivalence: Eq.Equivalence<Money> = Eq.make(
  (left, right) => left.currency === right.currency && BigDecimal.equals(left.amount, right.amount),
);
