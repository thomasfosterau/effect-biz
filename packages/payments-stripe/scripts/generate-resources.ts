/**
 * Regenerates the resource modules (`src/Customer.ts`, `src/Invoice.ts`, …):
 * one wrapped operation per `@distilled.cloud/stripe` operation on each
 * published resource, as `resources.ts` assigns and names them.
 *
 * The input is the installed Distilled release (its operations and their
 * declarations), so the output is a pure function of the lockfile and
 * `resources.ts`; `tests/resources.test.ts` fails when a module on disk
 * differs from it. Refuses to write anything while the plan has a problem
 * (an operation neither assigned nor listed as unexposed, a name clash).
 *
 * Run it with `vp run --filter ./packages/payments-stripe generate:resources`.
 *
 * @module
 */

import * as Arr from "effect/Array";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as R from "effect/Record";
import * as Schema from "effect/Schema";
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { installed } from "./distilled.ts";
import { plan, readOperations, render, runtimeOperations } from "./resources.ts";

/** The plan has a problem, so nothing is written. */
class PlanError extends Schema.TaggedError<PlanError>()("PlanError", {
  message: Schema.String,
}) {}

/** Plan from the installed Distilled release and write every resource module. */
const generate = Effect.fn("generateResources")(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = path.dirname(path.dirname(path.resolve(import.meta.filename)));
  const distilled = installed();
  const operations = readOperations(distilled.declarations, distilled.module);
  const read = operations.map((operation) => operation.name);
  const unread = runtimeOperations(distilled.module).filter((name) => !read.includes(name));
  const planned = plan(operations);
  const problems = [
    ...unread.map((name) => `${name} is exported by Distilled, but its declaration was not read`),
    ...planned.problems,
  ];
  if (Arr.isReadonlyArrayNonEmpty(problems)) {
    return yield* new PlanError({
      message: `The resource plan has problems:\n${problems.join("\n")}`,
    });
  }
  const files = yield* render(planned, distilled.version);
  yield* Effect.forEach(
    R.toEntries(files),
    ([file, code]) => fs.writeFileString(path.join(root, file), code),
    {
      concurrency: "unbounded",
      discard: true,
    },
  );
  const exposed = R.values(planned.modules).reduce((sum, module) => sum + module.length, 0);
  yield* Console.log(
    `Wrote ${R.size(files)} resource modules: ${exposed} operations exposed, ${planned.unexposed.length} left unexposed`,
  );
});

NodeRuntime.runMain(generate().pipe(Effect.provide(NodeServices.layer)));
