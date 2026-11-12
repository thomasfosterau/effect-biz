/**
 * Shared test support for the exact-number modules: arbitraries (built on
 * Effect's own `Arbitrary`, so no extra dependency) and small result helpers.
 */
import * as Arbitrary from "effect/Arbitrary";
import * as Option from "effect/Option";
import * as BigDecimal from "effect/BigDecimal";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import type { BusinessRuleViolation } from "../src/BizError.ts";

/** An integer arbitrary within bounds. */
const between = (minimum: number, maximum: number) =>
  Arbitrary.schema(Schema.Int.check(Schema.isBetween({ minimum, maximum })));

/** A decimal of up to twelve fraction digits, from a generated mantissa. */
export const decimals = Arbitrary.map(
  ({ mantissa, scale }: { readonly mantissa: bigint; readonly scale: number }) =>
    BigDecimal.make(mantissa, scale),
)(Arbitrary.all({ mantissa: Arbitrary.schema(Schema.BigInt), scale: between(0, 12) }));

/** Three independent decimals. */
export const triples = Arbitrary.all({ a: decimals, b: decimals, c: decimals });

/** A whole number of minor units. */
export const minorAmounts = Arbitrary.schema(Schema.BigInt);

/** A total in minor units, a non-zero first weight, more weights, and a currency of each exponent. */
export const allocations = Arbitrary.all({
  minor: between(-1_000_000_000, 1_000_000_000),
  first: between(1, 1000),
  rest: Arbitrary.array(between(0, 1000), { maxLength: 7 }),
  currency: Arbitrary.schema(Schema.Literals(["AUD", "JPY", "KWD", "CLF"])),
});

/**
 * Runs a property over 300 generated values with a fixed seed. Succeeds with
 * `None` when it holds for all of them, else `Some` description of the
 * (shrunk) counterexample.
 */
export const counterexample = <A>(
  arbitrary: Arbitrary.Arbitrary<A>,
  property: (value: A) => boolean,
): Effect.Effect<Option.Option<string>> =>
  Effect.map(Arbitrary.checkEffect(arbitrary, property, { runs: 300, seed: 42 }), (failure) =>
    Option.fromNullishOr(Arbitrary.formatCheckFailure(failure)),
  );

/** The success of a result; throws the violation otherwise, which fails the test with its message. */
export const succeeded = <A>(result: Result.Result<A, BusinessRuleViolation>): A =>
  Result.getOrThrowWith(result, (violation) => violation);

/** The violation of a failed result; throws the success otherwise, which fails the test. */
export const failed = <A>(result: Result.Result<A, BusinessRuleViolation>): BusinessRuleViolation =>
  Result.getOrThrowWith(
    Result.flip(result),
    (value) => new globalThis.Error(`Expected a failure, got ${String(value)}`),
  );

/** Whether decoding the input (JSON, or one of the non-JSON values a test feeds: a bigint, undefined) against the schema fails. */
export const rejects = (schema: Schema.Decoder<unknown>, input?: Schema.Json | bigint): boolean =>
  Schema.decodeExit(schema)(input)._tag === "Failure";
