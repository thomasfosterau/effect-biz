---
"@thomasfosterau/effect-biz": minor
"@thomasfosterau/effect-biz-payments-stripe": minor
---

Absence is an `Option` and a parameter bag member is a bare `?: T`: `T | null` and `T | undefined` no longer appear in the payments types.

Core entity fields that were `T | null` are now `Option<T>` (their encoded form is unchanged: `Schema.OptionFromNullOr` still reads and writes `null`). `Customer`: `email`, `name`, `phone`, `description`. `Product`: `description`. `Price`: `productId`, `unitAmount`, `recurring` (an `Option<Recurring>`). `PaymentIntent`: `customerId`, `paymentMethodId`, `clientSecret`, `description`. `Subscription` item: `quantity`. `Refund`: `paymentIntentId`, `chargeId`, `reason`. A provider builds them with `Option.fromNullishOr`; a consumer reads them with `Option.match` / `Option.getOrElse`.

`Page.nextCursor` is now a required `Option<string>` (`Some` when `hasMore`), not an optional `string`; pass its value on as the list params' `startingAfter`. A provider's page literal must set it (`Option.none()` on the last page).

Every `CreateParams` / `UpdateParams` / `ConfirmParams` / `ListParams` member (and `CheckoutSession` line items' `quantity`, and `Price.CreateParams["recurring"]`'s `intervalCount`) is declared `readonly x?: T` instead of `readonly x?: T | undefined`. Under `exactOptionalPropertyTypes` a caller holding `undefined` now omits the key rather than passing it.

`IdempotencyKey.validate` takes an optional `key?: string` and resolves to `Option<IdempotencyKey>` (`None` for no key) instead of `IdempotencyKey | undefined`.

Stripe: `StripeHttpConfig`, `LayerConfigOptions`, `RequestOptions` / `CallOptions` and `Webhook.VerifyOptions` / `WebhookConfig` members drop `| undefined` (`VerifyOptions.header` is now `header?: string`: omit it, rather than pass `null` or `undefined`, when the request carried no `Stripe-Signature`). The raw resource modules' trailing `options?: RequestOptions` is unchanged. In the semver-exempt `Payments.internal`, helpers that answered `T | undefined` (`scaleToMinor`, `parseDecimal`, `formatDecimal`, `stringField`) answer `Option<T>`, `epochSecondsOf` takes an `Option<string>`, and `pageNumberedList` takes its params as a required object and lists with `(page?: number)`.
