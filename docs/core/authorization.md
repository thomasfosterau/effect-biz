# Authorisation

effect-biz has no policy engine, no RBAC and no authentication of its own. A command is authorised by [`@thomasfosterau/effect-auth`](https://www.npmjs.com/package/@thomasfosterau/effect-auth)'s `Authorizer`, and `./Authorization` (`@thomasfosterau/effect-biz/Authorization`) is the one module of core that imports it. effect-auth is an optional peer: install it only if you use this subpath.

```sh
pnpm add @thomasfosterau/effect-auth
```

See also [tenancy, companies and actors](tenancy.md) and [identifiers and errors](ids-and-errors.md).

## Actions and resources

An action is a string in `"resource:action"` form (`"company:archive"`, `"sales-order:confirm"`); effect-auth decides it as the entity `Action::"company:archive"`. A resource is an effect-auth `EntityRef` (`Auth.Entity.ref("Company", id)`, rendered `Company::"<id>"`). The principal is effect-auth's `CurrentPrincipal`, which the host provides per request, exactly as it provides the `Tenancy.TenantContext`. Tenancy is independent of effect-auth's Organizations.

`Authorization.authorize(action, resource)` asks the `Authorizer` and succeeds when the decision allows. A denial is `BizError.Forbidden` with the action, the rendered resource and a `trace`: the decision's reason (`"forbid"` or `"default-deny"`) and the policies that determined it, by id. The trace never carries the principal, an attribute value or a policy's error text, so it is safe to store in an audit log. Any other failure of the `Authorizer` (a resolver or policy store that is down) is `BizError.Unavailable` with `service: "Authorizer"`.

## Declaring a module's actions

Each module declares its actions as a catalogue, and the host merges the catalogues into one effect-auth `AuthorizationModel`, so a policy naming an action that does not exist fails the `Authorizer` layer instead of silently never matching. Core's own is `Authorization.company` (`company:create`, `company:read`, `company:update`, `company:archive`, `company:restore`).

```ts
import { Effect, Exit, Layer } from "effect";
import * as Auth from "@thomasfosterau/effect-auth";
import * as Authorization from "@thomasfosterau/effect-biz/Authorization";

const salesOrder = Authorization.catalogue({
  resource: "sales-order",
  entityType: "SalesOrder",
  verbs: ["create", "confirm", "cancel"],
  declaration: { memberOf: ["Company"] },
});

console.log(salesOrder.action("confirm")); // "sales-order:confirm"

const model = Authorization.model({
  principals: ["User", "System"],
  catalogues: [Authorization.company, salesOrder],
  entities: { User: { memberOf: ["Role"] }, Role: {} },
});

const typo = Auth.Policy.permit({
  id: "typo",
  action: Auth.Policy.eq(Auth.Entity.ref("Action", "sales-order:confrim")),
});

const exit = Effect.runSync(
  Effect.exit(Effect.scoped(Layer.build(Auth.Authorizer.layer({ policies: [typo], model })))),
);
console.log(Exit.isFailure(exit)); // true
```

`Authorization.fragment(catalogue, principals)` is one catalogue's part of the model, for a host that assembles its model by hand.

## Authorising a command

A command calls `authorize` before its load-decide-commit, naming its action and the resource. The commands of `./Company` do not call it themselves: that would make effect-auth a requirement of every host, optional peer or not. A host that authorises wraps them:

```ts
import { Effect, Layer, Option } from "effect";
import * as Auth from "@thomasfosterau/effect-auth";
import * as Authorization from "@thomasfosterau/effect-biz/Authorization";
import * as Company from "@thomasfosterau/effect-biz/Company";
import * as Currency from "@thomasfosterau/effect-biz/Currency";
import * as Id from "@thomasfosterau/effect-biz/Id";
import * as Rounding from "@thomasfosterau/effect-biz/Rounding";
import * as Tenancy from "@thomasfosterau/effect-biz/Tenancy";

const archiveCompany = (company: Company.Company) =>
  Authorization.authorize(
    Authorization.company.action("archive"),
    Auth.Entity.ref("Company", company.id),
  ).pipe(Effect.andThen(Company.archive(company.id, company.audit.version)));

const policies = [
  Auth.Policy.permit({
    id: "admins-manage-companies",
    principal: Auth.Policy.inScope(Auth.Entity.ref("Role", "admin")),
    resource: Auth.Policy.isType("Company"),
  }),
];

const resolvers = Authorization.layerResolvers({
  User: Auth.memoryEntityResolver([
    Auth.Entity.entity(Auth.Entity.ref("User", "alice"), {
      parents: [Auth.Entity.ref("Role", "admin")],
    }),
  ]),
});

const layer = Layer.mergeAll(
  Company.layerMemory,
  Id.layerSequential,
  Layer.orDie(Auth.Authorizer.layer({ policies }).pipe(Layer.provide(resolvers))),
);

const as =
  (principal: Auth.Entity.EntityRef) =>
  <A, E, R>(self: Effect.Effect<A, E, R>) =>
    self.pipe(Authorization.withActor(), Auth.CurrentPrincipal.provide(principal));

const program = Effect.gen(function* () {
  // Not authorised here: only the onboarding job's actor comes from its principal.
  const created = yield* Company.create({
    legalName: "Example Pty Ltd",
    tradingName: Option.none(),
    registrations: [],
    baseCurrency: Currency.make("AUD"),
    country: Company.CountryCode.make("AU"),
    locale: "en-AU",
    timeZone: "Australia/Sydney",
    fiscalYearStart: new Company.FiscalYearStart({ month: 7, day: 1 }),
    rounding: new Rounding.RoundingPolicy({ mode: "half-even", scale: 2 }),
  }).pipe(as(Auth.System.ref("onboarding")));

  const denied = yield* Effect.flip(
    archiveCompany(created).pipe(as(Auth.Entity.ref("User", "bob"))),
  );
  console.log(denied.message); // 'Forbidden: company:archive on Company::"…"'

  const archived = yield* archiveCompany(created).pipe(as(Auth.Entity.ref("User", "alice")));
  console.log(archived.audit.updatedBy); // "alice"
});

const tenant = Tenancy.TenantId.make("0190a6e4-1c2d-7abc-8def-0123456789ab");
Effect.runSync(program.pipe(Tenancy.withTenant(tenant), Effect.provide(layer)));
```

## Resolvers

effect-auth decides over a slice of the entity graph that its `EntityResolver` fetches: the principal, the action, the resource and their ancestors. Each module contributes resolvers for its own entity types, and `Authorization.composeResolvers({ Company: …, SalesOrder: … })` (or `layerResolvers`, the same as a layer) builds the host's one resolver. A request's references are grouped by type and sent to their type's resolver concurrently; the parents of what comes back are resolved the same way until none are left, so a sales order's `Company` parent is found through the company resolver. A type no resolver knows is omitted, which effect-auth reads as an entity with no attributes and no parents.

## Actors

The `Actor.CurrentActor` a command records in its audit fields is derived from the `CurrentPrincipal`: `Authorization.withActor(options?)` provides it for one effect, `layerActor(options?)` as a layer, and `toActor(principal, options?)` is the mapping. effect-auth's system principals (`System::"<name>"`) are `"system"` actors named by their name (the same actor `Actor.system(name)` makes), the `integrationTypes` (by default `["Integration"]`) are `"integration"` actors, and every other principal is a `"user"`. The actor's id is the principal's id. The display name defaults to that id, adding no personal data; a host that has a person's name passes `displayName`, and never logs it.

## Testing

`Authorization.layerPermissive` is an `Authorizer` that allows every request, system principals included, with the policy id `"effect-biz:permissive"` in its trace. Use it in a module's tests where authorisation is not the subject; test the policies themselves with effect-auth's in-memory pieces (`Auth.Authorizer.layer({ policies })` over `memoryEntityResolver`s), as above.

```ts
import { Effect } from "effect";
import * as Auth from "@thomasfosterau/effect-auth";
import * as Authorization from "@thomasfosterau/effect-biz/Authorization";

const program = Authorization.authorize("anything:at-all", Auth.Entity.ref("Thing", "t1")).pipe(
  Effect.as("allowed"),
  Auth.System.provide("any-job"),
  Effect.provide(Authorization.layerPermissive),
);

console.log(Effect.runSync(program)); // "allowed"
```
