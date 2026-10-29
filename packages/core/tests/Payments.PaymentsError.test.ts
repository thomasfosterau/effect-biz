import { describe, it, expect } from "vite-plus/test";
import * as Effect from "effect/Effect";
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
      code: "card_declined",
      statusCode: 402,
    });
    expect(error._tag).toBe("PaymentProviderError");
    expect(error.provider).toBe("stripe");
    expect(error.code).toBe("card_declined");
    expect(error.statusCode).toBe(402);
  });

  it("tags an authentication error", () => {
    const error = new PaymentAuthenticationError({
      message: "bad key",
      statusCode: 401,
    });
    expect(error._tag).toBe("PaymentAuthenticationError");
    expect(error.statusCode).toBe(401);
  });

  it("tags a rate limit error", () => {
    const error = new PaymentRateLimitError({ message: "slow down", retryAfter: 5 });
    expect(error._tag).toBe("PaymentRateLimitError");
    expect(error.retryAfter).toBe(5);
  });

  it("tags a config error", () => {
    const error = new PaymentConfigError({ message: "missing key" });
    expect(error._tag).toBe("PaymentConfigError");
  });

  it("tags an unavailable error and carries the provider", () => {
    const error = new PaymentsUnavailable({ message: "not configured", provider: "stripe" });
    expect(error._tag).toBe("PaymentsUnavailable");
    expect(error.provider).toBe("stripe");
  });

  it("tags a signature verification error", () => {
    const error = new SignatureVerificationError({ message: "no match" });
    expect(error._tag).toBe("SignatureVerificationError");
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
