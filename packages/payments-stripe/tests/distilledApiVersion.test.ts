import { describe, it, expect, expectTypeOf } from "vite-plus/test";
// oxlint-disable-next-line effect/use-filesystem-service -- a test reading an installed package's manifest, outside any Effect runtime
import { readFileSync } from "node:fs";
// oxlint-disable-next-line effect/avoid-node-imports -- see the import above
import { createRequire } from "node:module";
// oxlint-disable-next-line effect/avoid-node-imports -- see the import above
import { pathToFileURL } from "node:url";
import * as HashMap from "effect/HashMap";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import type { CreateWebhookEndpointRequestApiVersion } from "@distilled.cloud/stripe/stripe";
import Stripe from "stripe";
import { DISTILLED_API_VERSION } from "../src/StripePayments.ts";

/**
 * The capability layers pin `Stripe-Version` to the API version the pinned
 * Distilled release is generated from (owner decision on effect-finance#146: follow
 * Distilled). Distilled exposes no such constant, so this table records it
 * per release: the `version` of the `com.stripe.api#Stripe` service in
 * `packages/stripe/.generated-specs/stripe.json` at the release's commit in
 * alchemy-run/distilled (`063c844c` for `1.0.0-rc.15`).
 */
const FOLLOWED = HashMap.make(["1.0.0-rc.15", "2026-09-30.endive"]);

const Manifest = Schema.Struct({
  name: Schema.Literal("@distilled.cloud/stripe"),
  version: Schema.String,
});

/**
 * The installed `@distilled.cloud/stripe` version, from the manifest beside
 * its entry point (`lib/index.js`): the package exports no `./package.json`.
 */
const installedVersion = (): string => {
  const entry = createRequire(import.meta.url).resolve("@distilled.cloud/stripe");
  // oxlint-disable-next-line effect/avoid-sync-fs -- see the import
  const text = readFileSync(new URL("../package.json", pathToFileURL(entry)), "utf8");
  return Schema.decodeUnknownSync(Schema.fromJsonString(Manifest))(text).version;
};

describe("DISTILLED_API_VERSION", () => {
  const installed = installedVersion();

  it("is the API version the installed Distilled release is generated from", () => {
    const followed = Option.getOrUndefined(HashMap.get(FOLLOWED, installed));
    if (followed === undefined) {
      expect.fail(
        `@distilled.cloud/stripe ${installed} is installed, but the API version it is generated ` +
          `from is not recorded. Look it up (the com.stripe.api#Stripe service's version in ` +
          `packages/stripe/.generated-specs/stripe.json at its release commit), then update ` +
          `DISTILLED_API_VERSION in src/internal/apiVersion.ts and the FOLLOWED table in this ` +
          `file together, and check that the fields src/internal/mapping.ts reads still exist.`,
      );
    }
    expect(DISTILLED_API_VERSION).toBe(followed);
  });

  it("is a version Distilled's own types know", () => {
    expectTypeOf<typeof DISTILLED_API_VERSION>().toExtend<CreateWebhookEndpointRequestApiVersion>();
  });

  // The optional `stripe` peer types `Webhook.constructEvent*`'s `Stripe.Event`
  // at the SDK's own API version, so the dev pin (`catalog:` in
  // pnpm-workspace.yaml) follows DISTILLED_API_VERSION too (effect-finance#160): on a
  // Distilled bump, move it, and the `catalogs.peers` range, to the stripe-node
  // release for the new version.
  it("is the API version of the installed stripe SDK", () => {
    expect(Stripe.API_VERSION).toBe(DISTILLED_API_VERSION);
    expectTypeOf<typeof Stripe.API_VERSION>().toEqualTypeOf<typeof DISTILLED_API_VERSION>();
  });
});
