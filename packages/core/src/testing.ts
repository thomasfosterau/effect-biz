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
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Eq from "effect/Equal";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as Order from "effect/Order";
import * as P from "effect/Predicate";
import * as Ref from "effect/Ref";
import * as Result from "effect/Result";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as TestClock from "effect/testing/TestClock";
import * as Actor from "./Actor.js";
import * as Audit from "./Audit.js";
import type * as BizError from "./BizError.js";
import * as BizErrors from "./BizError.js";
import * as Company from "./Company.js";
import * as Currency from "./Currency.js";
import * as Dispatcher from "./Dispatcher.js";
import * as DomainEvent from "./DomainEvent.js";
import * as EventRecorder from "./EventRecorder.js";
import type * as Id from "./Id.js";
import * as NumberSequence from "./NumberSequence.js";
import * as Outbox from "./Outbox.js";
import * as Page from "./Page.js";
import type * as Repository from "./Repository.js";
import * as Rounding from "./Rounding.js";
import * as Subscriber from "./Subscriber.js";
import * as Tenancy from "./Tenancy.js";
import * as UnitOfWork from "./UnitOfWork.js";

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
 * The runnable cases of `bodies`: the case at `index` runs under the tenants
 * `tenantsOf(offset + index)` and the contract's actor, with its failures
 * named after it.
 */
const casesOf = <C, P, R>(
  bodies: ReadonlyArray<readonly [string, (context: C) => Effect.Effect<void, Failure, R>]>,
  offset: number,
  contextOf: (port: P, other: Tenancy.TenantId) => C,
  repository: Effect.Effect<P, never, R>,
): ReadonlyArray<Case<Provided<R>>> =>
  Arr.map(bodies, ([name, body], index) => {
    const [tenant, other] = tenantsOf(offset + index);
    return {
      name,
      run: repository.pipe(
        Effect.flatMap((port) => body(contextOf(port, other))),
        Effect.mapError((error) => failureOf(name, error)),
        Tenancy.withTenant(tenant),
        Actor.withActor(actor),
      ),
    };
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
  casesOf(
    cases<I, A, R | RMake>(),
    0,
    (port, other) => ({ port, subject, other }),
    subject.repository,
  );

/**
 * The unit of work under test: a repository subject whose writes it stages,
 * and a second store, the log a command records its events in.
 */
export interface UnitOfWorkSubject<
  I extends string,
  A extends Audit.Audited & { readonly id: I },
  R,
  RMake = R,
> extends Subject<I, A, R, RMake> {
  /** Records one event for the current tenant, staged into the open transaction's batch. */
  readonly record: Effect.Effect<void, BizError.ConcurrencyConflict, R>;
  /** How many events the current tenant has recorded (committed). */
  readonly recorded: Effect.Effect<number, never, R>;
}

/** The deliberate failure a case's command ends with. */
class Aborted extends Schema.TaggedError<Aborted, { readonly brand: unique symbol }>()(
  "Aborted",
  {},
) {}

/** What a unit-of-work case body gets: the port and the subject. */
interface WorkContext<I extends string, A extends Audit.Audited & { readonly id: I }, R> {
  readonly port: Repository.Port<A, I>;
  readonly subject: UnitOfWorkSubject<I, A, R>;
}

type WorkBody<I extends string, A extends Audit.Audited & { readonly id: I }, R> = (
  context: WorkContext<I, A, R>,
) => Effect.Effect<void, Failure, R | Repository.WriteContext | UnitOfWork.UnitOfWork>;

/**
 * A command's writes across two stores: an update of `existing`, an insert
 * of `fresh` and one recorded event.
 */
const writeAll = <I extends string, A extends Audit.Audited & { readonly id: I }, R>(
  { port, subject }: WorkContext<I, A, R>,
  existing: A,
  fresh: A,
) =>
  Effect.gen(function* () {
    yield* port.update(subject.change(existing));
    yield* port.insert(fresh);
    yield* subject.record;
  });

/** Checks that none of {@link writeAll}'s writes was applied. */
const untouched = <I extends string, A extends Audit.Audited & { readonly id: I }, R>(
  { port, subject }: WorkContext<I, A, R>,
  existing: A,
  fresh: A,
) =>
  Effect.gen(function* () {
    const stored = yield* port.get(existing.id);
    yield* ensure(stored.audit.version === 1, "the updated aggregate is still at version 1");
    yield* failsWith(port.get(fresh.id), "NotFound", "get of the inserted aggregate");
    yield* ensure((yield* subject.recorded) === 0, "no event is recorded");
  });

/** Makes and inserts an entity outside any transaction, and makes another, not inserted. */
const existingAndFresh = <I extends string, A extends Audit.Audited & { readonly id: I }, R>(
  context: WorkContext<I, A, R>,
) =>
  Effect.all([Effect.tap(context.subject.make, context.port.insert), context.subject.make], {
    concurrency: 1,
  });

/**
 * One run of a command that loads the entity, stages an update, and, on its
 * first run only, waits after staging until the other command has staged
 * too, so both commit from the same version.
 */
const racing = <I extends string, A extends Audit.Audited & { readonly id: I }, R>(
  { port, subject }: WorkContext<I, A, R>,
  id: I,
  runs: Ref.Ref<number>,
  mine: Deferred.Deferred<void>,
  theirs: Deferred.Deferred<void>,
) =>
  UnitOfWork.transaction(
    Effect.gen(function* () {
      yield* Ref.update(runs, (n) => n + 1);
      const loaded = yield* port.get(id);
      yield* port.update(subject.change(loaded));
      if (!(yield* Deferred.isDone(mine))) {
        yield* Deferred.succeed(mine, undefined);
        yield* Deferred.await(theirs);
      }
    }),
  );

const workCases = <
  I extends string,
  A extends Audit.Audited & { readonly id: I },
  R,
>(): ReadonlyArray<readonly [string, WorkBody<I, A, R>]> => [
  [
    "a command commits its writes to every store in one batch, unseen by its own reads",
    Effect.fnUntraced(function* (context) {
      const [existing, fresh] = yield* existingAndFresh(context);
      yield* UnitOfWork.transaction(
        Effect.gen(function* () {
          yield* writeAll(context, existing, fresh);
          yield* failsWith(context.port.get(fresh.id), "NotFound", "a read of a staged insert");
        }),
      );
      yield* ensure(
        (yield* context.port.get(existing.id)).audit.version === 2,
        "the update is committed",
      );
      yield* ensure(
        (yield* context.port.get(fresh.id)).audit.version === 1,
        "the insert is committed",
      );
      yield* ensure((yield* context.subject.recorded) === 1, "the event is recorded");
    }),
  ],
  [
    "a command that writes two aggregates and records an event, then fails, leaves every store untouched",
    Effect.fnUntraced(function* (context) {
      const [existing, fresh] = yield* existingAndFresh(context);
      yield* failsWith(
        UnitOfWork.transaction(
          Effect.andThen(writeAll(context, existing, fresh), Effect.fail(new Aborted())),
        ),
        "Aborted",
        "the failing command",
      );
      yield* untouched(context, existing, fresh);
    }),
  ],
  [
    "a command interrupted mid-transaction leaves every store untouched",
    Effect.fnUntraced(function* (context) {
      const [existing, fresh] = yield* existingAndFresh(context);
      const staged = yield* Deferred.make<void>();
      const fiber = yield* Effect.forkChild(
        UnitOfWork.transaction(
          Effect.andThen(
            writeAll(context, existing, fresh),
            Effect.andThen(Deferred.succeed(staged, undefined), Effect.never),
          ),
        ),
      );
      yield* Deferred.await(staged);
      yield* Fiber.interrupt(fiber);
      yield* untouched(context, existing, fresh);
    }),
  ],
  [
    "a nested transaction joins the outer one, and is rolled back with it",
    Effect.fnUntraced(function* (context) {
      const [existing, fresh] = yield* existingAndFresh(context);
      yield* failsWith(
        UnitOfWork.transaction(
          Effect.andThen(
            UnitOfWork.transaction(writeAll(context, existing, fresh)),
            Effect.fail(new Aborted()),
          ),
        ),
        "Aborted",
        "the outer command",
      );
      yield* untouched(context, existing, fresh);
    }),
  ],
  [
    "a command whose commit conflicts with a concurrent one is retried from load and succeeds",
    Effect.fnUntraced(function* (context) {
      const entity = yield* Effect.tap(context.subject.make, context.port.insert);
      const runs = yield* Ref.make(0);
      const first = yield* Deferred.make<void>();
      const second = yield* Deferred.make<void>();
      yield* Effect.all(
        [
          racing(context, entity.id, runs, first, second),
          racing(context, entity.id, runs, second, first),
        ],
        { concurrency: "unbounded" },
      );
      const stored = yield* context.port.get(entity.id);
      yield* ensure(stored.audit.version === 3, "both commands are committed, one after the other");
      yield* ensure((yield* Ref.get(runs)) === 3, "exactly one command ran again");
    }),
  ],
  [
    "a batch that always conflicts ends in ConcurrencyConflict after bounded retries, applying nothing",
    Effect.fnUntraced(function* (context) {
      const entity = yield* Effect.tap(context.subject.make, context.port.insert);
      const runs = yield* Ref.make(0);
      // Two updates from one version: each passes its eager check, the second guard fails.
      yield* failsWith(
        UnitOfWork.transaction(
          Effect.gen(function* () {
            yield* Ref.update(runs, (n) => n + 1);
            yield* context.port.update(context.subject.change(entity));
            yield* context.port.update(context.subject.change(entity));
          }),
        ),
        "ConcurrencyConflict",
        "the conflicting command",
      );
      const attempts = yield* Ref.get(runs);
      yield* ensure(
        attempts > 1 && attempts <= 10,
        "the command is retried, a bounded number of times",
      );
      yield* ensure(
        (yield* context.port.get(entity.id)).audit.version === 1,
        "the entity is unchanged",
      );
    }),
  ],
  [
    "a conflict the command itself fails with is returned, not retried",
    Effect.fnUntraced(function* (context) {
      const entity = yield* Effect.tap(context.subject.make, context.port.insert);
      yield* context.port.update(context.subject.change(entity));
      const runs = yield* Ref.make(0);
      yield* failsWith(
        UnitOfWork.transaction(
          Effect.andThen(
            Ref.update(runs, (n) => n + 1),
            context.port.update(context.subject.change(entity)),
          ),
        ),
        "ConcurrencyConflict",
        "an update from a stale version",
      );
      yield* ensure((yield* Ref.get(runs)) === 1, "the command runs once");
    }),
  ],
];

/**
 * The unit-of-work contract's cases for a subject: a command's writes to an
 * aggregate store and an event log commit as one batch, or (on failure,
 * interruption, or in a nested transaction that the outer one aborts) not
 * at all; a commit conflict is retried from load, a bounded number of times;
 * a conflict the command itself raises is not. Like
 * {@link repositoryContract}, each case runs under a tenant of its own and
 * the actor `system:repository-contract`; give each a fresh store and log.
 * The retry cases sleep between attempts, so run them on a live clock.
 *
 * @example
 * ```ts
 * import { Context, Effect, Layer, Struct } from "effect";
 * import * as Audit from "@thomasfosterau/effect-biz/Audit";
 * import * as Id from "@thomasfosterau/effect-biz/Id";
 * import * as Memory from "@thomasfosterau/effect-biz/Memory";
 * import type * as Repository from "@thomasfosterau/effect-biz/Repository";
 * import * as Testing from "@thomasfosterau/effect-biz/testing";
 * import * as UnitOfWork from "@thomasfosterau/effect-biz/UnitOfWork";
 *
 * const NoteId = Id.make("NoteId");
 * type NoteId = typeof NoteId.Type;
 *
 * interface Note {
 *   readonly id: NoteId;
 *   readonly text: string;
 *   readonly audit: Audit.AuditFields;
 * }
 *
 * class Notes extends Context.Service<
 *   Notes,
 *   { readonly port: Repository.Port<Note, NoteId>; readonly log: Memory.Log<string> }
 * >()("example/Notes") {}
 *
 * const notesMemory = Layer.effect(
 *   Notes,
 *   Effect.gen(function* () {
 *     const store = yield* Memory.makeStore<NoteId, Note>();
 *     const port = Memory.repository(store, {
 *       entity: "Note",
 *       withAudit: (note, audit) => ({ ...Struct.omit(note, ["audit"]), audit }),
 *       searchable: ["text"],
 *     });
 *     return { port, log: yield* Memory.makeLog<string>() };
 *   }),
 * );
 *
 * const cases = Testing.unitOfWorkContract({
 *   repository: Effect.map(Effect.service(Notes), (notes) => notes.port),
 *   make: Effect.gen(function* () {
 *     return { id: yield* Id.generate(NoteId), text: "Call back", audit: yield* Audit.created };
 *   }),
 *   change: (note) => ({ ...note, text: `${note.text}!` }),
 *   record: Effect.flatMap(Effect.service(Notes), (notes) => Memory.append(notes.log, "noted")),
 *   recorded: Effect.flatMap(Effect.service(Notes), (notes) =>
 *     Effect.map(Memory.entries(notes.log), (entries) => entries.length),
 *   ),
 * });
 *
 * const layer = Layer.mergeAll(notesMemory, UnitOfWork.layerMemory, Id.layerSequential);
 * const program = Effect.forEach(cases, (contractCase) => Effect.provide(contractCase.run, layer), {
 *   concurrency: 1,
 * });
 * Effect.runPromise(program).then(() => console.log(cases.length)); // 7
 * ```
 */
export const unitOfWorkContract = <
  I extends string,
  A extends Audit.Audited & { readonly id: I },
  R,
  RMake,
>(
  subject: UnitOfWorkSubject<I, A, R, RMake>,
): ReadonlyArray<Case<Provided<R | RMake | UnitOfWork.UnitOfWork>>> =>
  casesOf(workCases<I, A, R | RMake>(), 1000, (port) => ({ port, subject }), subject.repository);

/** The event every events-contract case records: one step of an aggregate's history. */
const ContractStep = DomainEvent.make(
  "contract.aggregate.stepped",
  Schema.Struct({ step: Schema.Int }),
);

/** The services an events-contract case uses besides the subject's. */
type EventServices =
  | Outbox.Outbox
  | Subscriber.Inbox
  | UnitOfWork.UnitOfWork
  | EventRecorder.EventRecorder;

type EventsBody<I extends string, A extends Audit.Audited & { readonly id: I }, R> = (
  context: Context<I, A, R>,
) => Effect.Effect<void, Failure, R | Repository.WriteContext | EventServices>;

/** Records step `step` of the aggregate `aggregate`, as one command of its own. */
const recordStep = (aggregate: string, step: number) =>
  UnitOfWork.transaction(
    EventRecorder.record(
      ContractStep.of({
        aggregate: { kind: "ContractAggregate", id: aggregate, version: step },
        payload: { step },
      }),
    ),
  );

/** Every case's dispatcher settings: retry at once, three attempts in all. */
const contractDispatch: Dispatcher.Options = {
  maxAttempts: 3,
  backoff: Schedule.spaced(Duration.zero),
  concurrency: 4,
};

/** The steps a subscriber handled, as `aggregate:step`, in order. */
const logged = (log: Ref.Ref<ReadonlyArray<string>>, aggregate: string) =>
  Effect.map(Ref.get(log), (entries) =>
    Arr.filter(entries, (entry) => entry.startsWith(`${aggregate}:`)).join(),
  );

/** A subscriber that logs each step it handles. */
const logging = (name: string, log: Ref.Ref<ReadonlyArray<string>>) =>
  Subscriber.make(name, [ContractStep], (event) =>
    Ref.update(log, Arr.append(`${event.aggregate.id}:${event.payload.step}`)),
  );

/** Delivers `envelope` straight to `subscriber`, as a relay would. */
const deliverTo = (subscriber: Subscriber.Subscriber, envelope: DomainEvent.Envelope) =>
  Effect.mapError(
    subscriber.handle(envelope),
    (error) => new Unmet({ reason: `${subscriber.name} failed with ${error.tag}` }),
  );

/** This tenant's dead letters for `subscriber`. */
const deadFor = (subscriber: string) =>
  Effect.gen(function* () {
    const tenantId = yield* Tenancy.currentTenant;
    const outbox = yield* Outbox.Outbox;
    return Arr.filter(
      yield* outbox.deadLetters,
      (dead) => dead.subscriber === subscriber && dead.envelope.tenantId === tenantId,
    );
  });

const eventCases = <
  I extends string,
  A extends Audit.Audited & { readonly id: I },
  R,
>(): ReadonlyArray<readonly [string, EventsBody<I, A, R>]> => [
  [
    "an event is recorded atomically with the state change: a failed command records nothing",
    Effect.fnUntraced(function* (context) {
      const existing = yield* Effect.tap(context.subject.make, context.port.insert);
      const log = yield* Ref.make<ReadonlyArray<string>>([]);
      const dispatcher = yield* Dispatcher.make(
        [yield* logging("contract.observer", log)],
        contractDispatch,
      );
      const command = (step: number) =>
        UnitOfWork.transaction(
          Effect.andThen(
            context.port.update(context.subject.change(existing)),
            recordStep(existing.id, step),
          ),
        );
      yield* failsWith(
        Effect.andThen(command(1), Effect.fail(new Aborted())).pipe(UnitOfWork.transaction),
        "Aborted",
        "the failing command",
      );
      yield* dispatcher.drain;
      yield* ensure(
        Arr.isReadonlyArrayEmpty(yield* Ref.get(log)),
        "a failed command's event is never delivered",
      );
      yield* ensure(
        (yield* context.port.get(existing.id)).audit.version === 1,
        "nor its state change applied",
      );
      yield* command(2);
      yield* dispatcher.drain;
      yield* ensure(
        (yield* logged(log, existing.id)) === `${existing.id}:2`,
        "a committed command's event is delivered once",
      );
    }),
  ],
  [
    "a redelivered event is handled once per subscriber",
    Effect.fnUntraced(function* (context) {
      const insertedIds = yield* Ref.make<ReadonlyArray<I>>([]);
      /** A subscriber whose handler stages one insert per run, noting the id it inserts. */
      const writing = (name: string) =>
        Subscriber.make(name, [ContractStep], () =>
          Effect.flatMap(context.subject.make, (entity) =>
            Effect.andThen(
              context.port.insert(entity),
              Ref.update(insertedIds, Arr.append(entity.id)),
            ),
          ),
        );
      const first = yield* writing("contract.first");
      const second = yield* writing("contract.second");
      const dispatcher = yield* Dispatcher.make([first, second], contractDispatch);
      const envelope = yield* recordStep("redelivered", 1);
      // A relay claims both deliveries and dies (its lease ends at once) after handling
      // the first one twice over, concurrently, and marking nothing.
      const outbox = yield* Outbox.Outbox;
      const claims = yield* outbox.claimBatch({
        owner: "contract.crashed",
        subscriptions: [first, second],
        limit: 10,
        leaseFor: 0,
      });
      yield* ensure(claims.length === 2, "the relay claims one delivery per subscriber");
      yield* Effect.all([deliverTo(first, envelope), deliverTo(first, envelope)], {
        concurrency: "unbounded",
      });
      // Another relay claims the expired deliveries again; then both are delivered yet again.
      yield* dispatcher.drain;
      yield* Effect.all([deliverTo(first, envelope), deliverTo(second, envelope)], {
        concurrency: 1,
      });
      const committed = yield* context.port.getMany(yield* Ref.get(insertedIds));
      yield* ensure(
        committed.length === 2,
        "each subscriber's handler committed its writes exactly once",
      );
    }),
  ],
  [
    "a failing subscriber does not block the others; it retries, then dead-letters",
    Effect.fnUntraced(function* () {
      const log = yield* Ref.make<ReadonlyArray<string>>([]);
      const attempts = yield* Ref.make(0);
      const broken = yield* Subscriber.make("contract.broken", [ContractStep], () =>
        Effect.andThen(
          Ref.update(attempts, (n) => n + 1),
          Effect.fail(
            new BizErrors.BusinessRuleViolation({ code: "contract.broken", reason: "always" }),
          ),
        ),
      );
      const dispatcher = yield* Dispatcher.make(
        [broken, yield* logging("contract.healthy", log)],
        contractDispatch,
      );
      yield* recordStep("first", 1);
      yield* recordStep("second", 1);
      yield* dispatcher.drain;
      const entries = yield* Ref.get(log);
      yield* ensure(
        sameIds(entries, ["first:1", "second:1"]),
        "the healthy subscriber handles every event",
      );
      yield* ensure((yield* Ref.get(attempts)) === 6, "the broken one is tried 3 times per event");
      const dead = yield* deadFor("contract.broken");
      yield* ensure(
        dead.length === 2 &&
          Arr.every(
            dead,
            (letter) =>
              letter.attempts === 3 &&
              letter.error.tag === "BusinessRuleViolation" &&
              letter.error.message.includes("contract.broken"),
          ),
        "each event is dead-lettered for it after its last attempt, with the error's tag and message",
      );
      yield* ensure(
        Arr.isReadonlyArrayEmpty(yield* deadFor("contract.healthy")),
        "nothing is dead-lettered for the healthy subscriber",
      );
    }),
  ],
  [
    "each subscriber gets an aggregate's events in order; a retry holds back no other aggregate",
    Effect.fnUntraced(function* () {
      const log = yield* Ref.make<ReadonlyArray<string>>([]);
      const failuresLeft = yield* Ref.make(2);
      // Fails `a:1` twice (then handles it), and `c:1` always (so it is dead-lettered).
      const flaky = yield* Subscriber.make("contract.flaky", [ContractStep], (event) =>
        Effect.gen(function* () {
          const key = `${event.aggregate.id}:${event.payload.step}`;
          const transient =
            key === "a:1" && (yield* Ref.getAndUpdate(failuresLeft, (n) => n - 1)) > 0;
          if (transient || key === "c:1") {
            return yield* new BizErrors.Unavailable({ service: "contract" });
          }
          return yield* Ref.update(log, Arr.append(key));
        }),
      );
      const dispatcher = yield* Dispatcher.make([flaky], contractDispatch);
      yield* Effect.forEach(
        [
          ["a", 1],
          ["a", 2],
          ["b", 1],
          ["a", 3],
          ["c", 1],
          ["b", 2],
          ["c", 2],
        ] as const,
        ([aggregate, step]) => recordStep(aggregate, step),
        { concurrency: 1, discard: true },
      );
      yield* dispatcher.drain;
      yield* ensure((yield* logged(log, "a")) === "a:1,a:2,a:3", "a's events arrive in order");
      yield* ensure((yield* logged(log, "b")) === "b:1,b:2", "b's events arrive in order");
      yield* ensure(
        (yield* logged(log, "c")) === "c:2",
        "c's later event follows once its first is dead-lettered",
      );
      const entries = yield* Ref.get(log);
      yield* ensure(
        entries.indexOf("b:2") < entries.indexOf("a:1"),
        "b is not held back while a's first event waits for its retry",
      );
    }),
  ],
];

/**
 * The events contract's cases for a subject: recording is atomic with the
 * command's state change (a failed command records nothing); a redelivered
 * event, including one delivered twice at once, is handled once per
 * subscriber; a failing subscriber blocks no other, is retried, and is
 * dead-lettered with the failure's tag and message after its last attempt;
 * and each subscriber gets an aggregate's events in the order recorded,
 * while an aggregate waiting for a retry holds back no other. The subject is
 * a repository subject the cases write through; provide with it the
 * `Outbox`, `Subscriber.Inbox`, `UnitOfWork` and `EventRecorder` under
 * test. Like {@link unitOfWorkContract}, each case runs under a tenant of
 * its own; give each a fresh store, outbox and inbox, on a live clock.
 *
 * @example
 * ```ts
 * import { Effect, Layer, Option, Struct } from "effect";
 * import * as Audit from "@thomasfosterau/effect-biz/Audit";
 * import * as Company from "@thomasfosterau/effect-biz/Company";
 * import * as Currency from "@thomasfosterau/effect-biz/Currency";
 * import * as EventRecorder from "@thomasfosterau/effect-biz/EventRecorder";
 * import * as Id from "@thomasfosterau/effect-biz/Id";
 * import * as Outbox from "@thomasfosterau/effect-biz/Outbox";
 * import * as Rounding from "@thomasfosterau/effect-biz/Rounding";
 * import * as Subscriber from "@thomasfosterau/effect-biz/Subscriber";
 * import * as Tenancy from "@thomasfosterau/effect-biz/Tenancy";
 * import * as Testing from "@thomasfosterau/effect-biz/testing";
 * import * as UnitOfWork from "@thomasfosterau/effect-biz/UnitOfWork";
 *
 * const cases = Testing.eventsContract({
 *   repository: Effect.service(Company.CompanyRepository),
 *   make: Effect.gen(function* () {
 *     return new Company.Company({
 *       id: yield* Id.generate(Tenancy.CompanyId),
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
 * // Each case against a fresh store, outbox and inbox.
 * const layer = () =>
 *   EventRecorder.layer.pipe(
 *     Layer.provideMerge(
 *       Layer.mergeAll(
 *         Company.layerMemory,
 *         Outbox.layerMemory,
 *         Subscriber.layerInboxMemory,
 *         UnitOfWork.layerMemory,
 *         Id.layerSequential,
 *       ),
 *     ),
 *   );
 * const program = Effect.forEach(cases, (contractCase) => Effect.provide(contractCase.run, layer()), {
 *   concurrency: 1,
 * });
 * Effect.runPromise(program).then(() => console.log(cases.length)); // 4
 * ```
 */
export const eventsContract = <
  I extends string,
  A extends Audit.Audited & { readonly id: I },
  R,
  RMake,
>(
  subject: Subject<I, A, R, RMake>,
): ReadonlyArray<Case<Provided<R | RMake | EventServices>>> =>
  casesOf(
    eventCases<I, A, R | RMake>(),
    2000,
    (port, other) => ({ port, subject, other }),
    subject.repository,
  );

/** The services a numbering-contract case uses. */
export type NumberingServices =
  | NumberSequence.NumberSequences
  | NumberSequence.SequenceDefinitions
  | Company.CompanyRepository
  | UnitOfWork.UnitOfWork
  | Id.IdGenerator;

type NumberingBody = () => Effect.Effect<
  void,
  Failure,
  NumberingServices | Repository.WriteContext
>;

/** How many fibers the concurrent numbering cases race. */
const RACERS = 20;

/** A company of the case's tenant in `timeZone`, with its fiscal year from 1 July. */
const companyIn = (timeZone: string) =>
  Company.create({
    legalName: "Contract Pty Ltd",
    tradingName: Option.none(),
    registrations: [],
    baseCurrency: Currency.make("AUD"),
    country: Company.CountryCode.make("AU"),
    locale: "en-AU",
    timeZone,
    fiscalYearStart: new Company.FiscalYearStart({ month: 7, day: 1 }),
    rounding: new Rounding.RoundingPolicy({ mode: "half-even", scale: 2 }),
  });

/** Defines `documentType` for `company`, its pattern from `pattern`. */
const defineFor = (
  company: Company.Company,
  documentType: string,
  pattern: string,
  options: Pick<NumberSequence.DefineInput, "reset" | "mode"> = {},
) =>
  NumberSequence.define({
    ...options,
    companyId: company.id,
    documentType: NumberSequence.DocumentType.make(documentType),
    pattern: NumberSequence.Pattern.make(pattern),
  });

/** One command that takes the next number and does nothing else. */
const issue = (company: Company.Company, documentType: string) =>
  UnitOfWork.transaction(
    NumberSequence.next(company.id, NumberSequence.DocumentType.make(documentType)),
  );

/** `prefix` followed by each of `1..count`, padded to 4. */
const numbered = (prefix: string, count: number): ReadonlyArray<string> =>
  Arr.makeBy(count, (index) => `${prefix}${String(index + 1).padStart(4, "0")}`);

/**
 * Runs `RACERS` commands at once, each taking a number and then waiting
 * until every one has taken its own (so they all decide from the same
 * counter), then `after` with its index; returns each command's outcome.
 */
const race = <E>(
  take: Effect.Effect<string, E, NumberingServices | Repository.WriteContext>,
  after: (index: number) => Effect.Effect<void, Aborted>,
) =>
  Effect.gen(function* () {
    const arrived = yield* Ref.make(0);
    const allTaken = yield* Deferred.make<void>();
    const gate = yield* Deferred.make<void>();
    const command = (index: number) =>
      UnitOfWork.transaction(
        Effect.gen(function* () {
          const number = yield* take;
          if ((yield* Ref.updateAndGet(arrived, (n) => n + 1)) >= RACERS) {
            yield* Deferred.succeed(allTaken, undefined);
          }
          yield* Deferred.await(gate);
          yield* after(index);
          return number;
        }),
      );
    const fiber = yield* Effect.forkChild(
      Effect.forEach(
        Arr.makeBy(RACERS, (index) => index),
        (index) => Effect.result(command(index)),
        {
          concurrency: "unbounded",
        },
      ),
    );
    yield* Deferred.await(allTaken);
    yield* Deferred.succeed(gate, undefined);
    return yield* Fiber.join(fiber);
  });

const distinct = (values: ReadonlyArray<string>): boolean =>
  Arr.dedupe(values).length === values.length;

const sorted = (values: ReadonlyArray<string>): ReadonlyArray<string> =>
  Arr.sort(values, Order.String);

const epochMillis = (iso: string): number => DateTime.toEpochMillis(DateTime.makeUnsafe(iso));

/** Runs `self` on a `TestClock` of its own, whatever clock the runner provides. */
const onTestClock = <A, E, R>(self: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
  Effect.scoped(
    Effect.flatMap(TestClock.make(), (clock) => Effect.provideService(self, Clock.Clock, clock)),
  );

const numberingCases = (): ReadonlyArray<readonly [string, NumberingBody]> => [
  [
    "concurrent gap-less next calls never repeat a number and leave no gap",
    Effect.fnUntraced(function* () {
      const company = yield* companyIn("UTC");
      yield* defineFor(company, "contract.gap-less", "A-{#}");
      const outcomes = yield* race(issue(company, "contract.gap-less"), () => Effect.void);
      const issued = Arr.getSuccesses(outcomes);
      yield* ensure(Arr.isReadonlyArrayNonEmpty(issued), "at least one command takes a number");
      yield* ensure(distinct(issued), "no number is issued twice");
      yield* ensure(
        Arr.every(Arr.getFailures(outcomes), (error) => P.isTagged(error, "ConcurrencyConflict")),
        "a command that loses every retry fails with ConcurrencyConflict",
      );
      yield* ensure(
        sorted(issued).join() === numbered("A-", issued.length).join(),
        "the numbers issued are 1 to n, without a gap",
      );
      yield* ensure(
        (yield* issue(company, "contract.gap-less")) ===
          numbered("A-", issued.length + 1)[issued.length],
        "the next number follows the last one committed",
      );
    }),
  ],
  [
    "concurrent gaps-allowed next calls never repeat a number, even when their commands roll back",
    Effect.fnUntraced(function* () {
      const company = yield* companyIn("UTC");
      yield* defineFor(company, "contract.gaps", "B-{#}", { mode: "gaps-allowed" });
      const taken = yield* Ref.make<ReadonlyArray<string>>([]);
      const outcomes = yield* race(
        Effect.tap(
          NumberSequence.next(company.id, NumberSequence.DocumentType.make("contract.gaps")),
          (number) => Ref.update(taken, Arr.append(number)),
        ),
        (index) => (index % 2 === 0 ? Effect.void : Effect.fail(new Aborted())),
      );
      const issued = yield* Ref.get(taken);
      yield* ensure(Arr.getSuccesses(outcomes).length === RACERS / 2, "half the commands commit");
      yield* ensure(distinct(issued), "no number is issued twice");
      yield* ensure(
        sorted(issued).join() === numbered("B-", RACERS).join(),
        "every command took a number of its own, at once",
      );
      yield* ensure(
        (yield* issue(company, "contract.gaps")) === numbered("B-", RACERS + 1)[RACERS],
        "a rolled-back command's number is not reissued",
      );
    }),
  ],
  [
    "a rolled-back command consumes no gap-less number",
    Effect.fnUntraced(function* () {
      const company = yield* companyIn("UTC");
      yield* defineFor(company, "contract.rollback", "C-{#}");
      yield* ensure((yield* issue(company, "contract.rollback")) === "C-0001", "the first number");
      yield* Effect.forEach(
        Arr.makeBy(3, (index) => index),
        () =>
          failsWith(
            UnitOfWork.transaction(
              Effect.andThen(
                NumberSequence.next(
                  company.id,
                  NumberSequence.DocumentType.make("contract.rollback"),
                ),
                Effect.fail(new Aborted()),
              ),
            ),
            "Aborted",
            "a command that takes a number and fails",
          ),
        { concurrency: 1, discard: true },
      );
      yield* ensure(
        (yield* issue(company, "contract.rollback")) === "C-0002",
        "the next committed number follows the last committed one",
      );
    }),
  ],
  [
    "a yearly sequence resets at the new year in the company's time zone",
    Effect.fnUntraced(function* () {
      const sydney = yield* companyIn("Australia/Sydney");
      const utc = yield* companyIn("UTC");
      yield* defineFor(sydney, "contract.yearly", "{YYYY}-{#}", { reset: "yearly" });
      yield* defineFor(utc, "contract.yearly", "{YYYY}-{#}", { reset: "yearly" });
      // 23:00 on 31 December in Sydney (UTC+11), and in UTC 12:00.
      yield* TestClock.setTime(epochMillis("2026-12-31T12:00:00Z"));
      yield* ensure((yield* issue(sydney, "contract.yearly")) === "2026-0001", "Sydney's 2026");
      yield* ensure((yield* issue(utc, "contract.yearly")) === "2026-0001", "UTC's 2026");
      // 00:30 on 1 January 2027 in Sydney; still 13:30 on 31 December in UTC.
      yield* TestClock.setTime(epochMillis("2026-12-31T13:30:00Z"));
      yield* ensure(
        (yield* issue(sydney, "contract.yearly")) === "2027-0001",
        "Sydney's counter resets in its own new year",
      );
      yield* ensure(
        (yield* issue(utc, "contract.yearly")) === "2026-0002",
        "UTC's counter carries on in 2026",
      );
    }, onTestClock),
  ],
  [
    "next on a document type without a definition is NotFound",
    Effect.fnUntraced(function* () {
      const company = yield* companyIn("UTC");
      yield* failsWith(
        issue(company, "contract.undefined"),
        "NotFound",
        "next on an undefined type",
      );
    }),
  ],
];

/**
 * The numbering contract's cases: concurrent `next` calls never repeat a
 * number, in gap-less mode (where they also leave no gap) and in
 * gaps-allowed mode (where a rolled-back command keeps its number); a
 * rolled-back command consumes no gap-less number; a yearly reset follows
 * the company's time zone (on a `TestClock` the case provides itself); and
 * an undefined document type is `NotFound`. Each case runs under a tenant
 * of its own and the actor `system:repository-contract`, over the
 * implementation's `NumberSequences`, `SequenceDefinitions`,
 * `CompanyRepository`, `UnitOfWork` and `IdGenerator`; give each fresh
 * stores. The racing cases retry conflicting commits, so run them on a live
 * clock.
 *
 * @example
 * ```ts
 * import { Effect, Layer } from "effect";
 * import * as Company from "@thomasfosterau/effect-biz/Company";
 * import * as Id from "@thomasfosterau/effect-biz/Id";
 * import * as NumberSequence from "@thomasfosterau/effect-biz/NumberSequence";
 * import * as Testing from "@thomasfosterau/effect-biz/testing";
 * import * as UnitOfWork from "@thomasfosterau/effect-biz/UnitOfWork";
 *
 * const cases = Testing.numberSequencesContract();
 *
 * // Each case against fresh stores.
 * const layer = () =>
 *   NumberSequence.layerMemory.pipe(
 *     Layer.provideMerge(
 *       Layer.mergeAll(Company.layerMemory, UnitOfWork.layerMemory, Id.layerSequential),
 *     ),
 *   );
 * const program = Effect.forEach(cases, (contractCase) => Effect.provide(contractCase.run, layer()), {
 *   concurrency: 1,
 * });
 * Effect.runPromise(program).then(() => console.log(cases.length)); // 5
 * ```
 */
export const numberSequencesContract = (): ReadonlyArray<
  Case<Provided<NumberingServices | Repository.WriteContext>>
> => casesOf(numberingCases(), 3000, () => undefined, Effect.void);
