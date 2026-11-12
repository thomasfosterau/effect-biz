/**
 * A small, typed filter and sort spec over an entity's fields, and its pure
 * interpreter.
 *
 * A {@link Query} names fields of the entity it filters: `eq` and `in` on
 * any scalar field (a string, number, boolean, `DateTime.Utc` or
 * `BigDecimal`), `range` (`gt` / `gte` / `lt` / `lte`) on an ordered one, a
 * text `search` hint, the `archived` flag (`"exclude"` by default,
 * `"include"` or `"only"`) and a `sort`. Every repository layer interprets
 * the same spec: the in-memory one with {@link run}, a SQL one as a `WHERE` /
 * `ORDER BY` (where `search` may use full-text search instead of
 * {@link run}'s case-insensitive substring match over the repository's
 * searchable fields).
 *
 * Results are ordered by the sort keys, then by id, so the order is total
 * and stable, and {@link run} pages it with `./Page`'s cursors.
 *
 * See {@link run} for an example.
 *
 * @module
 */

import * as Arr from "effect/Array";
import * as BigDecimal from "effect/BigDecimal";
import * as Bool from "effect/Boolean";
import * as DateTime from "effect/DateTime";
import * as Eq from "effect/Equal";
import * as Option from "effect/Option";
import * as Order from "effect/Order";
import * as P from "effect/Predicate";
import * as R from "effect/Record";
import * as Result from "effect/Result";
import * as Str from "effect/String";
import * as Audit from "./Audit.js";
import type * as BizError from "./BizError.js";
import * as Page from "./Page.js";

/** A value a query compares by: one of `./Page`'s keys. */
export type Value = Page.Key;

/** A value a range or sort orders by: a {@link Value} other than a boolean. */
export type Ordered = Exclude<Value, boolean>;

/** The names of `A`'s fields whose values are `V`s. */
export type FieldsOf<A, V> = {
  readonly [K in keyof A]-?: A[K] extends V ? K : never;
}[keyof A] &
  string;

/** Bounds on an ordered field; every bound given must hold. */
export interface Range<V> {
  /** Greater than. */
  readonly gt?: V;
  /** Greater than or equal to. */
  readonly gte?: V;
  /** Less than. */
  readonly lt?: V;
  /** Less than or equal to. */
  readonly lte?: V;
}

/** Which archived entities a query sees: none (the default), all, or only them. */
export type Archived = "exclude" | "include" | "only";

/** The direction of a sort key. */
export type Direction = "asc" | "desc";

/** One sort key: an ordered field and its direction (`"asc"` by default). */
export interface Sort<A> {
  /** The field to sort by. */
  readonly field: FieldsOf<A, Ordered>;
  /** Ascending (the default) or descending. */
  readonly direction?: Direction;
}

/** A filter and sort over the fields of `A`; every condition given must hold. */
export interface Query<A> {
  /** Fields that must equal the value given. */
  readonly eq?: { readonly [K in FieldsOf<A, Value>]?: A[K] & Value };
  /** Fields that must equal one of the values given. */
  readonly in?: { readonly [K in FieldsOf<A, Value>]?: ReadonlyArray<A[K] & Value> };
  /** Fields that must lie within the bounds given. */
  readonly range?: { readonly [K in FieldsOf<A, Ordered>]?: Range<A[K] & Ordered> };
  /** A text search hint over the repository's searchable fields. */
  readonly search?: string;
  /** Which archived entities to see: `"exclude"` by default. */
  readonly archived?: Archived;
  /** The sort keys, before the id that breaks every tie. */
  readonly sort?: ReadonlyArray<Sort<A>>;
}

/** What a repository tells the interpreter about its entity. */
export interface Options<A> {
  /** The string fields `search` matches against; none by default. */
  readonly searchable?: ReadonlyArray<FieldsOf<A, string>>;
}

/** A field's value, when it is a {@link Value}. */
const fieldValue = (entity: Audit.Audited, field: string): Option.Option<Value> => {
  if (!P.hasProperty(entity, field)) {
    return Option.none();
  }
  const value = entity[field];
  return Page.isKey(value) ? Option.some(value) : Option.none();
};

/** The kinds of value, in the order values of different kinds sort in. */
const kinds: ReadonlyArray<(value: Value) => boolean> = [
  P.isString,
  P.isNumber,
  P.isBoolean,
  DateTime.isDateTime,
  BigDecimal.isBigDecimal,
];

/** The rank of a value's kind, so values of different kinds still order totally. */
const kindOf = (value: Value): number =>
  Option.getOrElse(
    Arr.findFirstIndex(kinds, (is) => is(value)),
    () => kinds.length,
  );

/** The total order of values: by kind, then within the kind. */
const compareValues: Order.Order<Value> = (left, right) => {
  if (P.isString(left) && P.isString(right)) {
    return Order.String(left, right);
  }
  if (P.isNumber(left) && P.isNumber(right)) {
    return Order.Number(left, right);
  }
  if (P.isBoolean(left) && P.isBoolean(right)) {
    return Bool.Order(left, right);
  }
  if (DateTime.isDateTime(left) && DateTime.isDateTime(right)) {
    return DateTime.Order(left, right);
  }
  if (BigDecimal.isBigDecimal(left) && BigDecimal.isBigDecimal(right)) {
    return BigDecimal.Order(left, right);
  }
  return Order.Number(kindOf(left), kindOf(right));
};

/** Missing values first, then by value. */
const compareKeys = Option.makeOrder(compareValues);

const matchesEq = (entity: Audit.Audited, field: string, expected: Value): boolean =>
  Option.exists(fieldValue(entity, field), (value) => Eq.equals(value, expected));

const matchesIn = (entity: Audit.Audited, field: string, allowed: ReadonlyArray<Value>): boolean =>
  Arr.some(allowed, (expected) => matchesEq(entity, field, expected));

/** Whether a value satisfies a bound, when the bound is given. */
const bound = (limit: Value | undefined, value: Value, holds: (order: number) => boolean) =>
  limit === undefined || holds(compareValues(value, limit));

const matchesRange = (entity: Audit.Audited, field: string, range: Range<Value>): boolean =>
  Option.exists(
    fieldValue(entity, field),
    (value) =>
      bound(range.gt, value, (order) => order > 0) &&
      bound(range.gte, value, (order) => order >= 0) &&
      bound(range.lt, value, (order) => order < 0) &&
      bound(range.lte, value, (order) => order <= 0),
  );

/** Whether an entity with the given archive state passes each `archived` flag. */
const archivedFilter: R.ReadonlyRecord<Archived, (archived: boolean) => boolean> = {
  exclude: (archived) => !archived,
  include: () => true,
  only: (archived) => archived,
};

const matchesSearch = (
  entity: Audit.Audited,
  search: string | undefined,
  fields: ReadonlyArray<string>,
): boolean => {
  const needle = (search ?? "").trim().toLowerCase();
  return (
    Str.isEmpty(needle) ||
    Arr.some(fields, (field) =>
      Option.exists(
        fieldValue(entity, field),
        (value) => P.isString(value) && value.toLowerCase().includes(needle),
      ),
    )
  );
};

/** Whether every `[field, condition]` entry of a per-field condition holds. */
const every = <C>(
  record: R.ReadonlyRecord<string, C | undefined> | undefined,
  holds: (field: string, condition: C) => boolean,
): boolean =>
  Arr.every(
    R.toEntries(record ?? {}),
    ([field, condition]) => condition === undefined || holds(field, condition),
  );

/** Whether an entity satisfies every condition of a query. */
export const matches =
  <A extends Audit.Audited>(query: Query<A>, options: Options<A> = {}) =>
  (entity: A): boolean =>
    archivedFilter[query.archived ?? "exclude"](Audit.isArchived(entity)) &&
    every<Value>(query.eq, (field, value) => matchesEq(entity, field, value)) &&
    every<ReadonlyArray<Value>>(query.in, (field, values) => matchesIn(entity, field, values)) &&
    every<Range<Value>>(query.range, (field, range) => matchesRange(entity, field, range)) &&
    matchesSearch(entity, query.search, options.searchable ?? []);

/** The fingerprint of a query's sort, which its cursors carry: `"name:asc,createdOn:desc"`. */
export const sortKey = <A>(query: Query<A>): string =>
  Arr.map(query.sort ?? [], (sort) => `${sort.field}:${sort.direction ?? "asc"}`).join(",");

/** An entity's position in a query's order: its sort-key values and id. */
const positionOf = <A extends Audit.Audited>(query: Query<A>, entity: A): Page.Position => ({
  sort: sortKey(query),
  keys: Arr.map(query.sort ?? [], (sort) => fieldValue(entity, sort.field)),
  id: entity.id,
});

/** Compares two positions in a query's order: each sort key in its direction, then the id. */
const comparePositions = <A>(query: Query<A>): Order.Order<Page.Position> =>
  Order.combineAll([
    ...Arr.map(query.sort ?? [], (sort, index) => {
      const byKey = Order.mapInput(compareKeys, (position: Page.Position) =>
        Option.flatten(Arr.get(position.keys, index)),
      );
      return sort.direction === "desc" ? Order.flip(byKey) : byKey;
    }),
    Order.mapInput(Order.String, (position: Page.Position) => position.id),
  ]);

/** The order a query sorts entities in: its sort keys, then the id. */
export const order = <A extends Audit.Audited>(query: Query<A>): Order.Order<A> =>
  Order.mapInput(comparePositions(query), (entity: A) => positionOf(query, entity));

/** Every entity of `rows` that matches the query, in its order, unpaged. */
export const select = <A extends Audit.Audited>(
  rows: Iterable<A>,
  query: Query<A>,
  options: Options<A> = {},
): ReadonlyArray<A> =>
  Arr.sort(Arr.filter(Arr.fromIterable(rows), matches(query, options)), order(query));

/**
 * Runs a query over a tenant's rows: filters, sorts and returns the page the
 * request asks for. Pure, so an in-memory repository runs it inside its
 * read; a malformed cursor or limit is a `ValidationError`.
 *
 * @example
 * ```ts
 * import { DateTime, Option, Result } from "effect";
 * import * as Audit from "@thomasfosterau/effect-biz/Audit";
 * import * as Query from "@thomasfosterau/effect-biz/Query";
 *
 * const audit = new Audit.AuditFields({
 *   createdAt: DateTime.makeUnsafe(0),
 *   createdBy: "importer",
 *   updatedAt: DateTime.makeUnsafe(0),
 *   updatedBy: "importer",
 *   version: 1,
 *   archivedAt: Option.none(),
 * });
 * const rows = [
 *   { id: "00000000-0000-7000-8000-000000000001", name: "Bolt", audit },
 *   { id: "00000000-0000-7000-8000-000000000002", name: "Anchor", audit },
 *   { id: "00000000-0000-7000-8000-000000000003", name: "Cable", audit },
 * ];
 *
 * const page = Query.run(rows, { sort: [{ field: "name" }] }, { limit: 2 });
 * if (Result.isSuccess(page)) {
 *   console.log(page.success.items.map((row) => row.name)); // ["Anchor", "Bolt"]
 *   console.log(Option.isSome(page.success.nextCursor)); // true
 * }
 * ```
 */
export const run = <A extends Audit.Audited>(
  rows: Iterable<A>,
  query: Query<A>,
  request: Page.Request = {},
  options: Options<A> = {},
): Result.Result<Page.Page<A>, BizError.ValidationError> =>
  Result.flatMap(Page.limitOf(request), (limit) =>
    Result.map(afterOf(query, request), (after) => {
      const sorted = select(rows, query, options);
      const compare = comparePositions(query);
      const remaining = Option.match(after, {
        onNone: () => sorted,
        onSome: (position) =>
          Arr.filter(sorted, (entity) => compare(positionOf(query, entity), position) > 0),
      });
      const items = Arr.take(remaining, limit);
      const nextCursor =
        remaining.length > limit
          ? Option.map(Arr.last(items), (last) => Page.encodeCursor(positionOf(query, last)))
          : Option.none();
      return { items, nextCursor };
    }),
  );

/** The position a request continues after, decoded against the query's sort. */
const afterOf = <A>(
  query: Query<A>,
  request: Page.Request,
): Result.Result<Option.Option<Page.Position>, BizError.ValidationError> =>
  request.cursor === undefined
    ? Result.succeed(Option.none())
    : Result.map(Page.decodeCursor(request.cursor, sortKey(query)), Option.some);
