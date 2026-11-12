---
"@thomasfosterau/effect-biz": minor
---

The payments entities and errors (`Money`, `Customer`, `Product`, `Price`, `Recurring`, `PaymentIntent`, `Refund`, `Subscription`, `CheckoutSession`, `BillingPortal` and every `PaymentsError` member) are now nominal: each `Schema.Class` / `Schema.TaggedError` carries a `{ readonly brand: unique symbol }` brand. A structurally equal object literal no longer type-checks where an instance is expected; construct instances with `new X({ ... })` or `X.make`.
