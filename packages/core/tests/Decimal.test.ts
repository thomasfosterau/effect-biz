import { describe, expect, it } from "vite-plus/test";
import * as Arr from "effect/Array";
import * as BigDecimal from "effect/BigDecimal";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Decimal from "../src/Decimal.ts";
import * as Rounding from "../src/Rounding.ts";
import { counterexample, decimals, rejects, triples } from "./arbitraries.ts";

const policy = (mode: Rounding.RoundingMode, scale: number) =>
  new Rounding.RoundingPolicy({ mode, scale });
const encode = Schema.encodeSync(Decimal.Decimal);
const decode = Schema.decodeUnknownSync(Decimal.Decimal);

describe("Decimal schema", () => {
  it.each(["0", "1", "-1", "12.5", "-0.000000000001", "999999999999999.999999999999", "007"])(
    "decodes %s",
    (text) => {
      expect(BigDecimal.equals(decode(text), BigDecimal.fromStringUnsafe(text))).toBe(true);
    },
  );

  it.each(["1e5", "1E5", "", "+1", "1,000", " 1", "1 ", "1.", ".5", "--1", "0x10", "NaN", "1e-12"])(
    "rejects the string %j",
    (text) => {
      expect(rejects(Decimal.Decimal, text)).toBe(true);
    },
  );

  it.each([1.5, 1, null, undefined, {}, 10n])("rejects the non-string %s", (value) => {
    expect(rejects(Decimal.Decimal, value)).toBe(true);
  });

  it("encodes the shortest plain form, never an exponent", () => {
    expect(encode(Decimal.make("1.50"))).toBe("1.5");
    expect(encode(Decimal.make("-0"))).toBe("0");
    expect(encode(BigDecimal.make(1n, 30))).toBe(`0.${"0".repeat(29)}1`);
    expect(encode(BigDecimal.make(1n, -20))).toBe(`1${"0".repeat(20)}`);
  });

  it("round-trips every power of ten from 1e-12 to 1e15 without losing precision", () => {
    const powers = Arr.map(Arr.range(-12, 15), (exponent) => BigDecimal.make(1n, -exponent));
    expect(powers.every((value) => BigDecimal.equals(decode(encode(value)), value))).toBe(true);
    expect(encode(decode("1000000000000000.000000000001"))).toBe("1000000000000000.000000000001");
  });

  it("round-trips any generated decimal", () => {
    expect(
      counterexample(decimals, (value) => BigDecimal.equals(decode(encode(value)), value)),
    ).toEqual(Option.none());
    expect(
      counterexample(decimals, (value) => encode(decode(encode(value))) === encode(value)),
    ).toEqual(Option.none());
  });
});

describe("Decimal helpers", () => {
  it("make parses a literal and throws on anything else", () => {
    expect(BigDecimal.equals(Decimal.make("1.25"), BigDecimal.fromStringUnsafe("1.25"))).toBe(true);
    expect(() => Decimal.make("1e3")).toThrow("Expected a string matching");
  });

  it("fromString returns None for non-canonical text", () => {
    expect(Option.isSome(Decimal.fromString("1.5"))).toBe(true);
    expect(Option.isNone(Decimal.fromString("1e5"))).toBe(true);
    expect(Option.isNone(Decimal.fromString(""))).toBe(true);
  });

  it("has zero and one", () => {
    expect(BigDecimal.isZero(Decimal.zero)).toBe(true);
    expect(BigDecimal.equals(Decimal.one, Decimal.make("1"))).toBe(true);
  });

  it("format pads to a fixed scale and never rounds", () => {
    expect(Decimal.format(Decimal.make("2.5"), 2)).toEqual(Option.some("2.50"));
    expect(Decimal.format(Decimal.make("-0.05"), 3)).toEqual(Option.some("-0.050"));
    expect(Decimal.format(Decimal.make("12"), 0)).toEqual(Option.some("12"));
    expect(Decimal.format(Decimal.make("2.505"), 2)).toEqual(Option.none());
  });

  it("divide rounds with the policy and is None for a zero divisor", () => {
    const third = Decimal.divide(Decimal.make("1"), Decimal.make("3"), policy("half-even", 4));
    expect(Option.map(third, BigDecimal.format)).toEqual(Option.some("0.3333"));
    const half = Decimal.divide(Decimal.make("5"), Decimal.make("2"), policy("half-even", 0));
    expect(Option.map(half, BigDecimal.format)).toEqual(Option.some("2"));
    expect(
      Option.isNone(Decimal.divide(Decimal.make("1"), Decimal.zero, policy("half-even", 2))),
    ).toBe(true);
  });

  it("addition is commutative and associative", () => {
    expect(
      counterexample(triples, ({ a, b }) =>
        BigDecimal.equals(BigDecimal.sum(a, b), BigDecimal.sum(b, a)),
      ),
    ).toEqual(Option.none());
    expect(
      counterexample(triples, ({ a, b, c }) =>
        BigDecimal.equals(
          BigDecimal.sum(BigDecimal.sum(a, b), c),
          BigDecimal.sum(a, BigDecimal.sum(b, c)),
        ),
      ),
    ).toEqual(Option.none());
  });

  it("multiplication is commutative", () => {
    expect(
      counterexample(triples, ({ a, b }) =>
        BigDecimal.equals(BigDecimal.multiply(a, b), BigDecimal.multiply(b, a)),
      ),
    ).toEqual(Option.none());
  });
});
