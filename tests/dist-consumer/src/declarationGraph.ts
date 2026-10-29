/**
 * The `.d.ts` graph of a package's `dist/`, shared by the declaration checks
 * (`declarationsFreeOfSdk.ts`, `distilledDeclarations.ts`): the module
 * specifiers a declaration file names, and every declaration file reachable
 * from an entry point through the local declaration chunks. Plain Node:
 * nothing here is Effect code.
 */

// oxlint-disable-next-line effect/use-filesystem-service -- a build-output check run by bare Node, outside any Effect runtime
import { readFileSync } from "node:fs";
import * as Arr from "effect/Array";
import * as Option from "effect/Option";
import * as R from "effect/Record";
import * as Schema from "effect/Schema";

/** The declaration graph of one package. */
export interface DeclarationGraph {
  /** A file of the package's `dist/`, as text (`../package.json` reads its manifest). */
  readonly read: (file: string) => string;
  /** Every module specifier a declaration file names: imports, re-exports, `import()` types, references. */
  readonly specifiersIn: (file: string) => ReadonlyArray<string>;
  /** Every declaration file reachable from `entry` through local chunks, `entry` included. */
  readonly reachableFrom: (entry: string) => ReadonlyArray<string>;
  /** The declaration file of every entry in the package's `exports`. */
  readonly entries: () => ReadonlyArray<string>;
}

/** `./x.js` in a declaration chunk is the `./x.d.ts` beside it. */
const declarationOf = (specifier: string): string => specifier.slice(2).replace(/\.js$/, ".d.ts");

/**
 * What the checks read from a package manifest: its `exports` map, whose
 * entries name their declarations (vite.package.ts derives the pack entries
 * from it).
 */
const Manifest = Schema.Struct({
  exports: Schema.Record(Schema.String, Schema.Struct({ types: Schema.String })),
});

/** Parse a `package.json`'s text as a {@link Manifest}, throwing when it is not one. */
const decodeManifest = Schema.decodeUnknownSync(Schema.fromJsonString(Manifest));

/** The declaration graph of `packages/<directory>/dist/`. */
export const graphOf = (directory: string): DeclarationGraph => {
  const dist = new URL(`../../../packages/${directory}/dist/`, import.meta.url);
  const read = (file: string): string =>
    // oxlint-disable-next-line effect/avoid-sync-fs -- see the import
    readFileSync(new URL(file, dist), "utf8");
  const specifiersIn = (file: string): ReadonlyArray<string> => {
    // Doc comments keep their `@example` imports, which a consumer never
    // resolves; `/// <reference>` directives are line comments, and kept.
    const source = read(file).replace(/\/\*[\s\S]*?\*\//g, "");
    return [
      ...source.matchAll(/\b(?:from|import)\s*["']([^"']+)["']/g),
      ...source.matchAll(/\bimport\s*\(\s*["']([^"']+)["']\s*\)/g),
      ...source.matchAll(/\/\/\/\s*<reference\s+(?:types|path)="([^"]+)"/g),
    ].map((match) => match[1] ?? "");
  };
  /**
   * Walk `reached` from position `index` on: `reached` grows while it is
   * walked (a worklist), each file appended once, in discovery order.
   */
  const walk = (reached: ReadonlyArray<string>, index: number): ReadonlyArray<string> =>
    Option.match(Arr.get(reached, index), {
      onNone: () => reached,
      onSome: (file) =>
        walk(
          Arr.reduce(
            Arr.map(
              Arr.filter(specifiersIn(file), (item) => item.startsWith("./")),
              declarationOf,
            ),
            reached,
            (acc, next) => (Arr.contains(acc, next) ? acc : Arr.append(acc, next)),
          ),
          index + 1,
        ),
    });
  const reachableFrom = (entry: string): ReadonlyArray<string> => walk([entry], 0);
  const entries = (): ReadonlyArray<string> =>
    Arr.map(R.values(decodeManifest(read("../package.json")).exports), (target) =>
      target.types.replace("./dist/", ""),
    );
  return { read, specifiersIn, reachableFrom, entries };
};

/** The declaration graph of `packages/payments-stripe/dist/`. */
export const { reachableFrom, specifiersIn } = graphOf("payments-stripe");
