import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { FetchHttpClient } from "effect/http";
import * as Customer from "@thomasfosterau/effect-biz/Payments.Customer";
import * as Product from "@thomasfosterau/effect-biz/Payments.Product";
import * as Price from "@thomasfosterau/effect-biz/Payments.Price";
import * as Subscription from "@thomasfosterau/effect-biz/Payments.Subscription";
import * as StripePayments from "@thomasfosterau/effect-biz-payments-stripe/StripePayments";

/**
 * Example: Create a subscription using the vendor-neutral core.
 *
 * 1. Create a customer
 * 2. Create a product
 * 3. Create a recurring price for the product
 * 4. Create a subscription for the customer
 *
 * The file exports the program and the layer, and runs them only when executed
 * directly (`node examples/subscription.ts`), so importing it has no side
 * effects (`tests/examples.test.ts` runs it over a stubbed `fetch`).
 */

const createSubscription = Effect.fn("createSubscription")(function* () {
  yield* Console.log("Creating customer...");
  const customer = yield* Customer.create({
    email: "subscriber@example.com",
    name: "Jane Smith",
  });
  yield* Console.log(`Customer created: ${customer.id}`);

  yield* Console.log("Creating product...");
  const product = yield* Product.create({
    name: "Premium Subscription",
    description: "Monthly premium subscription",
  });
  yield* Console.log(`Product created: ${product.id}`);

  yield* Console.log("Creating price...");
  const price = yield* Price.create({
    product: product.id,
    unitAmount: 1999, // $19.99 in minor units
    currency: "usd",
    recurring: { interval: "month" },
  });
  yield* Console.log(`Price created: ${price.id}`);

  yield* Console.log("Creating subscription...");
  const subscription = yield* Subscription.create({
    customer: customer.id,
    items: [{ price: price.id }],
  });
  yield* Console.log(`Subscription created: ${subscription.id}`);
  yield* Console.log(`Status: ${subscription.status}`);

  return { customer, product, price, subscription };
});

/** The example's program: the four steps above, in order. */
export const program = createSubscription();

// The key comes from STRIPE_API_KEY, read through `Config` as a `Redacted`;
// the capabilities need an `HttpClient`.
export const layer = StripePayments.layerFromEnv().pipe(Layer.provide(FetchHttpClient.layer));

// Run only when executed directly, never on import.
if (import.meta.main) {
  Effect.runPromise(program.pipe(Effect.provide(layer)))
    .then((result) => {
      console.log("\nSubscription created successfully!");
      console.log("Customer:", result.customer.id);
      console.log("Product:", result.product.id);
      console.log("Price:", result.price.id);
      console.log("Subscription:", result.subscription.id);
    })
    .catch((error) => {
      console.error("\nFailed:", error);
      process.exit(1);
    });
}
