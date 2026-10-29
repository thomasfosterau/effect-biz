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

import { assert, describe, expect, it, onTestFinished, vi } from "vite-plus/test";
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import { TestClock } from "effect/testing";
import { SignatureVerificationError } from "@thomasfosterau/effect-biz/Payments";
import * as Webhook from "../src/Webhook.ts";

const SECRET = "whsec_test_do_not_use_anywhere_real";
const NOW = 1_760_000_000;
const TOLERANCE = Webhook.DEFAULT_TOLERANCE;

/** Sign a payload exactly as Stripe does: HMAC-SHA256 over `${t}.${body}`, hex. */
const digest = async (payload: string, timestamp: number, secret = SECRET): Promise<string> => {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(`${timestamp}.${payload}`),
  );
  return [...new Uint8Array(mac)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
};

const sign = async (payload: string, timestamp: number, secret = SECRET): Promise<string> =>
  `t=${timestamp},v1=${await digest(payload, timestamp, secret)}`;

/** Run `effect` with the clock at `nowSeconds`. */
const at = <A, E>(nowSeconds: number, effect: Effect.Effect<A, E>): Promise<A> =>
  Effect.runPromise(
    Effect.gen(function* () {
      yield* TestClock.setTime(nowSeconds * 1000);
      return yield* effect;
    }).pipe(Effect.provide(TestClock.layer())),
  );

type Options = Partial<Webhook.VerifyOptions>;

const verifySignature = (payload: string | Uint8Array, header: string | null, options?: Options) =>
  at(
    NOW,
    Effect.result(
      Webhook.verifySignature({ payload, header, secret: Redacted.make(SECRET), ...options }),
    ),
  );

/** `undefined` when the signature verified, else the refusal's message. */
const refusal = async (
  payload: string | Uint8Array,
  header: string | null,
  options?: Options,
): Promise<string | undefined> => {
  const result = await verifySignature(payload, header, options);
  if (Result.isSuccess(result)) return undefined;
  expect(result.failure).toBeInstanceOf(SignatureVerificationError);
  return result.failure.message;
};

/** A test event's body: the event serialised as `JSON.stringify` does. */
const toJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

const BODY = toJson({
  id: "evt_1",
  type: "customer.subscription.updated",
  data: { object: { id: "sub_1" } },
});

describe("Webhook.verifySignature", () => {
  it("accepts a genuine signature", async () => {
    expect(await refusal(BODY, await sign(BODY, NOW))).toBeUndefined();
  });

  it("accepts a signature within the tolerance window on either side", async () => {
    expect(await refusal(BODY, await sign(BODY, NOW - TOLERANCE + 1))).toBeUndefined();
    expect(await refusal(BODY, await sign(BODY, NOW + TOLERANCE - 1))).toBeUndefined();
    // The window is inclusive at its edges.
    expect(await refusal(BODY, await sign(BODY, NOW - TOLERANCE))).toBeUndefined();
  });

  it("refuses a body tampered with after signing", async () => {
    const header = await sign(BODY, NOW);
    const tampered = BODY.replace("updated", "deleted");
    expect(await refusal(tampered, header)).toBe(Webhook.SIGNATURE_MISMATCH_MESSAGE);
  });

  it("refuses a signature made with a different secret", async () => {
    const header = await sign(BODY, NOW, "whsec_some_other_endpoints_secret");
    expect(await refusal(BODY, header)).toBe(Webhook.SIGNATURE_MISMATCH_MESSAGE);
  });

  it("refuses a timestamp changed after signing", async () => {
    const genuine = await digest(BODY, NOW);
    expect(await refusal(BODY, `t=${NOW - 1},v1=${genuine}`)).toBe(
      Webhook.SIGNATURE_MISMATCH_MESSAGE,
    );
  });

  it("refuses a replay from outside the tolerance window", async () => {
    const header = await sign(BODY, NOW - TOLERANCE - 1);
    expect(await refusal(BODY, header)).toBe(Webhook.OUTSIDE_TOLERANCE_MESSAGE);
  });

  it("refuses a future-dated timestamp just as firmly", async () => {
    const header = await sign(BODY, NOW + TOLERANCE + 1);
    expect(await refusal(BODY, header)).toBe(Webhook.OUTSIDE_TOLERANCE_MESSAGE);
  });

  it("honours a configured tolerance", async () => {
    const header = await sign(BODY, NOW - 3600);
    expect(await refusal(BODY, header)).toBe(Webhook.OUTSIDE_TOLERANCE_MESSAGE);
    expect(await refusal(BODY, header, { tolerance: 7200 })).toBeUndefined();
    expect(await refusal(BODY, await sign(BODY, NOW - 11), { tolerance: 10 })).toBe(
      Webhook.OUTSIDE_TOLERANCE_MESSAGE,
    );
  });

  it.each([Number.NaN, Number.POSITIVE_INFINITY, -1])(
    "fails closed on an unusable tolerance (%s)",
    async (tolerance) => {
      expect(await refusal(BODY, await sign(BODY, NOW), { tolerance })).toBe(
        Webhook.INVALID_TOLERANCE_MESSAGE,
      );
    },
  );

  it("reads now from the Clock", async () => {
    const header = await sign(BODY, NOW);
    const later = await at(
      NOW + TOLERANCE + 1,
      Effect.flip(
        Webhook.verifySignature({ payload: BODY, header, secret: Redacted.make(SECRET) }),
      ),
    );
    expect(later.message).toBe(Webhook.OUTSIDE_TOLERANCE_MESSAGE);
  });

  it.each([
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
  ])("refuses a malformed header (%s)", async (_label, header) => {
    expect(await refusal(BODY, header)).toBe(Webhook.MALFORMED_HEADER_MESSAGE);
  });

  it("refuses a missing header passed as undefined", async () => {
    const error = await at(
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
  });

  it("accepts when any one of several v1 candidates matches (secret rotation)", async () => {
    const genuine = await digest(BODY, NOW);
    const zeros = "0".repeat(64);
    expect(await refusal(BODY, `t=${NOW},v1=${zeros},v1=${genuine}`)).toBeUndefined();
    expect(await refusal(BODY, `t=${NOW},v1=${genuine},v1=${zeros}`)).toBeUndefined();
    // Unknown schemes, extra whitespace and order do not matter.
    expect(await refusal(BODY, ` v0=abc , v1=${genuine} , t=${NOW} `)).toBeUndefined();
  });

  it("refuses when none of several v1 candidates matches", async () => {
    const other = await digest(BODY, NOW, "whsec_other");
    expect(await refusal(BODY, `t=${NOW},v1=${"0".repeat(64)},v1=${other}`)).toBe(
      Webhook.SIGNATURE_MISMATCH_MESSAGE,
    );
  });

  it("verifies the raw bytes of a payload", async () => {
    const bytes = new TextEncoder().encode(BODY);
    expect(await refusal(bytes, await sign(BODY, NOW))).toBeUndefined();
    // Multi-byte UTF-8 must be signed as bytes, not UTF-16 code units.
    const unicode = toJson({ id: "evt_ü", type: "x", data: { object: {} } });
    expect(
      await refusal(new TextEncoder().encode(unicode), await sign(unicode, NOW)),
    ).toBeUndefined();
  });

  it("takes the last t when the header repeats it", async () => {
    // Signed at NOW, but a second `t` wins, so the MAC no longer matches.
    const genuine = await digest(BODY, NOW);
    expect(await refusal(BODY, `t=${NOW},t=${NOW - 1},v1=${genuine}`)).toBe(
      Webhook.SIGNATURE_MISMATCH_MESSAGE,
    );
  });

  it("refuses an uppercase-hex v1 (Stripe sends lowercase)", async () => {
    const genuine = await digest(BODY, NOW);
    expect(await refusal(BODY, `t=${NOW},v1=${genuine.toUpperCase()}`)).toBe(
      Webhook.SIGNATURE_MISMATCH_MESSAGE,
    );
  });

  it("refuses an absurdly long timestamp as outside the window", async () => {
    expect(await refusal(BODY, `t=${"9".repeat(400)},v1=${"0".repeat(64)}`)).toBe(
      Webhook.OUTSIDE_TOLERANCE_MESSAGE,
    );
  });

  it("fails closed on an empty secret, keeping the header", async () => {
    // Node's WebCrypto will not even import a zero-length key, so no genuine
    // header exists; the verifier must refuse before comparing anything.
    const header = `t=${NOW},v1=${"0".repeat(64)}`;
    const error = await at(
      NOW,
      Effect.flip(Webhook.verifySignature({ payload: BODY, header, secret: Redacted.make("") })),
    );
    expect(error).toBeInstanceOf(SignatureVerificationError);
    expect(error.message).toBe(Webhook.SIGNATURE_UNAVAILABLE_MESSAGE);
    expect(error.header).toBe(header);
  });

  it("never puts the secret or the payload in the error", async () => {
    const header = await sign(BODY, NOW, "whsec_other");
    const result = await verifySignature(BODY, header);
    expect(result._tag).toBe("Failure");
    const serialised = toJson(result) + String(result);
    expect(serialised).not.toContain(SECRET);
    assert(Result.isFailure(result));
    expect(result.failure.header).toBe(header);
    expect(result.failure.payload).toBeUndefined();
  });
});

describe("Webhook.verify", () => {
  it("verifies, then decodes the envelope", async () => {
    const event = await at(
      NOW,
      Webhook.verify({
        payload: BODY,
        header: await sign(BODY, NOW),
        secret: Redacted.make(SECRET),
      }),
    );
    expect(event.id).toBe("evt_1");
    expect(event.type).toBe("customer.subscription.updated");
    expect(event.data.object).toStrictEqual({ id: "sub_1" });
  });

  it("does not decode a payload whose signature fails", async () => {
    const error = await at(
      NOW,
      Effect.flip(
        Webhook.verify({
          payload: "<html>nope</html>",
          header: await sign(BODY, NOW),
          secret: Redacted.make(SECRET),
        }),
      ),
    );
    expect(error._tag).toBe("SignatureVerificationError");
  });

  it("refuses a valid-JSON event with a bad signature as a signature failure", async () => {
    const error = await at(
      NOW,
      Effect.flip(
        Webhook.verify({
          payload: BODY,
          header: await sign(BODY, NOW, "whsec_other"),
          secret: Redacted.make(SECRET),
        }),
      ),
    );
    expect(error).toBeInstanceOf(SignatureVerificationError);
    expect(Schema.isSchemaError(error)).toBe(false);
  });

  it("never decodes an unverified body", async () => {
    const decode = vi.spyOn(TextDecoder.prototype, "decode");
    onTestFinished(() => {
      decode.mockRestore();
    });
    const bytes = new TextEncoder().encode(BODY);
    const error = await at(
      NOW,
      Effect.flip(
        Webhook.verify({
          payload: bytes,
          header: await sign(BODY, NOW, "whsec_other"),
          secret: Redacted.make(SECRET),
        }),
      ),
    );
    expect(error.message).toBe(Webhook.SIGNATURE_MISMATCH_MESSAGE);
    expect(decode).not.toHaveBeenCalled();
    // …and does decode once the body verifies.
    await at(
      NOW,
      Webhook.verify({
        payload: bytes,
        header: await sign(BODY, NOW),
        secret: Redacted.make(SECRET),
      }),
    );
    expect(decode).toHaveBeenCalledTimes(1);
  });

  it("fails, rather than throwing, on a signed body that is not an event", async () => {
    const body = "<html>nope</html>";
    const error = await at(
      NOW,
      Effect.flip(
        Webhook.verify({
          payload: body,
          header: await sign(body, NOW),
          secret: Redacted.make(SECRET),
        }),
      ),
    );
    expect(Schema.isSchemaError(error)).toBe(true);
  });

  it("round-trips a header built by signatureHeader", async () => {
    const secret = Redacted.make(SECRET);
    const expected = await sign(BODY, NOW);
    const event = await at(
      NOW,
      Effect.gen(function* () {
        const header = yield* Webhook.signatureHeader({ payload: BODY, secret });
        expect(header).toBe(expected);
        return yield* Webhook.verify({ payload: BODY, header, secret });
      }),
    );
    expect(event.id).toBe("evt_1");
    const stale = await at(
      NOW,
      Webhook.signatureHeader({ payload: BODY, secret, timestamp: NOW - 1000 }),
    );
    expect(stale.startsWith(`t=${NOW - 1000},v1=`)).toBe(true);
  });
});

describe("the event vocabulary", () => {
  it("recognises exactly the handled types", () => {
    Arr.forEach(Webhook.handledEventTypes, (type) => {
      expect(Webhook.isHandledEventType(type)).toBe(true);
    });
    expect(Webhook.isHandledEventType("customer.created")).toBe(false);
    expect(Webhook.isHandledEventType("")).toBe(false);
  });

  it("decodes an envelope from the raw string without looking inside data.object", async () => {
    const event = await Effect.runPromise(
      Webhook.decodeEvent(
        toJson({
          id: "evt_123",
          type: "customer.created",
          data: { object: { whatever: [1, 2, 3] } },
        }),
      ),
    );
    expect(event.id).toBe("evt_123");
    expect(event.type).toBe("customer.created");
  });

  it("fails rather than throwing on a body that is not JSON at all", async () => {
    const outcome = await Effect.runPromise(
      Effect.result(Webhook.decodeEvent("<html>nope</html>")),
    );
    expect(outcome._tag).toBe("Failure");
  });

  it("decodes a checkout session with both ids absent", async () => {
    const session = await Effect.runPromise(
      Webhook.decodeCheckoutSession({ id: "cs_1", customer: null }),
    );
    expect(session.id).toBe("cs_1");
    expect(session.customer).toBeNull();
    expect(session.subscription).toBeUndefined();
  });

  it("decodes an invoice leniently", async () => {
    const invoice = await Effect.runPromise(
      Webhook.decodeInvoice({ object: "invoice", customer: "cus_1", subscription: null }),
    );
    expect(invoice.customer).toBe("cus_1");
    expect(invoice.subscription).toBeNull();
    expect(Webhook.invoiceSubscription(invoice)).toStrictEqual(Option.none());
  });

  it("reads an invoice's subscription from the legacy top-level field", async () => {
    const invoice = await Effect.runPromise(
      Webhook.decodeInvoice({ customer: "cus_1", subscription: "sub_old" }),
    );
    expect(Webhook.invoiceSubscription(invoice)).toStrictEqual(Option.some("sub_old"));
  });

  it("prefers the invoice's parent.subscription_details (2025-03-31.basil and later)", async () => {
    const basil = await Effect.runPromise(
      Webhook.decodeInvoice({
        customer: "cus_1",
        parent: {
          type: "subscription_details",
          quote_details: null,
          subscription_details: { subscription: "sub_new", metadata: {} },
        },
      }),
    );
    expect(Webhook.invoiceSubscription(basil)).toStrictEqual(Option.some("sub_new"));
    const both = await Effect.runPromise(
      Webhook.decodeInvoice({
        subscription: "sub_old",
        parent: { subscription_details: { subscription: "sub_new" } },
      }),
    );
    expect(Webhook.invoiceSubscription(both)).toStrictEqual(Option.some("sub_new"));
    const detached = await Effect.runPromise(
      Webhook.decodeInvoice({ subscription: "sub_old", parent: null }),
    );
    expect(Webhook.invoiceSubscription(detached)).toStrictEqual(Option.some("sub_old"));
  });

  const subscription = {
    id: "sub_1",
    customer: "cus_1",
    status: "a_status_added_later",
    cancel_at_period_end: false,
    current_period_end: null,
    items: { data: [{ current_period_end: 1_760_000_000, price: { id: "price_1" } }] },
    unknown_field: true,
  };

  it("decodes a subscription, accepting any status", async () => {
    const decoded = await Effect.runPromise(Webhook.decodeSubscription(subscription));
    expect(decoded.status).toBe("a_status_added_later");
    expect(decoded.items.data[0]?.price.id).toBe("price_1");
  });

  it("narrows a handled event to its decoded object", async () => {
    const handled = await Effect.runPromise(
      Webhook.decodeHandledEvent({
        id: "evt_1",
        type: "customer.subscription.deleted",
        data: { object: subscription },
      }),
    );
    expect(Option.isSome(handled)).toBe(true);
    assert(Option.isSome(handled) && handled.value.type === "customer.subscription.deleted");
    expect(handled.value.data.object.customer).toBe("cus_1");
    const checkout = await Effect.runPromise(
      Webhook.decodeHandledEvent({
        id: "evt_2",
        type: "checkout.session.completed",
        data: { object: { id: "cs_1", metadata: { account: "a_1" } } },
      }),
    );
    assert(Option.isSome(checkout));
    expect(checkout.value.data.object).toStrictEqual({
      id: "cs_1",
      metadata: { account: "a_1" },
    });
  });

  it("answers none for an event type it does not handle", async () => {
    const handled = await Effect.runPromise(
      Webhook.decodeHandledEvent({ id: "evt_1", type: "customer.created", data: { object: 1 } }),
    );
    expect(Option.isNone(handled)).toBe(true);
  });

  it("fails on a handled event whose object lacks a required field", async () => {
    const outcome = await Effect.runPromise(
      Effect.result(
        Webhook.decodeHandledEvent({
          id: "evt_1",
          type: "invoice.payment_failed",
          data: { object: { customer: 42 } },
        }),
      ),
    );
    expect(outcome._tag).toBe("Failure");
  });
});
