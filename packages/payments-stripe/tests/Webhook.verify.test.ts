/**
 * The default, WebCrypto webhook verifier (`Webhook.verify`) and the event
 * vocabulary. Ported from gardeneria's `packages/billing/tests/webhook.test.ts`
 * (the behavioural spec), plus the cases the port adds: byte payloads,
 * a configurable tolerance, fail-closed tolerance values and the handled-event
 * decoder.
 *
 * Each failure mode is asserted on its own. The MAC is computed here with
 * WebCrypto independently of the module under test, signing exactly as Stripe
 * does, so a change to the scheme fails the happy path rather than silently
 * weakening the check. "Now" comes from `TestClock`.
 */

import { assert, describe, expect, onTestFinished, vi } from "vite-plus/test";
import { it } from "@effect/vitest";
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import { TestClock } from "effect/testing";
import { SignatureVerificationError } from "@thomasfosterau/effect-biz/Payments";
import { awaitTestPromise, type TestPromiseRejected } from "../../../tests/stubs.ts";
import * as Webhook from "../src/Webhook.ts";

const SECRET = "whsec_test_do_not_use_anywhere_real";
const NOW = 1_760_000_000;
const TOLERANCE = Webhook.DEFAULT_TOLERANCE;

/** Sign a payload exactly as Stripe does: HMAC-SHA256 over `${t}.${body}`, hex. */
const digest = (
  payload: string,
  timestamp: number,
  secret = SECRET,
): Effect.Effect<string, TestPromiseRejected> =>
  Effect.gen(function* () {
    const key = yield* awaitTestPromise(() =>
      crypto.subtle.importKey(
        "raw",
        new TextEncoder().encode(secret),
        { name: "HMAC", hash: "SHA-256" },
        false,
        ["sign"],
      ),
    );
    const mac = yield* awaitTestPromise(() =>
      crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${timestamp}.${payload}`)),
    );
    return [...new Uint8Array(mac)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  });

const sign = (
  payload: string,
  timestamp: number,
  secret = SECRET,
): Effect.Effect<string, TestPromiseRejected> =>
  Effect.map(digest(payload, timestamp, secret), (hex) => `t=${timestamp},v1=${hex}`);

/** Run `effect` with the clock at `nowSeconds`. */
const at = <A, E>(nowSeconds: number, effect: Effect.Effect<A, E>): Effect.Effect<A, E> =>
  Effect.gen(function* () {
    yield* TestClock.setTime(nowSeconds * 1000);
    return yield* effect;
  }).pipe(Effect.provide(TestClock.layer()));

type Options = Partial<Webhook.VerifyOptions>;

const verifySignature = (payload: string | Uint8Array, header: string | null, options?: Options) =>
  at(
    NOW,
    Effect.result(
      Webhook.verifySignature({ payload, header, secret: Redacted.make(SECRET), ...options }),
    ),
  );

/** `undefined` when the signature verified, else the refusal's message. */
const refusal = (
  payload: string | Uint8Array,
  header: string | null,
  options?: Options,
): Effect.Effect<string | undefined> =>
  Effect.gen(function* () {
    const result = yield* verifySignature(payload, header, options);
    if (Result.isSuccess(result)) return undefined;
    expect(result.failure).toBeInstanceOf(SignatureVerificationError);
    return result.failure.message;
  });

/** A test event's body: the event serialised as `JSON.stringify` does. */
const toJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

const BODY = toJson({
  id: "evt_1",
  type: "customer.subscription.updated",
  data: { object: { id: "sub_1" } },
});

describe("Webhook.verifySignature", () => {
  it.effect("accepts a genuine signature", () =>
    Effect.gen(function* () {
      expect(yield* refusal(BODY, yield* sign(BODY, NOW))).toBeUndefined();
    }),
  );

  it.effect("accepts a signature within the tolerance window on either side", () =>
    Effect.gen(function* () {
      expect(yield* refusal(BODY, yield* sign(BODY, NOW - TOLERANCE + 1))).toBeUndefined();
      expect(yield* refusal(BODY, yield* sign(BODY, NOW + TOLERANCE - 1))).toBeUndefined();
      // The window is inclusive at its edges.
      expect(yield* refusal(BODY, yield* sign(BODY, NOW - TOLERANCE))).toBeUndefined();
    }),
  );

  it.effect("refuses a body tampered with after signing", () =>
    Effect.gen(function* () {
      const header = yield* sign(BODY, NOW);
      const tampered = BODY.replace("updated", "deleted");
      expect(yield* refusal(tampered, header)).toBe(Webhook.SIGNATURE_MISMATCH_MESSAGE);
    }),
  );

  it.effect("refuses a signature made with a different secret", () =>
    Effect.gen(function* () {
      const header = yield* sign(BODY, NOW, "whsec_some_other_endpoints_secret");
      expect(yield* refusal(BODY, header)).toBe(Webhook.SIGNATURE_MISMATCH_MESSAGE);
    }),
  );

  it.effect("refuses a timestamp changed after signing", () =>
    Effect.gen(function* () {
      const genuine = yield* digest(BODY, NOW);
      expect(yield* refusal(BODY, `t=${NOW - 1},v1=${genuine}`)).toBe(
        Webhook.SIGNATURE_MISMATCH_MESSAGE,
      );
    }),
  );

  it.effect("refuses a replay from outside the tolerance window", () =>
    Effect.gen(function* () {
      const header = yield* sign(BODY, NOW - TOLERANCE - 1);
      expect(yield* refusal(BODY, header)).toBe(Webhook.OUTSIDE_TOLERANCE_MESSAGE);
    }),
  );

  it.effect("refuses a future-dated timestamp just as firmly", () =>
    Effect.gen(function* () {
      const header = yield* sign(BODY, NOW + TOLERANCE + 1);
      expect(yield* refusal(BODY, header)).toBe(Webhook.OUTSIDE_TOLERANCE_MESSAGE);
    }),
  );

  it.effect("honours a configured tolerance", () =>
    Effect.gen(function* () {
      const header = yield* sign(BODY, NOW - 3600);
      expect(yield* refusal(BODY, header)).toBe(Webhook.OUTSIDE_TOLERANCE_MESSAGE);
      expect(yield* refusal(BODY, header, { tolerance: 7200 })).toBeUndefined();
      expect(yield* refusal(BODY, yield* sign(BODY, NOW - 11), { tolerance: 10 })).toBe(
        Webhook.OUTSIDE_TOLERANCE_MESSAGE,
      );
    }),
  );

  it.effect.each([Number.NaN, Number.POSITIVE_INFINITY, -1])(
    "fails closed on an unusable tolerance (%s)",
    (tolerance) =>
      Effect.gen(function* () {
        expect(yield* refusal(BODY, yield* sign(BODY, NOW), { tolerance })).toBe(
          Webhook.INVALID_TOLERANCE_MESSAGE,
        );
      }),
  );

  it.effect("reads now from the Clock", () =>
    Effect.gen(function* () {
      const header = yield* sign(BODY, NOW);
      const later = yield* at(
        NOW + TOLERANCE + 1,
        Effect.flip(
          Webhook.verifySignature({ payload: BODY, header, secret: Redacted.make(SECRET) }),
        ),
      );
      expect(later.message).toBe(Webhook.OUTSIDE_TOLERANCE_MESSAGE);
    }),
  );

  it.effect.each([
    ["missing (null)", null],
    ["empty", ""],
    ["no v1 part", `t=${NOW}`],
    ["an empty v1", `t=${NOW},v1=`],
    ["no timestamp", "v1=deadbeef"],
    ["non-numeric timestamp", "t=yesterday,v1=deadbeef"],
    ["a non-integer timestamp", `t=${NOW}.5,v1=deadbeef`],
    ["an empty timestamp", "t=,v1=deadbeef"],
    ["only a v0 scheme", `t=${NOW},v0=deadbeef`],
    ["not the scheme at all", "Bearer something"],
  ])("refuses a malformed header (%s)", ([_label, header]) =>
    Effect.gen(function* () {
      expect(yield* refusal(BODY, header)).toBe(Webhook.MALFORMED_HEADER_MESSAGE);
    }),
  );

  it.effect("refuses a missing header passed as undefined", () =>
    Effect.gen(function* () {
      const error = yield* at(
        NOW,
        Effect.flip(
          Webhook.verifySignature({
            payload: BODY,
            header: undefined,
            secret: Redacted.make(SECRET),
          }),
        ),
      );
      expect(error.message).toBe(Webhook.MALFORMED_HEADER_MESSAGE);
      expect(error.header).toBeUndefined();
    }),
  );

  it.effect("accepts when any one of several v1 candidates matches (secret rotation)", () =>
    Effect.gen(function* () {
      const genuine = yield* digest(BODY, NOW);
      const zeros = "0".repeat(64);
      expect(yield* refusal(BODY, `t=${NOW},v1=${zeros},v1=${genuine}`)).toBeUndefined();
      expect(yield* refusal(BODY, `t=${NOW},v1=${genuine},v1=${zeros}`)).toBeUndefined();
      // Unknown schemes, extra whitespace and order do not matter.
      expect(yield* refusal(BODY, ` v0=abc , v1=${genuine} , t=${NOW} `)).toBeUndefined();
    }),
  );

  it.effect("refuses when none of several v1 candidates matches", () =>
    Effect.gen(function* () {
      const other = yield* digest(BODY, NOW, "whsec_other");
      expect(yield* refusal(BODY, `t=${NOW},v1=${"0".repeat(64)},v1=${other}`)).toBe(
        Webhook.SIGNATURE_MISMATCH_MESSAGE,
      );
    }),
  );

  it.effect("verifies the raw bytes of a payload", () =>
    Effect.gen(function* () {
      const bytes = new TextEncoder().encode(BODY);
      expect(yield* refusal(bytes, yield* sign(BODY, NOW))).toBeUndefined();
      // Multi-byte UTF-8 must be signed as bytes, not UTF-16 code units.
      const unicode = toJson({ id: "evt_ü", type: "x", data: { object: {} } });
      expect(
        yield* refusal(new TextEncoder().encode(unicode), yield* sign(unicode, NOW)),
      ).toBeUndefined();
    }),
  );

  it.effect("takes the last t when the header repeats it", () =>
    Effect.gen(function* () {
      // Signed at NOW, but a second `t` wins, so the MAC no longer matches.
      const genuine = yield* digest(BODY, NOW);
      expect(yield* refusal(BODY, `t=${NOW},t=${NOW - 1},v1=${genuine}`)).toBe(
        Webhook.SIGNATURE_MISMATCH_MESSAGE,
      );
    }),
  );

  it.effect("refuses an uppercase-hex v1 (Stripe sends lowercase)", () =>
    Effect.gen(function* () {
      const genuine = yield* digest(BODY, NOW);
      expect(yield* refusal(BODY, `t=${NOW},v1=${genuine.toUpperCase()}`)).toBe(
        Webhook.SIGNATURE_MISMATCH_MESSAGE,
      );
    }),
  );

  it.effect("refuses an absurdly long timestamp as outside the window", () =>
    Effect.gen(function* () {
      expect(yield* refusal(BODY, `t=${"9".repeat(400)},v1=${"0".repeat(64)}`)).toBe(
        Webhook.OUTSIDE_TOLERANCE_MESSAGE,
      );
    }),
  );

  it.effect("fails closed on an empty secret, keeping the header", () =>
    Effect.gen(function* () {
      // Node's WebCrypto will not even import a zero-length key, so no genuine
      // header exists; the verifier must refuse before comparing anything.
      const header = `t=${NOW},v1=${"0".repeat(64)}`;
      const error = yield* at(
        NOW,
        Effect.flip(Webhook.verifySignature({ payload: BODY, header, secret: Redacted.make("") })),
      );
      expect(error).toBeInstanceOf(SignatureVerificationError);
      expect(error.message).toBe(Webhook.SIGNATURE_UNAVAILABLE_MESSAGE);
      expect(error.header).toBe(header);
    }),
  );

  it.effect("never puts the secret or the payload in the error", () =>
    Effect.gen(function* () {
      const header = yield* sign(BODY, NOW, "whsec_other");
      const result = yield* verifySignature(BODY, header);
      expect(result._tag).toBe("Failure");
      const serialised = toJson(result) + String(result);
      expect(serialised).not.toContain(SECRET);
      assert(Result.isFailure(result));
      expect(result.failure.header).toBe(header);
      expect(result.failure.payload).toBeUndefined();
    }),
  );
});

describe("Webhook.verify", () => {
  it.effect("verifies, then decodes the envelope", () =>
    Effect.gen(function* () {
      const event = yield* at(
        NOW,
        Webhook.verify({
          payload: BODY,
          header: yield* sign(BODY, NOW),
          secret: Redacted.make(SECRET),
        }),
      );
      expect(event.id).toBe("evt_1");
      expect(event.type).toBe("customer.subscription.updated");
      expect(event.data.object).toStrictEqual({ id: "sub_1" });
    }),
  );

  it.effect("does not decode a payload whose signature fails", () =>
    Effect.gen(function* () {
      const error = yield* at(
        NOW,
        Effect.flip(
          Webhook.verify({
            payload: "<html>nope</html>",
            header: yield* sign(BODY, NOW),
            secret: Redacted.make(SECRET),
          }),
        ),
      );
      expect(error._tag).toBe("SignatureVerificationError");
    }),
  );

  it.effect("refuses a valid-JSON event with a bad signature as a signature failure", () =>
    Effect.gen(function* () {
      const error = yield* at(
        NOW,
        Effect.flip(
          Webhook.verify({
            payload: BODY,
            header: yield* sign(BODY, NOW, "whsec_other"),
            secret: Redacted.make(SECRET),
          }),
        ),
      );
      expect(error).toBeInstanceOf(SignatureVerificationError);
      expect(Schema.isSchemaError(error)).toBe(false);
    }),
  );

  it.effect("never decodes an unverified body", () =>
    Effect.gen(function* () {
      const decode = vi.spyOn(TextDecoder.prototype, "decode");
      onTestFinished(() => {
        decode.mockRestore();
      });
      const bytes = new TextEncoder().encode(BODY);
      const error = yield* at(
        NOW,
        Effect.flip(
          Webhook.verify({
            payload: bytes,
            header: yield* sign(BODY, NOW, "whsec_other"),
            secret: Redacted.make(SECRET),
          }),
        ),
      );
      expect(error.message).toBe(Webhook.SIGNATURE_MISMATCH_MESSAGE);
      expect(decode).not.toHaveBeenCalled();
      // …and does decode once the body verifies.
      yield* at(
        NOW,
        Webhook.verify({
          payload: bytes,
          header: yield* sign(BODY, NOW),
          secret: Redacted.make(SECRET),
        }),
      );
      expect(decode).toHaveBeenCalledTimes(1);
    }),
  );

  it.effect("fails, rather than throwing, on a signed body that is not an event", () =>
    Effect.gen(function* () {
      const body = "<html>nope</html>";
      const error = yield* at(
        NOW,
        Effect.flip(
          Webhook.verify({
            payload: body,
            header: yield* sign(body, NOW),
            secret: Redacted.make(SECRET),
          }),
        ),
      );
      expect(Schema.isSchemaError(error)).toBe(true);
    }),
  );

  it.effect("round-trips a header built by signatureHeader", () =>
    Effect.gen(function* () {
      const secret = Redacted.make(SECRET);
      const expected = yield* sign(BODY, NOW);
      const event = yield* at(
        NOW,
        Effect.gen(function* () {
          const header = yield* Webhook.signatureHeader({ payload: BODY, secret });
          expect(header).toBe(expected);
          return yield* Webhook.verify({ payload: BODY, header, secret });
        }),
      );
      expect(event.id).toBe("evt_1");
      const stale = yield* at(
        NOW,
        Webhook.signatureHeader({ payload: BODY, secret, timestamp: NOW - 1000 }),
      );
      expect(stale.startsWith(`t=${NOW - 1000},v1=`)).toBe(true);
    }),
  );
});

describe("the event vocabulary", () => {
  it("recognises exactly the handled types", () => {
    Arr.forEach(Webhook.handledEventTypes, (type) => {
      expect(Webhook.isHandledEventType(type)).toBe(true);
    });
    expect(Webhook.isHandledEventType("customer.created")).toBe(false);
    expect(Webhook.isHandledEventType("")).toBe(false);
  });

  it.effect("decodes an envelope from the raw string without looking inside data.object", () =>
    Effect.gen(function* () {
      const event = yield* Webhook.decodeEvent(
        toJson({
          id: "evt_123",
          type: "customer.created",
          data: { object: { whatever: [1, 2, 3] } },
        }),
      );
      expect(event.id).toBe("evt_123");
      expect(event.type).toBe("customer.created");
    }),
  );

  it.effect("fails rather than throwing on a body that is not JSON at all", () =>
    Effect.gen(function* () {
      const outcome = yield* Effect.result(Webhook.decodeEvent("<html>nope</html>"));
      expect(outcome._tag).toBe("Failure");
    }),
  );

  it.effect("decodes a checkout session with both ids absent", () =>
    Effect.gen(function* () {
      const session = yield* Webhook.decodeCheckoutSession({ id: "cs_1", customer: null });
      expect(session.id).toBe("cs_1");
      expect(session.customer).toBeNull();
      expect(session.subscription).toBeUndefined();
    }),
  );

  it.effect("decodes an invoice leniently", () =>
    Effect.gen(function* () {
      const invoice = yield* Webhook.decodeInvoice({
        object: "invoice",
        customer: "cus_1",
        subscription: null,
      });
      expect(invoice.customer).toBe("cus_1");
      expect(invoice.subscription).toBeNull();
      expect(Webhook.invoiceSubscription(invoice)).toStrictEqual(Option.none());
    }),
  );

  it.effect("reads an invoice's subscription from the legacy top-level field", () =>
    Effect.gen(function* () {
      const invoice = yield* Webhook.decodeInvoice({ customer: "cus_1", subscription: "sub_old" });
      expect(Webhook.invoiceSubscription(invoice)).toStrictEqual(Option.some("sub_old"));
    }),
  );

  it.effect("prefers the invoice's parent.subscription_details (2025-03-31.basil and later)", () =>
    Effect.gen(function* () {
      const basil = yield* Webhook.decodeInvoice({
        customer: "cus_1",
        parent: {
          type: "subscription_details",
          quote_details: null,
          subscription_details: { subscription: "sub_new", metadata: {} },
        },
      });
      expect(Webhook.invoiceSubscription(basil)).toStrictEqual(Option.some("sub_new"));
      const both = yield* Webhook.decodeInvoice({
        subscription: "sub_old",
        parent: { subscription_details: { subscription: "sub_new" } },
      });
      expect(Webhook.invoiceSubscription(both)).toStrictEqual(Option.some("sub_new"));
      const detached = yield* Webhook.decodeInvoice({ subscription: "sub_old", parent: null });
      expect(Webhook.invoiceSubscription(detached)).toStrictEqual(Option.some("sub_old"));
    }),
  );

  const subscription = {
    id: "sub_1",
    customer: "cus_1",
    status: "a_status_added_later",
    cancel_at_period_end: false,
    current_period_end: null,
    items: { data: [{ current_period_end: 1_760_000_000, price: { id: "price_1" } }] },
    unknown_field: true,
  };

  it.effect("decodes a subscription, accepting any status", () =>
    Effect.gen(function* () {
      const decoded = yield* Webhook.decodeSubscription(subscription);
      expect(decoded.status).toBe("a_status_added_later");
      expect(decoded.items.data[0]?.price.id).toBe("price_1");
    }),
  );

  it.effect("narrows a handled event to its decoded object", () =>
    Effect.gen(function* () {
      const handled = yield* Webhook.decodeHandledEvent({
        id: "evt_1",
        type: "customer.subscription.deleted",
        data: { object: subscription },
      });
      expect(Option.isSome(handled)).toBe(true);
      assert(Option.isSome(handled) && handled.value.type === "customer.subscription.deleted");
      expect(handled.value.data.object.customer).toBe("cus_1");
      const checkout = yield* Webhook.decodeHandledEvent({
        id: "evt_2",
        type: "checkout.session.completed",
        data: { object: { id: "cs_1", metadata: { account: "a_1" } } },
      });
      assert(Option.isSome(checkout));
      expect(checkout.value.data.object).toStrictEqual({
        id: "cs_1",
        metadata: { account: "a_1" },
      });
    }),
  );

  it.effect("answers none for an event type it does not handle", () =>
    Effect.gen(function* () {
      const handled = yield* Webhook.decodeHandledEvent({
        id: "evt_1",
        type: "customer.created",
        data: { object: 1 },
      });
      expect(Option.isNone(handled)).toBe(true);
    }),
  );

  it.effect("fails on a handled event whose object lacks a required field", () =>
    Effect.gen(function* () {
      const outcome = yield* Effect.result(
        Webhook.decodeHandledEvent({
          id: "evt_1",
          type: "invoice.payment_failed",
          data: { object: { customer: 42 } },
        }),
      );
      expect(outcome._tag).toBe("Failure");
    }),
  );
});
