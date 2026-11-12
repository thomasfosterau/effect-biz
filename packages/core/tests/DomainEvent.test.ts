import { expect } from "vite-plus/test";
import { it, layer } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { TestClock } from "effect/testing";
import * as Actor from "../src/Actor.ts";
import * as BizError from "../src/BizError.ts";
import * as DomainEvent from "../src/DomainEvent.ts";
import * as EventRecorder from "../src/EventRecorder.ts";
import * as Tenancy from "../src/Tenancy.ts";
import * as UnitOfWork from "../src/UnitOfWork.ts";
import {
  OrderConfirmed,
  company,
  confirm,
  eventsLayer,
  outbox,
  tenant,
} from "./events.fixtures.ts";

const V1 = DomainEvent.make("test.thing.renamed", Schema.Struct({ name: Schema.String }));
const V2 = DomainEvent.evolve(
  V1,
  Schema.Struct({ first: Schema.String, last: Schema.String }),
  ({ name }) => ({ first: name, last: "" }),
);
const V3 = DomainEvent.evolve(V2, Schema.Struct({ full: Schema.String }), ({ first, last }) => ({
  full: `${first} ${last}`.trim(),
}));

const envelopeOf = (type: string, version: number, payload: Schema.Json) =>
  new DomainEvent.Envelope({
    eventId: DomainEvent.EventId.make("00000000-0000-7000-8000-000000000001"),
    type,
    version,
    tenantId: tenant,
    companyId: Option.none(),
    aggregate: new DomainEvent.AggregateRef({ kind: "Thing", id: "t-1", version: 1 }),
    occurredAt: DateTime.makeUnsafe(0),
    actor: new DomainEvent.ActorRef({ kind: "system", id: "test" }),
    correlationId: "00000000-0000-7000-8000-000000000001",
    causationId: Option.none(),
    payload,
  });

it.effect("a definition is version 1 of its type", () =>
  Effect.sync(() => {
    expect([V1.type, V1.version, V2.version, V3.version]).toEqual(["test.thing.renamed", 1, 2, 3]);
  }),
);

it.effect("an envelope stored at an earlier version decodes through every upcaster since", () =>
  Effect.gen(function* () {
    const fromV1 = yield* V3.decode(envelopeOf("test.thing.renamed", 1, { name: "Ada" }));
    expect(fromV1.payload).toEqual({ full: "Ada" });
    expect(fromV1.version).toBe(1);
    const fromV2 = yield* V3.decode(
      envelopeOf("test.thing.renamed", 2, { first: "Ada", last: "Lovelace" }),
    );
    expect(fromV2.payload).toEqual({ full: "Ada Lovelace" });
    const fromV3 = yield* V3.decode(envelopeOf("test.thing.renamed", 3, { full: "A L" }));
    expect(fromV3.payload).toEqual({ full: "A L" });
  }),
);

it.effect("a reader of a version ignores fields added to it (an additive change)", () =>
  Effect.gen(function* () {
    const event = yield* V1.decode(
      envelopeOf("test.thing.renamed", 1, { name: "Ada", nickname: "A" }),
    );
    expect(event.payload).toEqual({ name: "Ada" });
  }),
);

it.effect("a newer version, another type or a refused payload is a ValidationError", () =>
  Effect.gen(function* () {
    const newer = yield* Effect.flip(V2.decode(envelopeOf("test.thing.renamed", 3, {})));
    expect(newer.issues[0]?.path).toEqual(["version"]);
    const other = yield* Effect.flip(V1.decode(envelopeOf("test.other", 1, { name: "x" })));
    expect(other.issues[0]?.path).toEqual(["type"]);
    const refused = yield* Effect.flip(V1.decode(envelopeOf("test.thing.renamed", 1, { name: 1 })));
    expect(refused).toBeInstanceOf(BizError.ValidationError);
    expect(refused.issues[0]?.path).toEqual(["name"]);
  }),
);

it.effect("an envelope round-trips through its JSON encoding", () =>
  Effect.gen(function* () {
    const envelope = envelopeOf("test.thing.renamed", 1, { name: "Ada" });
    const json = yield* Schema.encodeEffect(DomainEvent.EnvelopeFromJson)(envelope);
    expect(json).toContain('"occurredAt":"1970-01-01T00:00:00.000Z"');
    expect(json).toContain('"companyId":null');
    const decoded = yield* Schema.decodeEffect(DomainEvent.EnvelopeFromJson)(json);
    expect(decoded).toEqual(envelope);
  }),
);

const actor = new Actor.Actor({ kind: "user", id: "u-7", displayName: "Jane Citizen" });

layer(eventsLayer, { buildPerTest: true })("EventRecorder.record", (it) => {
  it.effect("fills the envelope from the context: tenant, company, actor ids, clock, ids", () =>
    Effect.gen(function* () {
      yield* TestClock.adjust("5 seconds");
      const envelope = yield* confirm("o-1", 2, 3).pipe(Tenancy.withCompany(company));
      expect(envelope.eventId).toBe("00000000-0000-7000-8000-000000000001");
      expect(envelope.type).toBe("test.order.confirmed");
      expect(envelope.version).toBe(1);
      expect(envelope.tenantId).toBe(tenant);
      expect(envelope.companyId).toEqual(Option.some(company));
      expect(envelope.aggregate).toEqual(
        new DomainEvent.AggregateRef({ kind: "Order", id: "o-1", version: 2 }),
      );
      expect(DateTime.toEpochMillis(envelope.occurredAt)).toBe(5000);
      expect(envelope.actor).toEqual(new DomainEvent.ActorRef({ kind: "user", id: "u-7" }));
      expect(yield* Schema.encodeEffect(DomainEvent.EnvelopeFromJson)(envelope)).not.toContain(
        "Jane",
      );
      expect(envelope.correlationId).toBe(envelope.eventId);
      expect(envelope.causationId).toEqual(Option.none());
      expect(envelope.payload).toEqual({ orderId: "o-1", lines: 3 });
    }).pipe(Tenancy.withTenant(tenant), Actor.withActor(actor)),
  );

  it.effect("carries the host's correlation id, and no company outside one", () =>
    Effect.gen(function* () {
      const envelope = yield* DomainEvent.withCorrelation(confirm("o-1"), "request-1");
      expect(envelope.correlationId).toBe("request-1");
      expect(envelope.causationId).toEqual(Option.none());
      expect(envelope.companyId).toEqual(Option.none());
    }).pipe(Tenancy.withTenant(tenant), Actor.withActor(actor)),
  );

  it.effect("refuses a payload its schema does not encode, staging nothing", () =>
    Effect.gen(function* () {
      const Strict = DomainEvent.make(
        "test.strict",
        Schema.Struct({ n: Schema.Int.check(Schema.isGreaterThan(0)) }),
      );
      const error = yield* Effect.flip(
        UnitOfWork.transaction(
          EventRecorder.record(
            Strict.of({ aggregate: { kind: "T", id: "t", version: 1 }, payload: { n: -1 } }),
          ),
        ),
      );
      expect(error).toBeInstanceOf(BizError.ValidationError);
      const claims = yield* Effect.flatMap(outbox, (box) =>
        box.claimBatch({
          owner: "test",
          subscriptions: [{ name: "s", types: ["test.strict"] }],
          limit: 10,
          leaseFor: "1 minute",
        }),
      );
      expect(claims).toEqual([]);
    }).pipe(Tenancy.withTenant(tenant), Actor.withActor(actor)),
  );

  it.effect("EventRecorder.make needs only an outbox and an id generator", () =>
    Effect.gen(function* () {
      const recorder = yield* EventRecorder.make;
      const envelope = yield* recorder
        .record(
          OrderConfirmed.of({
            aggregate: { kind: "Order", id: "o-2", version: 1 },
            payload: { orderId: "o-2", lines: 1 },
          }),
        )
        .pipe(Tenancy.withTenant(tenant), Actor.withActor(actor));
      expect(envelope.aggregate.id).toBe("o-2");
    }),
  );
});

it.effect("an event built with `of` names its type, version and aggregate", () =>
  Effect.gen(function* () {
    const pending = OrderConfirmed.of({
      aggregate: { kind: "Order", id: "o-9", version: 4 },
      payload: { orderId: "o-9", lines: 2 },
    });
    expect([pending.type, pending.version, pending.aggregate.version]).toEqual([
      "test.order.confirmed",
      1,
      4,
    ]);
    expect(yield* pending.encoded).toEqual({ orderId: "o-9", lines: 2 });
  }),
);
