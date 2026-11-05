# @thomasfosterau/effect-biz-payments-paypal

## 0.1.0

### Minor Changes

- [#155](https://github.com/thomasfosterau/effect-biz/pull/155) [`9459bf4`](https://github.com/thomasfosterau/effect-biz/commit/9459bf470cfea345143ac7d7ed68db50be9877bf) Thanks [@thomasfosterau](https://github.com/thomasfosterau)! - Absorb the effect-finance repository's payments packages, none of which was ever published. The vendor-neutral payments core (formerly `@thomasfosterau/effect-payments`) is now part of `@thomasfosterau/effect-biz`: import the barrel from `@thomasfosterau/effect-biz/Payments` and each module from `@thomasfosterau/effect-biz/Payments.<Module>` (`Payments.Customer`, `Payments.Subscription`, …; the providers' shared helpers are `Payments.internal`). The Stripe, PayPal and Airwallex providers are now `@thomasfosterau/effect-biz-payments-stripe`, `-paypal` and `-airwallex`, versioned in lockstep with the rest of the family. Their behaviour is unchanged; the `Context.Service` and `Schema.Class` identifiers move from `@effect-payments/…` to `@effect-biz/payments/…`.

### Patch Changes

- [#160](https://github.com/thomasfosterau/effect-biz/pull/160) [`9e4bb7c`](https://github.com/thomasfosterau/effect-biz/commit/9e4bb7ca1f355236770bc5409614d4a8600da8c2) Thanks [@thomasfosterau](https://github.com/thomasfosterau)! - Tidy emitted signatures found by type-aware linting, with no change in what they accept: optional parameters drop a redundant `| undefined` (an optional parameter already accepts `undefined`), including every generated Stripe resource operation's `params?` and `options?`, and `Redacted.Redacted<string>` is written `Redacted.Redacted` (its default type argument).
- Updated dependencies [[`9459bf4`](https://github.com/thomasfosterau/effect-biz/commit/9459bf470cfea345143ac7d7ed68db50be9877bf), [`9e4bb7c`](https://github.com/thomasfosterau/effect-biz/commit/9e4bb7ca1f355236770bc5409614d4a8600da8c2)]:
  - @thomasfosterau/effect-biz@0.1.0
