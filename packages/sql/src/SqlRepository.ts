/**
 * A whole `Repository.Port` over one SQL table: the helper a domain
 * package's SQL repository layer is built with, on Postgres, SQLite and
 * Cloudflare D1.
 *
 * {@link make} takes the table, the entity's column codecs (built from
 * `./Column` for the current dialect) and its allow-lists, and returns the
 * port:
 *
 * - **Reads** (`get`, `getMany`, `find`) read committed rows of the current
 *   tenant (`tenant_id` from `Tenancy.TenantContext`, always), each decoded
 *   through `Schema`. `find` translates core's `Query` into `WHERE` /
 *   `ORDER BY` over the `filterable` allow-list (a field off it is a
 *   `ValidationError`) and pages it by keyset with core's own cursors, so a
 *   cursor from the in-memory store continues here and the reverse.
 * - **Writes** (`insert`, `update`, `archive`, `restore`) decide eagerly
 *   against a fresh read, for a precise error (`AlreadyExists`, `NotFound`,
 *   `ConcurrencyConflict`, `InvalidTransition`), stamp the audit fields
 *   (`Audit.next`, as `Memory.repository` does), and stage one
 *   version-guarded statement into the open `UnitOfWork.transaction`
 *   (`./SqlUnitOfWork`), or commit it at once outside one: an insert
 *   `ON CONFLICT (id) DO NOTHING`, an update `WHERE tenant_id = ? AND id = ?
 *   AND version = ?`, each `RETURNING id` and guarded on one row.
 *
 * The table carries `id` (the primary key), `tenant_id`, one column per
 * field (snake_case by default), `version` and the audit columns
 * `created_at`, `created_by`, `updated_at`, `updated_by` and `archived_at`.
 * A database failure, or a stored row that does not decode, is a defect:
 * the port has no error channel for either.
 *
 * See {@link make} for an example.
 *
 * @module
 */

import * as Audit from "@thomasfosterau/effect-biz/Audit";
import * as BizError from "@thomasfosterau/effect-biz/BizError";
import type * as Query from "@thomasfosterau/effect-biz/Query";
import type * as Repository from "@thomasfosterau/effect-biz/Repository";
import * as Tenancy from "@thomasfosterau/effect-biz/Tenancy";
import * as Arr from "effect/Array";
import type * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as HashMap from "effect/HashMap";
import * as Option from "effect/Option";
import * as R from "effect/Record";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import type * as SqlConnection from "effect/sql/SqlConnection";
import type * as SqlError from "effect/sql/SqlError";
import * as Str from "effect/String";
import * as Column from "./Column.js";
import * as Dialect from "./Dialect.js";
import * as Internal from "./internal/query.js";
import * as SqlUnitOfWork from "./SqlUnitOfWork.js";

/**
 * How an allow-listed column compares and sorts: `text` (code-point order,
 * `COLLATE "C"` on Postgres), `id` (a UUID), `number`, `boolean`,
 * `timestamp` or `decimal` (`numeric` on Postgres; on SQLite and D1 the
 * canonical text compares as `REAL`, so a range or a sort on a decimal of
 * more than 15 significant digits is approximate there, while `eq` and `in`
 * stay exact).
 */
export type Kind = Internal.Kind;

/** A column codec with no services: the type of each of a repository's {@link Fields}. */
export type Codec = Internal.Codec;

/** An entity's domain fields (every field but `id` and `audit`), each with its column codec. */
export interface Fields {
  readonly [field: PropertyKey]: Codec;
}

/** What a repository stores: an entity with its id and audit fields. */
export type Entity<I extends string> = Audit.Audited & { readonly id: I };

/** A decoded row: the entity's domain fields, its id and its audit fields, for {@link Options.make}. */
export type Row<I extends string, F extends Fields> = Schema.Struct.Type<F> & {
  readonly id: I;
  readonly audit: Audit.AuditFields;
};

/** How {@link make} maps an entity kind onto its table. */
export interface Options<A extends Entity<I>, I extends string, F extends Fields> {
  /** The table, e.g. `"widgets"`. */
  readonly table: string;
  /** The entity kind its errors name, e.g. `"Widget"`. */
  readonly entity: string;
  /** The id's codec (core's `Id.make(kind)`). */
  readonly id: Schema.Codec<I, string>;
  /** The domain fields' column codecs, for the current dialect's `./Column` codecs. */
  readonly fields: (columns: Column.Columns) => F;
  /** Column names that are not the field's name in snake_case. */
  readonly columns?: { readonly [K in keyof NoInfer<F>]?: string };
  /** The entity of a decoded row. */
  readonly make: (row: Row<I, NoInfer<F>>) => A;
  /**
   * The entity with other audit fields, every other field unchanged (as
   * `Memory.Options.withAudit`). The entity type is inferred from it, so give
   * its parameters and result their types.
   */
  readonly withAudit: (entity: A, audit: Audit.AuditFields) => A;
  /**
   * The fields `find` may filter (`eq`, `in`, `range`) and sort by, with how
   * each compares; any other is a `ValidationError`. The id is always
   * allowed.
   */
  readonly filterable?: { readonly [K in Query.FieldsOf<NoInfer<A>, Query.Value>]?: Kind };
  /** The text fields `search` matches, case-insensitively. */
  readonly searchable?: ReadonlyArray<Query.FieldsOf<NoInfer<A>, string>>;
}

/** The audit columns of a row, on a dialect. */
const auditRow = (columns: Column.Columns) =>
  Schema.Struct({
    version: Audit.Version,
    created_at: columns.timestamp,
    created_by: Schema.NonEmptyString,
    updated_at: columns.timestamp,
    updated_by: Schema.NonEmptyString,
    archived_at: columns.nullable(columns.timestamp),
  });

/** An archive-state command: the state it leads to, the state it refuses, and the stamp of `archivedAt`. */
interface Transition {
  readonly command: "archive" | "restore";
  readonly archived: boolean;
  readonly from: "archived" | "active";
  readonly archivedAt: (stamp: Audit.Stamp) => Option.Option<DateTime.Utc>;
}

const transitions = {
  archive: {
    command: "archive",
    archived: true,
    from: "archived",
    archivedAt: (stamp) => Option.some(stamp.at),
  },
  restore: { command: "restore", archived: false, from: "active", archivedAt: () => Option.none() },
} satisfies { readonly archive: Transition; readonly restore: Transition };

/** The audit columns a write replaces: every one but the creation's. */
const unchanged: ReadonlyArray<"id" | "tenant_id" | "version" | "created_at" | "created_by"> = [
  "id",
  "tenant_id",
  "version",
  "created_at",
  "created_by",
];

/**
 * A `Repository.Port` over one table of the current dialect, writing
 * through the {@link SqlUnitOfWork.Committer} of `./SqlUnitOfWork`'s layer
 * (inside a `UnitOfWork.transaction` its writes join the batch; outside one,
 * each commits at once).
 *
 * @example
 * ```ts
 * import { Effect, Layer, Schema, Struct } from "effect";
 * import { SqlClient } from "effect/sql";
 * import * as Actor from "@thomasfosterau/effect-biz/Actor";
 * import * as Audit from "@thomasfosterau/effect-biz/Audit";
 * import * as Id from "@thomasfosterau/effect-biz/Id";
 * import * as Tenancy from "@thomasfosterau/effect-biz/Tenancy";
 * import * as SqlRepository from "@thomasfosterau/effect-biz-sql/SqlRepository";
 * import * as SqlUnitOfWork from "@thomasfosterau/effect-biz-sql/SqlUnitOfWork";
 * import * as Testing from "@thomasfosterau/effect-biz-sql/testing";
 *
 * const NoteId = Id.make("NoteId");
 * type NoteId = typeof NoteId.Type;
 *
 * interface Note {
 *   readonly id: NoteId;
 *   readonly text: string;
 *   readonly audit: Audit.AuditFields;
 * }
 *
 * const program = Effect.gen(function* () {
 *   const sql = yield* SqlClient.SqlClient;
 *   yield* sql`CREATE TABLE notes (
 *     id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, text TEXT NOT NULL,
 *     version INTEGER NOT NULL, created_at TEXT NOT NULL, created_by TEXT NOT NULL,
 *     updated_at TEXT NOT NULL, updated_by TEXT NOT NULL, archived_at TEXT
 *   )`;
 *   const notes = yield* SqlRepository.make({
 *     table: "notes",
 *     entity: "Note",
 *     id: NoteId,
 *     fields: () => ({ text: Schema.String }),
 *     make: (row) => row,
 *     withAudit: (note: Note, audit: Audit.AuditFields): Note => ({
 *       ...Struct.omit(note, ["audit"]),
 *       audit,
 *     }),
 *     filterable: { text: "text" },
 *     searchable: ["text"],
 *   });
 *   const audit = yield* Audit.created;
 *   yield* notes.insert({ id: yield* Id.generate(NoteId), text: "Call back", audit });
 *   yield* notes.insert({ id: yield* Id.generate(NoteId), text: "Book flights", audit });
 *   const page = yield* notes.find({ search: "CALL", sort: [{ field: "text" }] });
 *   return page.items.map((note) => note.text);
 * });
 *
 * const layer = SqlUnitOfWork.layer().pipe(
 *   Layer.provideMerge(Layer.merge(Testing.layerSqlite, Id.layer)),
 * );
 * const tenant = Tenancy.TenantId.make("0190a6e4-1c2d-7abc-8def-0123456789ab");
 * Effect.runPromise(
 *   program.pipe(
 *     Effect.provide(layer),
 *     Tenancy.withTenant(tenant),
 *     Actor.withActor(Actor.system("example")),
 *   ),
 * ).then(console.log); // ["Call back"]
 * ```
 */
export const make = <A extends Entity<I>, I extends string, F extends Fields>(
  options: Options<A, I, F>,
): Effect.Effect<
  Repository.Port<A, I>,
  never,
  SqlClient.SqlClient | Dialect.Dialect | SqlUnitOfWork.Committer
> =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const dialect = yield* Dialect.current;
    const committer = yield* SqlUnitOfWork.Committer;
    const { entity, table } = options;
    const columns = Column.make(dialect.name);
    const fields = options.fields(columns);
    const Domain = Schema.Struct(fields);
    const Key = Schema.Struct({ id: options.id });
    const AuditRow = auditRow(columns);
    const overrides: Readonly<Partial<Record<string, string>>> = options.columns ?? {};
    const columnOf = (field: string): string =>
      Option.getOrElse(Option.flatMap(R.get(overrides, field), Option.fromNullishOr), () =>
        Str.camelToSnake(field),
      );
    const fieldOf: Readonly<Record<string, string>> = R.fromEntries(
      Arr.map(R.keys(fields), (field) => [columnOf(field), field] as const),
    );
    const kinds: Readonly<Partial<Record<string, Kind>>> = options.filterable ?? {};
    const allowed = Arr.filterMap(R.toEntries(kinds), ([field, given]) =>
      Result.fromOption(
        Option.flatMap(Option.fromNullishOr(given), (kind) =>
          Option.map(R.get(fields, field), (codec): readonly [string, Internal.Filterable] => [
            field,
            { column: columnOf(field), kind, codec },
          ]),
        ),
        () => undefined,
      ),
    );
    const spec: Internal.Spec = {
      sql,
      dialect: dialect.name,
      table,
      filterable: HashMap.fromIterable(
        Arr.append(allowed, ["id", { column: "id", kind: "id", codec: options.id }] as const),
      ),
      searchable: Arr.map(options.searchable ?? [], columnOf),
    };

    /** A stored row as the entity: every column decoded through its codec. */
    const decode = (raw: SqlConnection.Row): Effect.Effect<A> =>
      Effect.map(
        Effect.all(
          [
            Schema.decodeUnknownEffect(Domain)(
              R.mapKeys(raw, (column) => Option.getOrElse(R.get(fieldOf, column), () => column)),
            ),
            Schema.decodeUnknownEffect(Key)(raw),
            Schema.decodeUnknownEffect(AuditRow)(raw),
          ],
          { concurrency: 1 },
        ),
        ([domain, key, stored]) =>
          options.make({
            ...domain,
            id: key.id,
            audit: new Audit.AuditFields({
              createdAt: stored.created_at,
              createdBy: stored.created_by,
              updatedAt: stored.updated_at,
              updatedBy: stored.updated_by,
              version: stored.version,
              archivedAt: stored.archived_at,
            }),
          }),
      ).pipe(Effect.orDie);

    /** The entity as the tenant's row: every column encoded through its codec. */
    const encode = (value: A, tenantId: Tenancy.TenantId): Effect.Effect<SqlConnection.Row> =>
      Effect.map(
        Effect.all(
          [
            Schema.encodeUnknownEffect(Domain)(value),
            Schema.encodeEffect(Key)({ id: value.id }),
            Schema.encodeEffect(AuditRow)({
              version: value.audit.version,
              created_at: value.audit.createdAt,
              created_by: value.audit.createdBy,
              updated_at: value.audit.updatedAt,
              updated_by: value.audit.updatedBy,
              archived_at: value.audit.archivedAt,
            }),
          ],
          { concurrency: 1 },
        ),
        ([domain, key, stored]) => ({
          ...key,
          tenant_id: tenantId,
          ...R.mapKeys(domain, columnOf),
          ...stored,
        }),
      ).pipe(Effect.orDie);

    const rowsOf = (
      statement: Effect.Effect<ReadonlyArray<SqlConnection.Row>, SqlError.SqlError>,
    ): Effect.Effect<ReadonlyArray<A>> =>
      Effect.flatMap(Effect.orDie(statement), (rows) =>
        Effect.forEach(rows, decode, { concurrency: 1 }),
      );

    /** The tenant's stored entity with this id, if any. */
    const load = (tenantId: Tenancy.TenantId, id: I): Effect.Effect<Option.Option<A>> =>
      Schema.is(options.id)(id)
        ? Effect.map(
            rowsOf(sql`SELECT * FROM ${sql(table)} WHERE tenant_id = ${tenantId} AND id = ${id}`),
            Arr.head,
          )
        : Effect.succeedNone;

    const Versions = Schema.Array(Schema.Struct({ version: Audit.Version }));

    /** The conflict of a write from `expected`, with the version the store holds now (0 for none). */
    const conflict = (
      tenantId: Tenancy.TenantId,
      id: I,
      expected: number,
    ): Effect.Effect<BizError.ConcurrencyConflict> =>
      sql`SELECT version FROM ${sql(table)} WHERE tenant_id = ${tenantId} AND id = ${id}`.pipe(
        Effect.flatMap(Schema.decodeUnknownEffect(Versions)),
        Effect.map(
          (rows) =>
            new BizError.ConcurrencyConflict({
              entity,
              id,
              expected,
              actual: Option.match(Arr.head(rows), {
                onNone: () => 0,
                onSome: (row) => row.version,
              }),
            }),
        ),
        Effect.orDie,
      );

    /**
     * Decides a version-guarded write to the entity `id` stored at
     * `version` against a fresh read (`NotFound`, `ConcurrencyConflict`, or
     * `change`'s outcome), then stages the update of its row.
     */
    const write = <E>(
      id: I,
      version: number,
      change: (current: A, stamp: Audit.Stamp) => Result.Result<A, E>,
    ): Effect.Effect<
      A,
      BizError.NotFound | BizError.ConcurrencyConflict | E,
      Repository.WriteContext
    > =>
      Effect.gen(function* () {
        const tenantId = yield* Tenancy.currentTenant;
        const stamp = yield* Audit.stamp;
        const stored = yield* load(tenantId, id);
        if (Option.isNone(stored)) {
          return yield* new BizError.NotFound({ entity, id });
        }
        if (stored.value.audit.version !== version) {
          return yield* new BizError.ConcurrencyConflict({
            entity,
            id,
            expected: version,
            actual: stored.value.audit.version,
          });
        }
        const next = yield* Effect.fromResult(change(stored.value, stamp));
        const row = yield* encode(next, tenantId);
        yield* SqlUnitOfWork.stage(
          committer,
          SqlUnitOfWork.guarded(
            sql`UPDATE ${sql(table)} SET ${sql.update(row, unchanged)}, version = version + 1 WHERE tenant_id = ${tenantId} AND id = ${id} AND version = ${version} RETURNING id`,
            { conflict: conflict(tenantId, id, version) },
          ),
        );
        return next;
      });

    /**
     * The archive or restore change: the entity in the target state, stamped,
     * or `InvalidTransition` when it is in that state already.
     */
    const archiving =
      (transition: Transition) =>
      (current: A, stamp: Audit.Stamp): Result.Result<A, BizError.InvalidTransition> =>
        Audit.isArchived(current) === transition.archived
          ? Result.fail(
              new BizError.InvalidTransition({
                entity,
                id: current.id,
                from: transition.from,
                command: transition.command,
              }),
            )
          : Result.succeed(
              options.withAudit(
                current,
                Audit.next(current.audit, stamp, transition.archivedAt(stamp)),
              ),
            );

    return {
      get: (id) =>
        Effect.flatMap(Tenancy.currentTenant, (tenantId) =>
          Effect.flatMap(load(tenantId, id), (stored) =>
            Effect.fromOption(stored, () => new BizError.NotFound({ entity, id })),
          ),
        ),
      getMany: (ids) =>
        Effect.flatMap(Tenancy.currentTenant, (tenantId) => {
          const wanted = Arr.filter(Arr.dedupe(Arr.fromIterable(ids)), Schema.is(options.id));
          return Arr.isReadonlyArrayNonEmpty(wanted)
            ? Effect.map(
                rowsOf(
                  sql`SELECT * FROM ${sql(table)} WHERE tenant_id = ${tenantId} AND id IN ${sql.in(wanted)}`,
                ),
                (found) =>
                  Arr.getSomes(
                    Arr.map(wanted, (id) => Arr.findFirst(found, (stored) => stored.id === id)),
                  ),
              )
            : Effect.succeed([]);
        }),
      find: (query, request = {}) =>
        Effect.flatMap(Tenancy.currentTenant, (tenantId) =>
          Effect.flatMap(Internal.select(spec, tenantId, query, request), (select) =>
            Effect.map(rowsOf(select.statement), (rows) =>
              Internal.pageOf(query, select.limit, rows),
            ),
          ),
        ),
      insert: (value) =>
        Effect.flatMap(
          Tenancy.currentTenant,
          (tenantId): Effect.Effect<void, BizError.AlreadyExists | BizError.ConcurrencyConflict> =>
            value.audit.version === 1
              ? Effect.flatMap(
                  load(tenantId, value.id),
                  (
                    stored,
                  ): Effect.Effect<void, BizError.AlreadyExists | BizError.ConcurrencyConflict> =>
                    Option.isSome(stored)
                      ? Effect.fail(new BizError.AlreadyExists({ entity, key: value.id }))
                      : Effect.flatMap(encode(value, tenantId), (row) =>
                          SqlUnitOfWork.stage(
                            committer,
                            SqlUnitOfWork.guarded(
                              sql`INSERT INTO ${sql(table)} ${sql.insert(row)} ON CONFLICT (id) DO NOTHING RETURNING id`,
                              { conflict: conflict(tenantId, value.id, 0) },
                            ),
                          ),
                        ),
                )
              : Effect.fail(
                  new BizError.ConcurrencyConflict({
                    entity,
                    id: value.id,
                    expected: 1,
                    actual: value.audit.version,
                  }),
                ),
        ),
      update: (value) =>
        write(value.id, value.audit.version, (current, stamp) =>
          Result.succeed(options.withAudit(value, Audit.next(current.audit, stamp))),
        ),
      archive: (id, version) => write(id, version, archiving(transitions.archive)),
      restore: (id, version) => write(id, version, archiving(transitions.restore)),
    };
  });
