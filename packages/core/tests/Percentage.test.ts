import { describe, expect, it } from "vite-plus/test";
import * as BigDecimal from "effect/BigDecimal";
import * as Schema from "effect/Schema";
import * as Decimal from "../src/Decimal.ts";
import * as Percentage from "../src/Percentage.ts";
import * as Rounding from "../src/Rounding.ts";

const pct = (value: string) => new Percentage.Percentage({ value: Decimal.make(value) });
const cents = new Rounding.RoundingPolicy({ mode: "half-even", scale: 2 });

describe("Percentage", () => {
  it("12.5 percent is the factor 0.125 and back, exactly", () => {
    expect(BigDecimal.format(Percentage.toFactor(pct("12.5")))).toBe("0.125");
    expect(BigDecimal.format(Percentage.fromFactor(Decimal.make("0.125")).value)).toBe("12.5");
    expect(BigDecimal.format(Percentage.toFactor(pct("100")))).toBe("1");
    expect(BigDecimal.format(Percentage.toFactor(pct("0.01")))).toBe("0.0001");
  });

  it("takes a percentage of a base with the given policy", () => {
    expect(BigDecimal.format(Percentage.of(Decimal.make("200"), pct("12.5"), cents))).toBe("25");
    expect(BigDecimal.format(Percentage.of(Decimal.make("12.345"), pct("10"), cents))).toBe("1.23");
    const up = new Rounding.RoundingPolicy({ mode: "from-zero", scale: 2 });
    expect(BigDecimal.format(Percentage.of(Decimal.make("12.345"), pct("10"), up))).toBe("1.24");
  });

  it("encodes the value as a decimal string", () => {
    expect(Schema.encodeSync(Percentage.Percentage)(pct("12.5"))).toEqual({ value: "12.5" });
  });
});
