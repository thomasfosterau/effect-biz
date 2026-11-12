/**
 * The error channel every effect-biz module shares.
 *
 * A command fails with one of a small set of tagged errors, so a host
 * application handles them once and the HTTP and RPC surfaces map them
 * uniformly ({@link httpStatus}). A domain package adds its own tagged error
 * only for a case a caller must branch on; any other broken business rule is
 * a {@link BusinessRuleViolation} with a namespaced `code`
 * (`"sales.credit-limit-exceeded"`).
 *
 * No error carries a secret or personal data: only entity kinds, ids, codes
 * and schema paths. Their messages are built from those fields alone.
 *
 * Every error is a `Schema.TaggedError`, so it encodes and decodes through
 * {@link BizError} (what an RPC group needs). See {@link NotFound} for an
 * example.
 *
 * @module
 */

import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import { flow } from "effect/Function";
import * as Match from "effect/Match";
import * as P from "effect/Predicate";
import * as Schema from "effect/Schema";
import * as SchemaIssue from "effect/SchemaIssue";

/**
 * Raised when the entity a command names does not exist (or is not visible
 * under the current tenant).
 *
 * @example
 * ```ts
 * import { Effect } from "effect";
 * import * as BizError from "@thomasfosterau/effect-biz/BizError";
 *
 * const program = Effect.gen(function* () {
 *   return yield* new BizError.NotFound({ entity: "Party", id: "0190a6e4-0000-7000-8000-000000000001" });
 * });
 *
 * const error = Effect.runSync(Effect.flip(program));
 * console.log(error.message); // "Party 0190a6e4-0000-7000-8000-000000000001 not found"
 * console.log(BizError.httpStatus(error)); // 404
 * ```
 */
export class NotFound extends Schema.TaggedError<NotFound, { readonly brand: unique symbol }>()(
  "NotFound",
  {
    /** The kind of entity, e.g. `"Party"`. */
    entity: Schema.String,
    /** The id the caller asked for. */
    id: Schema.String,
  },
) {
  /** A message built from the entity kind and id. */
  override get message(): string {
    return `${this.entity} ${this.id} not found`;
  }
}

/**
 * Raised when a create would duplicate an entity's natural key (a party code,
 * a document number).
 */
export class AlreadyExists extends Schema.TaggedError<
  AlreadyExists,
  { readonly brand: unique symbol }
>()("AlreadyExists", {
  /** The kind of entity, e.g. `"Product"`. */
  entity: Schema.String,
  /** The natural key that is already taken. */
  key: Schema.String,
}) {
  /** A message built from the entity kind and key. */
  override get message(): string {
    return `${this.entity} ${this.key} already exists`;
  }
}

/**
 * One problem with a command's input: where it is (`path`, from the input's
 * root; empty for the input as a whole) and what is wrong with it.
 */
export class Issue extends Schema.Class<Issue, { readonly brand: unique symbol }>(
  "@effect-biz/BizError/Issue",
)({
  /** The property path from the input's root, e.g. `["lines", 0, "quantity"]`. */
  path: Schema.Array(Schema.Union([Schema.String, Schema.Int])),
  /** What is wrong, e.g. `"Expected a string, got 1"`. */
  message: Schema.String,
}) {}

/**
 * Raised when a command's input is malformed: each problem is an
 * {@link Issue} addressed by its path. Build one from a `Schema` failure with
 * {@link fromSchemaError}, or decode through {@link decodeUnknown}.
 */
export class ValidationError extends Schema.TaggedError<
  ValidationError,
  { readonly brand: unique symbol }
>()("ValidationError", {
  /** Every problem found, in the order the schema reported them. */
  issues: Schema.Array(Issue),
}) {
  /** A message listing each issue as `path: message`. */
  override get message(): string {
    return this.issues
      .map((issue) =>
        Arr.match(issue.path, {
          onEmpty: () => issue.message,
          onNonEmpty: (path) => `${path.join(".")}: ${issue.message}`,
        }),
      )
      .join("; ");
  }
}

/**
 * Raised when a version-guarded write finds the entity at a different version
 * than the command loaded: another writer got there first. The command is
 * retried from its load step ({@link isRetryable}).
 */
export class ConcurrencyConflict extends Schema.TaggedError<
  ConcurrencyConflict,
  { readonly brand: unique symbol }
>()("ConcurrencyConflict", {
  /** The kind of entity, e.g. `"SalesOrder"`. */
  entity: Schema.String,
  /** The entity's id. */
  id: Schema.String,
  /** The version the command loaded and expected to replace. */
  expected: Schema.Int,
  /** The version the store holds now. */
  actual: Schema.Int,
}) {
  /** A message built from the entity and both versions. */
  override get message(): string {
    return `${this.entity} ${this.id} is at version ${this.actual}, expected ${this.expected}`;
  }
}

/**
 * Raised when a command is not allowed from the entity's current state (a
 * cancelled order cannot be confirmed).
 */
export class InvalidTransition extends Schema.TaggedError<
  InvalidTransition,
  { readonly brand: unique symbol }
>()("InvalidTransition", {
  /** The kind of entity, e.g. `"SalesOrder"`. */
  entity: Schema.String,
  /** The entity's id. */
  id: Schema.String,
  /** The state the entity is in, e.g. `"cancelled"`. */
  from: Schema.String,
  /** The command that was refused, e.g. `"confirm"`. */
  command: Schema.String,
}) {
  /** A message built from the entity, its state and the command. */
  override get message(): string {
    return `${this.entity} ${this.id} cannot ${this.command} from ${this.from}`;
  }
}

/**
 * Raised when the current principal may not perform an action on a resource.
 * The decision itself comes from effect-auth's `Authorizer`; effect-biz has
 * no policy engine of its own.
 */
export class Forbidden extends Schema.TaggedError<Forbidden, { readonly brand: unique symbol }>()(
  "Forbidden",
  {
    /** The action, in `"resource:action"` form, e.g. `"sales-order:confirm"`. */
    action: Schema.String,
    /** The resource, as an entity reference, e.g. `SalesOrder::"<id>"`. */
    resource: Schema.String,
  },
) {
  /** A message built from the action and resource. */
  override get message(): string {
    return `Forbidden: ${this.action} on ${this.resource}`;
  }
}

/**
 * Raised when a command breaks a business rule that no more specific error
 * covers. `code` is namespaced by module (`"sales.credit-limit-exceeded"`) so
 * a caller can branch on it; `details` carries the rule's figures as strings.
 */
export class BusinessRuleViolation extends Schema.TaggedError<
  BusinessRuleViolation,
  { readonly brand: unique symbol }
>()("BusinessRuleViolation", {
  /** The rule, namespaced by module, e.g. `"sales.credit-limit-exceeded"`. */
  code: Schema.String,
  /** A human-readable explanation, free of personal data. */
  reason: Schema.String,
  /** The figures behind the decision, e.g. `{ limit: "5000.00" }`. */
  details: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)),
}) {
  /** A message built from the code and reason. */
  override get message(): string {
    return `${this.code}: ${this.reason}`;
  }
}

/**
 * Raised when a port or integration a command needs is down or not
 * configured. Retryable ({@link isRetryable}).
 */
export class Unavailable extends Schema.TaggedError<
  Unavailable,
  { readonly brand: unique symbol }
>()("Unavailable", {
  /** The port or integration, e.g. `"ExchangeRates"`. */
  service: Schema.String,
}) {
  /** A message built from the service name. */
  override get message(): string {
    return `${this.service} is unavailable`;
  }
}

/** The schema of the shared error channel: any one of its errors. */
export const BizError = Schema.Union([
  NotFound,
  AlreadyExists,
  ValidationError,
  ConcurrencyConflict,
  InvalidTransition,
  Forbidden,
  BusinessRuleViolation,
  Unavailable,
]);

/** Any error of the shared channel. */
export type BizError = typeof BizError.Type;

/**
 * Whether repeating the command may succeed: a {@link ConcurrencyConflict}
 * (retry from the load step) or an {@link Unavailable} port. Every other
 * error fails the same way again.
 */
export const isRetryable = (error: BizError): boolean =>
  Match.valueTags(error, {
    NotFound: () => false,
    AlreadyExists: () => false,
    ValidationError: () => false,
    ConcurrencyConflict: () => true,
    InvalidTransition: () => false,
    Forbidden: () => false,
    BusinessRuleViolation: () => false,
    Unavailable: () => true,
  });

/**
 * The HTTP status an API answers each error with: `404` for
 * {@link NotFound}, `409` for {@link AlreadyExists},
 * {@link ConcurrencyConflict} and {@link InvalidTransition}, `422` for
 * {@link ValidationError} and {@link BusinessRuleViolation}, `403` for
 * {@link Forbidden} and `503` for {@link Unavailable}.
 */
export const httpStatus = (error: BizError): 403 | 404 | 409 | 422 | 503 =>
  Match.valueTags(error, {
    NotFound: () => 404 as const,
    AlreadyExists: () => 409 as const,
    ValidationError: () => 422 as const,
    ConcurrencyConflict: () => 409 as const,
    InvalidTransition: () => 409 as const,
    Forbidden: () => 403 as const,
    BusinessRuleViolation: () => 422 as const,
    Unavailable: () => 503 as const,
  });

const formatter = SchemaIssue.makeFormatterStandardSchemaV1();

/** A formatter path segment as an {@link Issue} path segment: an index stays a number, any other key is its text. */
const pathSegment = (segment: PropertyKey | { readonly key: PropertyKey }): string | number => {
  const key = P.hasProperty(segment, "key") ? segment.key : segment;
  return P.isNumber(key) ? key : String(key);
};

/** The {@link ValidationError} for a `Schema` failure, one {@link Issue} per problem. */
export const fromSchemaError = (error: Schema.SchemaError): ValidationError =>
  new ValidationError({
    issues: formatter(error.issue).issues.map(
      (issue) =>
        new Issue({
          path: Arr.map(issue.path ?? [], pathSegment),
          message: issue.message,
        }),
    ),
  });

/**
 * Decodes an input against a schema, failing with a {@link ValidationError}
 * instead of a `SchemaError`: how a command checks what crosses its boundary.
 */
export const decodeUnknown = <S extends Schema.Decoder<unknown>>(schema: S) =>
  flow(Schema.decodeUnknownEffect(schema), Effect.mapError(fromSchemaError));
