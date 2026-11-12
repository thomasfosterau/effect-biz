# Payments

The vendor-neutral payments core. See also [errors](payments-errors.md), [retrying a write safely](retrying-writes.md), [stubs](stubs.md) and [the module reference](payments-modules.md).

A vendor-neutral payments core for Effect, under `@thomasfosterau/effect-biz/Payments` (the barrel) and `@thomasfosterau/effect-biz/Payments.<Module>` (one module each).

Write your payment workflows against provider-agnostic capabilities, and choose the provider at the edge of your application by the layer you provide: [`@thomasfosterau/effect-biz-payments-stripe`](https://www.npmjs.com/package/@thomasfosterau/effect-biz-payments-stripe) today. It is the payments analogue of Effect's AI modules: one abstraction, one package per provider.

Add a provider package to run a program.

## Usage

A program depends only on the **capabilities** it uses; it never imports a provider:

```typescript
import { Effect } from "effect";
import * as Customer from "@thomasfosterau/effect-biz/Payments.Customer";
import * as Subscription from "@thomasfosterau/effect-biz/Payments.Subscription";

// Effect<{ customer, subscription }, PaymentsError, Customers | Subscriptions>
const onboard = (email: string, priceId: string) =>
  Effect.gen(function* () {
    const customer = yield* Customer.create({ email });
    const subscription = yield* Subscription.create({
      customer: customer.id,
      items: [{ price: priceId }],
    });
    return { customer, subscription };
  });
```

Run it by providing a provider's layer, for example `StripePayments.layer` from `@thomasfosterau/effect-biz-payments-stripe`. Swapping providers means swapping the layer, not the program.

Providers may implement only the capabilities they support (Stripe implements every one). The type system enforces this: a program that needs a capability the provided layer doesn't supply does not type-check. An individual operation a provider lacks fails with `PaymentInvalidRequestError`; each provider's documentation lists them.

## Capabilities

Each resource is an abstract Effect service (a `Context.Service`). A program that calls `Customer.create(...)` requires the `Customers` capability in its environment, and nothing more.

| Module | Capability | Operations |
| --- | --- | --- |
| `Customer` | `Customers` | `create`, `retrieve`, `update`, `del`, `list` |
| `Product` | `Products` | `create`, `retrieve`, `update`, `del`, `list` |
| `Price` | `Prices` | `create`, `retrieve`, `update`, `list` |
| `PaymentIntent` | `PaymentIntents` | `create`, `retrieve`, `update`, `confirm`, `cancel`, `list` |
| `Subscription` | `Subscriptions` | `create`, `retrieve`, `update`, `cancel`, `list` |
| `Refund` | `Refunds` | `create`, `retrieve`, `update`, `list` |
| `CheckoutSession` | `CheckoutSessions` | `create` (a hosted checkout page → its `url`) |
| `BillingPortal` | `BillingPortalSessions` | `create` (a hosted billing portal page → its `url`) |

Every operation returns `Effect<Entity, PaymentsError, Capability>`. List operations return a neutral `Page<Entity>` (`{ data, hasMore, nextCursor }`; request the next page by passing `nextCursor` as `startingAfter`, with the same `limit` and filters); deletions return `Deleted` (`{ id, deleted: true }`).

### Hosted checkout and billing portal

`CheckoutSession.create` and `BillingPortal.create` return an entity whose `url` you redirect the buyer to. A checkout never takes an amount: it names the provider's price ids (`lineItems`, at least one), so the buyer pays the price's amount. `mode` is `"payment"` or `"subscription"` (which also takes `subscriptionMetadata`, stored on the subscription the checkout creates).

```typescript
import { Effect } from "effect";
import * as BillingPortal from "@thomasfosterau/effect-biz/Payments.BillingPortal";
import * as CheckoutSession from "@thomasfosterau/effect-biz/Payments.CheckoutSession";

// Effect<string, PaymentsError, CheckoutSessions>
const checkout = (customer: string, priceId: string) =>
  CheckoutSession.create({
    mode: "subscription",
    customer,
    lineItems: [{ price: priceId }],
    successUrl: "https://example.com/billing?checkout=success",
    cancelUrl: "https://example.com/pricing",
  }).pipe(Effect.map((session) => session.url));

// Effect<string, PaymentsError, BillingPortalSessions>
const portal = (customer: string) =>
  BillingPortal.create({ customer, returnUrl: "https://example.com/account" }).pipe(
    Effect.map((session) => session.url),
  );
```

## Domain types

Entities are provider-agnostic `effect/Schema` classes: `Customer`, `Product`, `Price`, `PaymentIntent`, `Subscription`, `Refund`, `CheckoutSession`, `BillingPortalSession` and `Money`. They contain only fields that are meaningful across providers, in a normalized shape (`camelCase`, neutral status enums). **Amounts are always in the smallest currency unit** (`2000` = $20.00), and currencies are lower-cased ISO 4217 codes (`"usd"`).

Status and type enums are lenient: each is the known literals plus `Other` (`{ _tag: "Other", raw }`), carrying a provider value the library does not model, so an unexpected value never fails a whole list page. Match exhaustively with a case for `Other` (`Enumeration.isOther`). Each module exports the enum twice: `Known<Name>` (the literals, the type a request filter takes) and `<Name>` (the lenient union, the type of the entity field): `PaymentIntent.PaymentStatus`, `Subscription.SubscriptionStatus`, `Refund.RefundStatus`, `Price.PriceType` and `Price.RecurringInterval`. `CheckoutSession.CheckoutMode` is a request input and stays closed.
