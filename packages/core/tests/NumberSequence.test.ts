import { describe, expect } from "vite-plus/test";
import { it, layer } from "@effect/vitest";
import * as Arr from "effect/Array";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as Struct from "effect/Struct";
import * as TestClock from "effect/testing/TestClock";
import * as Actor from "../src/Actor.ts";
import * as BizError from "../src/BizError.ts";
import * as Company from "../src/Company.ts";
import * as Currency from "../src/Currency.ts";
import * as Id from "../src/Id.ts";
import * as NumberSequence from "../src/NumberSequence.ts";
import * as Rounding from "../src/Rounding.ts";
import * as Tenancy from "../src/Tenancy.ts";
import * as Testing from "../src/testing.ts";
import * as UnitOfWork from "../src/UnitOfWork.ts";

const memory = NumberSequence.layerMemory.pipe(
  Layer.provideMerge(
    Layer.mergeAll(Company.layerMemory, UnitOfWork.layerMemory, Id.layerSequential),
  ),
);

layer(memory, { buildPerTest: true, excludeTestServices: true })(
  "the numbering contract over Memory",
  (it) => {
    Arr.forEach(Testing.numberSequencesContract(), (contractCase) =>
      it.effect(contractCase.name, () => contractCase.run),
    );
  },
);

const tenant = Tenancy.TenantId.make("0190a6e4-1c2d-7abc-8def-0000000000a1");
const actor = Actor.system("test");

const companyIn = (timeZone: string) =>
  Company.create({
    legalName: "Example Pty Ltd",
    tradingName: Option.none(),
    registrations: [],
    baseCurrency: Currency.make("AUD"),
    country: Company.CountryCode.make("AU"),
    locale: "en-AU",
    timeZone,
    fiscalYearStart: new Company.FiscalYearStart({ month: 7, day: 1 }),
    rounding: new Rounding.RoundingPolicy({ mode: "half-even", scale: 2 }),
  });

const invoice = NumberSequence.DocumentType.make("sales.invoice");
const order = NumberSequence.DocumentType.make("sales.order");
const pattern = (value: string) => NumberSequence.Pattern.make(value);

const at = (iso: string) => TestClock.setTime(DateTime.toEpochMillis(DateTime.makeUnsafe(iso)));

const take = (companyId: Tenancy.CompanyId, documentType = invoice) =>
  UnitOfWork.transaction(NumberSequence.next(companyId, documentType));

const decodes = Schema.is(NumberSequence.Pattern);

describe("Pattern", () => {
  it("accepts text and known tokens with exactly one counter", () => {
    expect(decodes("INV-{YYYY}{MM}-{#}")).toBe(true);
    expect(decodes("{COMPANY}/{FY}/{FYY}/{YY}/{#}")).toBe(true);
    expect(decodes("{#}")).toBe(true);
  });

  it("refuses an unknown token, a stray brace, and no or two counters", () => {
    const problem = (value: string) =>
      Result.match(Schema.decodeResult(NumberSequence.Pattern)(value), {
        onFailure: (error) => String(error),
        onSuccess: () => "decoded",
      });
    expect(problem("INV-{DD}-{#}")).toContain("unknown token {DD}");
    expect(problem("INV-{#}}")).toContain("a brace outside a token");
    expect(problem("INV-{YYYY")).toContain("a brace outside a token");
    expect(problem("INV-{YYYY}")).toContain("exactly one {#}");
    expect(problem("{#}-{#}")).toContain("exactly one {#}");
  });
});

describe("fiscalYearOf", () => {
  const july = new Company.FiscalYearStart({ month: 7, day: 1 });
  const january = new Company.FiscalYearStart({ month: 1, day: 1 });
  const midApril = new Company.FiscalYearStart({ month: 4, day: 15 });

  it("names a fiscal year by the year it ends in", () => {
    expect(NumberSequence.fiscalYearOf({ year: 2026, month: 6, day: 30 }, july)).toBe(2026);
    expect(NumberSequence.fiscalYearOf({ year: 2026, month: 7, day: 1 }, july)).toBe(2027);
    expect(NumberSequence.fiscalYearOf({ year: 2026, month: 4, day: 14 }, midApril)).toBe(2026);
    expect(NumberSequence.fiscalYearOf({ year: 2026, month: 4, day: 15 }, midApril)).toBe(2027);
  });

  it("makes a fiscal year from 1 January the calendar year", () => {
    expect(NumberSequence.fiscalYearOf({ year: 2026, month: 1, day: 1 }, january)).toBe(2026);
    expect(NumberSequence.fiscalYearOf({ year: 2026, month: 12, day: 31 }, january)).toBe(2026);
  });
});

describe("periodOf and advance", () => {
  const sydney = {
    timeZone: "Australia/Sydney",
    fiscalYearStart: new Company.FiscalYearStart({ month: 7, day: 1 }),
  };
  const moment = DateTime.makeUnsafe("2027-06-30T14:30:00Z"); // 00:30 on 1 July 2027 in Sydney

  it("keys each reset period in the company's time zone", () => {
    const keyOf = (reset: NumberSequence.ResetPeriod) =>
      Result.map(NumberSequence.periodOf(reset, sydney, moment), (period) => period.key);
    expect(keyOf("never")).toEqual(Result.succeed("all"));
    expect(keyOf("yearly")).toEqual(Result.succeed("2027"));
    expect(keyOf("monthly")).toEqual(Result.succeed("2027-07"));
    expect(keyOf("fiscal-yearly")).toEqual(Result.succeed("FY2028"));
  });

  it("refuses a time zone the runtime does not know", () => {
    const period = NumberSequence.periodOf(
      "yearly",
      { ...sydney, timeZone: "Mars/Olympus" },
      moment,
    );
    expect(Result.isFailure(period) && period.failure.code).toBe("core.unknown-time-zone");
  });

  it("counts on within a period and resets in a new one", () => {
    const period: NumberSequence.Period = { key: "2027", year: 2027, month: 1, fiscalYear: 2027 };
    const first = NumberSequence.advance(Option.none(), period);
    expect(first.last).toBe(1);
    expect(NumberSequence.advance(Option.some(first), period).last).toBe(2);
    const stale = new NumberSequence.Counter({ period: "2026", last: 41 });
    expect(NumberSequence.advance(Option.some(stale), period)).toEqual(first);
  });
});

layer(memory)("NumberSequence over Memory", (it) => {
  it.effect("formats every token, and resets a monthly sequence in the company's month", () =>
    Effect.gen(function* () {
      const company = yield* companyIn("Australia/Sydney");
      yield* NumberSequence.define({
        companyId: company.id,
        documentType: invoice,
        pattern: pattern("{COMPANY}/{YY}{MM}/{FY}-{FYY}/{#}"),
        padding: 3,
        reset: "monthly",
        companyCode: "SYD",
      });
      yield* at("2027-06-30T13:30:00Z"); // 23:30 on 30 June in Sydney
      expect(yield* take(company.id)).toBe("SYD/2706/2027-27/001");
      expect(yield* take(company.id)).toBe("SYD/2706/2027-27/002");
      yield* at("2027-06-30T14:30:00Z"); // 00:30 on 1 July
      expect(yield* take(company.id)).toBe("SYD/2707/2028-28/001");
    }).pipe(Tenancy.withTenant(tenant), Actor.withActor(actor)),
  );

  it.effect("resets a fiscal-yearly sequence at the company's fiscal year", () =>
    Effect.gen(function* () {
      const company = yield* companyIn("Australia/Sydney");
      yield* NumberSequence.define({
        companyId: company.id,
        documentType: invoice,
        pattern: pattern("FY{FYY}-{#}"),
        reset: "fiscal-yearly",
      });
      yield* at("2027-06-30T13:30:00Z");
      expect(yield* take(company.id)).toBe("FY27-0001");
      yield* at("2027-06-30T14:30:00Z");
      expect(yield* take(company.id)).toBe("FY28-0001");
      expect(yield* take(company.id)).toBe("FY28-0002");
    }).pipe(Tenancy.withTenant(tenant), Actor.withActor(actor)),
  );

  it.effect("takes a number in a transaction of its own outside one", () =>
    Effect.gen(function* () {
      const company = yield* companyIn("UTC");
      yield* NumberSequence.define({
        companyId: company.id,
        documentType: invoice,
        pattern: pattern("{#}"),
      });
      expect(yield* NumberSequence.next(company.id, invoice)).toBe("0001");
      expect(yield* NumberSequence.next(company.id, invoice)).toBe("0002");
    }).pipe(Tenancy.withTenant(tenant), Actor.withActor(actor)),
  );

  it.effect("redefines a sequence at its next version, its counter carrying on", () =>
    Effect.gen(function* () {
      const company = yield* companyIn("UTC");
      const first = yield* NumberSequence.define({
        companyId: company.id,
        documentType: invoice,
        pattern: pattern("A-{#}"),
      });
      yield* NumberSequence.define({
        companyId: company.id,
        documentType: order,
        pattern: pattern("O-{#}"),
      });
      expect(yield* take(company.id)).toBe("A-0001");
      const second = yield* NumberSequence.define({
        companyId: company.id,
        documentType: invoice,
        pattern: pattern("B-{#}"),
        padding: 2,
        mode: "gaps-allowed",
      });
      expect(second.id).toBe(first.id);
      expect(second.audit.version).toBe(2);
      expect(yield* NumberSequence.get(company.id, invoice)).toEqual(second);
      expect(
        Arr.map(yield* NumberSequence.list(company.id), (definition) => definition.documentType),
      ).toEqual([invoice, order]);
      expect(yield* take(company.id)).toBe("B-02");
    }).pipe(Tenancy.withTenant(tenant), Actor.withActor(actor)),
  );

  it.effect("refuses a definition whose pattern lacks its period or company code", () =>
    Effect.gen(function* () {
      const company = yield* companyIn("UTC");
      const yearly = yield* Effect.flip(
        NumberSequence.define({
          companyId: company.id,
          documentType: invoice,
          pattern: pattern("INV-{#}"),
          reset: "yearly",
        }),
      );
      expect(yearly._tag).toBe("ValidationError");
      expect(yearly.message).toContain("needs {YYYY} or {YY}");
      const coded = yield* Effect.flip(
        NumberSequence.define({
          companyId: company.id,
          documentType: invoice,
          pattern: pattern("{COMPANY}-{#}"),
        }),
      );
      expect(coded.message).toContain("needs a companyCode");
      expect(yield* Effect.flip(NumberSequence.get(company.id, invoice))).toEqual(
        new BizError.NotFound({ entity: "SequenceDefinition", id: `${company.id}/${invoice}` }),
      );
    }).pipe(Tenancy.withTenant(tenant), Actor.withActor(actor)),
  );

  it.effect("defines only for a company of the tenant", () =>
    Effect.gen(function* () {
      const missing = Tenancy.CompanyId.make("0190a6e4-1c2d-7abc-8def-0000000000ff");
      const error = yield* Effect.flip(
        NumberSequence.define({
          companyId: missing,
          documentType: invoice,
          pattern: pattern("{#}"),
        }),
      );
      expect(error).toEqual(new BizError.NotFound({ entity: "Company", id: missing }));
    }).pipe(Tenancy.withTenant(tenant), Actor.withActor(actor)),
  );

  it.effect("fails next for a company whose time zone is unknown", () =>
    Effect.gen(function* () {
      const company = yield* companyIn("Mars/Olympus");
      yield* NumberSequence.define({
        companyId: company.id,
        documentType: invoice,
        pattern: pattern("{#}"),
      });
      const error = yield* Effect.flip(take(company.id));
      expect(Schema.is(BizError.BusinessRuleViolation)(error) && error.code).toBe(
        "core.unknown-time-zone",
      );
    }).pipe(Tenancy.withTenant(tenant), Actor.withActor(actor)),
  );

  it.effect("guards the definitions store: a duplicate insert, a stale or foreign update", () =>
    Effect.gen(function* () {
      const definitions = yield* NumberSequence.SequenceDefinitions;
      const company = yield* companyIn("UTC");
      const stored = yield* NumberSequence.define({
        companyId: company.id,
        documentType: invoice,
        pattern: pattern("{#}"),
      });
      expect(yield* Effect.flip(definitions.insert(stored))).toEqual(
        new BizError.AlreadyExists({
          entity: "SequenceDefinition",
          key: `${company.id}/${invoice}`,
        }),
      );
      const updated = yield* definitions.update(stored);
      expect(updated.audit.version).toBe(2);
      expect(yield* Effect.flip(definitions.update(stored))).toEqual(
        new BizError.ConcurrencyConflict({
          entity: "SequenceDefinition",
          id: `${company.id}/${invoice}`,
          expected: 1,
          actual: 2,
        }),
      );
      const foreign = new NumberSequence.SequenceDefinition({
        ...Struct.omit(updated, ["id"]),
        id: NumberSequence.SequenceId.make("0190a6e4-1c2d-7abc-8def-0000000000ee"),
      });
      expect(yield* Effect.flip(definitions.update(foreign))).toEqual(
        new BizError.NotFound({ entity: "SequenceDefinition", id: foreign.id }),
      );
    }).pipe(Tenancy.withTenant(tenant), Actor.withActor(actor)),
  );
});
