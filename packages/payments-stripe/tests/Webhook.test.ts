import { describe, expect } from "vite-plus/test";
import { it } from "@effect/vitest";
import * as Clock from "effect/Clock";
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Webhook from "../src/Webhook.ts";
import { StripeService } from "../src/Webhook.ts";
import { SignatureVerificationError } from "@thomasfosterau/effect-biz/Payments";
import { Stripe } from "stripe";
import { DISTILLED_API_VERSION } from "../src/StripePayments.ts";

/** A test event's body: the event serialised as `JSON.stringify` does. */
const toJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

// `it.live`: the SDK-based verifiers read the real wall clock, so the tests that sign
// with `Clock` (the default timestamp, "an hour ago") must share it, not `TestClock`.
describe("Webhook", () => {
  const mockStripe = new Stripe("sk_test_mock", {
    apiVersion: DISTILLED_API_VERSION,
  });

  const testLayer = Layer.succeed(StripeService, mockStripe);

  describe("constructEvent", () => {
    it.live("should construct event with valid signature", () =>
      Effect.gen(function* () {
        const payload = toJson({
          id: "evt_test",
          type: "payment_intent.succeeded",
          data: { object: { id: "pi_test" } },
        });
        const secret = "whsec_test_secret";

        const program = Effect.fn("program")(function* () {
          // Generate test signature
          const signature = yield* Webhook.generateTestHeaderString(payload, secret);

          // Verify signature and construct event
          const event = yield* Webhook.constructEvent(payload, signature, secret);

          return event;
        });

        const result = yield* program().pipe(Effect.provide(testLayer));

        expect(result).toBeDefined();
        expect(result.type).toBe("payment_intent.succeeded");
      }),
    );

    it.live("should fail with invalid signature", () =>
      Effect.gen(function* () {
        const payload = toJson({
          id: "evt_test",
          type: "payment_intent.succeeded",
          data: { object: { id: "pi_test" } },
        });
        const secret = "whsec_test_secret";
        const invalidSignature = "t=1234567890,v1=invalid_signature";

        const program = Webhook.constructEvent(payload, invalidSignature, secret);

        const result = yield* program.pipe(Effect.provide(testLayer), Effect.flip);

        expect(result).toBeInstanceOf(SignatureVerificationError);
        expect(result._tag).toBe("SignatureVerificationError");
      }),
    );

    it.live("should fail with wrong secret", () =>
      Effect.gen(function* () {
        const payload = toJson({
          id: "evt_test",
          type: "payment_intent.succeeded",
          data: { object: { id: "pi_test" } },
        });
        const secret = "whsec_test_secret";
        const wrongSecret = "whsec_wrong_secret";

        const program = Effect.fn("program")(function* () {
          const signature = yield* Webhook.generateTestHeaderString(payload, secret);
          return yield* Webhook.constructEvent(payload, signature, wrongSecret);
        });

        const result = yield* program().pipe(Effect.provide(testLayer), Effect.flip);

        expect(result).toBeInstanceOf(SignatureVerificationError);
      }),
    );

    it.live("should work with Buffer payload", () =>
      Effect.gen(function* () {
        const payloadString = toJson({
          id: "evt_test",
          type: "payment_intent.succeeded",
          data: { object: { id: "pi_test" } },
        });
        const payload = Buffer.from(payloadString, "utf8");
        const secret = "whsec_test_secret";

        const program = Effect.fn("program")(function* () {
          const signature = yield* Webhook.generateTestHeaderString(payload, secret);
          const event = yield* Webhook.constructEvent(payload, signature, secret);
          return event;
        });

        const result = yield* program().pipe(Effect.provide(testLayer));

        expect(result).toBeDefined();
        expect(result.type).toBe("payment_intent.succeeded");
      }),
    );

    it.live("should respect tolerance parameter", () =>
      Effect.gen(function* () {
        const payload = toJson({
          id: "evt_test",
          type: "payment_intent.succeeded",
          data: { object: { id: "pi_test" } },
        });
        const secret = "whsec_test_secret";

        const program = Effect.fn("program")(function* () {
          const veryOldTimestamp = Math.floor((yield* Clock.currentTimeMillis) / 1000) - 3600; // 1 hour ago
          const signature = yield* Webhook.generateTestHeaderString(
            payload,
            secret,
            veryOldTimestamp,
          );

          // Should fail with default tolerance (300 seconds)
          const failedEffect = Effect.flip(Webhook.constructEvent(payload, signature, secret));
          const error = yield* failedEffect;
          expect(error).toBeInstanceOf(SignatureVerificationError);

          // Should succeed with large tolerance
          const event = yield* Webhook.constructEvent(
            payload,
            signature,
            secret,
            7200, // 2 hours
          );
          return event;
        });

        const result = yield* program().pipe(Effect.provide(testLayer));

        expect(result).toBeDefined();
        expect(result.type).toBe("payment_intent.succeeded");
      }),
    );
  });

  describe("constructEventAsync", () => {
    it.live("should construct event with valid signature (async)", () =>
      Effect.gen(function* () {
        const payload = toJson({
          id: "evt_test",
          type: "payment_intent.succeeded",
          data: { object: { id: "pi_test" } },
        });
        const secret = "whsec_test_secret";

        const program = Effect.fn("program")(function* () {
          const signature = yield* Webhook.generateTestHeaderStringAsync(payload, secret);
          const event = yield* Webhook.constructEventAsync(payload, signature, secret);
          return event;
        });

        const result = yield* program().pipe(Effect.provide(testLayer));

        expect(result).toBeDefined();
        expect(result.type).toBe("payment_intent.succeeded");
      }),
    );

    it.live("should fail with invalid signature (async)", () =>
      Effect.gen(function* () {
        const payload = toJson({
          id: "evt_test",
          type: "payment_intent.succeeded",
          data: { object: { id: "pi_test" } },
        });
        const secret = "whsec_test_secret";
        const invalidSignature = "t=1234567890,v1=invalid_signature";

        const program = Webhook.constructEventAsync(payload, invalidSignature, secret);

        const result = yield* program.pipe(Effect.provide(testLayer), Effect.flip);

        expect(result).toBeInstanceOf(SignatureVerificationError);
      }),
    );
  });

  // `0` means DEFAULT_TOLERANCE (300 s) on both SDK-based paths, though the
  // SDK itself reads `0` as "no timestamp check"; a negative tolerance goes to
  // the SDK as given and skips the check.
  describe.each([
    { name: "constructEvent", construct: Webhook.constructEvent },
    { name: "constructEventAsync", construct: Webhook.constructEventAsync },
  ])("$name tolerance", ({ construct }) => {
    const payload = toJson({ id: "evt_test", type: "payment_intent.succeeded" });
    const secret = "whsec_test_secret";
    const hourOld = (tolerance: number) =>
      Effect.gen(function* () {
        const signature = yield* Webhook.generateTestHeaderString(
          payload,
          secret,
          Math.floor((yield* Clock.currentTimeMillis) / 1000) - 3600,
        );
        return yield* construct(payload, signature, secret, tolerance);
      }).pipe(Effect.provide(testLayer));

    it.live("reads a tolerance of 0 as the default 300 s, refusing an hour-old signature", () =>
      Effect.gen(function* () {
        const error = yield* Effect.flip(hourOld(0));
        expect(error).toBeInstanceOf(SignatureVerificationError);
        expect(error.message).toContain("Timestamp outside the tolerance zone");
      }),
    );

    it.live("skips the timestamp check on a negative tolerance", () =>
      Effect.gen(function* () {
        const event = yield* hourOld(-1);
        expect(event.type).toBe("payment_intent.succeeded");
      }),
    );
  });

  describe("generateTestHeaderString", () => {
    it.live("should generate valid test header", () =>
      Effect.gen(function* () {
        const payload = toJson({
          id: "evt_test",
          type: "payment_intent.succeeded",
        });
        const secret = "whsec_test_secret";

        const program = Webhook.generateTestHeaderString(payload, secret);

        const result = yield* program.pipe(Effect.provide(testLayer));

        expect(result).toBeDefined();
        expect(result).toBeTypeOf("string");
        expect(result).toMatch(/^t=\d+,v1=[a-f0-9]+/);
      }),
    );

    it.live("should use custom timestamp", () =>
      Effect.gen(function* () {
        const payload = "test payload";
        const secret = "whsec_test_secret";
        const timestamp = 1234567890;

        const program = Webhook.generateTestHeaderString(payload, secret, timestamp);

        const result = yield* program.pipe(Effect.provide(testLayer));

        expect(result).toContain(`t=${timestamp}`);
      }),
    );
  });

  describe("generateTestHeaderStringAsync", () => {
    it.live("should generate valid test header (async)", () =>
      Effect.gen(function* () {
        const payload = toJson({
          id: "evt_test",
          type: "payment_intent.succeeded",
        });
        const secret = "whsec_test_secret";

        const program = Webhook.generateTestHeaderStringAsync(payload, secret);

        const result = yield* program.pipe(Effect.provide(testLayer));

        expect(result).toBeDefined();
        expect(result).toBeTypeOf("string");
        expect(result).toMatch(/^t=\d+,v1=[a-f0-9]+/);
      }),
    );
  });

  describe("DEFAULT_TOLERANCE", () => {
    it("should export default tolerance constant", () => {
      expect(Webhook.DEFAULT_TOLERANCE).toBe(300);
    });
  });

  describe("error handling", () => {
    it.live("should include error details in SignatureVerificationError", () =>
      Effect.gen(function* () {
        const payload = "invalid payload";
        const signature = "invalid signature";
        const secret = "whsec_test_secret";

        const program = Webhook.constructEvent(payload, signature, secret);

        const result = yield* program.pipe(Effect.provide(testLayer), Effect.flip);

        expect(result).toBeInstanceOf(SignatureVerificationError);
        expect(result.message).toBeDefined();
        expect(result.header).toEqual(Option.some(signature));
        expect(result.payload).toEqual(Option.some(payload));
      }),
    );

    // Each SDK wrapper maps whatever the SDK throws the same way: the thrown
    // message (or the thrown value as a string), the header it was given, and
    // the payload decoded as UTF-8.
    const throwing = (thrown: Error | string) => {
      const fail = () => {
        throw thrown;
      };
      const failAsync = () => Promise.reject(thrown);
      // SAFETY: the fixture implements only the four `webhooks` methods the
      // SDK wrappers call; nothing else on the client is reached.
      return Layer.succeed(StripeService, {
        webhooks: {
          constructEvent: fail,
          constructEventAsync: failAsync,
          generateTestHeaderString: fail,
          generateTestHeaderStringAsync: failAsync,
        },
      } as never);
    };
    const payload = Buffer.from('{"id":"evt_1"}', "utf8");
    const wrappers: ReadonlyArray<
      readonly [
        string,
        Effect.Effect<unknown, SignatureVerificationError, StripeService>,
        Option.Option<string>,
      ]
    > = [
      [
        "constructEvent",
        Webhook.constructEvent(payload, "t=1,v1=x", "whsec_s"),
        Option.some("t=1,v1=x"),
      ],
      [
        "constructEventAsync",
        Webhook.constructEventAsync(payload, "t=1,v1=x", "whsec_s"),
        Option.some("t=1,v1=x"),
      ],
      [
        "generateTestHeaderString",
        Webhook.generateTestHeaderString(payload, "whsec_s"),
        Option.none(),
      ],
      [
        "generateTestHeaderStringAsync",
        Webhook.generateTestHeaderStringAsync(payload, "whsec_s"),
        Option.none(),
      ],
    ];

    Arr.forEach(wrappers, ([name, program, header]) => {
      it.live(`${name} maps a thrown Error onto SignatureVerificationError`, () =>
        Effect.gen(function* () {
          const error = yield* Effect.flip(Effect.asVoid(program)).pipe(
            Effect.provide(throwing(new Error("sdk refused"))),
          );
          expect(error).toBeInstanceOf(SignatureVerificationError);
          expect(error.message).toBe("sdk refused");
          expect(error.header).toEqual(header);
          expect(error.payload).toEqual(Option.some('{"id":"evt_1"}'));
        }),
      );

      it.live(`${name} maps a thrown non-Error by its string form`, () =>
        Effect.gen(function* () {
          const error = yield* Effect.flip(Effect.asVoid(program)).pipe(
            Effect.provide(throwing("plain")),
          );
          expect(error.message).toBe("plain");
        }),
      );
    });
  });
});
