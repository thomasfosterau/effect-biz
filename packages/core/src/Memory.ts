/**
 * The in-memory store domain packages build their in-memory repository
 * layers on: a tenant-partitioned `TxRef` of maps, written through
 * `./UnitOfWork`.
 *
 * A {@link Store} holds every tenant's rows, keyed by id; a call reads and
 * writes only the rows of the `Tenancy.TenantContext` it runs under.
 * {@link put} is the one write primitive: a write of one row guarded by the
 * version it must still be at, staged into the open
 * `UnitOfWork.transaction`'s batch (or committed at once outside one). A
 * batch commits in one `Effect.tx`, so its writes to several stores apply
 * all or none, and of two writes from the same version exactly one commits
 * (the shape every command has, #128). {@link Log} is an append-only
 * companion store, the shape of an outbox. Reads see committed rows only:
 * a transaction does not read its own staged writes. {@link repository}
 * builds a whole `Repository.Port` from a store; a domain package adds its
 * own methods over the same store.
 *
 * See {@link repository} for an example.
 *
 * @module
 */

import * as Arr from "effect/Array";
import type * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as HashMap from "effect/HashMap";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as TxRef from "effect/TxRef";
import * as Audit from "./Audit.js";
import * as BizError from "./BizError.js";
import * as Query from "./Query.js";
import type * as Repository from "./Repository.js";
import * as Tenancy from "./Tenancy.js";
import * as UnitOfWork from "./UnitOfWork.js";

/** One tenant's rows, by id. */
export type Rows<I extends string, A> = HashMap.HashMap<I, A>;

/** Every tenant's rows: what a {@link Store} holds. */
export type Partitions<I extends string, A> = HashMap.HashMap<Tenancy.TenantId, Rows<I, A>>;

/** An in-memory, tenant-partitioned store of entities `A` with ids `I`. */
export interface Store<I extends string, A> {
  /** The rows of every tenant, transactional so one batch can write several stores. */
  readonly partitions: TxRef.TxRef<Partitions<I, A>>;
}

/** An empty store. */
export const makeStore = <I extends string, A>(): Effect.Effect<Store<I, A>> =>
  Effect.map(TxRef.make<Partitions<I, A>>(HashMap.empty()), (partitions) => ({ partitions }));

const rowsOf = <I extends string, A>(
  partitions: Partitions<I, A>,
  tenantId: Tenancy.TenantId,
): Rows<I, A> => Option.getOrElse(HashMap.get(partitions, tenantId), () => HashMap.empty());

/** The current tenant's committed rows (never the writes a transaction has staged). */
export const rows = <I extends string, A>(
  store: Store<I, A>,
): Effect.Effect<Rows<I, A>, never, Tenancy.TenantContext> =>
  Effect.flatMap(Tenancy.currentTenant, (tenantId) =>
    Effect.map(TxRef.get(store.partitions), (partitions) => rowsOf(partitions, tenantId)),
  );

/** Stages an in-memory write into the open transaction, or commits it at once outside one. */
const stage = (write: UnitOfWork.MemoryWrite): Effect.Effect<void, BizError.ConcurrencyConflict> =>
  UnitOfWork.stage(UnitOfWork.memoryJournal, write, UnitOfWork.commitMemory);

/** A version-guarded write of one row, as {@link put} takes it. */
export interface Put<I extends string, A> {
  /** The entity kind a conflict names, e.g. `"Company"`. */
  readonly entity: string;
  /** The row's id. */
  readonly id: I;
  /** The version the row must be stored at when the write commits: 0 for no row yet (an insert). */
  readonly expected: number;
  /** The row to store in its place. */
  readonly row: A;
}

/**
 * Stages a version-guarded write of one row of the current tenant, through
 * `UnitOfWork`: inside a transaction it joins the transaction's batch,
 * outside one it commits at once. At commit, the stored row must still be at
 * `expected` (no row for 0), or the batch aborts with `ConcurrencyConflict`
 * and nothing in it is applied. Decide (and refuse) before staging, against
 * the rows {@link rows} reads: the guard only re-checks the version.
 */
export const put = <I extends string, A extends Audit.Audited>(
  store: Store<I, A>,
  write: Put<I, A>,
): Effect.Effect<void, BizError.ConcurrencyConflict, Tenancy.TenantContext> =>
  Effect.flatMap(Tenancy.currentTenant, (tenantId) =>
    stage(
      Effect.flatMap(
        TxRef.modify(
          store.partitions,
          (partitions): [Result.Result<void, BizError.ConcurrencyConflict>, Partitions<I, A>] => {
            const current = rowsOf(partitions, tenantId);
            const actual = Option.match(HashMap.get(current, write.id), {
              onNone: () => 0,
              onSome: (stored) => stored.audit.version,
            });
            return actual === write.expected
              ? [
                  Result.succeed(undefined),
                  HashMap.set(partitions, tenantId, HashMap.set(current, write.id, write.row)),
                ]
              : [
                  Result.fail(
                    new BizError.ConcurrencyConflict({
                      entity: write.entity,
                      id: write.id,
                      expected: write.expected,
                      actual,
                    }),
                  ),
                  partitions,
                ];
          },
        ),
        Effect.fromResult,
      ),
    ),
  );

/**
 * An in-memory, tenant-partitioned, append-only log of items `A`: the
 * shape an outbox takes, so a command can record what happened in the same
 * batch as its state change.
 */
export interface Log<A> {
  /** The items of every tenant, in the order appended. */
  readonly entries: TxRef.TxRef<HashMap.HashMap<Tenancy.TenantId, ReadonlyArray<A>>>;
}

/** An empty log. */
export const makeLog = <A>(): Effect.Effect<Log<A>> =>
  Effect.map(
    TxRef.make<HashMap.HashMap<Tenancy.TenantId, ReadonlyArray<A>>>(HashMap.empty()),
    (entries) => ({
      entries,
    }),
  );

/** The current tenant's committed items, in the order appended. */
export const entries = <A>(
  log: Log<A>,
): Effect.Effect<ReadonlyArray<A>, never, Tenancy.TenantContext> =>
  Effect.flatMap(Tenancy.currentTenant, (tenantId) =>
    Effect.map(TxRef.get(log.entries), (all) =>
      Option.getOrElse(HashMap.get(all, tenantId), (): ReadonlyArray<A> => []),
    ),
  );

/**
 * Stages an append of `item` to the current tenant's log, through
 * `UnitOfWork` like {@link put}: it lands only if the transaction's batch
 * commits. An append has no guard of its own.
 */
export const append = <A>(
  log: Log<A>,
  item: A,
): Effect.Effect<void, BizError.ConcurrencyConflict, Tenancy.TenantContext> =>
  Effect.flatMap(Tenancy.currentTenant, (tenantId) =>
    stage(
      TxRef.update(log.entries, (all) =>
        HashMap.modifyAt(all, tenantId, (items) =>
          Option.some(
            Arr.append(
              Option.getOrElse(items, (): ReadonlyArray<A> => []),
              item,
            ),
          ),
        ),
      ),
    ),
  );

/** How {@link repository} treats an entity kind. */
export interface Options<A> extends Query.Options<A> {
  /** The entity kind its errors name, e.g. `"Company"`. */
  readonly entity: string;
  /** The entity with other audit fields, every other field unchanged. */
  readonly withAudit: (entity: A, audit: Audit.AuditFields) => A;
}

type Entity<I extends string> = Audit.Audited & { readonly id: I };

/** A pure decision over a stored entity: the entity to store in its place, or a failure. */
type Change<A, E> = (current: A) => Result.Result<A, E>;

/**
 * Decides a version-guarded write to the entity `id`, stored at `version`:
 * `NotFound` without one, `ConcurrencyConflict` at another version, else
 * `change`'s outcome.
 */
const decideWrite = <I extends string, A extends Entity<I>, E>(
  entity: string,
  current: Rows<I, A>,
  id: I,
  version: number,
  change: Change<A, E>,
): Result.Result<A, BizError.NotFound | BizError.ConcurrencyConflict | E> =>
  Option.match(HashMap.get(current, id), {
    onNone: () => Result.fail(new BizError.NotFound({ entity, id })),
    onSome: (stored): Result.Result<A, BizError.NotFound | BizError.ConcurrencyConflict | E> =>
      stored.audit.version === version
        ? change(stored)
        : Result.fail(
            new BizError.ConcurrencyConflict({
              entity,
              id,
              expected: version,
              actual: stored.audit.version,
            }),
          ),
  });

/** Decides an insert: version 1, and an id the tenant has not used. */
const decideInsert = <I extends string, A extends Entity<I>>(
  entity: string,
  current: Rows<I, A>,
  row: A,
): Result.Result<A, BizError.AlreadyExists | BizError.ConcurrencyConflict> => {
  if (row.audit.version !== 1) {
    return Result.fail(
      new BizError.ConcurrencyConflict({
        entity,
        id: row.id,
        expected: 1,
        actual: row.audit.version,
      }),
    );
  }
  return HashMap.has(current, row.id)
    ? Result.fail(new BizError.AlreadyExists({ entity, key: row.id }))
    : Result.succeed(row);
};

/** The archive change: `archivedAt` set when `archive`, cleared otherwise; refused from the same state. */
const archiveChange =
  <A extends Audit.Audited>(
    options: Options<A>,
    stamp: Audit.Stamp,
    archive: boolean,
  ): Change<A, BizError.InvalidTransition> =>
  (current) => {
    if (Audit.isArchived(current) === archive) {
      return Result.fail(
        new BizError.InvalidTransition({
          entity: options.entity,
          id: current.id,
          from: archive ? "archived" : "active",
          command: archive ? "archive" : "restore",
        }),
      );
    }
    const archivedAt: Option.Option<DateTime.Utc> = archive ? Option.some(stamp.at) : Option.none();
    return Result.succeed(options.withAudit(current, Audit.next(current.audit, stamp, archivedAt)));
  };

/**
 * A `Repository.Port` over a store: every method scoped to the current
 * tenant, `find` run by `Query.run`. Each write decides eagerly against
 * the committed rows (so a stale version or a used id fails at once, with
 * its own error) and then stages the decided row with {@link put}, whose
 * guard re-checks the version at commit.
 *
 * @example
 * ```ts
 * import { Effect } from "effect";
 * import * as Actor from "@thomasfosterau/effect-biz/Actor";
 * import * as Audit from "@thomasfosterau/effect-biz/Audit";
 * import * as Memory from "@thomasfosterau/effect-biz/Memory";
 * import * as Tenancy from "@thomasfosterau/effect-biz/Tenancy";
 *
 * interface Note {
 *   readonly id: string;
 *   readonly text: string;
 *   readonly audit: Audit.AuditFields;
 * }
 *
 * const program = Effect.gen(function* () {
 *   const store = yield* Memory.makeStore<string, Note>();
 *   const notes = Memory.repository(store, {
 *     entity: "Note",
 *     withAudit: (note, audit) => ({ id: note.id, text: note.text, audit }),
 *     searchable: ["text"],
 *   });
 *   const audit = yield* Audit.created;
 *   yield* notes.insert({ id: "00000000-0000-7000-8000-000000000001", text: "Call back", audit });
 *   const page = yield* notes.find({ search: "call" });
 *   return page.items.length;
 * });
 *
 * const tenant = Tenancy.TenantId.make("0190a6e4-1c2d-7abc-8def-0123456789ab");
 * const found = Effect.runSync(
 *   program.pipe(Tenancy.withTenant(tenant), Actor.withActor(Actor.system("example"))),
 * );
 * console.log(found); // 1
 * ```
 */
export const repository = <I extends string, A extends Entity<I>>(
  store: Store<I, A>,
  options: Options<A>,
): Repository.Port<A, I> => {
  const { entity } = options;
  /** Decides against the committed rows, then stages the decided row, guarded by `expected`. */
  const decided = <E>(expected: number, decide: (current: Rows<I, A>) => Result.Result<A, E>) =>
    Effect.flatMap(rows(store), (current) =>
      Effect.tap(Effect.fromResult(decide(current)), (row) =>
        put(store, { entity, id: row.id, expected, row }),
      ),
    );
  const write = <E>(id: I, version: number, change: (stamp: Audit.Stamp) => Change<A, E>) =>
    Effect.flatMap(Audit.stamp, (stamp) =>
      decided(version, (current) => decideWrite(entity, current, id, version, change(stamp))),
    );
  return {
    get: (id) =>
      Effect.flatMap(rows(store), (current) =>
        Effect.fromOption(HashMap.get(current, id), () => new BizError.NotFound({ entity, id })),
      ),
    getMany: (ids) =>
      Effect.map(rows(store), (current) =>
        Arr.getSomes(Arr.map(Arr.dedupe(Arr.fromIterable(ids)), (id) => HashMap.get(current, id))),
      ),
    find: (query, request) =>
      Effect.flatMap(rows(store), (current) =>
        Effect.fromResult(Query.run(HashMap.values(current), query, request, options)),
      ),
    insert: (row) => Effect.asVoid(decided(0, (current) => decideInsert(entity, current, row))),
    update: (row) =>
      write(
        row.id,
        row.audit.version,
        (stamp) => (current) =>
          Result.succeed(options.withAudit(row, Audit.next(current.audit, stamp))),
      ),
    archive: (id, version) => write(id, version, (stamp) => archiveChange(options, stamp, true)),
    restore: (id, version) => write(id, version, (stamp) => archiveChange(options, stamp, false)),
  };
};
