/**
 * Cursor paging for repository queries: a {@link Page} of items and the
 * opaque {@link Cursor} that continues it.
 *
 * Paging is keyset paging over a stable order: the query's sort keys, then
 * the entity id (UUIDv7, so creation order). A cursor encodes the position
 * of the last item of a page (its sort-key values and id, with the sort they
 * belong to), so the next page starts strictly after it: a row inserted
 * between two pages never duplicates or hides a row that was there when the
 * first page was read. A cursor is opaque to the caller; a malformed one, or
 * one made for another sort, fails with `BizError.ValidationError`.
 *
 * `limit` defaults to {@link defaultLimit} (50) and is capped at
 * {@link maxLimit} (500); one below 1 or not an integer is a
 * `ValidationError`.
 *
 * This is the ERP's paging; `./Payments.Page` is the payments providers' own
 * shape and is separate. See {@link encodeCursor} for an example.
 *
 * @module
 */

import * as Arr from "effect/Array";
import * as BigDecimal from "effect/BigDecimal";
import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";
import * as P from "effect/Predicate";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as BizError from "./BizError.js";
import * as Decimal from "./Decimal.js";

/** An opaque position in a query's results: pass a page's `nextCursor` back for the next page. */
export const Cursor = Schema.String.pipe(Schema.brand("Cursor"));

/** An opaque page cursor. */
export type Cursor = typeof Cursor.Type;

/** One page of a query's results, and the cursor of the next page while there is one. */
export interface Page<A> {
  /** The page's items, in the query's order. */
  readonly items: ReadonlyArray<A>;
  /** The cursor that continues after the last item; `None` on the last page. */
  readonly nextCursor: Option.Option<Cursor>;
}

/** Which page to read: how many items, and from which cursor (the first page without one). */
export interface Request {
  /** The page size: {@link defaultLimit} when omitted, at most {@link maxLimit}. */
  readonly limit?: number;
  /** The `nextCursor` of the previous page. */
  readonly cursor?: Cursor;
}

/** The page size when a request names none. */
export const defaultLimit = 50;

/** The largest page size; a larger `limit` is capped to it. */
export const maxLimit = 500;

/** A value a query sorts and compares by: a string, number, boolean, UTC date-time or decimal. */
export type Key = string | number | boolean | DateTime.Utc | BigDecimal.BigDecimal;

/** Whether a value is a {@link Key}. */
export const isKey = (value: unknown): value is Key =>
  P.isString(value) ||
  P.isNumber(value) ||
  P.isBoolean(value) ||
  (DateTime.isDateTime(value) && DateTime.isUtc(value)) ||
  BigDecimal.isBigDecimal(value);

/**
 * Where a page ended: the sort it was read in (`sort`, a fingerprint such as
 * `"name:asc"`), the last item's sort-key values in that order, and its id.
 */
export interface Position {
  /** The fingerprint of the sort the position belongs to. */
  readonly sort: string;
  /** The last item's value for each sort key; `None` where it had none. */
  readonly keys: ReadonlyArray<Option.Option<Key>>;
  /** The last item's id, the final tie-breaker. */
  readonly id: string;
}

/** A key on the wire: tagged by kind, since a date-time and a decimal both encode as strings. */
const TaggedKey = Schema.Union([
  Schema.Tuple([Schema.Literal("s"), Schema.String]),
  Schema.Tuple([Schema.Literal("n"), Schema.Finite]),
  Schema.Tuple([Schema.Literal("b"), Schema.Boolean]),
  Schema.Tuple([Schema.Literal("t"), Schema.DateTimeUtcFromString]),
  Schema.Tuple([Schema.Literal("d"), Decimal.Decimal]),
]);

type TaggedKey = typeof TaggedKey.Type;

const Payload = Schema.Struct({
  sort: Schema.String,
  keys: Schema.Array(Schema.OptionFromNullOr(TaggedKey)),
  id: Schema.String,
});

/** A position as a base64url-encoded JSON payload. */
const CursorPayload = Schema.StringFromBase64Url.pipe(
  Schema.decodeTo(Schema.fromJsonString(Payload)),
);

const encodePayload = Schema.encodeSync(CursorPayload);
const decodePayload = Schema.decodeUnknownResult(CursorPayload);

const tag = (key: Key): TaggedKey => {
  if (P.isString(key)) {
    return ["s", key];
  }
  if (P.isNumber(key)) {
    return ["n", key];
  }
  if (P.isBoolean(key)) {
    return ["b", key];
  }
  return DateTime.isDateTime(key) ? ["t", key] : ["d", key];
};

const untag = (tagged: TaggedKey): Key => tagged[1];

/** The {@link ValidationError} for a cursor that is malformed or belongs to another query. */
const invalidCursor = (): BizError.ValidationError =>
  new BizError.ValidationError({
    issues: [new BizError.Issue({ path: ["cursor"], message: "Not a cursor for this query" })],
  });

/**
 * Encodes a position as an opaque cursor (base64url of a JSON payload).
 *
 * @example
 * ```ts
 * import { Option, Result } from "effect";
 * import * as Page from "@thomasfosterau/effect-biz/Page";
 *
 * const cursor = Page.encodeCursor({
 *   sort: "name:asc",
 *   keys: [Option.some("Acme")],
 *   id: "00000000-0000-7000-8000-000000000001",
 * });
 *
 * const position = Page.decodeCursor(cursor, "name:asc");
 * console.log(Result.isSuccess(position)); // true
 * console.log(Result.isFailure(Page.decodeCursor(cursor, "code:asc"))); // true: another sort
 * ```
 */
export const encodeCursor = (position: Position): Cursor =>
  Cursor.make(
    encodePayload({
      sort: position.sort,
      keys: Arr.map(position.keys, Option.map(tag)),
      id: position.id,
    }),
  );

/**
 * Decodes a cursor made by {@link encodeCursor} for the sort `sort`; a
 * malformed cursor, or one for another sort, is a `ValidationError`.
 */
export const decodeCursor = (
  cursor: string,
  sort: string,
): Result.Result<Position, BizError.ValidationError> =>
  Result.match(decodePayload(cursor), {
    onFailure: () => Result.fail(invalidCursor()),
    onSuccess: (payload) =>
      payload.sort === sort
        ? Result.succeed({
            sort: payload.sort,
            keys: Arr.map(payload.keys, Option.map(untag)),
            id: payload.id,
          })
        : Result.fail(invalidCursor()),
  });

/**
 * The page size a request asks for: {@link defaultLimit} when it names none,
 * capped at {@link maxLimit}; below 1 or not an integer is a
 * `ValidationError`.
 */
export const limitOf = (request: Request): Result.Result<number, BizError.ValidationError> => {
  const limit = request.limit ?? defaultLimit;
  return Number.isInteger(limit) && limit >= 1
    ? Result.succeed(Math.min(limit, maxLimit))
    : Result.fail(
        new BizError.ValidationError({
          issues: [
            new BizError.Issue({ path: ["limit"], message: "Expected an integer of at least 1" }),
          ],
        }),
      );
};
