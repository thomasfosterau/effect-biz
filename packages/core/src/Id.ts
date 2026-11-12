/**
 * Branded entity identifiers and the one service that generates them.
 *
 * Every entity id in effect-biz is a lower-case UUIDv7 string, branded per
 * kind, so a `PartyId` never type-checks where a `SalesOrderId` is expected.
 * A domain package declares its ids with {@link make}; a command creates one
 * with {@link generate}, which reads the injectable {@link IdGenerator}.
 *
 * UUIDv7 (RFC 9562) is time-ordered, so ids sort by creation and index
 * well, and needs no coordination between processes. {@link layer} builds
 * it from `Clock` and `Random`, so a test under `TestClock` and a seeded
 * `Random` gets the same ids on every run; {@link layerSequential} counts
 * from one. An identifier from another system (a host application's user
 * id, a sales channel's order number) is never reused as an effect-biz id:
 * it is stored beside the entity as an external reference.
 *
 * See {@link make} for an example.
 *
 * @module
 */

import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Random from "effect/Random";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Clock from "effect/Clock";

/** A single string-literal brand key, as `Schema.brand` requires (no unions, no widened `string`). */
export type BrandKey<K extends string> = Parameters<typeof Schema.brand<K>>[0];

/** The schema of an id of kind `K`: a lower-case UUIDv7 string, branded `K`. */
export type IdSchema<K extends string> = Schema.brand<Schema.String, K>;

/**
 * Declares the id schema of one kind of entity: a lower-case UUIDv7 string
 * branded with `kind`. Decoding rejects anything else (`BizError.decodeUnknown`
 * turns the failure into a `ValidationError`).
 *
 * @example
 * ```ts
 * import { Effect, Schema } from "effect";
 * import * as Id from "@thomasfosterau/effect-biz/Id";
 *
 * const PartyId = Id.make("PartyId");
 * type PartyId = typeof PartyId.Type;
 *
 * const program = Effect.gen(function* () {
 *   const first: PartyId = yield* Id.generate(PartyId);
 *   const second: PartyId = yield* Id.generate(PartyId);
 *   return [first, second];
 * });
 *
 * const ids = Effect.runSync(program.pipe(Effect.provide(Id.layerSequential)));
 * console.log(ids); // ["00000000-0000-7000-8000-000000000001", "00000000-0000-7000-8000-000000000002"]
 * console.log(Schema.is(PartyId)("not-an-id")); // false
 * ```
 */
export const make = <const K extends string>(kind: BrandKey<K>): IdSchema<K> =>
  Schema.String.check(Schema.isUUID(7), Schema.isLowercased()).pipe(Schema.brand<K>(kind));

/**
 * The service every id comes from: `next` yields a fresh lower-case UUIDv7
 * string. Provide {@link layer} in an application, {@link layerSequential}
 * in a test, or a host's own.
 */
export class IdGenerator extends Context.Service<
  IdGenerator,
  {
    /** A fresh, lower-case UUIDv7 string, greater than every one before it. */
    readonly next: Effect.Effect<string>;
  }
>()("@effect-biz/Id/IdGenerator") {}

/** Generates a fresh id of the schema's kind from the {@link IdGenerator}. */
export const generate = <K extends string>(
  schema: IdSchema<K>,
): Effect.Effect<IdSchema<K>["Type"], never, IdGenerator> =>
  IdGenerator.use((generator) => generator.next).pipe(
    Effect.flatMap((raw) => Effect.orDie(schema.makeEffect(raw))),
  );

const hex = (value: number, digits: number): string => value.toString(16).padStart(digits, "0");

/** The 12-bit counter's largest value; a fresh millisecond starts it below half of that. */
const COUNTER_MAX = 0xfff;
const COUNTER_SEED = 0x800;

/** The id with the given 48-bit millisecond timestamp, 12-bit counter and 62 random bits. */
const format = (
  millis: number,
  counter: number,
  high: number,
  middle: number,
  low: number,
): string => {
  const time = hex(millis, 12);
  return `${time.slice(0, 8)}-${time.slice(8)}-7${hex(counter, 3)}-${hex(0x8000 | high, 4)}-${hex(middle, 6)}${hex(low, 6)}`;
};

interface State {
  readonly millis: number;
  readonly counter: number;
}

/** The next timestamp and counter: monotonic, even when the clock stalls or steps back. */
const advance = (state: State, now: number, seed: number): State => {
  if (now > state.millis) {
    return { millis: now, counter: seed };
  }
  return state.counter < COUNTER_MAX
    ? { millis: state.millis, counter: state.counter + 1 }
    : { millis: state.millis + 1, counter: seed };
};

/**
 * The UUIDv7 generator: a 48-bit millisecond timestamp from `Clock`, a 12-bit
 * counter that keeps ids increasing within a millisecond (RFC 9562, method
 * 1), and 62 bits from `Random`. Deterministic under `TestClock` and a seeded
 * `Random`.
 */
export const layer: Layer.Layer<IdGenerator> = Layer.effect(
  IdGenerator,
  Effect.gen(function* () {
    const state = yield* Ref.make<State>({ millis: -1, counter: 0 });
    return IdGenerator.of({ next: nextFrom(state) });
  }),
);

/** The next id of {@link layer}'s generator, advancing its `state`. */
const nextFrom = Effect.fn("IdGenerator.next")(function* (state: Ref.Ref<State>) {
  const now = yield* Clock.currentTimeMillis;
  const seed = yield* Random.nextIntBetween(0, COUNTER_SEED, { halfOpen: true });
  const high = yield* Random.nextIntBetween(0, 0x4000, { halfOpen: true });
  const middle = yield* Random.nextIntBetween(0, 0x1000000, { halfOpen: true });
  const low = yield* Random.nextIntBetween(0, 0x1000000, { halfOpen: true });
  const current = yield* Ref.modify(state, (previous) => {
    const advanced = advance(previous, now, seed);
    return [advanced, advanced];
  });
  return format(current.millis, current.counter, high, middle, low);
});

/**
 * A generator for tests: `00000000-0000-7000-8000-000000000001`, then `…02`,
 * and so on, each a valid UUIDv7 with a zero timestamp.
 */
export const layerSequential: Layer.Layer<IdGenerator> = Layer.effect(
  IdGenerator,
  Effect.gen(function* () {
    const counter = yield* Ref.make(0);
    const next = Ref.updateAndGet(counter, (n) => n + 1).pipe(
      Effect.map((n) => `00000000-0000-7000-8000-${hex(n, 12)}`),
    );
    return IdGenerator.of({ next });
  }),
);
