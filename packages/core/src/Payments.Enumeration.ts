/**
 * Lenient provider enumerations: a neutral literal set plus a tagged catch-all.
 *
 * A provider can add a value to one of its enumerations (a payment status, a
 * billing interval) at any time. A neutral enumeration is therefore not a
 * closed literal set but `Known | Other`: the literals this library models,
 * plus {@link Other} carrying the raw string a provider sent that it does not
 * model. An unrecognised value then never fails the decode of a whole object
 * or list page, and the exact value stays available to the caller.
 *
 * Every neutral enumeration uses this one shape. The known literals stay bare
 * strings (`"succeeded"`), so existing code comparing against them keeps
 * working; only an exhaustive match must now also handle `Other`.
 *
 * @module
 */

import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";
import * as SchemaGetter from "effect/SchemaGetter";

/**
 * The catch-all member of every neutral enumeration: a value the provider sent
 * that this library does not model. `raw` is the provider's exact string.
 */
export const Other = Schema.TaggedStruct("Other", { raw: Schema.String });
export type Other = typeof Other.Type;

/** Build the {@link Other} member for an unrecognised provider value. */
export const other = (raw: string): Other => ({ _tag: "Other", raw });

/** Whether an enumeration value is the catch-all rather than a known literal. */
export const isOther = (value: string | Other): value is Other => !Predicate.isString(value);

/**
 * The lenient schema for an enumeration: its known literals, or {@link Other}.
 * Use it as the field type of a neutral entity.
 */
export const lenient = <const L extends ReadonlyArray<string>>(known: Schema.Literals<L>) =>
  Schema.Union([known, Other]);

/**
 * Classify a provider's raw string against an enumeration's known literals:
 * the literal when it is one, otherwise {@link Other} carrying the raw string.
 */
export const parse = <const L extends ReadonlyArray<string>>(
  known: Schema.Literals<L>,
  raw: string,
): L[number] | Other => (Schema.is(known)(raw) ? raw : other(raw));

/**
 * A wire-format codec for an enumeration: decodes any string to a known literal
 * or {@link Other}, so it cannot fail on an unrecognised value. Use it for the
 * field of a provider's wire schema whose value already matches the neutral
 * literals (Stripe's own spellings).
 */
export const fromWire = <const L extends ReadonlyArray<string>>(known: Schema.Literals<L>) =>
  Schema.String.pipe(
    Schema.decodeTo(lenient(known), {
      decode: SchemaGetter.transform((raw: string) => parse(known, raw)),
      encode: SchemaGetter.transform((value: L[number] | Other) =>
        Predicate.isString(value) ? value : value.raw,
      ),
    }),
  );
