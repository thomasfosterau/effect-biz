/**
 * Companies: the legal entities a tenant holds, each with its own base
 * currency, country, fiscal-year start and rounding policy.
 *
 * A {@link Company} is shared by the operational and finance modules: the
 * ledger's periods, a document's base-currency amounts and the numbering
 * series all hang off it. {@link CompanyRepository} is its persistence port,
 * a `Repository.Port` (the conventions of `./Repository`), and every method
 * requires the {@link Tenancy.TenantContext}: a repository only ever sees
 * the current tenant's companies. {@link layerMemory} is the in-memory
 * implementation for tests, built on `./Memory`.
 *
 * See {@link create} for an example.
 *
 * @module
 */

import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as HashMap from "effect/HashMap";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Struct from "effect/Struct";
import type * as Actor from "./Actor.js";
import * as Audit from "./Audit.js";
import type * as BizError from "./BizError.js";
import * as Currency from "./Currency.js";
import * as Id from "./Id.js";
import * as Memory from "./Memory.js";
import type * as Page from "./Page.js";
import * as Query from "./Query.js";
import type * as Repository from "./Repository.js";
import * as Rounding from "./Rounding.js";
import * as Tenancy from "./Tenancy.js";

/** An ISO 3166-1 alpha-2 country code: two upper-case letters, such as `"AU"`. */
export const CountryCode = Schema.String.check(Schema.isPattern(/^[A-Z]{2}$/)).pipe(
  Schema.brand("CountryCode"),
);

/** An ISO 3166-1 alpha-2 country code. */
export type CountryCode = typeof CountryCode.Type;

/**
 * A registration identifier of a company under a named scheme (`"AU.ABN"`,
 * `"AU.ACN"`, `"GB.CRN"`). A locale package validates the value for the
 * schemes it knows; the core only requires both to be non-empty.
 */
export class Registration extends Schema.Class<Registration, { readonly brand: unique symbol }>(
  "@effect-biz/Company/Registration",
)({
  /** The scheme, namespaced by country: `"AU.ABN"`. */
  scheme: Schema.NonEmptyString,
  /** The identifier under that scheme. */
  value: Schema.NonEmptyString,
}) {}

/** The last day of each month in a non-leap year, so a fiscal year starts on the same day every year. */
const DAYS_IN_MONTH = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31] as const;

/**
 * The month and day a company's fiscal year starts (1 July for most
 * Australian companies). Informational here: the ledger owns the periods it
 * derives from it. 29 February is refused, since it does not recur.
 */
export class FiscalYearStart extends Schema.Class<
  FiscalYearStart,
  { readonly brand: unique symbol }
>("@effect-biz/Company/FiscalYearStart")(
  Schema.Struct({
    /** The month, from 1 (January) to 12. */
    month: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 12 })),
    /** The day of the month, from 1. */
    day: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 31 })),
  }).check(
    Schema.makeFilter(
      ({ month, day }) =>
        day <= (DAYS_IN_MONTH[month - 1] ?? 0) || `${month}-${day} is not a day every year has`,
      {
        identifier: "FiscalYearStart",
        title: "Fiscal-year start",
        description: "A month and day every year has (never 29 February)",
        expected: "a month and a day within it",
      },
    ),
  ),
) {}

/** The fields of a company, with the audit fields its repository keeps. */
export class Company extends Schema.Class<Company, { readonly brand: unique symbol }>(
  "@effect-biz/Company/Company",
)({
  /** The company's id. */
  id: Tenancy.CompanyId,
  /** The registered legal name. */
  legalName: Schema.NonEmptyString,
  /** The name it trades under, when that differs from the legal name. */
  tradingName: Schema.OptionFromNullOr(Schema.NonEmptyString),
  /** Its registration identifiers (business number, company number, …). */
  registrations: Schema.Array(Registration),
  /** The currency its books are kept in. */
  baseCurrency: Currency.CurrencyCode,
  /** The country it is registered in. */
  country: CountryCode,
  /** Its BCP 47 locale, for documents and formatting: `"en-AU"`. */
  locale: Schema.NonEmptyString,
  /** Its IANA time zone, for document dates: `"Australia/Sydney"`. */
  timeZone: Schema.NonEmptyString,
  /** Where its fiscal year starts. */
  fiscalYearStart: FiscalYearStart,
  /** How its money amounts are rounded (the rounding basis of its tax calculation). */
  rounding: Rounding.RoundingPolicy,
  /** Who created and last changed it, its version and archive state. */
  audit: Audit.AuditFields,
}) {}

/** What {@link create} takes: a company's fields without its id or audit fields. */
export type CreateInput = Omit<ConstructorParameters<typeof Company>[0], "id" | "audit">;

/**
 * The persistence port for companies, scoped to the current tenant: the
 * conventional `Repository.Port`, plus {@link list}.
 */
export class CompanyRepository extends Context.Service<
  CompanyRepository,
  Repository.Port<Company, Tenancy.CompanyId> & {
    /** Every active (not archived) company of the tenant, by id. */
    readonly list: Effect.Effect<ReadonlyArray<Company>, never, Tenancy.TenantContext>;
  }
>()("@effect-biz/Company/CompanyRepository") {}

/** The tenant's company with this id. */
export const get = (
  id: Tenancy.CompanyId,
): Effect.Effect<Company, BizError.NotFound, CompanyRepository | Tenancy.TenantContext> =>
  CompanyRepository.use((repository) => repository.get(id));

/** Every active (not archived) company of the tenant, by id. */
export const list: Effect.Effect<
  ReadonlyArray<Company>,
  never,
  CompanyRepository | Tenancy.TenantContext
> = CompanyRepository.use((repository) => repository.list);

/**
 * Replaces a stored company, guarded by its version; returns it at the next
 * version.
 */
export const update = (
  company: Company,
): Effect.Effect<
  Company,
  BizError.NotFound | BizError.ConcurrencyConflict,
  CompanyRepository | Repository.WriteContext
> => CompanyRepository.use((repository) => repository.update(company));

/** One page of the tenant's companies that match the query. */
export const find = (
  query: Query.Query<Company>,
  request?: Page.Request,
): Effect.Effect<
  Page.Page<Company>,
  BizError.ValidationError,
  CompanyRepository | Tenancy.TenantContext
> => CompanyRepository.use((repository) => repository.find(query, request));

/** Archives the company stored at `version`; returns it at the next version. */
export const archive = (
  id: Tenancy.CompanyId,
  version: number,
): Effect.Effect<
  Company,
  BizError.NotFound | BizError.ConcurrencyConflict | BizError.InvalidTransition,
  CompanyRepository | Repository.WriteContext
> => CompanyRepository.use((repository) => repository.archive(id, version));

/** Restores the archived company stored at `version`; returns it at the next version. */
export const restore = (
  id: Tenancy.CompanyId,
  version: number,
): Effect.Effect<
  Company,
  BizError.NotFound | BizError.ConcurrencyConflict | BizError.InvalidTransition,
  CompanyRepository | Repository.WriteContext
> => CompanyRepository.use((repository) => repository.restore(id, version));

/**
 * Creates a company for the current tenant: a fresh id, and audit fields
 * stamped with the current actor and time, at version 1.
 *
 * @example
 * ```ts
 * import { Effect, Layer, Option } from "effect";
 * import * as Actor from "@thomasfosterau/effect-biz/Actor";
 * import * as Company from "@thomasfosterau/effect-biz/Company";
 * import * as Currency from "@thomasfosterau/effect-biz/Currency";
 * import * as Id from "@thomasfosterau/effect-biz/Id";
 * import * as Rounding from "@thomasfosterau/effect-biz/Rounding";
 * import * as Tenancy from "@thomasfosterau/effect-biz/Tenancy";
 *
 * const program = Company.create({
 *   legalName: "Example Pty Ltd",
 *   tradingName: Option.some("Example"),
 *   registrations: [new Company.Registration({ scheme: "AU.ABN", value: "51824753556" })],
 *   baseCurrency: Currency.make("AUD"),
 *   country: Company.CountryCode.make("AU"),
 *   locale: "en-AU",
 *   timeZone: "Australia/Sydney",
 *   fiscalYearStart: new Company.FiscalYearStart({ month: 7, day: 1 }),
 *   rounding: new Rounding.RoundingPolicy({ mode: "half-even", scale: 2 }),
 * });
 *
 * const tenant = Tenancy.TenantId.make("0190a6e4-1c2d-7abc-8def-0123456789ab");
 * const company = Effect.runSync(
 *   program.pipe(
 *     Tenancy.withTenant(tenant),
 *     Actor.withActor(Actor.system("onboarding")),
 *     Effect.provide(Layer.merge(Company.layerMemory, Id.layerSequential)),
 *   ),
 * );
 * console.log(company.audit.version, company.audit.createdBy); // 1 "onboarding"
 * ```
 */
export const create: (
  input: CreateInput,
) => Effect.Effect<
  Company,
  BizError.AlreadyExists | BizError.ConcurrencyConflict,
  Id.IdGenerator | CompanyRepository | Tenancy.TenantContext | Actor.CurrentActor
> = Effect.fn("Company.create")(function* (input: CreateInput) {
  const id = yield* Id.generate(Tenancy.CompanyId);
  const audit = yield* Audit.created;
  const company = new Company({ ...input, id, audit });
  yield* CompanyRepository.use((repository) => repository.insert(company));
  return company;
});

/** The company with other audit fields, every other field unchanged. */
const withAudit = (company: Company, audit: Audit.AuditFields): Company =>
  new Company({ ...Struct.omit(company, ["audit"]), audit });

/**
 * An in-memory {@link CompanyRepository} over `./Memory`, partitioned by
 * tenant: a call reads and writes only its own tenant's rows, so another
 * tenant's company is `NotFound`. Each write decides and commits in one
 * atomic `Ref` update, so of two updates from the same version exactly one
 * succeeds. A query's `search` matches the legal name.
 */
export const layerMemory: Layer.Layer<CompanyRepository> = Layer.effect(
  CompanyRepository,
  Effect.map(Memory.makeStore<Tenancy.CompanyId, Company>(), (store) =>
    CompanyRepository.of({
      ...Memory.repository(store, {
        entity: "Company",
        withAudit,
        searchable: ["legalName"],
      }),
      list: Effect.map(Memory.rows(store), (rows) => Query.select(HashMap.values(rows), {})),
    }),
  ),
);
