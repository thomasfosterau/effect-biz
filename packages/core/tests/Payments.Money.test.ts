import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";
import * as Money from "@thomasfosterau/effect-biz/Payments.Money";

describe("Money schema", () => {
  const decode = Schema.decodeUnknownSync(Money.Money);

  it("decodes an integer minor-unit amount", () => {
    expect(decode({ amount: 2000, currency: "usd" }).amount).toBe(2000);
  });

  it.each([Number.NaN, Number.POSITIVE_INFINITY, 20.5])("rejects amount %s", (amount) => {
    expect(() => decode({ amount, currency: "usd" })).toThrow(/amount/);
  });
});
