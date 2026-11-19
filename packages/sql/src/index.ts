/**
 * The SQL foundation of effect-biz: the dialects (`./Dialect`), column
 * codecs (`./Column`), the unit of work (`./SqlUnitOfWork`) and the
 * repository helper (`./SqlRepository`) every domain package's `effect/sql`
 * repository layer shares, on Postgres, SQLite and Cloudflare D1, with
 * in-process test databases in `./testing` (SQLite) and `./testing.postgres`.
 *
 * Each module is also its own subpath; `./testing` and `./testing.postgres`
 * (optional client peers) are subpath-only.
 * See {@link name} for an example.
 *
 * @module
 */

/**
 * The published name of this package, for diagnostics and logging.
 *
 * @example
 * ```ts
 * import { name } from "@thomasfosterau/effect-biz-sql";
 *
 * console.log(name); // "@thomasfosterau/effect-biz-sql"
 * ```
 */
export const name = "@thomasfosterau/effect-biz-sql";

export * as Column from "./Column.js";
export * as Dialect from "./Dialect.js";
export * as SqlRepository from "./SqlRepository.js";
export * as SqlUnitOfWork from "./SqlUnitOfWork.js";
