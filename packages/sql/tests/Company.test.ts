/**
 * Core's `Company` over SQL: its repository built with `SqlRepository.make`
 * (the nested values as JSON columns) passes core's repository contract and
 * serves `Company.create` / `update` / `archive`, on SQLite.
 */
import { expect } from "vite-plus/test";
import { layer } from "@effect/vitest";
import * as Actor from "@thomasfosterau/effect-biz/Actor";
import * as Audit from "@thomasfosterau/effect-biz/Audit";
import * as Company from "@thomasfosterau/effect-biz/Company";
import * as Currency from "@thomasfosterau/effect-biz/Currency";
import * as Id from "@thomasfosterau/effect-biz/Id";
import * as Page from "@thomasfosterau/effect-biz/Page";
import * as Rounding from "@thomasfosterau/effect-biz/Rounding";
import * as Tenancy from "@thomasfosterau/effect-biz/Tenancy";
import * as Testing from "@thomasfosterau/effect-biz/testing";
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as Struct from "effect/Struct";
import * as Dialect from "../src/Dialect.ts";
import * as SqlRepository from "../src/SqlRepository.ts";
import * as SqlUnitOfWork from "../src/SqlUnitOfWork.ts";
import * as TestingSql from "../src/testing.ts";

const withAudit = (company: Company.Company, audit: Audit.AuditFields): Company.Company =>
  new Company.Company({ ...Struct.omit(company, ["audit"]), audit });

/** `CompanyRepository` over a `companies` table. */
const companiesLayer = Layer.effect(
  Company.CompanyRepository,
  Effect.map(
    SqlRepository.make({
      table: "companies",
      entity: "Company",
      id: Tenancy.CompanyId,
      fields: (columns) => ({
        legalName: Schema.NonEmptyString,
        tradingName: columns.nullable(Schema.NonEmptyString),
        registrations: columns.json(Schema.Array(Company.Registration)),
        baseCurrency: Currency.CurrencyCode,
        country: Company.CountryCode,
        locale: Schema.NonEmptyString,
        timeZone: Schema.NonEmptyString,
        fiscalYearStart: columns.json(Company.FiscalYearStart),
        rounding: columns.json(Rounding.RoundingPolicy),
      }),
      make: (row) => new Company.Company(row),
      withAudit,
      filterable: { legalName: "text", country: "text", baseCurrency: "text" },
      searchable: ["legalName"],
    }),
    (port) =>
      Company.CompanyRepository.of({
        ...port,
        list: Effect.map(
          Effect.orDie(port.find({}, { limit: Page.maxLimit })),
          (page) => page.items,
        ),
      }),
  ),
);

const createTable = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const dialect = yield* Dialect.current;
  yield* sql.unsafe(`CREATE TABLE companies (
    id ${dialect.idType} PRIMARY KEY,
    tenant_id ${dialect.idType} NOT NULL,
    legal_name text NOT NULL,
    trading_name text,
    registrations ${dialect.jsonType} NOT NULL,
    base_currency text NOT NULL,
    country text NOT NULL,
    locale text NOT NULL,
    time_zone text NOT NULL,
    fiscal_year_start ${dialect.jsonType} NOT NULL,
    rounding ${dialect.jsonType} NOT NULL,
    version integer NOT NULL,
    created_at ${dialect.timestampType} NOT NULL,
    created_by text NOT NULL,
    updated_at ${dialect.timestampType} NOT NULL,
    updated_by text NOT NULL,
    archived_at ${dialect.timestampType}
  )`);
}).pipe(Effect.orDie);

const services = Layer.mergeAll(
  companiesLayer,
  Layer.effectDiscard(createTable),
  Id.layerSequential,
).pipe(Layer.provideMerge(SqlUnitOfWork.layer()), Layer.provideMerge(TestingSql.layerSqlite));

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

const subject = {
  repository: Effect.service(Company.CompanyRepository),
  make: Effect.gen(function* () {
    const id = yield* Id.generate(Tenancy.CompanyId);
    return new Company.Company({ ...input, id, audit: yield* Audit.created });
  }),
  change: (company: Company.Company) =>
    new Company.Company({ ...Struct.omit(company, ["legalName"]), legalName: "Renamed Pty Ltd" }),
};

layer(services, { buildPerTest: true, excludeTestServices: true })(
  "Company's repository contract on SQLite",
  (it) => {
    Arr.forEach(Testing.repositoryContract(subject), (contractCase) =>
      it.effect(contractCase.name, () => contractCase.run),
    );
  },
);

layer(services, { buildPerTest: true, excludeTestServices: true })("Company on SQLite", (it) => {
  it.effect("creates, finds, updates and archives a company, its nested values intact", () =>
    Effect.gen(function* () {
      const created = yield* Company.create(input);
      expect(yield* Company.get(created.id)).toEqual(created);
      const found = yield* Company.find({
        search: "example",
        eq: { country: Company.CountryCode.make("AU") },
      });
      expect(Arr.map(found.items, (company) => company.id)).toEqual([created.id]);
      const renamed = yield* Company.update(subject.change(created));
      expect(renamed.audit.version).toBe(2);
      expect((yield* Company.get(created.id)).registrations).toEqual(input.registrations);
      yield* Company.archive(created.id, 2);
      expect(yield* Company.list).toEqual([]);
    }).pipe(
      Tenancy.withTenant(Tenancy.TenantId.make("0190a6e4-1c2d-7abc-8def-0000000000a1")),
      Actor.withActor(Actor.system("company-test")),
    ),
  );
});
