/**
 * `@thomasfosterau/effect-biz-payments-airwallex`
 *
 * An Airwallex implementation of the vendor-neutral
 * `@thomasfosterau/effect-biz/Payments` core. It provides:
 *
 * - **`Airwallex`** — the Airwallex client service (token handshake + HTTP) and
 *   the `Layer`s that construct it from configuration or the environment.
 * - **`AirwallexPayments`** — `Layer`s that implement the `Customers`,
 *   `PaymentIntents` and `Refunds` capabilities on top of Airwallex, plus
 *   `layer`/`layerFromEnv` that bundle the client and capabilities together.
 *
 * Airwallex does not model catalogs or subscription billing in the same shape as
 * the core, so it intentionally implements only a subset of the capabilities.
 * The same neutral program runs on Airwallex or Stripe — only the provided layer
 * changes.
 *
 * See `AirwallexPayments.layer` for an example of running a neutral program on Airwallex.
 *
 * @module
 */

export * as Payments from "@thomasfosterau/effect-biz/Payments";

export * as Airwallex from "./Airwallex.js";
export * as AirwallexPayments from "./AirwallexPayments.js";

export type { AirwallexConfig, AirwallexEnvironment, AirwallexRequest } from "./Airwallex.js";
