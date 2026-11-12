import { describe, expect } from "vite-plus/test";
import { it, layer } from "@effect/vitest";
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as HashMap from "effect/HashMap";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
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
import * as UnitOfWork from "../src/UnitOfWork.ts";
import {
  Outbox,
  Widget,
  Widgets,
  audit,
  outboxLayer,
  widget,
  widgetWorkSubject,
  widgetsLayer,
} from "./fixtures.ts";

const workCases = Testing.unitOfWorkContract(widgetWorkSubject(Effect.service(Widgets)));

layer(Layer.mergeAll(widgetsLayer, outboxLayer, UnitOfWork.layerMemory, Id.layerSequential), {
  buildPerTest: true,
  excludeTestServices: true,
})("the unit-of-work contract over Memory", (it) => {
  Arr.forEach(workCases, (contractCase) => it.effect(contractCase.name, () => contractCase.run));
});

const tenant = Tenancy.TenantId.make("0190a6e4-1c2d-7abc-8def-0000000000a1");
const other = Tenancy.TenantId.make("0190a6e4-1c2d-7abc-8def-0000000000b2");
const actorLayer = Layer.succeed(Actor.CurrentActor, Actor.system("test"));

describe("Memory.put", () => {
  it.effect("commits at once outside a transaction, guarded by the expected version", () =>
    Effect.gen(function* () {
      const store = yield* Memory.makeStore<string, Widget>();
      const row = widget(1);
      yield* Memory.put(store, { entity: "Widget", id: row.id, expected: 0, row });
      expect(HashMap.get(yield* Memory.rows(store), row.id)).toEqual(Option.some(row));
      const conflict = yield* Effect.flip(
        Memory.put(store, { entity: "Widget", id: row.id, expected: 0, row }),
      );
      expect(conflict).toEqual(
        new BizError.ConcurrencyConflict({ entity: "Widget", id: row.id, expected: 0, actual: 1 }),
      );
      const moved = widget(1, {
        audit: new Audit.AuditFields({ ...Struct.omit(audit, ["version"]), version: 2 }),
      });
      yield* Memory.put(store, { entity: "Widget", id: row.id, expected: 1, row: moved });
      expect(HashMap.get(yield* Memory.rows(store), row.id)).toEqual(Option.some(moved));
      expect(HashMap.size(yield* Memory.rows(store).pipe(Tenancy.withTenant(other)))).toBe(0);
    }).pipe(Tenancy.withTenant(tenant)),
  );
});

describe("Memory.append", () => {
  it.effect("appends to the current tenant's log, in order", () =>
    Effect.gen(function* () {
      const log = yield* Memory.makeLog<string>();
      yield* Memory.append(log, "a");
      yield* Memory.append(log, "b");
      expect(yield* Memory.entries(log)).toEqual(["a", "b"]);
      expect(yield* Memory.entries(log).pipe(Tenancy.withTenant(other))).toEqual([]);
    }).pipe(Tenancy.withTenant(tenant)),
  );
});

layer(Layer.mergeAll(widgetsLayer, outboxLayer, actorLayer), { buildPerTest: true })(
  "UnitOfWork.make",
  (it) => {
    it.effect("with one attempt, returns a commit conflict without retrying", () =>
      Effect.gen(function* () {
        const widgets = yield* Widgets;
        const unitOfWork = UnitOfWork.makeMemory({ attempts: 1 });
        const row = widget(1);
        yield* widgets.insert(row);
        const runs = yield* Ref.make(0);
        const conflict = yield* Effect.flip(
          unitOfWork.transaction(
            Effect.gen(function* () {
              yield* Ref.update(runs, (n) => n + 1);
              yield* widgets.update(row);
              yield* widgets.update(row);
            }),
          ),
        );
        expect(conflict).toEqual(
          new BizError.ConcurrencyConflict({
            entity: "Widget",
            id: row.id,
            expected: 1,
            actual: 2,
          }),
        );
        expect(yield* Ref.get(runs)).toBe(1);
        expect((yield* widgets.get(row.id)).audit.version).toBe(1);
      }).pipe(Tenancy.withTenant(tenant)),
    );

    it.effect(
      "returns the command's value, and commits nothing for a command that stages nothing",
      () =>
        Effect.gen(function* () {
          const outbox = yield* Outbox;
          const value = yield* UnitOfWork.makeMemory().transaction(Effect.succeed(42));
          expect(value).toBe(42);
          expect(yield* Memory.entries(outbox)).toEqual([]);
        }).pipe(Tenancy.withTenant(tenant)),
    );
  },
);

layer(Layer.mergeAll(Company.layerMemory, UnitOfWork.layerMemory, Id.layerSequential, actorLayer), {
  buildPerTest: true,
})("UnitOfWork.transaction over Company.layerMemory", (it) => {
  it.effect("stages a command's writes and commits them only when it succeeds", () =>
    Effect.gen(function* () {
      const input: Company.CreateInput = {
        legalName: "Example Pty Ltd",
        tradingName: Option.none(),
        registrations: [],
        baseCurrency: Currency.make("AUD"),
        country: Company.CountryCode.make("AU"),
        locale: "en-AU",
        timeZone: "Australia/Sydney",
        fiscalYearStart: new Company.FiscalYearStart({ month: 7, day: 1 }),
        rounding: new Rounding.RoundingPolicy({ mode: "half-even", scale: 2 }),
      };
      const created = yield* UnitOfWork.transaction(Company.create(input));
      yield* Effect.flip(
        UnitOfWork.transaction(
          Effect.andThen(
            Company.create(input),
            Effect.fail(new BizError.Unavailable({ service: "test" })),
          ),
        ),
      );
      expect((yield* Company.list).map((company) => company.id)).toEqual([created.id]);
    }).pipe(Tenancy.withTenant(tenant)),
  );
});

/** A unit of work that opens no transaction: every write commits at once. */
const passThrough = Layer.succeed(UnitOfWork.UnitOfWork, { transaction: (effect) => effect });

layer(Layer.mergeAll(widgetsLayer, outboxLayer, passThrough, Id.layerSequential), {
  buildPerTest: true,
  excludeTestServices: true,
})("the unit-of-work contract over a pass-through unit of work", (it) => {
  it.effect("fails every case but the last with a ContractFailure naming it", () =>
    Effect.gen(function* () {
      const exits = yield* Effect.forEach(
        workCases,
        (contractCase) => Effect.exit(contractCase.run),
        {
          concurrency: 1,
        },
      );
      const failures = Arr.getSomes(Arr.map(exits, Exit.findErrorOption));
      // Every case but the last, a conflict the command raises itself, which needs no transaction.
      expect(failures.map((failure) => failure.case)).toEqual(
        workCases.slice(0, -1).map((contractCase) => contractCase.name),
      );
    }),
  );
});
