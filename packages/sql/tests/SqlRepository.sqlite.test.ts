import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlUnitOfWork from "../src/SqlUnitOfWork.ts";
import * as Testing from "../src/testing.ts";
import { suites } from "./suite.ts";

// Each case on a fresh in-memory database, committing in one `withTransaction`.
suites({
  name: "SQLite",
  database: SqlUnitOfWork.layer().pipe(Layer.provideMerge(Testing.layerSqlite)),
  buildPerTest: true,
  guard: () => Effect.void,
});
