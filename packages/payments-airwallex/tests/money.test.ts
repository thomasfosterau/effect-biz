import { describe, it, expect } from "vite-plus/test";
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import { PaymentInvalidRequestError } from "@thomasfosterau/effect-biz/Payments";
import {
  exponent,
  formatMinorUnits,
  parseMinorUnits,
  toMajorNumber,
  toMinorUnits,
} from "../src/internal/money.ts";

/** `JSON.stringify` through `Schema`: the JSON text a value is sent as. */
const toJsonText = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

/** `JSON.parse` of a number's JSON text through `Schema`. */
const numberFromJsonText = Schema.decodeSync(Schema.fromJsonString(Schema.Number));

/** A small seeded PRNG (mulberry32), so the property runs are reproducible. */
const prng = (seed: number) => () => {
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

/** A random non-negative safe integer, biased towards both small and very large magnitudes. */
const safeInteger = (next: () => number): number =>
  Math.floor(next() * 2 ** Math.floor(next() * 54));

const CURRENCIES = [
  { code: "usd", digits: 2 },
  { code: "EUR", digits: 2 },
  { code: "jpy", digits: 0 },
  { code: "KRW", digits: 0 },
  { code: "kwd", digits: 3 },
  { code: "BHD", digits: 3 },
] as const;

describe("Airwallex money: currency exponents", () => {
  it("keeps the table: zero, two and three decimals", () => {
    Arr.forEach(CURRENCIES, ({ code, digits }) => expect(exponent(code)).toBe(digits));
  });

  it("treats ISK as zero-decimal (effect-finance#74)", () => {
    expect(exponent("isk")).toBe(0);
    expect(exponent("ISK")).toBe(0);
    expect(parseMinorUnits(2000, "isk")).toBe(2000);
    expect(parseMinorUnits(20.5, "isk")).toBeUndefined();
  });

  it("keeps HUF, IDR and TWD at two decimals, their ISO 4217 exponent (effect-finance#74)", () => {
    Arr.forEach(["huf", "idr", "twd", "HUF", "IDR", "TWD"], (code) =>
      expect(exponent(code)).toBe(2),
    );
    expect(parseMinorUnits(20.5, "huf")).toBe(2050);
  });

  it("keeps IQD and LYD at three decimals, their ISO 4217 exponent (effect-finance#74)", () => {
    Arr.forEach(["iqd", "lyd"], (code) => expect(exponent(code)).toBe(3));
  });
});

describe("Airwallex money: parse", () => {
  it("reads amounts exactly from their decimal form", () => {
    expect(parseMinorUnits(20, "usd")).toBe(2000);
    expect(parseMinorUnits(20.5, "usd")).toBe(2050);
    expect(parseMinorUnits(0.05, "usd")).toBe(5);
    expect(parseMinorUnits(1.005, "kwd")).toBe(1005);
    expect(parseMinorUnits(2000, "jpy")).toBe(2000);
    expect(parseMinorUnits(-12.34, "usd")).toBe(-1234);
    expect(Object.is(parseMinorUnits(-0, "usd"), 0)).toBe(true);
  });

  it("rejects an amount with more decimals than the currency allows (effect-finance#68: 10.005 USD)", () => {
    expect(parseMinorUnits(10.005, "usd")).toBeUndefined();
    expect(parseMinorUnits(10.5, "jpy")).toBeUndefined();
    expect(parseMinorUnits(1.0005, "kwd")).toBeUndefined();
    // A float sum whose shortest form carries the float error is not rounded away.
    expect(parseMinorUnits(0.1 + 0.2, "usd")).toBeUndefined();
    expect(() => toMinorUnits(10.005, "usd")).toThrow(RangeError);
  });

  it("parses a large unambiguous amount exactly", () => {
    // Below 2^45 major units, doubles are finer than half a cent, so every
    // two-decimal USD amount has a double of its own.
    expect(parseMinorUnits(35184372088831.99, "usd")).toBe(3518437208883199);
    expect(toMinorUnits(35184372088831.99, "usd")).toBe(3518437208883199);
    expect(parseMinorUnits(45035996273704.96, "usd")).toBe(4503599627370496);
    expect(parseMinorUnits(9007199254740991, "jpy")).toBe(9007199254740991);
  });

  it("rejects a double that more than one wire amount could have produced (effect-finance#68: 45035996273704.95 USD)", () => {
    // `45035996273704.95` and `45035996273704.955` parse to the same double,
    // so the amount cannot be told apart from one with excess decimals. The
    // float conversion this replaces read it as 4503599627370496.
    expect(Number("45035996273704.955")).toBe(Number("45035996273704.95"));
    expect(parseMinorUnits(Number("45035996273704.95"), "usd")).toBeUndefined();
    expect(parseMinorUnits(Number("45035996273704.955"), "usd")).toBeUndefined();
    expect(() => toMinorUnits(45035996273704.95, "usd")).toThrow(RangeError);
    // `90071992547409.91` and `90071992547409.9` parse to the same double: a
    // shortest-form read would decode the former one cent short.
    expect(Number("90071992547409.91")).toBe(Number("90071992547409.9"));
    expect(parseMinorUnits(Number("90071992547409.91"), "usd")).toBeUndefined();
    expect(parseMinorUnits(Number("90071992547409.9"), "usd")).toBeUndefined();
  });

  it("rejects an amount whose LOWER half-unit neighbour shares its double (2^45..2^46 USD)", () => {
    // Above 2^45 major a double is 2^-7 apart, so 35184372088832.005 and
    // 35184372088832.01 share a double while 35184372088832.015 does not:
    // only the `m - half a minor unit` check refuses it.
    expect(Number("35184372088832.005")).toBe(Number("35184372088832.01"));
    expect(Number("35184372088832.015")).not.toBe(Number("35184372088832.01"));
    expect(parseMinorUnits(Number("35184372088832.01"), "usd")).toBeUndefined();
    expect(parseMinorUnits(Number("35184372088832.05"), "usd")).toBeUndefined();
  });

  it("rejects ambiguous three-decimal amounts above 2^42 major (KWD)", () => {
    expect(parseMinorUnits(4398046511103.999, "kwd")).toBeDefined();
    expect(parseMinorUnits(4398046511104.001, "kwd")).toBeUndefined();
    expect(parseMinorUnits(4398046511104.003, "kwd")).toBeUndefined();
  });

  it("rejects an even zero-decimal integer in 2^52..2^53 (JPY) but reads odd ones", () => {
    expect(parseMinorUnits(2 ** 52, "jpy")).toBeUndefined();
    expect(parseMinorUnits(2 ** 52 + 2, "jpy")).toBeUndefined();
    expect(parseMinorUnits(2 ** 53 - 2, "jpy")).toBeUndefined();
    expect(parseMinorUnits(2 ** 52 + 1, "jpy")).toBe(2 ** 52 + 1);
    expect(parseMinorUnits(2 ** 53 - 1, "jpy")).toBe(2 ** 53 - 1);
  });

  it("decodes every sampled accepted amount in 2^44..2^46 USD to exactly its minor units", () => {
    // About 53k samples: enough of both outcomes, well inside the default test timeout.
    const step = 100_000_000_003n;
    const start = 2n ** 44n * 100n;
    const end = 2n ** 46n * 100n;
    const samples = Arr.makeBy(Number((end - start + step - 1n) / step), (i) => {
      const minor = start + BigInt(i) * step;
      const text = minor.toString();
      const parsed = parseMinorUnits(Number(`${text.slice(0, -2)}.${text.slice(-2)}`), "usd");
      return { minor, parsed };
    });
    const accepted = Arr.filterMap(samples, ({ minor, parsed }) =>
      parsed === undefined ? Result.failVoid : Result.succeed({ minor, parsed: BigInt(parsed) }),
    );
    const refused = samples.length - accepted.length;
    // Every accepted amount decodes to exactly its minor units.
    expect(Arr.map(accepted, ({ parsed }) => parsed)).toEqual(
      Arr.map(accepted, ({ minor }) => minor),
    );
    // Both outcomes occur, so the sweep cannot pass vacuously.
    expect(accepted.length).toBeGreaterThan(1000);
    expect(refused).toBeGreaterThan(1000);
  });

  it("never decodes an amount near the top of the safe range to the wrong minor units", () => {
    const decoded = Arr.filterMap(
      Arr.makeBy(20000, (i) => Number.MAX_SAFE_INTEGER - i),
      (minor) => {
        const text = String(minor);
        const parsed = parseMinorUnits(Number(`${text.slice(0, -2)}.${text.slice(-2)}`), "usd");
        return parsed === undefined ? Result.failVoid : Result.succeed({ minor, parsed });
      },
    );
    Arr.forEach(decoded, ({ minor, parsed }) => expect(parsed).toBe(minor));
  });

  it("rejects an amount outside the safe-integer range in minor units", () => {
    expect(parseMinorUnits(90071992547410, "usd")).toBeUndefined();
    expect(parseMinorUnits(9007199254740992, "jpy")).toBeUndefined();
    expect(parseMinorUnits(-90071992547410, "usd")).toBeUndefined();
  });

  it("reads exponent notation exactly instead of rounding it", () => {
    // `String(n)` switches to exponent notation below 1e-6 and from 1e21; no
    // such amount fits a currency here, so each is rejected, not rounded.
    expect(String(1e-7)).toBe("1e-7");
    expect(parseMinorUnits(1e-7, "usd")).toBeUndefined();
    expect(parseMinorUnits(-2.5e-7, "kwd")).toBeUndefined();
    expect(String(1e21)).toBe("1e+21");
    expect(parseMinorUnits(1e21, "jpy")).toBeUndefined();
    expect(parseMinorUnits(1.5e21, "usd")).toBeUndefined();
  });

  it("rejects non-finite amounts", () => {
    expect(parseMinorUnits(Number.NaN, "usd")).toBeUndefined();
    expect(parseMinorUnits(Number.POSITIVE_INFINITY, "usd")).toBeUndefined();
  });
});

describe("Airwallex money: format", () => {
  it("formats fixed examples as numbers whose JSON text is the exact decimal", () => {
    expect(toJsonText(formatMinorUnits(2000, "usd"))).toBe("20");
    expect(toJsonText(formatMinorUnits(2050, "usd"))).toBe("20.5");
    expect(toJsonText(formatMinorUnits(5, "usd"))).toBe("0.05");
    expect(toJsonText(formatMinorUnits(5, "kwd"))).toBe("0.005");
    expect(toJsonText(formatMinorUnits(2000, "jpy"))).toBe("2000");
    expect(toJsonText(formatMinorUnits(3518437208883199, "usd"))).toBe("35184372088831.99");
  });

  Arr.forEach(CURRENCIES, ({ code, digits }) => {
    it(`minor units -> number -> minor units never changes the amount, for ${code}`, () => {
      const next = prng(0x5eed + digits);
      const sent = Arr.filterMap(
        Arr.makeBy(2000, () => safeInteger(next)),
        (minor) => {
          const major = formatMinorUnits(minor, code);
          return major === undefined ? Result.failVoid : Result.succeed({ minor, major });
        },
      );
      Arr.forEach(sent, ({ minor, major }) => {
        const parsed = parseMinorUnits(numberFromJsonText(toJsonText(major)), code);
        // Every amount that is sent reads back as exactly itself.
        expect(parsed).toBe(minor);
      });
    });
  });

  it("formats every safe integer up to 15 digits", () => {
    const next = prng(0xa1e);
    Arr.forEach(
      Arr.makeBy(2000, () => Math.floor(next() * 1e15)),
      (minor) =>
        Arr.forEach(CURRENCIES, ({ code }) => expect(formatMinorUnits(minor, code)).toBeDefined()),
    );
  });

  it("refuses an amount no JSON number carries exactly", () => {
    // 90071992547409.91 has 16 significant digits; its nearest double prints
    // as 90071992547409.9, which would charge a different amount.
    expect(String(Number.MAX_SAFE_INTEGER / 100)).toBe("90071992547409.9");
    expect(formatMinorUnits(Number.MAX_SAFE_INTEGER, "usd")).toBeUndefined();
    expect(formatMinorUnits(Number.MAX_SAFE_INTEGER, "jpy")).toBe(Number.MAX_SAFE_INTEGER);
  });

  it("refuses an amount the parser would refuse (effect-finance#73 follow-up: 4503599627370495 USD)", () => {
    // The double for 45035996273704.95 is ambiguous, so Airwallex's echo of it
    // could not be decoded; sending it would invite a duplicate on retry.
    expect(parseMinorUnits(Number("45035996273704.95"), "usd")).toBeUndefined();
    expect(formatMinorUnits(4503599627370495, "usd")).toBeUndefined();
    expect(formatMinorUnits(3518437208883201, "usd")).toBeUndefined();
    expect(formatMinorUnits(2 ** 52, "jpy")).toBeUndefined();
    expect(formatMinorUnits(4398046511104001, "kwd")).toBeUndefined();
  });

  it("refuses an amount that is not a safe integer", () => {
    expect(formatMinorUnits(10.5, "usd")).toBeUndefined();
    expect(formatMinorUnits(2 ** 53, "jpy")).toBeUndefined();
    expect(formatMinorUnits(Number.NaN, "usd")).toBeUndefined();
  });
});

describe("Airwallex money: request amounts", () => {
  it("toMajorNumber succeeds with the exact number", async () => {
    expect(await Effect.runPromise(toMajorNumber(1234, "usd", "amount"))).toBe(12.34);
    expect(await Effect.runPromise(toMajorNumber(0, "usd", "amount"))).toBe(0);
    expect(Object.is(await Effect.runPromise(toMajorNumber(-0, "usd", "amount")), 0)).toBe(true);
  });

  it("toMajorNumber fails with an invalid-request error naming the parameter", async () => {
    const errors = await Effect.runPromise(
      Effect.forEach(
        [10.5, -1, Number.MAX_SAFE_INTEGER, 2 ** 53],
        (minor) => Effect.flip(toMajorNumber(minor, "usd", "amount")),
        { concurrency: 1 },
      ),
    );
    Arr.forEach(errors, (error) => {
      expect(error).toBeInstanceOf(PaymentInvalidRequestError);
      expect(error.param).toBe("amount");
    });
  });
});
