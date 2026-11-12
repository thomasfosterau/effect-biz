import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as DomainEvent from "../src/DomainEvent.ts";
import * as EventRecorder from "../src/EventRecorder.ts";
import * as Id from "../src/Id.ts";
import * as Outbox from "../src/Outbox.ts";
import * as Subscriber from "../src/Subscriber.ts";
import * as Tenancy from "../src/Tenancy.ts";
import * as UnitOfWork from "../src/UnitOfWork.ts";

/** The tenant most cases record under. */
export const tenant = Tenancy.TenantId.make("0190a6e4-1c2d-7abc-8def-0000000000a1");

/** A company of that tenant. */
export const company = Tenancy.CompanyId.make("0190a6e4-1c2d-7abc-8def-0000000000c1");

/** A test event: an order confirmed with a number of lines. */
export const OrderConfirmed = DomainEvent.make(
  "test.order.confirmed",
  Schema.Struct({ orderId: Schema.String, lines: Schema.Int }),
);

/** A second test event, recorded in reaction to the first. */
export const StockReserved = DomainEvent.make(
  "test.stock.reserved",
  Schema.Struct({ orderId: Schema.String }),
);

/** Records an order confirmation as one command. */
export const confirm = (orderId: string, version = 1, lines = 1) =>
  UnitOfWork.transaction(
    EventRecorder.record(
      OrderConfirmed.of({
        aggregate: { kind: "Order", id: orderId, version },
        payload: { orderId, lines },
      }),
    ),
  );

/** The in-memory outbox, inbox, unit of work and recorder, with sequential ids. */
export const eventsLayer = EventRecorder.layer.pipe(
  Layer.provideMerge(
    Layer.mergeAll(
      Outbox.layerMemory,
      Subscriber.layerInboxMemory,
      UnitOfWork.layerMemory,
      Id.layerSequential,
    ),
  ),
);

/** The current outbox. */
export const outbox = Effect.service(Outbox.Outbox);
