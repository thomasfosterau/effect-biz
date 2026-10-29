/**
 * The Stripe API version every request follows, in a module of its own so
 * that `StripePayments` and `StripeHttp` re-export it from one place.
 *
 * @module
 */

/**
 * The Stripe API version every capability layer and resource module pins in
 * `Stripe-Version` unless configured: the one the pinned
 * `@distilled.cloud/stripe` release's schemas are generated from
 * (`2026-09-30.endive` for `1.0.0-rc.15`). It moves whenever this package
 * moves its Distilled pin, so create the webhook endpoints whose events a
 * program reads at this version.
 *
 * Where it comes from (owner decision on effect-finance#146: follow Distilled): the
 * `version` of the `com.stripe.api#Stripe` service in
 * `packages/stripe/.generated-specs/stripe.json` at alchemy-run/distilled's
 * release commit (`063c844c` for `1.0.0-rc.15`); the package exposes no such
 * constant. `tests/distilledApiVersion.test.ts` keys it by the installed
 * Distilled version and fails on a release it does not list, so a Distilled
 * bump updates this constant and that table together.
 */
export const DISTILLED_API_VERSION = "2026-09-30.endive";
