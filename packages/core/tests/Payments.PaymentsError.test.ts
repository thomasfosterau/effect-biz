import { describe, it, expect } from "vite-plus/test";
import * as Option from "effect/Option";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import {
  PaymentAuthenticationError,
  PaymentConfigError,
  PaymentProviderError,
  PaymentRateLimitError,
  PaymentsUnavailable,
  SignatureVerificationError,
} from "@thomasfosterau/effect-biz/Payments";

describe("PaymentsError", () => {
  it("tags a provider error and carries provider/code", () => {
    const error = new PaymentProviderError({
      message: "boom",
      provider: "stripe",
      code: Option.some("card_declined"),
      statusCode: Option.some(402),
    });
    expect(error._tag).toBe("PaymentProviderError");
    expect(error.provider).toBe("stripe");
    expect(error.code).toEqual(Option.some("card_declined"));
    expect(error.statusCode).toEqual(Option.some(402));
  });

  it("tags an authentication error", () => {
    const error = new PaymentAuthenticationError({
      message: "bad key",
      statusCode: Option.some(401),
    });
    expect(error._tag).toBe("PaymentAuthenticationError");
    expect(error.statusCode).toEqual(Option.some(401));
  });

  it("tags a rate limit error", () => {
    const error = new PaymentRateLimitError({ message: "slow down", retryAfter: Option.some(5) });
    expect(error._tag).toBe("PaymentRateLimitError");
    expect(error.retryAfter).toEqual(Option.some(5));
  });

  it("tags a config error", () => {
    const error = new PaymentConfigError({ message: "missing key" });
    expect(error._tag).toBe("PaymentConfigError");
  });

  it("tags an unavailable error and carries the provider", () => {
    const error = new PaymentsUnavailable({
      message: "not configured",
      provider: Option.some("stripe"),
    });
    expect(error._tag).toBe("PaymentsUnavailable");
    expect(error.provider).toEqual(Option.some("stripe"));
  });

  it("tags a signature verification error", () => {
    const error = new SignatureVerificationError({ message: "no match" });
    expect(error._tag).toBe("SignatureVerificationError");
  });

  it("keeps an absent field an omitted key on the wire, and reads it back as None", () => {
    const encode = Schema.encodeSync(PaymentProviderError);
    const decode = Schema.decodeUnknownSync(PaymentProviderError);
    const bare = new PaymentProviderError({ message: "boom", provider: "stripe" });
    expect(bare.code).toEqual(Option.none());
    const wire = encode(bare);
    expect(wire).not.toHaveProperty("code");
    expect(decode(wire).statusCode).toEqual(Option.none());
    const full = new PaymentProviderError({
      message: "boom",
      provider: "stripe",
      code: Option.some("card_declined"),
    });
    expect(encode(full)).toMatchObject({ code: "card_declined" });
    expect(decode(encode(full)).code).toEqual(Option.some("card_declined"));
  });

  it("is usable in the Effect error channel via catchTag", async () => {
    const program = Effect.fail(
      new PaymentProviderError({ message: "nope", provider: "stripe" }),
    ).pipe(
      Effect.catchTag("PaymentProviderError", (error) =>
        Effect.succeed({ caught: true, message: error.message }),
      ),
    );

    const result = await Effect.runPromise(program);
    expect(result.caught).toBe(true);
    expect(result.message).toBe("nope");
  });
});
