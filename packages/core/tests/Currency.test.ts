import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";
import * as Currency from "../src/Currency.ts";
import { rejects } from "./arbitraries.ts";

describe("CurrencyCode", () => {
  it.each(["AUD", "USD", "XXX"])("accepts %s", (code) => {
    expect(Schema.decodeSync(Currency.CurrencyCode)(code)).toBe(code);
  });

  it.each(["aud", "AU", "AUDD", "A1D", "", " AUD"])("rejects %j", (code) => {
    expect(rejects(Currency.CurrencyCode, code)).toBe(true);
  });
});

describe("Currency.minorUnits", () => {
  const groups: ReadonlyArray<readonly [0 | 2 | 3 | 4, ReadonlyArray<string>]> = [
    [
      0,
      [
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
      ],
    ],
    [2, ["AUD", "USD", "EUR", "GBP", "NZD", "CAD", "CNY", "XXX"]],
    [3, ["BHD", "IQD", "JOD", "KWD", "LYD", "OMR", "TND"]],
    [4, ["CLF", "UYW"]],
  ];

  it.each(groups.flatMap(([digits, codes]) => codes.map((code) => [code, digits] as const)))(
    "%s has %i minor-unit digits",
    (code, digits) => {
      expect(Currency.minorUnits(Currency.make(code))).toBe(digits);
    },
  );
});
