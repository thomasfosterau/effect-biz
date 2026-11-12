import { describe, expect, expectTypeOf, it } from "vite-plus/test";
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

/** `count` ids from {@link Id.layer} under a `TestClock` set to `millis` and a seeded `Random`. */
const generated = (count: number, millis: number, seed: string) =>
  Effect.gen(function* () {
    yield* TestClock.setTime(millis);
    return yield* Effect.all(Arr.replicate(Id.generate(PartyId), count), { concurrency: 1 });
  }).pipe(Random.withSeed(seed), Effect.provide(Layer.merge(Id.layer, TestClock.layer())));

describe("Id.make", () => {
  it("brands each kind so ids of different kinds are not assignable", () => {
    expectTypeOf<PartyId>().toExtend<string>();
    expectTypeOf<PartyId>().not.toEqualTypeOf<SalesOrderId>();
    expectTypeOf<string>().not.toExtend<PartyId>();
    expectTypeOf<SalesOrderId>().not.toExtend<PartyId>();
  });

  it("decodes a lower-case UUIDv7", async () => {
    const valid = "0190a6e4-1c2d-7abc-8def-0123456789ab";
    expect(await Effect.runPromise(BizError.decodeUnknown(PartyId)(valid))).toBe(valid);
  });

  it.each([
    ["not-an-id"],
    ["0190A6E4-1C2D-7ABC-8DEF-0123456789AB"], // upper case
    ["0190a6e4-1c2d-4abc-8def-0123456789ab"], // version 4
    ["0190a6e4-1c2d-7abc-cdef-0123456789ab"], // wrong variant
    [42],
  ])("rejects %s with a ValidationError", async (bad) => {
    const error = await Effect.runPromise(Effect.flip(BizError.decodeUnknown(PartyId)(bad)));
    expect(error).toBeInstanceOf(BizError.ValidationError);
    expect(Arr.isReadonlyArrayNonEmpty(error.issues)).toBe(true);
  });
});

describe("Id.layer", () => {
  it("generates valid ids that increase within one millisecond", async () => {
    const ids = await Effect.runPromise(generated(5000, 1_730_000_000_000, "monotonic"));
    expect(ids.every((id) => V7.test(id) && Schema.is(PartyId)(id))).toBe(true);
    expect(Arr.sort(ids, Order.String)).toEqual(ids);
    expect(HashSet.size(HashSet.fromIterable(ids))).toBe(ids.length);
  });

  it("puts the clock's milliseconds in the first 48 bits", async () => {
    const [id] = await Effect.runPromise(generated(1, 0x0190a6e41c2d, "time"));
    expect(id?.slice(0, 13)).toBe("0190a6e4-1c2d");
  });

  it("is deterministic under TestClock and a seeded Random", async () => {
    const first = await Effect.runPromise(generated(10, 1_730_000_000_000, "seed"));
    const second = await Effect.runPromise(generated(10, 1_730_000_000_000, "seed"));
    const other = await Effect.runPromise(generated(10, 1_730_000_000_000, "other"));
    expect(second).toEqual(first);
    expect(other).not.toEqual(first);
  });
});

describe("Id.layerSequential", () => {
  it("counts from one in valid UUIDv7s", async () => {
    const ids = await Effect.runPromise(
      Effect.all([Id.generate(PartyId), Id.generate(PartyId)], { concurrency: 1 }).pipe(
        Effect.provide(Id.layerSequential),
      ),
    );
    expect(ids).toEqual([
      "00000000-0000-7000-8000-000000000001",
      "00000000-0000-7000-8000-000000000002",
    ]);
    expect(ids.every(Schema.is(PartyId))).toBe(true);
  });
});
