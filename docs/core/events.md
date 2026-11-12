# Domain events

How a module says what happened, and how other modules react: **typed domain events, recorded into a transactional outbox in the same batch as the command's state change, and delivered at least once to idempotent subscribers** (#30). See also [the unit of work](unit-of-work.md).

| Module | What it holds |
| --- | --- |
| `./DomainEvent` | `make` / `evolve` (defining an event and its versions), the `Envelope`, `CurrentCorrelation`, `withCorrelation`, `causedBy`. |
| `./EventRecorder` | `record`: the one way a command records an event, inside its unit of work. |
| `./Outbox` | The `Outbox` port (`append`, `claimBatch`, `markDispatched`, `markFailed`, `deadLetters`) and `layerMemory`. |
| `./Subscriber` | `make` (a named, idempotent handler) and the `Inbox` port with `layerInboxMemory`. |
| `./Dispatcher` | The relay: `make`, `runOnce`, `drain`, `layer` (a scoped relay fiber) and `layerOnDemand`. |
| `./testing` | `eventsContract`, the suite every outbox, inbox and unit of work runs. |

## Defining an event

An event type is `<module>.<aggregate>.<what happened>`, in the past tense (`sales.order.confirmed`), and each version of it is a definition: `DomainEvent.make(type, payloadSchema)` is version 1. The payload's schema must encode to JSON; the payload names what a subscriber needs by id, never a copy of personal data it can load.

### Evolving it

- **Within a version, only additive changes**: a new optional field, a new member of a lenient enumeration. A reader of the version ignores fields it does not know, so old readers keep working.
- **Anything else is a new version**: renaming, removing or retyping a field, or making one required. Define it with `DomainEvent.evolve(previous, newSchema, upcast)`, where `upcast` turns the previous version's payload into the new one. An envelope stored at any earlier version then decodes through its own version's schema and every upcaster since, so a subscriber written against the newest version reads the whole history.
- **Deploy readers first.** An envelope at a version newer than the subscriber's definition does not decode: it fails (a `ValidationError`), is retried and, at the last attempt, dead-lettered.

## The envelope

`EventRecorder.record(event)` fills every field but the payload from the context, never from the caller:

| Field | From |
| --- | --- |
| `eventId` | `Id.IdGenerator` (a UUIDv7) |
| `type`, `version`, `payload` | the definition; the payload encoded as JSON by its schema |
| `tenantId` | `Tenancy.TenantContext` |
| `companyId` | `Tenancy.CompanyContext`, when the command acts for a company (`Option`) |
| `aggregate` | the event: the aggregate's kind, id and the version the command stores it at |
| `occurredAt` | `Clock` |
| `actor` | `Actor.CurrentActor`: its kind and id, never its display name |
| `correlationId` | `DomainEvent.CurrentCorrelation`; the event's own id when there is none |
| `causationId` | `DomainEvent.CurrentCorrelation` (`Option`): the event that caused it |

The envelope's encoded form (`DomainEvent.EnvelopeFromJson`) is JSON, so a SQL outbox stores it in one text column. It carries ids only: no personal data outside the payload.

## Recording

Record inside the command's `UnitOfWork.transaction`, after deciding, like any other write: the outbox `append` is staged into the transaction's batch, so the event commits exactly when the state change does, and a command that fails records nothing.

## Subscribing

`Subscriber.make(name, definitions, handler)` builds a subscriber. Its name is the inbox key, so keep it unique and stable. The handler gets the decoded event (`event.payload` typed by the definition, upcast to its version) and runs:

- inside a `UnitOfWork.transaction` of its own, whose batch also stages the **inbox mark** (subscriber name + event id): a redelivered event finds the mark and does nothing, and of two deliveries racing, exactly one commits. Delivery is at least once; the handler's committed effects are exactly once. A side effect outside the unit of work (an email, an HTTP call) is still at least once: key it by `event.eventId`;
- under the event's tenant, its company when it has one (read it from `event.companyId`, or with `Effect.serviceOption(Tenancy.CompanyContext)`), and the system actor named after the subscriber;
- `DomainEvent.causedBy` the event: every event it records shares the correlation id and names the handled event as its cause, so a chain (order → reservation → shipment → invoice request) is traceable. Each delivery is a span, `Subscriber.handle`, with the subscriber, event id, type and correlation id.

The effect `Subscriber.make` returns captures the handler's services with the `Inbox` and the `UnitOfWork`, so build subscribers where those are provided.

## Dispatching

The dispatcher claims outbox deliveries and runs them through their subscribers.

- **Deliveries, not entries.** Each (entry, subscriber) pair is a delivery with its own status (`pending`, `dispatched`, `failed` awaiting a retry, `dead`), attempt count and lease, so a failing subscriber never holds back another.
- **Leases, not locks.** D1 has no row locks and no `SKIP LOCKED` (#128). `claimBatch` atomically takes due deliveries whose lease is absent or expired and leases them to the claiming dispatcher for `leaseFor` (30 seconds by default), counting an attempt. A dispatcher that dies mid-delivery loses nothing: its lease expires and the delivery is claimed again.
- **Ordering per aggregate.** For each subscriber, a claim takes only the first unsettled delivery of each aggregate, and skips the aggregate while that one is leased or waiting for its retry. An aggregate's later event never reaches a subscriber before the earlier one is dispatched or dead-lettered; other aggregates proceed meanwhile, `concurrency` (8 by default) deliveries at a time.
- **Retry, then dead-letter.** A failed delivery is due again after the `backoff` schedule's delay for that attempt (exponential from 1 second by default), read from `Clock`, so `TestClock` drives it in tests. On its last attempt (`maxAttempts`, 5 by default) it is dead-lettered with the failure's tag and message (a defect as `Defect` and its error's name only); then the aggregate's later events flow again. `Outbox.deadLetters` lists them.
- **Running it.** `Dispatcher.layer(subscribers, options)` forks a relay fiber into the layer's scope that drains every `pollInterval` (1 second). `Dispatcher.layerOnDemand` runs none: a host that drives dispatch from a cron or queue trigger calls `Dispatcher.runOnce` (one batch) or `Dispatcher.drain` (batches until one claims nothing), as tests do.

A subscriber registered later is delivered every entry the outbox still holds.

## Example

An order service records `sales.order.confirmed` in the command that confirms the order; a reservation subscriber reacts and records `stock.reservation.made`, which carries the order's correlation id:

```ts
import { Context, Effect, Layer, Option, Ref, Schema, Struct } from "effect";
import * as Actor from "@thomasfosterau/effect-biz/Actor";
import * as Audit from "@thomasfosterau/effect-biz/Audit";
import * as Dispatcher from "@thomasfosterau/effect-biz/Dispatcher";
import * as DomainEvent from "@thomasfosterau/effect-biz/DomainEvent";
import * as EventRecorder from "@thomasfosterau/effect-biz/EventRecorder";
import * as Id from "@thomasfosterau/effect-biz/Id";
import * as Memory from "@thomasfosterau/effect-biz/Memory";
import * as Outbox from "@thomasfosterau/effect-biz/Outbox";
import type * as Repository from "@thomasfosterau/effect-biz/Repository";
import * as Subscriber from "@thomasfosterau/effect-biz/Subscriber";
import * as Tenancy from "@thomasfosterau/effect-biz/Tenancy";
import * as UnitOfWork from "@thomasfosterau/effect-biz/UnitOfWork";

interface Order {
  readonly id: string;
  readonly status: "draft" | "confirmed";
  readonly audit: Audit.AuditFields;
}

class Orders extends Context.Service<Orders, Repository.Port<Order, string>>()("example/Orders") {}

const ordersMemory = Layer.effect(
  Orders,
  Effect.map(Memory.makeStore<string, Order>(), (store) =>
    Memory.repository(store, {
      entity: "Order",
      withAudit: (order, audit) => ({ ...Struct.omit(order, ["audit"]), audit }),
      searchable: [],
    }),
  ),
);

// Version 1 carried a line count; version 2 lists the line ids.
const OrderConfirmedV1 = DomainEvent.make(
  "sales.order.confirmed",
  Schema.Struct({ orderId: Schema.String, lines: Schema.Int }),
);
const OrderConfirmed = DomainEvent.evolve(
  OrderConfirmedV1,
  Schema.Struct({ orderId: Schema.String, lineIds: Schema.Array(Schema.String) }),
  ({ orderId }) => ({ orderId, lineIds: [] }),
);
const ReservationMade = DomainEvent.make(
  "stock.reservation.made",
  Schema.Struct({ orderId: Schema.String }),
);

// The command: load, decide, stage the update and the event; one batch commits both.
const confirmOrder = (id: string) =>
  UnitOfWork.transaction(
    Effect.gen(function* () {
      const orders = yield* Orders;
      const order = yield* orders.get(id);
      const confirmed = yield* orders.update({ ...order, status: "confirmed" });
      yield* EventRecorder.record(
        OrderConfirmed.of({
          aggregate: { kind: "Order", id, version: confirmed.audit.version },
          payload: { orderId: id, lineIds: ["l-1", "l-2"] },
        }),
      );
    }),
  );

const program = Effect.gen(function* () {
  const reservations = yield* Ref.make<ReadonlyArray<DomainEvent.Envelope>>([]);
  // Reacts to a confirmation by recording a reservation, in the same chain.
  const reserve = Subscriber.make("stock.reserve-for-order", [OrderConfirmed], (event) =>
    Effect.asVoid(
      EventRecorder.record(
        ReservationMade.of({
          aggregate: { kind: "Reservation", id: `r-${event.payload.orderId}`, version: 1 },
          payload: { orderId: event.payload.orderId },
        }),
      ),
    ),
  );
  const audit = Subscriber.make("example.audit-trail", [ReservationMade], (event) =>
    Ref.update(reservations, (all) => [
      ...all,
      new DomainEvent.Envelope({ ...Struct.omit(event, ["payload"]), payload: event.payload }),
    ]),
  );
  const dispatcher = yield* Dispatcher.make(
    yield* Effect.all([reserve, audit], { concurrency: 1 }),
  );

  const orders = yield* Orders;
  yield* orders.insert({ id: "o-1", status: "draft", audit: yield* Audit.created });
  yield* DomainEvent.withCorrelation(confirmOrder("o-1"), "request-1");
  yield* dispatcher.drain; // delivers the confirmation, then the reservation it caused
  yield* dispatcher.drain; // nothing more: each event is handled once per subscriber

  const [reservation] = yield* Ref.get(reservations);
  return [reservation?.correlationId, Option.isSome(reservation?.causationId ?? Option.none())];
});

const layer = EventRecorder.layer.pipe(
  Layer.provideMerge(
    Layer.mergeAll(
      ordersMemory,
      Outbox.layerMemory,
      Subscriber.layerInboxMemory,
      UnitOfWork.layerMemory,
      Id.layerSequential,
    ),
  ),
);
const tenant = Tenancy.TenantId.make("0190a6e4-1c2d-7abc-8def-0123456789ab");
console.log(
  Effect.runSync(
    program.pipe(
      Effect.provide(layer),
      Tenancy.withTenant(tenant),
      Actor.withActor(Actor.system("example")),
    ),
  ),
); // ["request-1", true]
```

In an application, provide `Dispatcher.layer(Effect.all([reserve, audit], { concurrency: 1 }))` instead: its relay drains in the background for as long as the layer's scope is open.

## Layers

- **In memory**: `Outbox.layerMemory` and `Subscriber.layerInboxMemory` stage their writes into `UnitOfWork.layerMemory`'s batches, so an event, an inbox mark and the aggregates they go with commit in one `Effect.tx`.
- **SQL** (the `-sql` package, #40): an `outbox` table of encoded envelopes in append order, an `outbox_delivery` table keyed by (entry, subscriber) with the status, attempts, lease owner and expiry, retry time and last error, and an `inbox` table keyed by (tenant, subscriber, event id). `claimBatch` is one batch of guarded `UPDATE`s that take a lease only where it is absent or expired; `append` and the inbox mark are staged statements of the command's batch. It runs `Testing.eventsContract`.

## The contract suite

`Testing.eventsContract(subject)` takes a repository subject (`repository`, `make`, `change`) and checks, against the provided `Outbox`, `Subscriber.Inbox`, `UnitOfWork` and `EventRecorder`: recording is atomic with the state change; a redelivered event, including one delivered twice at once, is handled once per subscriber; a failing subscriber blocks no other, is retried and dead-lettered; and each subscriber gets an aggregate's events in order while an aggregate waiting for a retry holds back no other. Run it on a live clock, with a fresh store, outbox and inbox per case.
