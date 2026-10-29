import { describe, it, expect } from "vite-plus/test";
// oxlint-disable-next-line effect/use-filesystem-service -- a test inspecting the package's own source files, outside any Effect runtime
import { readdirSync, readFileSync } from "node:fs";
import * as Arr from "effect/Array";
import * as HashSet from "effect/HashSet";
import * as Option from "effect/Option";
import * as Result from "effect/Result";

/**
 * `stripe` is an optional peer (effect-finance#39), kept only for the types of the
 * SDK-based webhook verifier (`Webhook.constructEvent*`, which runs on an SDK
 * client the program builds): no module loads it at runtime, so a Worker
 * bundle built from any of them never contains the SDK. This walks the
 * runtime import graph of the sources and fails on any path to `stripe`.
 */

const SRC = new URL("../src/", import.meta.url);

/** The modules a source file imports at runtime (`import type` excluded). */
const runtimeImportsOf = (source: string): ReadonlyArray<string> => {
  const statement =
    /^(?:import|export)\s+(type\s+)?([^"';]*?)\s*from\s+"([^"]+)";|^import\s+"([^"]+)";/gms;
  return Arr.filterMap(Arr.fromIterable(source.matchAll(statement)), (match) => {
    const [, typeOnly, clause = "", from, bare] = match;
    if (bare !== undefined) return Result.succeed(bare);
    if (typeOnly !== undefined || from === undefined) return Result.failVoid;
    // `import { type A, type B } from …` is erased too.
    const named = /^\{([^}]*)\}$/s.exec(clause.trim());
    if (named !== null) {
      const [, inner = ""] = named;
      const specifiers = inner
        .split(",")
        .map((item) => item.trim())
        .filter((item) => item !== "");
      if (specifiers.every((item) => item.startsWith("type "))) return Result.failVoid;
    }
    return Result.succeed(from);
  });
};

/** `./x.js` relative to `file` → the source path under `src/`, or the package name. */
const resolve = (file: string, specifier: string): string => {
  if (!specifier.startsWith(".")) return specifier;
  const url = new URL(specifier.replace(/\.js$/, ".ts"), new URL(file, SRC));
  return url.pathname.slice(SRC.pathname.length);
};

/** Where a walk stands: the trail to the target once found, and the files already read. */
interface Walk {
  readonly path: Option.Option<ReadonlyArray<string>>;
  readonly seen: HashSet.HashSet<string>;
}

const reaches = (entry: string, target: string): ReadonlyArray<string> | undefined => {
  const walk = (
    file: string,
    trail: ReadonlyArray<string>,
    seen: HashSet.HashSet<string>,
  ): Walk => {
    if (file === target) return { path: Option.some(trail), seen };
    if (HashSet.has(seen, file) || !file.endsWith(".ts")) return { path: Option.none(), seen };
    // oxlint-disable-next-line effect/avoid-sync-fs -- see the import
    const source = readFileSync(new URL(file, SRC), "utf8");
    const start: Walk = { path: Option.none(), seen: HashSet.add(seen, file) };
    return Arr.reduce(runtimeImportsOf(source), start, (state, specifier) => {
      if (Option.isSome(state.path)) return state;
      const next = resolve(file, specifier);
      return walk(next, [...trail, next], state.seen);
    });
  };
  return Option.getOrUndefined(walk(entry, [entry], HashSet.empty()).path);
};

// oxlint-disable-next-line effect/avoid-sync-fs -- see the import
const entries = readdirSync(SRC).filter((name) => name.endsWith(".ts"));

describe("the stripe SDK is optional", () => {
  it("finds the entry points", () => {
    expect(entries).toContain("index.ts");
    expect(entries).toContain("StripeHttp.ts");
    expect(entries).toContain("Webhook.ts");
    expect(entries).not.toContain("Stripe.ts");
  });

  it("follows runtime imports, and skips type-only ones", () => {
    // The walk reaches a package a module loads (Distilled's operations)…
    expect(reaches("Customer.ts", "@distilled.cloud/stripe/stripe")).toBeDefined();
    // …and not one it imports for types alone: the webhook verifier's `stripe`.
    // oxlint-disable-next-line effect/avoid-sync-fs -- see the import
    expect(readFileSync(new URL("Webhook.ts", SRC), "utf8")).toContain(
      'import type Stripe from "stripe";',
    );
  });

  it.each(entries)("is never loaded at runtime from %s", (entry) => {
    expect(reaches(entry, "stripe")).toBeUndefined();
  });
});
