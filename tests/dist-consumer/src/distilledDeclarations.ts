/**
 * The consumer type-check cost of effect-finance#146: Distilled's generated operation
 * modules are large declaration files (`@distilled.cloud/stripe` puts every
 * Stripe operation in one of about 7.5 MB; `@distilled.cloud/paypal`'s
 * Orders module alone is about 0.8 MB), and a consumer whose declarations
 * reach one type-checks all of it. `StripePayments`, `StripeHttp`, `Webhook`
 * and `PayPalPayments` run on those operations but name only Distilled's
 * `Credentials` (each its own small subpath) in their declarations, so a
 * program on the neutral capabilities never pays for them.
 *
 * The Stripe resource modules (`./Customer`, `./Invoice`, …) are re-exports of
 * Distilled's operations and types, so their declarations do name the
 * operations module, by design: the cost a consumer pays for the escape
 * hatch it imports. Each must name it (a module typed by anything else would
 * have stopped re-exporting Distilled), and nothing else of Distilled's but
 * the light subpath.
 *
 * Walks the `.d.ts` graph of each package's `dist/` from every published
 * entry point (following `import … from`, `export … from` and `import("…")`
 * types into the shared declaration chunks) and fails on a declaration that
 * names a `@distilled.cloud/*` module its entry may not. Run by this
 * package's `check` task against the fresh `dist/` its build edges produce.
 * Plain Node: nothing here is Effect code.
 */

import * as Arr from "effect/Array";
import { graphOf } from "./declarationGraph.ts";

const DISTILLED = "@distilled.cloud/";

/** One package on Distilled, and the Distilled modules its declarations may name. */
interface Package {
  readonly directory: string;
  /** The one Distilled subpath every declaration may name. */
  readonly light: string;
  /** The operations module, and the entries whose declarations name it by design. */
  readonly heavy?:
    | { readonly module: string; readonly entries: (entry: string) => boolean }
    | undefined;
}

/** The entries of payments-stripe that are not resource modules. */
const STRIPE_LIGHT: ReadonlyArray<string> = [
  "StripePayments.d.ts",
  "StripeHttp.d.ts",
  "Webhook.d.ts",
];

const PACKAGES: ReadonlyArray<Package> = [
  {
    directory: "payments-stripe",
    light: "@distilled.cloud/stripe/Credentials",
    // Every resource module, the Treasury barrel and the root barrel (which
    // re-exports them all).
    heavy: {
      module: "@distilled.cloud/stripe/stripe",
      entries: (entry) => !Arr.contains(STRIPE_LIGHT, entry),
    },
  },
  { directory: "payments-paypal", light: "@distilled.cloud/paypal/Credentials" },
];

const failures = PACKAGES.flatMap(({ directory, light, heavy }) => {
  const { entries, reachableFrom, specifiersIn } = graphOf(directory);
  const allowed = (entry: string) =>
    heavy !== undefined && heavy.entries(entry) ? [light, heavy.module] : [light];
  const named = (entry: string, module: string) =>
    reachableFrom(entry).some((file) => specifiersIn(file).includes(module));
  const disallowed = entries().flatMap((entry) =>
    reachableFrom(entry).flatMap((file) =>
      specifiersIn(file)
        .filter(
          (specifier) => specifier.startsWith(DISTILLED) && !allowed(entry).includes(specifier),
        )
        .map(
          (specifier) =>
            `heavy Distilled declaration: ${directory}: ${entry} -> ${file} -> ${specifier}`,
        ),
    ),
  );
  const notReexported =
    heavy === undefined
      ? []
      : entries()
          .filter((entry) => heavy.entries(entry) && !named(entry, heavy.module))
          .map((entry) => `${directory}: ${entry} no longer names ${heavy.module}`);
  const sanity = entries().some((entry) => named(entry, light))
    ? []
    : [`sanity check failed: no ${directory} declaration names ${light}`];
  return [...disallowed, ...notReexported, ...sanity];
});

Arr.match(failures, {
  onEmpty: () => {
    process.stdout.write(
      `Distilled declarations as intended: ${PACKAGES.map(({ directory, light, heavy }) => `${directory} names ${light}${heavy === undefined ? "" : `, and its resource modules ${heavy.module}`}`).join("; ")}\n`,
    );
  },
  onNonEmpty: (messages) => {
    process.stderr.write(messages.map((failure) => `${failure}\n`).join(""));
    process.exitCode = 1;
  },
});
