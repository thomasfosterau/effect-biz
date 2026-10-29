/**
 * The declaration half of the optional `stripe` peer (effect-finance#56, effect-finance#146): no Stripe
 * declaration but the webhook verifier's may need the `stripe` package to
 * type-check in a consumer. Every resource module is typed with Distilled's
 * declarations; only `Webhook` (the SDK-based `constructEvent*` and its
 * `StripeService`) names `stripe`, and the root barrel, which re-exports it.
 *
 * Walks the `.d.ts` graph of `packages/payments-stripe/dist/` from every
 * published entry point (following `import … from`, `export … from` and
 * `import("…")` types into the shared declaration chunks) and fails if any
 * declaration reachable from one names `stripe`. Run by this package's
 * `check` task against the fresh `dist/` its build edges produce. Plain Node:
 * nothing here is Effect code.
 */

import * as Arr from "effect/Array";
import { graphOf } from "./declarationGraph.ts";

const SDK = "stripe";

/** The entry points whose declarations may name the SDK: the webhook verifier, and the barrel. */
const NAMES_SDK: ReadonlyArray<string> = ["Webhook.d.ts", "index.d.ts"];

const isSdk = (specifier: string): boolean => specifier === SDK || specifier.startsWith(`${SDK}/`);

const { entries, reachableFrom, specifiersIn } = graphOf("payments-stripe");

const free = entries().filter((entry) => !Arr.contains(NAMES_SDK, entry));
const leaks = free.flatMap((entry) =>
  reachableFrom(entry)
    .filter((file) => specifiersIn(file).some(isSdk))
    .map((file) => `${entry} -> ${file}`),
);
// Sanity: the walk sees the SDK where it is named, so it cannot pass vacuously.
const seen = reachableFrom("Webhook.d.ts").some((file) => specifiersIn(file).some(isSdk));

const failures: ReadonlyArray<string> = [
  ...Arr.match(leaks, {
    onEmpty: () => [],
    onNonEmpty: (named) => [`stripe named in declarations: ${named.join(", ")}`],
  }),
  ...(seen ? [] : ["sanity check failed: Webhook.d.ts no longer names stripe"]),
  ...(free.length < 40 ? [`sanity check failed: only ${free.length} entries`] : []),
];

Arr.match(failures, {
  onEmpty: () => {
    process.stdout.write(
      `declarations are free of the stripe SDK: ${free.length} entries (all but ${NAMES_SDK.join(", ")})\n`,
    );
  },
  onNonEmpty: (messages) => {
    process.stderr.write(messages.map((message) => `${message}\n`).join(""));
    process.exitCode = 1;
  },
});
