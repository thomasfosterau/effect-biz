/**
 * `@thomasfosterau/effect-biz-payments-paypal`
 *
 * A PayPal implementation of the vendor-neutral
 * `@thomasfosterau/effect-biz/Payments` core. It provides:
 *
 * - **`PayPalPayments`** — `Layer`s that implement the `Products`, `Prices`,
 *   `PaymentIntents`, `Subscriptions` and `Refunds` capabilities on top of
 *   Distilled's PayPal operations (`@distilled.cloud/paypal`), plus
 *   `layer`/`layerFromEnv` bundles that log in with the client credentials,
 *   and the `PayPalConfig` / `PayPalEnvironment` types `layer` takes.
 *
 * For a PayPal call the capabilities do not cover, use
 * `@distilled.cloud/paypal`'s operations directly, with an access token of
 * your own in its `Credentials`.
 *
 * PayPal has no first-class customer resource, so it does not implement the
 * core's `Customers` capability. The same neutral program runs on PayPal,
 * Stripe or Airwallex — only the provided layer changes.
 *
 * See `PayPalPayments.layer` for an example of running a neutral program on PayPal.
 *
 * @module
 */

export * as Payments from "@thomasfosterau/effect-biz/Payments";

export * as PayPalPayments from "./PayPalPayments.js";

export type { PayPalConfig, PayPalEnvironment } from "./PayPalPayments.js";
