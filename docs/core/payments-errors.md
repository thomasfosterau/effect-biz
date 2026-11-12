# Payments errors

The failure channel of every payments capability.

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
