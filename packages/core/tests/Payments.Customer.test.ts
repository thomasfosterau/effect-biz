import { describe, expect } from "vite-plus/test";
import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Customer from "@thomasfosterau/effect-biz/Payments.Customer";
import { Money } from "@thomasfosterau/effect-biz/Payments";

describe("core domain types", () => {
  it("constructs a neutral Customer entity", () => {
    const customer = new Customer.Customer({
      id: "cus_1",
      email: Option.some("jane@example.com"),
      name: Option.none(),
      phone: Option.none(),
      description: Option.none(),
      metadata: { plan: "pro" },
      created: 1700000000,
      livemode: false,
    });
    expect(customer.id).toBe("cus_1");
    expect(customer.email).toEqual(Option.some("jane@example.com"));
    expect(customer.metadata.plan).toBe("pro");
  });

  it("constructs Money in minor units", () => {
    const price = Money.make({ amount: 2000, currency: "usd" });
    expect(price.amount).toBe(2000);
    expect(price.currency).toBe("usd");
  });
});

describe("Customer accessors", () => {
  it.effect("create dispatches to whichever Customers service is provided", () =>
    Effect.gen(function* () {
      const customer = new Customer.Customer({
        id: "cus_test",
        email: Option.some("test@example.com"),
        name: Option.none(),
        phone: Option.none(),
        description: Option.none(),
        metadata: {},
        created: 0,
        livemode: false,
      });

      // A fake, vendor-agnostic implementation of the capability.
      const fake = Customer.Customers.of({
        create: () => Effect.succeed(customer),
        retrieve: () => Effect.succeed(customer),
        update: () => Effect.succeed(customer),
        del: (id) => Effect.succeed({ id, deleted: true as const }),
        list: () => Effect.succeed({ data: [customer], hasMore: false, nextCursor: Option.none() }),
      });

      const program = Customer.create({ email: "test@example.com" }).pipe(
        Effect.provideService(Customer.Customers, fake),
      );

      const result = yield* program;
      expect(result.id).toBe("cus_test");
    }),
  );
});
