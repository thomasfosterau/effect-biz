import { describe, expect } from "vite-plus/test";
import { it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as TestClock from "effect/testing/TestClock";
import * as Actor from "../src/Actor.ts";
import * as Audit from "../src/Audit.ts";

const user = new Actor.Actor({ kind: "user", id: "user-1", displayName: "Jane Citizen" });

describe("Audit", () => {
  it.effect("stamps a new entity with the clock's time and the actor's id, at version 1", () =>
    Effect.gen(function* () {
      yield* TestClock.adjust("1 second");
      const created = yield* Audit.created;
      expect(created.createdAt).toEqual(DateTime.makeUnsafe(1000));
      expect(created.updatedAt).toEqual(created.createdAt);
      expect(created.createdBy).toBe("user-1");
      expect(created.updatedBy).toBe("user-1");
      expect(created.version).toBe(1);
      expect(Option.isNone(created.archivedAt)).toBe(true);
    }).pipe(Actor.withActor(user)),
  );

  it.effect("moves the version and update fields on, keeping the creation fields", () =>
    Effect.gen(function* () {
      const created = yield* Audit.created.pipe(Actor.withActor(Actor.system("importer")));
      yield* TestClock.adjust("1 minute");
      const stamp = yield* Audit.stamp;
      const next = Audit.next(created, stamp);
      expect(next.version).toBe(2);
      expect(next.createdBy).toBe("importer");
      expect(next.updatedBy).toBe("user-1");
      expect(next.updatedAt).toEqual(DateTime.makeUnsafe(60_000));
      const archived = Audit.next(next, stamp, Option.some(stamp.at));
      expect(Audit.isArchived({ id: "x", audit: archived })).toBe(true);
      expect(Audit.next(archived, stamp).archivedAt).toEqual(Option.some(stamp.at));
    }).pipe(Actor.withActor(user)),
  );
});
