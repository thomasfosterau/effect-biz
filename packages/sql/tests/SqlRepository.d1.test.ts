import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlUnitOfWork from "../src/SqlUnitOfWork.ts";
import * as Testing from "../src/testing.ts";
import { suites } from "./suite.ts";

// D1 has no in-process database and its SQL is SQLite's: every case runs
// D1's commit (one atomic batch, each guard a statement that raises when
// unmet) on a fresh in-memory SQLite database, through `Testing.layerBatch`.
suites({
  name: "D1's batch commit, on SQLite",
  database: SqlUnitOfWork.layerBatch().pipe(
    Layer.provideMerge(Testing.layerBatch),
    Layer.provideMerge(Testing.layerSqlite),
  ),
  buildPerTest: true,
  guard: () => Effect.void,
});
