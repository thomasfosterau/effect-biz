/**
 * The tenant and company every repository call and command acts for.
 *
 * A tenant is the isolation boundary: every row carries its `tenant_id`, and a
 * repository only ever reads and writes the rows of the {@link TenantContext}
 * it runs under. Within a tenant, a {@link CompanyContext} names the company
 * (legal entity) a command acts for. Both are services in `R`, so a command
 * run without them fails to type-check rather than at runtime; the host app
 * provides them per request with {@link withTenant} and {@link withCompany}.
 *
 * Tenancy is independent of effect-auth's Organizations (#130).
 *
 * See {@link withTenant} for an example.
 *
 * @module
 */

import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import { dual } from "effect/Function";
import * as Id from "./Id.js";

/** The id of a tenant: the isolation boundary every row is partitioned by. */
export const TenantId = Id.make("TenantId");

/** A tenant's id. */
export type TenantId = typeof TenantId.Type;

/** The id of a company (legal entity) within a tenant. */
export const CompanyId = Id.make("CompanyId");

/** A company's id. */
export type CompanyId = typeof CompanyId.Type;

/**
 * The tenant a call acts for; every repository method requires it.
 *
 * Request-scoped, like an HTTP request: the host provides it per call, so it
 * is meant to appear in every repository method's requirements.
 *
 * @effect-leakable-service
 */
export class TenantContext extends Context.Service<
  TenantContext,
  {
    /** The tenant whose rows the call may read and write. */
    readonly tenantId: TenantId;
  }
>()("@effect-biz/Tenancy/TenantContext") {}

/**
 * The company (legal entity) a command acts for, within the current tenant.
 *
 * Request-scoped, like {@link TenantContext}.
 *
 * @effect-leakable-service
 */
export class CompanyContext extends Context.Service<
  CompanyContext,
  {
    /** The company the command acts for. */
    readonly companyId: CompanyId;
  }
>()("@effect-biz/Tenancy/CompanyContext") {}

/** The id of the tenant the call runs under. */
export const currentTenant: Effect.Effect<TenantId, never, TenantContext> = TenantContext.useSync(
  (context) => context.tenantId,
);

/** The id of the company the command acts for. */
export const currentCompany: Effect.Effect<CompanyId, never, CompanyContext> =
  CompanyContext.useSync((context) => context.companyId);

/**
 * Runs an effect for a tenant: provides the {@link TenantContext}, removing it
 * from the effect's requirements.
 *
 * @example
 * ```ts
 * import { Effect } from "effect";
 * import * as Tenancy from "@thomasfosterau/effect-biz/Tenancy";
 *
 * const tenant = Tenancy.TenantId.make("0190a6e4-1c2d-7abc-8def-0123456789ab");
 *
 * // `program` requires `TenantContext`; running it without one does not compile.
 * const program = Tenancy.currentTenant;
 *
 * console.log(Effect.runSync(program.pipe(Tenancy.withTenant(tenant)))); // the tenant's id
 * ```
 */
export const withTenant: {
  (
    tenantId: TenantId,
  ): <A, E, R>(self: Effect.Effect<A, E, R>) => Effect.Effect<A, E, Exclude<R, TenantContext>>;
  <A, E, R>(
    self: Effect.Effect<A, E, R>,
    tenantId: TenantId,
  ): Effect.Effect<A, E, Exclude<R, TenantContext>>;
} = dual(
  2,
  <A, E, R>(
    self: Effect.Effect<A, E, R>,
    tenantId: TenantId,
  ): Effect.Effect<A, E, Exclude<R, TenantContext>> =>
    Effect.provideService(self, TenantContext, { tenantId }),
);

/**
 * Runs an effect for a company: provides the {@link CompanyContext}, removing
 * it from the effect's requirements. The tenant is provided separately, with
 * {@link withTenant}.
 */
export const withCompany: {
  (
    companyId: CompanyId,
  ): <A, E, R>(self: Effect.Effect<A, E, R>) => Effect.Effect<A, E, Exclude<R, CompanyContext>>;
  <A, E, R>(
    self: Effect.Effect<A, E, R>,
    companyId: CompanyId,
  ): Effect.Effect<A, E, Exclude<R, CompanyContext>>;
} = dual(
  2,
  <A, E, R>(
    self: Effect.Effect<A, E, R>,
    companyId: CompanyId,
  ): Effect.Effect<A, E, Exclude<R, CompanyContext>> =>
    Effect.provideService(self, CompanyContext, { companyId }),
);
