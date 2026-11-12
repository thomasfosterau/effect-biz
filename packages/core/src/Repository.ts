/**
 * The repository conventions every domain package follows: the shape of a
 * repository port and the errors each method fails with. Conventions and
 * helper types, not a base class: a domain package declares its own
 * `Context.Service` whose shape is (or extends) {@link Port}.
 *
 * - **Tenant-scoped.** Every method requires `Tenancy.TenantContext`, and
 *   reads and writes only that tenant's rows: another tenant's entity is
 *   `NotFound`.
 * - **Audited.** Every stored entity carries `audit: Audit.AuditFields`
 *   ({@link Entity}). A command builds a new one with `Audit.created`;
 *   {@link Port.update}, {@link Port.archive} and {@link Port.restore} move
 *   the audit fields on themselves (from `Clock` and `Actor.CurrentActor`,
 *   which they therefore require).
 * - **Version-guarded.** `insert` takes version 1; `update`, `archive` and
 *   `restore` take the version the caller loaded and store the entity at the
 *   next one, or fail with `ConcurrencyConflict` when the stored version
 *   differs. Each write is load → decide (pure) → commit one atomic,
 *   version-guarded batch, so it works on Cloudflare D1 (no row locks, no
 *   interactive transactions) as on Postgres (#128); a caller retries a
 *   conflict from its load step.
 * - **Archived, not deleted.** `archive` sets `audit.archivedAt`, `restore`
 *   clears it; `get` still finds an archived entity, `find` hides it unless
 *   the query asks (`archived: "include"` or `"only"`). Archiving an
 *   archived entity, or restoring an active one, is `InvalidTransition`.
 *   A hard delete ({@link Deletable}) is added only where the domain allows
 *   it.
 * - **Paged.** `find` takes a `./Query` and returns a `./Page` (keyset
 *   paging in a stable order, ties broken by id).
 *
 * `./Memory` builds an in-memory port; `./testing` is the contract suite
 * every implementation runs. See {@link Port} for an example.
 *
 * @module
 */

import type * as Effect from "effect/Effect";
import type * as Actor from "./Actor.js";
import type * as Audit from "./Audit.js";
import type * as BizError from "./BizError.js";
import type * as Page from "./Page.js";
import type * as Query from "./Query.js";
import type * as Tenancy from "./Tenancy.js";

/** What a repository stores: an entity with its id and audit fields. */
export type Entity = Audit.Audited;

/** What a write that stamps the audit fields requires: the tenant and the actor. */
export type WriteContext = Tenancy.TenantContext | Actor.CurrentActor;

/**
 * The methods of a repository port for entities `A` with ids `I`, all
 * scoped to the current tenant.
 *
 * @example
 * ```ts
 * import { Context } from "effect";
 * import * as Repository from "@thomasfosterau/effect-biz/Repository";
 * import type * as Audit from "@thomasfosterau/effect-biz/Audit";
 *
 * interface Widget {
 *   readonly id: string;
 *   readonly name: string;
 *   readonly audit: Audit.AuditFields;
 * }
 *
 * // A domain package's port: the conventional methods, plus its own.
 * class WidgetRepository extends Context.Service<
 *   WidgetRepository,
 *   Repository.Port<Widget, string>
 * >()("example/WidgetRepository") {}
 *
 * console.log(WidgetRepository.key); // "example/WidgetRepository"
 * ```
 */
export interface Port<A extends Entity, I extends string> {
  /** The tenant's entity with this id, archived or not. */
  readonly get: (id: I) => Effect.Effect<A, BizError.NotFound, Tenancy.TenantContext>;
  /**
   * The tenant's entities with these ids, in the order asked, each once;
   * an id the tenant has no entity for is left out.
   */
  readonly getMany: (
    ids: Iterable<I>,
  ) => Effect.Effect<ReadonlyArray<A>, never, Tenancy.TenantContext>;
  /** One page of the tenant's entities that match the query. */
  readonly find: (
    query: Query.Query<A>,
    request?: Page.Request,
  ) => Effect.Effect<Page.Page<A>, BizError.ValidationError, Tenancy.TenantContext>;
  /** Stores a new entity for the tenant; its version must be 1 and its id unused. */
  readonly insert: (
    entity: A,
  ) => Effect.Effect<
    void,
    BizError.AlreadyExists | BizError.ConcurrencyConflict,
    Tenancy.TenantContext
  >;
  /**
   * Replaces a stored entity, guarded by its version: `entity.audit.version`
   * must be the stored one. Returns it as stored, at the next version, with
   * its creation and archive fields kept from the stored row.
   */
  readonly update: (
    entity: A,
  ) => Effect.Effect<A, BizError.NotFound | BizError.ConcurrencyConflict, WriteContext>;
  /** Archives the entity stored at `version`; returns it at the next version. */
  readonly archive: (
    id: I,
    version: number,
  ) => Effect.Effect<
    A,
    BizError.NotFound | BizError.ConcurrencyConflict | BizError.InvalidTransition,
    WriteContext
  >;
  /** Restores the archived entity stored at `version`; returns it at the next version. */
  readonly restore: (
    id: I,
    version: number,
  ) => Effect.Effect<
    A,
    BizError.NotFound | BizError.ConcurrencyConflict | BizError.InvalidTransition,
    WriteContext
  >;
}

/** The hard delete a port adds only where its domain allows one, guarded by version. */
export interface Deletable<I extends string> {
  /** Deletes the entity stored at `version`. */
  readonly delete: (
    id: I,
    version: number,
  ) => Effect.Effect<void, BizError.NotFound | BizError.ConcurrencyConflict, Tenancy.TenantContext>;
}
