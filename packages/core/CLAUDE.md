# @thomasfosterau/effect-biz

The foundation every domain package builds on. Peer: `effect` only. No SQL, no HTTP, no domain vocabulary (no parties, products or orders).

## Boundary

Imports nothing from this workspace. Every other package imports it through its published `exports` (so through `dist/`).

## Invariants

- **Placeholder today.** `src/index.ts` carries only `name`; the platform-foundation issues replace it with the identifiers, tenancy context, error channel, domain events and repository conventions.
