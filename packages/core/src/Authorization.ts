/**
 * Authorisation through effect-auth's policy kernel: the one module of this
 * package that imports `@thomasfosterau/effect-auth` (an optional peer).
 *
 * effect-biz has no policy engine, no RBAC and no authentication of its own.
 * A command names the action it performs, in `"resource:action"` form
 * (`"company:archive"`), and the resource it acts on, as an effect-auth
 * `EntityRef` (`Company::"<id>"`), and {@link authorize} asks effect-auth's
 * `Authorizer` whether the `CurrentPrincipal` may. A denial is
 * `BizError.Forbidden`, carrying the decision's trace (the determining
 * policies, never the principal) for audit.
 *
 * Around it: {@link catalogue} declares a module's actions and {@link model}
 * turns catalogues into an effect-auth `AuthorizationModel`;
 * {@link composeResolvers} builds the host's one `EntityResolver` from each
 * module's resolvers, keyed by entity type; {@link toActor} /
 * {@link withActor} / {@link layerActor} derive `Actor.CurrentActor` from the
 * `CurrentPrincipal`; and {@link layerPermissive} allows everything, for
 * tests.
 *
 * Tenancy stays independent of effect-auth's Organizations: the host provides
 * the `Tenancy.TenantContext` and the `CurrentPrincipal` separately.
 *
 * See {@link authorize} for an example.
 *
 * @module
 */

import * as Auth from "@thomasfosterau/effect-auth";
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import { dual } from "effect/Function";
import * as HashSet from "effect/HashSet";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as R from "effect/Record";
import * as Actor from "./Actor.js";
import * as BizError from "./BizError.js";

/** An action id in `"resource:action"` form, such as `"company:create"`. */
export type ActionId = `${string}:${string}`;

/** The entity type the Authorizer's failures are reported under, as `Unavailable`. */
const AUTHORIZER = "Authorizer";

/** The {@link BizError.DecisionTrace} of a denial: its reason and determining policies, no error text. */
const traceOf = (decision: Auth.Decision): BizError.DecisionTrace =>
  new BizError.DecisionTrace({
    reason: decision.reason === "forbid" ? "forbid" : "default-deny",
    determining: Arr.map(
      decision.determining,
      (outcome) =>
        new BizError.DeterminingPolicy({
          policyId: outcome.policyId,
          effect: outcome.effect,
          result: outcome.result,
        }),
    ),
  });

/**
 * Authorises the current principal to perform `action` on `resource`, through
 * effect-auth's `Authorizer`. Succeeds when the decision allows; a denial is a
 * {@link BizError.Forbidden} with the action, the resource rendered as
 * effect-auth renders it (`Company::"<id>"`) and the decision's trace. Any
 * other failure of the Authorizer (a resolver or policy store that is down)
 * is {@link BizError.Unavailable}, naming `"Authorizer"` only: no error
 * carries the principal.
 *
 * @example
 * ```ts
 * import { Effect, Layer } from "effect";
 * import * as Auth from "@thomasfosterau/effect-auth";
 * import * as Authorization from "@thomasfosterau/effect-biz/Authorization";
 *
 * const policies = [
 *   Auth.Policy.permit({
 *     id: "alice-archives-companies",
 *     principal: Auth.Policy.eq(Auth.Entity.ref("User", "alice")),
 *     action: Auth.Policy.eq(Auth.Entity.ref("Action", "company:archive")),
 *     resource: Auth.Policy.isType("Company"),
 *   }),
 * ];
 *
 * const archive = Authorization.authorize(
 *   Authorization.company.action("archive"),
 *   Auth.Entity.ref("Company", "0190a6e4-1c2d-7abc-8def-0123456789ab"),
 * );
 *
 * const run = (user: string) =>
 *   Effect.runSync(
 *     archive.pipe(
 *       Effect.as("allowed"),
 *       Effect.catchTag("Forbidden", (error) => Effect.succeed(error.message)),
 *       Auth.CurrentPrincipal.provide(Auth.Entity.ref("User", user)),
 *       Effect.provide(Layer.orDie(Auth.Authorizer.layer({ policies }))),
 *     ),
 *   );
 *
 * console.log(run("alice")); // "allowed"
 * console.log(run("bob")); // 'Forbidden: company:archive on Company::"0190a6e4-1c2d-7abc-8def-0123456789ab"'
 * ```
 */
export const authorize = (
  action: ActionId,
  resource: Auth.Entity.EntityRef,
): Effect.Effect<
  void,
  BizError.Forbidden | BizError.Unavailable,
  Auth.Authorizer | Auth.CurrentPrincipal
> =>
  Auth.Authorizer.use((authorizer) => authorizer.authorize({ action, resource })).pipe(
    Effect.asVoid,
    Effect.catchTags({
      AuthorizationDeniedError: (denied) =>
        Effect.fail(
          new BizError.Forbidden({
            action,
            resource: Auth.Entity.formatRef(resource),
            trace: Option.some(traceOf(denied.decision)),
          }),
        ),
      AuthError: () => Effect.fail(new BizError.Unavailable({ service: AUTHORIZER })),
    }),
  );

/**
 * What a model needs of a {@link Catalogue}: its entity type, its action ids
 * and the entity type's declaration. Every catalogue is one, whatever its
 * verbs.
 */
export interface Declared {
  /** The effect-auth entity type the actions apply to: `"Company"`. */
  readonly entityType: string;
  /** Every action id of the catalogue, in declaration order. */
  readonly ids: ReadonlyArray<ActionId>;
  /**
   * The entity type's declaration in the model (its attribute schema and the
   * types it may be `in`); none by default.
   */
  readonly declaration?: Auth.AuthorizationModel.EntityTypeDecl;
}

/**
 * A module's actions on one entity type: the action ids it authorises, each
 * `"<resource>:<verb>"`, built by {@link catalogue}.
 */
export interface Catalogue<Resource extends string, Verb extends string> extends Declared {
  /** The resource half of every action id, in kebab case: `"company"`. */
  readonly resource: Resource;
  /** Every action id of the catalogue, in declaration order. */
  readonly ids: ReadonlyArray<`${Resource}:${Verb}`>;
  /** The action id of one verb: `company.action("create")` is `"company:create"`. */
  readonly action: (verb: Verb) => `${Resource}:${Verb}`;
}

/** What {@link catalogue} takes. */
export interface CatalogueOptions<Resource extends string, Verb extends string> {
  /** The resource half of every action id, in kebab case: `"sales-order"`. */
  readonly resource: Resource;
  /** The effect-auth entity type the actions apply to: `"SalesOrder"`. */
  readonly entityType: string;
  /** The verbs, each an action `"<resource>:<verb>"`: `["create", "confirm"]`. */
  readonly verbs: ReadonlyArray<Verb>;
  /**
   * The entity type's declaration in the model: the schema of its attribute
   * bag and the types it may be `in` (`{ memberOf: ["Company"] }`).
   */
  readonly declaration?: Auth.AuthorizationModel.EntityTypeDecl;
}

/**
 * Declares a module's actions on one entity type: `catalogue({ resource:
 * "company", entityType: "Company", verbs: ["create", "update"] })` holds
 * `"company:create"` and `"company:update"`. Its {@link fragment} is the
 * module's part of the host's `AuthorizationModel`.
 */
export const catalogue = <const Resource extends string, const Verb extends string>(
  options: CatalogueOptions<Resource, Verb>,
): Catalogue<Resource, Verb> => {
  const action = (verb: Verb): `${Resource}:${Verb}` => `${options.resource}:${verb}`;
  return { ...options, ids: Arr.map(options.verbs, action), action };
};

/**
 * The actions on a `Company` (the entity type `Company`): `company:create`,
 * `company:read`, `company:update`, `company:archive` and `company:restore`.
 * `./Company`'s commands do not call {@link authorize} themselves (that would
 * make effect-auth a requirement of every host); a host that authorises
 * wraps them, naming these actions.
 */
export const company: Catalogue<"company", "create" | "read" | "update" | "archive" | "restore"> =
  catalogue({
    resource: "company",
    entityType: "Company",
    verbs: ["create", "read", "update", "archive", "restore"],
  });

/**
 * A catalogue as an effect-auth `AuthorizationModel` fragment: its entity type,
 * and each action applying to the given principal types and that entity type.
 */
export const fragment = (
  entry: Declared,
  principals: ReadonlyArray<string>,
): Auth.AuthorizationModel.Model => ({
  entities: { [entry.entityType]: entry.declaration ?? {} },
  actions: R.fromEntries(
    Arr.map(entry.ids, (id): readonly [string, Auth.AuthorizationModel.ActionDecl] => [
      id,
      { appliesTo: { principal: principals, resource: [entry.entityType] } },
    ]),
  ),
});

/** What {@link model} takes. */
export interface ModelOptions {
  /**
   * The host's principal entity types, such as `["User", "System"]`. `"System"`
   * (effect-auth's system principals) is declared with
   * `Auth.System.declaration`; any other is declared with no attributes.
   */
  readonly principals: ReadonlyArray<string>;
  /** Every module's catalogue. */
  readonly catalogues: ReadonlyArray<Declared>;
  /**
   * The host's other entity types (roles, groups) and any declaration that
   * replaces a principal's or a catalogue's: `{ User: { memberOf: ["Role"] },
   * Role: {} }`. Merged last.
   */
  readonly entities?: Readonly<Record<string, Auth.AuthorizationModel.EntityTypeDecl>>;
}

/**
 * The host's effect-auth `AuthorizationModel` from every module's catalogue:
 * the principal types, each catalogue's {@link fragment}, merged. Pass it as
 * `Auth.Authorizer.layer({ policies, model })`'s `model`, so a policy naming
 * an undeclared action fails the layer instead of never matching.
 */
export const model = (options: ModelOptions): Auth.AuthorizationModel.Model => {
  const fragments = Arr.map(options.catalogues, (entry) => fragment(entry, options.principals));
  const principals = R.fromEntries(
    Arr.map(
      options.principals,
      (type): readonly [string, Auth.AuthorizationModel.EntityTypeDecl] => [
        type,
        type === Auth.System.entityType ? Auth.System.declaration : {},
      ],
    ),
  );
  return Auth.AuthorizationModel.make({
    entities: {
      ...Arr.reduce(fragments, principals, (entities, part) => ({
        ...entities,
        ...part.entities,
      })),
      ...options.entities,
    },
    actions: Arr.reduce(
      fragments,
      R.empty<string, Auth.AuthorizationModel.ActionDecl>(),
      (actions, part) => ({ ...actions, ...part.actions }),
    ),
  });
};

/** One module's entity resolver: effect-auth's `EntityResolver` service shape. */
export type Resolver = typeof Auth.EntityResolver.Service;

/** Resolvers keyed by the entity type each resolves: `{ Company: …, SalesOrder: … }`. */
export type Resolvers = Readonly<Record<string, Resolver>>;

/** The references' keys, as effect-auth keys them. */
const keysOf = (refs: ReadonlyArray<Auth.Entity.EntityRef>): HashSet.HashSet<string> =>
  HashSet.fromIterable(Arr.map(refs, Auth.Entity.refKey));

/** The references not yet in `seen`, each once. */
const unseen = (
  refs: ReadonlyArray<Auth.Entity.EntityRef>,
  seen: HashSet.HashSet<string>,
): ReadonlyArray<Auth.Entity.EntityRef> =>
  Arr.dedupeWith(
    Arr.filter(refs, (ref) => !HashSet.has(seen, Auth.Entity.refKey(ref))),
    Auth.Entity.refEquals,
  );

/** Resolves `refs` through the resolver of each one's type; a type no resolver knows yields nothing. */
const resolveByType = (
  resolvers: Resolvers,
  refs: ReadonlyArray<Auth.Entity.EntityRef>,
): Effect.Effect<ReadonlyArray<Auth.Entity.Entity>, Auth.AuthError> =>
  Effect.map(
    Effect.forEach(
      R.toEntries(Arr.groupBy(refs, (ref) => ref.type)),
      ([type, group]) =>
        Option.match(R.get(resolvers, type), {
          onNone: () => Effect.succeed<ReadonlyArray<Auth.Entity.Entity>>([]),
          onSome: (resolver) => resolver.resolve(group),
        }),
      { concurrency: "unbounded" },
    ),
    Arr.flatten,
  );

/**
 * The entities of `pending` and their transitive ancestors, each once: every
 * round resolves the references not yet asked for, then queues the parents of
 * what it found that are neither asked for nor found, until none are left.
 */
const closure = (
  resolvers: Resolvers,
  pending: ReadonlyArray<Auth.Entity.EntityRef>,
  asked: HashSet.HashSet<string>,
  found: ReadonlyArray<Auth.Entity.Entity>,
): Effect.Effect<ReadonlyArray<Auth.Entity.Entity>, Auth.AuthError> =>
  Arr.isReadonlyArrayNonEmpty(pending)
    ? Effect.flatMap(resolveByType(resolvers, pending), (resolved) => {
        const foundKeys = keysOf(Arr.map(found, (entity) => entity.ref));
        const fresh = Arr.dedupeWith(
          Arr.filter(resolved, (entity) => !HashSet.has(foundKeys, Auth.Entity.refKey(entity.ref))),
          (a: Auth.Entity.Entity, b: Auth.Entity.Entity) => Auth.Entity.refEquals(a.ref, b.ref),
        );
        const all = Arr.appendAll(found, fresh);
        const nowAsked = HashSet.union(asked, keysOf(pending));
        const seen = HashSet.union(nowAsked, keysOf(Arr.map(all, (entity) => entity.ref)));
        const parents = unseen(
          Arr.flatMap(fresh, (entity) => entity.parents),
          seen,
        );
        return closure(resolvers, parents, nowAsked, all);
      })
    : Effect.succeed(found);

/**
 * The host's one effect-auth `EntityResolver`, from each module's resolvers
 * keyed by entity type. A request's references are grouped by type and each
 * group goes to its type's resolver (concurrently); the parents of what they
 * return are resolved the same way, round after round, so the slice holds
 * every transitive ancestor, as effect-auth's contract requires, even when a
 * parent belongs to another module (a sales order in its `Company`). A type
 * no resolver knows is omitted, which effect-auth reads as an entity with no
 * attributes and no parents.
 *
 * A module resolver reads only what it is asked for; it may return ancestors
 * too, and each entity appears once in the result.
 */
export const composeResolvers = (resolvers: Resolvers): Resolver => ({
  resolve: (refs) => closure(resolvers, unseen(refs, HashSet.empty()), HashSet.empty(), []),
});

/** The effect-auth `EntityResolver` of {@link composeResolvers}, as a layer. */
export const layerResolvers = (resolvers: Resolvers): Layer.Layer<Auth.EntityResolver> =>
  Layer.succeed(Auth.EntityResolver, composeResolvers(resolvers));

/** How {@link toActor} reads a principal. */
export interface ActorOptions {
  /**
   * The principal entity types that are integrations (an API client, a sales
   * channel connector): `["Integration"]` by default.
   */
  readonly integrationTypes?: ReadonlyArray<string>;
  /**
   * The display name of a principal. By default a system principal's is its
   * name and any other's is its id, so the default adds no personal data; a
   * host that has the person's name supplies it here. Personal data: never
   * logged.
   */
  readonly displayName?: (principal: Auth.Entity.EntityRef) => string;
}

/**
 * The {@link Actor.Actor} a principal acts as: effect-auth's system principals
 * (`System::"<name>"`) are `"system"` actors named by their name, the
 * integration types are `"integration"` actors, and every other principal is
 * a `"user"`. The actor's id is the principal's id (so a system actor's id is
 * its name, as `Actor.system` makes it); a principal with an empty id is a
 * defect.
 */
export const toActor = (principal: Auth.Entity.EntityRef, options?: ActorOptions): Actor.Actor => {
  const integrationTypes = options?.integrationTypes ?? ["Integration"];
  const kind: Actor.ActorKind = Auth.System.isSystem(principal)
    ? "system"
    : integrationTypes.includes(principal.type)
      ? "integration"
      : "user";
  const displayName = options?.displayName?.(principal) ?? principal.id;
  return new Actor.Actor({ kind, id: principal.id, displayName });
};

/** The actor the current principal acts as ({@link toActor}). */
export const currentActor = (
  options?: ActorOptions,
): Effect.Effect<Actor.Actor, never, Auth.CurrentPrincipal> =>
  Effect.map(Effect.service(Auth.CurrentPrincipal), (principal) => toActor(principal, options));

/**
 * Runs an effect as the actor of the current principal: provides
 * `Actor.CurrentActor` from effect-auth's `CurrentPrincipal`
 * ({@link toActor}), which the effect then requires instead.
 */
export const withActor: {
  (
    options?: ActorOptions,
  ): <A, E, R>(
    self: Effect.Effect<A, E, R>,
  ) => Effect.Effect<A, E, Exclude<R, Actor.CurrentActor> | Auth.CurrentPrincipal>;
  <A, E, R>(
    self: Effect.Effect<A, E, R>,
    options?: ActorOptions,
  ): Effect.Effect<A, E, Exclude<R, Actor.CurrentActor> | Auth.CurrentPrincipal>;
} = dual(
  (args) => Effect.isEffect(args[0]),
  <A, E, R>(
    self: Effect.Effect<A, E, R>,
    options?: ActorOptions,
  ): Effect.Effect<A, E, Exclude<R, Actor.CurrentActor> | Auth.CurrentPrincipal> =>
    Effect.flatMap(currentActor(options), (actor) => Actor.withActor(self, actor)),
);

/** `Actor.CurrentActor` derived from effect-auth's `CurrentPrincipal` ({@link toActor}), as a layer. */
export const layerActor = (
  options?: ActorOptions,
): Layer.Layer<Actor.CurrentActor, never, Auth.CurrentPrincipal> =>
  Layer.effect(Actor.CurrentActor, currentActor(options));

/** The one policy outcome of {@link layerPermissive}'s decisions. */
const permissiveOutcome: Auth.PolicyOutcome = {
  policyId: "effect-biz:permissive",
  effect: "permit",
  result: "matched",
};

/** The decision {@link layerPermissive} makes for every request. */
const permissiveDecision: Auth.Decision = {
  allowed: true,
  reason: "permit",
  determining: [permissiveOutcome],
  outcomes: [permissiveOutcome],
};

/**
 * An effect-auth `Authorizer` that allows every request, system principals
 * included, with the policy id `"effect-biz:permissive"` in its trace. For
 * tests and examples only: it bypasses every policy.
 */
export const layerPermissive: Layer.Layer<Auth.Authorizer> = Layer.succeed(Auth.Authorizer, {
  decideRequest: () => Effect.succeed(permissiveDecision),
  authorize: () => Effect.succeed(permissiveDecision),
  check: () => Effect.succeed(true),
});
