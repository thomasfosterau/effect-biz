import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";
import * as Option from "effect/Option";
import * as BizError from "../src/BizError.ts";
import * as Decimal from "../src/Decimal.ts";
import * as Quantity from "../src/Quantity.ts";
import { failed, rejects, succeeded } from "./arbitraries.ts";

const unit = Schema.decodeSync(Quantity.UnitCode);
const qty = (amount: string, code: string) =>
  new Quantity.Quantity({ amount: Decimal.make(amount), unit: unit(code) });
const encodeAmount = Schema.encodeSync(Decimal.Decimal);

describe("Quantity", () => {
  it("adds and subtracts within a unit, exactly", () => {
    expect(encodeAmount(succeeded(Quantity.add(qty("0.1", "kg"), qty("0.2", "kg"))).amount)).toBe(
      "0.3",
    );
    expect(
      encodeAmount(succeeded(Quantity.subtract(qty("1", "kg"), qty("1.5", "kg"))).amount),
    ).toBe("-0.5");
  });

  it.each([
    ["add", Quantity.add],
    ["subtract", Quantity.subtract],
  ] as const)(
    "%s fails across units with core.unit-mismatch and both codes",
    (_name, operation) => {
      const violation = failed(operation(qty("1", "kg"), qty("1", "each")));
      expect(violation).toBeInstanceOf(BizError.BusinessRuleViolation);
      expect(violation.code).toBe("core.unit-mismatch");
      expect(violation.details).toEqual(Option.some({ left: "kg", right: "each" }));
    },
  );

  it("rejects an empty unit code", () => {
    expect(rejects(Quantity.UnitCode, "")).toBe(true);
  });

  it("round-trips through its encoded form", () => {
    const encoded = Schema.encodeSync(Quantity.Quantity)(qty("12.345", "kg"));
    expect(encoded).toEqual({ amount: "12.345", unit: "kg" });
    expect(Schema.decodeSync(Quantity.Quantity)(encoded).unit).toBe("kg");
  });

  it("NonNegativeQuantity accepts zero and rejects a negative amount", () => {
    expect(rejects(Quantity.NonNegativeQuantity, { amount: "0", unit: "kg" })).toBe(false);
    expect(rejects(Quantity.NonNegativeQuantity, { amount: "-0.001", unit: "kg" })).toBe(true);
  });
});
