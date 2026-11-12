# Tenancy, companies and actors

Every repository call knows which tenant it acts for, every command which company, and every write who is acting. See also [identifiers and errors](ids-and-errors.md).

## Tenants and companies (`./Tenancy`)

A tenant is the isolation boundary: every row carries its `tenant_id`, and a repository reads and writes only the rows of the `TenantContext` it runs under. Within a tenant, a `CompanyContext` names the company (legal entity) a command acts for. Both are services in `R`, so a command run without them does not compile. The host provides them per request:

```ts
import { Effect } from "effect";
import * as Tenancy from "@thomasfosterau/effect-biz/Tenancy";

const tenant = Tenancy.TenantId.make("0190a6e4-1c2d-7abc-8def-0123456789ab");
const company = Tenancy.CompanyId.make("0190a6e4-1c2d-7abc-8def-0123456789ac");

const program = Effect.all([Tenancy.currentTenant, Tenancy.currentCompany]);

console.log(Effect.runSync(program.pipe(Tenancy.withCompany(company), Tenancy.withTenant(tenant))));
```

Tenancy is independent of effect-auth's Organizations (#130). Whether all tenants share one database or each has its own is the host's choice, through the `TenantDatabase` resolver (#129).

## Companies (`./Company`)

A `Company` holds what the operational and finance modules share: its legal and trading names, registration identifiers (`AU.ABN`, …, validated by a locale package), base currency, country, locale, time zone, fiscal-year start and rounding policy. `CompanyRepository` is its persistence port, a conventional repository port ([repositories](repositories.md)); every method requires the `TenantContext`, so another tenant's company is simply `NotFound`. A company carries its audit fields (`company.audit`: created and updated by whom and when, its `version` and archive state), so `Company.create` also requires the `CurrentActor`. Writes are guarded by `audit.version`: of two updates from the same version, exactly one succeeds and the other fails with `ConcurrencyConflict`. `Company.archive` / `restore` take a company out of `list` and `find` and back.

```ts
import { Effect, Layer, Option } from "effect";
import * as Actor from "@thomasfosterau/effect-biz/Actor";
import * as Company from "@thomasfosterau/effect-biz/Company";
import * as Currency from "@thomasfosterau/effect-biz/Currency";
import * as Id from "@thomasfosterau/effect-biz/Id";
import * as Rounding from "@thomasfosterau/effect-biz/Rounding";
import * as Tenancy from "@thomasfosterau/effect-biz/Tenancy";

const program = Effect.gen(function* () {
  const created = yield* Company.create({
    legalName: "Example Pty Ltd",
    tradingName: Option.none(),
    registrations: [],
    baseCurrency: Currency.make("AUD"),
    country: Company.CountryCode.make("AU"),
    locale: "en-AU",
    timeZone: "Australia/Sydney",
    fiscalYearStart: new Company.FiscalYearStart({ month: 7, day: 1 }),
    rounding: new Rounding.RoundingPolicy({ mode: "half-even", scale: 2 }),
  });
  return yield* Company.get(created.id);
});

const tenant = Tenancy.TenantId.make("0190a6e4-1c2d-7abc-8def-0123456789ab");
const company = Effect.runSync(
  program.pipe(
    Tenancy.withTenant(tenant),
    Actor.withActor(Actor.system("onboarding")),
    Effect.provide(Layer.merge(Company.layerMemory, Id.layerSequential)),
  ),
);
console.log(company.legalName, company.audit.version); // "Example Pty Ltd" 1
```

`Company.layerMemory` is for tests and embedded hosts, built on `./Memory`; a SQL layer follows the same [repository conventions](repositories.md) and passes the same contract suite.

## Actors (`./Actor`)

An `Actor` is who is acting: a `user`, a `system` process or an `integration`, with the host's id for it and a display name. A command reads it from `CurrentActor` for its audit fields (`createdBy` / `updatedBy` hold the actor's id) and approvals; the host provides it with `Actor.withActor`, and an effect-auth adapter derives it from effect-auth's `CurrentPrincipal` (#130). The display name is personal data: never log it or put it in an error.
