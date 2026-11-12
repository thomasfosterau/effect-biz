# The unit of work

How a command reads and writes: **load → decide (pure) → commit one batch**, retried from the load step when the batch hits a version conflict. The shape suits Cloudflare D1 (no row locks, no interactive transactions) as well as Postgres, so every dialect and the in-memory layers work the same way (#29, #128). See also [repositories](repositories.md).

## The shape of a command

A service wraps each of its commands in `UnitOfWork.transaction(...)`; the caller never does, and a repository never opens a transaction itself.

1. **Load.** Read what the command needs (`get`, `getMany`, `find`). Reads see committed state.
2. **Decide.** Work out the new state as pure code over what was loaded.
3. **Stage.** Call the repositories' writes (`insert`, `update`, `archive`, `restore`) and record events. Inside a transaction a write is not applied: each one checks its version eagerly against the committed row (so a stale version or a used id fails at once, with its own error) and then stages a guarded write into the transaction's batch.
4. **Commit.** When the command succeeds, the unit of work commits every staged write as one atomic batch. Each write's guard re-checks that its row is still at the version the command decided from; if any guard fails, nothing in the batch applies.

| When | What happens |
| --- | --- |
| The command succeeds | Its batch commits, across every store it wrote (aggregates and the outbox alike). |
| The command fails, or is interrupted, before the commit | Nothing applies: the staged writes are dropped. |
| A guard fails at commit (another command committed first) | Nothing applies, and the whole command runs again from its load step, after a jittered exponential backoff (5 attempts from 10 ms by default); after the last one it fails with `ConcurrencyConflict`. |
| The command itself fails with `ConcurrencyConflict` (a stale version it was given) | Returned as it is, never retried: running it again would fail the same way. |
| `transaction` is called inside another | It joins the outer one, which alone commits and retries. |
| A write runs outside any transaction | It commits at once, as its own batch of one. |

The commit is uninterruptible, so it applies all of the batch or none of it.

**No read-your-writes.** A read inside a transaction never sees the writes staged so far: an insert staged in this command is still `NotFound` to a `get`. Decide from what you loaded, and keep the values the writes return (`update` returns the entity at its next version).

## Example

A command that writes two aggregates and records an event, then fails, leaves every store untouched:

```ts
import { Context, Effect, Layer, Struct } from "effect";
import * as Actor from "@thomasfosterau/effect-biz/Actor";
import * as Audit from "@thomasfosterau/effect-biz/Audit";
import * as BizError from "@thomasfosterau/effect-biz/BizError";
import * as Memory from "@thomasfosterau/effect-biz/Memory";
import type * as Repository from "@thomasfosterau/effect-biz/Repository";
import * as Tenancy from "@thomasfosterau/effect-biz/Tenancy";
import * as UnitOfWork from "@thomasfosterau/effect-biz/UnitOfWork";

interface Task {
  readonly id: string;
  readonly title: string;
  readonly done: boolean;
  readonly audit: Audit.AuditFields;
}

class Tasks extends Context.Service<
  Tasks,
  { readonly port: Repository.Port<Task, string>; readonly events: Memory.Log<string> }
>()("example/Tasks") {}

const tasksMemory = Layer.effect(
  Tasks,
  Effect.gen(function* () {
    const store = yield* Memory.makeStore<string, Task>();
    const port = Memory.repository(store, {
      entity: "Task",
      withAudit: (task, audit) => ({ ...Struct.omit(task, ["audit"]), audit }),
      searchable: ["title"],
    });
    return { port, events: yield* Memory.makeLog<string>() };
  }),
);

// Completes a task and opens its follow-up, recording an event, then breaks a rule.
const complete = (id: string, followUp: string) =>
  UnitOfWork.transaction(
    Effect.gen(function* () {
      const { port, events } = yield* Tasks;
      const task = yield* port.get(id);
      yield* port.update({ ...task, done: true });
      yield* port.insert({
        id: followUp,
        title: "Follow up",
        done: false,
        audit: yield* Audit.created,
      });
      yield* Memory.append(events, "task.completed");
      return yield* new BizError.BusinessRuleViolation({
        code: "example.no-follow-ups",
        reason: "follow-ups are not allowed",
      });
    }),
  );

const program = Effect.gen(function* () {
  const { port, events } = yield* Tasks;
  yield* port.insert({ id: "t1", title: "Call back", done: false, audit: yield* Audit.created });
  yield* Effect.flip(complete("t1", "t2"));
  const task = yield* port.get("t1");
  const followUps = yield* port.getMany(["t2"]);
  const recorded = yield* Memory.entries(events);
  return [task.done, followUps.length, recorded.length];
});

const tenant = Tenancy.TenantId.make("0190a6e4-1c2d-7abc-8def-0123456789ab");
const result = Effect.runSync(
  program.pipe(
    Effect.provide(Layer.merge(tasksMemory, UnitOfWork.layerMemory)),
    Tenancy.withTenant(tenant),
    Actor.withActor(Actor.system("example")),
  ),
);
console.log(result); // [false, 0, 0]
```

## Layers

- **`UnitOfWork.layerMemory`** commits what `./Memory` stages. Every `Memory` store (`makeStore`) and log (`makeLog`) is a `TxRef`, and `Memory.put` / `Memory.append` stage an effect over it, so one batch writes several stores in a single `Effect.tx`: all or none. `UnitOfWork.makeMemory({ attempts, backoff })` tunes the retry.
- **A SQL layer** declares its own journal and commit: `UnitOfWork.makeJournal<W>(key)` gives the per-transaction buffer of its write type `W` (a `Context.Reference`, empty outside a transaction, so repository methods need nothing new in `R`); its repositories stage with `UnitOfWork.stage(journal, write, commit)`; and `UnitOfWork.make(journal, commit, options)` is its `UnitOfWork`. `commit` runs the batch atomically (one D1 `batch`, or one Postgres transaction of version-guarded statements) and fails with `ConcurrencyConflict` when a guarded statement matches no row.

```ts skip-type-checking
const journal = UnitOfWork.makeJournal<Statement>("example/SqlJournal");
const commit = (statements: ReadonlyArray<Statement>) => runBatch(statements); // fails with ConcurrencyConflict when a guard matches no row
const layer = Layer.succeed(UnitOfWork.UnitOfWork, UnitOfWork.make(journal, commit));
```

## The contract suite

`Testing.unitOfWorkContract(subject)` is the suite every unit of work runs, runner-agnostic like `repositoryContract`. The subject is a repository subject (`repository`, `make`, `change`) plus `record` (stage one event) and `recorded` (how many the tenant has committed). Its cases: a command commits its writes to every store in one batch, unseen by its own reads; a failing command, an interrupted one and a nested transaction its outer one aborts leave every store untouched; a commit conflicting with a concurrent command is retried from load and succeeds; a batch that always conflicts ends in `ConcurrencyConflict` after bounded retries; and a conflict the command raises itself is not retried. The retry cases sleep between attempts, so run them on a live clock (with `@effect/vitest`, `layer(..., { excludeTestServices: true })`).
