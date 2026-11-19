# @thomasfosterau/effect-biz

The foundation every domain package builds on, and the vendor-neutral payments core every provider implements. Guides: [`docs/core/`](../../docs/core/).

## Boundary

Imports nothing from this workspace. No SQL, no vendor SDK or provider vocabulary, no ERP domain vocabulary outside the payments entities. Only `./Authorization` imports the optional peer `@thomasfosterau/effect-auth`. The root `.` entry re-exports the foundation modules as namespaces, but not payments, `./Authorization` or `./testing`. The payments `Customer`, `Product` and `Price` are a provider's records, not the ERP's parties or catalogue.

## Invariants

- **Ids** are lower-case UUIDv7 strings, branded per kind, and come only from the `IdGenerator` service.
- **Errors come from `BizError`.** A new tagged error only for a case a caller must branch on; otherwise a `BusinessRuleViolation` with a module-namespaced `code`. No error carries a secret or personal data. A new error adds its row to `BizError.httpStatus` (and `isRetryable` if retryable).
- **Every repository call runs under a tenant** (`TenantContext` in `R`); another tenant's entity is `NotFound`. `TenantContext`, `CompanyContext` and `CurrentActor` are request-scoped and tagged `@effect-leakable-service`.
- **Authorisation** is effect-auth's `Authorizer`: actions are `"resource:action"`, a denial is `Forbidden` with a `DecisionTrace` (never the principal or attribute values), any other failure `Unavailable`.
- **Every command is load → decide (pure) → commit one batch** inside `UnitOfWork.transaction`, which the service (never the caller) opens. Writes are version-guarded; a guard conflict re-runs the whole command from the outermost transaction; a command's own failure is never retried. No read-your-writes inside a transaction.
- **Domain events are recorded only through `EventRecorder.record`, inside the command's transaction**, so they commit exactly with the state change. Envelopes carry ids only. Within a version only additive changes; otherwise `DomainEvent.evolve`. Delivery is at least once; a subscriber's committed effects are exactly once (the inbox mark is in its batch). Delivery is leased per (entry, subscriber) and ordered per aggregate.
- **A document number is an attribute, never an identity.** Gap-less numbering stages a write guarded by the counter it read; periods are in the company's time zone; the pattern grammar is closed.
- **Repositories** follow `Repository.Port` and pass `./testing`'s contract suites. Audit fields live in one `audit` member; archive, never delete. Paging is keyset in a total order (sort keys, then id).
- **No `number` for an amount, quantity, price or rate**: `effect/BigDecimal` through `./Decimal`, encoded as canonical decimal strings. Nothing rounds without a `RoundingPolicy`. Pure failures are a `Result`, never a throw.

### Payments

- **Amounts are integer minor units** in the core; providers convert.
- **Enumerations are lenient** (`Known | Other`): a provider decoder never fails on an unknown value.
- **Hosted sessions never take an amount**, and return a required `url`.
- **`idempotencyKey` only where every provider can honour it**; a provider validates it first and never silently drops it.
- **A new capability** gets a `Payments.<Name>.ts` module and `exports` entry, a `Stub` constructor, and an implementation or stub layer in every provider.
- **`./Payments.internal` is semver-exempt**: the helpers providers share, naming no vendor.
- **Every exchange is time-boxed**, and a provider's token login is shared (`shareLogin`); a 401 forgets the token.
- **Errors**: every capability method fails only with `PaymentsError`. `PaymentsUnavailable` ("not configured ≡ down") is raised at call time, never while a layer is built.
