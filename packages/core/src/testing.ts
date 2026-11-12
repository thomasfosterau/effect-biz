/**
 * The repository contract suite: the cases every `Repository.Port`
 * implementation (in-memory, SQL, a host's own) must pass, as plain effects.
 *
 * {@link repositoryContract} takes a {@link Subject} (the port, a way to
 * make fresh entities and a way to change one) and returns its
 * {@link Case}s: insert and get, `getMany`, version-guarded updates,
 * concurrent updates from one version, tenant isolation, paging stability
 * under inserts between pages, malformed cursors, and archive / restore.
 * Each case is an `Effect` that fails with a {@link ContractFailure} naming
 * the broken rule, so the suite runs under any test runner (it imports
 * none); run each case against an empty store. Each case provides its own
 * tenants and actor.
 *
 * See {@link repositoryContract} for an example.
 *
 * @module
 */

import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as Eq from "effect/Equal";
import * as Option from "effect/Option";
import * as Order from "effect/Order";
import * as P from "effect/Predicate";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as Actor from "./Actor.js";
import * as Audit from "./Audit.js";
import type * as BizError from "./BizError.js";
import * as Page from "./Page.js";
import type * as Repository from "./Repository.js";
import * as Tenancy from "./Tenancy.js";

/** Raised when an implementation breaks a rule of the repository contract. */
export class ContractFailure extends Schema.TaggedError<
  ContractFailure,
  { readonly brand: unique symbol }
>()("ContractFailure", {
  /** The case that failed. */
  case: Schema.String,
  /** The rule it broke, and how. */
  reason: Schema.String,
}) {
  /** A message built from the case and the reason. */
  override get message(): string {
    return `${this.case}: ${this.reason}`;
  }
}

/** One case of the contract: a name for the test runner and the effect that checks it. */
export interface Case<R> {
  /** What the case checks. */
  readonly name: string;
  /** Succeeds when the implementation keeps the rule; fails with a {@link ContractFailure}. */
  readonly run: Effect.Effect<void, ContractFailure, R>;
}

/** The implementation under test, and how to make and change its entities. */
export interface Subject<
  I extends string,
  A extends Audit.Audited & { readonly id: I },
  R,
  RMake = R,
> {
  /** The repository port under test. */
  readonly repository: Effect.Effect<Repository.Port<A, I>, never, R>;
  /**
   * A fresh entity with a new id, at version 1 (built with `Audit.created`),
   * not yet inserted. Runs under the case's tenant and actor.
   */
  readonly make: Effect.Effect<A, never, RMake>;
  /** A change to an entity for `update`: its fields edited, its id and audit kept. */
  readonly change: (entity: A) => A;
}

/** A broken rule, before the case's name is known. */
class Unmet extends Schema.TaggedError<Unmet, { readonly brand: unique symbol }>()("Unmet", {
  reason: Schema.String,
}) {}

const ensure = (condition: boolean, reason: string): Effect.Effect<void, Unmet> =>
  condition ? Effect.void : Effect.fail(new Unmet({ reason }));

/** Succeeds with the error when `self` fails with the tag `tag`; anything else is {@link Unmet}. */
const failsWith = <A, E extends { readonly _tag: string }, R, const T extends E["_tag"]>(
  self: Effect.Effect<A, E, R>,
  tag: T,
  rule: string,
): Effect.Effect<Extract<E, { readonly _tag: T }>, Unmet, R> =>
  Effect.matchEffect(self, {
    onSuccess: () => Effect.fail(new Unmet({ reason: `${rule}: it succeeded` })),
    onFailure: (error) =>
      isTag(error, tag)
        ? Effect.succeed(error)
        : Effect.fail(new Unmet({ reason: `${rule}: it failed with ${error._tag}` })),
  });

const isTag = <E extends { readonly _tag: string }, const T extends string>(
  error: E,
  tag: T,
): error is Extract<E, { readonly _tag: T }> => P.isTagged(error, tag);

const idsOf = (entities: ReadonlyArray<Audit.Audited>): ReadonlyArray<string> =>
  Arr.map(entities, (entity) => entity.id);

const sameIds = (left: ReadonlyArray<string>, right: ReadonlyArray<string>): boolean =>
  Arr.sort(left, Order.String).join() === Arr.sort(right, Order.String).join();

const hex = (value: number): string => value.toString(16).padStart(12, "0");

/** The two tenants of the case at `index`: unique to it, so cases never share rows. */
const tenantsOf = (index: number): readonly [Tenancy.TenantId, Tenancy.TenantId] => [
  Tenancy.TenantId.make(`0190a6e4-0000-7000-8000-${hex(index * 2 + 1)}`),
  Tenancy.TenantId.make(`0190a6e4-0000-7000-8000-${hex(index * 2 + 2)}`),
];

/** The actor every case writes as. */
const actor = Actor.system("repository-contract");

/** What a case body gets: the port, the subject, and the other tenant of the case. */
interface Context<I extends string, A extends Audit.Audited & { readonly id: I }, R> {
  readonly port: Repository.Port<A, I>;
  readonly subject: Subject<I, A, R>;
  readonly other: Tenancy.TenantId;
}

type Body<I extends string, A extends Audit.Audited & { readonly id: I }, R> = (
  context: Context<I, A, R>,
) => Effect.Effect<void, Failure, R | Repository.WriteContext>;

/** What a case body may fail with: a broken rule, or a repository error it did not expect. */
type Failure = Unmet | BizError.BizError;

/** Makes and inserts a fresh entity. */
const inserted = <I extends string, A extends Audit.Audited & { readonly id: I }, R>({
  port,
  subject,
}: Context<I, A, R>) => Effect.tap(subject.make, port.insert);

/** The ids of the pages from `cursor` on, appended to `seen`; at most `budget` more pages. */
const restOf = <I extends string, A extends Audit.Audited & { readonly id: I }>(
  port: Repository.Port<A, I>,
  cursor: Option.Option<Page.Cursor>,
  seen: ReadonlyArray<string>,
  budget: number,
): Effect.Effect<ReadonlyArray<string>, Failure, Tenancy.TenantContext> =>
  Option.match(cursor, {
    onNone: () => Effect.succeed(seen),
    onSome: (next) =>
      budget === 0
        ? Effect.fail(new Unmet({ reason: "find never reaches a last page" }))
        : Effect.flatMap(port.find({}, { limit: 2, cursor: next }), (page) =>
            restOf(port, page.nextCursor, Arr.appendAll(seen, idsOf(page.items)), budget - 1),
          ),
  });

/** Every id `find` returns, page by page, running `between` after the first page. */
const pageThrough = <I extends string, A extends Audit.Audited & { readonly id: I }, R>(
  context: Context<I, A, R>,
  between: Effect.Effect<void, Failure, R | Repository.WriteContext>,
) =>
  Effect.gen(function* () {
    const first = yield* context.port.find({}, { limit: 2 });
    yield* ensure(first.items.length === 2, "find returns a full first page");
    yield* between;
    return yield* restOf(context.port, first.nextCursor, idsOf(first.items), 100);
  });

const cases = <I extends string, A extends Audit.Audited & { readonly id: I }, R>(): ReadonlyArray<
  readonly [string, Body<I, A, R>]
> => [
  [
    "insert stores an entity at version 1 that get reads back, and refuses its id again",
    Effect.fnUntraced(function* (context) {
      const entity = yield* inserted(context);
      const got = yield* context.port.get(entity.id);
      yield* ensure(got.id === entity.id && got.audit.version === 1, "get reads it at version 1");
      yield* failsWith(context.port.insert(entity), "AlreadyExists", "a second insert");
    }),
  ],
  [
    "getMany returns the tenant's entities in the order asked, each once, without unknown ids",
    Effect.fnUntraced(function* (context) {
      const first = yield* inserted(context);
      const second = yield* inserted(context);
      const unknown = yield* context.subject.make;
      const many = yield* context.port.getMany([second.id, unknown.id, first.id, second.id]);
      yield* ensure(
        idsOf(many).join() === [second.id, first.id].join(),
        "getMany returns the known ids, in order, once",
      );
    }),
  ],
  [
    "update stores the next version and refuses a stale one with ConcurrencyConflict",
    Effect.fnUntraced(function* (context) {
      const entity = yield* inserted(context);
      const updated = yield* context.port.update(context.subject.change(entity));
      yield* ensure(updated.audit.version === 2, "update returns version 2");
      yield* ensure(
        Eq.equals(updated.audit.createdAt, entity.audit.createdAt),
        "update keeps the creation time",
      );
      const stored = yield* context.port.get(entity.id);
      yield* ensure(stored.audit.version === 2, "get reads version 2");
      const stale = yield* failsWith(
        context.port.update(context.subject.change(entity)),
        "ConcurrencyConflict",
        "an update from version 1",
      );
      yield* ensure(stale.expected === 1 && stale.actual === 2, "the conflict names both versions");
    }),
  ],
  [
    "of two concurrent updates from one version exactly one succeeds",
    Effect.fnUntraced(function* (context) {
      const entity = yield* inserted(context);
      const outcomes = yield* Effect.all(
        [
          Effect.result(context.port.update(context.subject.change(entity))),
          Effect.result(context.port.update(context.subject.change(entity))),
        ],
        { concurrency: "unbounded" },
      );
      const conflicts = Arr.filter(outcomes, (outcome) =>
        Result.isFailure(outcome) ? outcome.failure._tag === "ConcurrencyConflict" : false,
      );
      yield* ensure(
        Arr.filter(outcomes, Result.isSuccess).length === 1 && conflicts.length === 1,
        "one update succeeds and the other is a ConcurrencyConflict",
      );
      yield* ensure(
        (yield* context.port.get(entity.id)).audit.version === 2,
        "the entity is at version 2",
      );
    }),
  ],
  [
    "another tenant neither sees nor writes the tenant's entities",
    Effect.fnUntraced(function* (context) {
      const entity = yield* inserted(context);
      const asOther = <B, E, R2>(self: Effect.Effect<B, E, R2>) =>
        Tenancy.withTenant(self, context.other);
      yield* failsWith(asOther(context.port.get(entity.id)), "NotFound", "get from another tenant");
      const many = yield* asOther(context.port.getMany([entity.id]));
      yield* ensure(Arr.isReadonlyArrayEmpty(many), "getMany from another tenant finds nothing");
      const page = yield* asOther(context.port.find({ archived: "include" }));
      yield* ensure(Arr.isReadonlyArrayEmpty(page.items), "find from another tenant finds nothing");
      yield* failsWith(
        asOther(context.port.update(context.subject.change(entity))),
        "NotFound",
        "update from another tenant",
      );
      yield* failsWith(
        asOther(context.port.archive(entity.id, 1)),
        "NotFound",
        "archive from another tenant",
      );
      const own = yield* context.port.get(entity.id);
      yield* ensure(own.audit.version === 1, "the tenant's entity is unchanged");
    }),
  ],
  [
    "find pages in a stable order: an insert between pages neither repeats nor skips a row",
    Effect.fnUntraced(function* (context) {
      const before = yield* Effect.forEach(Arr.range(1, 5), () => inserted(context), {
        concurrency: 1,
      });
      const seen = yield* pageThrough(
        context,
        Effect.asVoid(Effect.forEach(Arr.range(1, 3), () => inserted(context), { concurrency: 1 })),
      );
      yield* ensure(
        Arr.every(idsOf(before), (id) => Arr.filter(seen, (s) => s === id).length === 1),
        "every row that existed before the first page is read exactly once",
      );
      yield* ensure(
        Arr.every(seen, (id, index) => index === 0 || (seen[index - 1] ?? "") < id),
        "the pages are in increasing id order",
      );
    }),
  ],
  [
    "find refuses a malformed cursor or limit with ValidationError",
    Effect.fnUntraced(function* (context) {
      yield* inserted(context);
      yield* failsWith(
        context.port.find({}, { cursor: Page.Cursor.make("not-a-cursor") }),
        "ValidationError",
        "find with a malformed cursor",
      );
      yield* failsWith(context.port.find({}, { limit: 0 }), "ValidationError", "find with limit 0");
    }),
  ],
  [
    "archive hides an entity from find until restore, each guarded by version and state",
    Effect.fnUntraced(function* (context) {
      const first = yield* inserted(context);
      const second = yield* inserted(context);
      const archived = yield* context.port.archive(first.id, 1);
      yield* ensure(
        archived.audit.version === 2 && Audit.isArchived(archived),
        "archive stores version 2, archived",
      );
      yield* ensure(Audit.isArchived(yield* context.port.get(first.id)), "get still finds it");
      const active = yield* context.port.find({});
      yield* ensure(sameIds(idsOf(active.items), [second.id]), "find excludes it by default");
      const only = yield* context.port.find({ archived: "only" });
      yield* ensure(sameIds(idsOf(only.items), [first.id]), "find with only returns it alone");
      const all = yield* context.port.find({ archived: "include" });
      yield* ensure(
        sameIds(idsOf(all.items), [first.id, second.id]),
        "find with include returns both",
      );
      yield* failsWith(context.port.archive(first.id, 2), "InvalidTransition", "a second archive");
      yield* failsWith(
        context.port.archive(second.id, 5),
        "ConcurrencyConflict",
        "a stale archive",
      );
      const restored = yield* context.port.restore(first.id, 2);
      yield* ensure(
        restored.audit.version === 3 && !Audit.isArchived(restored),
        "restore stores version 3, active",
      );
      const back = yield* context.port.find({});
      yield* ensure(sameIds(idsOf(back.items), [first.id, second.id]), "find sees it again");
      yield* failsWith(context.port.restore(first.id, 3), "InvalidTransition", "a second restore");
    }),
  ],
];

/** A case's requirements: the subject's, less the tenant and actor each case provides. */
export type Provided<R> = Exclude<Exclude<R, Tenancy.TenantContext>, Actor.CurrentActor>;

/** The case's failure: its own rule broken, or an error it did not expect. */
const failureOf = (name: string, error: Failure): ContractFailure =>
  new ContractFailure({
    case: name,
    reason: Schema.is(Unmet)(error) ? error.reason : `unexpected ${error._tag}: ${error.message}`,
  });

/**
 * The contract's cases for a subject. Each case runs under two tenants of
 * its own and the actor `system:repository-contract`, so its requirements
 * are the subject's, less the tenant and actor.
 *
 * @example
 * ```ts
 * import { Effect, Layer, Option, Struct } from "effect";
 * import * as Audit from "@thomasfosterau/effect-biz/Audit";
 * import * as Company from "@thomasfosterau/effect-biz/Company";
 * import * as Currency from "@thomasfosterau/effect-biz/Currency";
 * import * as Id from "@thomasfosterau/effect-biz/Id";
 * import * as Rounding from "@thomasfosterau/effect-biz/Rounding";
 * import * as Tenancy from "@thomasfosterau/effect-biz/Tenancy";
 * import * as Testing from "@thomasfosterau/effect-biz/testing";
 *
 * const cases = Testing.repositoryContract({
 *   repository: Effect.service(Company.CompanyRepository),
 *   make: Effect.gen(function* () {
 *     const id = yield* Id.generate(Tenancy.CompanyId);
 *     return new Company.Company({
 *       id,
 *       legalName: "Example Pty Ltd",
 *       tradingName: Option.none(),
 *       registrations: [],
 *       baseCurrency: Currency.make("AUD"),
 *       country: Company.CountryCode.make("AU"),
 *       locale: "en-AU",
 *       timeZone: "Australia/Sydney",
 *       fiscalYearStart: new Company.FiscalYearStart({ month: 7, day: 1 }),
 *       rounding: new Rounding.RoundingPolicy({ mode: "half-even", scale: 2 }),
 *       audit: yield* Audit.created,
 *     });
 *   }),
 *   change: (company) =>
 *     new Company.Company({ ...Struct.omit(company, ["legalName"]), legalName: "Renamed Pty Ltd" }),
 * });
 *
 * // Each case against a fresh store, as a test runner would run it.
 * for (const contractCase of cases) {
 *   Effect.runSync(
 *     contractCase.run.pipe(Effect.provide(Layer.merge(Company.layerMemory, Id.layerSequential))),
 *   );
 * }
 * console.log(cases.length); // 8
 * ```
 */
export const repositoryContract = <
  I extends string,
  A extends Audit.Audited & { readonly id: I },
  R,
  RMake,
>(
  subject: Subject<I, A, R, RMake>,
): ReadonlyArray<Case<Provided<R | RMake>>> =>
  Arr.map(cases<I, A, R | RMake>(), ([name, body], index) => {
    const [tenant, other] = tenantsOf(index);
    return {
      name,
      run: subject.repository.pipe(
        Effect.flatMap((port) => body({ port, subject, other })),
        Effect.mapError((error) => failureOf(name, error)),
        Tenancy.withTenant(tenant),
        Actor.withActor(actor),
      ),
    };
  });
