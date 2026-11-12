import * as BigDecimal from "effect/BigDecimal";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Struct from "effect/Struct";
import type * as Actor from "../src/Actor.ts";
import * as Audit from "../src/Audit.ts";
import * as Id from "../src/Id.ts";
import * as Memory from "../src/Memory.ts";
import type * as Repository from "../src/Repository.ts";
import type * as Testing from "../src/testing.ts";

/** A test entity's id. */
export const WidgetId = Id.make("WidgetId");

/** A test entity's id. */
export type WidgetId = typeof WidgetId.Type;

/** A test entity with a field of every key kind. */
export class Widget extends Schema.Class<Widget, { readonly brand: unique symbol }>("test/Widget")({
  id: WidgetId,
  name: Schema.String,
  sku: Schema.String,
  price: Schema.BigDecimal,
  weight: Schema.Finite,
  active: Schema.Boolean,
  launchedAt: Schema.DateTimeUtc,
  note: Schema.OptionFromNullOr(Schema.String),
  audit: Audit.AuditFields,
}) {}

/** The widget with other audit fields. */
export const withAudit = (widget: Widget, audit: Audit.AuditFields): Widget =>
  new Widget({ ...Struct.omit(widget, ["audit"]), audit });

/** An in-memory widget repository. */
export class Widgets extends Context.Service<Widgets, Repository.Port<Widget, WidgetId>>()(
  "test/Widgets",
) {}

/** Widgets over `Memory`, searchable by name and SKU. */
export const widgetsLayer: Layer.Layer<Widgets> = Layer.effect(
  Widgets,
  Effect.map(Memory.makeStore<WidgetId, Widget>(), (store) =>
    Memory.repository(store, { entity: "Widget", withAudit, searchable: ["name", "sku"] }),
  ),
);

/** The audit fields of a row made at time zero by `"fixture"`. */
export const audit = new Audit.AuditFields({
  createdAt: DateTime.makeUnsafe(0),
  createdBy: "fixture",
  updatedAt: DateTime.makeUnsafe(0),
  updatedBy: "fixture",
  version: 1,
  archivedAt: Option.none(),
});

/** A widget with the given fields, at version 1. */
export const widget = (
  id: number,
  fields: Partial<Omit<ConstructorParameters<typeof Widget>[0], "id">> = {},
): Widget =>
  new Widget({
    name: `Widget ${id}`,
    sku: `W-${id}`,
    price: BigDecimal.fromNumberUnsafe(id),
    weight: id,
    active: true,
    launchedAt: DateTime.makeUnsafe(id * 1000),
    note: Option.none(),
    audit,
    ...fields,
    id: WidgetId.make(`00000000-0000-7000-8000-${id.toString(16).padStart(12, "0")}`),
  });

/** The contract subject for a widget port. */
export const widgetSubject = <R>(
  repository: Effect.Effect<Repository.Port<Widget, WidgetId>, never, R>,
): Testing.Subject<WidgetId, Widget, R | Id.IdGenerator | Actor.CurrentActor> => ({
  repository,
  make: Effect.gen(function* () {
    const id = yield* Id.generate(WidgetId);
    const created = yield* Audit.created;
    return new Widget({ ...Struct.omit(widget(1), ["id", "audit"]), id, audit: created });
  }),
  change: (entity) => new Widget({ ...Struct.omit(entity, ["name"]), name: `${entity.name}!` }),
});
