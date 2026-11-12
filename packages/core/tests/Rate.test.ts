import { describe, expect, it } from "vite-plus/test";
import * as BigDecimal from "effect/BigDecimal";
import * as Decimal from "../src/Decimal.ts";
import * as Rate from "../src/Rate.ts";
import * as Rounding from "../src/Rounding.ts";
import { failed, rejects, succeeded } from "./arbitraries.ts";

const rate = (value: string) => new Rate.Rate({ value: Decimal.make(value) });
const policy = (scale: number) => new Rounding.RoundingPolicy({ mode: "half-even", scale });

describe("Rate", () => {
  it("must be greater than zero", () => {
    expect(() => rate("0")).toThrow("Schema validation failed");
    expect(() => rate("-1.5")).toThrow("Schema validation failed");
    expect(rejects(Rate.Rate, { value: "0" })).toBe(true);
    expect(rejects(Rate.Rate, { value: "0.0001" })).toBe(false);
  });

  it("make returns a violation for a value that cannot be a rate", () => {
    expect(failed(Rate.make(Decimal.zero)).code).toBe("core.rate-not-positive");
    expect(failed(Rate.make(Decimal.make("-2"))).code).toBe("core.rate-not-positive");
    expect(BigDecimal.format(succeeded(Rate.make(Decimal.make("0.5"))).value)).toBe("0.5");
  });

  it("applies with the policy it is given", () => {
    expect(BigDecimal.format(Rate.apply(Decimal.make("100"), rate("1.5432"), policy(2)))).toBe(
      "154.32",
    );
    expect(BigDecimal.format(Rate.apply(Decimal.make("1"), rate("1.5432"), policy(0)))).toBe("2");
  });

  it("inverts with the policy it is given", () => {
    expect(BigDecimal.format(succeeded(Rate.invert(rate("1.5432"), policy(6))).value)).toBe(
      "0.648004",
    );
    expect(BigDecimal.format(succeeded(Rate.invert(rate("4"), policy(6))).value)).toBe("0.25");
  });

  it("fails to invert when the reciprocal rounds to zero", () => {
    expect(failed(Rate.invert(rate("1000"), policy(2))).code).toBe("core.rate-not-positive");
  });
});
