---
"@thomasfosterau/effect-biz": patch
"@thomasfosterau/effect-biz-payments-stripe": patch
---

Payments schemas no longer use `Schema.Number`. Minor-unit amounts (`Money.amount`, `unitAmount`, refund and payment-intent amounts), quantities, interval counts, epoch-second timestamps and HTTP status codes now decode with `Schema.Int`, and `PaymentsError.retryAfter` with `Schema.Finite`. Decoding therefore rejects `NaN` and `Infinity`, and rejects fractional values wherever `Schema.Int` applies; the same holds for the Stripe mapping and webhook schemas.
