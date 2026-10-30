/**
 * The one Vite+ configuration every package in this workspace shares: the
 * task graph (`check`, `build`, `test:unit`, `test:coverage`, `docgen`), the
 * `vp pack` (tsdown) settings and the vitest / coverage settings. Each
 * `packages/<name>/vite.config.ts` is a one-call instantiation of it.
 *
 * Copied from the effect-finance repository (itself adapted from the effect-web library). The difference is
 * the module layout: these packages keep one flat module per subpath
 * (`src/Party.ts`, `src/SalesOrder.Line.ts`), so the pack entries
 * are derived from the package's own `exports` map — the manifest stays the
 * single list of public entry points.
 */
import { existsSync, readFileSync } from "node:fs";
import * as Arr from "effect/Array";
import * as R from "effect/Record";
import * as Schema from "effect/Schema";
import { defineConfig } from "vite-plus";

/** What differs per package. */
export interface PackageConfigOptions {
  /** The package's `import.meta.url`, so paths resolve relative to it. */
  readonly url: string;
  /**
   * Also run the workspace root `README.md`'s TypeScript blocks in this
   * package's `docgen` task. Set on the one package whose dependencies
   * resolve every import those blocks make.
   */
  readonly rootReadme?: boolean | undefined;
}

/**
 * Input fingerprint for a package's cached tasks: auto tracking minus
 * node_modules bookkeeping churn (pnpm rewrites `.modules.yaml` on every
 * install), with the lockfile back explicitly so a dependency upgrade still
 * invalidates a type-check or a test run.
 */
const cacheInputs = [
  { auto: true },
  "!node_modules/**",
  "!coverage/**",
  "!docs/**",
  { pattern: "!node_modules/**", base: "workspace" as const },
  { pattern: "pnpm-lock.yaml", base: "workspace" as const },
];

/**
 * A sibling package is consumed the way a consumer does — through its
 * `exports`, so its `dist/` — hence the build edge on every task that
 * resolves one. A package with no workspace dependency gets an empty edge.
 */
const siblingBuild = { task: "build", from: "dependencies" as const };

const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");

/**
 * `pack.entry` from the manifest's `exports`: `"."` → `src/index.ts`, and
 * `"./Party"` → `src/Party.ts`, emitted as `dist/<key>.js` + `.d.ts`.
 */
const entriesFromExports = (exports: Manifest["exports"]): Record<string, string> =>
  R.fromEntries(
    Arr.map(R.keys(exports), (key): readonly [string, string] => {
      const name = key === "." ? "index" : key.slice(2);
      return [name, `src/${name}.ts`];
    }),
  );

/**
 * What the configuration reads from a package manifest: every one in this
 * workspace carries `name` and an `exports` map (strict catalog + the release
 * script depend on both). Only the `exports` keys are read.
 */
const Manifest = Schema.Struct({
  name: Schema.String,
  exports: Schema.Record(Schema.String, Schema.Unknown),
});

/** A decoded package manifest. */
type Manifest = typeof Manifest.Type;

/** Parse a `package.json`'s text as a {@link Manifest}, throwing when it is not one. */
const decodeManifest = Schema.decodeUnknownSync(Schema.fromJsonString(Manifest));

/**
 * The tsconfig the `check` task type-checks. A package with a workspace
 * sibling carries a `tsconfig.check.json` that resolves the sibling through
 * `dist/` (its tsconfig.json maps it to `src/` for type-aware lint, which
 * runs before any build); one without uses tsconfig.json directly.
 */
const checkProjectOf = (url: string): string =>
  existsSync(new URL("./tsconfig.check.json", url)) ? "tsconfig.check.json" : "tsconfig.json";

export const packageConfig = ({ url, rootReadme = false }: PackageConfigOptions) => {
  const manifest = decodeManifest(readFileSync(new URL("./package.json", url), "utf8"));
  const srcDir = new URL("./src/", url).pathname;
  const maxWorkers = process.env.VITEST_MAX_WORKERS;
  const readmes = rootReadme ? "README.md ../../README.md" : "README.md";
  const checkProject = checkProjectOf(url);
  return defineConfig({
    run: {
      tasks: {
        // `src` and `tests` under the native, Effect-patched `tsc`
        // (`tsconfig.check.json` where the package has a sibling, see above).
        check: {
          command: `tsc -p ${checkProject}`,
          dependsOn: [siblingBuild],
          cache: {
            input: cacheInputs,
            output: [],
          },
        },
        // The published artifact: one ESM bundle + declaration file per entry
        // point (`vp pack` → tsdown, `platform: neutral`). `sideEffects:
        // false` is a claim about this output: no top-level statements.
        build: {
          command: "vp pack",
          dependsOn: [siblingBuild],
          cache: {
            input: cacheInputs,
            output: ["dist/**"],
          },
        },
        "test:unit": {
          command: "vp test run tests",
          dependsOn: [siblingBuild],
          cache: {
            env: ["VITEST_MAX_WORKERS", "NODE_OPTIONS"],
            input: cacheInputs,
            output: [],
          },
        },
        "test:coverage": {
          command: "vp test run tests --coverage",
          dependsOn: [siblingBuild],
          cache: {
            env: ["VITEST_MAX_WORKERS", "NODE_OPTIONS"],
            input: cacheInputs,
            output: ["coverage/**"],
          },
        },
        // Type-checks AND RUNS every JSDoc `@example` (see the package's
        // docgen.json), then writes the git-ignored API reference to `docs/`.
        // An example imports packages by name exactly as a consumer does,
        // which resolves through `exports` to `dist/`: this package's own
        // build edge (which carries the sibling builds with it).
        //
        // Then the same for every `ts` / `typescript` block of the package's
        // README.md: scripts/readme-examples.ts writes the blocks into
        // a generated module under `docs/readme/src/`, and a second docgen run
        // over it type-checks and runs them. A fragment opts out with docgen's
        // own fence marker, `ts skip-type-checking`. The second run takes its
        // directories from DOCGEN_SRC / DOCGEN_OUT, not `--src` / `--out`:
        // docgen resolves a flag to an absolute path, then joins it onto the
        // working directory. With `rootReadme`, the root README's blocks are
        // written alongside (a module of their own) and run in the same pass.
        docgen: {
          command: `docgen && node ../../scripts/readme-examples.ts ${readmes} && DOCGEN_SRC=docs/readme/src DOCGEN_OUT=docs/readme docgen`,
          dependsOn: ["build"],
          cache: {
            input: [
              ...cacheInputs,
              "README.md",
              ...(rootReadme ? [{ pattern: "README.md", base: "workspace" as const }] : []),
              { pattern: "scripts/readme-examples.ts", base: "workspace" as const },
            ],
            output: ["docs/**"],
          },
        },
      },
    },
    pack: {
      entry: entriesFromExports(manifest.exports),
      format: "esm",
      platform: "neutral",
      dts: true,
      outDir: "dist",
      clean: true,
    },
    resolve: {
      // A test that imports its OWN package by name (as a consumer would, and
      // as the `paths` in the package's tsconfig.json type-check it) resolves
      // to `src/` rather than to the `dist/` that `exports` points at, so a
      // unit run never needs this package's build first. Siblings still
      // resolve through `exports` → `dist/` (the `siblingBuild` edge).
      alias: [
        { find: new RegExp(`^${escapeRegExp(manifest.name)}$`), replacement: `${srcDir}index.ts` },
        {
          find: new RegExp(`^${escapeRegExp(manifest.name)}/([A-Za-z.]+)$`),
          replacement: `${srcDir}$1.ts`,
        },
      ],
    },
    test: {
      include: ["tests/**/*.test.ts"],
      testTimeout: 30_000,
      ...(maxWorkers === undefined ? {} : { maxWorkers: Number(maxWorkers) }),
      coverage: {
        provider: "istanbul",
        // `json` writes coverage-final.json, the per-file Istanbul map.
        reporter: ["text-summary", "json-summary", "json"],
        reportsDirectory: "./coverage",
        // `examples/`: the runnable examples a package's suite executes
        // count too.
        include: ["src/**/*.ts", "examples/**/*.ts"],
        // `generated/`: machine-written code, exercised through the modules
        // that use it, not line by line.
        exclude: ["**/*.d.ts", "**/generated/**"],
      },
    },
  });
};
