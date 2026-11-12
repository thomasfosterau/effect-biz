---
"@thomasfosterau/effect-biz": minor
---

Add the first platform-foundation modules. `@thomasfosterau/effect-biz/Id` declares branded entity ids (`Id.make("PartyId")`: lower-case UUIDv7 strings, not assignable across kinds) and generates them from the `IdGenerator` service (`Id.generate`), with `Id.layer` (UUIDv7 from `Clock` and `Random`, increasing within a millisecond, deterministic under `TestClock` and a seeded `Random`) and `Id.layerSequential` for tests. `@thomasfosterau/effect-biz/BizError` is the error channel every module shares: `NotFound`, `AlreadyExists`, `ValidationError`, `ConcurrencyConflict`, `InvalidTransition`, `Forbidden`, `BusinessRuleViolation` and `Unavailable`, the `BizError` union schema, `isRetryable`, `httpStatus`, and `decodeUnknown` / `fromSchemaError` to turn a `Schema` failure into a path-addressed `ValidationError`.
