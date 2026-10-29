/**
 * The installed `@distilled.cloud/stripe`, as the resource-module generator
 * reads it: its operations module, the declarations beside it (for type
 * names and docs) and its version. Shared by `generate-resources.ts` and
 * `tests/resources.test.ts`, so both plan from the same input.
 *
 * @module
 */

// oxlint-disable-next-line effect/use-filesystem-service -- a code generator and its test reading an installed package's files, outside any Effect runtime
import { readFileSync } from "node:fs";
// oxlint-disable-next-line effect/avoid-node-imports -- see the import above
import { createRequire } from "node:module";
// oxlint-disable-next-line effect/avoid-node-imports -- see the import above
import { pathToFileURL } from "node:url";
import * as Schema from "effect/Schema";
import * as Distilled from "@distilled.cloud/stripe/stripe";

const Manifest = Schema.Struct({
  name: Schema.Literal("@distilled.cloud/stripe"),
  version: Schema.String,
});

/** The installed Distilled Stripe package. */
export interface Installed {
  /** `@distilled.cloud/stripe/stripe`, the generated operations. */
  readonly module: Readonly<Record<string, unknown>>;
  /** `lib/services/stripe.d.ts`, the declarations of that module. */
  readonly declarations: string;
  /** The package version (`1.0.0-rc.15`). */
  readonly version: string;
}

/** Read the installed package, beside its entry point (`lib/index.js`). */
export const installed = (): Installed => {
  const entry = pathToFileURL(createRequire(import.meta.url).resolve("@distilled.cloud/stripe"));
  const read = (relative: string) =>
    // oxlint-disable-next-line effect/avoid-sync-fs -- see the import
    readFileSync(new URL(relative, entry), "utf8");
  return {
    module: Distilled,
    declarations: read("./services/stripe.d.ts"),
    version: Schema.decodeUnknownSync(Schema.fromJsonString(Manifest))(read("../package.json"))
      .version,
  };
};
