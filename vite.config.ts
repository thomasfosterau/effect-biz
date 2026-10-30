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

/** Every published package, in dependency order. A new package adds itself here. */
const packages = [
  "@thomasfosterau/effect-biz",
  "@thomasfosterau/effect-biz-payments-stripe",
  "@thomasfosterau/effect-biz-payments-paypal",
  "@thomasfosterau/effect-biz-payments-airwallex",
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
    extends: [recommended, effect.configs.recommended],
    // oxlint's default plugins plus `import`, `promise`, `vitest` and `jsdoc`,
    // each contributing its rules to the categories below.
    plugins: ["eslint", "typescript", "unicorn", "oxc", "import", "promise", "vitest", "jsdoc"],
    categories: {
      correctness: "error",
      suspicious: "error",
      perf: "error",
    },
    rules: {
      "eslint/no-unused-vars": [
        "warn",
        {
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
        },
      ],
      "eslint/prefer-const": "warn",

      // ---- `suspicious` / `perf` / plugin and type-aware rules ----
      // `_tag` is Effect's discriminant, read and written on every tagged
      // value; any other leading underscore is still a finding.
      "eslint/no-underscore-dangle": ["error", { allow: ["_tag"] }],
      // Allowance adopted with type-aware linting (count as of adoption; a
      // new site is a defect, not headroom; paying it down is tracked in the
      // follow-up issue linked from the PR that enabled it). Every assertion
      // already carries a `// SAFETY:` comment
      // (effect/require-safety-comment-for-type-assertion): a structural read
      // of a value the type system cannot narrow (a decoded wire body, a
      // Distilled operation's erased input, a test fixture).
      "typescript/no-unsafe-type-assertion": "warn", // 37 sites (5 src, 2 scripts, 30 tests)
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
      // `casting-awareness` is an awareness prompt, not a defect rule — it
      // fires on every `as`. Stays visible as a warning.
      "effect/casting-awareness": "warn",
      // Hard-codes abbreviations (`Arr`, `P`, `R`, …) with no options, so it is
      // unsatisfiable under the full-name convention (`import * as Option from
      // "effect/Option"`) this family shares with its consumers.
      "effect/prefer-namespace-imports": "off",

      // ---- Effect preset: rules this workspace's conventions cut across ----
      // `prefer-option-over-null` fires on `?: T | undefined`, which is the
      // ONLY spelling of an optional member `exactOptionalPropertyTypes` lets
      // a caller forward an optional of its own into — the spelling AGENTS.md
      // mandates — and on the `NullOr` columns a SQL row decodes to.
      "effect/prefer-option-over-null": "off",
      // `unknown` is the honest type at a decoding boundary (a SQL row, an
      // HTTP body) before `Schema` has decoded it.
      "effect/no-unknown-parameters": "warn",
      "effect/no-unknown-returns": "warn",
      "effect/no-unsafe-dictionary-type": "warn",
      "effect/no-runtime-typeof": "warn",
      "typescript/no-explicit-any": "off",
      "typescript/no-empty-object-type": "off",
      "typescript/ban-ts-comment": "off",
      "unicorn/no-empty-file": "off",
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
          "effect/avoid-native-fetch": "off",
          "effect/effect-promise-vs-trypromise": "off",
          // `...(process.env.X ? { x } : {})` is how a vitest option is left
          // unset under `exactOptionalPropertyTypes`.
          "effect/no-conditional-empty-object-spread": "off",
        },
      },
      // Type-level tests: the expect-error directives ARE the assertions
      // (a statement that must fail to compile), and every binding exists to
      // be asserted against, never to be read.
      {
        files: ["**/tests/**/*.types.ts"],
        rules: {
          "eslint/no-unused-vars": "off",
          "effect/avoid-ts-ignore": "off",
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
          "effect/use-clock-service": "off",
          "effect/require-safety-comment-for-type-assertion": "warn",
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
      // Test suites ARE the runtime boundary: `Effect.runPromise` in a test
      // body is the harness running the effect under test, and a bare
      // `new Error("boom")` there is a fixture. Fixture casts and a wall-clock
      // read stay visible as warnings.
      {
        files: ["**/tests/**/*.ts"],
        rules: {
          "effect/effect-run-in-body": "off",
          "effect/avoid-untagged-errors": "off",
          "effect/require-safety-comment-for-type-assertion": "warn",
          "effect/use-clock-service": "warn",
          "effect/avoid-process-env": "warn",
          "effect/require-effect-concurrency": "warn",
          // A test is an application entry point: each case provides its own
          // stub layers, which is exactly where `Effect.provide` belongs.
          "effecttsgo/strict-effect-provide": "off",
          // A helper declared inside the `it` that uses it keeps each case
          // self-contained; `src/` still hoists them.
          "unicorn/consistent-function-scoping": "off",
          // Allowances adopted with type-aware linting (counts as of adoption;
          // a new site is a defect; tracked in the follow-up issue linked
          // from the PR that enabled them).
          // The capability tables erase each operation to
          // `Effect<unknown, unknown, …>` so one `it.each` runs them all.
          "effecttsgo/any-unknown-in-error-context": "warn", // 55 sites
          // Sibling `Effect.gen` blocks inside one case reuse the same names
          // (`errors`, `after`, `leader`) for the same roles.
          "eslint/no-shadow": "warn", // 22 sites
          // A credentials effect that fails although its type rules it out,
          // to reach the no-response path (SAFETY-commented).
          "effecttsgo/unsafe-effect-type-assertion": "warn", // 1 site
          // The webhook suite exercises the `Buffer` payload the SDK-based
          // verifier accepts; the WebCrypto verifier (effect-finance#41) drops it.
          "eslint/no-restricted-globals": "warn",
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
      // and each `ts` / `typescript` block of the package README (and, in
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
