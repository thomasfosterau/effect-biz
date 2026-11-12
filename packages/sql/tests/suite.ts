/**
 * The suites every dialect runs against the sample repository (`widgets.ts`):
 * core's repository and unit-of-work contracts, the agreement of `find`
 * with `Query.run` (cursors included), the allow-list, and commit-time
 * conflicts and rollback.
 */
import { expect } from "vite-plus/test";
import { layer } from "@effect/vitest";
import * as Actor from "@thomasfosterau/effect-biz/Actor";
import * as BizError from "@thomasfosterau/effect-biz/BizError";
import * as Decimal from "@thomasfosterau/effect-biz/Decimal";
import * as Id from "@thomasfosterau/effect-biz/Id";
import * as Page from "@thomasfosterau/effect-biz/Page";
import * as Query from "@thomasfosterau/effect-biz/Query";
import * as Tenancy from "@thomasfosterau/effect-biz/Tenancy";
import * as Testing from "@thomasfosterau/effect-biz/testing";
import * as UnitOfWork from "@thomasfosterau/effect-biz/UnitOfWork";
import * as Arr from "effect/Array";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import type * as Config from "effect/Config";
import type * as SqlClient from "effect/sql/SqlClient";
import type * as SqlError from "effect/sql/SqlError";
import type * as Dialect from "../src/Dialect.ts";
import * as SqlUnitOfWork from "../src/SqlUnitOfWork.ts";
import {
  NarrowWidgets,
  narrowWidgetsLayer,
  newWidget,
  recorded,
  subject,
  tablesLayer,
  type Widget,
  widgetFields,
  Widgets,
  widgetsLayer,
  workSubject,
} from "./widgets.ts";

/** What a dialect's suite runs on: a database with its dialect and a SQL unit of work over it. */
export type Database = Layer.Layer<
  SqlClient.SqlClient | Dialect.Dialect | UnitOfWork.UnitOfWork | SqlUnitOfWork.Committer,
  SqlError.SqlError | Config.ConfigError | Dialect.UnsupportedDialect | SqlUnitOfWork.BatchRequired
>;

/** The services each case gets: the database, the tables, the widgets' repository and ids. */
const servicesOf = (database: Database) =>
  Layer.mergeAll(widgetsLayer, narrowWidgetsLayer, tablesLayer, Id.layerSequential).pipe(
    Layer.provideMerge(database),
  );

const hex = (value: number): string => value.toString(16).padStart(12, "0");

/** A tenant of this suite's own, apart from the contracts' tenants. */
const tenantOf = (n: number): Tenancy.TenantId =>
  Tenancy.TenantId.make(`0190a6e4-0000-7000-9000-${hex(n)}`);

/** Runs `self` as a tenant of this suite's and the test actor. */
const asTenant =
  (n: number) =>
  <A, E, R>(self: Effect.Effect<A, E, R>) =>
    self.pipe(Tenancy.withTenant(tenantOf(n)), Actor.withActor(Actor.system("sql-suite")));

/** The widgets the agreement cases query: names and codes chosen to catch collation, case and `LIKE` wildcards. */
const seeds = [
  { name: "apple", code: "A_1", n: 3 },
  { name: "Banana", code: "B%2", n: 12 },
  { name: "Zed", code: "Z-3", n: 7 },
  { name: "_under", code: "U-4", n: 1 },
  { name: "Ångström", code: "A-5", n: 10 },
  { name: "apple", code: "A-6", n: 25 },
  { name: "cherry", code: "C\\7", n: 3 },
] as const;

/** Inserts the seeds and archives the third; returns every widget as stored. */
const seed = Effect.fn("seed")(function* () {
  const widgets = yield* Widgets;
  const inserted = yield* Effect.forEach(
    seeds,
    ({ name, code, n }) =>
      Effect.tap(newWidget({ ...widgetFields(n), name, code }), (widget) => widgets.insert(widget)),
    { concurrency: 1 },
  );
  const third = inserted[2];
  if (third !== undefined) {
    yield* widgets.archive(third.id, 1);
  }
  const all = yield* widgets.find({ archived: "include" }, { limit: 500 });
  return all.items;
});

/** The queries `find` must answer as `Query.run` does, by what each exercises. */
const queries: ReadonlyArray<readonly [string, Query.Query<Widget>]> = [
  ["no filter, by id", {}],
  ["text ascending, by code point", { sort: [{ field: "name" }] }],
  ["mixed directions", { sort: [{ field: "name", direction: "desc" }, { field: "weight" }] }],
  [
    "a decimal descending, then text",
    {
      sort: [
        { field: "price", direction: "desc" },
        { field: "name", direction: "asc" },
      ],
    },
  ],
  ["a timestamp, archived included", { sort: [{ field: "madeAt" }], archived: "include" }],
  ["archived only", { archived: "only" }],
  ["eq", { eq: { name: "apple" } }],
  ["in, archived included", { in: { code: ["A_1", "Z-3", "nope"] }, archived: "include" }],
  ["an empty in", { in: { code: [] } }],
  ["a decimal range", { range: { price: { gte: Decimal.make("3.5"), lt: Decimal.make("12.5") } } }],
  [
    "a timestamp range, descending",
    {
      range: { madeAt: { gt: DateTime.makeUnsafe("2026-01-03T00:00:00Z") } },
      sort: [{ field: "madeAt", direction: "desc" }],
    },
  ],
  ["a number range", { range: { weight: { lte: 2.5 } }, sort: [{ field: "weight" }] }],
  ["search, case-insensitive", { search: "APP" }],
  ["search for an underscore", { search: "_" }],
  ["search for a percent sign", { search: "%" }],
  ["search for a backslash", { search: "\\" }],
  ["a blank search", { search: "  " }],
  ["search, sorted", { search: "b%2", sort: [{ field: "code" }] }],
];

const idsOf = (widgets: ReadonlyArray<Widget>) => Arr.map(widgets, (widget) => widget.id);

/** Every id `find` returns, page by page. */
const pagesOf = <R>(
  find: (request: Page.Request) => Effect.Effect<Page.Page<Widget>, BizError.ValidationError, R>,
  cursor: Option.Option<Page.Cursor>,
  seen: ReadonlyArray<string>,
): Effect.Effect<ReadonlyArray<string>, BizError.ValidationError, R> =>
  Effect.flatMap(
    find(
      Option.match(cursor, {
        onNone: () => ({ limit: 2 }),
        onSome: (next) => ({ limit: 2, cursor: next }),
      }),
    ),
    (page) =>
      Option.isSome(page.nextCursor) && seen.length < 100
        ? pagesOf(find, page.nextCursor, Arr.appendAll(seen, idsOf(page.items)))
        : Effect.succeed(Arr.appendAll(seen, idsOf(page.items))),
  );

const memoryPage = (
  rows: ReadonlyArray<Widget>,
  query: Query.Query<Widget>,
  request: Page.Request,
) => Effect.fromResult(Query.run(rows, query, request, { searchable: ["name", "code"] }));

/** A unit of work over the suite's committer that retries nothing, so a commit's own conflict comes back. */
const unretried = Effect.map(SqlUnitOfWork.Committer, (committer) =>
  UnitOfWork.make(SqlUnitOfWork.journal, committer.commit, { attempts: 1 }),
);

/** Runs `self` outside the open transaction: its writes commit at once, as another command's. */
const outside = <A, E, R>(self: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
  Effect.provideService(self, SqlUnitOfWork.journal.current, Option.none());

/** The services of the suites, and whether each case needs a fresh database. */
export interface Suite {
  readonly name: string;
  readonly database: Database;
  readonly buildPerTest: boolean;
  /** Skips a case where the database is not there (Postgres without its URL). */
  readonly guard: (ctx: {
    readonly skip: (note?: string) => void;
  }) => Effect.Effect<void, never, Dialect.Dialect>;
}

/** Registers every suite of a dialect. */
export const suites = ({ name, database, buildPerTest, guard }: Suite): void => {
  const services = servicesOf(database);
  const options = { buildPerTest, excludeTestServices: true };

  layer(services, options)(`the repository contract on ${name}`, (it) => {
    Arr.forEach(Testing.repositoryContract(subject), (contractCase) =>
      it.effect(contractCase.name, (ctx) => Effect.andThen(guard(ctx), contractCase.run)),
    );
  });

  layer(services, options)(`the unit-of-work contract on ${name}`, (it) => {
    Arr.forEach(Testing.unitOfWorkContract(workSubject), (contractCase) =>
      it.effect(contractCase.name, (ctx) => Effect.andThen(guard(ctx), contractCase.run)),
    );
  });

  layer(services, options)(`find on ${name}`, (it) => {
    Arr.forEach(queries, ([label, query], index) =>
      it.effect(`agrees with Query.run, page by page: ${label}`, (ctx) =>
        Effect.gen(function* () {
          yield* guard(ctx);
          const widgets = yield* Widgets;
          const rows = yield* seed();
          const sql = yield* pagesOf((request) => widgets.find(query, request), Option.none(), []);
          const memory = yield* pagesOf(
            (request) => memoryPage(rows, query, request),
            Option.none(),
            [],
          );
          expect(sql).toEqual(memory);
        }).pipe(asTenant(100 + index)),
      ),
    );

    it.effect(
      "continues the in-memory store's cursor, and the in-memory store continues its",
      (ctx) =>
        Effect.gen(function* () {
          yield* guard(ctx);
          const widgets = yield* Widgets;
          const rows = yield* seed();
          const query: Query.Query<Widget> = {
            sort: [{ field: "price", direction: "desc" }, { field: "name" }],
          };
          const fromMemory = yield* memoryPage(rows, query, { limit: 2 });
          const cursor = yield* Effect.fromOption(fromMemory.nextCursor);
          const sqlNext = yield* widgets.find(query, { limit: 2, cursor });
          const memoryNext = yield* memoryPage(rows, query, { limit: 2, cursor });
          expect(idsOf(sqlNext.items)).toEqual(idsOf(memoryNext.items));
          const sqlCursor = yield* Effect.fromOption(sqlNext.nextCursor);
          expect(Option.some(sqlCursor)).toEqual(memoryNext.nextCursor);
          const last = yield* memoryPage(rows, query, { limit: 2, cursor: sqlCursor });
          const sqlLast = yield* widgets.find(query, { limit: 2, cursor: sqlCursor });
          expect(idsOf(sqlLast.items)).toEqual(idsOf(last.items));
        }).pipe(asTenant(200)),
    );

    it.effect(
      "refuses a field off the allow-list, a cursor for another sort or of other values, and a bad limit",
      (ctx) =>
        Effect.gen(function* () {
          yield* guard(ctx);
          const widgets = yield* Widgets;
          const narrow = yield* NarrowWidgets;
          yield* seed();
          const unlisted = yield* Effect.flip(narrow.find({ eq: { code: "A_1" } }));
          expect(unlisted.issues[0]?.path).toEqual(["eq", "code"]);
          const sortOff = yield* Effect.flip(narrow.find({ sort: [{ field: "price" }] }));
          expect(sortOff.issues[0]?.path).toEqual(["sort", 0, "field"]);
          const rangeOff = yield* Effect.flip(narrow.find({ range: { weight: { gt: 1 } } }));
          expect(rangeOff.issues[0]?.path).toEqual(["range", "weight"]);
          expect((yield* narrow.find({ eq: { name: "apple" } })).items.length).toBe(2);
          const page = yield* widgets.find({ sort: [{ field: "name" }] }, { limit: 1 });
          const cursor = yield* Effect.fromOption(page.nextCursor);
          const other = yield* Effect.flip(widgets.find({ sort: [{ field: "code" }] }, { cursor }));
          expect(other.issues[0]?.path).toEqual(["cursor"]);
          const forged = Page.encodeCursor({
            sort: "price:asc",
            keys: [Option.some("not a decimal")],
            id: "00000000-0000-7000-8000-000000000001",
          });
          const wrongKind = yield* Effect.flip(
            widgets.find({ sort: [{ field: "price" }] }, { cursor: forged }),
          );
          expect(wrongKind.issues[0]?.path).toEqual(["cursor"]);
          const limit = yield* Effect.flip(widgets.find({}, { limit: 1.5 }));
          expect(limit.issues[0]?.path).toEqual(["limit"]);
        }).pipe(asTenant(201)),
    );
  });

  layer(services, options)(`commits on ${name}`, (it) => {
    it.effect(
      "a conflict at commit names the version stored, and rolls back the whole batch",
      (ctx) =>
        Effect.gen(function* () {
          yield* guard(ctx);
          const widgets = yield* Widgets;
          const once = yield* unretried;
          const first = yield* Effect.tap(newWidget(widgetFields(1)), widgets.insert);
          const second = yield* Effect.tap(newWidget(widgetFields(2)), widgets.insert);
          const fresh = yield* newWidget(widgetFields(3));
          const conflict = yield* Effect.flip(
            once.transaction(
              Effect.gen(function* () {
                yield* widgets.update(subject.change(first));
                yield* widgets.insert(fresh);
                yield* workSubject.record;
                yield* widgets.update(subject.change(second));
                // Another command commits second at version 2 before this batch.
                yield* outside(widgets.update(subject.change(second)));
              }),
            ),
          );
          expect(conflict).toEqual(
            new BizError.ConcurrencyConflict({
              entity: "Widget",
              id: second.id,
              expected: 1,
              actual: 2,
            }),
          );
          expect((yield* widgets.get(first.id)).audit.version).toBe(1);
          expect(Result.isFailure(yield* Effect.result(widgets.get(fresh.id)))).toBe(true);
          expect(yield* recorded).toBe(0);
          expect((yield* widgets.get(second.id)).audit.version).toBe(2);
        }).pipe(asTenant(300)),
    );

    it.effect("a duplicate insert is AlreadyExists when decided, and a conflict at commit", (ctx) =>
      Effect.gen(function* () {
        yield* guard(ctx);
        const widgets = yield* Widgets;
        const once = yield* unretried;
        const widget = yield* newWidget(widgetFields(4));
        const conflict = yield* Effect.flip(
          once.transaction(Effect.andThen(widgets.insert(widget), outside(widgets.insert(widget)))),
        );
        expect(conflict).toEqual(
          new BizError.ConcurrencyConflict({
            entity: "Widget",
            id: widget.id,
            expected: 0,
            actual: 1,
          }),
        );
        const again = yield* Effect.flip(widgets.insert(widget));
        expect(again._tag).toBe("AlreadyExists");
      }).pipe(asTenant(301)),
    );
  });
};
