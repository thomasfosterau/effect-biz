import { assert, describe, it, expect } from "vite-plus/test";
// oxlint-disable-next-line effect/use-filesystem-service -- a test comparing generated sources with the files on disk, outside any Effect runtime
import { readdirSync, readFileSync } from "node:fs";
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as Order from "effect/Order";
import * as R from "effect/Record";
import * as Schema from "effect/Schema";
import { installed } from "../scripts/distilled.ts";
import {
  OVERRIDES,
  plan,
  readOperations,
  render,
  RESOURCES,
  runtimeOperations,
  UNEXPOSED,
} from "../scripts/resources.ts";

/**
 * The resource modules are generated from the installed Distilled release
 * (`scripts/generate-resources.ts`, effect-finance#146): every Distilled operation is placed
 * in exactly one module or listed as unexposed, and the modules on disk are
 * what the generator writes. A Distilled bump that adds, moves or renames an
 * operation fails here until `scripts/resources.ts` decides where it goes and
 * the modules are regenerated (`generate:resources`).
 */

const distilled = installed();
const operations = readOperations(distilled.declarations, distilled.module);
const planned = plan(operations);
const PACKAGE = new URL("../", import.meta.url);

/** The part of the package manifest the subpath check reads. */
const Manifest = Schema.fromJsonString(
  Schema.Struct({ exports: Schema.Record(Schema.String, Schema.Unknown) }),
);

/** Strings in code-unit order, as `Array.prototype.sort` orders them by default. */
const sorted = (strings: ReadonlyArray<string>): ReadonlyArray<string> =>
  Arr.sort(strings, Order.String);

/** Exported names, by resource subpath. */
type Kept = Readonly<Record<string, ReadonlyArray<string>>>;

/** The names each module exported before the modules re-exported Distilled, kept by the rule and {@link OVERRIDES}. */
const KEPT = {
  Account: ["create", "retrieve", "update", "del", "list"],
  AccountLink: ["create"],
  Balance: ["retrieve"],
  BalanceTransaction: ["retrieve", "list"],
  "BillingPortal.Session": ["create"],
  Charge: ["create", "retrieve", "update", "list"],
  CheckoutSession: ["create", "retrieve", "expire", "list"],
  CountrySpec: ["retrieve", "list"],
  Coupon: ["create", "retrieve", "update", "del", "list"],
  Customer: ["create", "retrieve", "update", "del", "list"],
  Dispute: ["retrieve", "update", "list"],
  Event: ["retrieve", "list"],
  ExternalAccount: ["create", "retrieve", "update", "del", "list"],
  File: ["create", "retrieve", "list"],
  "Identity.VerificationReport": ["retrieve", "list"],
  "Identity.VerificationSession": ["create", "retrieve", "update", "cancel", "redact", "list"],
  Invoice: ["create", "retrieve", "update", "del", "list"],
  "Issuing.Authorization": ["retrieve", "update", "list"],
  "Issuing.Card": ["create", "retrieve", "update", "list"],
  "Issuing.Cardholder": ["create", "retrieve", "update", "list"],
  "Issuing.Dispute": ["create", "retrieve", "update", "list"],
  "Issuing.Transaction": ["retrieve", "update", "list"],
  PaymentIntent: ["create", "retrieve", "update", "confirm", "cancel", "list"],
  PaymentMethod: ["create", "retrieve", "update", "attach", "detach", "list"],
  Payout: ["create", "retrieve", "update", "cancel", "list"],
  Person: ["create", "retrieve", "update", "del", "list"],
  Price: ["create", "retrieve", "update", "list"],
  Product: ["create", "retrieve", "update", "del", "list"],
  PromotionCode: ["create", "retrieve", "update", "list"],
  Refund: ["create", "retrieve", "update", "list"],
  Review: ["retrieve", "list", "approve"],
  SetupIntent: ["create", "retrieve", "update", "confirm", "cancel", "list"],
  Subscription: ["create", "retrieve", "update", "cancel", "list"],
  SubscriptionSchedule: ["create", "retrieve", "update", "cancel", "release", "list"],
  TaxRate: ["create", "retrieve", "update", "list"],
  "Terminal.ConnectionToken": ["create"],
  "Terminal.Location": ["create", "retrieve", "update", "del", "list"],
  "Terminal.Reader": ["create", "retrieve", "update", "del", "list"],
  Topup: ["create", "retrieve", "update", "list"],
  Transfer: ["create", "retrieve", "update", "list"],
  "Treasury.FinancialAccount": [
    "create",
    "retrieve",
    "update",
    "list",
    "close",
    "retrieveFeatures",
    "updateFeatures",
  ],
  "Treasury.InboundTransfer": ["create", "retrieve", "list", "cancel"],
  "Treasury.OutboundTransfer": ["create", "retrieve", "list", "cancel"],
  "Treasury.Transaction": ["retrieve", "list"],
  WebhookEndpoint: ["create", "retrieve", "update", "del", "list"],
} satisfies Kept;

describe("the resource plan", () => {
  it("reads every operation Distilled exports", () => {
    expect(sorted(operations.map((operation) => operation.name))).toEqual(
      runtimeOperations(distilled.module),
    );
    expect(operations.length).toBeGreaterThan(500);
  });

  it("places every operation in one module or lists it as unexposed, with no problem", () => {
    expect(planned.problems).toEqual([]);
    const exposed = R.values(planned.modules)
      .flat()
      .map((operation) => operation.name);
    expect(Arr.dedupe(exposed).length).toBe(exposed.length);
    expect(sorted([...exposed, ...planned.unexposed])).toEqual(runtimeOperations(distilled.module));
  });

  it("reports an operation under no listed path", () => {
    const [first] = operations;
    assert.isDefined(first, "Distilled has no operation");
    const stray = {
      ...first,
      name: "CreateWidget",
      path: "/v1/widgets",
      method: "POST" as const,
    };
    expect(plan([...operations, stray]).problems).toEqual([
      "CreateWidget (POST /v1/widgets) is in no resource module and not listed as unexposed",
    ]);
  });

  it("reports two operations that would share a name", () => {
    const customer = operations.find((operation) => operation.name === "GetCustomer");
    assert.isDefined(customer, "Distilled has no GetCustomer");
    const twin = {
      ...customer,
      name: "GetCustomerAgain",
    };
    expect(plan([...operations, twin]).problems).toContain(
      "GetCustomerAgain and GetCustomer would both be Customer.retrieve",
    );
  });

  it("reads each operation's params apart from its path ids", () => {
    const update = operations.find((operation) => operation.name === "UpdateCustomer");
    assert.isDefined(update, "Distilled has no UpdateCustomer");
    expect(update.ids).toEqual(["customer"]);
    expect(update.members).not.toContain("customer");
    expect(update.members).toContain("email");
  });

  it("reports a PARAM_TYPES entry whose operation is gone", () => {
    const without = operations.filter((operation) => operation.name !== "CreateFile");
    expect(plan(without).problems).toContain(
      "PARAM_TYPES names CreateFile, which Distilled no longer has",
    );
  });

  it("reports a PARAM_TYPES member its operation no longer takes", () => {
    const stale = operations.map((operation) =>
      operation.name === "CreateFile"
        ? { ...operation, members: operation.members.filter((member) => member !== "file") }
        : operation,
    );
    expect(plan(stale).problems).toEqual([
      "PARAM_TYPES retypes CreateFile's file, which is not a param of CreateFileRequest",
    ]);
  });

  it("has a module for every resource subpath the package publishes, and nothing else", () => {
    const manifest = Schema.decodeUnknownSync(Manifest)(
      // oxlint-disable-next-line effect/avoid-sync-fs -- see the import
      readFileSync(new URL("package.json", PACKAGE), "utf8"),
    );
    const published = R.keys(manifest.exports).map((key) => key.replace(/^\.\/?/, ""));
    const resources = RESOURCES.map((resource) => resource.subpath);
    expect(sorted(published.filter((key) => !resources.includes(key)))).toEqual([
      "",
      "StripeHttp",
      "StripePayments",
      "Treasury",
      "Webhook",
    ]);
    expect(resources.every((subpath) => published.includes(subpath))).toBe(true);
  });

  it("keeps every name a module exported before (effect-finance#146)", () => {
    R.toEntries(KEPT).forEach(([subpath, names]) => {
      const exported = (planned.modules[subpath] ?? []).map((operation) => operation.exported);
      expect(exported, subpath).toEqual(expect.arrayContaining([...names]));
    });
    const subpaths = RESOURCES.map((resource) => resource.subpath);
    expect(R.keys(KEPT).filter((subpath) => !subpaths.includes(subpath))).toEqual([]);
  });

  it("exposes the Invoice and Subscription actions (effect-finance#142)", () => {
    const names = (subpath: string) =>
      (planned.modules[subpath] ?? []).map((operation) => operation.exported);
    expect(names("Invoice")).toEqual(
      expect.arrayContaining([
        "finalize",
        "pay",
        "voidInvoice",
        "send",
        "markUncollectible",
        "listLines",
        "createPreview",
        "search",
      ]),
    );
    expect(names("Subscription")).toEqual(expect.arrayContaining(["resume", "migrate", "search"]));
  });

  it("names each API path and each subpath in RESOURCES once", () => {
    const paths = RESOURCES.flatMap((resource) => resource.paths);
    expect(paths.filter((path, index) => paths.indexOf(path) !== index)).toEqual([]);
    const subpaths = RESOURCES.map((resource) => resource.subpath);
    expect(subpaths.filter((subpath, index) => subpaths.indexOf(subpath) !== index)).toEqual([]);
  });

  it("lists only paths no module holds as unexposed, each with its reason", () => {
    const held = RESOURCES.flatMap((resource) => resource.paths);
    expect(
      UNEXPOSED.filter(({ path }) =>
        held.some((prefix) => prefix.startsWith(`${path}/`) || prefix === path),
      ),
    ).toEqual([]);
    expect(UNEXPOSED.filter(({ reason }) => reason.trim() === "")).toEqual([]);
    expect(R.size(OVERRIDES)).toBeGreaterThan(0);
  });

  it("leaves unexposed only the operations StripeHttp cannot run (effect-finance#154)", () => {
    expect(sorted(planned.unexposed)).toEqual(["CreateBillingMeterEventStream", "GetQuotePdf"]);
  });

  it("lets a longer unexposed path win over a resource's", () => {
    const quote = (planned.modules["Quote"] ?? []).map((operation) => operation.name);
    expect(quote).toContain("GetQuoteLineItems");
    expect(quote).not.toContain("GetQuotePdf");
  });

  it("follows stripe-node's names where the rule cannot, and lists a list", () => {
    const names = (subpath: string) =>
      (planned.modules[subpath] ?? []).map((operation) => operation.exported);
    expect(names("Billing.CreditGrant")).toContain("voidGrant");
    expect(names("Apps.Secret")).toContain("delWhere");
    expect(names("Apps.Secret")).not.toContain("del");
    expect(names("CreditNote")).toContain("listPreviewLines");
  });

  it("reports a /v2 DELETE that takes params, which would go out as a JSON body", () => {
    const withParams = operations.map((operation) =>
      operation.name === "DeleteCoreEventDestination"
        ? { ...operation, members: ["reason"], params: "optional" as const }
        : operation,
    );
    expect(plan(withParams).problems).toEqual([
      "DeleteCoreEventDestination (DELETE /v2/core/event_destinations/{id}) takes params, which Distilled would send as a JSON body",
    ]);
  });

  it("says a module includes test helpers only when it has some", () => {
    const helpers = (subpath: string) =>
      (planned.modules[subpath] ?? []).some((operation) => operation.testHelper);
    expect(helpers("Customer")).toBe(true);
    expect(helpers("CreditNote")).toBe(false);
    expect(helpers("TestHelpers.TestClock")).toBe(false);
  });

  it("reads a /v2 page as a list", () => {
    const names = (subpath: string) =>
      (planned.modules[subpath] ?? []).map((operation) => operation.exported);
    expect(names("V2.Core.Account")).toEqual(
      expect.arrayContaining(["create", "retrieve", "update", "list", "close"]),
    );
    expect(names("V2.Core.Event")).toEqual(["list", "retrieve"]);
  });

  it("re-exports every resource module from the root, flattened, or from the Treasury barrel", () => {
    // oxlint-disable-next-line effect/avoid-sync-fs -- see the import
    const read = (file: string) => readFileSync(new URL(`src/${file}`, PACKAGE), "utf8");
    const reexported = (source: string) =>
      [...source.matchAll(/^export \* as (?<name>\w+) from "\.\/(?<module>[\w.]+)\.js";$/gm)].map(
        (match) => ({
          name: match.groups?.["name"] ?? "",
          module: match.groups?.["module"] ?? "",
        }),
      );
    const root = reexported(read("index.ts"));
    const reached = [...root, ...reexported(read("Treasury.ts"))].map(({ module }) => module);
    expect(
      RESOURCES.map((resource) => resource.subpath).filter((subpath) => !reached.includes(subpath)),
    ).toEqual([]);
    expect(root.filter(({ name, module }) => name !== module.replaceAll(".", ""))).toEqual([]);
  });
});

describe("the generated resource modules", () => {
  it("are what the generator writes from the installed Distilled release", async () => {
    const files = await Effect.runPromise(render(planned, distilled.version));
    expect(R.size(files)).toBe(RESOURCES.length);
    R.toEntries(files).forEach(([file, code]) => {
      // oxlint-disable-next-line effect/avoid-sync-fs -- see the import
      const onDisk = readFileSync(new URL(file, PACKAGE), "utf8");
      expect(onDisk, `${file} is stale: run generate:resources`).toBe(code);
    });
  });

  it("leave no stale module behind", () => {
    // oxlint-disable-next-line effect/avoid-sync-fs -- see the import
    const generated = readdirSync(new URL("src/", PACKAGE)).filter(
      (name) =>
        name.endsWith(".ts") &&
        // oxlint-disable-next-line effect/avoid-sync-fs -- see the import
        readFileSync(new URL(`src/${name}`, PACKAGE), "utf8").includes(
          "Generated by `scripts/generate-resources.ts`",
        ),
    );
    expect(sorted(generated)).toEqual(
      sorted(RESOURCES.map((resource) => `${resource.subpath}.ts`)),
    );
  });
});
