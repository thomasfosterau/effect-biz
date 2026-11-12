import { describe, expect } from "vite-plus/test";
import { it } from "@effect/vitest";
import * as Arr from "effect/Array";
import * as BigDecimal from "effect/BigDecimal";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as Struct from "effect/Struct";
import * as Audit from "../src/Audit.ts";
import * as BizError from "../src/BizError.ts";
import * as Page from "../src/Page.ts";
import * as Query from "../src/Query.ts";
import { Widget, audit, widget, withAudit } from "./fixtures.ts";

const rows: ReadonlyArray<Widget> = [
  widget(1, { name: "Anchor bolt", weight: 3, active: false }),
  widget(2, { name: "Cable tie", weight: 1 }),
  widget(3, { name: "Bracket", weight: 3 }),
  widget(4, { name: "Anchor plate", weight: 2 }),
  withAudit(
    widget(5, { name: "Archived anchor", weight: 5 }),
    new Audit.AuditFields({
      ...Struct.omit(audit, ["archivedAt"]),
      archivedAt: Option.some(DateTime.makeUnsafe(10)),
    }),
  ),
];

const options: Query.Options<Widget> = { searchable: ["name", "sku"] };

const run = (query: Query.Query<Widget>, request: Page.Request = {}) =>
  Effect.fromResult(Query.run(rows, query, request, options));

const namesOf = (query: Query.Query<Widget>, request: Page.Request = {}) =>
  Effect.map(run(query, request), (page) => Arr.map(page.items, (row) => row.name));

/** Every page of a query from `cursor` on, following the cursors. */
const pagesFrom = (
  query: Query.Query<Widget>,
  limit: number,
  cursor: Option.Option<Page.Cursor>,
): Effect.Effect<ReadonlyArray<string>, BizError.ValidationError> =>
  Effect.flatMap(
    run(
      query,
      Option.match(cursor, { onNone: () => ({ limit }), onSome: (c) => ({ limit, cursor: c }) }),
    ),
    (page) =>
      Option.match(page.nextCursor, {
        onNone: () => Effect.succeed(Arr.map(page.items, (row) => row.name)),
        onSome: (next) =>
          Effect.map(pagesFrom(query, limit, Option.some(next)), (rest) =>
            Arr.appendAll(
              Arr.map(page.items, (row) => row.name),
              rest,
            ),
          ),
      }),
  );

describe("Query.run", () => {
  it.effect("excludes archived rows by default, and includes or isolates them on request", () =>
    Effect.gen(function* () {
      expect(yield* namesOf({})).toHaveLength(4);
      expect(yield* namesOf({ archived: "include" })).toHaveLength(5);
      expect(yield* namesOf({ archived: "only" })).toEqual(["Archived anchor"]);
    }),
  );

  it.effect("filters by equality, membership and ranges", () =>
    Effect.gen(function* () {
      expect(yield* namesOf({ eq: { weight: 3 } })).toEqual(["Anchor bolt", "Bracket"]);
      expect(yield* namesOf({ eq: { active: false } })).toEqual(["Anchor bolt"]);
      expect(yield* namesOf({ in: { weight: [1, 2] } })).toEqual(["Cable tie", "Anchor plate"]);
      expect(yield* namesOf({ range: { weight: { gt: 1, lt: 3 } } })).toEqual(["Anchor plate"]);
      expect(yield* namesOf({ range: { weight: { gte: 2, lte: 3 } } })).toEqual([
        "Anchor bolt",
        "Bracket",
        "Anchor plate",
      ]);
      expect(yield* namesOf({ range: { price: { gte: BigDecimal.fromNumberUnsafe(3) } } })).toEqual(
        ["Bracket", "Anchor plate"],
      );
      expect(yield* namesOf({ range: { launchedAt: { lt: DateTime.makeUnsafe(2500) } } })).toEqual([
        "Anchor bolt",
        "Cable tie",
      ]);
      expect(yield* namesOf({ eq: { price: BigDecimal.fromNumberUnsafe(2) } })).toEqual([
        "Cable tie",
      ]);
    }),
  );

  it.effect("searches the searchable fields case-insensitively", () =>
    Effect.gen(function* () {
      expect(yield* namesOf({ search: "  ANCHOR " })).toEqual(["Anchor bolt", "Anchor plate"]);
      expect(yield* namesOf({ search: "w-3" })).toEqual(["Bracket"]);
      expect(yield* namesOf({ search: "" })).toHaveLength(4);
      const unsearchable = yield* Effect.fromResult(Query.run(rows, { search: "anchor" }));
      expect(unsearchable.items).toEqual([]);
    }),
  );

  it.effect("sorts by the sort keys, breaking ties by id", () =>
    Effect.gen(function* () {
      expect(yield* namesOf({ sort: [{ field: "name" }] })).toEqual([
        "Anchor bolt",
        "Anchor plate",
        "Bracket",
        "Cable tie",
      ]);
      expect(yield* namesOf({ sort: [{ field: "weight", direction: "desc" }] })).toEqual([
        "Anchor bolt",
        "Bracket",
        "Anchor plate",
        "Cable tie",
      ]);
      expect(
        yield* namesOf({ sort: [{ field: "weight" }, { field: "launchedAt", direction: "desc" }] }),
      ).toEqual(["Cable tie", "Anchor plate", "Bracket", "Anchor bolt"]);
    }),
  );

  it.effect("orders values of different kinds by kind, so the order stays total", () =>
    Effect.gen(function* () {
      const mixed: ReadonlyArray<{
        readonly id: string;
        readonly key: Query.Ordered;
        readonly audit: typeof audit;
      }> = [
        { id: "5", key: BigDecimal.fromNumberUnsafe(1), audit },
        { id: "4", key: DateTime.makeUnsafe(0), audit },
        { id: "2", key: 1, audit },
        { id: "1", key: "a", audit },
      ];
      const page = yield* Effect.fromResult(Query.run(mixed, { sort: [{ field: "key" }] }));
      expect(page.items.map((row) => row.id)).toEqual(["1", "2", "4", "5"]);
      const ranged = yield* Effect.fromResult(Query.run(mixed, { range: { key: { gte: 0 } } }));
      expect(ranged.items.map((row) => row.id)).toEqual(["2", "4", "5"]);
    }),
  );

  it.effect("pages through every sort without repeating or skipping a row", () =>
    Effect.gen(function* () {
      const queries: ReadonlyArray<Query.Query<Widget>> = [
        {},
        { sort: [{ field: "weight", direction: "desc" }] },
        { sort: [{ field: "price" }] },
        { sort: [{ field: "launchedAt", direction: "desc" }, { field: "name" }] },
        { archived: "include", sort: [{ field: "sku" }] },
      ];
      const checked = yield* Effect.forEach(
        queries,
        (query) =>
          Effect.map(
            Effect.all(
              [
                namesOf(query),
                pagesFrom(query, 1, Option.none()),
                pagesFrom(query, 2, Option.none()),
              ],
              {
                concurrency: 1,
              },
            ),
            ([whole, byOne, byTwo]) => {
              expect(byOne).toEqual(whole);
              expect(byTwo).toEqual(whole);
            },
          ),
        { concurrency: 1 },
      );
      expect(checked).toHaveLength(queries.length);
    }),
  );

  it.effect("refuses a cursor for another sort, a malformed one and a bad limit", () =>
    Effect.gen(function* () {
      const first = yield* run({ sort: [{ field: "name" }] }, { limit: 1 });
      const cursor = yield* Effect.fromOption(first.nextCursor);
      const other = yield* Effect.flip(run({ sort: [{ field: "weight" }] }, { cursor }));
      expect(other).toBeInstanceOf(BizError.ValidationError);
      expect(Result.isFailure(Query.run(rows, {}, { cursor: Page.Cursor.make("%%%") }))).toBe(true);
      expect(Result.isFailure(Query.run(rows, {}, { limit: 1.5 }))).toBe(true);
      expect(Result.isFailure(Query.run(rows, {}, { limit: 0 }))).toBe(true);
    }),
  );

  it("names its sort in the cursor fingerprint", () => {
    expect(Query.sortKey<Widget>({})).toBe("");
    expect(
      Query.sortKey<Widget>({
        sort: [{ field: "name" }, { field: "weight", direction: "desc" }],
      }),
    ).toBe("name:asc,weight:desc");
  });
});

describe("Page", () => {
  it("defaults the limit to 50 and caps it at 500", () => {
    expect(Page.limitOf({})).toEqual(Result.succeed(Page.defaultLimit));
    expect(Page.limitOf({ limit: 10_000 })).toEqual(Result.succeed(Page.maxLimit));
    expect(Page.limitOf({ limit: 7 })).toEqual(Result.succeed(7));
  });

  it.effect("round-trips every kind of key through a cursor", () =>
    Effect.gen(function* () {
      const position: Page.Position = {
        sort: "a:asc,b:asc,c:asc,d:asc,e:asc,f:asc",
        keys: [
          Option.some("text"),
          Option.some(1.5),
          Option.some(true),
          Option.some(DateTime.makeUnsafe(1_700_000_000_000)),
          Option.some(BigDecimal.fromStringUnsafe("12.50")),
          Option.none(),
        ],
        id: "00000000-0000-7000-8000-000000000001",
      };
      const decoded = yield* Effect.fromResult(
        Page.decodeCursor(Page.encodeCursor(position), position.sort),
      );
      expect(decoded.id).toBe(position.id);
      expect(decoded.keys).toHaveLength(6);
      expect(decoded.keys[0]).toEqual(Option.some("text"));
      expect(decoded.keys[2]).toEqual(Option.some(true));
      expect(Option.isNone(decoded.keys[5] ?? Option.some(0))).toBe(true);
      expect(Page.encodeCursor(decoded)).toBe(Page.encodeCursor(position));
    }),
  );

  it("recognises keys", () => {
    expect(Page.isKey(DateTime.makeZonedUnsafe(0, { timeZone: "UTC" }))).toBe(false);
    expect(Page.isKey(Option.none())).toBe(false);
    expect(Page.isKey(BigDecimal.fromNumberUnsafe(1))).toBe(true);
  });
});
