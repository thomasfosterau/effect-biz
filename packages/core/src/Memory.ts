/**
 * The in-memory store domain packages build their in-memory repository
 * layers on: a tenant-partitioned `Ref` of maps, written by one atomic
 * decide-and-commit.
 *
 * A {@link Store} holds every tenant's rows, keyed by id; a call reads and
 * writes only the rows of the `Tenancy.TenantContext` it runs under.
 * {@link modify} is the one write primitive: a pure decision over the
 * tenant's rows, applied in a single `Ref.modify`, so concurrent writes
 * serialise and of two writes from the same version exactly one succeeds
 * (the shape every command has, #128). {@link repository} builds a whole
 * `Repository.Port` from a store; a domain package adds its own methods over
 * the same store.
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
import * as Ref from "effect/Ref";
import * as Result from "effect/Result";
import * as Audit from "./Audit.js";
import * as BizError from "./BizError.js";
import * as Query from "./Query.js";
import type * as Repository from "./Repository.js";
import * as Tenancy from "./Tenancy.js";

/** One tenant's rows, by id. */
export type Rows<I extends string, A> = HashMap.HashMap<I, A>;

/** Every tenant's rows: what a {@link Store} holds. */
export type Partitions<I extends string, A> = HashMap.HashMap<Tenancy.TenantId, Rows<I, A>>;

/** An in-memory, tenant-partitioned store of entities `A` with ids `I`. */
export interface Store<I extends string, A> {
  /** The rows of every tenant. */
  readonly partitions: Ref.Ref<Partitions<I, A>>;
}

/** An empty store. */
export const makeStore = <I extends string, A>(): Effect.Effect<Store<I, A>> =>
  Effect.map(Ref.make<Partitions<I, A>>(HashMap.empty()), (partitions) => ({ partitions }));

const rowsOf = <I extends string, A>(
  partitions: Partitions<I, A>,
  tenantId: Tenancy.TenantId,
): Rows<I, A> => Option.getOrElse(HashMap.get(partitions, tenantId), () => HashMap.empty());

/** The current tenant's rows. */
export const rows = <I extends string, A>(
  store: Store<I, A>,
): Effect.Effect<Rows<I, A>, never, Tenancy.TenantContext> =>
  Effect.flatMap(Tenancy.currentTenant, (tenantId) =>
    Effect.map(Ref.get(store.partitions), (partitions) => rowsOf(partitions, tenantId)),
  );

/** A write's decision: its failure, or its result and the tenant's rows after it. */
export type Decision<I extends string, A, B, E> = Result.Result<readonly [B, Rows<I, A>], E>;

/**
 * Decides and commits a write to the current tenant's rows in one atomic
 * `Ref.modify`: the rows change only when `decide` succeeds, and the effect
 * fails with its failure otherwise.
 */
export const modify = <I extends string, A, B, E>(
  store: Store<I, A>,
  decide: (current: Rows<I, A>) => Decision<I, A, B, E>,
): Effect.Effect<B, E, Tenancy.TenantContext> =>
  Effect.flatMap(Tenancy.currentTenant, (tenantId) =>
    Effect.flatMap(
      Ref.modify(store.partitions, (partitions) => {
        const decided = decide(rowsOf(partitions, tenantId));
        const after = Result.match(decided, {
          onFailure: () => partitions,
          onSuccess: ([, next]) => HashMap.set(partitions, tenantId, next),
        });
        return [Result.map(decided, ([result]) => result), after] as const;
      }),
      Effect.fromResult,
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
): Decision<I, A, A, BizError.NotFound | BizError.ConcurrencyConflict | E> =>
  Option.match(HashMap.get(current, id), {
    onNone: () => Result.fail(new BizError.NotFound({ entity, id })),
    onSome: (stored): Decision<I, A, A, BizError.NotFound | BizError.ConcurrencyConflict | E> =>
      stored.audit.version === version
        ? Result.map(change(stored), (next) => [next, HashMap.set(current, id, next)] as const)
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
): Decision<I, A, void, BizError.AlreadyExists | BizError.ConcurrencyConflict> => {
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
    : Result.succeed([undefined, HashMap.set(current, row.id, row)] as const);
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
 * tenant, every write one atomic decide-and-commit, `find` run by
 * `Query.run`.
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
  const write = <E>(id: I, version: number, change: (stamp: Audit.Stamp) => Change<A, E>) =>
    Effect.flatMap(Audit.stamp, (stamp) =>
      modify(store, (current) => decideWrite(entity, current, id, version, change(stamp))),
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
    insert: (row) => modify(store, (current) => decideInsert(entity, current, row)),
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
