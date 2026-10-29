import { describe, expect, it } from "vite-plus/test";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import {
  parseSignatureHeader,
  signatureDigest,
  timingSafeEqual,
} from "../src/internal/signature.ts";

describe("timingSafeEqual", () => {
  it("is true only for identical strings", () => {
    expect(timingSafeEqual("abc", "abc")).toBe(true);
    expect(timingSafeEqual("abc", "abd")).toBe(false);
    // A length difference short-circuits: it is visible in the header anyway.
    expect(timingSafeEqual("abc", "abcd")).toBe(false);
    expect(timingSafeEqual("", "")).toBe(true);
  });

  it("does not short-circuit on the first differing character", () => {
    // Asserting the result is all a unit test can do; the property itself is
    // in the implementation's shape (XOR-accumulate, no early exit).
    expect(timingSafeEqual("0aaaaaaa", "1aaaaaaa")).toBe(false);
    expect(timingSafeEqual("aaaaaaa0", "aaaaaaa1")).toBe(false);
  });
});

describe("parseSignatureHeader", () => {
  it("collects the timestamp and every v1 digest", () => {
    expect(parseSignatureHeader("t=10,v1=aa,v0=bb,v1=cc")).toStrictEqual(
      Option.some({ timestamp: 10, candidates: ["aa", "cc"] }),
    );
  });

  it("ignores parts without a key", () => {
    expect(parseSignatureHeader("junk,t=10,,v1=aa")).toStrictEqual(
      Option.some({ timestamp: 10, candidates: ["aa"] }),
    );
  });
});

describe("signatureDigest", () => {
  const digestOf = (payload: Uint8Array) =>
    Effect.runPromise(signatureDigest("whsec_x", 10, payload, () => "failed"));

  it("signs only the bytes a subarray view covers", async () => {
    const whole = new TextEncoder().encode('xx{"id":1}yy');
    const view = whole.subarray(2, whole.length - 2);
    expect(view.byteOffset).toBe(2);
    expect(await digestOf(view)).toBe(await digestOf(new TextEncoder().encode('{"id":1}')));
  });

  it("fails with onFailure on an empty secret", async () => {
    const outcome = await Effect.runPromise(
      Effect.flip(signatureDigest("", 10, new Uint8Array(), () => "failed")),
    );
    expect(outcome).toBe("failed");
  });
});
