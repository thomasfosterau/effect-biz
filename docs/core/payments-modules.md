# Payments modules

Every payments module is its own subpath.

Every module is its own subpath (`@thomasfosterau/effect-biz/Payments.<Module>`). `@thomasfosterau/effect-biz/Payments` re-exports the capability modules, `Enumeration`, `IdempotencyKey` and `Stub` as namespaces, and flattens the errors, `Page` / `Deleted`, `Money`, `Metadata` and `money` (`Money.make`).

| Module | Purpose |
| --- | --- |
| `Customer`, `Product`, `Price`, `PaymentIntent`, `Subscription`, `Refund` | The capability, its entity, its params (`CreateParams`, `UpdateParams`, `ListParams`, …), its enums and the accessor functions. |
| `CheckoutSession`, `BillingPortal` | Hosted checkout and billing portal sessions: an entity whose `url` you redirect to. |
| `Money` | `Money` (minor-unit amount + currency), `make`, `Metadata`. |
| `Page` | `Page<A>` and `Deleted`. |
| `PaymentsError` | The error classes and the `PaymentsError` union. |
| `IdempotencyKey` | The branded key, `generate` and `validate`. |
| `Enumeration` | The lenient-enum helpers: `Other`, `other`, `isOther`, `lenient`, `parse` (a raw string → a known literal or `Other`) and `fromWire` (the same as a `Schema` codec, for a provider's wire schema). |
| `Stub` | Capability layers that fail every call with one error: `layer`, one constructor per capability, `unavailable`, and the `Failure` / `Capabilities` types. |
