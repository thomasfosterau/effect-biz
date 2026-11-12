import { describe, expect, expectTypeOf } from "vite-plus/test";
import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Schema from "effect/Schema";
import * as Actor from "../src/Actor.ts";
import * as Tenancy from "../src/Tenancy.ts";

const tenant = Tenancy.TenantId.make("0190a6e4-1c2d-7abc-8def-0000000000a1");
const company = Tenancy.CompanyId.make("0190a6e4-1c2d-7abc-8def-0000000000c1");

describe("Tenancy", () => {
  it("keeps tenant and company ids apart at the type level", () => {
    expectTypeOf<Tenancy.TenantId>().not.toEqualTypeOf<Tenancy.CompanyId>();
    expectTypeOf<Tenancy.CompanyId>().not.toExtend<Tenancy.TenantId>();
  });

  it("removes each context from the requirements it provides", () => {
    const both = Effect.all([Tenancy.currentTenant, Tenancy.currentCompany], { concurrency: 1 });
    expectTypeOf<Effect.Services<typeof both>>().toEqualTypeOf<
      Tenancy.TenantContext | Tenancy.CompanyContext
    >();
    const provided = both.pipe(Tenancy.withTenant(tenant), Tenancy.withCompany(company));
    expectTypeOf<Effect.Services<typeof provided>>().toEqualTypeOf<never>();
  });

  it.effect("provides the tenant and company, data-first or data-last", () =>
    Effect.gen(function* () {
      expect(yield* Tenancy.currentTenant.pipe(Tenancy.withTenant(tenant))).toBe(tenant);
      expect(yield* Tenancy.withTenant(Tenancy.currentTenant, tenant)).toBe(tenant);
      expect(yield* Tenancy.currentCompany.pipe(Tenancy.withCompany(company))).toBe(company);
      expect(yield* Tenancy.withCompany(Tenancy.currentCompany, company)).toBe(company);
    }),
  );

  it.effect("lets an inner tenant shadow an outer one", () =>
    Effect.gen(function* () {
      const other = Tenancy.TenantId.make("0190a6e4-1c2d-7abc-8def-0000000000b2");
      const seen = yield* Tenancy.currentTenant.pipe(
        Tenancy.withTenant(other),
        Tenancy.withTenant(tenant),
      );
      expect(seen).toBe(other);
    }),
  );
});

describe("Actor", () => {
  it.effect("provides the current actor", () =>
    Effect.gen(function* () {
      const actor = new Actor.Actor({ kind: "user", id: "user-1", displayName: "Jane" });
      expect(yield* Actor.current.pipe(Actor.withActor(actor))).toBe(actor);
      expect(yield* Actor.withActor(Actor.current, Actor.system("scheduler"))).toEqual(
        new Actor.Actor({ kind: "system", id: "scheduler", displayName: "scheduler" }),
      );
    }),
  );

  it("refuses an empty id and an unknown kind", () => {
    const decode = Schema.decodeUnknownExit(Actor.Actor);
    expect(Exit.isFailure(decode({ kind: "user", id: "", displayName: "x" }))).toBe(true);
    expect(Exit.isFailure(decode({ kind: "robot", id: "r", displayName: "x" }))).toBe(true);
    expect(Exit.isSuccess(decode({ kind: "integration", id: "i", displayName: "" }))).toBe(true);
  });
});
