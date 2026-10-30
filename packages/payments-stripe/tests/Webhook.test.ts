import { describe, it, expect } from "vite-plus/test";
import * as Clock from "effect/Clock";
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Webhook from "../src/Webhook.ts";
import { StripeService } from "../src/Webhook.ts";
import { SignatureVerificationError } from "@thomasfosterau/effect-biz/Payments";
import { Stripe } from "stripe";
import { DISTILLED_API_VERSION } from "../src/StripePayments.ts";

/** A test event's body: the event serialised as `JSON.stringify` does. */
const toJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

describe("Webhook", () => {
  const mockStripe = new Stripe("sk_test_mock", {
    apiVersion: DISTILLED_API_VERSION,
  });

  const testLayer = Layer.succeed(StripeService, mockStripe);

  describe("constructEvent", () => {
    it("should construct event with valid signature", async () => {
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

      const result = await Effect.runPromise(program().pipe(Effect.provide(testLayer)));

      expect(result).toBeDefined();
      expect(result.type).toBe("payment_intent.succeeded");
    });

    it("should fail with invalid signature", async () => {
      const payload = toJson({
        id: "evt_test",
        type: "payment_intent.succeeded",
        data: { object: { id: "pi_test" } },
      });
      const secret = "whsec_test_secret";
      const invalidSignature = "t=1234567890,v1=invalid_signature";

      const program = Webhook.constructEvent(payload, invalidSignature, secret);

      const result = await Effect.runPromise(program.pipe(Effect.provide(testLayer), Effect.flip));

      expect(result).toBeInstanceOf(SignatureVerificationError);
      expect(result._tag).toBe("SignatureVerificationError");
    });

    it("should fail with wrong secret", async () => {
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

      const result = await Effect.runPromise(
        program().pipe(Effect.provide(testLayer), Effect.flip),
      );

      expect(result).toBeInstanceOf(SignatureVerificationError);
    });

    it("should work with Buffer payload", async () => {
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

      const result = await Effect.runPromise(program().pipe(Effect.provide(testLayer)));

      expect(result).toBeDefined();
      expect(result.type).toBe("payment_intent.succeeded");
    });

    it("should respect tolerance parameter", async () => {
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

      const result = await Effect.runPromise(program().pipe(Effect.provide(testLayer)));

      expect(result).toBeDefined();
      expect(result.type).toBe("payment_intent.succeeded");
    });
  });

  describe("constructEventAsync", () => {
    it("should construct event with valid signature (async)", async () => {
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

      const result = await Effect.runPromise(program().pipe(Effect.provide(testLayer)));

      expect(result).toBeDefined();
      expect(result.type).toBe("payment_intent.succeeded");
    });

    it("should fail with invalid signature (async)", async () => {
      const payload = toJson({
        id: "evt_test",
        type: "payment_intent.succeeded",
        data: { object: { id: "pi_test" } },
      });
      const secret = "whsec_test_secret";
      const invalidSignature = "t=1234567890,v1=invalid_signature";

      const program = Webhook.constructEventAsync(payload, invalidSignature, secret);

      const result = await Effect.runPromise(program.pipe(Effect.provide(testLayer), Effect.flip));

      expect(result).toBeInstanceOf(SignatureVerificationError);
    });
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

    it("reads a tolerance of 0 as the default 300 s, refusing an hour-old signature", async () => {
      const error = await Effect.runPromise(Effect.flip(hourOld(0)));
      expect(error).toBeInstanceOf(SignatureVerificationError);
      expect(error.message).toContain("Timestamp outside the tolerance zone");
    });

    it("skips the timestamp check on a negative tolerance", async () => {
      const event = await Effect.runPromise(hourOld(-1));
      expect(event.type).toBe("payment_intent.succeeded");
    });
  });

  describe("generateTestHeaderString", () => {
    it("should generate valid test header", async () => {
      const payload = toJson({
        id: "evt_test",
        type: "payment_intent.succeeded",
      });
      const secret = "whsec_test_secret";

      const program = Webhook.generateTestHeaderString(payload, secret);

      const result = await Effect.runPromise(program.pipe(Effect.provide(testLayer)));

      expect(result).toBeDefined();
      expect(typeof result).toBe("string");
      expect(result).toMatch(/^t=\d+,v1=[a-f0-9]+/);
    });

    it("should use custom timestamp", async () => {
      const payload = "test payload";
      const secret = "whsec_test_secret";
      const timestamp = 1234567890;

      const program = Webhook.generateTestHeaderString(payload, secret, timestamp);

      const result = await Effect.runPromise(program.pipe(Effect.provide(testLayer)));

      expect(result).toContain(`t=${timestamp}`);
    });
  });

  describe("generateTestHeaderStringAsync", () => {
    it("should generate valid test header (async)", async () => {
      const payload = toJson({
        id: "evt_test",
        type: "payment_intent.succeeded",
      });
      const secret = "whsec_test_secret";

      const program = Webhook.generateTestHeaderStringAsync(payload, secret);

      const result = await Effect.runPromise(program.pipe(Effect.provide(testLayer)));

      expect(result).toBeDefined();
      expect(typeof result).toBe("string");
      expect(result).toMatch(/^t=\d+,v1=[a-f0-9]+/);
    });
  });

  describe("DEFAULT_TOLERANCE", () => {
    it("should export default tolerance constant", () => {
      expect(Webhook.DEFAULT_TOLERANCE).toBe(300);
    });
  });

  describe("error handling", () => {
    it("should include error details in SignatureVerificationError", async () => {
      const payload = "invalid payload";
      const signature = "invalid signature";
      const secret = "whsec_test_secret";

      const program = Webhook.constructEvent(payload, signature, secret);

      const result = await Effect.runPromise(program.pipe(Effect.provide(testLayer), Effect.flip));

      expect(result).toBeInstanceOf(SignatureVerificationError);
      expect(result.message).toBeDefined();
      expect(result.header).toBe(signature);
      expect(result.payload).toBe(payload);
    });

    // Each SDK wrapper maps whatever the SDK throws the same way: the thrown
    // message (or the thrown value as a string), the header it was given, and
    // the payload decoded as UTF-8.
    const throwing = (thrown: unknown) => {
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
        string | undefined,
      ]
    > = [
      ["constructEvent", Webhook.constructEvent(payload, "t=1,v1=x", "whsec_s"), "t=1,v1=x"],
      [
        "constructEventAsync",
        Webhook.constructEventAsync(payload, "t=1,v1=x", "whsec_s"),
        "t=1,v1=x",
      ],
      ["generateTestHeaderString", Webhook.generateTestHeaderString(payload, "whsec_s"), undefined],
      [
        "generateTestHeaderStringAsync",
        Webhook.generateTestHeaderStringAsync(payload, "whsec_s"),
        undefined,
      ],
    ];

    Arr.forEach(wrappers, ([name, program, header]) => {
      it(`${name} maps a thrown Error onto SignatureVerificationError`, async () => {
        const error = await Effect.runPromise(
          Effect.flip(program).pipe(Effect.provide(throwing(new Error("sdk refused")))),
        );
        expect(error).toBeInstanceOf(SignatureVerificationError);
        expect(error.message).toBe("sdk refused");
        expect(error.header).toBe(header);
        expect(error.payload).toBe('{"id":"evt_1"}');
      });

      it(`${name} maps a thrown non-Error by its string form`, async () => {
        const error = await Effect.runPromise(
          Effect.flip(program).pipe(Effect.provide(throwing("plain"))),
        );
        expect(error.message).toBe("plain");
      });
    });
  });
});
