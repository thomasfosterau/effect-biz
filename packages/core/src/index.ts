/**
 * The foundation of the effect-biz package family: the identifiers, tenancy
 * context, error channel, domain events and repository conventions every
 * domain package builds on.
 *
 * Each module is also its own subpath. Payments (`./Payments`), `./Authorization`
 * (optional effect-auth peer) and `./testing` are subpath-only.
 * See {@link name} for an example.
 *
 * @module
 */

/**
 * The published name of this package, for diagnostics and logging.
 *
 * @example
 * ```ts
 * import { name } from "@thomasfosterau/effect-biz";
 *
 * console.log(name); // "@thomasfosterau/effect-biz"
 * ```
 */
export const name = "@thomasfosterau/effect-biz";

export * as Actor from "./Actor.js";
export * as Audit from "./Audit.js";
export * as BizError from "./BizError.js";
export * as Company from "./Company.js";
export * as Currency from "./Currency.js";
export * as Decimal from "./Decimal.js";
export * as Dispatcher from "./Dispatcher.js";
export * as DomainEvent from "./DomainEvent.js";
export * as EventRecorder from "./EventRecorder.js";
export * as Id from "./Id.js";
export * as Memory from "./Memory.js";
export * as Money from "./Money.js";
export * as NumberSequence from "./NumberSequence.js";
export * as Outbox from "./Outbox.js";
export * as Page from "./Page.js";
export * as Percentage from "./Percentage.js";
export * as Quantity from "./Quantity.js";
export * as Query from "./Query.js";
export * as Rate from "./Rate.js";
export * as Repository from "./Repository.js";
export * as Rounding from "./Rounding.js";
export * as Subscriber from "./Subscriber.js";
export * as Tenancy from "./Tenancy.js";
export * as UnitOfWork from "./UnitOfWork.js";
