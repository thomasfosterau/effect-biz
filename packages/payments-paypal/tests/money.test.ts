import { describe, it, expect } from "vite-plus/test";
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import { PaymentInvalidRequestError } from "@thomasfosterau/effect-biz/Payments";
import {
  exponent,
  formatMinorUnits,
  parseMinorUnits,
  toMajorString,
  toMinorUnits,
} from "../src/internal/money.ts";

/** A small seeded PRNG (mulberry32), so the property runs are reproducible. */
const prng = (seed: number) => () => {
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

/** A random safe integer, biased towards both small and very large magnitudes. */
const safeInteger = (next: () => number): number => {
  const bits = Math.floor(next() * 54);
  const magnitude = Math.floor(next() * 2 ** bits);
  return next() < 0.5 && magnitude !== 0 ? -magnitude : magnitude;
};

const CURRENCIES = [
  { code: "usd", digits: 2 },
  { code: "EUR", digits: 2 },
  { code: "jpy", digits: 0 },
  { code: "HUF", digits: 0 },
  { code: "twd", digits: 0 },
  { code: "krw", digits: 0 },
  { code: "kwd", digits: 3 },
  { code: "TND", digits: 3 },
] as const;

describe("PayPal money: currency exponents", () => {
  it("follows PayPal's table: HUF, JPY and TWD have no decimals", () => {
    Arr.forEach(CURRENCIES, ({ code, digits }) => expect(exponent(code)).toBe(digits));
  });
});

describe("PayPal money: round trip", () => {
  Arr.forEach(CURRENCIES, ({ code, digits }) => {
    it(`minor units -> string -> minor units is the identity for ${code}`, () => {
      const next = prng(0x5eed + digits);
      Arr.forEach(
        Arr.makeBy(2000, () => safeInteger(next)),
        (minor) => {
          const value = formatMinorUnits(minor, code);
          expect(value).toMatch(digits === 0 ? /^-?\d+$/ : new RegExp(`^-?\\d+\\.\\d{${digits}}$`));
          expect(parseMinorUnits(value ?? "", code)).toBe(minor);
        },
      );
    });
  });

  it("formats fixed examples exactly", () => {
    expect(formatMinorUnits(1000, "usd")).toBe("10.00");
    expect(formatMinorUnits(5, "usd")).toBe("0.05");
    expect(formatMinorUnits(0, "usd")).toBe("0.00");
    expect(formatMinorUnits(-1, "usd")).toBe("-0.01");
    expect(formatMinorUnits(-0, "usd")).toBe("0.00");
    expect(formatMinorUnits(1000, "huf")).toBe("1000");
    expect(formatMinorUnits(1000, "TWD")).toBe("1000");
    expect(formatMinorUnits(1000, "jpy")).toBe("1000");
    expect(formatMinorUnits(1, "kwd")).toBe("0.001");
    expect(formatMinorUnits(12345, "kwd")).toBe("12.345");
  });

  it("parses fixed examples exactly, padding a short fraction", () => {
    expect(parseMinorUnits("10.00", "usd")).toBe(1000);
    expect(parseMinorUnits("10", "usd")).toBe(1000);
    expect(parseMinorUnits("10.5", "usd")).toBe(1050);
    expect(parseMinorUnits("0.01", "usd")).toBe(1);
    expect(parseMinorUnits("-0.01", "usd")).toBe(-1);
    expect(parseMinorUnits("1000", "huf")).toBe(1000);
    expect(parseMinorUnits("12.3", "kwd")).toBe(12300);
  });

  it("never produces negative zero", () => {
    expect(Object.is(parseMinorUnits("-0.00", "usd"), 0)).toBe(true);
    expect(Object.is(parseMinorUnits("-0", "jpy"), 0)).toBe(true);
  });

  it("is exact at the edge of the safe-integer range, where a float parse is not", () => {
    // 90071992547409.91 USD is Number.MAX_SAFE_INTEGER cents.
    expect(parseMinorUnits("90071992547409.91", "usd")).toBe(Number.MAX_SAFE_INTEGER);
    // A float parse lands one cent off here; the integer parse does not.
    expect(Math.round(Number.parseFloat("45035996273704.95") * 100)).toBe(4503599627370496);
    expect(parseMinorUnits("45035996273704.95", "usd")).toBe(4503599627370495);
    expect(formatMinorUnits(Number.MAX_SAFE_INTEGER, "usd")).toBe("90071992547409.91");
    expect(formatMinorUnits(-Number.MAX_SAFE_INTEGER, "kwd")).toBe("-9007199254740.991");
    expect(parseMinorUnits("9007199254740991", "jpy")).toBe(Number.MAX_SAFE_INTEGER);
  });
});

describe("PayPal money: rejection", () => {
  it("rejects more fraction digits than the currency allows instead of rounding", () => {
    expect(parseMinorUnits("10.005", "usd")).toBeUndefined();
    expect(parseMinorUnits("10.001", "EUR")).toBeUndefined();
    expect(parseMinorUnits("10.5", "huf")).toBeUndefined();
    expect(parseMinorUnits("10.00", "TWD")).toBeUndefined();
    expect(parseMinorUnits("1.0", "jpy")).toBeUndefined();
    expect(parseMinorUnits("1.0001", "kwd")).toBeUndefined();
  });

  it("rejects an amount beyond the safe-integer range in minor units", () => {
    // One cent over Number.MAX_SAFE_INTEGER: a float parse would silently land
    // on a neighbouring value.
    expect(parseMinorUnits("90071992547409.93", "usd")).toBeUndefined();
    expect(parseMinorUnits("-90071992547409.93", "usd")).toBeUndefined();
    expect(parseMinorUnits("9007199254740993", "jpy")).toBeUndefined();
    expect(parseMinorUnits("1".repeat(40), "usd")).toBeUndefined();
  });

  it("rejects malformed strings", () => {
    Arr.forEach(
      [
        "",
        "ten",
        "1.",
        ".5",
        "+1",
        "1e3",
        "1,000.00",
        " 1.00",
        "1.00 ",
        "--1",
        "0x10",
        "Infinity",
        "NaN",
      ],
      (value) => expect(parseMinorUnits(value, "usd"), value).toBeUndefined(),
    );
  });

  it("toMinorUnits throws on a value the decoder would have rejected", () => {
    expect(toMinorUnits("10.05", "usd")).toBe(1005);
    expect(() => toMinorUnits("10.005", "usd")).toThrow(RangeError);
  });

  it("refuses to format an amount that is not a safe integer", () => {
    Arr.forEach([1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1], (minor) =>
      expect(formatMinorUnits(minor, "usd")).toBeUndefined(),
    );
  });

  it("toMajorString refuses a negative amount, which no request carries", async () => {
    expect(await Effect.runPromise(toMajorString(0, "usd", "amount"))).toBe("0.00");
    expect(await Effect.runPromise(toMajorString(-0, "usd", "amount"))).toBe("0.00");
    const error = await Effect.runPromise(Effect.flip(toMajorString(-1, "usd", "amount")));
    expect(error).toBeInstanceOf(PaymentInvalidRequestError);
    expect(error.param).toBe("amount");
  });

  it("toMajorString fails with an invalid-request error naming the parameter", async () => {
    expect(await Effect.runPromise(toMajorString(1000, "huf", "amount"))).toBe("1000");
    const error = await Effect.runPromise(Effect.flip(toMajorString(10.5, "usd", "unitAmount")));
    expect(error).toBeInstanceOf(PaymentInvalidRequestError);
    expect(error.param).toBe("unitAmount");
  });
});
