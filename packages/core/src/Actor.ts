/**
 * Who is acting: the principal a command records in its audit fields and
 * approvals.
 *
 * An {@link Actor} is a user, a system process or an integration, with an id
 * and a display name. The host app provides the {@link CurrentActor} per
 * request with {@link withActor}, or derives it from effect-auth's
 * `CurrentPrincipal` with `./Authorization`'s `withActor` / `layerActor`.
 * effect-biz never authenticates.
 *
 * The display name is personal data: never log it or put it in an error.
 *
 * See {@link withActor} for an example.
 *
 * @module
 */

import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import { dual } from "effect/Function";
import * as Schema from "effect/Schema";

/** What kind of principal is acting: a person, a system process or an integration. */
export const ActorKind = Schema.Literals(["user", "system", "integration"]);

/** One of the actor kinds. */
export type ActorKind = typeof ActorKind.Type;

/** A principal that acts: its kind, its id (the host's own) and a display name. */
export class Actor extends Schema.Class<Actor, { readonly brand: unique symbol }>(
  "@effect-biz/Actor/Actor",
)({
  /** What kind of principal this is. */
  kind: ActorKind,
  /** The host's id for the principal: stable, never reused for another. */
  id: Schema.NonEmptyString,
  /** The name shown in audit trails. Personal data: never logged. */
  displayName: Schema.String,
}) {}

/**
 * The actor a call acts as; every mutating command requires it.
 *
 * Request-scoped, like an HTTP request: the host provides it per call.
 *
 * @effect-leakable-service
 */
export class CurrentActor extends Context.Service<CurrentActor, Actor>()(
  "@effect-biz/Actor/CurrentActor",
) {}

/** The actor the call acts as. */
export const current: Effect.Effect<Actor, never, CurrentActor> = Effect.service(CurrentActor);

/**
 * A system actor: a process of the host app itself (a scheduler, a
 * subscriber), named by `id`.
 */
export const system = (id: string): Actor => new Actor({ kind: "system", id, displayName: id });

/**
 * Runs an effect as an actor: provides the {@link CurrentActor}, removing it
 * from the effect's requirements.
 *
 * @example
 * ```ts
 * import { Effect } from "effect";
 * import * as Actor from "@thomasfosterau/effect-biz/Actor";
 *
 * const program = Actor.current.pipe(Effect.map((actor) => actor.kind));
 *
 * console.log(Effect.runSync(program.pipe(Actor.withActor(Actor.system("scheduler"))))); // "system"
 * ```
 */
export const withActor: {
  (
    actor: Actor,
  ): <A, E, R>(self: Effect.Effect<A, E, R>) => Effect.Effect<A, E, Exclude<R, CurrentActor>>;
  <A, E, R>(
    self: Effect.Effect<A, E, R>,
    actor: Actor,
  ): Effect.Effect<A, E, Exclude<R, CurrentActor>>;
} = dual(
  2,
  <A, E, R>(
    self: Effect.Effect<A, E, R>,
    actor: Actor,
  ): Effect.Effect<A, E, Exclude<R, CurrentActor>> =>
    Effect.provideService(self, CurrentActor, actor),
);
