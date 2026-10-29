/**
 * A vendor-neutral monetary amount.
 *
 * @module
 */

import * as Schema from "effect/Schema";

/**
 * Represents an amount of money in the smallest currency unit (e.g. cents for
 * USD), paired with an ISO 4217 currency code.
 *
 * Using the smallest currency unit avoids floating-point rounding issues and
 * matches the representation used by most payment providers.
 */
export class Money extends Schema.Class<Money>("@effect-biz/payments/Money")({
  /** The amount in the smallest currency unit (e.g. `2000` = $20.00). */
  amount: Schema.Number,
  /** The lower-cased ISO 4217 currency code, e.g. `"usd"`. */
  currency: Schema.String,
}) {}

/**
 * Construct a {@link Money} value from a minor-unit amount and currency.
 */
export const make = (amount: number, currency: string): Money => Money.make({ amount, currency });

/** Shared shape for metadata bags accepted/returned across resources. */
export const Metadata = Schema.Record(Schema.String, Schema.String);

/** A bag of arbitrary string key/value pairs attached to a resource. */
export type Metadata = typeof Metadata.Type;
