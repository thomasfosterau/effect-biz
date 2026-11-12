import { describe, expect, it } from "vite-plus/test";
import * as BigDecimal from "effect/BigDecimal";
import * as Schema from "effect/Schema";
import * as Decimal from "../src/Decimal.ts";
import * as Rounding from "../src/Rounding.ts";

const policy = (mode: Rounding.RoundingMode, scale: number) =>
  new Rounding.RoundingPolicy({ mode, scale });

describe("Rounding.round", () => {
  // [value, mode, scale, expected]
  const cases: ReadonlyArray<readonly [string, Rounding.RoundingMode, number, string]> = [
    ["2.5", "half-even", 0, "2"],
    ["3.5", "half-even", 0, "4"],
    ["-2.5", "half-even", 0, "-2"],
    ["-3.5", "half-even", 0, "-4"],
    ["2.4", "half-even", 0, "2"],
    ["2.6", "half-even", 0, "3"],
    ["1.005", "half-even", 2, "1"],
    ["1.015", "half-even", 2, "1.02"],
    ["2.5", "half-from-zero", 0, "3"],
    ["-2.5", "half-from-zero", 0, "-3"],
    ["2.4", "half-from-zero", 0, "2"],
    ["2.1", "from-zero", 0, "3"],
    ["-2.1", "from-zero", 0, "-3"],
    ["2.9", "to-zero", 0, "2"],
    ["-2.9", "to-zero", 0, "-2"],
    ["2.1", "ceil", 0, "3"],
    ["-2.9", "ceil", 0, "-2"],
    ["2.9", "floor", 0, "2"],
    ["-2.1", "floor", 0, "-3"],
    ["2.5", "half-to-zero", 0, "2"],
    ["2.5", "half-odd", 0, "3"],
    ["3.5", "half-odd", 0, "3"],
    ["1234.5", "half-even", -2, "1200"],
    ["1.5", "half-even", 3, "1.5"],
  ];

  it.each(cases)("rounds %s with %s at scale %i to %s", (value, mode, scale, expected) => {
    const rounded = Rounding.round(Decimal.make(value), policy(mode, scale));
    expect(BigDecimal.equals(rounded, Decimal.make(expected))).toBe(true);
  });

  it("rejects a non-integer scale and an unknown mode", () => {
    expect(() => policy("half-even", 1.5)).toThrow("Schema validation failed");
    expect(
      Schema.decodeUnknownExit(Rounding.RoundingPolicy)({ mode: "nearest", scale: 2 })._tag,
    ).toBe("Failure");
  });
});
