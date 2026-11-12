import { describe, expect } from "vite-plus/test";
import { it, layer } from "@effect/vitest";
import * as Auth from "@thomasfosterau/effect-auth";
import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as R from "effect/Record";
import * as Actor from "../src/Actor.ts";
import * as Authorization from "../src/Authorization.ts";
import * as BizError from "../src/BizError.ts";
import * as Tenancy from "../src/Tenancy.ts";
import { type WidgetId, Widgets, widget, widgetsLayer } from "./fixtures.ts";

const tenant = Tenancy.TenantId.make("0190a6e4-1c2d-7abc-8def-0000000000a1");

// The toy module: its action catalogue and one command that authorises, then
// writes through its repository.
const widgetActions = Authorization.catalogue({
  resource: "widget",
  entityType: "Widget",
  verbs: ["archive"],
  declaration: { memberOf: ["Company"] },
});

const widgetRef = (id: WidgetId): Auth.Entity.EntityRef => Auth.Entity.ref("Widget", id);

const archiveWidget = Effect.fn("archiveWidget")(function* (id: WidgetId, version: number) {
  yield* Authorization.authorize(widgetActions.action("archive"), widgetRef(id));
  return yield* Widgets.use((repository) => repository.archive(id, version));
});

const alice = Auth.Entity.ref("User", "alice");
const bob = Auth.Entity.ref("User", "bob");
const manager = Auth.Entity.ref("Role", "manager");
const acme = Auth.Entity.ref("Company", "acme");

const [w1, w2, w3, w4] = [widget(1), widget(2), widget(3), widget(4)];

// One resolver per module: users and roles from the host, widgets from the toy
// module (each in its company), companies from core. The widget resolver knows
// nothing of companies; composition resolves the parent through `Company`'s.
const resolvers = Authorization.layerResolvers({
  User: Auth.memoryEntityResolver([Auth.Entity.entity(alice, { parents: [manager] })]),
  Role: Auth.memoryEntityResolver([Auth.Entity.entity(manager)]),
  Widget: Auth.memoryEntityResolver(
    [w1, w2, w3, w4].map((row) => Auth.Entity.entity(widgetRef(row.id), { parents: [acme] })),
  ),
  Company: Auth.memoryEntityResolver([Auth.Entity.entity(acme)]),
});

const policies = [
  Auth.Policy.permit({
    id: "managers-archive-acme-widgets",
    principal: Auth.Policy.inScope(manager),
    action: Auth.Policy.eq(Auth.Entity.ref("Action", "widget:archive")),
    resource: Auth.Policy.inScope(acme),
  }),
  Auth.Policy.forbid({
    id: "widget-2-is-locked",
    action: Auth.Policy.eq(Auth.Entity.ref("Action", "widget:archive")),
    resource: Auth.Policy.eq(widgetRef(w2.id)),
  }),
  Auth.System.grant("nightly", {
    id: "nightly-archives-widgets",
    action: "widget:archive",
    resource: Auth.Policy.isType("Widget"),
  }),
];

const model = Authorization.model({
  principals: ["User", "System"],
  catalogues: [widgetActions, Authorization.company],
  entities: { User: { memberOf: ["Role"] }, Role: {} },
});

const policyAuthorizer = Auth.Authorizer.layer({ policies, model }).pipe(
  Layer.provide(resolvers),
  Layer.orDie,
);

/** Runs a command as `principal` under the tenant, its actor derived from the principal. */
const as =
  (principal: Auth.Entity.EntityRef) =>
  <A, E, R>(self: Effect.Effect<A, E, R>) =>
    self.pipe(
      Authorization.withActor(),
      Auth.CurrentPrincipal.provide(principal),
      Tenancy.withTenant(tenant),
    );

const seed = Effect.forEach(
  [w1, w2, w3, w4],
  (row) => Widgets.use((repository) => repository.insert(row)),
  { concurrency: 1 },
).pipe(Tenancy.withTenant(tenant));

layer(Layer.mergeAll(widgetsLayer, policyAuthorizer))("a toy module's command", (it) => {
  it.effect("seeds the store", () => seed);

  it.effect("is allowed under a policy, and records the principal as its actor", () =>
    Effect.gen(function* () {
      const archived = yield* archiveWidget(w1.id, 1).pipe(as(alice));
      expect(Option.isSome(archived.audit.archivedAt)).toBe(true);
      expect(archived.audit.updatedBy).toBe("alice");
      expect(archived.audit.version).toBe(2);
    }),
  );

  it.effect("is Forbidden by default, with the trace, and writes nothing", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(archiveWidget(w3.id, 1).pipe(as(bob)));
      expect(error).toBeInstanceOf(BizError.Forbidden);
      expect(error).toMatchObject({
        _tag: "Forbidden",
        action: "widget:archive",
        resource: `Widget::"${w3.id}"`,
      });
      expect(error.message).toBe(`Forbidden: widget:archive on Widget::"${w3.id}"`);
      expect(error.message).not.toContain("bob");
      expect(error instanceof BizError.Forbidden && error.trace).toEqual(
        Option.some(new BizError.DecisionTrace({ reason: "default-deny", determining: [] })),
      );
      const stored = yield* Widgets.use((repository) => repository.get(w3.id)).pipe(
        Tenancy.withTenant(tenant),
      );
      expect(stored.audit.version).toBe(1);
    }),
  );

  it.effect("is Forbidden by a forbid policy, which the trace names", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(archiveWidget(w2.id, 1).pipe(as(alice)));
      expect(error instanceof BizError.Forbidden && error.trace).toEqual(
        Option.some(
          new BizError.DecisionTrace({
            reason: "forbid",
            determining: [
              new BizError.DeterminingPolicy({
                policyId: "widget-2-is-locked",
                effect: "forbid",
                result: "matched",
              }),
            ],
          }),
        ),
      );
    }),
  );

  it.effect("runs for a system principal it grants, as a system actor", () =>
    Effect.gen(function* () {
      const archived = yield* archiveWidget(w3.id, 1).pipe(as(Auth.System.ref("nightly")));
      expect(archived.audit.updatedBy).toBe("nightly");
      const actor = yield* Actor.current.pipe(as(Auth.System.ref("nightly")));
      expect(actor).toEqual(
        new Actor.Actor({ kind: "system", id: "nightly", displayName: "nightly" }),
      );
    }),
  );

  it.effect("is Forbidden for a system principal no policy names", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(archiveWidget(w4.id, 1).pipe(as(Auth.System.ref("other"))));
      expect(error._tag).toBe("Forbidden");
    }),
  );
});

const failingResolver = Layer.succeed(Auth.EntityResolver, {
  resolve: () => Effect.fail(new Auth.AuthError({ message: 'resolver down for User::"alice"' })),
});

layer(
  Layer.mergeAll(
    widgetsLayer,
    Auth.Authorizer.layer({ policies }).pipe(Layer.provide(failingResolver), Layer.orDie),
  ),
)("an Authorizer that fails", (it) => {
  it.effect("is Unavailable, naming only the Authorizer", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(archiveWidget(w1.id, 1).pipe(as(alice)));
      expect(error).toEqual(new BizError.Unavailable({ service: "Authorizer" }));
    }),
  );
});

layer(Layer.mergeAll(widgetsLayer, Authorization.layerPermissive))("layerPermissive", (it) => {
  it.effect("allows every principal, system ones included", () =>
    Effect.gen(function* () {
      yield* seed;
      yield* archiveWidget(w1.id, 1).pipe(as(bob));
      yield* archiveWidget(w2.id, 1).pipe(as(Auth.System.ref("anything")));
      const authorizer = yield* Auth.Authorizer;
      const decision = yield* authorizer.decideRequest(
        Auth.Policy.request({ principal: bob, action: manager, resource: acme }),
      );
      expect(decision.determining.map((outcome) => outcome.policyId)).toEqual([
        "effect-biz:permissive",
      ]);
      expect(
        yield* authorizer
          .check({ action: "widget:archive", resource: acme })
          .pipe(Auth.CurrentPrincipal.provide(bob)),
      ).toBe(true);
    }),
  );
});

describe("composeResolvers", () => {
  const group = Auth.Entity.ref("Group", "g");
  const order = Auth.Entity.ref("Order", "o");
  const composed = Authorization.composeResolvers({
    // A resolver may return ancestors of its own; each entity appears once.
    Order: Auth.memoryEntityResolver([
      Auth.Entity.entity(order, { parents: [acme, group] }),
      Auth.Entity.entity(group, { parents: [acme] }),
    ]),
    Group: Auth.memoryEntityResolver([Auth.Entity.entity(group, { parents: [acme] })]),
    Company: Auth.memoryEntityResolver([Auth.Entity.entity(acme)]),
  });

  it.effect("returns each requested entity and its transitive ancestors, once", () =>
    Effect.gen(function* () {
      const resolved = yield* composed.resolve([order, order, Auth.Entity.ref("Unknown", "u")]);
      expect(resolved.map((entity) => Auth.Entity.formatRef(entity.ref)).toSorted()).toEqual(
        ['Company::"acme"', 'Group::"g"', 'Order::"o"'].toSorted(),
      );
    }),
  );

  it.effect("returns nothing for no references or unknown types", () =>
    Effect.gen(function* () {
      expect(yield* composed.resolve([])).toEqual([]);
      expect(yield* composed.resolve([Auth.Entity.ref("Unknown", "u")])).toEqual([]);
    }),
  );
});

describe("catalogue and model", () => {
  it("names each action resource:verb", () => {
    expect(Authorization.company.ids).toEqual([
      "company:create",
      "company:read",
      "company:update",
      "company:archive",
      "company:restore",
    ]);
    expect(Authorization.company.action("archive")).toBe("company:archive");
  });

  it("builds a fragment and a model the Authorizer validates against", () => {
    expect(Authorization.fragment(widgetActions, ["User"])).toEqual({
      entities: { Widget: { memberOf: ["Company"] } },
      actions: { "widget:archive": { appliesTo: { principal: ["User"], resource: ["Widget"] } } },
    });
    expect(model.entities["System"]).toBe(Auth.System.declaration);
    expect(R.keys(model.actions)).toContain("company:create");
  });

  it.effect("fails the Authorizer layer on a policy naming an undeclared action", () =>
    Effect.gen(function* () {
      const exit = yield* Effect.exit(
        Layer.build(
          Auth.Authorizer.layer({
            model,
            policies: [
              Auth.Policy.permit({
                id: "typo",
                action: Auth.Policy.eq(Auth.Entity.ref("Action", "widget:archvie")),
              }),
            ],
          }),
        ).pipe(Effect.scoped),
      );
      expect(Exit.isFailure(exit)).toBe(true);
    }),
  );
});

describe("toActor", () => {
  it("maps user, system and integration principals", () => {
    expect(Authorization.toActor(alice)).toEqual(
      new Actor.Actor({ kind: "user", id: "alice", displayName: "alice" }),
    );
    expect(Authorization.toActor(Auth.System.ref("nightly")).kind).toBe("system");
    expect(Authorization.toActor(Auth.Entity.ref("Integration", "shopify")).kind).toBe(
      "integration",
    );
    expect(
      Authorization.toActor(Auth.Entity.ref("ApiClient", "k1"), {
        integrationTypes: ["ApiClient"],
        displayName: () => "Key one",
      }),
    ).toEqual(new Actor.Actor({ kind: "integration", id: "k1", displayName: "Key one" }));
  });
});

layer(Authorization.layerActor().pipe(Layer.provide(Auth.System.layer("importer"))))(
  "layerActor",
  (it) => {
    it.effect("provides the CurrentActor from the CurrentPrincipal", () =>
      Effect.gen(function* () {
        const actor = yield* Actor.current;
        expect(actor).toEqual(
          new Actor.Actor({ kind: "system", id: "importer", displayName: "importer" }),
        );
      }),
    );
  },
);

layer(NodeFileSystem.layer)("the effect-auth boundary", (it) => {
  const src = new URL("../src/", import.meta.url);

  it.effect("is crossed by ./Authorization alone, so effect-auth stays an optional peer", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const files = yield* fs.readDirectory(src.pathname);
      const importers = yield* Effect.filter(
        files,
        (file) =>
          Effect.map(fs.readFileString(new URL(file, src).pathname), (text) =>
            text.includes('from "@thomasfosterau/effect-auth'),
          ),
        { concurrency: "unbounded" },
      );
      expect(importers).toEqual(["Authorization.ts"]);
    }),
  );
});
