/**
 * The sample SQL repository the contract suites run: a `widgets` table of
 * one column of each comparable kind, plus a `widget_events` log, the second
 * store a unit-of-work command writes. The DDL is created here per dialect
 * (the migrator is #37).
 */
import * as Actor from "@thomasfosterau/effect-biz/Actor";
import * as Audit from "@thomasfosterau/effect-biz/Audit";
import * as BizError from "@thomasfosterau/effect-biz/BizError";
import * as Decimal from "@thomasfosterau/effect-biz/Decimal";
import * as Id from "@thomasfosterau/effect-biz/Id";
import type * as Query from "@thomasfosterau/effect-biz/Query";
import type * as Repository from "@thomasfosterau/effect-biz/Repository";
import * as Tenancy from "@thomasfosterau/effect-biz/Tenancy";
import type * as Testing from "@thomasfosterau/effect-biz/testing";
import * as Arr from "effect/Array";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as Struct from "effect/Struct";
import * as Dialect from "../src/Dialect.ts";
import * as SqlRepository from "../src/SqlRepository.ts";
import * as SqlUnitOfWork from "../src/SqlUnitOfWork.ts";

/** A widget's id. */
export const WidgetId = Id.make("WidgetId");

/** A widget's id. */
export type WidgetId = typeof WidgetId.Type;

/** The sample entity. */
export class Widget extends Schema.Class<Widget, { readonly brand: unique symbol }>("test/Widget")({
  id: WidgetId,
  name: Schema.String,
  code: Schema.String,
  price: Decimal.Decimal,
  madeAt: Schema.DateTimeUtcFromString,
  weight: Schema.Finite,
  audit: Audit.AuditFields,
}) {}

/** The widgets' repository port. */
export class Widgets extends Context.Service<Widgets, Repository.Port<Widget, WidgetId>>()(
  "test/Widgets",
) {}

/** The widget with other audit fields. */
export const withAudit = (widget: Widget, audit: Audit.AuditFields): Widget =>
  new Widget({ ...Struct.omit(widget, ["audit"]), audit });

/** A repository over the widgets' table, with these allow-lists. */
const widgetRepository = (
  filterable: { readonly [K in Query.FieldsOf<Widget, Query.Value>]?: SqlRepository.Kind },
  searchable: ReadonlyArray<Query.FieldsOf<Widget, string>>,
) =>
  SqlRepository.make({
    table: "widgets",
    entity: "Widget",
    id: WidgetId,
    fields: (columns) => ({
      name: Schema.String,
      code: Schema.String,
      price: columns.decimal,
      madeAt: columns.timestamp,
      weight: Schema.Finite,
    }),
    columns: { code: "widget_code" },
    make: (row) => new Widget(row),
    withAudit,
    filterable,
    searchable,
  });

/** The widgets' SQL repository. */
export const widgetsLayer: Layer.Layer<
  Widgets,
  never,
  SqlClient.SqlClient | Dialect.Dialect | SqlUnitOfWork.Committer
> = Layer.effect(
  Widgets,
  widgetRepository(
    { name: "text", code: "text", price: "decimal", madeAt: "timestamp", weight: "number" },
    ["name", "code"],
  ),
);

/** The same table with only `name` allow-listed, and no search. */
export class NarrowWidgets extends Context.Service<
  NarrowWidgets,
  Repository.Port<Widget, WidgetId>
>()("test/NarrowWidgets") {}

/** The narrow repository over the widgets' table. */
export const narrowWidgetsLayer: Layer.Layer<
  NarrowWidgets,
  never,
  SqlClient.SqlClient | Dialect.Dialect | SqlUnitOfWork.Committer
> = Layer.effect(NarrowWidgets, widgetRepository({ name: "text" }, []));

/** The widgets' and the events' DDL, from the dialect's column types. */
const ddl = (dialect: Dialect.Info): ReadonlyArray<string> => [
  "DROP TABLE IF EXISTS widgets",
  "DROP TABLE IF EXISTS widget_events",
  `CREATE TABLE widgets (
    id ${dialect.idType} PRIMARY KEY,
    tenant_id ${dialect.idType} NOT NULL,
    name text NOT NULL,
    widget_code text NOT NULL,
    price ${dialect.decimalType} NOT NULL,
    made_at ${dialect.timestampType} NOT NULL,
    weight ${dialect.name === "postgres" ? "double precision" : "real"} NOT NULL,
    version integer NOT NULL,
    created_at ${dialect.timestampType} NOT NULL,
    created_by text NOT NULL,
    updated_at ${dialect.timestampType} NOT NULL,
    updated_by text NOT NULL,
    archived_at ${dialect.timestampType}
  )`,
  `CREATE TABLE widget_events (
    tenant_id ${dialect.idType} NOT NULL,
    note text NOT NULL
  )`,
];

/** (Re)creates the empty tables on the current dialect. */
export const createTables: Effect.Effect<void, never, SqlClient.SqlClient | Dialect.Dialect> =
  Effect.flatMap(
    Effect.all([Effect.service(SqlClient.SqlClient), Dialect.current], { concurrency: 1 }),
    ([sql, dialect]) =>
      Effect.orDie(
        Effect.forEach(ddl(dialect), (statement) => sql.unsafe(statement), {
          concurrency: 1,
          discard: true,
        }),
      ),
  );

/** The widgets' tables, created when the layer is built. */
export const tablesLayer: Layer.Layer<never, never, SqlClient.SqlClient | Dialect.Dialect> =
  Layer.effectDiscard(createTables);

/** A widget's fields, from a seed. */
export const widgetFields = (n: number) => ({
  name: `Widget ${n}`,
  code: `W-${n}`,
  price: Decimal.make(`${n}.50`),
  madeAt: DateTime.makeUnsafe(`2026-01-${n.toString().padStart(2, "0")}T00:00:00Z`),
  weight: n / 4,
});

/** A new widget with these fields, its id from the `IdGenerator`, created by the current actor. */
export const newWidget = Effect.fn("newWidget")(function* (
  fields: ReturnType<typeof widgetFields>,
) {
  const id = yield* Id.generate(WidgetId);
  return new Widget({ ...fields, id, audit: yield* Audit.created });
});

/** The repository contract's subject. */
export const subject: Testing.Subject<
  WidgetId,
  Widget,
  Widgets,
  Id.IdGenerator | Actor.CurrentActor
> = {
  repository: Effect.service(Widgets),
  make: newWidget(widgetFields(1)),
  change: (widget) => new Widget({ ...Struct.omit(widget, ["name"]), name: `${widget.name}!` }),
};

/** Records one event for the current tenant, staged into the open transaction's batch. */
export const record: Effect.Effect<
  void,
  BizError.ConcurrencyConflict,
  SqlClient.SqlClient | SqlUnitOfWork.Committer | Tenancy.TenantContext
> = Effect.flatMap(
  Effect.all([SqlClient.SqlClient, SqlUnitOfWork.Committer, Tenancy.currentTenant], {
    concurrency: 1,
  }),
  ([sql, committer, tenantId]) =>
    SqlUnitOfWork.stage(
      committer,
      SqlUnitOfWork.unguarded(
        sql`INSERT INTO widget_events (tenant_id, note) VALUES (${tenantId}, 'widget.changed')`,
      ),
    ),
);

/** How many events the current tenant has recorded. */
export const recorded: Effect.Effect<number, never, SqlClient.SqlClient | Tenancy.TenantContext> =
  Effect.flatMap(
    Effect.all([SqlClient.SqlClient, Tenancy.currentTenant], { concurrency: 1 }),
    ([sql, tenantId]) =>
      Effect.map(
        Effect.orDie(sql`SELECT note FROM widget_events WHERE tenant_id = ${tenantId}`),
        (rows) => rows.length,
      ),
  );

/** The unit-of-work contract's subject. */
export const workSubject: Testing.UnitOfWorkSubject<
  WidgetId,
  Widget,
  Widgets | SqlClient.SqlClient | SqlUnitOfWork.Committer | Tenancy.TenantContext,
  Id.IdGenerator | Actor.CurrentActor
> = { ...subject, record, recorded };

/** Every widget of a list, by name, for assertions. */
export const namesOf = (widgets: ReadonlyArray<Widget>): ReadonlyArray<string> =>
  Arr.map(widgets, (widget) => widget.name);
