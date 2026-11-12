import { describe, expect, expectTypeOf } from "vite-plus/test";
import { it, layer } from "@effect/vitest";
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as HashSet from "effect/HashSet";
import * as Layer from "effect/Layer";
import * as Order from "effect/Order";
import * as Random from "effect/Random";
import * as Schema from "effect/Schema";
import { TestClock } from "effect/testing";
import * as BizError from "../src/BizError.ts";
import * as Id from "../src/Id.ts";

const PartyId = Id.make("PartyId");
type PartyId = typeof PartyId.Type;
const SalesOrderId = Id.make("SalesOrderId");
type SalesOrderId = typeof SalesOrderId.Type;

const V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/** `count` ids from the ambient generator under a `TestClock` set to `millis` and a seeded `Random`. */
const generated = (count: number, millis: number, seed: string) =>
  Effect.gen(function* () {
    yield* TestClock.setTime(millis);
    return yield* Effect.all(Arr.replicate(Id.generate(PartyId), count), { concurrency: 1 });
  }).pipe(Random.withSeed(seed));

describe("Id.make", () => {
  it("brands each kind so ids of different kinds are not assignable", () => {
    expectTypeOf<PartyId>().toExtend<string>();
    expectTypeOf<PartyId>().not.toEqualTypeOf<SalesOrderId>();
    expectTypeOf<string>().not.toExtend<PartyId>();
    expectTypeOf<SalesOrderId>().not.toExtend<PartyId>();
  });

  it.effect("decodes a lower-case UUIDv7", () =>
    Effect.gen(function* () {
      const valid = "0190a6e4-1c2d-7abc-8def-0123456789ab";
      expect(yield* BizError.decodeUnknown(PartyId)(valid)).toBe(valid);
    }),
  );

  it.effect.each([
    ["not-an-id"],
    ["0190A6E4-1C2D-7ABC-8DEF-0123456789AB"], // upper case
    ["0190a6e4-1c2d-4abc-8def-0123456789ab"], // version 4
    ["0190a6e4-1c2d-7abc-cdef-0123456789ab"], // wrong variant
    [42],
  ])("rejects %s with a ValidationError", ([bad]) =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(BizError.decodeUnknown(PartyId)(bad));
      expect(error).toBeInstanceOf(BizError.ValidationError);
      expect(Arr.isReadonlyArrayNonEmpty(error.issues)).toBe(true);
    }),
  );
});

// The generator keeps its last millisecond and counter, so each case builds its own.
layer(Id.layer, { buildPerTest: true })("Id.layer", (it) => {
  it.effect("generates valid ids that increase within one millisecond", () =>
    Effect.gen(function* () {
      const ids = yield* generated(5000, 1_730_000_000_000, "monotonic");
      expect(ids.every((id) => V7.test(id) && Schema.is(PartyId)(id))).toBe(true);
      expect(Arr.sort(ids, Order.String)).toEqual(ids);
      expect(HashSet.size(HashSet.fromIterable(ids))).toBe(ids.length);
    }),
  );

  it.effect("puts the clock's milliseconds in the first 48 bits", () =>
    Effect.gen(function* () {
      const [id] = yield* generated(1, 0x0190a6e41c2d, "time");
      expect(id?.slice(0, 13)).toBe("0190a6e4-1c2d");
    }),
  );
});

describe("Id.layer determinism", () => {
  /** `generated` from a generator built just for this run: the subject here is what a fresh `Id.layer` yields. */
  const fromFreshLayer = (count: number, millis: number, seed: string) =>
    Layer.build(Id.layer).pipe(
      Effect.flatMap((context) =>
        generated(count, millis, seed).pipe(Effect.provideContext(context)),
      ),
    );

  it.effect("is deterministic under TestClock and a seeded Random", () =>
    Effect.gen(function* () {
      const first = yield* fromFreshLayer(10, 1_730_000_000_000, "seed");
      const second = yield* fromFreshLayer(10, 1_730_000_000_000, "seed");
      const other = yield* fromFreshLayer(10, 1_730_000_000_000, "other");
      expect(second).toEqual(first);
      expect(other).not.toEqual(first);
    }),
  );
});

layer(Id.layerSequential)("Id.layerSequential", (it) => {
  it.effect("counts from one in valid UUIDv7s", () =>
    Effect.gen(function* () {
      const ids = yield* Effect.all([Id.generate(PartyId), Id.generate(PartyId)], {
        concurrency: 1,
      });
      expect(ids).toEqual([
        "00000000-0000-7000-8000-000000000001",
        "00000000-0000-7000-8000-000000000002",
      ]);
      expect(ids.every(Schema.is(PartyId))).toBe(true);
    }),
  );
});
