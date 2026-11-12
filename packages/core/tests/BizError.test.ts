import { describe, expect } from "vite-plus/test";
import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as BizError from "../src/BizError.ts";

const id = "0190a6e4-1c2d-7abc-8def-0123456789ab";

const cases: ReadonlyArray<readonly [BizError.BizError, number, boolean, string]> = [
  [new BizError.NotFound({ entity: "Party", id }), 404, false, `Party ${id} not found`],
  [
    new BizError.AlreadyExists({ entity: "Product", key: "SKU-1" }),
    409,
    false,
    "Product SKU-1 already exists",
  ],
  [
    new BizError.ValidationError({
      issues: [
        new BizError.Issue({
          path: ["lines", 0, "quantity"],
          message: "Expected a decimal string",
        }),
        new BizError.Issue({ path: [], message: "Missing key" }),
      ],
    }),
    422,
    false,
    "lines.0.quantity: Expected a decimal string; Missing key",
  ],
  [
    new BizError.ConcurrencyConflict({ entity: "SalesOrder", id, expected: 3, actual: 4 }),
    409,
    true,
    `SalesOrder ${id} is at version 4, expected 3`,
  ],
  [
    new BizError.InvalidTransition({
      entity: "SalesOrder",
      id,
      from: "cancelled",
      command: "confirm",
    }),
    409,
    false,
    `SalesOrder ${id} cannot confirm from cancelled`,
  ],
  [
    new BizError.Forbidden({ action: "sales-order:confirm", resource: `SalesOrder::"${id}"` }),
    403,
    false,
    `Forbidden: sales-order:confirm on SalesOrder::"${id}"`,
  ],
  [
    new BizError.BusinessRuleViolation({
      code: "sales.credit-limit-exceeded",
      reason: "The order exceeds the customer's credit limit",
      details: Option.some({ limit: "5000.00", exposure: "5200.00" }),
    }),
    422,
    false,
    "sales.credit-limit-exceeded: The order exceeds the customer's credit limit",
  ],
  [
    new BizError.Unavailable({ service: "ExchangeRates" }),
    503,
    true,
    "ExchangeRates is unavailable",
  ],
];

describe("BizError", () => {
  it.each(cases)(
    "%s maps to its status, retryability and message",
    (error, status, retryable, message) => {
      expect(BizError.httpStatus(error)).toBe(status);
      expect(BizError.isRetryable(error)).toBe(retryable);
      expect(error.message).toBe(message);
      expect(error).toBeInstanceOf(Error);
    },
  );

  it.each(cases)("%s round-trips through the BizError schema", (error) => {
    const Json = Schema.fromJsonString(BizError.BizError);
    const decoded = Schema.decodeSync(Json)(Schema.encodeSync(Json)(error));
    expect(decoded).toEqual(error);
    expect(decoded.constructor).toBe(error.constructor);
  });

  it.effect("is yielded and caught by tag", () =>
    Effect.gen(function* () {
      const program = Effect.fail(new BizError.NotFound({ entity: "Party", id })).pipe(
        Effect.catchTag("NotFound", (error) => Effect.succeed(error.id)),
      );
      expect(yield* program).toBe(id);
    }),
  );
});

describe("BizError.decodeUnknown", () => {
  const Line = Schema.Struct({
    sku: Schema.String,
    lines: Schema.Array(Schema.Struct({ quantity: Schema.String })),
  });

  it.effect("succeeds with the decoded value", () =>
    Effect.gen(function* () {
      const input = { sku: "A", lines: [{ quantity: "1.5" }] };
      expect(yield* BizError.decodeUnknown(Line)(input)).toEqual(input);
    }),
  );

  it.effect("fails with a ValidationError addressing each issue by path", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(
        BizError.decodeUnknown(Line)({ sku: 1, lines: [{ quantity: 2 }] }),
      );
      expect(error).toBeInstanceOf(BizError.ValidationError);
      expect(error.issues.map((issue) => issue.path)).toEqual([["sku"]]);
      const all = yield* Effect.flip(
        Schema.decodeUnknownEffect(Line)(
          { sku: 1, lines: [{ quantity: 2 }] },
          { errors: "all" },
        ).pipe(Effect.mapError(BizError.fromSchemaError)),
      );
      expect(all.issues.map((issue) => issue.path)).toEqual([["sku"], ["lines", 0, "quantity"]]);
    }),
  );
});
