---
"@thomasfosterau/effect-biz": minor
---

Add tenancy, companies and actors (#26): `./Tenancy` (`TenantId`, `CompanyId`, `TenantContext`, `CompanyContext`, `currentTenant`, `currentCompany`, `withTenant`, `withCompany`), `./Company` (the `Company` entity with `Registration`, `CountryCode` and `FiscalYearStart`, the tenant-scoped, version-guarded `CompanyRepository` port, `create` / `get` / `list` / `update`, and `layerMemory`) and `./Actor` (`Actor`, `CurrentActor`, `current`, `system`, `withActor`).
