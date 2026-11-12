import { expect } from "vite-plus/test";
import { describe, it, layer, type Vitest } from "@effect/vitest";
import * as BizError from "@thomasfosterau/effect-biz/BizError";
import * as UnitOfWork from "@thomasfosterau/effect-biz/UnitOfWork";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";
import * as Dialect from "../src/Dialect.ts";
import * as SqlUnitOfWork from "../src/SqlUnitOfWork.ts";
import * as Testing from "../src/testing.ts";

/** The conflict every guard here fails with. */
const conflict = new BizError.ConcurrencyConflict({
  entity: "Counter",
  id: "a",
  expected: 1,
  actual: 2,
});

/** A `counters` table with one row, `a`, at version 1. */
const setUp = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE counters (id TEXT PRIMARY KEY, version INTEGER NOT NULL)`;
  yield* sql`INSERT INTO counters (id, version) VALUES ('a', 1), ('b', 1)`;
  return sql;
}).pipe(Effect.orDie);

/** A version-guarded bump of `id` from version `from`. */
const bump = (sql: SqlClient.SqlClient, id: string, from: number) =>
  SqlUnitOfWork.guarded(
    sql`UPDATE counters SET version = version + 1 WHERE id = ${id} AND version = ${from} RETURNING id`,
    { conflict: Effect.succeed(conflict) },
  );

const versions = (sql: SqlClient.SqlClient) =>
  Effect.orDie(
    sql<{
      readonly id: string;
      readonly version: number;
    }>`SELECT id, version FROM counters ORDER BY id`,
  );

/** The cases both commits (in one transaction, in one batch) must pass. */
const commitCases = (
  it: Vitest.MethodsNonLive<SqlClient.SqlClient | SqlUnitOfWork.Committer | UnitOfWork.UnitOfWork>,
) => {
  it.effect("commits every write of a batch, in order", () =>
    Effect.gen(function* () {
      const sql = yield* setUp;
      const committer = yield* SqlUnitOfWork.Committer;
      yield* committer.commit([bump(sql, "a", 1), bump(sql, "a", 2), bump(sql, "b", 1)]);
      expect(yield* versions(sql)).toEqual([
        { id: "a", version: 3 },
        { id: "b", version: 2 },
      ]);
    }),
  );

  it.effect("rolls back the whole batch on an unmet guard, failing with its conflict", () =>
    Effect.gen(function* () {
      const sql = yield* setUp;
      const committer = yield* SqlUnitOfWork.Committer;
      const failure = yield* Effect.flip(
        committer.commit([bump(sql, "b", 1), bump(sql, "a", 1), bump(sql, "a", 1)]),
      );
      expect(failure).toBe(conflict);
      expect(yield* versions(sql)).toEqual([
        { id: "a", version: 1 },
        { id: "b", version: 1 },
      ]);
    }),
  );

  it.effect("checks a guard of several rows", () =>
    Effect.gen(function* () {
      const sql = yield* setUp;
      const committer = yield* SqlUnitOfWork.Committer;
      const both = SqlUnitOfWork.guarded(
        sql`UPDATE counters SET version = version + 1 WHERE version = 1 RETURNING id`,
        { rows: 2, conflict: Effect.succeed(conflict) },
      );
      yield* committer.commit([both]);
      expect(yield* Effect.flip(committer.commit([both]))).toBe(conflict);
    }),
  );

  it.effect("applies an unguarded write, and fails a database error as a defect", () =>
    Effect.gen(function* () {
      const sql = yield* setUp;
      const committer = yield* SqlUnitOfWork.Committer;
      yield* committer.commit([
        SqlUnitOfWork.unguarded(
          sql`UPDATE counters SET version = 7 WHERE id = 'none' RETURNING id`,
        ),
      ]);
      const exit = yield* Effect.exit(
        committer.commit([
          bump(sql, "a", 1),
          SqlUnitOfWork.unguarded(sql`INSERT INTO counters (id, version) VALUES ('b', 1)`),
        ]),
      );
      expect(Exit.hasDies(exit)).toBe(true);
      expect(yield* versions(sql)).toEqual([
        { id: "a", version: 1 },
        { id: "b", version: 1 },
      ]);
    }),
  );

  it.effect("stages inside a transaction and commits at once outside one", () =>
    Effect.gen(function* () {
      const sql = yield* setUp;
      const committer = yield* SqlUnitOfWork.Committer;
      yield* SqlUnitOfWork.stage(committer, bump(sql, "a", 1));
      expect(yield* versions(sql)).toEqual([
        { id: "a", version: 2 },
        { id: "b", version: 1 },
      ]);
      yield* UnitOfWork.transaction(
        Effect.gen(function* () {
          yield* SqlUnitOfWork.stage(committer, bump(sql, "b", 1));
          expect((yield* versions(sql))[1]).toEqual({ id: "b", version: 1 });
        }),
      );
      expect((yield* versions(sql))[1]).toEqual({ id: "b", version: 2 });
    }),
  );
};

layer(SqlUnitOfWork.layer().pipe(Layer.provideMerge(Testing.layerSqlite)), {
  buildPerTest: true,
})("the transactional commit on SQLite", commitCases);

layer(
  SqlUnitOfWork.layerBatch().pipe(
    Layer.provideMerge(Testing.layerBatch),
    Layer.provideMerge(Testing.layerSqlite),
  ),
  { buildPerTest: true },
)("D1's batch commit on SQLite", commitCases);

// `layer` on D1 commits through the host's `Batch`: here D1's batch over SQLite.
layer(
  SqlUnitOfWork.layer().pipe(
    Layer.provideMerge(Layer.mergeAll(Dialect.layerAs("d1"), Testing.layerBatch)),
    Layer.provideMerge(Testing.layerSqlite),
  ),
  { buildPerTest: true },
)("layer on D1, with a Batch", commitCases);

describe("layer on D1", () => {
  it.effect("fails while built without a Batch", () =>
    Effect.gen(function* () {
      const failure = yield* Effect.flip(
        Layer.build(
          SqlUnitOfWork.layer().pipe(
            Layer.provide(Dialect.layerAs("d1")),
            Layer.provide(Testing.layerSqlite),
          ),
        ),
      );
      expect(failure).toEqual(new SqlUnitOfWork.BatchRequired({ dialect: "d1" }));
      expect(failure.message).toContain("SqlUnitOfWork.Batch");
    }).pipe(Effect.scoped),
  );
});
