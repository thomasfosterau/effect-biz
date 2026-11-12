# Retrying a write safely

How to repeat a payments write without applying it twice.

A write that fails with a `PaymentNetworkError` (a timeout, a dropped connection), or a provider 5xx, has an **unknown outcome**: the provider may have applied it. Repeating it blindly can charge, refund or create twice. Pass an `idempotencyKey` and the provider recognises the repeat as the same write and answers with the original outcome instead of applying it again.

```typescript
import { Effect, Schedule } from "effect";
import * as IdempotencyKey from "@thomasfosterau/effect-biz/Payments.IdempotencyKey";
import * as Refund from "@thomasfosterau/effect-biz/Payments.Refund";
import type { PaymentsError } from "@thomasfosterau/effect-biz/Payments";

// The outcome may be unknown (or the write not applied): safe to repeat with the same key.
const isUnknownOutcome = (error: PaymentsError) =>
  error._tag === "PaymentNetworkError" ||
  error._tag === "PaymentRateLimitError" ||
  (error._tag === "PaymentProviderError" && (error.statusCode ?? 0) >= 500);

const refund = (paymentIntent: string) =>
  Effect.gen(function* () {
    const idempotencyKey = yield* IdempotencyKey.generate; // once per logical write
    return yield* Refund.create({ paymentIntent, idempotencyKey }).pipe(
      Effect.retry({
        while: isUnknownOutcome, // see "Retry only when" below
        schedule: Schedule.exponential("200 millis"),
        times: 3,
      }),
    ); // the same key on every attempt
  });
```

The rules:

- **One key per logical write**, created by the caller _before the first attempt_ (`IdempotencyKey.generate`, or your own id for the operation, such as `refund-${orderId}`) and passed unchanged on every retry. A key generated inside the retried effect is a new key per attempt and protects nothing. Never reuse a key for a different write: a provider answers the same key with different parameters with an error rather than the original outcome. Stripe's is `idempotency_error`, which surfaces as `PaymentProviderError` with code `StripeIdempotencyError` (not `PaymentInvalidRequestError`).
- **Accepted on the create and confirm operations** that every provider implementing them can honour: `Customer.create`, `Product.create`, `Price.create`, `PaymentIntent.create` / `confirm`, `Subscription.create`, `Refund.create`, `CheckoutSession.create`. It is optional, and a program that passes none behaves as before. Updates are set-semantics and repeatable. `Subscription.cancel` and `PaymentIntent.cancel` do **not** take one (not every provider can honour a key there; PayPal, a former provider, could not), and neither does `BillingPortal.create`: the option is absent from their types, so passing one does not compile.
- **Retry only when the outcome is unknown or the write was not applied**: `PaymentNetworkError`, `PaymentProviderError` with `statusCode >= 500` (a vendor 5xx surfaces as this, not as `PaymentNetworkError`) and `PaymentRateLimitError` (back off for `retryAfter` first). Do not retry `PaymentInvalidRequestError`, `PaymentAuthenticationError`, or a `PaymentProviderError` below 500 (including Stripe's `StripeIdempotencyError`): they fail the same way again.
- **The shape is the lowest common denominator**: 1 to 64 characters from `A-Z a-z 0-9 _ -` (a UUID is 36). `IdempotencyKey.IdempotencyKey` is the branded `Schema`; `IdempotencyKey.IdempotencyKey.make` (throws on a bad shape) or `IdempotencyKey.validate` (fails with `PaymentInvalidRequestError`) check a value of your own, and a raw string that slips past the types fails with `PaymentInvalidRequestError` before anything is sent.
- **A window, not forever**: providers remember a key for a limited time, differing per provider. Treat a retry within a few hours as safe, and a later one as a new write. The figures:

  | Provider | Key length | Kept for | Source |
  | --- | --- | --- | --- |
  | Stripe | 255 characters | at least 24 hours | unverified ([effect-finance#93](https://github.com/thomasfosterau/effect-finance/issues/93)) |

  The 1 to 64 character shape stays within the unverified Stripe figure.

Mapping: Stripe sends `Idempotency-Key`. Without a key, Stripe's client generates a key of its own per call (for its own internal retries), which does not deduplicate your retry.
