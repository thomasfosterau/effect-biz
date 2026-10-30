---
"@thomasfosterau/effect-biz": patch
"@thomasfosterau/effect-biz-payments-stripe": patch
"@thomasfosterau/effect-biz-payments-paypal": patch
"@thomasfosterau/effect-biz-payments-airwallex": patch
---

Tidy emitted signatures found by type-aware linting, with no change in what they accept: optional parameters drop a redundant `| undefined` (an optional parameter already accepts `undefined`), including every generated Stripe resource operation's `params?` and `options?`, and `Redacted.Redacted<string>` is written `Redacted.Redacted` (its default type argument).
