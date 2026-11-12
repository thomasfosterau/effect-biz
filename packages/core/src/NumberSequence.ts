/**
 * Document numbering: the sequences invoices, orders and other documents
 * take their numbers from, per company and document type.
 *
 * A {@link SequenceDefinition} says how a company numbers one document type:
 * a {@link Pattern} of literal text and tokens (`"INV-{YYYY}-{#}"`), the
 * counter's padding, when the counter resets ({@link ResetPeriod}, in the
 * company's time zone) and whether the sequence may have gaps
 * ({@link NumberingMode}). {@link define} creates or updates one;
 * {@link SequenceDefinitions} stores them per tenant, company and document
 * type. {@link next} issues the next number.
 *
 * - **A number is an attribute, never an identity.** A document keeps its
 *   UUIDv7 id; its number is a unique, searchable field. The sequence never
 *   issues a number twice, but enforcing the number's uniqueness among the
 *   documents (a unique index, a guarded insert) is the document's
 *   repository's concern.
 * - **Gap-less** (`"gap-less"`, the default): {@link next} reads the
 *   committed counter, decides the number purely and stages a write guarded
 *   by the counter it read (`UPDATE … WHERE period = ? AND last = ?` in
 *   SQL) into the open `UnitOfWork.transaction`'s batch. A concurrent
 *   command that took the number first makes the batch conflict, and the
 *   command is retried from its load step; a command that fails or rolls
 *   back consumes no number. Take at most one number per sequence per
 *   command: a second {@link next} in the same transaction reads the same
 *   committed counter and conflicts with the first.
 * - **Gaps allowed** (`"gaps-allowed"`): the increment commits at once,
 *   outside the command's batch, so it never conflicts and a rolled-back
 *   command leaves a gap. Still never a duplicate.
 *
 * See {@link next} for an example.
 *
 * @module
 */

import * as Arr from "effect/Array";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as HashMap from "effect/HashMap";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Order from "effect/Order";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as Struct from "effect/Struct";
import * as TxRef from "effect/TxRef";
import type * as Actor from "./Actor.js";
import * as Audit from "./Audit.js";
import * as BizError from "./BizError.js";
import * as Company from "./Company.js";
import * as Id from "./Id.js";
import * as Memory from "./Memory.js";
import type * as Repository from "./Repository.js";
import * as Tenancy from "./Tenancy.js";
import * as UnitOfWork from "./UnitOfWork.js";

/** The id of a sequence definition. */
export const SequenceId = Id.make("SequenceId");

/** A sequence definition's id. */
export type SequenceId = typeof SequenceId.Type;

/**
 * A document type a company numbers: lower-case, dot-separated words, the
 * owning module first (`"sales.invoice"`, `"purchasing.order"`).
 */
export const DocumentType = Schema.String.check(
  Schema.isPattern(/^[a-z][a-z0-9-]*(\.[a-z][a-z0-9-]*)*$/),
).pipe(Schema.brand("DocumentType"));

/** A document type. */
export type DocumentType = typeof DocumentType.Type;

/** A number issued by a sequence: the text a document carries as its number. */
export const DocumentNumber = Schema.NonEmptyString.pipe(Schema.brand("DocumentNumber"));

/** An issued document number. */
export type DocumentNumber = typeof DocumentNumber.Type;

/**
 * The tokens a {@link Pattern} may contain, each in braces:
 *
 * | Token | Value |
 * | --- | --- |
 * | `{YYYY}` | the calendar year, four digits |
 * | `{YY}` | the calendar year's last two digits |
 * | `{MM}` | the month, two digits |
 * | `{FY}` | the fiscal year, four digits, named by the year it ends in |
 * | `{FYY}` | the fiscal year's last two digits |
 * | `{COMPANY}` | the definition's `companyCode` |
 * | `{#}` | the counter, zero-padded to the definition's `padding` |
 *
 * Dates are the company's, in its time zone, at the moment the number is
 * issued.
 */
export const Token = Schema.Literals(["YYYY", "YY", "MM", "FY", "FYY", "COMPANY", "#"]);

/** A pattern token. */
export type Token = typeof Token.Type;

const isToken = Schema.is(Token);

/** A piece of a pattern: literal text, or a token's name (between its braces). */
interface Segment {
  /** Whether the piece is literal text or a token. */
  readonly kind: "text" | "token";
  /** The text, or the token's name. */
  readonly value: string;
}

/** A pattern's pieces, in order: a `{…}` without nested braces is a token, the rest is text. */
const segmentsOf = (pattern: string): ReadonlyArray<Segment> =>
  Arr.map(pattern.split(/(\{[^{}]*\})/), (piece, index): Segment =>
    index % 2 === 1 ? { kind: "token", value: piece.slice(1, -1) } : { kind: "text", value: piece },
  );

/** The token names of a pattern, in order. */
const tokensOf = (pattern: string): ReadonlyArray<string> =>
  Arr.filterMap(segmentsOf(pattern), (segment) =>
    segment.kind === "token" ? Result.succeed(segment.value) : Result.failVoid,
  );

/** What is wrong with a pattern, if anything. */
const patternProblem = (pattern: string): Option.Option<string> => {
  const segments = segmentsOf(pattern);
  const tokens = tokensOf(pattern);
  return Arr.head(
    Arr.getSomes([
      Option.map(
        Arr.findFirst(segments, (segment) => segment.kind === "text" && /[{}]/.test(segment.value)),
        () => "a brace outside a token",
      ),
      Option.map(
        Arr.findFirst(tokens, (name) => !isToken(name)),
        (name) => `unknown token {${name}}`,
      ),
      Arr.filter(tokens, (name) => name === "#").length === 1
        ? Option.none()
        : Option.some("exactly one {#} counter token is required"),
    ]),
  );
};

/** A filter that passes when `problem` finds nothing, and fails with its message otherwise. */
const passes = (problem: Option.Option<string>): true | string =>
  Option.match(problem, { onNone: () => true, onSome: (message) => message });

/**
 * A numbering pattern: literal text and {@link Token}s in braces, with
 * exactly one counter token `{#}`, such as `"INV-{YYYY}-{#}"`. An unknown
 * token, a stray brace or a missing (or second) `{#}` is a decode failure.
 */
export const Pattern = Schema.String.check(
  Schema.makeFilter((pattern: string) => passes(patternProblem(pattern)), {
    identifier: "Pattern",
    title: "Numbering pattern",
    description: "Text and {TOKEN}s, with exactly one {#} counter",
    expected: "a numbering pattern",
  }),
).pipe(Schema.brand("Pattern"));

/** A numbering pattern. */
export type Pattern = typeof Pattern.Type;

/**
 * When a sequence's counter goes back to 1: `"never"`, at each new calendar
 * year (`"yearly"`), fiscal year (`"fiscal-yearly"`, from the company's
 * `fiscalYearStart`) or month (`"monthly"`), each in the company's time
 * zone. A resetting sequence's pattern must carry the period, so a number
 * never repeats: `"yearly"` needs `{YYYY}` or `{YY}`, `"monthly"` one of
 * those and `{MM}`, `"fiscal-yearly"` `{FY}` or `{FYY}`.
 */
export const ResetPeriod = Schema.Literals(["never", "yearly", "fiscal-yearly", "monthly"]);

/** A reset period. */
export type ResetPeriod = typeof ResetPeriod.Type;

/**
 * Whether a sequence may skip numbers: `"gap-less"` takes the number in the
 * command's batch (a rolled-back command consumes none), `"gaps-allowed"`
 * takes it at once and never conflicts (a rolled-back command leaves a gap).
 */
export const NumberingMode = Schema.Literals(["gap-less", "gaps-allowed"]);

/** A numbering mode. */
export type NumberingMode = typeof NumberingMode.Type;

/** The counter's minimum width, from 1 to 18 digits. */
export const Padding = Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 18 }));

/** A counter's padding. */
export type Padding = typeof Padding.Type;

const hasAny = (tokens: ReadonlyArray<string>, wanted: ReadonlyArray<Token>): boolean =>
  Arr.some(wanted, (token) => Arr.contains(tokens, token));

/** The tokens each reset period's pattern needs, as alternatives per group. */
const periodTokens: Record<ResetPeriod, ReadonlyArray<ReadonlyArray<Token>>> = {
  never: [],
  yearly: [["YYYY", "YY"]],
  "fiscal-yearly": [["FY", "FYY"]],
  monthly: [["YYYY", "YY"], ["MM"]],
};

/** What is wrong with a definition's fields together, if anything. */
const definitionProblem = (fields: {
  readonly pattern: string;
  readonly reset: ResetPeriod;
  readonly companyCode: Option.Option<string>;
}): Option.Option<string> => {
  const tokens = tokensOf(fields.pattern);
  const missing = Arr.findFirst(periodTokens[fields.reset], (group) => !hasAny(tokens, group));
  return Arr.head(
    Arr.getSomes([
      Option.map(
        missing,
        (group) =>
          `a ${fields.reset} sequence's pattern needs ${Arr.map(group, (token) => `{${token}}`).join(" or ")}`,
      ),
      Arr.contains(tokens, "COMPANY") && Option.isNone(fields.companyCode)
        ? Option.some("a pattern with {COMPANY} needs a companyCode")
        : Option.none(),
    ]),
  );
};

/** How one company numbers one document type, with the audit fields its repository keeps. */
export class SequenceDefinition extends Schema.Class<
  SequenceDefinition,
  { readonly brand: unique symbol }
>("@effect-biz/NumberSequence/SequenceDefinition")(
  Schema.Struct({
    /** The definition's id. */
    id: SequenceId,
    /** The company that numbers with it. */
    companyId: Tenancy.CompanyId,
    /** The document type it numbers. */
    documentType: DocumentType,
    /** The pattern each number is formatted from. */
    pattern: Pattern,
    /** The counter's minimum width: `4` formats 7 as `0007`. */
    padding: Padding,
    /** When the counter resets to 1. */
    reset: ResetPeriod,
    /** Whether the sequence may skip numbers. */
    mode: NumberingMode,
    /** The company's code for `{COMPANY}`, such as `"SYD"`; required when the pattern has it. */
    companyCode: Schema.OptionFromNullOr(Schema.NonEmptyString),
    /** Who created and last changed it, and its version. */
    audit: Audit.AuditFields,
  }).check(
    Schema.makeFilter((fields) => passes(definitionProblem(fields)), {
      identifier: "SequenceDefinition",
      title: "Sequence definition",
      description: "A pattern that carries the reset period, and a code for {COMPANY}",
      expected: "a pattern consistent with its reset period and company code",
    }),
  ),
) {}

/**
 * The state of a sequence's counter: the period of the last number issued
 * (see {@link Period}) and that number's counter value.
 */
export class Counter extends Schema.Class<Counter, { readonly brand: unique symbol }>(
  "@effect-biz/NumberSequence/Counter",
)({
  /** The period key of the last number issued. */
  period: Schema.String,
  /** The counter value of the last number issued, from 1. */
  last: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
}) {}

/**
 * The period a number is issued in, in the company's time zone: its
 * calendar year and month, its fiscal year (named by the year it ends in)
 * and the key its counter is reset by.
 */
export interface Period {
  /** The reset key: `"all"`, `"2026"`, `"2026-12"` or `"FY2027"`, by the reset period. */
  readonly key: string;
  /** The calendar year. */
  readonly year: number;
  /** The month, from 1. */
  readonly month: number;
  /** The fiscal year, named by the calendar year it ends in. */
  readonly fiscalYear: number;
}

/**
 * The fiscal year a date falls in, named by the calendar year it ends in
 * (the Australian convention: 1 July 2026 to 30 June 2027 is FY2027). A
 * fiscal year that starts on 1 January is the calendar year.
 */
export const fiscalYearOf = (
  date: { readonly year: number; readonly month: number; readonly day: number },
  start: Company.FiscalYearStart,
): number => {
  const started = date.month > start.month || (date.month === start.month && date.day >= start.day);
  const startYear = started ? date.year : date.year - 1;
  return start.month === 1 && start.day === 1 ? startYear : startYear + 1;
};

const pad = (value: number, width: number): string => String(value).padStart(width, "0");

const periodKey = (reset: ResetPeriod, year: number, month: number, fiscalYear: number): string =>
  ({
    never: "all",
    yearly: pad(year, 4),
    "fiscal-yearly": `FY${pad(fiscalYear, 4)}`,
    monthly: `${pad(year, 4)}-${pad(month, 2)}`,
  })[reset];

/**
 * The period `at` falls in for a company, in its time zone (its IANA
 * `timeZone`); a time zone the runtime does not know is a
 * `BusinessRuleViolation` (`core.unknown-time-zone`).
 */
export const periodOf = (
  reset: ResetPeriod,
  company: Pick<Company.Company, "timeZone" | "fiscalYearStart">,
  at: DateTime.DateTime,
): Result.Result<Period, BizError.BusinessRuleViolation> =>
  Option.match(DateTime.zoneMakeNamed(company.timeZone), {
    onNone: () =>
      Result.fail(
        new BizError.BusinessRuleViolation({
          code: "core.unknown-time-zone",
          reason: "the company's time zone is not a known IANA time zone",
        }),
      ),
    onSome: (zone) => {
      const parts = DateTime.toParts(DateTime.setZone(at, zone));
      const fiscalYear = fiscalYearOf(parts, company.fiscalYearStart);
      return Result.succeed({
        key: periodKey(reset, parts.year, parts.month, fiscalYear),
        year: parts.year,
        month: parts.month,
        fiscalYear,
      });
    },
  });

/**
 * The counter after issuing one number in `period`: one past the last, or 1
 * when there is none yet or the period has changed (a reset).
 */
export const advance = (current: Option.Option<Counter>, period: Period): Counter =>
  new Counter({
    period: period.key,
    last: Option.match(
      Option.filter(current, (counter) => counter.period === period.key),
      { onNone: () => 1, onSome: (counter) => counter.last + 1 },
    ),
  });

/** Each token's text, for a definition, a period and a counter value. */
const tokenText = (
  token: Token,
  definition: SequenceDefinition,
  period: Period,
  value: number,
): string =>
  ({
    YYYY: pad(period.year, 4),
    YY: pad(period.year % 100, 2),
    MM: pad(period.month, 2),
    FY: pad(period.fiscalYear, 4),
    FYY: pad(period.fiscalYear % 100, 2),
    COMPANY: Option.getOrElse(definition.companyCode, () => ""),
    "#": pad(value, definition.padding),
  })[token];

/**
 * The number a definition formats for a period and counter value: its
 * pattern with each token replaced (see {@link Token}).
 */
export const format = (
  definition: SequenceDefinition,
  period: Period,
  value: number,
): DocumentNumber =>
  DocumentNumber.make(
    Arr.map(segmentsOf(definition.pattern), (segment) => {
      if (segment.kind === "text") {
        return segment.value;
      }
      return isToken(segment.value)
        ? tokenText(segment.value, definition, period, value)
        : `{${segment.value}}`;
    }).join(""),
  );

/**
 * The persistence port for sequence definitions, scoped to the current
 * tenant and keyed by company and document type (one definition each).
 */
export class SequenceDefinitions extends Context.Service<
  SequenceDefinitions,
  {
    /** The company's definition for the document type; `NotFound` without one. */
    readonly get: (
      companyId: Tenancy.CompanyId,
      documentType: DocumentType,
    ) => Effect.Effect<SequenceDefinition, BizError.NotFound, Tenancy.TenantContext>;
    /** Every definition of the company, by document type. */
    readonly list: (
      companyId: Tenancy.CompanyId,
    ) => Effect.Effect<ReadonlyArray<SequenceDefinition>, never, Tenancy.TenantContext>;
    /** Stores a new definition (at version 1); `AlreadyExists` when the type has one. */
    readonly insert: (
      definition: SequenceDefinition,
    ) => Effect.Effect<
      void,
      BizError.AlreadyExists | BizError.ConcurrencyConflict,
      Tenancy.TenantContext
    >;
    /** Replaces a stored definition, guarded by its version; returns it at the next version. */
    readonly update: (
      definition: SequenceDefinition,
    ) => Effect.Effect<
      SequenceDefinition,
      BizError.NotFound | BizError.ConcurrencyConflict,
      Repository.WriteContext
    >;
  }
>()("@effect-biz/NumberSequence/SequenceDefinitions") {}

/** The numbering port: issues the next number of a company's sequence. */
export class NumberSequences extends Context.Service<
  NumberSequences,
  {
    /**
     * The next number of the company's sequence for the document type, in
     * the current `UnitOfWork.transaction` (or one of its own outside one).
     * `NotFound` when the type has no definition (or the company does not
     * exist).
     */
    readonly next: (
      companyId: Tenancy.CompanyId,
      documentType: DocumentType,
    ) => Effect.Effect<
      DocumentNumber,
      BizError.NotFound | BizError.BusinessRuleViolation | BizError.ConcurrencyConflict,
      Tenancy.TenantContext
    >;
  }
>()("@effect-biz/NumberSequence/NumberSequences") {}

/**
 * Issues the next number of the company's sequence for the document type.
 * Call it inside the command's `UnitOfWork.transaction`: in gap-less mode
 * the number is taken in the command's batch, so a command that fails
 * consumes none.
 *
 * @example
 * ```ts
 * import { Effect, Layer, Option } from "effect";
 * import * as Actor from "@thomasfosterau/effect-biz/Actor";
 * import * as Company from "@thomasfosterau/effect-biz/Company";
 * import * as Currency from "@thomasfosterau/effect-biz/Currency";
 * import * as Id from "@thomasfosterau/effect-biz/Id";
 * import * as NumberSequence from "@thomasfosterau/effect-biz/NumberSequence";
 * import * as Rounding from "@thomasfosterau/effect-biz/Rounding";
 * import * as Tenancy from "@thomasfosterau/effect-biz/Tenancy";
 * import * as UnitOfWork from "@thomasfosterau/effect-biz/UnitOfWork";
 *
 * const invoice = NumberSequence.DocumentType.make("sales.invoice");
 *
 * const program = Effect.gen(function* () {
 *   const company = yield* Company.create({
 *     legalName: "Example Pty Ltd",
 *     tradingName: Option.none(),
 *     registrations: [],
 *     baseCurrency: Currency.make("AUD"),
 *     country: Company.CountryCode.make("AU"),
 *     locale: "en-AU",
 *     timeZone: "Australia/Sydney",
 *     fiscalYearStart: new Company.FiscalYearStart({ month: 7, day: 1 }),
 *     rounding: new Rounding.RoundingPolicy({ mode: "half-even", scale: 2 }),
 *   });
 *   yield* NumberSequence.define({
 *     companyId: company.id,
 *     documentType: invoice,
 *     pattern: NumberSequence.Pattern.make("INV-{#}"),
 *     padding: 5,
 *   });
 *   // A command takes its number inside its own transaction.
 *   const first = yield* UnitOfWork.transaction(NumberSequence.next(company.id, invoice));
 *   const second = yield* UnitOfWork.transaction(NumberSequence.next(company.id, invoice));
 *   return [first, second];
 * });
 *
 * const layer = NumberSequence.layerMemory.pipe(
 *   Layer.provideMerge(Layer.mergeAll(Company.layerMemory, UnitOfWork.layerMemory, Id.layerSequential)),
 * );
 * const tenant = Tenancy.TenantId.make("0190a6e4-1c2d-7abc-8def-0123456789ab");
 * const numbers = Effect.runSync(
 *   program.pipe(
 *     Effect.provide(layer),
 *     Tenancy.withTenant(tenant),
 *     Actor.withActor(Actor.system("example")),
 *   ),
 * );
 * console.log(numbers); // ["INV-00001", "INV-00002"]
 * ```
 */
export const next = (
  companyId: Tenancy.CompanyId,
  documentType: DocumentType,
): Effect.Effect<
  DocumentNumber,
  BizError.NotFound | BizError.BusinessRuleViolation | BizError.ConcurrencyConflict,
  NumberSequences | Tenancy.TenantContext
> => NumberSequences.use((sequences) => sequences.next(companyId, documentType));

/** The company's definition for the document type; `NotFound` without one. */
export const get = (
  companyId: Tenancy.CompanyId,
  documentType: DocumentType,
): Effect.Effect<
  SequenceDefinition,
  BizError.NotFound,
  SequenceDefinitions | Tenancy.TenantContext
> => SequenceDefinitions.use((definitions) => definitions.get(companyId, documentType));

/** Every sequence definition of the company. */
export const list = (
  companyId: Tenancy.CompanyId,
): Effect.Effect<
  ReadonlyArray<SequenceDefinition>,
  never,
  SequenceDefinitions | Tenancy.TenantContext
> => SequenceDefinitions.use((definitions) => definitions.list(companyId));

/**
 * What {@link define} takes: the company and document type, the pattern,
 * and optionally the padding (default 4), reset period (default `"never"`),
 * mode (default `"gap-less"`) and the company code for `{COMPANY}`.
 */
export interface DefineInput {
  /** The company that numbers with it. */
  readonly companyId: Tenancy.CompanyId;
  /** The document type it numbers. */
  readonly documentType: DocumentType;
  /** The pattern each number is formatted from. */
  readonly pattern: Pattern;
  /** The counter's minimum width. Default 4. */
  readonly padding?: number;
  /** When the counter resets to 1. Default `"never"`. */
  readonly reset?: ResetPeriod;
  /** Whether the sequence may skip numbers. Default `"gap-less"`. */
  readonly mode?: NumberingMode;
  /** The code `{COMPANY}` is replaced with. */
  readonly companyCode?: string;
}

/** The definition's fields from the input, before its id and audit fields. */
const fieldsOf = (input: DefineInput) => ({
  companyId: input.companyId,
  documentType: input.documentType,
  pattern: input.pattern,
  padding: input.padding ?? 4,
  reset: input.reset ?? "never",
  mode: input.mode ?? "gap-less",
  companyCode: Option.fromUndefinedOr(input.companyCode),
});

/** Builds a definition, a `ValidationError` when its fields do not fit together. */
const build = (
  fields: ConstructorParameters<typeof SequenceDefinition>[0],
): Effect.Effect<SequenceDefinition, BizError.ValidationError> =>
  Effect.mapError(SequenceDefinition.makeEffect(fields), (issue) =>
    BizError.fromSchemaError(new Schema.SchemaError(issue)),
  );

/**
 * Defines how the company numbers a document type, or redefines it: a new
 * definition at version 1, or the stored one updated at its next version
 * (its counter carries on). `NotFound` for an unknown company, and a
 * `ValidationError` when the pattern does not carry the reset period or
 * uses `{COMPANY}` without a `companyCode`. Runs as one
 * `UnitOfWork.transaction`.
 */
export const define: (
  input: DefineInput,
) => Effect.Effect<
  SequenceDefinition,
  | BizError.NotFound
  | BizError.AlreadyExists
  | BizError.ConcurrencyConflict
  | BizError.ValidationError,
  | SequenceDefinitions
  | Company.CompanyRepository
  | UnitOfWork.UnitOfWork
  | Id.IdGenerator
  | Tenancy.TenantContext
  | Actor.CurrentActor
> = (input) =>
  UnitOfWork.transaction(
    Effect.gen(function* () {
      const definitions = yield* SequenceDefinitions;
      yield* Company.get(input.companyId);
      const existing = yield* Effect.option(definitions.get(input.companyId, input.documentType));
      const fields = fieldsOf(input);
      if (Option.isSome(existing)) {
        const { id, audit } = existing.value;
        return yield* definitions.update(yield* build({ ...fields, id, audit }));
      }
      const definition = yield* build({
        ...fields,
        id: yield* Id.generate(SequenceId),
        audit: yield* Audit.created,
      });
      yield* definitions.insert(definition);
      return definition;
    }),
  );

/** The store key of a company's sequence for a document type. */
const keyOf = (companyId: Tenancy.CompanyId, documentType: DocumentType): string =>
  `${companyId}/${documentType}`;

const ENTITY = "SequenceDefinition";

/** The definition with other audit fields, every other field unchanged. */
const withAudit = (definition: SequenceDefinition, audit: Audit.AuditFields): SequenceDefinition =>
  new SequenceDefinition({ ...Struct.omit(definition, ["audit"]), audit });

/** Sequence definitions over `./Memory`, keyed by company and document type. */
const makeDefinitions = Effect.map(
  Memory.makeStore<string, SequenceDefinition>(),
  (store): SequenceDefinitions["Service"] => {
    const lookup = (key: string) =>
      Effect.flatMap(Memory.rows(store), (rows) =>
        Effect.fromOption(
          HashMap.get(rows, key),
          () => new BizError.NotFound({ entity: ENTITY, id: key }),
        ),
      );
    return SequenceDefinitions.of({
      get: (companyId, documentType) => lookup(keyOf(companyId, documentType)),
      list: (companyId) =>
        Effect.map(Memory.rows(store), (rows) =>
          Arr.sortWith(
            Arr.filter(
              Arr.fromIterable(HashMap.values(rows)),
              (row) => row.companyId === companyId,
            ),
            (row) => row.documentType,
            Order.String,
          ),
        ),
      insert: (definition) => {
        const key = keyOf(definition.companyId, definition.documentType);
        return Effect.flatMap(
          Memory.rows(store),
          (
            rows,
          ): Effect.Effect<
            void,
            BizError.AlreadyExists | BizError.ConcurrencyConflict,
            Tenancy.TenantContext
          > =>
            HashMap.has(rows, key)
              ? Effect.fail(new BizError.AlreadyExists({ entity: ENTITY, key }))
              : Memory.put(store, { entity: ENTITY, id: key, expected: 0, row: definition }),
        );
      },
      update: (definition) => {
        const key = keyOf(definition.companyId, definition.documentType);
        const version = definition.audit.version;
        return Effect.gen(function* () {
          const stored = yield* lookup(key);
          if (stored.id !== definition.id) {
            return yield* new BizError.NotFound({ entity: ENTITY, id: definition.id });
          }
          if (stored.audit.version !== version) {
            return yield* new BizError.ConcurrencyConflict({
              entity: ENTITY,
              id: key,
              expected: version,
              actual: stored.audit.version,
            });
          }
          const row = withAudit(definition, Audit.next(stored.audit, yield* Audit.stamp));
          yield* Memory.put(store, { entity: ENTITY, id: key, expected: version, row });
          return row;
        });
      },
    });
  },
);

/** Whether a stored counter is still the one a command read. */
const sameCounter = Option.makeEquivalence(
  (left: Counter, right: Counter) => left.period === right.period && left.last === right.last,
);

const lastOf = (counter: Option.Option<Counter>): number =>
  Option.match(counter, { onNone: () => 0, onSome: (stored) => stored.last });

/** The counter rows of one tenant, by sequence key. */
type CounterRows = Memory.Rows<string, Counter>;

const counterRowsOf = (
  partitions: Memory.Partitions<string, Counter>,
  tenantId: Tenancy.TenantId,
): CounterRows => Option.getOrElse(HashMap.get(partitions, tenantId), () => HashMap.empty());

/**
 * The gap-less write: the counter must still be what the command read (the
 * same period and last value, or none), else the batch conflicts.
 */
const guardedCounter = (
  store: Memory.Store<string, Counter>,
  tenantId: Tenancy.TenantId,
  key: string,
  read: Option.Option<Counter>,
  replacement: Counter,
): UnitOfWork.MemoryWrite =>
  Effect.flatMap(
    TxRef.modify(
      store.partitions,
      (
        partitions,
      ): [
        Result.Result<void, BizError.ConcurrencyConflict>,
        Memory.Partitions<string, Counter>,
      ] => {
        const rows = counterRowsOf(partitions, tenantId);
        const stored = HashMap.get(rows, key);
        return sameCounter(stored, read)
          ? [
              Result.succeed(undefined),
              HashMap.set(partitions, tenantId, HashMap.set(rows, key, replacement)),
            ]
          : [
              Result.fail(
                new BizError.ConcurrencyConflict({
                  entity: "NumberSequence",
                  id: key,
                  expected: lastOf(read),
                  actual: lastOf(stored),
                }),
              ),
              partitions,
            ];
      },
    ),
    Effect.fromResult,
  );

/** The gaps-allowed increment: one atomic step on the committed counter, outside any batch. */
const incrementNow = (
  store: Memory.Store<string, Counter>,
  tenantId: Tenancy.TenantId,
  key: string,
  period: Period,
): Effect.Effect<Counter> =>
  Effect.tx(
    TxRef.modify(store.partitions, (partitions): [Counter, Memory.Partitions<string, Counter>] => {
      const rows = counterRowsOf(partitions, tenantId);
      const counter = advance(HashMap.get(rows, key), period);
      return [counter, HashMap.set(partitions, tenantId, HashMap.set(rows, key, counter))];
    }),
  );

/** Numbers over `./Memory` counters, the definitions and companies given, in `unitOfWork`. */
const makeNumbers = Effect.fnUntraced(function* () {
  const definitions = yield* SequenceDefinitions;
  const companies = yield* Company.CompanyRepository;
  const unitOfWork = yield* UnitOfWork.UnitOfWork;
  const store = yield* Memory.makeStore<string, Counter>();
  const take = (
    tenantId: Tenancy.TenantId,
    key: string,
    mode: NumberingMode,
    period: Period,
  ): Effect.Effect<Counter, BizError.ConcurrencyConflict> =>
    mode === "gaps-allowed"
      ? incrementNow(store, tenantId, key, period)
      : Effect.flatMap(TxRef.get(store.partitions), (partitions) => {
          const read = HashMap.get(counterRowsOf(partitions, tenantId), key);
          const counter = advance(read, period);
          return Effect.as(
            UnitOfWork.stage(
              UnitOfWork.memoryJournal,
              guardedCounter(store, tenantId, key, read, counter),
              UnitOfWork.commitMemory,
            ),
            counter,
          );
        });
  return NumberSequences.of({
    next: (companyId, documentType) =>
      unitOfWork.transaction(
        Effect.gen(function* () {
          const tenantId = yield* Tenancy.currentTenant;
          const definition = yield* definitions.get(companyId, documentType);
          const company = yield* companies.get(companyId);
          const period = yield* Effect.fromResult(
            periodOf(definition.reset, company, yield* DateTime.now),
          );
          const counter = yield* take(
            tenantId,
            keyOf(companyId, documentType),
            definition.mode,
            period,
          );
          return format(definition, period, counter.last);
        }),
      ),
  });
});

/**
 * The in-memory {@link NumberSequences} and {@link SequenceDefinitions},
 * for tests and embedded hosts: tenant-partitioned `TxRef` stores (built on
 * `./Memory`), reading companies from the `Company.CompanyRepository` and
 * staging gap-less counter writes into the in-memory `UnitOfWork`'s batch.
 */
export const layerMemory: Layer.Layer<
  NumberSequences | SequenceDefinitions,
  never,
  Company.CompanyRepository | UnitOfWork.UnitOfWork
> = Layer.effect(NumberSequences, makeNumbers()).pipe(
  Layer.provideMerge(Layer.effect(SequenceDefinitions, makeDefinitions)),
);
