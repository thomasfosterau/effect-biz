import { describe, expect } from "vite-plus/test";
import { it, layer } from "@effect/vitest";
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as HashMap from "effect/HashMap";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as Struct from "effect/Struct";
import * as Actor from "../src/Actor.ts";
import * as Audit from "../src/Audit.ts";
import * as BizError from "../src/BizError.ts";
import * as Company from "../src/Company.ts";
import * as Currency from "../src/Currency.ts";
import * as Id from "../src/Id.ts";
import * as Memory from "../src/Memory.ts";
import * as Rounding from "../src/Rounding.ts";
import * as Tenancy from "../src/Tenancy.ts";
import * as Testing from "../src/testing.ts";
import { Widget, Widgets, audit, widget, widgetSubject, widgetsLayer } from "./fixtures.ts";

const actorLayer = Layer.succeed(Actor.CurrentActor, Actor.system("test"));

const widgetCases = Testing.repositoryContract(widgetSubject(Effect.service(Widgets)));

layer(Layer.merge(widgetsLayer, Id.layerSequential), { buildPerTest: true })(
  "the repository contract over Memory",
  (it) => {
    Arr.forEach(widgetCases, (contractCase) =>
      it.effect(contractCase.name, () => contractCase.run),
    );
  },
);

layer(Layer.merge(widgetsLayer, Id.layer), { buildPerTest: true })(
  "the repository contract over Memory with UUIDv7 ids",
  (it) => {
    Arr.forEach(widgetCases, (contractCase) =>
      it.effect(contractCase.name, () => contractCase.run),
    );
  },
);

const companyCases = Testing.repositoryContract({
  repository: Effect.service(Company.CompanyRepository),
  make: Effect.gen(function* () {
    const id = yield* Id.generate(Tenancy.CompanyId);
    return new Company.Company({
      id,
      legalName: "Example Pty Ltd",
      tradingName: Option.none(),
      registrations: [],
      baseCurrency: Currency.make("AUD"),
      country: Company.CountryCode.make("AU"),
      locale: "en-AU",
      timeZone: "Australia/Sydney",
      fiscalYearStart: new Company.FiscalYearStart({ month: 7, day: 1 }),
      rounding: new Rounding.RoundingPolicy({ mode: "half-even", scale: 2 }),
      audit: yield* Audit.created,
    });
  }),
  change: (company) =>
    new Company.Company({ ...Struct.omit(company, ["legalName"]), legalName: "Renamed Pty Ltd" }),
});

layer(Layer.merge(Company.layerMemory, Id.layerSequential), { buildPerTest: true })(
  "the repository contract over Company.layerMemory",
  (it) => {
    Arr.forEach(companyCases, (contractCase) =>
      it.effect(contractCase.name, () => contractCase.run),
    );
  },
);

/** A port that ignores versions, tenants' getMany and archive state: every case should catch it. */
const brokenLayer = Layer.effect(
  Widgets,
  Effect.map(Effect.service(Widgets), (port) =>
    Widgets.of({
      ...port,
      getMany: () => Effect.succeed([]),
      update: (row) => Effect.succeed(row),
      archive: (id) => port.get(id),
      restore: (id) => port.get(id),
      insert: (row) => Effect.ignore(port.insert(row)),
      find: (query) => port.find(query, { limit: 500 }),
    }),
  ),
).pipe(Layer.provide(widgetsLayer));

layer(Layer.mergeAll(brokenLayer, Id.layerSequential), { buildPerTest: true })(
  "the repository contract over a broken port",
  (it) => {
    it.effect("fails every case but tenant isolation with a ContractFailure naming it", () =>
      Effect.gen(function* () {
        const exits = yield* Effect.forEach(
          widgetCases,
          (contractCase) => Effect.exit(contractCase.run),
          { concurrency: 1 },
        );
        const failures = Arr.getSomes(Arr.map(exits, Exit.findErrorOption));
        expect(failures.length).toBeGreaterThanOrEqual(6);
        expect(Arr.every(failures, (failure) => Schema.is(Testing.ContractFailure)(failure))).toBe(
          true,
        );
        expect(failures[0]?.message).toMatch(/^insert stores an entity/);
      }),
    );
  },
);

const tenant = Tenancy.TenantId.make("0190a6e4-1c2d-7abc-8def-0000000000a1");

describe("Memory", () => {
  it.effect("modify leaves the store unchanged when the decision fails", () =>
    Effect.gen(function* () {
      const store = yield* Memory.makeStore<string, string>();
      const error = yield* Effect.flip(
        Memory.modify<string, string, void, BizError.Unavailable>(store, () =>
          Result.fail(new BizError.Unavailable({ service: "Test" })),
        ),
      );
      expect(error).toBeInstanceOf(BizError.Unavailable);
      expect(HashMap.size(yield* Memory.rows(store))).toBe(0);
      const written = yield* Memory.modify<string, string, string, never>(store, (rows) =>
        Result.succeed(["written", HashMap.set(rows, "a", "A")] as const),
      );
      expect(written).toBe("written");
      expect(HashMap.get(yield* Memory.rows(store), "a")).toEqual(Option.some("A"));
    }).pipe(Tenancy.withTenant(tenant)),
  );
});

layer(Layer.mergeAll(widgetsLayer, actorLayer), { buildPerTest: true })(
  "Memory.repository",
  (it) => {
    it.effect("keeps an entity archived across an update, and its creation fields", () =>
      Effect.gen(function* () {
        const widgets = yield* Widgets;
        const original = widget(1);
        yield* widgets.insert(original);
        const archived = yield* widgets.archive(original.id, 1);
        const updated = yield* widgets.update(
          new Widget({ ...Struct.omit(archived, ["name"]), name: "Renamed" }),
        );
        expect(updated.name).toBe("Renamed");
        expect(updated.audit.version).toBe(3);
        expect(updated.audit.archivedAt).toEqual(archived.audit.archivedAt);
        expect(updated.audit.createdBy).toBe("fixture");
        expect(updated.audit.updatedBy).toBe("test");
      }).pipe(Tenancy.withTenant(tenant)),
    );

    it.effect("refuses an insert at a version other than 1, and a write to an unknown id", () =>
      Effect.gen(function* () {
        const widgets = yield* Widgets;
        const later = widget(1, {
          audit: new Audit.AuditFields({ ...Struct.omit(audit, ["version"]), version: 2 }),
        });
        expect(yield* Effect.flip(widgets.insert(later))).toEqual(
          new BizError.ConcurrencyConflict({
            entity: "Widget",
            id: later.id,
            expected: 1,
            actual: 2,
          }),
        );
        expect(yield* Effect.flip(widgets.restore(later.id, 1))).toEqual(
          new BizError.NotFound({ entity: "Widget", id: later.id }),
        );
      }).pipe(Tenancy.withTenant(tenant)),
    );
  },
);
