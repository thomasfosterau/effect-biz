import { describe, expect } from "vite-plus/test";
import { it } from "@effect/vitest";
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as BigDecimal from "effect/BigDecimal";
import * as Order from "effect/Order";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as BizError from "../src/BizError.ts";
import * as Currency from "../src/Currency.ts";
import * as Decimal from "../src/Decimal.ts";
import * as Money from "../src/Money.ts";
import * as Rounding from "../src/Rounding.ts";
import {
  allocations,
  counterexample,
  failed,
  minorAmounts,
  rejects,
  succeeded,
  triples,
} from "./arbitraries.ts";

const aud = Currency.make("AUD");
const jpy = Currency.make("JPY");
const kwd = Currency.make("KWD");
const usd = Currency.make("USD");
const money = (amount: string, currency = aud) => Money.make(Decimal.make(amount), currency);
const text = (value: Money.Money) => BigDecimal.format(value.amount);

describe("Money arithmetic", () => {
  it("adds, subtracts and sums exactly", () => {
    expect(text(succeeded(Money.add(money("0.1"), money("0.2"))))).toBe("0.3");
    expect(text(succeeded(Money.subtract(money("1"), money("1.75"))))).toBe("-0.75");
    expect(text(succeeded(Money.sum(aud, [money("1.10"), money("2.20"), money("3.30")])))).toBe(
      "6.6",
    );
    expect(text(succeeded(Money.sum(aud, [])))).toBe("0");
  });

  it.each([
    ["add", Money.add(money("1"), money("1", usd))],
    ["subtract", Money.subtract(money("1"), money("1", usd))],
    ["sum", Money.sum(aud, [money("1"), money("1", usd)])],
  ] as const)(
    "%s fails across currencies with core.currency-mismatch and both codes",
    (_name, result) => {
      const violation = failed(result);
      expect(violation).toBeInstanceOf(BizError.BusinessRuleViolation);
      expect(violation.code).toBe("core.currency-mismatch");
      expect(violation.details).toEqual({ left: "AUD", right: "USD" });
    },
  );

  it("multiplies without rounding", () => {
    expect(text(Money.multiply(money("19.99"), Decimal.make("3.333")))).toBe("66.62667");
  });

  it.effect("addition is commutative and associative", () =>
    Effect.gen(function* () {
      const m = (amount: BigDecimal.BigDecimal) => Money.make(amount, aud);
      expect(
        yield* counterexample(triples, ({ a, b }) =>
          Money.Equivalence(succeeded(Money.add(m(a), m(b))), succeeded(Money.add(m(b), m(a)))),
        ),
      ).toBeUndefined();
      expect(
        yield* counterexample(triples, ({ a, b, c }) =>
          Money.Equivalence(
            succeeded(Money.add(succeeded(Money.add(m(a), m(b))), m(c))),
            succeeded(Money.add(m(a), succeeded(Money.add(m(b), m(c))))),
          ),
        ),
      ).toBeUndefined();
    }),
  );

  it("zero, isZero and isNegative", () => {
    expect(Money.isZero(Money.zero(aud))).toBe(true);
    expect(Money.isZero(money("0.00"))).toBe(true);
    expect(Money.isZero(money("0.01"))).toBe(false);
    expect(Money.isNegative(money("-0.01"))).toBe(true);
    expect(Money.isNegative(money("0"))).toBe(false);
  });

  it("orders within a currency and compares value and currency for equivalence", () => {
    expect(Order.isLessThan(Money.Order)(money("1.5"), money("1.51"))).toBe(true);
    expect(Arr.sort([money("3"), money("-1"), money("2")], Money.Order).map(text)).toEqual([
      "-1",
      "2",
      "3",
    ]);
    expect(Money.Equivalence(money("1.5"), money("1.50"))).toBe(true);
    expect(Money.Equivalence(money("1.5"), money("1.5", usd))).toBe(false);
  });
});

describe("Money.round", () => {
  it("defaults to the currency's minor units, half-even", () => {
    expect(text(Money.round(money("2.345")))).toBe("2.34");
    expect(text(Money.round(money("2.355")))).toBe("2.36");
    expect(text(Money.round(money("2.5", jpy)))).toBe("2");
    expect(text(Money.round(money("3.5", jpy)))).toBe("4");
    expect(text(Money.round(money("0.0005", kwd)))).toBe("0");
    expect(text(Money.round(money("0.0015", kwd)))).toBe("0.002");
  });

  it("takes an explicit policy", () => {
    const up = new Rounding.RoundingPolicy({ mode: "half-from-zero", scale: 2 });
    expect(text(Money.round(money("2.345"), up))).toBe("2.35");
    const four = new Rounding.RoundingPolicy({ mode: "to-zero", scale: 4 });
    expect(text(Money.round(money("1.23456789"), four))).toBe("1.2345");
  });
});

describe("minor units", () => {
  it("converts to and from minor units per currency", () => {
    expect(succeeded(Money.toMinorUnits(money("12.34")))).toBe(1234n);
    expect(succeeded(Money.toMinorUnits(money("12.3")))).toBe(1230n);
    expect(succeeded(Money.toMinorUnits(money("-0.05")))).toBe(-5n);
    expect(succeeded(Money.toMinorUnits(money("500", jpy)))).toBe(500n);
    expect(succeeded(Money.toMinorUnits(money("1.234", kwd)))).toBe(1234n);
    expect(text(Money.fromMinorUnits(1234n, aud))).toBe("12.34");
    expect(text(Money.fromMinorUnits(500n, jpy))).toBe("500");
    expect(Money.fromMinorUnits(-5n, aud).currency).toBe("AUD");
  });

  it("fails with core.money-scale when the amount is finer than the minor unit", () => {
    const violation = failed(Money.toMinorUnits(money("12.345")));
    expect(violation.code).toBe("core.money-scale");
    expect(violation.details).toEqual({ amount: "12.345", currency: "AUD" });
    expect(failed(Money.toMinorUnits(money("0.5", jpy))).code).toBe("core.money-scale");
  });

  it.effect("round-trips whole minor units", () =>
    Effect.gen(function* () {
      expect(
        yield* counterexample(
          minorAmounts,
          (minor) =>
            Result.getOrUndefined(Money.toMinorUnits(Money.fromMinorUnits(minor, aud))) === minor,
        ),
      ).toBeUndefined();
    }),
  );
});

describe("Money.allocate", () => {
  const split = (amount: string, ratios: Arr.NonEmptyReadonlyArray<string>, currency = aud) =>
    Money.allocate(money(amount, currency), Arr.map(ratios, Decimal.make));
  const parts = (...args: Parameters<typeof split>) => succeeded(split(...args)).map(text);

  it("splits by largest remainder and the parts sum to the total", () => {
    expect(parts("100", ["1", "1", "1"])).toEqual(["33.34", "33.33", "33.33"]);
    expect(parts("0.05", ["3", "7"])).toEqual(["0.02", "0.03"]);
    expect(parts("10", ["1"])).toEqual(["10"]);
    expect(parts("100", ["0.5", "0.25", "0.25"])).toEqual(["50", "25", "25"]);
    expect(parts("1000", ["1", "1", "1"], jpy)).toEqual(["334", "333", "333"]);
    expect(parts("0.001", ["1", "1"], kwd)).toEqual(["0.001", "0"]);
  });

  it("gives a remainder tie to the earlier ratio and allows zero ratios", () => {
    expect(parts("0.02", ["1", "1", "1"])).toEqual(["0.01", "0.01", "0"]);
    expect(parts("1", ["0", "1", "0"])).toEqual(["0", "1", "0"]);
  });

  it("rounds the total to minor units first and splits a negative total", () => {
    expect(parts("10.005", ["1", "1"])).toEqual(["5", "5"]);
    expect(parts("-100", ["1", "1", "1"])).toEqual(["-33.34", "-33.33", "-33.33"]);
  });

  it.each([
    ["a negative ratio", ["1", "-1"]],
    ["ratios summing to zero", ["0", "0"]],
  ] as const)("fails on %s", (_name, ratios) => {
    expect(failed(split("10", ratios)).code).toBe("core.invalid-allocation");
  });

  it.effect("always sums exactly to the rounded total", () =>
    Effect.gen(function* () {
      expect(
        yield* counterexample(allocations, ({ minor, first, rest, currency }) => {
          const code = Currency.make(currency);
          const total = Money.fromMinorUnits(BigInt(minor), code);
          const ratios = Arr.map(Arr.make(first, ...rest), (n) => BigDecimal.fromBigInt(BigInt(n)));
          const allocated = Money.allocate(total, ratios);
          const summed = Result.flatMap(allocated, (all) => Money.sum(code, all));
          return (
            Result.getOrUndefined(Result.map(allocated, (all) => all.length)) === ratios.length &&
            Result.getOrUndefined(Result.map(summed, (sum) => Money.Equivalence(sum, total))) ===
              true &&
            Result.getOrUndefined(
              Result.map(allocated, (all) =>
                all.every((part) => Result.isSuccess(Money.toMinorUnits(part))),
              ),
            ) === true
          );
        }),
      ).toBeUndefined();
    }),
  );
});

describe("Money schema", () => {
  it("encodes the amount as a decimal string beside the currency", () => {
    const encoded = Schema.encodeSync(Money.Money)(money("12.50"));
    expect(encoded).toEqual({ amount: "12.5", currency: "AUD" });
    expect(Schema.decodeSync(Money.Money)(encoded).currency).toBe("AUD");
  });

  it("rejects a numeric amount and a malformed currency", () => {
    expect(rejects(Money.Money, { amount: 12.5, currency: "AUD" })).toBe(true);
    expect(rejects(Money.Money, { amount: "12.5", currency: "aud" })).toBe(true);
  });
});
