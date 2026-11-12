import { describe, expect, expectTypeOf } from "vite-plus/test";
import { it, layer } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as BizError from "../src/BizError.ts";
import * as Company from "../src/Company.ts";
import * as Currency from "../src/Currency.ts";
import * as Id from "../src/Id.ts";
import * as Rounding from "../src/Rounding.ts";
import * as Tenancy from "../src/Tenancy.ts";

const tenantA = Tenancy.TenantId.make("0190a6e4-1c2d-7abc-8def-0000000000a1");
const tenantB = Tenancy.TenantId.make("0190a6e4-1c2d-7abc-8def-0000000000b2");

const input: Company.CreateInput = {
  legalName: "Example Pty Ltd",
  tradingName: Option.some("Example"),
  registrations: [new Company.Registration({ scheme: "AU.ABN", value: "51824753556" })],
  baseCurrency: Currency.make("AUD"),
  country: Company.CountryCode.make("AU"),
  locale: "en-AU",
  timeZone: "Australia/Sydney",
  fiscalYearStart: new Company.FiscalYearStart({ month: 7, day: 1 }),
  rounding: new Rounding.RoundingPolicy({ mode: "half-even", scale: 2 }),
};

describe("Company schema", () => {
  it("round-trips through JSON, the trading name as null when absent", () => {
    const Json = Schema.fromJsonString(Company.Company);
    const company = new Company.Company({
      ...input,
      tradingName: Option.none(),
      id: Tenancy.CompanyId.make("0190a6e4-1c2d-7abc-8def-0123456789ab"),
      version: 1,
    });
    const encoded = Schema.encodeSync(Json)(company);
    expect(Schema.encodeSync(Company.Company)(company)).toMatchObject({
      tradingName: null,
      baseCurrency: "AUD",
    });
    expect(Schema.decodeSync(Json)(encoded)).toEqual(company);
  });

  it.each([
    [7, 1, true],
    [12, 31, true],
    [2, 28, true],
    [2, 29, false],
    [4, 31, false],
    [13, 1, false],
    [0, 1, false],
  ])("accepts %i-%i as a fiscal-year start: %s", (month, day, valid) => {
    expect(Exit.isSuccess(Schema.decodeExit(Company.FiscalYearStart)({ month, day }))).toBe(valid);
  });

  it("takes a two-letter upper-case country code", () => {
    expect(Schema.is(Company.CountryCode)("AU")).toBe(true);
    expect(Schema.is(Company.CountryCode)("au")).toBe(false);
    expect(Schema.is(Company.CountryCode)("AUS")).toBe(false);
  });

  it("requires the tenant on every repository call, at the type level", () => {
    expectTypeOf(Company.get).returns.toExtend<
      Effect.Effect<
        Company.Company,
        BizError.NotFound,
        Company.CompanyRepository | Tenancy.TenantContext
      >
    >();
    expectTypeOf<Effect.Services<ReturnType<typeof Company.create>>>().toEqualTypeOf<
      Id.IdGenerator | Company.CompanyRepository | Tenancy.TenantContext
    >();
  });
});

layer(Layer.merge(Company.layerMemory, Id.layerSequential), { buildPerTest: true })(
  "Company.layerMemory",
  (it) => {
    it.effect("creates a company at version 1 and reads it back", () =>
      Effect.gen(function* () {
        const company = yield* Company.create(input);
        expect(company.version).toBe(1);
        expect(yield* Company.get(company.id)).toEqual(company);
        expect(yield* Company.list).toEqual([company]);
      }).pipe(Tenancy.withTenant(tenantA)),
    );

    it.effect("never shows one tenant's company to another", () =>
      Effect.gen(function* () {
        const company = yield* Company.create(input).pipe(Tenancy.withTenant(tenantA));
        const fromB = yield* Effect.flip(Company.get(company.id)).pipe(Tenancy.withTenant(tenantB));
        expect(fromB).toEqual(new BizError.NotFound({ entity: "Company", id: company.id }));
        expect(yield* Company.list.pipe(Tenancy.withTenant(tenantB))).toEqual([]);
        const updated = yield* Effect.flip(Company.update(company)).pipe(
          Tenancy.withTenant(tenantB),
        );
        expect(updated).toBeInstanceOf(BizError.NotFound);
        expect(yield* Company.get(company.id).pipe(Tenancy.withTenant(tenantA))).toEqual(company);
      }),
    );

    it.effect("refuses a second insert of the same id", () =>
      Effect.gen(function* () {
        const company = yield* Company.create(input);
        const error = yield* Effect.flip(
          Company.CompanyRepository.use((repository) => repository.insert(company)),
        );
        expect(error).toEqual(new BizError.AlreadyExists({ entity: "Company", key: company.id }));
      }).pipe(Tenancy.withTenant(tenantA)),
    );

    it.effect("updates at the next version and refuses a stale one", () =>
      Effect.gen(function* () {
        const company = yield* Company.create(input);
        const renamed = yield* Company.update(
          new Company.Company({
            ...input,
            id: company.id,
            version: 1,
            legalName: "Renamed Pty Ltd",
          }),
        );
        expect(renamed.version).toBe(2);
        expect((yield* Company.get(company.id)).legalName).toBe("Renamed Pty Ltd");
        const stale = yield* Effect.flip(Company.update(company));
        expect(stale).toEqual(
          new BizError.ConcurrencyConflict({
            entity: "Company",
            id: company.id,
            expected: 1,
            actual: 2,
          }),
        );
      }).pipe(Tenancy.withTenant(tenantA)),
    );

    it.effect("lets exactly one of two updates from the same version succeed", () =>
      Effect.gen(function* () {
        const company = yield* Company.create(input);
        const outcomes = yield* Effect.all(
          [Effect.exit(Company.update(company)), Effect.exit(Company.update(company))],
          { concurrency: "unbounded" },
        );
        expect(outcomes.filter(Exit.isSuccess)).toHaveLength(1);
        const failures = outcomes.filter(Exit.isFailure);
        expect(failures).toHaveLength(1);
        expect((yield* Company.get(company.id)).version).toBe(2);
      }).pipe(Tenancy.withTenant(tenantA)),
    );

    it.effect("refuses an insert at a version other than 1", () =>
      Effect.gen(function* () {
        const company = new Company.Company({
          ...input,
          id: Tenancy.CompanyId.make("0190a6e4-1c2d-7abc-8def-0123456789ab"),
          version: 3,
        });
        const error = yield* Effect.flip(
          Company.CompanyRepository.use((repository) => repository.insert(company)),
        );
        expect(error).toBeInstanceOf(BizError.ConcurrencyConflict);
        expect(yield* Company.list).toEqual([]);
      }).pipe(Tenancy.withTenant(tenantA)),
    );
  },
);
