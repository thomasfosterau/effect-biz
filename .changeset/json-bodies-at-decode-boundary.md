---
"@thomasfosterau/effect-biz": minor
"@thomasfosterau/effect-biz-payments-stripe": minor
---

Vendor response bodies are typed as `Schema.Json` where they cross a decode boundary instead of `unknown`. `WebhookEvent`'s `data.object`, and `decodeCheckoutSession` / `decodeSubscription` / `decodeInvoice`, take `Schema.Json`; `StripeHttp.call` resolves to `Schema.Json`, and a 2xx now succeeds with the JSON body the client observed rather than Distilled's decoded output. In core's internal REST helpers (exempt from semver), `ObservedResponse.body` is `Option<Schema.Json>` and the `responseDecoder` decoders take `Schema.Json`.
