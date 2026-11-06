---
"@thomasfosterau/effect-biz": minor
"@thomasfosterau/effect-biz-payments-stripe": minor
---

Absorb the effect-finance repository's payments packages, none of which was ever published. The vendor-neutral payments core (formerly `@thomasfosterau/effect-payments`) is now part of `@thomasfosterau/effect-biz`: import the barrel from `@thomasfosterau/effect-biz/Payments` and each module from `@thomasfosterau/effect-biz/Payments.<Module>` (`Payments.Customer`, `Payments.Subscription`, …; the providers' shared helpers are `Payments.internal`). The Stripe provider is now `@thomasfosterau/effect-biz-payments-stripe`, versioned in lockstep with the rest of the family (effect-finance's PayPal and Airwallex providers were not carried over). Its behaviour is unchanged; the `Context.Service` and `Schema.Class` identifiers move from `@effect-payments/…` to `@effect-biz/payments/…`.
