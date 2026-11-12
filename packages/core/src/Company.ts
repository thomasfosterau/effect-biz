/**
 * Companies: the legal entities a tenant holds, each with its own base
 * currency, country, fiscal-year start and rounding policy.
 *
 * A {@link Company} is shared by the operational and finance modules: the
 * ledger's periods, a document's base-currency amounts and the numbering
 * series all hang off it. {@link CompanyRepository} is its persistence port,
 * and every method requires the {@link Tenancy.TenantContext}: a repository
 * only ever sees the current tenant's companies. {@link layerMemory} is the
 * in-memory implementation for tests; the SQL layer follows the repository
 * conventions (#28).
 *
 * See {@link create} for an example.
 *
 * @module
 */

import * as Arr from "effect/Array";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as HashMap from "effect/HashMap";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Order from "effect/Order";
import * as Ref from "effect/Ref";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as BizError from "./BizError.js";
import * as Currency from "./Currency.js";
import * as Id from "./Id.js";
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

/** The fields of a company, versioned by its repository. */
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
  /** The stored version: 1 when inserted, one more on each update. */
  version: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
}) {}

/** What {@link create} takes: a company's fields without its id or version. */
export type CreateInput = Omit<ConstructorParameters<typeof Company>[0], "id" | "version">;

/** The persistence port for companies, scoped to the current tenant. */
export class CompanyRepository extends Context.Service<
  CompanyRepository,
  {
    /** The tenant's company with this id. */
    readonly get: (
      id: Tenancy.CompanyId,
    ) => Effect.Effect<Company, BizError.NotFound, Tenancy.TenantContext>;
    /** Every company of the tenant, by id. */
    readonly list: Effect.Effect<ReadonlyArray<Company>, never, Tenancy.TenantContext>;
    /** Stores a new company for the tenant; its version must be 1. */
    readonly insert: (
      company: Company,
    ) => Effect.Effect<
      void,
      BizError.AlreadyExists | BizError.ConcurrencyConflict,
      Tenancy.TenantContext
    >;
    /**
     * Replaces a stored company, guarded by its version: `company.version` must
     * be the stored one, and the stored row becomes `company` at the next
     * version, which is returned.
     */
    readonly update: (
      company: Company,
    ) => Effect.Effect<
      Company,
      BizError.NotFound | BizError.ConcurrencyConflict,
      Tenancy.TenantContext
    >;
  }
>()("@effect-biz/Company/CompanyRepository") {}

/** The tenant's company with this id. */
export const get = (
  id: Tenancy.CompanyId,
): Effect.Effect<Company, BizError.NotFound, CompanyRepository | Tenancy.TenantContext> =>
  CompanyRepository.use((repository) => repository.get(id));

/** Every company of the tenant, by id. */
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
  CompanyRepository | Tenancy.TenantContext
> => CompanyRepository.use((repository) => repository.update(company));

/**
 * Creates a company for the current tenant: a fresh id, version 1.
 *
 * @example
 * ```ts
 * import { Effect, Layer, Option } from "effect";
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
 *     Effect.provide(Layer.merge(Company.layerMemory, Id.layerSequential)),
 *   ),
 * );
 * console.log(company.version); // 1
 * ```
 */
export const create = Effect.fn("Company.create")(function* (input: CreateInput) {
  const id = yield* Id.generate(Tenancy.CompanyId);
  const company = new Company({ ...input, id, version: 1 });
  yield* CompanyRepository.use((repository) => repository.insert(company));
  return company;
});

/** One tenant's companies, by id. */
type Rows = HashMap.HashMap<Tenancy.CompanyId, Company>;

/** Every tenant's rows: the in-memory store, partitioned by tenant. */
type Store = HashMap.HashMap<Tenancy.TenantId, Rows>;

/** A write's decision: the failure, or the store after it. */
type Decided<E> = Result.Result<Store, E>;

const rowsOf = (store: Store, tenantId: Tenancy.TenantId): Rows =>
  Option.getOrElse(HashMap.get(store, tenantId), () => HashMap.empty());

const notFound = (id: Tenancy.CompanyId): BizError.NotFound =>
  new BizError.NotFound({ entity: "Company", id });

const conflict = (
  id: Tenancy.CompanyId,
  expected: number,
  actual: number,
): BizError.ConcurrencyConflict =>
  new BizError.ConcurrencyConflict({ entity: "Company", id, expected, actual });

/** The company at another version, every other field unchanged. */
const atVersion = (company: Company, version: number): Company =>
  new Company({
    id: company.id,
    legalName: company.legalName,
    tradingName: company.tradingName,
    registrations: company.registrations,
    baseCurrency: company.baseCurrency,
    country: company.country,
    locale: company.locale,
    timeZone: company.timeZone,
    fiscalYearStart: company.fiscalYearStart,
    rounding: company.rounding,
    version,
  });

/** The store with the tenant's row for `company` set. */
const stored = (store: Store, tenantId: Tenancy.TenantId, company: Company): Store =>
  HashMap.set(store, tenantId, HashMap.set(rowsOf(store, tenantId), company.id, company));

/** Decides an insert against the tenant's rows: a fresh id, at version 1. */
const decideInsert = (
  store: Store,
  tenantId: Tenancy.TenantId,
  company: Company,
): Decided<BizError.AlreadyExists | BizError.ConcurrencyConflict> => {
  if (company.version !== 1) {
    return Result.fail(conflict(company.id, 1, company.version));
  }
  return HashMap.has(rowsOf(store, tenantId), company.id)
    ? Result.fail(new BizError.AlreadyExists({ entity: "Company", key: company.id }))
    : Result.succeed(stored(store, tenantId, company));
};

/** Decides an update against the tenant's rows: the stored version must match. */
const decideUpdate = (
  store: Store,
  tenantId: Tenancy.TenantId,
  next: Company,
): Decided<BizError.NotFound | BizError.ConcurrencyConflict> =>
  Option.match(HashMap.get(rowsOf(store, tenantId), next.id), {
    onNone: () => Result.fail(notFound(next.id)),
    onSome: (current) =>
      current.version === next.version - 1
        ? Result.succeed(stored(store, tenantId, next))
        : Result.fail(conflict(next.id, next.version - 1, current.version)),
  });

/**
 * Applies a decision atomically: the store changes only when `decide`
 * succeeds, and the effect fails with its failure otherwise.
 */
const commit = <E>(
  ref: Ref.Ref<Store>,
  decide: (store: Store) => Decided<E>,
): Effect.Effect<void, E> =>
  Effect.flatMap(
    Ref.modify(ref, (store) => {
      const decided = decide(store);
      return [decided, Result.getOrElse(decided, () => store)] as const;
    }),
    (decided) => Effect.asVoid(Effect.fromResult(decided)),
  );

/**
 * An in-memory {@link CompanyRepository}, partitioned by tenant: a call reads
 * and writes only its own tenant's rows, so another tenant's company is
 * `NotFound`. Each write decides and commits in one atomic `Ref` update, so of
 * two updates from the same version exactly one succeeds.
 */
export const layerMemory: Layer.Layer<CompanyRepository> = Layer.effect(
  CompanyRepository,
  Effect.map(Ref.make<Store>(HashMap.empty()), (ref) =>
    CompanyRepository.of({
      get: (id) =>
        Effect.flatMap(Tenancy.currentTenant, (tenantId) =>
          Effect.flatMap(Ref.get(ref), (store) =>
            Effect.mapError(Effect.fromOption(HashMap.get(rowsOf(store, tenantId), id)), () =>
              notFound(id),
            ),
          ),
        ),
      list: Effect.flatMap(Tenancy.currentTenant, (tenantId) =>
        Effect.map(Ref.get(ref), (store) =>
          Arr.sort(
            HashMap.values(rowsOf(store, tenantId)),
            Order.mapInput(Order.String, (company: Company) => company.id),
          ),
        ),
      ),
      insert: (company) =>
        Effect.flatMap(Tenancy.currentTenant, (tenantId) =>
          commit(ref, (store) => decideInsert(store, tenantId, company)),
        ),
      update: (company) =>
        Effect.flatMap(Tenancy.currentTenant, (tenantId) => {
          const next = atVersion(company, company.version + 1);
          return Effect.as(
            commit(ref, (store) => decideUpdate(store, tenantId, next)),
            next,
          );
        }),
    }),
  ),
);
