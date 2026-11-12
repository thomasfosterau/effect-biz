/**
 * The SQL foundation of effect-biz: the dialects (`./Dialect`) and column
 * codecs (`./Column`) every domain package's `effect/sql` repository layer
 * shares, on Postgres, SQLite and Cloudflare D1, with in-process test
 * databases in `./testing` (SQLite) and `./testing.postgres`.
 *
 * Each module is its own subpath; this entry point carries only the name.
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
