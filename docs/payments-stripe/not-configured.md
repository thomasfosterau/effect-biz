# "Not configured ≡ down"

A host without Stripe configured still starts and answers payment calls as it would an outage.

`StripePayments.layerConfig` reads the key (`STRIPE_API_KEY` by default, or `envVar`) on **every call**, never while the layer is built: from the calling fiber's `ConfigProvider` first, then from the one the layer was built under (so `layerConfig().pipe(Layer.provide(ConfigProvider.layer(…)))` works as it does for `layerFromEnv`). The layer therefore always builds, and a call made while the key is absent or empty fails with `PaymentsUnavailable` before Distilled runs, exactly as if Stripe were down (answer it with a 503). So a Worker without billing configured still boots and serves everything else, with or without `nodejs_compat`. Once the key is set, the calls need the `process` global (see [Runtime: a `process` global](runtime.md)): without it, each one dies with a defect instead of reaching Stripe.

```typescript
import { Effect, Layer } from "effect";
import { FetchHttpClient } from "effect/http";
import * as CheckoutSession from "@thomasfosterau/effect-biz/Payments.CheckoutSession";
import * as StripePayments from "@thomasfosterau/effect-biz-payments-stripe/StripePayments";

const billing = StripePayments.layerConfig({ envVar: "STRIPE_SECRET_KEY" }).pipe(
  Layer.provide(FetchHttpClient.layer),
);

const checkout = (params: CheckoutSession.CreateParams) =>
  CheckoutSession.create(params).pipe(
    Effect.map((session) => Response.redirect(session.url, 303)),
    Effect.catchTag("PaymentsUnavailable", () =>
      Effect.succeed(new Response(null, { status: 503 })),
    ),
    Effect.provide(billing),
  );
```

`StripeHttp.layerConfig` is the same posture for the resource modules' client. For a provider-neutral stub with no transport at all, use `Stub.unavailable("stripe")` from `@thomasfosterau/effect-biz/Payments.Stub`.
