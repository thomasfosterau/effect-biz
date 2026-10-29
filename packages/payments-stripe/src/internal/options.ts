import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { PaymentInvalidRequestError } from "@thomasfosterau/effect-biz/Payments";

/**
 * Refuse an empty per-call option before anything is sent. An empty
 * `idempotencyKey` would suppress the client's generated key and send an
 * empty header, leaving the `POST` unprotected; an empty `stripeAccount` would
 * send an empty `Stripe-Account`, and an empty `apiVersion` an empty
 * `Stripe-Version`. Failing with `PaymentInvalidRequestError` beats silently
 * treating any of them as absent.
 */
export const checkOptions = (options: {
  readonly idempotencyKey?: string | undefined;
  readonly stripeAccount?: string | undefined;
  readonly apiVersion?: string | undefined;
}): Effect.Effect<void, PaymentInvalidRequestError> =>
  Option.match(
    Arr.findFirst(
      ["idempotencyKey", "stripeAccount", "apiVersion"] as const,
      (name) => options[name] === "",
    ),
    {
      onNone: () => Effect.void,
      onSome: (name) =>
        Effect.fail(
          new PaymentInvalidRequestError({ message: `${name} must not be empty`, param: name }),
        ),
    },
  );
