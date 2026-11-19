---
"@thomasfosterau/effect-biz": minor
"@thomasfosterau/effect-biz-payments-stripe": patch
---

The package root re-exports the foundation modules as namespaces (`import { Money } from "@thomasfosterau/effect-biz"`), alongside their existing subpaths. Payments, `./Authorization` and `./testing` stay subpath-only. Doc comments are trimmed across both packages.
