/**
 * The vendor-neutral idempotency key: how a caller makes one logical write
 * safe to repeat.
 *
 * A write that fails with an unknown outcome (a `PaymentNetworkError` after a
 * timeout, say) may or may not have been applied by the provider. Repeating it
 * blindly can charge, refund or create twice. Passing the same
 * {@link IdempotencyKey} on the repeat lets the provider recognise it as the
 * same write and answer with the original outcome instead of applying it again.
 *
 * The contract (which key, which operations, which errors to retry, how long
 * a provider remembers a key) is on {@link IdempotencyKey}, where it reaches
 * the published declarations, with an example.
 *
 * @module
 */

import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { PaymentInvalidRequestError } from "./Payments.PaymentsError.js";

/** The shape a key must have: 1 to 64 characters of `A-Z a-z 0-9 _ -`. */
const KEY_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * A key that makes one logical write safe to repeat: a branded string of 1 to
 * 64 characters from `A-Z a-z 0-9 _ -`. Make one with {@link generate}, or
 * from a value of the caller's own with `IdempotencyKey.make` (which throws
 * on a bad shape) or {@link validate} (which fails with
 * `PaymentInvalidRequestError`).
 *
 * **The contract**
 *
 * - **One key per logical write**, created by the caller *before the first
 *   attempt* ({@link generate}) and passed unchanged on every retry of that
 *   write. A fresh key per attempt defeats the deduplication, and a key held
 *   by a layer or a scope would be shared by unrelated writes. Never reuse a
 *   key for a different write: a provider answers the same key with different
 *   parameters with an error, not the original outcome. Stripe's
 *   `idempotency_error` surfaces as `PaymentProviderError` with code
 *   `StripeIdempotencyError` (not `PaymentInvalidRequestError`). PayPal's
 *   API specifications do not say what it answers, and Airwallex's behaviour
 *   here is unverified (effect-finance#93).
 * - **Only on create and confirm operations** (`Customer.create`,
 *   `Product.create`, `Price.create`, `PaymentIntent.create` / `confirm`,
 *   `Subscription.create`, `Refund.create`, `CheckoutSession.create`): the
 *   operations every implementing provider can honour. Updates are set
 *   semantics and naturally repeatable. `Subscription.cancel` and
 *   `PaymentIntent.cancel` take none: PayPal cannot honour a key there, and a
 *   key a provider silently dropped would be worse than none.
 * - **Retry only when the outcome is unknown or the write was not applied**:
 *   `PaymentNetworkError` (a timeout, a dropped connection),
 *   `PaymentProviderError` with `statusCode >= 500` (a vendor 5xx surfaces as
 *   this, not as `PaymentNetworkError`) and `PaymentRateLimitError` (back off
 *   for `retryAfter` first). Do not retry `PaymentInvalidRequestError`,
 *   `PaymentAuthenticationError`, or a `PaymentProviderError` below 500
 *   (including `StripeIdempotencyError`): they fail the same way again.
 * - **A window, not forever.** Providers remember a key for a limited time
 *   that differs per provider (on PayPal, per API) and is not promised by the
 *   type. PayPal's Orders API keeps one for 6 hours by default, so a
 *   `PaymentIntent.create` / `confirm` retry on PayPal is deduplicated only
 *   within 6 hours; its Catalog Products and Subscriptions APIs keep one for
 *   72 hours, and its Payments API (refunds) states no window. Stripe's and
 *   Airwallex's windows are unverified (effect-finance#93). Treat a retry within a few hours
 *   as safe and a later one as a new write.
 * - **The shape is the lowest common denominator**: 1 to 64 characters from
 *   `A-Z a-z 0-9 _ -` (a UUID is 36). It fits PayPal's Orders (1 to 108
 *   characters) and Payments (refunds, 1 to 10 000) limits; PayPal states no
 *   limit for Catalog Products and Subscriptions. Stripe's (255) and
 *   Airwallex's (about 64) limits are unverified (effect-finance#93), so the shape is
 *   deliberately conservative.
 *
 * Create the key once per logical write and reuse it on every retry of that
 * write:
 *
 * @example
 * ```typescript
 * import { Effect, Schedule } from "effect";
 * import * as IdempotencyKey from "@thomasfosterau/effect-biz/Payments.IdempotencyKey";
 * import * as Refund from "@thomasfosterau/effect-biz/Payments.Refund";
 *
 * const refund = (paymentIntent: string) =>
 *   Effect.gen(function* () {
 *     const idempotencyKey = yield* IdempotencyKey.generate; // once per logical write
 *     return yield* Refund.create({ paymentIntent, idempotencyKey }).pipe(
 *       Effect.retry({
 *         // the same key on every attempt
 *         while: (error) =>
 *           error._tag === "PaymentNetworkError" ||
 *           error._tag === "PaymentRateLimitError" ||
 *           (error._tag === "PaymentProviderError" && (error.statusCode ?? 0) >= 500),
 *         schedule: Schedule.exponential("200 millis"),
 *         times: 3,
 *       }),
 *     );
 *   });
 * ```
 */
export const IdempotencyKey = Schema.String.check(
  Schema.isPattern(KEY_PATTERN, {
    message: "an idempotency key is 1 to 64 characters from A-Z, a-z, 0-9, _ and -",
  }),
).pipe(Schema.brand("IdempotencyKey"));

/** An idempotency key; see {@link IdempotencyKey}. */
export type IdempotencyKey = typeof IdempotencyKey.Type;

/**
 * A new random key (a UUID, 36 characters). Run it once per logical write,
 * before the first attempt, and reuse the result on every retry of that write.
 */
export const generate: Effect.Effect<IdempotencyKey> = Effect.sync(() =>
  IdempotencyKey.make(globalThis.crypto.randomUUID()),
);

/**
 * Check a key at runtime. The branded type already guarantees the shape for
 * typed code; providers call this to refuse a raw string from untyped code
 * with `PaymentInvalidRequestError` before anything is sent, instead of
 * passing a key a vendor might reject or truncate. `undefined` (no key)
 * succeeds as `undefined`.
 */
export const validate = (
  key: string | undefined,
): Effect.Effect<IdempotencyKey | undefined, PaymentInvalidRequestError> =>
  key === undefined
    ? Effect.succeed(undefined)
    : Schema.decodeUnknownEffect(IdempotencyKey)(key).pipe(
        Effect.mapError(
          () =>
            new PaymentInvalidRequestError({
              message: "idempotencyKey must be 1 to 64 characters from A-Z, a-z, 0-9, _ and -",
              param: "idempotencyKey",
            }),
        ),
      );
