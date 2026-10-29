# effect-biz

**Disclaimer:** This is an experiment. Don't use it in production.

Modular ERP and business-process services for [Effect](https://effect.website), built to be embedded in other applications: parties, the product catalogue, sales, purchasing, inventory, manufacturing, CRM, HR, projects and payroll, each as a package of Effect services you compose with the layers you choose.

Money is handled by the sibling [effect-finance](https://github.com/thomasfosterau/effect-finance) repository (payments, ledger, invoices, AR/AP, tax); effect-biz hands documents to it and never duplicates it.

| Package | Purpose |
| --- | --- |
| [`@thomasfosterau/effect-biz`](packages/core) | The foundation: identifiers, tenancy context, error channel, domain events and repository conventions. Peer: `effect`. |

More packages arrive as the roadmap's slices land; see the issue tracker.

## Design

- **Ports and adapters.** Each module defines its repositories as Effect services, with an in-memory layer for tests and an `@effect/sql` layer (Postgres, SQLite) for production. Bring your own if you need to.
- **Multi-tenant, multi-company.** Every call runs under a tenant context; a tenant holds one or more companies.
- **Event-driven integration.** Modules publish typed domain events through a transactional outbox; cross-module flows subscribe to them, and long-running ones run as durable `effect/workflow`s.
- **Mountable APIs.** Each module ships an optional `effect/http-api` group and an `effect/rpc` group.
- **Localisable.** The core is jurisdiction-neutral; Australian localisation comes first.

## Install

```sh
pnpm add effect @thomasfosterau/effect-biz
```

`effect` is a peer: your application owns the single copy.

## Development

See [CONTRIBUTING.md](CONTRIBUTING.md); conventions for agents are in [AGENTS.md](AGENTS.md). Releases go through Changesets ([PUBLISHING.md](PUBLISHING.md)); report vulnerabilities as [SECURITY.md](SECURITY.md) describes.

## License

MIT © Thomas Foster
