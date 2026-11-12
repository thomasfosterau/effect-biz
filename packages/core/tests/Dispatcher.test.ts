import { describe, expect } from "vite-plus/test";
import { it, layer } from "@effect/vitest";
import * as Arr from "effect/Array";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import { TestClock } from "effect/testing";
import * as Actor from "../src/Actor.ts";
import * as BizError from "../src/BizError.ts";
import * as Dispatcher from "../src/Dispatcher.ts";
import * as DomainEvent from "../src/DomainEvent.ts";
import * as EventRecorder from "../src/EventRecorder.ts";
import * as Outbox from "../src/Outbox.ts";
import * as Subscriber from "../src/Subscriber.ts";
import * as Tenancy from "../src/Tenancy.ts";
import * as Testing from "../src/testing.ts";
import * as UnitOfWork from "../src/UnitOfWork.ts";
import { Widgets, widgetSubject, widgetsLayer } from "./fixtures.ts";
import {
  OrderConfirmed,
  StockReserved,
  company,
  confirm,
  eventsLayer,
  outbox,
  tenant,
} from "./events.fixtures.ts";

const contractCases = Testing.eventsContract(widgetSubject(Effect.service(Widgets)));

layer(Layer.merge(eventsLayer, widgetsLayer), { buildPerTest: true, excludeTestServices: true })(
  "the events contract over the in-memory outbox and inbox",
  (it) => {
    Arr.forEach(contractCases, (contractCase) =>
      it.effect(contractCase.name, () => contractCase.run),
    );
  },
);

const actor = Actor.system("test");

/** Runs an effect as the test's tenant and actor. */
const asTenant = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(Tenancy.withTenant(tenant), Actor.withActor(actor));

/** A subscriber to order confirmations that fails while `failures` is above zero. */
const flaky = (failures: Ref.Ref<number>, handled: Ref.Ref<number>) =>
  Subscriber.make("test.flaky", [OrderConfirmed], () =>
    Effect.flatMap(
      Ref.getAndUpdate(failures, (n) => n - 1),
      (left) =>
        left > 0
          ? Effect.fail(new BizError.Unavailable({ service: "warehouse" }))
          : Ref.update(handled, (n) => n + 1),
    ),
  );

layer(eventsLayer, { buildPerTest: true })("Dispatcher under TestClock", (it) => {
  it.effect("retries with exponential backoff from the Clock, then dead-letters", () =>
    Effect.gen(function* () {
      const failures = yield* Ref.make(10);
      const handled = yield* Ref.make(0);
      const dispatcher = yield* Dispatcher.make([yield* flaky(failures, handled)], {
        maxAttempts: 4,
        owner: "relay-a",
      });
      yield* asTenant(confirm("o-1"));
      expect(yield* dispatcher.runOnce).toEqual({ claimed: 1, dispatched: 0, retried: 1, dead: 0 });
      expect((yield* dispatcher.drain).claimed).toBe(0);
      yield* TestClock.adjust("999 millis");
      expect((yield* dispatcher.drain).claimed).toBe(0);
      yield* TestClock.adjust("1 millis");
      expect((yield* dispatcher.runOnce).retried).toBe(1); // attempt 2, after 1 second
      yield* TestClock.adjust("1999 millis");
      expect((yield* dispatcher.runOnce).claimed).toBe(0);
      yield* TestClock.adjust("1 millis");
      expect((yield* dispatcher.runOnce).retried).toBe(1); // attempt 3, after 2 seconds
      yield* TestClock.adjust("4 seconds");
      expect(yield* dispatcher.runOnce).toEqual({ claimed: 1, dispatched: 0, retried: 0, dead: 1 });
      yield* TestClock.adjust("1 hour");
      expect((yield* dispatcher.drain).claimed).toBe(0);
      const [dead] = yield* Effect.flatMap(outbox, (box) => box.deadLetters);
      expect(dead?.attempts).toBe(4);
      expect(dead?.error).toEqual(
        new Outbox.DeliveryError({ tag: "Unavailable", message: "warehouse is unavailable" }),
      );
      expect(yield* Ref.get(handled)).toBe(0);
    }),
  );

  it.effect("a retry that then succeeds is dispatched", () =>
    Effect.gen(function* () {
      const failures = yield* Ref.make(1);
      const handled = yield* Ref.make(0);
      const dispatcher = yield* Dispatcher.make([yield* flaky(failures, handled)]);
      yield* asTenant(confirm("o-1"));
      yield* dispatcher.drain;
      yield* TestClock.adjust("1 second");
      expect(yield* dispatcher.drain).toEqual({ claimed: 1, dispatched: 1, retried: 0, dead: 0 });
      expect(yield* Ref.get(handled)).toBe(1);
      expect(yield* Effect.flatMap(outbox, (box) => box.deadLetters)).toEqual([]);
    }),
  );

  it.effect("a schedule that ends dead-letters at once", () =>
    Effect.gen(function* () {
      const failures = yield* Ref.make(10);
      const handled = yield* Ref.make(0);
      const dispatcher = yield* Dispatcher.make([yield* flaky(failures, handled)], {
        backoff: Schedule.recurs(0),
      });
      yield* asTenant(confirm("o-1"));
      expect(yield* dispatcher.drain).toEqual({ claimed: 1, dispatched: 0, retried: 0, dead: 1 });
    }),
  );

  it.effect("a lease that is never settled expires, and the delivery is claimed again", () =>
    Effect.gen(function* () {
      const box = yield* outbox;
      yield* asTenant(confirm("o-1"));
      const request = {
        owner: "relay-a",
        subscriptions: [{ name: "s", types: [OrderConfirmed.type] }],
        limit: 10,
        leaseFor: Duration.seconds(30),
      };
      const first = yield* Effect.fromOption(Arr.head(yield* box.claimBatch(request)));
      expect(first.attempts).toBe(1);
      expect(yield* box.claimBatch({ ...request, owner: "relay-b" })).toEqual([]);
      yield* TestClock.adjust("30 seconds");
      const second = yield* Effect.fromOption(
        Arr.head(yield* box.claimBatch({ ...request, owner: "relay-b" })),
      );
      expect([second.owner, second.attempts]).toEqual(["relay-b", 2]);
      // The first relay's late settlements change nothing: the lease is relay-b's.
      yield* box.markDispatched(first);
      yield* box.markFailed(
        first,
        new Outbox.DeliveryError({ tag: "X", message: "" }),
        Option.none(),
      );
      expect(yield* box.deadLetters).toEqual([]);
      yield* box.markDispatched(second);
      yield* TestClock.adjust("1 minute");
      expect(yield* box.claimBatch(request)).toEqual([]);
    }),
  );

  it.effect("a claim takes the oldest deliveries first, at most `limit` of them", () =>
    Effect.gen(function* () {
      const box = yield* outbox;
      yield* asTenant(
        Effect.all([confirm("o-1"), confirm("o-2"), confirm("o-3")], { concurrency: 1 }),
      );
      const claims = yield* box.claimBatch({
        owner: "relay",
        subscriptions: [
          { name: "s", types: [OrderConfirmed.type] },
          { name: "t", types: [StockReserved.type] },
        ],
        limit: 2,
        leaseFor: "1 minute",
      });
      expect(Arr.map(claims, (claim) => claim.envelope.aggregate.id)).toEqual(["o-1", "o-2"]);
      expect(
        yield* box.claimBatch({ owner: "x", subscriptions: [], leaseFor: 0, limit: 5 }),
      ).toEqual([]);
    }),
  );

  it.effect(
    "a handler's events continue the chain: same correlation, caused by the handled event",
    () =>
      Effect.gen(function* () {
        const seen = yield* Ref.make<ReadonlyArray<DomainEvent.Envelope>>([]);
        const companies = yield* Ref.make<ReadonlyArray<Option.Option<Tenancy.CompanyId>>>([]);
        const reserve = yield* Subscriber.make("test.reserve", [OrderConfirmed], (event) =>
          Effect.gen(function* () {
            const context = yield* Effect.serviceOption(Tenancy.CompanyContext);
            yield* Ref.update(companies, Arr.append(Option.map(context, (c) => c.companyId)));
            const actorId = (yield* Actor.current).id;
            expect(actorId).toBe("test.reserve");
            yield* EventRecorder.record(
              StockReserved.of({
                aggregate: { kind: "Reservation", id: `r-${event.payload.orderId}`, version: 1 },
                payload: { orderId: event.payload.orderId },
              }),
            );
          }),
        );
        const watch = yield* Subscriber.make("test.watch", [StockReserved], (event) =>
          Effect.flatMap(outbox, () =>
            Ref.update(seen, (all) =>
              Arr.append(
                all,
                new DomainEvent.Envelope({ ...eventFields(event), payload: event.payload }),
              ),
            ),
          ),
        );
        const dispatcher = yield* Dispatcher.make([reserve, watch]);
        const first = yield* asTenant(
          DomainEvent.withCorrelation(confirm("o-1"), "request-7").pipe(
            Tenancy.withCompany(company),
          ),
        );
        yield* asTenant(confirm("o-2"));
        yield* dispatcher.drain;
        const reserved = yield* Ref.get(seen);
        const fromFirst = yield* Effect.fromOption(
          Arr.findFirst(reserved, (envelope) => envelope.aggregate.id === "r-o-1"),
        );
        expect(fromFirst.correlationId).toBe("request-7");
        expect(fromFirst.causationId).toEqual(Option.some(first.eventId));
        expect(fromFirst.companyId).toEqual(Option.some(company));
        expect(fromFirst.actor.id).toBe("test.reserve");
        expect(yield* Ref.get(companies)).toEqual([Option.some(company), Option.none()]);
      }),
  );

  it.effect("an event its subscriber cannot decode is dead-lettered as a ValidationError", () =>
    Effect.gen(function* () {
      const Narrow = DomainEvent.make(OrderConfirmed.type, Schema.Struct({ orderId: Schema.Int }));
      const subscriber = yield* Subscriber.make("test.narrow", [Narrow], () => Effect.void);
      const dispatcher = yield* Dispatcher.make([subscriber], { maxAttempts: 1 });
      yield* asTenant(confirm("o-1"));
      expect((yield* dispatcher.drain).dead).toBe(1);
      const [dead] = yield* Effect.flatMap(outbox, (box) => box.deadLetters);
      expect(dead?.error.tag).toBe("ValidationError");
    }),
  );

  it.effect("a defect is stored as a Defect with its error's name only", () =>
    Effect.gen(function* () {
      const subscriber = yield* Subscriber.make("test.defect", [OrderConfirmed], () =>
        Effect.die(new TypeError("jane@example.com is not a function")),
      );
      const dispatcher = yield* Dispatcher.make([subscriber], { maxAttempts: 1 });
      yield* asTenant(confirm("o-1"));
      yield* dispatcher.drain;
      const [dead] = yield* Effect.flatMap(outbox, (box) => box.deadLetters);
      expect(dead?.error).toEqual(
        new Outbox.DeliveryError({ tag: "Defect", message: "TypeError" }),
      );
    }),
  );

  it.effect("the relay layer drains every poll interval until its scope closes", () =>
    Effect.gen(function* () {
      const handled = yield* Ref.make(0);
      const counting = Subscriber.make("test.counting", [OrderConfirmed], () =>
        Ref.update(handled, (n) => n + 1),
      );
      const relay = Dispatcher.layer(Effect.all([counting], { concurrency: 1 }), {
        pollInterval: "5 seconds",
      });
      const fiber = yield* Effect.forkChild(
        Layer.build(relay).pipe(Effect.andThen(Effect.never), Effect.scoped),
      );
      yield* TestClock.adjust("1 millis");
      yield* asTenant(confirm("o-1"));
      yield* TestClock.adjust("5 seconds");
      expect(yield* Ref.get(handled)).toBe(1);
      yield* asTenant(confirm("o-2"));
      yield* TestClock.adjust("5 seconds");
      expect(yield* Ref.get(handled)).toBe(2);
      yield* Fiber.interrupt(fiber);
    }),
  );
});

/** An envelope's fields, without its payload. */
const eventFields = (event: DomainEvent.Event<string, unknown>) => ({
  eventId: event.eventId,
  type: event.type,
  version: event.version,
  tenantId: event.tenantId,
  companyId: event.companyId,
  aggregate: event.aggregate,
  occurredAt: event.occurredAt,
  actor: event.actor,
  correlationId: event.correlationId,
  causationId: event.causationId,
});

/** How many claims the unavailable outbox has refused. */
class Claims extends Context.Service<Claims, Ref.Ref<number>>()("test/Claims") {}

const unavailable = new BizError.Unavailable({ service: "outbox" });

/** An outbox whose every claim fails as unavailable, counting the attempts. */
const failingOutbox = Layer.effect(
  Outbox.Outbox,
  Effect.map(Effect.service(Claims), (claims) =>
    Outbox.Outbox.of({
      append: () => Effect.void,
      claimBatch: () =>
        Effect.andThen(
          Ref.update(claims, (n) => n + 1),
          Effect.fail(unavailable),
        ),
      markDispatched: () => Effect.void,
      markFailed: () => Effect.void,
      deadLetters: Effect.succeed([]),
    }),
  ),
).pipe(Layer.provideMerge(Layer.effect(Claims, Ref.make(0))));

layer(
  Dispatcher.layer(Effect.succeed([]), { pollInterval: "1 second" }).pipe(
    Layer.provideMerge(failingOutbox),
  ),
)("Dispatcher.layer over an unavailable outbox", (it) => {
  it.effect("logs a failed round and goes on", () =>
    Effect.gen(function* () {
      yield* TestClock.adjust("3 seconds");
      expect(yield* Ref.get(yield* Claims)).toBeGreaterThanOrEqual(3);
      expect(yield* Effect.flip(Dispatcher.runOnce)).toEqual(unavailable);
      expect(yield* Effect.flip(Dispatcher.drain)).toEqual(unavailable);
    }),
  );
});

layer(eventsLayer, { buildPerTest: true })("Dispatcher.layerOnDemand", (it) => {
  it.effect("runs no relay: nothing is delivered until the host drains", () =>
    Effect.gen(function* () {
      const handled = yield* Ref.make(0);
      const onDemand = Dispatcher.layerOnDemand(
        Effect.all(
          [Subscriber.make("test.c", [OrderConfirmed], () => Ref.update(handled, (n) => n + 1))],
          { concurrency: 1 },
        ),
      );
      const context = yield* Layer.build(onDemand);
      yield* asTenant(confirm("o-1"));
      yield* TestClock.adjust("1 minute");
      expect(yield* Ref.get(handled)).toBe(0);
      const report = yield* Effect.provideContext(Dispatcher.drain, context);
      expect(report.dispatched).toBe(1);
    }).pipe(Effect.scoped),
  );
});

describe("Subscriber.deliveryError", () => {
  it.effect("keeps a failure's tag and message, and only a defect's name", () =>
    Effect.sync(() => {
      expect(
        Subscriber.deliveryError(Cause.fail(new BizError.Unavailable({ service: "s" }))),
      ).toEqual(new Outbox.DeliveryError({ tag: "Unavailable", message: "s is unavailable" }));
      expect(Subscriber.deliveryError(Cause.fail("plain"))).toEqual(
        new Outbox.DeliveryError({ tag: "Error", message: "" }),
      );
      expect(Subscriber.deliveryError(Cause.die("plain"))).toEqual(
        new Outbox.DeliveryError({ tag: "Defect", message: "unknown" }),
      );
      expect(Subscriber.deliveryError(Cause.interrupt())).toEqual(
        new Outbox.DeliveryError({ tag: "Defect", message: "unknown" }),
      );
    }),
  );
});

layer(eventsLayer, { buildPerTest: true })("Subscriber.handle", (it) => {
  it.effect("refuses an event of a type it does not handle, and is interrupted cleanly", () =>
    Effect.gen(function* () {
      const subscriber = yield* Subscriber.make("test.stock", [StockReserved], () => Effect.never);
      const envelope = yield* asTenant(confirm("o-1"));
      const error = yield* Effect.flip(subscriber.handle(envelope));
      expect(error.tag).toBe("ValidationError");
      const reserved = yield* asTenant(
        UnitOfWork.transaction(
          EventRecorder.record(
            StockReserved.of({
              aggregate: { kind: "R", id: "r", version: 1 },
              payload: { orderId: "o" },
            }),
          ),
        ),
      );
      const fiber = yield* Effect.forkChild(subscriber.handle(reserved));
      yield* TestClock.adjust("1 millis");
      yield* Fiber.interrupt(fiber);
      const exit = yield* Fiber.await(fiber);
      expect(Exit.isFailure(exit)).toBe(true);
    }),
  );
});
