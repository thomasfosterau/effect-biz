import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import { FetchHttpClient } from "effect/http";
import * as Customer from "@thomasfosterau/effect-biz/Payments.Customer";
import * as Enumeration from "@thomasfosterau/effect-biz/Payments.Enumeration";
import * as PaymentIntent from "@thomasfosterau/effect-biz/Payments.PaymentIntent";
import * as StripePayments from "@thomasfosterau/effect-biz-payments-stripe/StripePayments";

/**
 * Example: Create a customer and a payment intent using the vendor-neutral core.
 *
 * Notice that the program below imports only from `@thomasfosterau/effect-biz/Payments`
 * — it never mentions Stripe. The provider is chosen at the edge, by the layer we
 * provide. Swapping providers means swapping the layer, not the program.
 *
 * The file exports the program and the layer, and runs them only when executed
 * directly (`node examples/basic.ts`), so importing it has no side effects
 * (`tests/examples.test.ts` runs it over a stubbed `fetch`).
 */

export const program = Effect.gen(function* () {
  yield* Console.log("Creating customer...");

  const customer = yield* Customer.create({
    email: "customer@example.com",
    name: "John Doe",
    metadata: { userId: "user_123" },
  });

  yield* Console.log(`Customer created: ${customer.id}`);

  yield* Console.log("Creating payment intent...");

  const paymentIntent = yield* PaymentIntent.create({
    amount: 2000, // $20.00 in minor units
    currency: "usd",
    customer: customer.id,
    metadata: { orderId: "order_456" },
  });

  yield* Console.log(`Payment intent created: ${paymentIntent.id}`);
  const status = paymentIntent.status;
  yield* Console.log(`Status: ${Enumeration.isOther(status) ? status.raw : status}`);
  yield* Console.log(`Amount: $${paymentIntent.amount / 100}`);

  return { customer, paymentIntent };
}).pipe(
  // Errors are vendor-neutral, regardless of the underlying provider. We log
  // them with `tapErrorTag` and leave the failure in the channel for the caller.
  Effect.tapErrorTag("PaymentAuthenticationError", (error) =>
    Console.error("Authentication failed:", error.message),
  ),
  Effect.tapErrorTag("PaymentProviderError", (error) =>
    Console.error(`Provider error from ${error.provider} (${error.code ?? "?"}):`, error.message),
  ),
);

// Choose the provider here. To run on Stripe from an env var instead, use
// `StripePayments.layerFromEnv()`.
// The capabilities run on `effect/http`'s `HttpClient`: provide
// `FetchHttpClient.layer` (Node, Workers, browsers). The key is a `Redacted`.
export const layer = StripePayments.layer({
  apiKey: Redacted.make(process.env.STRIPE_API_KEY || "sk_test_..."),
}).pipe(Layer.provide(FetchHttpClient.layer));

// Run only when executed directly, never on import.
if (import.meta.main) {
  Effect.runPromise(program.pipe(Effect.provide(layer)))
    .then((result) => {
      console.log("\nSuccess!");
      console.log("Customer ID:", result.customer.id);
      console.log("Payment Intent ID:", result.paymentIntent.id);
      return result;
    })
    .catch((error) => {
      console.error("\nFailed:", error);
      process.exit(1);
    });
}
