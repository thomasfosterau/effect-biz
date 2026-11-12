/**
 * Audit fields: when an entity was created and last changed, by whom, at
 * which version, and whether it is archived.
 *
 * Every entity a repository stores carries its {@link AuditFields} as one
 * `audit` member (the {@link Audited} shape), so its domain fields stay its
 * own. A command fills them for a new entity with {@link created}; a
 * repository moves them on at each write with {@link next}. The time comes
 * from `Clock` (as a `DateTime.Utc`) and the actor from `Actor.CurrentActor`:
 * `createdBy` and `updatedBy` hold the actor's id, never its display name,
 * which is personal data.
 *
 * See {@link created} for an example.
 *
 * @module
 */

import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Actor from "./Actor.js";

/** A stored version: 1 when inserted, one more on each write. */
export const Version = Schema.Int.check(Schema.isGreaterThanOrEqualTo(1));

/** A stored version. */
export type Version = typeof Version.Type;

/**
 * Who changed an entity and when: the audit fields of every stored entity.
 * `archivedAt` is `Some` while the entity is archived (see the repository
 * conventions in `./Repository`).
 */
export class AuditFields extends Schema.Class<AuditFields, { readonly brand: unique symbol }>(
  "@effect-biz/Audit/AuditFields",
)({
  /** When the entity was inserted. */
  createdAt: Schema.DateTimeUtcFromString,
  /** The id of the actor that inserted it. */
  createdBy: Schema.NonEmptyString,
  /** When it was last written (its insert, for a new entity). */
  updatedAt: Schema.DateTimeUtcFromString,
  /** The id of the actor that last wrote it. */
  updatedBy: Schema.NonEmptyString,
  /** The stored version: 1 when inserted, one more on each write. */
  version: Version,
  /** When it was archived, while it is; `None` for an active entity. */
  archivedAt: Schema.OptionFromNullOr(Schema.DateTimeUtcFromString),
}) {}

/** The shape every stored entity has: an id and its audit fields. */
export interface Audited {
  /** The entity's id. */
  readonly id: string;
  /** Its audit fields. */
  readonly audit: AuditFields;
}

/** The moment of a write and who made it: the actor's id and the `Clock`'s time. */
export interface Stamp {
  /** When the write happens. */
  readonly at: DateTime.Utc;
  /** The id of the actor making it. */
  readonly by: string;
}

/** The current time and actor id, for a write. */
export const stamp: Effect.Effect<Stamp, never, Actor.CurrentActor> = Effect.map(
  Effect.all([DateTime.now, Actor.current], { concurrency: 1 }),
  ([at, actor]): Stamp => ({ at, by: actor.id }),
);

/**
 * The audit fields of a new entity: created and updated now, by the current
 * actor, at version 1, active.
 *
 * @example
 * ```ts
 * import { Effect } from "effect";
 * import * as Actor from "@thomasfosterau/effect-biz/Actor";
 * import * as Audit from "@thomasfosterau/effect-biz/Audit";
 *
 * const audit = Effect.runSync(Audit.created.pipe(Actor.withActor(Actor.system("importer"))));
 * console.log(audit.version, audit.createdBy); // 1 "importer"
 * ```
 */
export const created: Effect.Effect<AuditFields, never, Actor.CurrentActor> = Effect.map(
  stamp,
  ({ at, by }) =>
    new AuditFields({
      createdAt: at,
      createdBy: by,
      updatedAt: at,
      updatedBy: by,
      version: 1,
      archivedAt: Option.none(),
    }),
);

/**
 * The audit fields after a write to an entity stored with `current`: updated
 * at the stamp, one version on, with the given archive state (the current
 * one by default). The creation fields never change.
 */
export const next = (
  current: AuditFields,
  { at, by }: Stamp,
  archivedAt: Option.Option<DateTime.Utc> = current.archivedAt,
): AuditFields =>
  new AuditFields({
    createdAt: current.createdAt,
    createdBy: current.createdBy,
    updatedAt: at,
    updatedBy: by,
    version: current.version + 1,
    archivedAt,
  });

/** Whether an entity is archived. */
export const isArchived = (entity: Audited): boolean => Option.isSome(entity.audit.archivedAt);
