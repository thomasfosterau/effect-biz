import { describe, it, expect } from "vite-plus/test";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import { PaymentProviderError } from "@thomasfosterau/effect-biz/Payments";
import { layer, StripeHttp } from "../src/StripeHttp.ts";
import { jsonResponse, stubFetch, TEST_KEY } from "./support.ts";

/**
 * The client's last resort: a Distilled failure with no response behind it
 * (neither a connection failure nor an HTTP error) still lands on the neutral
 * channel, as a `PaymentProviderError` coded by the failure's tag.
 */

class DistilledOnlyError extends Schema.TaggedError<DistilledOnlyError>()("DistilledOnlyError", {
  message: Schema.String,
}) {}

const callWith = (failure: unknown) => {
  const { http, calls } = stubFetch(() => jsonResponse(200, {}));
  const result = Effect.runPromise(
    Effect.flip(
      Effect.flatMap(StripeHttp, (client) =>
        client.call("GET", () => Effect.fail(failure), {}),
      ).pipe(
        Effect.provide(layer({ apiKey: Redacted.make(TEST_KEY), maxNetworkRetries: 0 })),
        Effect.provide(http),
      ),
    ),
  );
  return { result, calls };
};

describe("StripeHttp", () => {
  it("maps a Distilled failure with no response to PaymentProviderError by its tag", async () => {
    const { result, calls } = callWith(new DistilledOnlyError({ message: "schema mismatch" }));
    const error = await result;
    expect(error).toBeInstanceOf(PaymentProviderError);
    expect(error).toMatchObject({
      provider: "stripe",
      code: "DistilledOnlyError",
      message: "schema mismatch",
    });
    expect(calls).toHaveLength(0);
  });

  it("names an untagged, message-less failure as unknown", async () => {
    const error = await callWith({}).result;
    expect(error).toMatchObject({
      _tag: "PaymentProviderError",
      code: "StripeUnknownError",
      message: "The Stripe request failed",
    });
  });
});
