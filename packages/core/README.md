# @thomasfosterau/effect-biz

**Disclaimer:** This is an experiment. Don't use it in production.

The foundation of the effect-biz package family: the identifiers, tenancy context, error channel, domain events and repository conventions every effect-biz domain package builds on, and the vendor-neutral payments core (`@thomasfosterau/effect-biz/Payments`; see [Payments](#payments)).

## Install

```sh
pnpm add effect @thomasfosterau/effect-biz
```

`effect` is a peer (`^4.0.0`): your application owns the single copy.

## Foundation

The modules every domain package builds on, one subpath each. More (tenancy, repositories, events) land as the platform-foundation slices do; see the repository's issues.

### Identifiers (`./Id`)

Every entity id is a lower-case UUIDv7 string, branded per kind, so ids of different kinds are not assignable to each other. Declare a kind with `Id.make`, and create ids with `Id.generate` from the `IdGenerator` service: `Id.layer` (UUIDv7 from `Clock` and `Random`, increasing within a millisecond, deterministic under `TestClock` and a seeded `Random`) or `Id.layerSequential` for tests.

```ts
import { Effect } from "effect";
import * as Id from "@thomasfosterau/effect-biz/Id";

const PartyId = Id.make("PartyId");

const program = Id.generate(PartyId);

console.log(Effect.runSync(program.pipe(Effect.provide(Id.layerSequential)))); // "00000000-0000-7000-8000-000000000001"
```

An identifier from another system (a host application's user id, a sales channel's order number) is never reused as an effect-biz id; it is stored beside the entity as an external reference.

### Errors (`./BizError`)

Every module fails with the same small set of `Schema.TaggedError`s, so a host handles them once. `BizError.BizError` is the schema of the union (for RPC), `isRetryable` says whether repeating the command may succeed, and `httpStatus` is the status an API answers with:

| Error | Raised when | HTTP | Retryable |
| --- | --- | --- | --- |
| `NotFound` | the named entity does not exist (or is not visible to the tenant) | 404 | no |
| `AlreadyExists` | a create would duplicate a natural key | 409 | no |
| `ValidationError` | the input is malformed; `issues` are addressed by path | 422 | no |
| `ConcurrencyConflict` | a version-guarded write lost a race; retry from the load | 409 | yes |
| `InvalidTransition` | the command is not allowed from the entity's state | 409 | no |
| `Forbidden` | the principal may not perform the action on the resource | 403 | no |
| `BusinessRuleViolation` | a business rule is broken; `code` is namespaced (`sales.credit-limit-exceeded`) | 422 | no |
| `Unavailable` | a port or integration is down or not configured | 503 | yes |

`BizError.decodeUnknown(schema)` decodes a command's input and fails with a `ValidationError` (built by `fromSchemaError`) instead of a `SchemaError`.

```ts
import { Effect, Schema } from "effect";
import * as BizError from "@thomasfosterau/effect-biz/BizError";

const Input = Schema.Struct({ name: Schema.String });

const error = Effect.runSync(Effect.flip(BizError.decodeUnknown(Input)({ name: 1 })));

console.log(error._tag, BizError.httpStatus(error)); // "ValidationError" 422
console.log(error.issues[0]?.path); // ["name"]
```

No error carries a secret or personal data: only entity kinds, ids, codes and schema paths.

### Exact numbers

A quantity, price, rate or percentage is never a JavaScript `number`. Every one is an `effect/BigDecimal`, and crosses a boundary (a SQL row, an event, an HTTP body) as a canonical decimal string. Arithmetic stays Effect's own `BigDecimal.sum`, `subtract` and `multiply`, which are exact; the one inexact operation, division, always takes a rounding policy, and so does every other place that rounds. Pure functions that can fail return a `Result` whose failure is a `BizError.BusinessRuleViolation` with a `core.*` code, and never throw.

#### Decimals (`./Decimal`)

`Decimal` is a schema whose Type is a `BigDecimal` and whose Encoded form is `-?digits` with an optional `.digits`: no exponent, no empty string, no leading `+`, never a JSON number. Encoding writes the shortest plain form and loses no precision (`BigDecimal.format` alone switches to an exponent for very small or large scales).

```ts
import { BigDecimal, Schema } from "effect";
import * as Decimal from "@thomasfosterau/effect-biz/Decimal";

const price = Schema.decodeUnknownSync(Decimal.Decimal)("12.50");
const total = BigDecimal.multiply(price, Decimal.make("3"));

console.log(Schema.encodeSync(Decimal.Decimal)(total)); // "37.5"
console.log(Schema.decodeUnknownExit(Decimal.Decimal)("1e5")._tag); // "Failure"
console.log(Schema.decodeUnknownExit(Decimal.Decimal)(1.5)._tag); // "Failure"
```

`make(text)` parses a literal (and throws), `fromString` returns an `Option`, `zero` and `one` are constants, `format(value, scale)` pads to a fixed scale (and is `None` rather than rounding), and `divide(a, b, policy)` is `None` for a zero divisor.

#### Rounding (`./Rounding`)

`RoundingMode` is Effect's `BigDecimal` rounding modes. The common names map onto them: half-even is `"half-even"`, half-up is `"half-from-zero"`, up is `"from-zero"` and down is `"to-zero"`. A `RoundingPolicy` is a mode and a scale (fraction digits kept); a company configures one wherever it rounds.

```ts
import { BigDecimal } from "effect";
import * as Rounding from "@thomasfosterau/effect-biz/Rounding";

const halfEven = new Rounding.RoundingPolicy({ mode: "half-even", scale: 0 });
const halfUp = new Rounding.RoundingPolicy({ mode: "half-from-zero", scale: 0 });
const tie = BigDecimal.fromStringUnsafe("2.5");

console.log(BigDecimal.format(Rounding.round(tie, halfEven))); // "2"
console.log(BigDecimal.format(Rounding.round(tie, halfUp))); // "3"
```

#### Quantities (`./Quantity`)

A `Quantity` is an exact `amount` of a `unit`. Core carries only the `UnitCode`; the catalogue owns the units and their conversions. `NonNegativeQuantity` refuses a negative amount. `add` and `subtract` fail with `core.unit-mismatch` (both codes in `details`) when the units differ.

```ts
import { Result, Schema } from "effect";
import * as Decimal from "@thomasfosterau/effect-biz/Decimal";
import * as Quantity from "@thomasfosterau/effect-biz/Quantity";

const unit = Schema.decodeSync(Quantity.UnitCode);
const kg = new Quantity.Quantity({ amount: Decimal.make("1.25"), unit: unit("kg") });
const each = new Quantity.Quantity({ amount: Decimal.make("1"), unit: unit("each") });

const mismatch = Quantity.add(kg, each);
console.log(Result.isFailure(mismatch) && mismatch.failure.code); // "core.unit-mismatch"
```

#### Percentages and rates (`./Percentage`, `./Rate`)

`Percentage` holds a number of percent (`"12.5"` is 12.5%); `toFactor` (`0.125`) and `fromFactor` are exact, and `of(base, percentage, policy)` rounds. `Rate` is a positive dimensionless factor (an exchange rate, a multiplier); `apply(value, rate, policy)` and `invert(rate, policy)` round with the policy given, and `invert` fails with `core.rate-not-positive` if the result rounds to zero.

```ts
import { BigDecimal, Result } from "effect";
import * as Decimal from "@thomasfosterau/effect-biz/Decimal";
import * as Percentage from "@thomasfosterau/effect-biz/Percentage";
import * as Rate from "@thomasfosterau/effect-biz/Rate";
import * as Rounding from "@thomasfosterau/effect-biz/Rounding";

const cents = new Rounding.RoundingPolicy({ mode: "half-even", scale: 2 });
const gst = new Percentage.Percentage({ value: Decimal.make("10") });
console.log(BigDecimal.format(Percentage.of(Decimal.make("12.345"), gst, cents))); // "1.23"

const rate = new Rate.Rate({ value: Decimal.make("1.5432") });
console.log(BigDecimal.format(Rate.apply(Decimal.make("100"), rate, cents))); // "154.32"
const back = Rate.invert(rate, new Rounding.RoundingPolicy({ mode: "half-even", scale: 6 }));
console.log(Result.isSuccess(back) && BigDecimal.format(back.success.value)); // "0.648004"
```

#### Currency and money (`./Currency`, `./Money`)

`CurrencyCode` is three upper-case letters, branded. `Currency.minorUnits(code)` is the one ISO 4217 minor-unit table (2 by default; 0 for `JPY`, `KRW`, …; 3 for `KWD`, `BHD`, …; 4 for `CLF`, `UYW`).

`Money` is an exact `{ amount, currency }`, encoded as `{ "amount": "12.5", "currency": "AUD" }`. It is not the payments `Money` (`./Payments.Money`: integer minor units in a `number`, the providers' wire format); convert at the gateway edge with `toMinorUnits` and `fromMinorUnits`. `add`, `subtract` and `sum` fail with `core.currency-mismatch`; `multiply` by an exact factor never rounds; `round` defaults to the currency's minor units, half-even; `toMinorUnits` fails with `core.money-scale` rather than drop digits; `allocate` splits by the largest-remainder method so the parts sum exactly to the rounded total. `isZero`, `isNegative`, `Order` (within one currency) and `Equivalence` are there too.

```ts
import { BigDecimal, Result } from "effect";
import * as Currency from "@thomasfosterau/effect-biz/Currency";
import * as Decimal from "@thomasfosterau/effect-biz/Decimal";
import * as Money from "@thomasfosterau/effect-biz/Money";

const aud = Currency.make("AUD");
const total = Money.make(Decimal.make("100"), aud);

const parts = Money.allocate(total, [Decimal.make("1"), Decimal.make("1"), Decimal.make("1")]);
console.log(Result.isSuccess(parts) && parts.success.map((part) => BigDecimal.format(part.amount))); // ["33.34", "33.33", "33.33"]

const yen = Money.make(Decimal.make("1234.5"), Currency.make("JPY"));
console.log(Result.isFailure(Money.toMinorUnits(yen))); // true: round first
console.log(Result.getOrUndefined(Money.toMinorUnits(Money.round(yen)))); // 1234n

const mixed = Money.add(total, Money.zero(Currency.make("USD")));
console.log(Result.isFailure(mixed) && mixed.failure.code); // "core.currency-mismatch"
```

## Payments

A vendor-neutral payments core for Effect, under `@thomasfosterau/effect-biz/Payments` (the barrel) and `@thomasfosterau/effect-biz/Payments.<Module>` (one module each).

Write your payment workflows against provider-agnostic capabilities, and choose the provider at the edge of your application by the layer you provide: [`@thomasfosterau/effect-biz-payments-stripe`](https://www.npmjs.com/package/@thomasfosterau/effect-biz-payments-stripe) today. It is the payments analogue of Effect's AI modules: one abstraction, one package per provider.

Add a provider package to run a program.

### Usage

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

Providers may implement only the capabilities they support (Stripe implements every one). The type system enforces this: a program that needs a capability the provided layer doesn't supply does not type-check. An individual operation a provider lacks fails with `PaymentInvalidRequestError`; each provider's README lists them.

### Capabilities

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

#### Hosted checkout and billing portal

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

### Domain types

Entities are provider-agnostic `effect/Schema` classes: `Customer`, `Product`, `Price`, `PaymentIntent`, `Subscription`, `Refund`, `CheckoutSession`, `BillingPortalSession` and `Money`. They contain only fields that are meaningful across providers, in a normalized shape (`camelCase`, neutral status enums). **Amounts are always in the smallest currency unit** (`2000` = $20.00), and currencies are lower-cased ISO 4217 codes (`"usd"`).

Status and type enums are lenient: each is the known literals plus `Other` (`{ _tag: "Other", raw }`), carrying a provider value the library does not model, so an unexpected value never fails a whole list page. Match exhaustively with a case for `Other` (`Enumeration.isOther`). Each module exports the enum twice: `Known<Name>` (the literals, the type a request filter takes) and `<Name>` (the lenient union, the type of the entity field): `PaymentIntent.PaymentStatus`, `Subscription.SubscriptionStatus`, `Refund.RefundStatus`, `Price.PriceType` and `Price.RecurringInterval`. `CheckoutSession.CheckoutMode` is a request input and stays closed.

### Errors

The failure channel is the neutral `PaymentsError` union:

- `PaymentProviderError` — a provider rejected the request for a reason no other variant covers, or answered with a response that does not decode (carries `provider`, `code`, `statusCode`, `cause`).
- `PaymentAuthenticationError` — authentication failed (carries `statusCode`).
- `PaymentRateLimitError` — too many requests (carries `retryAfter`, in seconds, when the provider sends one).
- `PaymentInvalidRequestError` — invalid parameters, or an operation the provider does not support (carries `param`, `statusCode`).
- `PaymentNetworkError` — transport-level failure, including a timeout (carries `cause`).
- `PaymentsUnavailable` — no provider can serve the call, typically because its credential is not configured (carries `provider`). This is "not configured ≡ down": it is raised at call time, never while a layer is built, so an application without payments configured still starts and answers the call as it would an outage (an HTTP API answers it with a 503).

Outside the union: `PaymentConfigError` (raised while building a provider layer) and `SignatureVerificationError` (webhook verification).

```typescript
import { Effect } from "effect";
import * as Customer from "@thomasfosterau/effect-biz/Payments.Customer";

const program = Customer.create({ email: "jane@example.com" }).pipe(
  Effect.catchTags({
    PaymentAuthenticationError: (e) => Effect.logError(`Auth failed: ${e.message}`),
    PaymentRateLimitError: (e) => Effect.logError(`Rate limited; retry after ${e.retryAfter}s`),
  }),
);
```

### Retrying a write safely

A write that fails with a `PaymentNetworkError` (a timeout, a dropped connection), or a provider 5xx, has an **unknown outcome**: the provider may have applied it. Repeating it blindly can charge, refund or create twice. Pass an `idempotencyKey` and the provider recognises the repeat as the same write and answers with the original outcome instead of applying it again.

```typescript
import { Effect, Schedule } from "effect";
import * as IdempotencyKey from "@thomasfosterau/effect-biz/Payments.IdempotencyKey";
import * as Refund from "@thomasfosterau/effect-biz/Payments.Refund";
import type { PaymentsError } from "@thomasfosterau/effect-biz/Payments";

// The outcome may be unknown (or the write not applied): safe to repeat with the same key.
const isUnknownOutcome = (error: PaymentsError) =>
  error._tag === "PaymentNetworkError" ||
  error._tag === "PaymentRateLimitError" ||
  (error._tag === "PaymentProviderError" && (error.statusCode ?? 0) >= 500);

const refund = (paymentIntent: string) =>
  Effect.gen(function* () {
    const idempotencyKey = yield* IdempotencyKey.generate; // once per logical write
    return yield* Refund.create({ paymentIntent, idempotencyKey }).pipe(
      Effect.retry({
        while: isUnknownOutcome, // see "Retry only when" below
        schedule: Schedule.exponential("200 millis"),
        times: 3,
      }),
    ); // the same key on every attempt
  });
```

The rules:

- **One key per logical write**, created by the caller _before the first attempt_ (`IdempotencyKey.generate`, or your own id for the operation, such as `refund-${orderId}`) and passed unchanged on every retry. A key generated inside the retried effect is a new key per attempt and protects nothing. Never reuse a key for a different write: a provider answers the same key with different parameters with an error rather than the original outcome. Stripe's is `idempotency_error`, which surfaces as `PaymentProviderError` with code `StripeIdempotencyError` (not `PaymentInvalidRequestError`).
- **Accepted on the create and confirm operations** that every provider implementing them can honour: `Customer.create`, `Product.create`, `Price.create`, `PaymentIntent.create` / `confirm`, `Subscription.create`, `Refund.create`, `CheckoutSession.create`. It is optional, and a program that passes none behaves as before. Updates are set-semantics and repeatable. `Subscription.cancel` and `PaymentIntent.cancel` do **not** take one (not every provider can honour a key there; PayPal, a former provider, could not), and neither does `BillingPortal.create`: the option is absent from their types, so passing one does not compile.
- **Retry only when the outcome is unknown or the write was not applied**: `PaymentNetworkError`, `PaymentProviderError` with `statusCode >= 500` (a vendor 5xx surfaces as this, not as `PaymentNetworkError`) and `PaymentRateLimitError` (back off for `retryAfter` first). Do not retry `PaymentInvalidRequestError`, `PaymentAuthenticationError`, or a `PaymentProviderError` below 500 (including Stripe's `StripeIdempotencyError`): they fail the same way again.
- **The shape is the lowest common denominator**: 1 to 64 characters from `A-Z a-z 0-9 _ -` (a UUID is 36). `IdempotencyKey.IdempotencyKey` is the branded `Schema`; `IdempotencyKey.IdempotencyKey.make` (throws on a bad shape) or `IdempotencyKey.validate` (fails with `PaymentInvalidRequestError`) check a value of your own, and a raw string that slips past the types fails with `PaymentInvalidRequestError` before anything is sent.
- **A window, not forever**: providers remember a key for a limited time, differing per provider. Treat a retry within a few hours as safe, and a later one as a new write. The figures:

  | Provider | Key length | Kept for | Source |
  | --- | --- | --- | --- |
  | Stripe | 255 characters | at least 24 hours | unverified ([effect-finance#93](https://github.com/thomasfosterau/effect-finance/issues/93)) |

  The 1 to 64 character shape stays within the unverified Stripe figure.

Mapping: Stripe sends `Idempotency-Key`. Without a key, Stripe's client generates a key of its own per call (for its own internal retries), which does not deduplicate your retry.

### Stubs

`Stub` builds capability layers whose every call fails with one given failing `Effect` (`Stub.Failure`): `Stub.layer(failure)` for every capability, one constructor per capability (`Stub.customers`, …, `Stub.billingPortalSessions`), and `Stub.unavailable(provider?)`, every capability failing with `PaymentsUnavailable`, for an environment with no provider configured or a unit suite with no transport at all.

```typescript
import { Effect } from "effect";
import * as Customer from "@thomasfosterau/effect-biz/Payments.Customer";
import * as Stub from "@thomasfosterau/effect-biz/Payments.Stub";

// Fails with PaymentsUnavailable, as if the provider were down.
const exit = await Effect.runPromiseExit(
  Customer.create({ email: "jane@example.com" }).pipe(Effect.provide(Stub.unavailable("stripe"))),
);
```

### API

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

### Internal subpath (not public API)

`@thomasfosterau/effect-biz/Payments.internal` holds helpers that the provider packages in this repository share (`shareLogin`, one in-flight token login shared by every waiting caller; the integer money core used to convert between minor units and major-unit decimals; the token cache and time-boxed request helpers of an OAuth-style login; the request helpers of a provider built over a generated operation client; and the response decoding, timestamp reading and HTTP error-status classification of a REST provider). It exists only because a provider may import nothing else of this workspace. It is **internal and exempt from semver**: its exports can change or disappear in any release, minor and patch included. Do not import it from application code.

## License

MIT © Thomas Foster
