/**
 * Core's `Query` and `Page.Request` as one SQL `SELECT`: the `WHERE` of the
 * tenant, the archived flag, the filters on the allow-listed columns, the
 * search and the keyset position, and the `ORDER BY` of the sort keys then
 * the id, fetching one row more than the page to know whether another
 * follows. It agrees with `Query.run`, core's pure interpreter, and reads
 * and writes the same cursors.
 *
 * @internal
 */

import type * as Audit from "@thomasfosterau/effect-biz/Audit";
import * as BizError from "@thomasfosterau/effect-biz/BizError";
import * as Page from "@thomasfosterau/effect-biz/Page";
import * as Query from "@thomasfosterau/effect-biz/Query";
import type * as Tenancy from "@thomasfosterau/effect-biz/Tenancy";
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as HashMap from "effect/HashMap";
import * as Option from "effect/Option";
import * as P from "effect/Predicate";
import * as R from "effect/Record";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import type * as SqlClient from "effect/sql/SqlClient";
import type * as SqlConnection from "effect/sql/SqlConnection";
import type * as Statement from "effect/sql/Statement";
import type * as Dialect from "../Dialect.js";

/**
 * How a column compares and sorts: `text` (code-point order, `COLLATE "C"`
 * on Postgres), `id` (a UUID, never collated), `number`, `boolean`,
 * `timestamp` (`timestamptz`, or ISO-8601 text, which sorts in time order)
 * or `decimal` (`numeric`, or canonical text compared as `REAL` on SQLite
 * and D1).
 */
export type Kind = "text" | "id" | "number" | "boolean" | "timestamp" | "decimal";

/** A column codec with no services: what a repository's fields are built from. */
export type Codec = Schema.Top & {
  readonly DecodingServices: never;
  readonly EncodingServices: never;
};

/** An allow-listed field: its column, how it compares, and the codec its values are bound through. */
export interface Filterable {
  readonly column: string;
  readonly kind: Kind;
  readonly codec: Codec;
}

/** What the translation needs to know about the table. */
export interface Spec {
  readonly sql: SqlClient.SqlClient;
  readonly dialect: Dialect.Name;
  readonly table: string;
  /** The allow-listed fields, by field name (the id included). */
  readonly filterable: HashMap.HashMap<string, Filterable>;
  /** The columns `search` matches. */
  readonly searchable: ReadonlyArray<string>;
}

/** The statement of one page, and the page size it fetches one row beyond. */
export interface Select {
  readonly statement: Statement.Statement<SqlConnection.Row>;
  readonly limit: number;
}

/** A value a driver binds for a filter: what a scalar column codec encodes to. */
const Bound = Schema.Union([Schema.String, Schema.Finite, Schema.Boolean, Schema.Date]);

/** A value a driver binds for a filter. */
type Bound = typeof Bound.Type;

type Fragment = Statement.Fragment;
type Path = ReadonlyArray<string | number>;

const issue = (path: Path, message: string): BizError.ValidationError =>
  new BizError.ValidationError({ issues: [new BizError.Issue({ path, message })] });

const invalidCursor = (): BizError.ValidationError =>
  issue(["cursor"], "Not a cursor for this query");

const always = (spec: Spec): Fragment => spec.sql.literal("1 = 1");
const never = (spec: Spec): Fragment => spec.sql.literal("1 = 0");

/** The allow-listed field, or a `ValidationError` at `path`. */
const filterableOf = (
  spec: Spec,
  field: string,
  path: Path,
): Effect.Effect<Filterable, BizError.ValidationError> =>
  Effect.fromOption(HashMap.get(spec.filterable, field), () =>
    issue(path, "Not a filterable field of this repository"),
  );

/** A value as its field's column stores it, or the `ValidationError` of `orElse`. */
const encode = (
  filterable: Filterable,
  value: Page.Key,
  orElse: () => BizError.ValidationError,
): Effect.Effect<Bound, BizError.ValidationError> =>
  Effect.mapError(
    Effect.flatMap(
      Schema.encodeUnknownEffect(filterable.codec)(value),
      Schema.decodeUnknownEffect(Bound),
    ),
    orElse,
  );

/** Whether the dialect compares the column's decimal text as a number (SQLite and D1). */
const castsDecimal = (spec: Spec, filterable: Filterable): boolean =>
  filterable.kind === "decimal" && spec.dialect !== "postgres";

/** The column as it orders: by code point on Postgres, a decimal as `REAL` on SQLite and D1. */
const ordered = (spec: Spec, filterable: Filterable): Fragment => {
  const { sql } = spec;
  if (filterable.kind === "text" && spec.dialect === "postgres") {
    return sql`${sql(filterable.column)} COLLATE "C"`;
  }
  return castsDecimal(spec, filterable)
    ? sql`CAST(${sql(filterable.column)} AS REAL)`
    : sql`${sql(filterable.column)}`;
};

/** A bound value as it orders against {@link ordered}. */
const orderedValue = (spec: Spec, filterable: Filterable, value: Bound): Fragment =>
  castsDecimal(spec, filterable) ? spec.sql`CAST(${value} AS REAL)` : spec.sql`${value}`;

/** Every present `[field, condition]` of a per-field condition (an `undefined` one imposes nothing). */
const conditions = <C>(
  record: Readonly<Partial<Record<string, C>>>,
): ReadonlyArray<readonly [string, C]> =>
  Arr.filterMap(R.toEntries(record), ([field, condition]) =>
    P.isUndefined(condition)
      ? Result.failVoid
      : Result.succeed<readonly [string, C]>([field, condition]),
  );

const notAValue = (path: Path) => () => issue(path, "Not a value of this field");

const eqClause = (spec: Spec, field: string, value: Query.Value) =>
  Effect.flatMap(filterableOf(spec, field, ["eq", field]), (filterable) =>
    Effect.map(
      encode(filterable, value, notAValue(["eq", field])),
      (encoded): Fragment => spec.sql`${spec.sql(filterable.column)} = ${encoded}`,
    ),
  );

const inClause = (spec: Spec, field: string, values: ReadonlyArray<Query.Value>) =>
  Effect.flatMap(filterableOf(spec, field, ["in", field]), (filterable) =>
    Arr.isReadonlyArrayNonEmpty(values)
      ? Effect.map(
          Effect.forEach(values, (value) => encode(filterable, value, notAValue(["in", field])), {
            concurrency: 1,
          }),
          (encoded): Fragment =>
            spec.sql`${spec.sql(filterable.column)} IN ${spec.sql.in(encoded)}`,
        )
      : Effect.succeed(never(spec)),
  );

/** The range bounds, with their operators. */
const bounds = [
  ["gt", ">"],
  ["gte", ">="],
  ["lt", "<"],
  ["lte", "<="],
] as const;

const rangeClauses = (spec: Spec, field: string, range: Query.Range<Query.Value>) =>
  Effect.flatMap(filterableOf(spec, field, ["range", field]), (filterable) =>
    Effect.forEach(
      Arr.filterMap(bounds, ([name, operator]) =>
        Result.fromOption(
          Option.map(
            Option.fromNullishOr(range[name]),
            (value) => [name, operator, value] as const,
          ),
          () => undefined,
        ),
      ),
      ([name, operator, value]) =>
        Effect.map(
          encode(filterable, value, notAValue(["range", field, name])),
          (encoded): Fragment =>
            spec.sql`${ordered(spec, filterable)} ${spec.sql.literal(operator)} ${orderedValue(spec, filterable, encoded)}`,
        ),
      { concurrency: 1 },
    ),
  );

/** `LIKE`'s wildcards and its escape character, escaped, so the search is a plain substring. */
const escapeLike = (text: string): string => text.replace(/[\\%_]/g, (match) => `\\${match}`);

/**
 * The search as a case-insensitive substring of any searchable column:
 * `ILIKE` on Postgres, `lower(…) LIKE` on SQLite and D1. An empty search
 * matches every row, and a non-empty one over no searchable column none, as
 * in `Query.run`.
 */
const searchClause = (spec: Spec, search: string): Option.Option<Fragment> => {
  const needle = search.trim().toLowerCase();
  if (needle === "") {
    return Option.none();
  }
  const { sql } = spec;
  const pattern = `%${escapeLike(needle)}%`;
  return Option.some(
    Arr.isReadonlyArrayNonEmpty(spec.searchable)
      ? sql.or(
          Arr.map(spec.searchable, (column) =>
            spec.dialect === "postgres"
              ? sql`${sql(column)} ILIKE ${pattern} ESCAPE '\\'`
              : sql`lower(${sql(column)}) LIKE ${pattern} ESCAPE '\\'`,
          ),
        )
      : never(spec),
  );
};

const archivedClause = (spec: Spec, archived: Query.Archived): Option.Option<Fragment> => {
  if (archived === "include") {
    return Option.none();
  }
  return Option.some(
    archived === "only" ? spec.sql`archived_at IS NOT NULL` : spec.sql`archived_at IS NULL`,
  );
};

/** One sort key of the query, resolved to its column. */
interface SortKey {
  readonly filterable: Filterable;
  readonly descending: boolean;
}

const sortKeys = <A>(spec: Spec, query: Query.Query<A>) =>
  Effect.forEach(
    query.sort ?? [],
    (sort, index): Effect.Effect<SortKey, BizError.ValidationError> =>
      Effect.map(filterableOf(spec, sort.field, ["sort", index, "field"]), (filterable) => ({
        filterable,
        descending: sort.direction === "desc",
      })),
    { concurrency: 1 },
  );

/** The id column, the final tie-breaker of every order. */
const idColumn = (spec: Spec): Fragment => spec.sql`${spec.sql("id")}`;

/**
 * The rows strictly after a position in the query's order, as the expanded
 * `OR` of keyset comparisons (`k1 > ? OR (k1 = ? AND k2 < ?) OR … OR (… AND
 * id > ?)`), which holds for mixed directions on every dialect. A missing
 * key (`None`, which sorts first) is before every value: everything is after
 * it ascending and nothing descending, and nothing equals it.
 */
const afterClause = (
  spec: Spec,
  keys: ReadonlyArray<SortKey>,
  position: Page.Position,
): Effect.Effect<Fragment, BizError.ValidationError> =>
  Effect.gen(function* () {
    const { sql } = spec;
    if (position.keys.length !== keys.length) {
      return yield* invalidCursor();
    }
    const comparisons = yield* Effect.forEach(
      keys,
      (key, index) =>
        Option.match(Option.flatten(Arr.get(position.keys, index)), {
          onNone: () =>
            Effect.succeed({
              after: key.descending ? never(spec) : always(spec),
              equal: never(spec),
            }),
          onSome: (value) =>
            Effect.map(encode(key.filterable, value, invalidCursor), (encoded) => {
              const column = ordered(spec, key.filterable);
              const bound = orderedValue(spec, key.filterable, encoded);
              return {
                after: key.descending ? sql`${column} < ${bound}` : sql`${column} > ${bound}`,
                equal: sql`${column} = ${bound}`,
              };
            }),
        }),
      { concurrency: 1 },
    );
    const id = yield* filterableOf(spec, "id", ["cursor"]);
    const lastId = yield* encode(id, position.id, invalidCursor);
    const terms = Arr.append(
      Arr.map(comparisons, (comparison) => comparison.after),
      sql`${idColumn(spec)} > ${lastId}`,
    );
    return sql.or(
      Arr.map(terms, (term, index) =>
        sql.and(
          Arr.append(
            Arr.map(Arr.take(comparisons, index), (comparison) => comparison.equal),
            term,
          ),
        ),
      ),
    );
  });

/** The position a request continues after, decoded against the query's sort. */
const positionOf = <A>(
  query: Query.Query<A>,
  request: Page.Request,
): Effect.Effect<Option.Option<Page.Position>, BizError.ValidationError> =>
  request.cursor === undefined
    ? Effect.succeedNone
    : Effect.asSome(Effect.fromResult(Page.decodeCursor(request.cursor, Query.sortKey(query))));

/**
 * One page's `SELECT` of the tenant's rows matching the query: a field off
 * the allow-list, a malformed value, a bad cursor or limit is a
 * `ValidationError`.
 */
export const select = <A>(
  spec: Spec,
  tenantId: Tenancy.TenantId,
  query: Query.Query<A>,
  request: Page.Request,
): Effect.Effect<Select, BizError.ValidationError> =>
  Effect.gen(function* () {
    const { sql } = spec;
    const limit = yield* Effect.fromResult(Page.limitOf(request));
    const position = yield* positionOf(query, request);
    const keys = yield* sortKeys(spec, query);
    const eq = yield* Effect.forEach(
      conditions<Query.Value>(query.eq ?? {}),
      ([field, value]) => eqClause(spec, field, value),
      { concurrency: 1 },
    );
    const inList = yield* Effect.forEach(
      conditions<ReadonlyArray<Query.Value>>(query.in ?? {}),
      ([field, values]) => inClause(spec, field, values),
      { concurrency: 1 },
    );
    const ranges = yield* Effect.forEach(
      conditions<Query.Range<Query.Value>>(query.range ?? {}),
      ([field, range]) => rangeClauses(spec, field, range),
      { concurrency: 1 },
    );
    const after = yield* Effect.forEach(
      Option.toArray(position),
      (at) => afterClause(spec, keys, at),
      { concurrency: 1 },
    );
    const where: ReadonlyArray<Fragment> = Arr.flatten([
      [sql`tenant_id = ${tenantId}`],
      Option.toArray(archivedClause(spec, query.archived ?? "exclude")),
      eq,
      inList,
      Arr.flatten(ranges),
      Option.toArray(searchClause(spec, query.search ?? "")),
      after,
    ]);
    const orderBy: ReadonlyArray<Fragment> = Arr.append(
      Arr.map(keys, (key): Fragment =>
        key.descending
          ? sql`${ordered(spec, key.filterable)} DESC`
          : sql`${ordered(spec, key.filterable)} ASC`,
      ),
      sql`${idColumn(spec)} ASC`,
    );
    return {
      statement: sql`SELECT * FROM ${sql(spec.table)} WHERE ${sql.and(where)} ORDER BY ${sql.csv(orderBy)} LIMIT ${limit + 1}`,
      limit,
    };
  });

/** A field's value on an entity, when it is a key a query sorts by (as `Query.run` reads it). */
const keyOf = (entity: Audit.Audited, field: string): Option.Option<Page.Key> =>
  Option.filter(
    Option.flatMap(Option.liftPredicate(entity, P.hasProperty(field)), (owner) =>
      Option.some(owner[field]),
    ),
    Page.isKey,
  );

/**
 * The page of a select's decoded rows: at most `limit` items, and the
 * cursor after the last while a further row was fetched, encoded as
 * `Query.run` encodes it, so the two implementations' cursors are
 * interchangeable.
 */
export const pageOf = <A extends Audit.Audited>(
  query: Query.Query<A>,
  limit: number,
  rows: ReadonlyArray<A>,
): Page.Page<A> => {
  const items = Arr.take(rows, limit);
  const nextCursor =
    rows.length > limit
      ? Option.map(Arr.last(items), (last) =>
          Page.encodeCursor({
            sort: Query.sortKey(query),
            keys: Arr.map(query.sort ?? [], (sort) => keyOf(last, sort.field)),
            id: last.id,
          }),
        )
      : Option.none();
  return { items, nextCursor };
};
