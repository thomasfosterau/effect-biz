/**
 * @copyright Thomas Foster
 *
 * Root workspace config. Owns the repo-wide format/lint/staged passes (read
 * statically by `vp fmt` / `vp lint` / `vp staged`) and the root `check` /
 * `docgen` / `test:coverage` aggregates. Every package's own tasks (`check`,
 * `test:unit`, `build`, `docgen`) live in that package's vite.config.ts via
 * ./vite.package.ts; this file deliberately compiles nothing.
 *
 * Copied from the effect-finance repository (itself from the effect-web and
 * effect-drizzle-ext libraries and the gardeneria application), whose payments
 * packages now live here: every comment
 * that explains a load-bearing decision is part of the standard and travels
 * with the config.
 */

import { defineConfig } from "vite-plus";
import { recommended } from "@effect/tsgo/oxlint-presets";
import effect from "@enfect/oxlint";
import * as R from "effect/Record";

/**
 * `@effect/tsgo`'s `recommended` preset with no warn tier: every rule it turns
 * on is an error here, as every other rule in the family's standard set is.
 */
const effectTsgo: typeof recommended = {
  ...recommended,
  rules: R.map(recommended.rules ?? {}, (level) => (level === "warn" ? "error" : level)),
};

/** Every published package, in dependency order. A new package adds itself here. */
const packages = [
  "@thomasfosterau/effect-biz",
  "@thomasfosterau/effect-biz-payments-stripe",
  "@thomasfosterau/effect-biz-sql",
];

export default defineConfig({
  // Staged-file checks run by `vp staged` (pre-commit): format WITH fixes,
  // then lint WITHOUT them. Lint is type-aware, and `vp check --fix` would
  // silently apply type-aware autofixes (even of `warn` rules) at commit
  // time, so the commit would differ from the tree that was verified. The
  // lint step tolerates a commit that stages no lintable file (only `.md` /
  // `.json` / `.css`).
  staged: {
    "*.{js,ts,css,json,md}": [
      "vp check --fix --no-lint",
      "vp check --no-fmt --no-error-on-unmatched-pattern",
    ],
  },
  fmt: {
    // `**/generated/**`: reserved for machine-written code that is not
    // formatted (none today: the Stripe resource modules, written by
    // packages/payments-stripe/scripts/generate-resources.ts, are formatted by
    // the generator itself, which `tests/resources.test.ts` checks).
    ignorePatterns: ["**/dist/**", "**/coverage/**", "**/generated/**", "pnpm-lock.yaml"],
    overrides: [
      {
        files: ["**/*.md"],
        options: {
          proseWrap: "never",
        },
      },
    ],
  },
  lint: {
    // `tests/dist-consumer`: a type-only fixture whose tsconfig resolves every
    // package to its EMITTED `dist/*.d.ts`, which do not exist before a build
    // (CI lints first). Its `Equals<…>` assertions are checked by
    // `vp run check`, which builds first; there is nothing else to lint.
    ignorePatterns: [
      "**/dist/**",
      "**/coverage/**",
      "**/generated/**",
      "**/node_modules/**",
      "tests/dist-consumer/**",
    ],
    // `@effect/tsgo`'s preset (the `effecttsgo/*` rules the patched oxlint
    // carries) and `@enfect/oxlint`'s `recommended` (every `effect/*` rule,
    // anti-slop included, at `error`; registered as a JS plugin).
    // Every rule is at `error`, with no warn tier and no inline disables
    // (owner decision, #161); an override below turns a rule off only where it
    // cannot apply, with its reason. `pedantic`, `nursery`, `style` and
    // `restriction` stay off: many of their rules contradict the conventions.
    extends: [effectTsgo, effect.configs.recommended],
    // oxlint's default plugins plus `import`, `promise`, `vitest` and `jsdoc`,
    // each contributing its rules to the categories below.
    plugins: ["eslint", "typescript", "unicorn", "oxc", "import", "promise", "vitest", "jsdoc"],
    categories: {
      correctness: "error",
      suspicious: "error",
      perf: "error",
    },
    rules: {
      // `Schema.Number` admits NaN and Infinity; use `Schema.Finite` / `Schema.Int`.
      "effecttsgo/schema-number": "error",
      // Entities and errors are nominal: `Schema.Class<Self, { readonly brand: unique symbol }>`.
      "effecttsgo/schema-class-missing-brand": "error",
      "eslint/no-unused-vars": [
        "error",
        {
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
        },
      ],
      "eslint/prefer-const": "error",
      // `@effect/tsgo` reads its own JSDoc tags: `@effect-leakable-service`
      // marks a request-scoped context (the tenant, the actor) that every
      // repository method is meant to require.
      "jsdoc/check-tag-names": ["error", { definedTags: ["effect-leakable-service"] }],

      // Chained `Effect.provide(a), Effect.provide(b)` becomes one provide of a
      // composed layer (`Layer.provideMerge`, `Layer.mergeAll`).
      "effecttsgo/multiple-effect-provide": "error",

      // ---- `suspicious` / `perf` / plugin and type-aware rules ----
      // `_tag` is Effect's discriminant, read and written on every tagged
      // value; any other leading underscore is still a finding.
      "eslint/no-underscore-dangle": ["error", { allow: ["_tag"] }],
      // Every assertion that remains is allowed per file in the override below.
      "typescript/no-unsafe-type-assertion": "error",
      // `expect(value, message)`: vitest's second argument is the failure
      // message, which the jest-derived default (one argument) rejects.
      "vitest/valid-expect": ["error", { maxArgs: 2 }],
      // The `Buffer` global is typed `any` wherever a consumer loads
      // @cloudflare/workers-types next to @types/node, so every call on it is
      // unchecked there. Use Uint8Array / TextEncoder / DataView instead.
      "eslint/no-restricted-globals": [
        "error",
        {
          name: "Buffer",
          message:
            "The `Buffer` global is typed `any` wherever @cloudflare/workers-types is loaded. Use Uint8Array / TextEncoder / DataView.",
        },
      ],
      // `@effect/tsgo` lint rules held at `error` with zero sites.
      "effecttsgo/run-of-exit-to-run-exit": "error",
      "effecttsgo/effect-fn-iife": "error",
      "effecttsgo/flat-map-conditional-to-filter-or-fail": "error",
      "effecttsgo/map-some-to-as-some": "error",
      "effecttsgo/effect-succeed-with-undefined": "error",
      "effecttsgo/prefer-typed-schema-decoder": "error",
      // Off: it fires on every use of an API tagged `@stability unstable`
      // (73 sites before the sql package, which adds more), and the
      // architecture mandates those modules (`effect/http` for the Stripe
      // client and Distilled, `effect/sql` and its `@effect/sql-*` clients in
      // the sql package, plus `effect/FileSystem`, `effect/Path` and
      // `@effect/platform-node` in the generator script; `effect/rpc` and
      // `effect/workflow` are planned). Effect 4 has no stable `HttpClient`/`FileSystem`, and the
      // rule takes no config (`RuleNoConfig` in `@effect/tsgo`'s
      // oxlint-schema.json), so there is no allowlist.
      "effecttsgo/unstable-api-usage": "off",
      "vite-plus/prefer-vite-plus-imports": "error",
    },
    overrides: [
      // Build/test configs are evaluated by Vite and Vitest in bare Node,
      // before any Effect runtime exists — there is no `Config` provider to
      // read from and no `FileSystem` service to call, so `process.env` and
      // `node:*` are the only things that work there. The root `scripts/` are
      // task-graph helpers of the same kind (a step of a package task, run by
      // bare `node`).
      {
        files: ["**/vite.config.ts", "**/vitest.config.ts", "vite.package.ts", "scripts/*.ts"],
        rules: {
          "effect/avoid-node-imports": "off",
          "effect/avoid-sync-fs": "off",
          "effect/avoid-process-env": "off",
          "effect/use-console-service": "off",
          "effect/use-filesystem-service": "off",
          "effect/use-path-service": "off",
        },
      },
      // The assertions no typing removes (10 sites, each with a `// SAFETY:`
      // comment). Src: a generic return (`F`, `OmitUndefined<T>`) and an
      // operation input that Distilled's `Operation<never, …>` types as
      // `never`. Tests: a fixture that must hand a function a value its type
      // forbids (a non-string id, a malformed status, an unbranded key, a
      // partial SDK client) to exercise the runtime check for an untyped
      // caller; a decoder cannot build such a value. Listed file by file.
      {
        files: [
          // 1: `OmitUndefined<T>` over a generic `T`.
          "packages/core/src/Payments.internal.ts",
          // 1: `checkId` is given a non-string id on purpose.
          "packages/core/tests/Payments.internal.test.ts",
          // 2: the erased operation input (`never`) and the generic signature `F`.
          "packages/payments-stripe/src/internal/resource.ts",
          // 1: `Schema.Top` (Distilled's schemas) needs `Codec<unknown, unknown>` to decode synchronously.
          "packages/payments-stripe/tests/StripePayments.endive.test.ts",
          // 1: a wire status that is not a string.
          "packages/payments-stripe/tests/StripePayments.enumerations.test.ts",
          // 1: a key the brand would have refused.
          "packages/payments-stripe/tests/StripePayments.idempotency.test.ts",
          // 1: a missing path id.
          "packages/payments-stripe/tests/StripeHttp.test.ts",
          // 1: an undefined path id.
          "packages/payments-stripe/tests/StripePayments.wire.test.ts",
          // 1: a partial SDK client.
          "packages/payments-stripe/tests/Webhook.test.ts",
        ],
        // `effect/casting-awareness` fires on every `as`: it is held at `error`
        // and these same files, each cast with its reason above, are exempt.
        rules: {
          "typescript/no-unsafe-type-assertion": "off",
          "effect/casting-awareness": "off",
        },
      },
      // The SDK-based `Webhook.constructEvent*` wrappers take the SDK's own
      // `string | Buffer` payload, and their suite must hand them a `Buffer`
      // (2 sites); `node:buffer` is refused in tests too, so the global is the
      // only way to build one. The WebCrypto `verify` (effect-finance#41) takes
      // `string | Uint8Array` and its suite keeps the rule.
      {
        files: ["packages/payments-stripe/tests/Webhook.test.ts"],
        rules: {
          "eslint/no-restricted-globals": "off",
        },
      },
      // Type-level tests: every binding exists to be asserted against, never
      // to be read.
      {
        files: ["**/tests/**/*.types.ts"],
        rules: {
          "eslint/no-unused-vars": "off",
        },
      },
      // `operation<F>` returns the generated resource module's annotated
      // signature: `F` is inferred from the export's type annotation (the
      // contextual return type), which is the whole point of the parameter.
      {
        files: ["packages/payments-stripe/src/internal/resource.ts"],
        rules: {
          "typescript/no-unnecessary-type-parameters": "off",
        },
      },
      // Vendor wire schemas decode a provider's JSON under the provider's own
      // field names (`active`, `livemode`, `has_more`); renaming them to
      // `is*` would decode nothing. The neutral entities they map onto keep
      // the rule.
      {
        files: ["packages/*/src/internal/mapping.ts"],
        rules: {
          "effect/require-is-prefix-for-boolean-schema-field": "off",
        },
      },
      // The examples are runnable scripts: the process edge, where the
      // program is run, logs to the terminal and reads its key from the
      // environment.
      {
        files: ["**/examples/**/*.ts"],
        rules: {
          "effect/effect-run-in-body": "off",
          "effect/use-console-service": "off",
          "effect/avoid-process-env": "off",
        },
      },
      // The runnable examples and payments-stripe's resource generator are
      // entry points: the program is run there, so providing its layers at
      // that site is exactly where `Effect.provide` belongs.
      {
        files: ["**/examples/**/*.ts", "packages/*/scripts/*.ts"],
        rules: {
          "effecttsgo/strict-effect-provide": "off",
        },
      },
      // Effect tests run through `@effect/vitest`'s `it.effect`, so no test
      // body runs an effect itself. A bare `new Error(…)` there is a fixture
      // standing for what `fetch` or the Stripe SDK throws, which the code
      // under test must map (7 sites).
      {
        files: ["**/tests/**/*.ts"],
        rules: {
          "effect/avoid-untagged-errors": "off",
          // `@effect/vitest`'s `it.effect` / `it.live` / `it.layer` bodies are
          // test blocks, but the rule only knows `it` and `test`.
          "vitest/no-standalone-expect": [
            "error",
            {
              additionalTestBlockFunctions: [
                "it.effect",
                "it.live",
                "it.effect.each",
                "it.live.each",
              ],
            },
          ],
          // `layer(L)(name, (it) => …)` hands its cases the layer-aware `it`,
          // which shadows the file's own (`@effect/vitest`'s documented form).
          "eslint/no-shadow": ["error", { allow: ["it"] }],
          // A helper declared inside the `it` that uses it keeps each case
          // self-contained; `src/` still hoists them.
          "unicorn/consistent-function-scoping": "off",
        },
      },
    ],
    // Type-aware linting through oxlint-tsgolint (bundled with Vite+, patched
    // by `effect-tsgo patch --oxlint`). tsgolint reads each file's nearest
    // `tsconfig.json`; every package's covers `src` and `tests`. `typeCheck`
    // also reports compiler diagnostics; `vp run check` (native,
    // Effect-patched tsc) stays the type gate of record.
    options: {
      typeAware: true,
      typeCheck: true,
    },
    jsPlugins: [
      {
        name: "vite-plus",
        specifier: "vite-plus/oxlint-plugin",
      },
    ],
  },
  run: {
    tasks: {
      // The whole CI pipeline as one task, in order: format + lint (type-aware,
      // so before any build), the type gates, the unit tests, the build, the
      // docs examples (which run against dist/) and the dependency audit.
      // `.github/workflows/ci.yml` runs exactly `vp run ci`, so a local run is
      // the CI run. Fail-fast: the first failing gate stops the rest.
      ci: {
        command:
          "vp check && vp run --concurrency-limit 2 check && vp run -r test:unit && vp run -r build && vp run docgen && pnpm audit --audit-level high",
        cache: false,
      },
      // The CI typecheck gate, as one task: every package's `check`, plus the
      // dist-consumer check that type-checks a consumer fixture against the
      // EMITTED declarations. A pure graph node. The packages are named explicitly — a
      // `from: "dependencies"` edge does not traverse the workspace root's own
      // devDependencies.
      check: {
        command: "echo 'check: every type gate green'",
        dependsOn: [...packages.map((name) => `${name}#check`), "@effect-biz/dist-consumer#check"],
        cache: false,
      },
      // Every package's docgen: type-checks AND RUNS each JSDoc `@example`
      // and each `ts` / `typescript` block of the package README and its guides under the root `docs/<package>/` (and, in
      // payments-stripe's, of this root README) against the built `dist/`, then writes the API reference under that package's
      // (git-ignored) `docs/`.
      docgen: {
        command: "echo 'docgen: every example compiled and ran'",
        dependsOn: packages.map((name) => `${name}#docgen`),
        cache: false,
      },
      // Every package's unit suite under one Istanbul coverage map
      // (`coverage/coverage-final.json`).
      "test:coverage": {
        command: "vp test run --coverage",
        dependsOn: packages.map((name) => `${name}#build`),
        cache: false,
      },
    },
  },
  test: {
    // One entry per package: each package's own vite.config.ts is a vitest
    // project, so the root run and the root coverage map cover them all.
    projects: ["packages/*/vite.config.ts"],
    coverage: {
      provider: "istanbul",
      reporter: ["text-summary", "json-summary", "json"],
      reportsDirectory: "./coverage",
      // `examples/`: the runnable examples a package's suite executes
      // (payments-stripe's `tests/examples.test.ts`) count too.
      include: ["packages/*/src/**/*.ts", "packages/*/examples/**/*.ts"],
      exclude: ["**/*.d.ts", "**/generated/**"],
    },
  },
});
