---
"@thomasfosterau/effect-biz": patch
"@thomasfosterau/effect-biz-payments-stripe": patch
"@thomasfosterau/effect-biz-payments-paypal": patch
"@thomasfosterau/effect-biz-payments-airwallex": patch
---

Move Distilled (`@distilled.cloud/stripe`, `-paypal` and `-core`) from `1.0.0-rc.15` to `1.0.0-rc.18`, and the optional `stripe` dev pin to 23.0.1 (still `2026-09-30.endive`, so `DISTILLED_API_VERSION` is unchanged). Distilled rc.16 and later declare `effect: ^4.0.5`, so the `effect` peer range of every package in the family moves from `^4.0.0` to `^4.0.5` (the packages version in lockstep under one range): a range change only, tested at effect 4.0.5. With rc.18 Distilled keeps its schemas private, so the Stripe resource modules now re-export Distilled's input and output types as types only (reach an operation's schemas through its `input` / `output`). A 2xx whose body is not JSON still fails with `PaymentProviderError` ("Invalid JSON received from the Stripe API") although Distilled now fails such a response with its own `StripeParseError`, and a `ConfigError` from Distilled's `Credentials` in context surfaces from the Stripe client as `PaymentsUnavailable`.
