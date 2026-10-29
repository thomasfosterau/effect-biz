import { describe, expectTypeOf, it } from "vite-plus/test";
import type { Effect } from "effect";
import type { PaymentsError } from "@thomasfosterau/effect-biz/Payments";
import * as Price from "@thomasfosterau/effect-biz/Payments.Price";

type Recurring = NonNullable<Price.CreateParams["recurring"]>;

describe("Price.CreateParams (type level)", () => {
  // The workspace compiles with `exactOptionalPropertyTypes`, so a bare
  // `recurring?: T` would refuse an explicit `undefined` (effect-finance#95).
  it("accepts a forwarded `recurring` that may be undefined", () => {
    expectTypeOf<{
      product: string;
      currency: string;
      unitAmount: number;
      recurring: Recurring | undefined;
    }>().toExtend<Price.CreateParams>();

    const forward = (recurring: Recurring | undefined) =>
      Price.create({ product: "prod_1", currency: "usd", unitAmount: 1000, recurring });
    expectTypeOf(forward).returns.toEqualTypeOf<
      Effect.Effect<Price.Price, PaymentsError, Price.Prices>
    >();
  });

  it("still accepts a call without `recurring`", () => {
    expectTypeOf<{
      product: string;
      currency: string;
      unitAmount: number;
    }>().toExtend<Price.CreateParams>();
  });
});
