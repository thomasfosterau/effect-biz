# Stubs

Capability layers for tests and for an environment with no provider configured.

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
