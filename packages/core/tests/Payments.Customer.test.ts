import { describe, it, expect } from "vite-plus/test";
import * as Effect from "effect/Effect";
import * as Customer from "@thomasfosterau/effect-biz/Payments.Customer";
import { Money } from "@thomasfosterau/effect-biz/Payments";

describe("core domain types", () => {
  it("constructs a neutral Customer entity", () => {
    const customer = new Customer.Customer({
      id: "cus_1",
      email: "jane@example.com",
      name: null,
      phone: null,
      description: null,
      metadata: { plan: "pro" },
      created: 1700000000,
      livemode: false,
    });
    expect(customer.id).toBe("cus_1");
    expect(customer.email).toBe("jane@example.com");
    expect(customer.metadata.plan).toBe("pro");
  });

  it("constructs Money in minor units", () => {
    const price = Money.make({ amount: 2000, currency: "usd" });
    expect(price.amount).toBe(2000);
    expect(price.currency).toBe("usd");
  });
});

describe("Customer accessors", () => {
  it("create dispatches to whichever Customers service is provided", async () => {
    const customer = new Customer.Customer({
      id: "cus_test",
      email: "test@example.com",
      name: null,
      phone: null,
      description: null,
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
      list: () => Effect.succeed({ data: [customer], hasMore: false }),
    });

    const program = Customer.create({ email: "test@example.com" }).pipe(
      Effect.provideService(Customer.Customers, fake),
    );

    const result = await Effect.runPromise(program);
    expect(result.id).toBe("cus_test");
  });
});
