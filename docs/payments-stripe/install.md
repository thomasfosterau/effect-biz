# Install

Peer and dependency ranges of `@thomasfosterau/effect-biz-payments-stripe`.

`effect` is a peer dependency, at `^4.0.5`: that is the peer range `@distilled.cloud/stripe` and `@distilled.cloud/core` declare, and neither 4.0.0–4.0.4 nor a `4.0.0-rc.*` prerelease satisfies it. Those two are dependencies, pinned exactly (they are pre-1.0): about 30 MB installed with core's `graphql` dependency, of which a bundler keeps only the operations the capabilities you use call. The official `stripe` package is an **optional** peer (`^23.0.0`: stripe-node 23.0.0 is the release for `2026-09-30.endive`, the `Stripe-Version` every request pins, so the verifier's `Stripe.Event` describes the payloads your endpoints receive at that version: an exact match on 23.0.x; a later 23.x types events at its own, newer endive version), for the SDK-based webhook verifier only:

- **At runtime** this package never loads it. `Webhook.constructEvent*` runs on an SDK client your program builds and provides (`Webhook.StripeService`); everything else runs without it.
- **For types** it is needed by `./Webhook` (its `constructEvent` signature names `Stripe.Event`, so `Webhook.verify` users need it too) and the package root, which re-exports it. Add it as a dev dependency when you import either; otherwise, with `skipLibCheck: false`, the declarations fail to resolve `stripe`, and with it on, its types silently become `any`. No other entry declares an import of it.
