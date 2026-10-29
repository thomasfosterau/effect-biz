/**
 * The WebCrypto half of the webhook verifier (`Webhook.verifySignature`):
 * parsing the `Stripe-Signature` header, computing Stripe's `v1` MAC, and
 * comparing digests in constant time. Nothing here needs Node or the SDK —
 * `crypto.subtle` and `TextEncoder` are globals in every Worker and in Node.
 *
 * @module
 */

import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Result from "effect/Result";

/** The parsed `Stripe-Signature` header: `t=<unix>,v1=<hex>[,v1=<hex>…]`. */
export interface ParsedSignature {
  /** The signing time, in UNIX seconds. */
  readonly timestamp: number;
  /** Every `v1` digest the header carries (more than one during a secret rotation). */
  readonly candidates: ReadonlyArray<string>;
}

const DIGITS = /^\d+$/;

/**
 * Parse `t=<unix>,v1=<hex>,v1=<hex>` into its parts.
 *
 * Permissive about order and about schemes other than `v1` (`v0` is a Stripe
 * CLI artefact and is simply not collected); strict about the two things that
 * matter: a timestamp of decimal digits, and at least one non-empty `v1`.
 * `none` means the header is malformed.
 */
export const parseSignatureHeader = (header: string): Option.Option<ParsedSignature> => {
  const fields = Arr.flatMap(header.split(","), (part) => {
    const separator = part.indexOf("=");
    return separator === -1
      ? []
      : [[part.slice(0, separator).trim(), part.slice(separator + 1).trim()] as const];
  });
  const timestamp = Option.map(
    Arr.findLast(fields, ([key, value]) => key === "t" && DIGITS.test(value)),
    ([, value]) => Number(value),
  );
  const candidates = Arr.filterMap(fields, ([key, value]) =>
    key === "v1" && value !== "" ? Result.succeed(value) : Result.failVoid,
  );
  return Option.flatMap(timestamp, (time) =>
    Arr.match(candidates, {
      onEmpty: () => Option.none<ParsedSignature>(),
      onNonEmpty: (values) => Option.some({ timestamp: time, candidates: values }),
    }),
  );
};

/**
 * Constant-time string comparison.
 *
 * A length difference short-circuits — it is not secret, the header shows it
 * — and the content comparison then XOR-accumulates over every character with
 * no early exit, so the time taken depends on the length alone and not on
 * where the first difference is.
 */
export const timingSafeEqual = (left: string, right: string): boolean => {
  if (left.length !== right.length) return false;
  const difference = Arr.reduce(
    left.split(""),
    0,
    (accumulated, char, index) => accumulated | (char.charCodeAt(0) ^ right.charCodeAt(index)),
  );
  return difference === 0;
};

/**
 * Whether any candidate equals `expected`. Every candidate is compared, with
 * no early exit, so two digests during a rotation cost the same whichever
 * matched.
 */
export const anyMatches = (expected: string, candidates: ReadonlyArray<string>): boolean =>
  Arr.reduce(
    candidates,
    false,
    (matched, candidate) => timingSafeEqual(expected, candidate) || matched,
  );

/** The payload as bytes: a string is UTF-8 encoded, bytes are signed as received. */
export const toBytes = (payload: string | Uint8Array): Uint8Array =>
  Predicate.isString(payload) ? new TextEncoder().encode(payload) : payload;

/** Bytes → lowercase hex, which is how Stripe encodes the `v1` digest. */
const toHex = (buffer: ArrayBuffer): string =>
  Arr.map(Arr.fromIterable(new Uint8Array(buffer)), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");

/**
 * Stripe's `v1` digest: HMAC-SHA256 with `secret` over `${timestamp}.` followed
 * by the raw payload bytes, hex-encoded.
 *
 * An empty secret is refused before WebCrypto sees it (runtimes differ on
 * whether a zero-length HMAC key imports, and a MAC under an empty key is one
 * anybody can compute). Any WebCrypto rejection — a runtime without
 * `crypto.subtle` — fails with `onFailure()`: the verifier fails closed. The
 * cause is dropped, since it could describe the key material.
 */
export const signatureDigest = <E>(
  secret: string,
  timestamp: number,
  payload: Uint8Array,
  onFailure: () => E,
): Effect.Effect<string, E> =>
  secret === ""
    ? Effect.fail(onFailure())
    : Effect.tryPromise({
        try: async () => {
          const encoder = new TextEncoder();
          const prefix = encoder.encode(`${timestamp}.`);
          const signed = new Uint8Array(prefix.length + payload.length);
          signed.set(prefix, 0);
          signed.set(payload, prefix.length);
          const key = await crypto.subtle.importKey(
            "raw",
            encoder.encode(secret),
            { name: "HMAC", hash: "SHA-256" },
            false,
            ["sign"],
          );
          return toHex(await crypto.subtle.sign("HMAC", key, signed));
        },
        catch: onFailure,
      });
