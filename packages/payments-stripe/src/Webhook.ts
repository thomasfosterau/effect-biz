/**
 * Stripe webhook verification and the event vocabulary a billing system acts
 * on.
 *
 * {@link verify} is the default verifier (WebCrypto, no SDK, no Node API). Its
 * JSDoc carries the verification notes a handler must follow, where they reach
 * the published declarations: pass the raw body bytes, answer every refusal
 * with a bare 400, the tolerance window, and the SDK-based verifier as the
 * alternative. It also has a sketch of a handler;
 * `packages/payments-stripe/examples/webhooks.ts` in the repository
 * (https://github.com/thomasfosterau/effect-biz) is the full version.
 *
 * An event type the system does not act on should still be verified and
 * acknowledged: {@link isHandledEventType} and {@link decodeHandledEvent}
 * narrow the envelope to the handled types ({@link handledEventTypes}) with
 * lenient decoders that read only the fields a handler needs.
 *
 * @module
 */

import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import type Stripe from "stripe";
import { SignatureVerificationError } from "@thomasfosterau/effect-biz/Payments";
import { omitUndefined } from "@thomasfosterau/effect-biz/Payments.internal";
import {
  anyMatches,
  parseSignatureHeader,
  signatureDigest,
  toBytes,
} from "./internal/signature.js";

// ---------------------------------------------------------------------------
// WebCrypto verifier (the default)
// ---------------------------------------------------------------------------

/**
 * The header Stripe signs every delivery with, lower-cased as `Headers.get`
 * accepts it.
 */
export const SIGNATURE_HEADER = "stripe-signature";

/** The input to {@link verifySignature} and {@link verify}. */
export interface VerifyOptions {
  /**
   * The raw request body exactly as received — a string, or its bytes. A
   * re-serialised parsed object does not reproduce the signed bytes.
   */
  readonly payload: string | Uint8Array;
  /**
   * The `Stripe-Signature` header value; `null` / `undefined` when the request
   * carried none (so `request.headers.get(SIGNATURE_HEADER)` can be passed
   * straight through), which is refused as malformed.
   */
  // oxlint-disable-next-line effect/prefer-option-over-null -- mirrors `Headers.get`, which answers a literal `null`
  readonly header: string | null | undefined;
  /** The webhook endpoint's signing secret (`whsec_…`). */
  readonly secret: Redacted.Redacted;
  /**
   * How far the signing time may be from now, either side, in seconds
   * (default {@link DEFAULT_TOLERANCE}). A future-dated timestamp is refused
   * just like a stale one. `0` means "the same second" — unlike the SDK's
   * {@link constructEvent}, where `0` disables the check. There is no way to
   * disable it here.
   */
  readonly tolerance?: number | undefined;
}

const refuse = (message: string, header: string | undefined) =>
  new SignatureVerificationError(omitUndefined({ message, header }));

/** `message` of a refusal for a missing header, or one without a `t=` and a `v1=`. */
export const MALFORMED_HEADER_MESSAGE = "Missing or malformed Stripe-Signature header";
/** `message` of a refusal for a signing time outside the tolerance window. */
export const OUTSIDE_TOLERANCE_MESSAGE = "Webhook timestamp is outside the tolerance window";
/** `message` of a refusal where no `v1` signature matches the payload. */
export const SIGNATURE_MISMATCH_MESSAGE = "No signature matches the payload";
/**
 * `message` of a refusal because the signature could not be computed: an
 * empty secret, or a runtime whose WebCrypto rejects the HMAC.
 */
export const SIGNATURE_UNAVAILABLE_MESSAGE = "Could not compute the webhook signature";
/** `message` of a refusal because the configured tolerance is not a usable number. */
export const INVALID_TOLERANCE_MESSAGE =
  "Webhook tolerance must be a finite, non-negative number of seconds";

/**
 * Verify a delivery's `Stripe-Signature` with WebCrypto, without decoding it.
 *
 * Succeeds with `void` when some `v1` digest in the header is the
 * HMAC-SHA256 of `${t}.${payload}` under `secret` and `t` is within
 * `tolerance` seconds of `Clock`'s now; otherwise fails with
 * {@link SignatureVerificationError}. Use {@link verify} to verify and decode
 * in one step.
 */
export const verifySignature = (
  options: VerifyOptions,
): Effect.Effect<void, SignatureVerificationError> =>
  Effect.gen(function* () {
    const header = options.header ?? undefined;
    const tolerance = options.tolerance ?? DEFAULT_TOLERANCE;
    // Fail closed: a NaN tolerance would otherwise make every timestamp pass.
    if (!Number.isFinite(tolerance) || tolerance < 0) {
      return yield* refuse(INVALID_TOLERANCE_MESSAGE, header);
    }
    const parsed = header === undefined ? Option.none() : parseSignatureHeader(header);
    if (Option.isNone(parsed)) return yield* refuse(MALFORMED_HEADER_MESSAGE, header);

    const { timestamp, candidates } = parsed.value;
    const now = Math.floor((yield* Clock.currentTimeMillis) / 1000);
    if (Math.abs(now - timestamp) > tolerance) {
      return yield* refuse(OUTSIDE_TOLERANCE_MESSAGE, header);
    }

    const expected = yield* signatureDigest(
      Redacted.value(options.secret),
      timestamp,
      toBytes(options.payload),
      () => refuse(SIGNATURE_UNAVAILABLE_MESSAGE, header),
    );
    return yield* anyMatches(expected, candidates)
      ? Effect.void
      : refuse(SIGNATURE_MISMATCH_MESSAGE, header);
  });

/**
 * Verify a delivery with WebCrypto, then decode its event envelope — the
 * default webhook verifier.
 *
 * It checks the `Stripe-Signature` header with `crypto.subtle`
 * (HMAC-SHA256), compares digests in constant time, enforces a tolerance
 * window around the signing time (±{@link DEFAULT_TOLERANCE} s unless
 * configured; see {@link VerifyOptions.tolerance}), and only then decodes the
 * event envelope. It needs neither the `stripe` SDK nor any Node API, so it
 * runs unchanged in a Cloudflare Worker, and it reads "now" from Effect's
 * `Clock`, so tests drive it with `TestClock`. Nothing is decoded until the
 * signature verifies. A signed body that is not a JSON event envelope fails
 * with `Schema.SchemaError` rather than throwing.
 *
 * **Pass the raw body.** Stripe sends
 * `Stripe-Signature: t=<unix>,v1=<hex>[,v1=<hex>…]`, and `v1` is HMAC-SHA256
 * with the endpoint's signing secret over `${t}.${rawBody}`. The signature is
 * over the **raw** body bytes, so pass the request body exactly as received —
 * canonically its bytes, `new Uint8Array(await request.arrayBuffer())`, and
 * never a re-serialised parsed object. `await request.text()` is a lossy
 * convenience: it strips a byte-order mark and replaces invalid UTF-8, so a
 * body that has either will not verify. Several `v1` values appear during a
 * secret rotation; every one is compared.
 *
 * **Answer every refusal with a bare 400.** Every refusal is a
 * {@link SignatureVerificationError} whose `message` is one of a fixed set of
 * exported constants (malformed header, timestamp outside the window, no
 * matching signature, an unusable tolerance, a signature that could not be
 * computed). The signing secret is taken as a `Redacted` and never reaches an
 * error; the payload is not copied into the error either. Telling a caller
 * which check failed helps forge the next attempt.
 *
 * Stripe treats every non-2xx answer as a failed delivery and retries it for
 * a limited period (see https://docs.stripe.com/webhooks), so the status
 * mostly tells the operator which side is at fault: a 400 for a bad delivery,
 * a 500 for a handled event that fails to decode (breakage on this side, say a
 * field moved in a new API version). Acknowledge the event types the system
 * does not act on with a 2xx. A fix that ships after the retries stop needs
 * the event resent from the Dashboard.
 *
 * **The SDK-based verifier stays available** as {@link constructEvent} /
 * {@link constructEventAsync} (and the `generateTestHeaderString*` helpers).
 * Those need an SDK client you build ({@link StripeService}) and the
 * optional `stripe` peer installed; this package never loads the SDK itself.
 *
 * A sketch of a handler: answer every refusal with a bare 400, acknowledge
 * the event types it does not act on, and answer a handled event that fails
 * to decode with a 500.
 *
 * @example
 * ```typescript
 * import { Effect, Option, Redacted, Schema } from "effect";
 * import * as Webhook from "@thomasfosterau/effect-biz-payments-stripe/Webhook";
 *
 * class UnreadableBodyError extends Schema.TaggedError<UnreadableBodyError>()(
 *   "UnreadableBodyError",
 *   {},
 * ) {}
 *
 * const status = (code: number) => Effect.succeed(new Response(null, { status: code }));
 *
 * const handle = Effect.fn("handleStripeWebhook")(
 *   function* (request: Request, secret: Redacted.Redacted<string>) {
 *     const payload = new Uint8Array(
 *       yield* Effect.tryPromise({
 *         try: () => request.arrayBuffer(),
 *         catch: () => new UnreadableBodyError(),
 *       }),
 *     );
 *     const event = yield* Webhook.verify({
 *       payload,
 *       header: request.headers.get(Webhook.SIGNATURE_HEADER),
 *       secret,
 *     });
 *     return yield* Webhook.decodeHandledEvent(event).pipe(
 *       Effect.flatMap((handled) => {
 *         if (Option.isSome(handled)) {
 *           switch (handled.value.type) {
 *             case "checkout.session.completed":
 *               // handled.value.data.object is a CheckoutSessionObject
 *               break;
 *             // …
 *           }
 *         }
 *         // Acknowledge every other type: refusing it makes Stripe retry it.
 *         return status(200);
 *       }),
 *       // Breakage on this side: log the id and type, never the payload.
 *       Effect.catchTag("SchemaError", () =>
 *         Effect.logError("Handled Stripe event failed to decode").pipe(
 *           Effect.annotateLogs({ id: event.id, type: event.type }),
 *           Effect.andThen(status(500)),
 *         ),
 *       ),
 *     );
 *   },
 *   Effect.catchTags({
 *     SignatureVerificationError: () => status(400), // bare: never say which check failed
 *     SchemaError: () => status(400), // signed, but not an event envelope
 *     UnreadableBodyError: () => status(400),
 *   }),
 * );
 * ```
 */
export const verify = (
  options: VerifyOptions,
): Effect.Effect<WebhookEvent, SignatureVerificationError | Schema.SchemaError> =>
  // The decode is built only once verification has succeeded: nothing touches
  // an unverified body.
  Effect.andThen(verifySignature(options), () => decodeEvent(options.payload));

/**
 * Build a `Stripe-Signature` header for `payload` the way Stripe signs it
 * (WebCrypto, no SDK) — for testing a webhook handler. The timestamp defaults
 * to `Clock`'s now.
 *
 * For tests and tooling only — never call it in a request handler: a server
 * that signs is a server that can forge its own deliveries.
 */
export const signatureHeader = (options: {
  readonly payload: string | Uint8Array;
  readonly secret: Redacted.Redacted;
  /** The signing time in UNIX seconds (default: now). */
  readonly timestamp?: number | undefined;
}): Effect.Effect<string, SignatureVerificationError> =>
  Effect.gen(function* () {
    const timestamp = options.timestamp ?? Math.floor((yield* Clock.currentTimeMillis) / 1000);
    const digest = yield* signatureDigest(
      Redacted.value(options.secret),
      timestamp,
      toBytes(options.payload),
      () => refuse(SIGNATURE_UNAVAILABLE_MESSAGE, undefined),
    );
    return `t=${timestamp},v1=${digest}`;
  });

// ---------------------------------------------------------------------------
// The event vocabulary
// ---------------------------------------------------------------------------

/** An optional, nullable field: Stripe sends `null` for an unset value. */
const Maybe = <S extends Schema.Top>(schema: S) => Schema.optional(Schema.NullOr(schema));

/**
 * The event envelope common to every Stripe event.
 *
 * `data.object` stays `Schema.Unknown`: its shape depends on the event type,
 * and an event type nobody handles must never fail to decode. Unknown fields
 * are ignored.
 */
export const WebhookEvent = Schema.Struct({
  id: Schema.String,
  type: Schema.String,
  created: Schema.optional(Schema.Number),
  livemode: Schema.optional(Schema.Boolean),
  api_version: Maybe(Schema.String),
  data: Schema.Struct({ object: Schema.Unknown }),
});

/** A decoded {@link WebhookEvent} envelope. */
export type WebhookEvent = typeof WebhookEvent.Type;

const decodeEventJson = Schema.decodeUnknownEffect(Schema.fromJsonString(WebhookEvent));

/**
 * Decode an event envelope from the raw body (a JSON string, or its UTF-8
 * bytes). Fails with `Schema.SchemaError` — never throws — on a body that is
 * not JSON or not an envelope. {@link verify} calls this after verification;
 * call it directly only on a payload already verified.
 */
export const decodeEvent = (
  payload: string | Uint8Array,
): Effect.Effect<WebhookEvent, Schema.SchemaError> =>
  decodeEventJson(Predicate.isString(payload) ? payload : new TextDecoder().decode(payload));

/**
 * The event types a subscription billing system acts on:
 *
 * - `checkout.session.completed` — the customer finished paying; the session
 *   carries the customer and the subscription it created.
 * - `customer.subscription.{created,updated,deleted}` — every subsequent
 *   subscription state change.
 * - `invoice.payment_failed` — dunning started.
 *
 * Any other type should still be verified and acknowledged: an endpoint that
 * refuses an event type it does not handle makes Stripe retry it.
 */
export const handledEventTypes = [
  "checkout.session.completed",
  "customer.subscription.created",
  "customer.subscription.updated",
  "customer.subscription.deleted",
  "invoice.payment_failed",
] as const;

/** One of {@link handledEventTypes}. */
export type HandledEventType = (typeof handledEventTypes)[number];

/** Whether an event type is one of {@link handledEventTypes}. */
export const isHandledEventType = (type: string): type is HandledEventType =>
  // SAFETY: widening a readonly tuple of string literals to its element supertype
  (handledEventTypes as ReadonlyArray<string>).includes(type);

const Metadata = Maybe(Schema.Record(Schema.String, Schema.String));

/**
 * The `checkout.session` fields a completion handler reads. The ids are
 * optional because Stripe omits them for modes that do not create one (a
 * `payment`-mode session has no subscription).
 */
export const CheckoutSessionObject = Schema.Struct({
  id: Schema.String,
  mode: Maybe(Schema.String),
  customer: Maybe(Schema.String),
  subscription: Maybe(Schema.String),
  client_reference_id: Maybe(Schema.String),
  metadata: Metadata,
});

/** A decoded {@link CheckoutSessionObject}. */
export type CheckoutSessionObject = typeof CheckoutSessionObject.Type;

/**
 * The `subscription` fields a state-change handler reads. `status` is any
 * string, so a status Stripe adds later still decodes; match it against the
 * core's `KnownSubscriptionStatus` where a closed set is wanted.
 * `current_period_end` is read both at the top level and per item (Stripe
 * moved it onto the item in later API versions).
 */
export const SubscriptionObject = Schema.Struct({
  id: Schema.String,
  customer: Schema.String,
  status: Schema.String,
  // oxlint-disable-next-line effect/require-is-prefix-for-boolean-schema-field -- Stripe's own field name
  cancel_at_period_end: Schema.Boolean,
  current_period_end: Maybe(Schema.Number),
  metadata: Metadata,
  items: Schema.Struct({
    data: Schema.Array(
      Schema.Struct({
        current_period_end: Maybe(Schema.Number),
        price: Schema.Struct({ id: Schema.String }),
      }),
    ),
  }),
});

/** A decoded {@link SubscriptionObject}. */
export type SubscriptionObject = typeof SubscriptionObject.Type;

/**
 * The `invoice` fields a dunning handler reads: who to tell.
 *
 * The subscription is decoded from both places Stripe has put it: the
 * top-level `subscription` (API versions up to `2025-02-24.acacia`, an
 * account's older pin) and `parent.subscription_details.subscription` (from
 * `2025-03-31.basil`, which removed the top-level field). Read it with
 * {@link invoiceSubscription}, which prefers the newer location.
 */
export const InvoiceObject = Schema.Struct({
  id: Maybe(Schema.String),
  customer: Maybe(Schema.String),
  subscription: Maybe(Schema.String),
  parent: Maybe(
    Schema.Struct({
      subscription_details: Maybe(Schema.Struct({ subscription: Maybe(Schema.String) })),
    }),
  ),
});

/** A decoded {@link InvoiceObject}. */
export type InvoiceObject = typeof InvoiceObject.Type;

/**
 * The subscription an invoice bills, wherever the event's API version put it:
 * `parent.subscription_details.subscription` when present, else the legacy
 * top-level `subscription`; `none` for an invoice outside any subscription.
 */
export const invoiceSubscription = (invoice: InvoiceObject): Option.Option<string> =>
  Option.orElse(Option.fromNullishOr(invoice.parent?.subscription_details?.subscription), () =>
    Option.fromNullishOr(invoice.subscription),
  );

const eventOf = <T extends Schema.Top, O extends Schema.Top>(type: T, object: O) =>
  Schema.Struct({ id: Schema.String, type, data: Schema.Struct({ object }) });

/**
 * A handled event, discriminated on `type`, with `data.object` decoded by the
 * schema for that type.
 */
export const HandledEvent = Schema.Union([
  eventOf(Schema.Literal("checkout.session.completed"), CheckoutSessionObject),
  eventOf(
    Schema.Literals([
      "customer.subscription.created",
      "customer.subscription.updated",
      "customer.subscription.deleted",
    ]),
    SubscriptionObject,
  ),
  eventOf(Schema.Literal("invoice.payment_failed"), InvoiceObject),
]);

/** A decoded {@link HandledEvent}. */
export type HandledEvent = typeof HandledEvent.Type;

const decodeHandled = Schema.decodeUnknownEffect(HandledEvent);

/**
 * Narrow a verified envelope to a {@link HandledEvent}: `none` for an event
 * type outside {@link handledEventTypes} (acknowledge it and move on), or the
 * event with its object decoded. A handled type whose object lacks a field
 * the handler needs fails with `Schema.SchemaError`.
 */
export const decodeHandledEvent = (
  event: WebhookEvent,
): Effect.Effect<Option.Option<HandledEvent>, Schema.SchemaError> =>
  isHandledEventType(event.type)
    ? Effect.map(decodeHandled(event), Option.some)
    : Effect.succeedNone;

const decodeCheckoutSessionObject = Schema.decodeUnknownEffect(CheckoutSessionObject);
const decodeSubscriptionObject = Schema.decodeUnknownEffect(SubscriptionObject);
const decodeInvoiceObject = Schema.decodeUnknownEffect(InvoiceObject);

/** Decode a `checkout.session.completed` event's `data.object`. */
export const decodeCheckoutSession = (
  object: unknown,
): Effect.Effect<CheckoutSessionObject, Schema.SchemaError> => decodeCheckoutSessionObject(object);

/** Decode a `customer.subscription.*` event's `data.object`. */
export const decodeSubscription = (
  object: unknown,
): Effect.Effect<SubscriptionObject, Schema.SchemaError> => decodeSubscriptionObject(object);

/** Decode an `invoice.payment_failed` event's `data.object`. */
export const decodeInvoice = (object: unknown): Effect.Effect<InvoiceObject, Schema.SchemaError> =>
  decodeInvoiceObject(object);

// ---------------------------------------------------------------------------
// SDK-based verifier (optional: needs an SDK client and the `stripe` peer)
// ---------------------------------------------------------------------------

/**
 * The official `stripe` SDK client the SDK-based verifier
 * ({@link constructEvent}, {@link constructEventAsync} and the
 * `generateTestHeaderString*` helpers) runs on. This package never builds or
 * loads one: provide your own, `Layer.succeed(StripeService, new Stripe(key))`
 * (the verifier reads only `stripe.webhooks`, which signs and checks with the
 * endpoint secret, never the API key). The `stripe` peer is optional, and
 * this module imports only its types.
 */
export class StripeService extends Context.Service<StripeService, Stripe>()(
  "@effect-biz/payments-stripe/StripeService",
) {}

/**
 * Configuration for webhook verification
 */
export interface WebhookConfig {
  /**
   * The webhook endpoint secret (starts with `whsec_`)
   */
  readonly secret: string;

  /**
   * Tolerance in seconds for timestamp verification (default: 300)
   */
  readonly tolerance?: number | undefined;
}

/**
 * The tolerance `constructEvent` / `constructEventAsync` hand the SDK: `0`
 * means {@link DEFAULT_TOLERANCE}; a negative value (which skips the
 * timestamp check) and `undefined` (the SDK's own default) go as given.
 */
const sdkTolerance = (tolerance: number | undefined): number | undefined =>
  tolerance === 0 ? DEFAULT_TOLERANCE : tolerance;

/** A payload the SDK takes as text: a `Buffer` is read as UTF-8. */
const payloadText = (payload: string | Buffer): string =>
  Predicate.isString(payload) ? payload : payload.toString("utf8");

/**
 * The `SignatureVerificationError` an SDK-based wrapper fails with when the
 * SDK throws: the thrown value's message, the header it was given (if any)
 * and the payload as a string.
 */
const sdkFailure = (
  error: unknown,
  payload: string | Buffer,
  header: string | undefined,
): SignatureVerificationError =>
  new SignatureVerificationError({
    // The thrown error's message; the value as a string when it carries none.
    message:
      Predicate.hasProperty(error, "message") && Predicate.isString(error.message)
        ? error.message
        : String(error),
    header,
    payload: payloadText(payload),
  });

/**
 * Construct an Event from a webhook payload and signature with the SDK's
 * verifier — the optional alternative to {@link verify}, needing
 * {@link StripeService} (an SDK client you build) and the `stripe` peer.
 *
 * This function verifies the webhook signature and returns the parsed Event object.
 * It uses the Stripe SDK's `constructEvent` method for synchronous verification.
 *
 * @param payload - The raw request body as a string or Buffer
 * @param signature - The Stripe-Signature header value
 * @param secret - The webhook endpoint secret (starts with `whsec_`)
 * @param tolerance - Tolerance in seconds for timestamp verification (default: 300).
 *   `0` means the default 300 s; a negative tolerance skips the timestamp
 *   check. (For {@link verify}, `0` means the current second only.)
 * @returns Effect that resolves to the verified Event object
 *
 * @example
 * ```typescript
 * import { Effect, Layer } from "effect";
 * import Stripe from "stripe";
 * import * as Webhook from "@thomasfosterau/effect-biz-payments-stripe/Webhook";
 *
 * const handle = (requestBody: string, stripeSignatureHeader: string) =>
 *   Effect.gen(function* () {
 *     const event = yield* Webhook.constructEvent(
 *       requestBody,
 *       stripeSignatureHeader,
 *       "whsec_your_secret"
 *     );
 *     console.log("Event type:", event.type);
 *     return event;
 *   });
 *
 * const layer = Layer.succeed(Webhook.StripeService, new Stripe("sk_test_..."));
 * // Run once per delivery, with the raw body and its Stripe-Signature header.
 * const onDelivery = (requestBody: string, stripeSignatureHeader: string) =>
 *   Effect.runPromise(handle(requestBody, stripeSignatureHeader).pipe(Effect.provide(layer)));
 * ```
 */
export const constructEvent = (
  payload: string | Buffer,
  signature: string,
  secret: string,
  tolerance?: number,
): Effect.Effect<Stripe.Event, SignatureVerificationError, StripeService> =>
  Effect.gen(function* () {
    const stripe = yield* StripeService;

    return yield* Effect.try({
      try: () =>
        stripe.webhooks.constructEvent(payload, signature, secret, sdkTolerance(tolerance)),
      catch: (error) => sdkFailure(error, payload, signature),
    });
  });

/**
 * Construct an Event from a webhook payload and signature (async version)
 * with the SDK's verifier — the optional alternative to {@link verify}.
 *
 * This function verifies the webhook signature asynchronously and returns the parsed Event object.
 * It uses the Stripe SDK's `constructEventAsync` method.
 *
 * @param payload - The raw request body as a string or Buffer
 * @param signature - The Stripe-Signature header value
 * @param secret - The webhook endpoint secret (starts with `whsec_`)
 * @param tolerance - Tolerance in seconds for timestamp verification (default: 300).
 *   `0` means the default 300 s; a negative tolerance skips the timestamp
 *   check. (For {@link verify}, `0` means the current second only.)
 * @param cryptoProvider - Optional custom crypto provider
 * @returns Effect that resolves to the verified Event object
 *
 * @example
 * ```typescript
 * import { Effect, Layer } from "effect";
 * import Stripe from "stripe";
 * import * as Webhook from "@thomasfosterau/effect-biz-payments-stripe/Webhook";
 *
 * const handle = (requestBody: string, stripeSignatureHeader: string) =>
 *   Effect.gen(function* () {
 *     const event = yield* Webhook.constructEventAsync(
 *       requestBody,
 *       stripeSignatureHeader,
 *       "whsec_your_secret"
 *     );
 *     console.log("Event type:", event.type);
 *     return event;
 *   });
 *
 * const layer = Layer.succeed(Webhook.StripeService, new Stripe("sk_test_..."));
 * // Run once per delivery, with the raw body and its Stripe-Signature header.
 * const onDelivery = (requestBody: string, stripeSignatureHeader: string) =>
 *   Effect.runPromise(handle(requestBody, stripeSignatureHeader).pipe(Effect.provide(layer)));
 * ```
 */
export const constructEventAsync = (
  payload: string | Buffer,
  signature: string,
  secret: string,
  tolerance?: number,
  cryptoProvider?: Stripe.CryptoProvider,
): Effect.Effect<Stripe.Event, SignatureVerificationError, StripeService> =>
  Effect.gen(function* () {
    const stripe = yield* StripeService;

    return yield* Effect.tryPromise({
      try: () =>
        stripe.webhooks.constructEventAsync(
          payload,
          signature,
          secret,
          sdkTolerance(tolerance),
          cryptoProvider,
        ),
      catch: (error) => sdkFailure(error, payload, signature),
    });
  });

/**
 * Generate a test header string for testing webhook handling
 *
 * This is useful for testing your webhook handler without needing to
 * trigger real events from Stripe.
 *
 * @param payload - The payload to sign
 * @param secret - The webhook endpoint secret
 * @param timestamp - Optional timestamp (defaults to current time)
 * @returns Effect that resolves to the signature header string
 *
 * @example
 * ```typescript
 * import { Effect, Layer } from "effect";
 * import Stripe from "stripe";
 * import * as Webhook from "@thomasfosterau/effect-biz-payments-stripe/Webhook";
 *
 * const program = Effect.gen(function* () {
 *   const payload = JSON.stringify({ type: "payment_intent.succeeded" });
 *   const secret = "whsec_test_secret";
 *   const signature = yield* Webhook.generateTestHeaderString(payload, secret);
 *
 *   // Use the signature to test your webhook handler
 *   const event = yield* Webhook.constructEvent(payload, signature, secret);
 *   return event;
 * });
 *
 * const layer = Layer.succeed(Webhook.StripeService, new Stripe("sk_test_..."));
 * await Effect.runPromise(program.pipe(Effect.provide(layer)));
 * ```
 */
export const generateTestHeaderString = (
  payload: string | Buffer,
  secret: string,
  timestamp?: number,
): Effect.Effect<string, SignatureVerificationError, StripeService> =>
  Effect.gen(function* () {
    const stripe = yield* StripeService;
    return yield* Effect.try({
      try: () =>
        stripe.webhooks.generateTestHeaderString(
          omitUndefined({
            payload: payloadText(payload),
            secret,
            timestamp,
          }),
        ),
      catch: (error) => sdkFailure(error, payload, undefined),
    });
  });

/**
 * Generate a test header string for testing webhook handling (async version)
 *
 * This is useful for testing your webhook handler without needing to
 * trigger real events from Stripe. This version uses async cryptography.
 *
 * @param payload - The payload to sign
 * @param secret - The webhook endpoint secret
 * @param timestamp - Optional timestamp (defaults to current time)
 * @param cryptoProvider - Optional custom crypto provider
 * @returns Effect that resolves to the signature header string
 *
 * @example
 * ```typescript
 * import { Effect, Layer } from "effect";
 * import Stripe from "stripe";
 * import * as Webhook from "@thomasfosterau/effect-biz-payments-stripe/Webhook";
 *
 * const program = Effect.gen(function* () {
 *   const payload = JSON.stringify({ type: "payment_intent.succeeded" });
 *   const secret = "whsec_test_secret";
 *   const signature = yield* Webhook.generateTestHeaderStringAsync(
 *     payload,
 *     secret
 *   );
 *
 *   // Use the signature to test your webhook handler
 *   const event = yield* Webhook.constructEventAsync(
 *     payload,
 *     signature,
 *     secret
 *   );
 *   return event;
 * });
 *
 * const layer = Layer.succeed(Webhook.StripeService, new Stripe("sk_test_..."));
 * await Effect.runPromise(program.pipe(Effect.provide(layer)));
 * ```
 */
export const generateTestHeaderStringAsync = (
  payload: string | Buffer,
  secret: string,
  timestamp?: number,
  cryptoProvider?: Stripe.CryptoProvider,
): Effect.Effect<string, SignatureVerificationError, StripeService> =>
  Effect.gen(function* () {
    const stripe = yield* StripeService;
    return yield* Effect.tryPromise({
      try: () =>
        stripe.webhooks.generateTestHeaderStringAsync(
          omitUndefined({
            payload: payloadText(payload),
            secret,
            timestamp,
            cryptoProvider,
          }),
        ),
      catch: (error) => sdkFailure(error, payload, undefined),
    });
  });

/**
 * The default tolerance, in seconds, between a signature's timestamp and now
 * (either side) — Stripe's own default — for {@link verify} and the SDK-based
 * verifier alike. The two differ on a tolerance of `0`: {@link verify} reads
 * it as "the same second", {@link constructEvent} / {@link constructEventAsync}
 * as this default; for the latter, a negative tolerance skips the timestamp
 * check.
 */
export const DEFAULT_TOLERANCE: number = 300;
