# Identifiers and errors

The foundation modules every domain package builds on: branded identifiers and the shared error channel. See also [exact numbers](exact-numbers.md).

## Identifiers (`./Id`)

Every entity id is a lower-case UUIDv7 string, branded per kind, so ids of different kinds are not assignable to each other. Declare a kind with `Id.make`, and create ids with `Id.generate` from the `IdGenerator` service: `Id.layer` (UUIDv7 from `Clock` and `Random`, increasing within a millisecond, deterministic under `TestClock` and a seeded `Random`) or `Id.layerSequential` for tests.

```ts
import { Effect } from "effect";
import * as Id from "@thomasfosterau/effect-biz/Id";

const PartyId = Id.make("PartyId");

const program = Id.generate(PartyId);

console.log(Effect.runSync(program.pipe(Effect.provide(Id.layerSequential)))); // "00000000-0000-7000-8000-000000000001"
```

An identifier from another system (a host application's user id, a sales channel's order number) is never reused as an effect-biz id; it is stored beside the entity as an external reference.

## Errors (`./BizError`)

Every module fails with the same small set of `Schema.TaggedError`s, so a host handles them once. `BizError.BizError` is the schema of the union (for RPC), `isRetryable` says whether repeating the command may succeed, and `httpStatus` is the status an API answers with:

| Error | Raised when | HTTP | Retryable |
| --- | --- | --- | --- |
| `NotFound` | the named entity does not exist (or is not visible to the tenant) | 404 | no |
| `AlreadyExists` | a create would duplicate a natural key | 409 | no |
| `ValidationError` | the input is malformed; `issues` are addressed by path | 422 | no |
| `ConcurrencyConflict` | a version-guarded write lost a race; retry from the load | 409 | yes |
| `InvalidTransition` | the command is not allowed from the entity's state | 409 | no |
| `Forbidden` | the principal may not perform the action on the resource | 403 | no |
| `BusinessRuleViolation` | a business rule is broken; `code` is namespaced (`sales.credit-limit-exceeded`) | 422 | no |
| `Unavailable` | a port or integration is down or not configured | 503 | yes |

`BizError.decodeUnknown(schema)` decodes a command's input and fails with a `ValidationError` (built by `fromSchemaError`) instead of a `SchemaError`.

```ts
import { Effect, Schema } from "effect";
import * as BizError from "@thomasfosterau/effect-biz/BizError";

const Input = Schema.Struct({ name: Schema.String });

const error = Effect.runSync(Effect.flip(BizError.decodeUnknown(Input)({ name: 1 })));

console.log(error._tag, BizError.httpStatus(error)); // "ValidationError" 422
console.log(error.issues[0]?.path); // ["name"]
```

No error carries a secret or personal data: only entity kinds, ids, codes and schema paths.
