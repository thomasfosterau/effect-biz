import { expect } from "vite-plus/test";
import { layer as testLayer } from "@effect/vitest";
import { FetchHttpClient } from "effect/http";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
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

class DistilledOnlyError extends Schema.TaggedError<
  DistilledOnlyError,
  { readonly brand: unique symbol }
>()("DistilledOnlyError", {
  message: Schema.String,
}) {}

/** A failure with neither a `_tag` nor a `message`. */
interface Untagged {
  readonly _tag?: undefined;
  readonly message?: undefined;
}

const callWith = (failure: DistilledOnlyError | Untagged) => {
  const { fetch, calls } = stubFetch(() => jsonResponse(200, {}));
  const result = Effect.flip(
    Effect.flatMap(StripeHttp, (client) =>
      Effect.asVoid(client.call("GET", () => Effect.fail(failure), {})),
    ).pipe(Effect.provideService(FetchHttpClient.Fetch, fetch)),
  );
  return { result, calls };
};

testLayer(
  Layer.provideMerge(
    layer({ apiKey: Redacted.make(TEST_KEY), maxNetworkRetries: 0 }),
    FetchHttpClient.layer,
  ),
)("StripeHttp", (it) => {
  it.effect("maps a Distilled failure with no response to PaymentProviderError by its tag", () =>
    Effect.gen(function* () {
      const { result, calls } = callWith(new DistilledOnlyError({ message: "schema mismatch" }));
      const error = yield* result;
      expect(error).toBeInstanceOf(PaymentProviderError);
      expect(error).toMatchObject({
        provider: "stripe",
        code: Option.some("DistilledOnlyError"),
        message: "schema mismatch",
      });
      expect(calls).toHaveLength(0);
    }),
  );

  it.effect("names an untagged, message-less failure as unknown", () =>
    Effect.gen(function* () {
      const error = yield* callWith({}).result;
      expect(error).toMatchObject({
        _tag: "PaymentProviderError",
        code: Option.some("StripeUnknownError"),
        message: "The Stripe request failed",
      });
    }),
  );
});
