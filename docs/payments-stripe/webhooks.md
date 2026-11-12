# Webhooks

Verifying and decoding Stripe webhook deliveries.

`Webhook.verify` is a Workers-safe WebCrypto verifier (HMAC-SHA256, constant-time compare, ±300 s tolerance by default, "now" from `Clock`) that needs neither the SDK nor any Node API. Pass the raw body bytes; nothing is decoded until the signature verifies, and every refusal is a `SignatureVerificationError` that never carries the secret. `decodeHandledEvent` narrows a verified event to the handled event types (`handledEventTypes`: `checkout.session.completed`, `customer.subscription.created` / `updated` / `deleted` and `invoice.payment_failed`), decoding the fields of its `data.object` a handler reads; any other type is `Option.none()`.

Stripe treats every non-2xx answer as a failed delivery and retries it for a limited period (see [Stripe's webhook docs](https://docs.stripe.com/webhooks)), so the status mostly tells the operator which side is at fault: a 400 for a bad delivery (an unreadable body, a signature refusal, a signed body that is not an event envelope), a 500 for breakage on this side (a handled event that fails to decode, say after a field moved in a new API version). A fix that ships after the retries stop needs the event resent from the Dashboard.

```typescript
import { Effect, Option, Redacted, Schema } from "effect";
import * as Webhook from "@thomasfosterau/effect-biz-payments-stripe/Webhook";

class UnreadableBodyError extends Schema.TaggedError<
  UnreadableBodyError,
  { readonly brand: unique symbol }
>()("UnreadableBodyError", {}) {}

const status = (code: number) => Effect.succeed(new Response(null, { status: code }));

const handle = Effect.fn("handleStripeWebhook")(
  function* (request: Request, secret: Redacted.Redacted<string>) {
    const payload = new Uint8Array(
      yield* Effect.tryPromise({
        try: () => request.arrayBuffer(),
        catch: () => new UnreadableBodyError(),
      }),
    );
    const event = yield* Webhook.verify({
      payload,
      header: request.headers.get(Webhook.SIGNATURE_HEADER),
      secret,
    });
    return yield* Webhook.decodeHandledEvent(event).pipe(
      Effect.flatMap((handled) => {
        if (Option.isSome(handled)) {
          // Act on handled.value: its `type` narrows `data.object`.
        }
        // Acknowledge every other type: refusing it makes Stripe retry it.
        return status(200);
      }),
      // Breakage on this side: log the id and type, never the payload.
      Effect.catchTag("SchemaError", () =>
        Effect.logError("Handled Stripe event failed to decode").pipe(
          Effect.annotateLogs({ id: event.id, type: event.type }),
          Effect.andThen(status(500)),
        ),
      ),
    );
  },
  Effect.catchTags({
    SignatureVerificationError: () => status(400), // bare: never say which check failed
    SchemaError: () => status(400), // signed, but not an event envelope
    UnreadableBodyError: () => status(400),
  }),
);
```

[`examples/webhooks.ts`](https://github.com/thomasfosterau/effect-biz/blob/trunk/packages/payments-stripe/examples/webhooks.ts) is the full version: the secret read through `Config`, an exhaustive `Match` over the handled types, and a demo that signs its own test deliveries with `Webhook.signatureHeader`.

The SDK-based `Webhook.constructEvent` / `constructEventAsync` remain as an optional alternative; they run on an SDK client you provide, `Layer.succeed(Webhook.StripeService, new Stripe(key))` (the verifier uses only the endpoint secret, never the key). For them, a `tolerance` of `0` means the default 300 s; a negative tolerance skips the timestamp check. `Webhook.verify` reads `0` as "this second only".
