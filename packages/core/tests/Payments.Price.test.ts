import { describe, expectTypeOf, it } from "vite-plus/test";
import type { Effect } from "effect";
import type { PaymentsError } from "@thomasfosterau/effect-biz/Payments";
import * as Price from "@thomasfosterau/effect-biz/Payments.Price";

type Recurring = NonNullable<Price.CreateParams["recurring"]>;

describe("Price.CreateParams (type level)", () => {
  // An options-bag member is `recurring?: T`, never `recurring?: T | undefined`:
  // under `exactOptionalPropertyTypes` a caller holding `undefined` omits the key.
  it("takes `recurring` only when present", () => {
    expectTypeOf<{
      product: string;
      currency: string;
      unitAmount: number;
      recurring: Recurring;
    }>().toExtend<Price.CreateParams>();
    expectTypeOf<{
      product: string;
      currency: string;
      unitAmount: number;
      recurring: undefined;
    }>().not.toExtend<Price.CreateParams>();

    const create = (recurring?: Recurring) =>
      recurring === undefined
        ? Price.create({ product: "prod_1", currency: "usd", unitAmount: 1000 })
        : Price.create({ product: "prod_1", currency: "usd", unitAmount: 1000, recurring });
    expectTypeOf(create).returns.toEqualTypeOf<
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
