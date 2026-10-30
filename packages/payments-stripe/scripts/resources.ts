/**
 * Which `@distilled.cloud/stripe` operation each resource module exposes,
 * under which name, and the source of every generated resource module.
 *
 * Every operation Distilled generates is either **assigned** to one published
 * resource subpath (`./Customer`, `./Invoice`, `./Treasury.FinancialAccount`,
 * …) by the longest API path in {@link RESOURCES} it falls under (its test
 * helpers, `/v1/test_helpers/…`, included), or left out by a longer path in
 * {@link UNEXPOSED}, which says why it stays unexposed. `tests/resources.test.ts` fails
 * on an operation that is neither, so a Distilled bump that adds one forces a
 * decision; it also fails when a generated module on disk differs from
 * {@link render}'s output (run `generate:resources`).
 *
 * Names follow the path, after the matched prefix (`{id}` is a path id):
 *
 * | rest of the path | `GET` | `POST` | `DELETE` |
 * | --- | --- | --- | --- |
 * | (none) | `list` (a list: `data` with `has_more`, or `/v2`'s `next_page_url`) / `retrieve` | `create` | `del` |
 * | `{id}` | `retrieve` | `update` | `del` |
 * | `word` | `word` | `word` | — |
 * | `{id}/word` | `listWord` (a list) / `retrieveWord` | `createWord` (a collection) / `updateWord` (an object) / `word` (an action) | `delWord` |
 * | `{id}/words/{id}` | `retrieveWord` | `updateWord` | `delWord` |
 * | `{id}/words/{id}/act` | — | `actWord` | — |
 *
 * in camel case, singular after `list` / `create` / … of a collection; a test
 * helper is `testHelpers` + the name. {@link OVERRIDES} keeps the name an
 * operation had before the resource modules re-exported Distilled
 * (`Subscription.cancel`, `Treasury.FinancialAccount.retrieveFeatures`) and
 * settles the few the rule cannot (`Invoice.voidInvoice`: `void` is reserved).
 *
 * The test imports it, and the generator script (`generate-resources.ts`)
 * runs it under Node.
 *
 * @module
 */

import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as HashSet from "effect/HashSet";
import * as Order from "effect/Order";
import * as Predicate from "effect/Predicate";
import * as R from "effect/Record";
import * as Schema from "effect/Schema";
import type * as AST from "effect/SchemaAST";
import { getAnn, getProps, hasPropAnn, nameOf } from "@distilled.cloud/core/protocol-http";
import { httpSymbol, labelSymbol } from "@distilled.cloud/core/trait";
import { format } from "vite-plus/fmt";

/** One published resource subpath and the API paths whose operations it holds. */
export interface Resource {
  /** The subpath, published as `./<subpath>` from `src/<subpath>.ts`. */
  readonly subpath: string;
  /** API path templates (`/v1/customers`); an operation under several goes to the longest. */
  readonly paths: ReadonlyArray<string>;
}

/**
 * Every resource subpath this package publishes. Names follow the Stripe
 * SDKs' resource types: a top-level resource is its singular (`/v1/credit_notes`
 * → `CreditNote`), a namespaced one is dotted (`/v1/billing/meters` →
 * `Billing.Meter`, `/v2/core/accounts` → `V2.Core.Account`); a sub-collection
 * Stripe types as a resource of its own gets a subpath of its own
 * (`/v1/accounts/{account}/persons` → `Person`). `CheckoutSession` keeps the
 * name it was first published under.
 */
export const RESOURCES: ReadonlyArray<Resource> = [
  { subpath: "Account", paths: ["/v1/accounts"] },
  { subpath: "AccountLink", paths: ["/v1/account_links"] },
  { subpath: "AccountSession", paths: ["/v1/account_sessions"] },
  { subpath: "ApplePayDomain", paths: ["/v1/apple_pay/domains"] },
  { subpath: "ApplicationFee", paths: ["/v1/application_fees"] },
  { subpath: "Apps.Install", paths: ["/v1/apps/installs"] },
  { subpath: "Apps.Secret", paths: ["/v1/apps/secrets"] },
  { subpath: "Balance", paths: ["/v1/balance"] },
  { subpath: "BalanceSettings", paths: ["/v1/balance_settings"] },
  { subpath: "BalanceTransaction", paths: ["/v1/balance_transactions"] },
  { subpath: "Billing.Alert", paths: ["/v1/billing/alerts"] },
  { subpath: "Billing.CreditBalanceSummary", paths: ["/v1/billing/credit_balance_summary"] },
  {
    subpath: "Billing.CreditBalanceTransaction",
    paths: ["/v1/billing/credit_balance_transactions"],
  },
  { subpath: "Billing.CreditGrant", paths: ["/v1/billing/credit_grants"] },
  { subpath: "Billing.FeedbackOption", paths: ["/v1/billing/feedback_options"] },
  { subpath: "Billing.Meter", paths: ["/v1/billing/meters"] },
  { subpath: "Billing.MeterEvent", paths: ["/v1/billing/meter_events"] },
  { subpath: "Billing.MeterEventAdjustment", paths: ["/v1/billing/meter_event_adjustments"] },
  { subpath: "BillingPortal.Configuration", paths: ["/v1/billing_portal/configurations"] },
  { subpath: "BillingPortal.Session", paths: ["/v1/billing_portal/sessions"] },
  { subpath: "Charge", paths: ["/v1/charges"] },
  { subpath: "CheckoutSession", paths: ["/v1/checkout/sessions"] },
  { subpath: "Climate.Order", paths: ["/v1/climate/orders"] },
  { subpath: "Climate.Product", paths: ["/v1/climate/products"] },
  { subpath: "Climate.Supplier", paths: ["/v1/climate/suppliers"] },
  { subpath: "ConfirmationToken", paths: ["/v1/confirmation_tokens"] },
  { subpath: "CountrySpec", paths: ["/v1/country_specs"] },
  { subpath: "Coupon", paths: ["/v1/coupons"] },
  { subpath: "CreditNote", paths: ["/v1/credit_notes"] },
  { subpath: "Customer", paths: ["/v1/customers"] },
  { subpath: "CustomerSession", paths: ["/v1/customer_sessions"] },
  { subpath: "Dispute", paths: ["/v1/disputes"] },
  { subpath: "Entitlements.ActiveEntitlement", paths: ["/v1/entitlements/active_entitlements"] },
  { subpath: "Entitlements.Feature", paths: ["/v1/entitlements/features"] },
  { subpath: "EphemeralKey", paths: ["/v1/ephemeral_keys"] },
  { subpath: "Event", paths: ["/v1/events"] },
  { subpath: "ExchangeRate", paths: ["/v1/exchange_rates"] },
  { subpath: "ExternalAccount", paths: ["/v1/accounts/{account}/external_accounts"] },
  { subpath: "File", paths: ["/v1/files"] },
  { subpath: "FileLink", paths: ["/v1/file_links"] },
  { subpath: "FinancialConnections.Account", paths: ["/v1/financial_connections/accounts"] },
  { subpath: "FinancialConnections.Session", paths: ["/v1/financial_connections/sessions"] },
  {
    subpath: "FinancialConnections.Transaction",
    paths: ["/v1/financial_connections/transactions"],
  },
  { subpath: "Forwarding.Request", paths: ["/v1/forwarding/requests"] },
  { subpath: "Identity.VerificationReport", paths: ["/v1/identity/verification_reports"] },
  { subpath: "Identity.VerificationSession", paths: ["/v1/identity/verification_sessions"] },
  { subpath: "Invoice", paths: ["/v1/invoices"] },
  { subpath: "InvoiceItem", paths: ["/v1/invoiceitems"] },
  { subpath: "InvoicePayment", paths: ["/v1/invoice_payments"] },
  { subpath: "InvoiceRenderingTemplate", paths: ["/v1/invoice_rendering_templates"] },
  { subpath: "Issuing.Authorization", paths: ["/v1/issuing/authorizations"] },
  { subpath: "Issuing.Card", paths: ["/v1/issuing/cards"] },
  { subpath: "Issuing.Cardholder", paths: ["/v1/issuing/cardholders"] },
  { subpath: "Issuing.Dispute", paths: ["/v1/issuing/disputes"] },
  { subpath: "Issuing.PersonalizationDesign", paths: ["/v1/issuing/personalization_designs"] },
  { subpath: "Issuing.PhysicalBundle", paths: ["/v1/issuing/physical_bundles"] },
  { subpath: "Issuing.Token", paths: ["/v1/issuing/tokens"] },
  { subpath: "Issuing.Transaction", paths: ["/v1/issuing/transactions"] },
  { subpath: "Mandate", paths: ["/v1/mandates"] },
  { subpath: "PaymentAttemptRecord", paths: ["/v1/payment_attempt_records"] },
  { subpath: "PaymentIntent", paths: ["/v1/payment_intents"] },
  { subpath: "PaymentLink", paths: ["/v1/payment_links"] },
  { subpath: "PaymentMethod", paths: ["/v1/payment_methods"] },
  { subpath: "PaymentMethodConfiguration", paths: ["/v1/payment_method_configurations"] },
  { subpath: "PaymentMethodDomain", paths: ["/v1/payment_method_domains"] },
  { subpath: "PaymentRecord", paths: ["/v1/payment_records"] },
  { subpath: "Payout", paths: ["/v1/payouts"] },
  { subpath: "Person", paths: ["/v1/accounts/{account}/persons"] },
  { subpath: "Plan", paths: ["/v1/plans"] },
  { subpath: "Price", paths: ["/v1/prices"] },
  { subpath: "Product", paths: ["/v1/products"] },
  { subpath: "ProductCatalog.TrialOffer", paths: ["/v1/product_catalog/trial_offers"] },
  { subpath: "PromotionCode", paths: ["/v1/promotion_codes"] },
  { subpath: "Quote", paths: ["/v1/quotes"] },
  { subpath: "Radar.EarlyFraudWarning", paths: ["/v1/radar/early_fraud_warnings"] },
  { subpath: "Radar.PaymentEvaluation", paths: ["/v1/radar/payment_evaluations"] },
  { subpath: "Radar.ValueList", paths: ["/v1/radar/value_lists"] },
  { subpath: "Radar.ValueListItem", paths: ["/v1/radar/value_list_items"] },
  { subpath: "Refund", paths: ["/v1/refunds"] },
  { subpath: "Reporting.ReportRun", paths: ["/v1/reporting/report_runs"] },
  { subpath: "Reporting.ReportType", paths: ["/v1/reporting/report_types"] },
  { subpath: "Review", paths: ["/v1/reviews"] },
  { subpath: "SetupAttempt", paths: ["/v1/setup_attempts"] },
  { subpath: "SetupIntent", paths: ["/v1/setup_intents"] },
  { subpath: "ShippingRate", paths: ["/v1/shipping_rates"] },
  { subpath: "Sigma.ScheduledQueryRun", paths: ["/v1/sigma/scheduled_query_runs"] },
  { subpath: "Source", paths: ["/v1/sources"] },
  { subpath: "Subscription", paths: ["/v1/subscriptions"] },
  { subpath: "SubscriptionItem", paths: ["/v1/subscription_items"] },
  { subpath: "SubscriptionSchedule", paths: ["/v1/subscription_schedules"] },
  { subpath: "Tax.Association", paths: ["/v1/tax/associations"] },
  { subpath: "Tax.Calculation", paths: ["/v1/tax/calculations"] },
  { subpath: "Tax.Location", paths: ["/v1/tax/locations"] },
  { subpath: "Tax.Registration", paths: ["/v1/tax/registrations"] },
  { subpath: "Tax.Settings", paths: ["/v1/tax/settings"] },
  { subpath: "Tax.Transaction", paths: ["/v1/tax/transactions"] },
  { subpath: "TaxCode", paths: ["/v1/tax_codes"] },
  { subpath: "TaxId", paths: ["/v1/tax_ids"] },
  { subpath: "TaxRate", paths: ["/v1/tax_rates"] },
  { subpath: "Terminal.Configuration", paths: ["/v1/terminal/configurations"] },
  { subpath: "Terminal.ConnectionToken", paths: ["/v1/terminal/connection_tokens"] },
  { subpath: "Terminal.Location", paths: ["/v1/terminal/locations"] },
  { subpath: "Terminal.OnboardingLink", paths: ["/v1/terminal/onboarding_links"] },
  { subpath: "Terminal.Reader", paths: ["/v1/terminal/readers"] },
  { subpath: "TestHelpers.TestClock", paths: ["/v1/test_helpers/test_clocks"] },
  { subpath: "ThreeDSecure.Authentication", paths: ["/v1/three_d_secure/authentications"] },
  { subpath: "Token", paths: ["/v1/tokens"] },
  { subpath: "Topup", paths: ["/v1/topups"] },
  { subpath: "Transfer", paths: ["/v1/transfers"] },
  { subpath: "Treasury.CreditReversal", paths: ["/v1/treasury/credit_reversals"] },
  { subpath: "Treasury.DebitReversal", paths: ["/v1/treasury/debit_reversals"] },
  { subpath: "Treasury.FinancialAccount", paths: ["/v1/treasury/financial_accounts"] },
  { subpath: "Treasury.InboundTransfer", paths: ["/v1/treasury/inbound_transfers"] },
  { subpath: "Treasury.OutboundPayment", paths: ["/v1/treasury/outbound_payments"] },
  { subpath: "Treasury.OutboundTransfer", paths: ["/v1/treasury/outbound_transfers"] },
  { subpath: "Treasury.ReceivedCredit", paths: ["/v1/treasury/received_credits"] },
  { subpath: "Treasury.ReceivedDebit", paths: ["/v1/treasury/received_debits"] },
  { subpath: "Treasury.Transaction", paths: ["/v1/treasury/transactions"] },
  { subpath: "Treasury.TransactionEntry", paths: ["/v1/treasury/transaction_entries"] },
  { subpath: "V2.Billing.MeterEvent", paths: ["/v2/billing/meter_events"] },
  { subpath: "V2.Billing.MeterEventAdjustment", paths: ["/v2/billing/meter_event_adjustments"] },
  { subpath: "V2.Billing.MeterEventSession", paths: ["/v2/billing/meter_event_session"] },
  {
    subpath: "V2.Commerce.ProductCatalogImport",
    paths: ["/v2/commerce/product_catalog/imports"],
  },
  { subpath: "V2.Core.Account", paths: ["/v2/core/accounts"] },
  { subpath: "V2.Core.AccountLink", paths: ["/v2/core/account_links"] },
  { subpath: "V2.Core.AccountPerson", paths: ["/v2/core/accounts/{account_id}/persons"] },
  {
    subpath: "V2.Core.AccountPersonToken",
    paths: ["/v2/core/accounts/{account_id}/person_tokens"],
  },
  { subpath: "V2.Core.AccountToken", paths: ["/v2/core/account_tokens"] },
  { subpath: "V2.Core.Event", paths: ["/v2/core/events"] },
  { subpath: "V2.Core.EventDestination", paths: ["/v2/core/event_destinations"] },
  { subpath: "WebhookEndpoint", paths: ["/v1/webhook_endpoints"] },
];

/** An API path whose operations stay unexposed on purpose, and why. */
export interface Unexposed {
  /** The API path template; every operation under it stays unexposed, even under a resource's path. */
  readonly path: string;
  /** Why no resource module holds it. */
  readonly reason: string;
}

/**
 * API paths whose operations no resource module exposes, deliberately: each
 * needs what `StripeHttp`'s request policy cannot give it. A program reaches
 * them through `@distilled.cloud/stripe` directly. An entry wins over a
 * {@link RESOURCES} path it is longer than (`Quote` keeps everything but its
 * PDF), and must still match an operation, so one Distilled drops is
 * removed here too.
 */
export const UNEXPOSED: ReadonlyArray<Unexposed> = [
  {
    path: "/v1/quotes/{quote}/pdf",
    reason:
      "a binary PDF streamed from files.stripe.com: StripeHttp sends it to the API origin and reads every 2xx as JSON (Distilled types it `{}`)",
  },
  {
    path: "/v2/billing/meter_event_stream",
    reason:
      "sent to meter-events.stripe.com with a meter event session's token, not the account key: StripeHttp sends every request to the API origin with the key (create the session with `V2.Billing.MeterEventSession.create`)",
  },
];

/** An operation the naming rule does not place or name as it should. */
interface Override {
  /** The subpath, when the operation's path is under none of its {@link Resource.paths}. */
  readonly subpath?: string | undefined;
  /** The name, when the rule's is not the one to publish. */
  readonly name?: string | undefined;
}

/** Overrides by Distilled operation name. */
type Overrides = Readonly<Record<string, Override>>;

/** The operations, by Distilled name, the rule does not place or name. */
export const OVERRIDES = {
  // `GET /v1/account`: the account the key belongs to, beside `retrieve(id)`.
  GetAccount: { subpath: "Account", name: "retrieveCurrent" },
  // `POST …/login_links` and `…/funding_instructions` create, but there is no
  // collection to list.
  CreateAccountLoginLink: { name: "createLoginLink" },
  CreateCustomerFundingInstruction: { name: "createFundingInstructions" },
  // A `POST` to a singleton's own path updates it: there is nothing to create.
  CreateBalanceSettings: { name: "update" },
  CreateTaxSettings: { name: "update" },
  // `void` is a reserved word. `voidGrant` is stripe-node's name.
  CreateInvoiceVoid: { name: "voidInvoice" },
  CreateBillingCreditGrantVoid: { name: "voidGrant" },
  CreateCreditNoteVoid: { name: "voidCreditNote" },
  // `POST /v1/apps/secrets/delete` deletes a secret by name and scope, not by
  // id as every `del` does: stripe-node's `deleteWhere` (`delete` is reserved).
  CreateAppsSecretsDelete: { name: "delWhere" },
  // `GET /v1/credit_notes/preview/lines` is a list.
  GetCreditNotesPreviewLines: { name: "listPreviewLines" },
  // `DELETE /v1/subscriptions/{id}` cancels; the module has always called it `cancel`.
  DeleteSubscription: { name: "cancel" },
} satisfies Overrides;

/** Retyped members by Distilled operation name, then member name: the member's type. */
type ParamTypes = Readonly<Record<string, Readonly<Record<string, string>>>>;

/**
 * Params members retyped where Distilled's declaration is narrower than what
 * the operation sends, by Distilled operation name, then member: the member
 * is dropped from Distilled's input type and declared again, required, as
 * the given type.
 */
const PARAM_TYPES = {
  // Distilled declares `file: string`; its multipart encoder sends a `Blob`
  // (a `File` included) as the file part, which is how a file is uploaded.
  CreateFile: { file: "string | Blob" },
} satisfies ParamTypes;

/** The members `paramTypes` retypes on the operation Distilled names `name`, as `[member, type]` pairs. */
const retypedOf = (
  paramTypes: ParamTypes,
  name: string,
): ReadonlyArray<readonly [string, string]> => R.toEntries(paramTypes[name] ?? R.empty());

/** The override of the operation Distilled names `name`, if there is one. */
const overrideOf = (name: string, overrides: Overrides = OVERRIDES): Override | undefined =>
  overrides[name];

/** One Distilled operation, as the planner reads it. */
export interface DistilledOperation {
  /** Distilled's export name (`CreateCustomer`). */
  readonly name: string;
  /** Its input and output type (and schema) names in `@distilled.cloud/stripe/stripe`. */
  readonly input: string;
  readonly output: string;
  readonly method: "GET" | "POST" | "DELETE";
  /** The path template (`/v1/customers/{customer}`). */
  readonly path: string;
  /** The input members bound to path ids, in path order. */
  readonly ids: ReadonlyArray<string>;
  /** The input members beyond the path ids (the params), in declaration order. */
  readonly members: ReadonlyArray<string>;
  /** Whether the input has members beyond the path ids, and whether any is required. */
  readonly params: "none" | "optional" | "required";
  /** Whether the output is a page (`{ data, has_more }`, or `/v2`'s `{ data, next_page_url }`). */
  readonly list: boolean;
  /** Whether the body is `multipart/form-data` (the Files API). */
  readonly upload: boolean;
  /** Distilled's one-line summary (`Create a customer`), or `""`. */
  readonly summary: string;
}

/** An operation placed in a resource module. */
export interface Planned extends DistilledOperation {
  /** The exported function name. */
  readonly exported: string;
  /** Whether it is one of the resource's test helpers (under `/v1/test_helpers`). */
  readonly testHelper: boolean;
}

/** What {@link plan} decides. */
export interface Plan {
  /** Each resource subpath's operations, sorted by exported name, in {@link RESOURCES} order. */
  readonly modules: Readonly<Record<string, ReadonlyArray<Planned>>>;
  /** The operations left unexposed, by Distilled name. */
  readonly unexposed: ReadonlyArray<string>;
  /** Every problem: an operation unassigned, a name clash, an unused table entry, a params-carrying `/v2` `DELETE`. */
  readonly problems: ReadonlyArray<string>;
}

const RESERVED: HashSet.HashSet<string> = HashSet.make(
  "break",
  "case",
  "catch",
  "class",
  "const",
  "continue",
  "debugger",
  "default",
  "delete",
  "do",
  "else",
  "enum",
  "export",
  "extends",
  "false",
  "finally",
  "for",
  "function",
  "if",
  "import",
  "in",
  "instanceof",
  "new",
  "null",
  "return",
  "super",
  "switch",
  "this",
  "throw",
  "true",
  "try",
  "typeof",
  "var",
  "void",
  "while",
  "with",
  "yield",
);

const TEST_HELPERS = "/v1/test_helpers";

/** `/v1/x` → `/v1/test_helpers/x`. */
const testHelperPath = (path: string): string => `${TEST_HELPERS}${path.slice("/v1".length)}`;

/** The path segments of `path` after `prefix`, if `path` is `prefix` or under it. */
const restOf = (path: string, prefix: string): ReadonlyArray<string> | undefined =>
  path === prefix
    ? []
    : path.startsWith(`${prefix}/`)
      ? path.slice(prefix.length + 1).split("/")
      : undefined;

const isId = (segment: string): boolean => segment.startsWith("{");

const pascal = (segment: string): string =>
  segment
    .split("_")
    .map((word) => `${word.charAt(0).toUpperCase()}${word.slice(1)}`)
    .join("");

const camel = (segment: string): string => {
  const name = pascal(segment);
  return `${name.charAt(0).toLowerCase()}${name.slice(1)}`;
};

const singular = (segment: string): string =>
  segment.endsWith("ies")
    ? `${segment.slice(0, -3)}y`
    : segment.endsWith("s")
      ? segment.slice(0, -1)
      : segment;

/** Where an operation goes: a resource module, under the rest of its path, or nowhere. */
type Placement =
  | {
      readonly kind: "resource";
      readonly subpath: string;
      readonly rest: ReadonlyArray<string>;
      readonly testHelper: boolean;
    }
  | { readonly kind: "unexposed" }
  | { readonly kind: "unassigned" };

/** The longest of `prefixes` an operation's path falls under, directly or as a test helper. */
const longestMatch = (
  path: string,
  prefixes: ReadonlyArray<string>,
): { readonly prefix: string; rest: ReadonlyArray<string>; testHelper: boolean } | undefined =>
  prefixes
    .flatMap((prefix) => {
      const direct = restOf(path, prefix);
      const helper = prefix.startsWith("/v1/") ? restOf(path, testHelperPath(prefix)) : undefined;
      return [
        ...(direct === undefined ? [] : [{ prefix, rest: direct, testHelper: false }]),
        ...(helper === undefined ? [] : [{ prefix, rest: helper, testHelper: true }]),
      ];
    })
    .reduce<
      { readonly prefix: string; rest: ReadonlyArray<string>; testHelper: boolean } | undefined
    >(
      (best, match) =>
        best === undefined || match.prefix.length > best.prefix.length ? match : best,
      undefined,
    );

const place = (operation: DistilledOperation): Placement => {
  const override = overrideOf(operation.name)?.subpath;
  if (override !== undefined) {
    return { kind: "resource", subpath: override, rest: [], testHelper: false };
  }
  const match = RESOURCES.flatMap((resource) => {
    const found = longestMatch(operation.path, resource.paths);
    return found === undefined ? [] : [{ ...found, subpath: resource.subpath }];
  }).reduce<
    | { readonly prefix: string; subpath: string; rest: ReadonlyArray<string>; testHelper: boolean }
    | undefined
  >(
    (best, found) =>
      best === undefined || found.prefix.length > best.prefix.length ? found : best,
    undefined,
  );
  const unexposed = longestMatch(
    operation.path,
    UNEXPOSED.map((entry) => entry.path),
  );
  if (
    unexposed !== undefined &&
    (match === undefined || unexposed.prefix.length > match.prefix.length)
  ) {
    return { kind: "unexposed" };
  }
  return match === undefined
    ? { kind: "unassigned" }
    : { kind: "resource", subpath: match.subpath, rest: match.rest, testHelper: match.testHelper };
};

/** What naming an operation reads: the operation, the words of the rest of its path, every operation. */
interface Naming {
  readonly operation: DistilledOperation;
  readonly words: ReadonlyArray<string>;
  readonly all: ReadonlyArray<DistilledOperation>;
}

type Method = DistilledOperation["method"];

/** The verb of each method on an object: `{id}`, or `{id}/words/{id}`. */
const OBJECT_VERB: Readonly<Record<Method, string>> = {
  GET: "retrieve",
  POST: "update",
  DELETE: "del",
};

/** `GET` of a page lists; of anything else, retrieves. */
const readVerb = (operation: DistilledOperation): string => (operation.list ? "list" : "retrieve");

/** The resource's own path: a `GET` reads it, a `POST` creates under it, a `DELETE` deletes it. */
const nameRoot = ({ operation }: Naming): string =>
  operation.method === "GET" ? readVerb(operation) : operation.method === "POST" ? "create" : "del";

/**
 * A `POST` to `{id}/word`: a create in a collection (one with a list or an
 * `{id}/word/{id}` beside it), an update of a sub-object Stripe also reads
 * (`{id}/features`), or else an action named by the word.
 */
const namePostUnder = ({ operation, words, all }: Naming): string => {
  const word = words[0] ?? "";
  const read = all.find((other) => other.path === operation.path && other.method === "GET");
  const collection =
    read?.list === true || all.some((other) => other.path.startsWith(`${operation.path}/{`));
  if (collection) return `create${pascal(singular(word))}`;
  return read === undefined ? camel(word) : `update${pascal(word)}`;
};

/** An operation on `{id}/word`. */
const nameUnder = (naming: Naming): string => {
  const word = pascal(naming.words[0] ?? "");
  const { operation } = naming;
  if (operation.method === "GET") return `${readVerb(operation)}${word}`;
  return operation.method === "DELETE" ? `del${word}` : namePostUnder(naming);
};

/** Names an operation. */
type Namer = (naming: Naming) => string;

/** Namers by the shape of the rest of the path. */
type Namers = Readonly<Record<string, Namer>>;

/** The rule for each shape of the rest of the path (`{}` an id, `w` a word). */
const NAMERS = {
  "": nameRoot,
  "{}": ({ operation }) => OBJECT_VERB[operation.method],
  w: ({ words }) => camel(words[0] ?? ""),
  "{}/w": nameUnder,
  "{}/w/{}": ({ operation, words }) =>
    `${OBJECT_VERB[operation.method]}${pascal(singular(words[0] ?? ""))}`,
  "{}/w/{}/w": ({ words }) => `${camel(words[1] ?? "")}${pascal(singular(words[0] ?? ""))}`,
} satisfies Namers;

/** The rule for a shape, if it has one. */
const namerOf = (pattern: string, namers: Namers = NAMERS): Namer | undefined => namers[pattern];

/** The rule's name for an operation, from the rest of its path. */
const ruleName = (
  operation: DistilledOperation,
  rest: ReadonlyArray<string>,
  all: ReadonlyArray<DistilledOperation>,
): string => {
  const words = rest.filter((segment) => !isId(segment));
  const pattern = rest.map((segment) => (isId(segment) ? "{}" : "w")).join("/");
  const namer = namerOf(pattern) ?? (() => camel(words.join("_")));
  return namer({ operation, words, all });
};

/** The exported name of an operation placed in a module. */
const exportedName = (
  operation: DistilledOperation,
  placement: Extract<Placement, { readonly kind: "resource" }>,
  all: ReadonlyArray<DistilledOperation>,
): string => {
  const base = overrideOf(operation.name)?.name ?? ruleName(operation, placement.rest, all);
  return placement.testHelper ? `testHelpers${pascal(base)}` : base;
};

/** Why `exported` cannot join `module`, if it cannot. */
const nameProblems = (
  operation: DistilledOperation,
  exported: string,
  subpath: string,
  module: ReadonlyArray<Planned>,
): ReadonlyArray<string> => {
  const clash = module.find((other) => other.exported === exported);
  return [
    ...(HashSet.has(RESERVED, exported)
      ? [`${operation.name} would be exported as the reserved word ${exported}`]
      : []),
    ...(clash === undefined
      ? []
      : [`${operation.name} and ${clash.name} would both be ${subpath}.${exported}`]),
  ];
};

/**
 * Why an operation cannot be sent as Stripe expects, if it cannot: a `/v2`
 * `DELETE` with params, which Distilled would encode as a JSON body
 * (`StripeHttp` moves only a form body's params to the query string).
 */
const wireProblems = (operation: DistilledOperation): ReadonlyArray<string> =>
  operation.method === "DELETE" && operation.path.startsWith("/v2/") && operation.params !== "none"
    ? [
        `${operation.name} (DELETE ${operation.path}) takes params, which Distilled would send as a JSON body`,
      ]
    : [];

/**
 * The table entries that name nothing Distilled has: an operation it no
 * longer exports, or a `PARAM_TYPES` member that is no longer a param of its
 * operation (whose retyping would silently add a member Distilled dropped).
 */
const staleEntries = (operations: ReadonlyArray<DistilledOperation>): ReadonlyArray<string> => {
  const known = HashSet.fromIterable(operations.map((operation) => operation.name));
  return [
    ...R.keys(OVERRIDES)
      .filter((name) => !HashSet.has(known, name))
      .map((name) => `OVERRIDES names ${name}, which Distilled no longer has`),
    ...R.toEntries(PARAM_TYPES).flatMap(([name, members]) => {
      const operation = operations.find((candidate) => candidate.name === name);
      return operation === undefined
        ? [`PARAM_TYPES names ${name}, which Distilled no longer has`]
        : R.keys(members)
            .filter((member) => !operation.members.includes(member))
            .map(
              (member) =>
                `PARAM_TYPES retypes ${name}'s ${member}, which is not a param of ${operation.input}`,
            );
    }),
    ...UNEXPOSED.filter(
      ({ path }) => !operations.some((operation) => longestMatch(operation.path, [path])),
    ).map(({ path }) => `UNEXPOSED lists ${path}, which no operation is under`),
  ];
};

/** How {@link plan} decides one operation: placed in a module, left unexposed, or a problem. */
type Decision =
  | { readonly kind: "planned"; readonly subpath: string; readonly planned: Planned }
  | { readonly kind: "unexposed"; readonly name: string }
  | { readonly kind: "problem"; readonly problem: string };

/** Decide one of `all`'s operations, whose modules are `subpaths`. */
const decide = (
  operation: DistilledOperation,
  all: ReadonlyArray<DistilledOperation>,
  subpaths: ReadonlyArray<string>,
): Decision => {
  const placement = place(operation);
  if (placement.kind === "unexposed") return { kind: "unexposed", name: operation.name };
  if (placement.kind === "unassigned") {
    return {
      kind: "problem",
      problem: `${operation.name} (${operation.method} ${operation.path}) is in no resource module and not listed as unexposed`,
    };
  }
  if (!subpaths.includes(placement.subpath)) {
    return {
      kind: "problem",
      problem: `${operation.name} is overridden into ${placement.subpath}, which is no resource`,
    };
  }
  const exported = exportedName(operation, placement, all);
  return {
    kind: "planned",
    subpath: placement.subpath,
    planned: { ...operation, exported, testHelper: placement.testHelper },
  };
};

/** The operations `decisions` place in `subpath`, in decision order. */
const plannedIn = (decisions: ReadonlyArray<Decision>, subpath: string): ReadonlyArray<Planned> =>
  decisions.flatMap((decision) =>
    decision.kind === "planned" && decision.subpath === subpath ? [decision.planned] : [],
  );

/** Planned operations by exported name, as `String.prototype.localeCompare` orders them. */
const byExported: Order.Order<Planned> = Order.mapInput(
  Order.make((a: string, b: string) => {
    const compared = a.localeCompare(b);
    return compared < 0 ? -1 : compared > 0 ? 1 : 0;
  }),
  (planned: Planned) => planned.exported,
);

/** Decide every operation's module and name. */
export const plan = (operations: ReadonlyArray<DistilledOperation>): Plan => {
  const subpaths = RESOURCES.map((resource) => resource.subpath);
  const decisions = operations.map((operation) => decide(operation, operations, subpaths));
  // Each operation's problems, in operation order: a name clashes with the
  // operations placed before it in the same module.
  const decisionProblems = decisions.flatMap((decision, index) =>
    decision.kind === "problem"
      ? [decision.problem]
      : decision.kind === "planned"
        ? [
            ...nameProblems(
              decision.planned,
              decision.planned.exported,
              decision.subpath,
              plannedIn(decisions.slice(0, index), decision.subpath),
            ),
            ...wireProblems(decision.planned),
          ]
        : [],
  );
  const modules = R.fromEntries(
    subpaths.map(
      (subpath) => [subpath, Arr.sort(plannedIn(decisions, subpath), byExported)] as const,
    ),
  );
  return {
    modules,
    unexposed: decisions.flatMap((decision) =>
      decision.kind === "unexposed" ? [decision.name] : [],
    ),
    problems: [
      ...staleEntries(operations),
      ...decisionProblems,
      ...R.toEntries(modules).flatMap(([subpath, planned]) =>
        Arr.isReadonlyArrayEmpty(planned) ? [`${subpath} would export no operation`] : [],
      ),
    ],
  };
};

// ---------------------------------------------------------------------------
// Reading Distilled
// ---------------------------------------------------------------------------

/** A schema, as Distilled's operations expose theirs (`.input` / `.output`). */
interface WithAst {
  readonly ast: AST.AST;
}

const OPERATION =
  /(?:\/\*\*(?<doc>[^\n]*?)\*\/\n)?export declare const (?<name>\w+): API\.(?:Paginated)?OperationMethod<(?<input>\w+), (?<output>\w+), \w+, StripeOpContext(?:, \w+)?>;/g;

/**
 * The names of every operation the Distilled module exports at runtime (a
 * function carrying its schemas as `.input`), so a declaration the reader's
 * pattern misses cannot drop an operation silently.
 */
export const runtimeOperations = (
  distilled: Readonly<Record<string, unknown>>,
): ReadonlyArray<string> =>
  Arr.sort(
    R.keys(distilled).filter((name) => {
      const value = distilled[name];
      return (
        Predicate.isFunction(value) &&
        Object.getOwnPropertyDescriptor(value, "input")?.get !== undefined
      );
    }),
    Order.String,
  );

const summaryOf = (doc: string): string =>
  doc
    .trim()
    .split(" <p>")[0]
    ?.replace(/<[^>]+>/g, "")
    .trim() ?? "";

/**
 * Every operation of `@distilled.cloud/stripe/stripe`: names and docs from its
 * declarations (`lib/services/stripe.d.ts`), method, path and members from
 * the operations' own schemas (`distilled`, the module itself).
 */
export const readOperations = (
  declarations: string,
  distilled: Readonly<Record<string, unknown>>,
): ReadonlyArray<DistilledOperation> =>
  [...declarations.matchAll(OPERATION)].map((match) => {
    const { doc = "", name = "", input = "", output = "" } = match.groups ?? {};
    // SAFETY: every `API.OperationMethod` Distilled exports carries its
    // schemas as `.input` / `.output` (`@distilled.cloud/core/api`'s `make`).
    const operation = distilled[name] as { readonly input: WithAst; readonly output: WithAst };
    const inputAst = operation.input.ast;
    // SAFETY: every generated input carries the `Http()` trait.
    const http = getAnn(inputAst, httpSymbol) as {
      readonly method: DistilledOperation["method"];
      readonly uri: string;
      readonly contentType?: string | undefined;
    };
    const props = getProps(inputAst);
    const labels = props.filter((prop) => hasPropAnn(prop, labelSymbol));
    const tokens = labels.map((prop) => ({
      member: String(prop.name),
      at: http.uri.indexOf(`{${nameOf(prop, labelSymbol)}}`),
    }));
    const labelled = HashSet.fromIterable(labels);
    const others = props.filter((prop) => !HashSet.has(labelled, prop));
    const outputNames = HashSet.fromIterable(
      getProps(operation.output.ast).map((prop) => String(prop.name)),
    );
    return {
      name,
      input,
      output,
      method: http.method,
      path: http.uri,
      ids: Arr.sort(
        tokens,
        Order.mapInput(Order.Number, (token: (typeof tokens)[number]) => token.at),
      ).map((token) => token.member),
      members: others.map((prop) => String(prop.name)),
      params: Arr.match(others, {
        onEmpty: () => "none" as const,
        onNonEmpty: (members) =>
          members.some((prop) => prop.type.context?.isOptional !== true)
            ? ("required" as const)
            : ("optional" as const),
      }),
      // A `/v1` page carries `has_more`; a `/v2` page, `next_page_url`.
      list:
        HashSet.has(outputNames, "data") &&
        (HashSet.has(outputNames, "has_more") || HashSet.has(outputNames, "next_page_url")),
      upload: http.contentType === "multipart",
      summary: summaryOf(doc),
    };
  });

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

/** A doc comment's text, safe inside `/** … *\/`. */
const docText = (text: string): string => text.replaceAll("*/", "*\\/");

/**
 * A type Distilled names in an operation's declaration: one of its own, or a
 * keyword (`unknown`: rc.15 declares `CreateTransfer` / `GetTransfer` /
 * `UpdateTransfer` so).
 */
const KEYWORDS: HashSet.HashSet<string> = HashSet.make("unknown");

const typeOf = (name: string): string => (HashSet.has(KEYWORDS, name) ? name : `Distilled.${name}`);

/** A string as a TypeScript (and JSON) string literal: `"customer"`. */
const quoted: (value: string) => string = Schema.encodeSync(Schema.fromJsonString(Schema.String));

const signatureOf = (operation: Planned): string => {
  const ids = operation.ids.map((id) => `${id}: string`);
  const retyped = retypedOf(PARAM_TYPES, operation.name);
  const omitted = [...operation.ids, ...retyped.map(([member]) => member)];
  const base = Arr.match(omitted, {
    onEmpty: () => `Distilled.${operation.input}`,
    onNonEmpty: (members) =>
      `Omit<Distilled.${operation.input}, ${members.map(quoted).join(" | ")}>`,
  });
  const rest = Arr.match(retyped, {
    onEmpty: () => base,
    onNonEmpty: (members) =>
      `${base} & { ${members.map(([member, type]) => `readonly ${member}: ${type}`).join("; ")} }`,
  });
  const params =
    operation.params === "none"
      ? []
      : operation.params === "required"
        ? [`params: ${rest}`]
        : [`params?: ${rest}`];
  // An optional PARAMETER accepts `undefined` even under
  // `exactOptionalPropertyTypes`, so no `| undefined` (the type-aware
  // `typescript/no-duplicate-type-constituents` rule flags it).
  return `(${[...ids, ...params, "options?: RequestOptions"].join(", ")}) => Effect.Effect<${typeOf(operation.output)}, PaymentsError, StripeHttp>`;
};

const renderOperation = (operation: Planned): string => {
  const summary = operation.summary === "" ? operation.name : operation.summary;
  const route = [
    `method: ${quoted(operation.method)}`,
    `path: ${quoted(operation.path)}`,
    `ids: [${operation.ids.map(quoted).join(", ")}]`,
    `params: ${operation.params !== "none"}`,
    ...(operation.upload ? ["upload: true"] : []),
  ].join(", ");
  return [
    "/**",
    ` * ${docText(summary)} (\`${operation.method} ${operation.path}\`): Distilled's`,
    ` * \`${operation.name}\`.`,
    " */",
    `export const ${operation.exported}: ${signatureOf(operation)} = /* @__PURE__ */ operation(Distilled.${operation.name}, { ${route} });`,
  ].join("\n");
};

/** The module doc's first line: the API paths the module holds. */
const pathsOf = (subpath: string): string =>
  (RESOURCES.find((resource) => resource.subpath === subpath)?.paths ?? [])
    .map((path) => `\`${path}\``)
    .join(", ");

/** The module doc's paragraph on a `/v2` API, which differs from `/v1` on the wire. */
const V2_NOTE: ReadonlyArray<string> = [
  " * A `/v2` API: Distilled sends `params` as a JSON body (not form-encoded),",
  " * and a list is a `{ data, next_page_url, previous_page_url }` page, not",
  " * `/v1`'s `{ data, has_more }`.",
  " *",
];

/** One resource module's source, unformatted. */
const renderModule = (
  subpath: string,
  operations: ReadonlyArray<Planned>,
  version: string,
): string => {
  const types = Arr.sort(
    Arr.dedupe(operations.flatMap((operation) => [operation.input, operation.output])).filter(
      (name) => !HashSet.has(KEYWORDS, name),
    ),
    Order.String,
  );
  return [
    "/**",
    ` * Stripe's ${pathsOf(subpath)} API as a raw resource module, the escape hatch for`,
    " * what the neutral capabilities do not cover: every `@distilled.cloud/stripe`",
    operations.some((operation) => operation.testHelper)
      ? " * operation on the resource, its test helpers included."
      : " * operation on the resource.",
    " *",
    " * Each operation takes the resource's path ids first, then the rest of",
    " * Distilled's input (`params`), then {@link RequestOptions}, and runs through",
    " * the `StripeHttp` client in context: `Stripe-Version` pinned to",
    " * `DISTILLED_API_VERSION` (unless configured, or overridden per call), the",
    " * SDK's retries, a per-attempt timeout, redirects refused, and every failure",
    " * mapped onto the neutral `PaymentsError` channel. Results are typed with",
    " * Distilled's declarations and are **not validated** (lenient), so a field",
    " * Distilled marks required may be absent at an older `apiVersion`.",
    " *",
    ...(operations.some((operation) => operation.path.startsWith("/v2/")) ? V2_NOTE : []),
    " * Operations require `StripeHttp`: provide `StripeHttp.layer` (with",
    " * `FetchHttpClient.layer`), `StripeHttp.layerConfig` or `StripeHttp.layerFromEnv`.",
    " *",
    ` * Generated by \`scripts/generate-resources.ts\` from \`@distilled.cloud/stripe\` ${version};`,
    " * edit `scripts/resources.ts` and regenerate rather than this file.",
    " *",
    " * @module",
    " */",
    "",
    'import type { Effect } from "effect";',
    'import * as Distilled from "@distilled.cloud/stripe/stripe";',
    'import type { PaymentsError } from "@thomasfosterau/effect-biz/Payments";',
    'import { operation } from "./internal/resource.js";',
    'import type { RequestOptions, StripeHttp } from "./StripeHttp.js";',
    "",
    "/**",
    " * The input and output types (each also its `Schema`) of this module's",
    " * operations, as `@distilled.cloud/stripe/stripe` declares them.",
    " */",
    `export { ${types.join(", ")} } from "@distilled.cloud/stripe/stripe";`,
    "",
    operations.map(renderOperation).join("\n\n"),
    "",
  ].join("\n");
};

/** A generated module the formatter refused. */
class FormatError extends Schema.TaggedError<FormatError>()("FormatError", {
  file: Schema.String,
  messages: Schema.Array(Schema.String),
}) {}

/** Every generated resource module, by its path under the package (`src/Customer.ts`), formatted. */
export const render = (
  planned: Plan,
  version: string,
): Effect.Effect<Readonly<Record<string, string>>, FormatError> =>
  Effect.map(
    Effect.forEach(
      R.toEntries(planned.modules),
      ([subpath, operations]) => {
        const file = `src/${subpath}.ts`;
        return Effect.tryPromise({
          try: () => format(file, renderModule(subpath, operations, version)),
          catch: (cause) => new FormatError({ file, messages: [String(cause)] }),
        }).pipe(
          Effect.flatMap(({ code, errors }) =>
            Arr.match(errors, {
              onEmpty: () => Effect.succeed([file, code] as const),
              onNonEmpty: (refused) =>
                Effect.fail(
                  new FormatError({ file, messages: refused.map((error) => error.message) }),
                ),
            }),
          ),
        );
      },
      { concurrency: "unbounded" },
    ),
    (files) => R.fromEntries(files),
  );
