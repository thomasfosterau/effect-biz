import { assert, describe, it, expect } from "vite-plus/test";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as R from "effect/Record";
import * as Schema from "effect/Schema";
import * as Redacted from "effect/Redacted";
import {
  PaymentInvalidRequestError,
  PaymentProviderError,
  type PaymentsError,
} from "@thomasfosterau/effect-biz/Payments";
import { installed } from "../scripts/distilled.ts";
import { type Planned, plan, readOperations } from "../scripts/resources.ts";
import { DISTILLED_API_VERSION, layer, type StripeHttp } from "../src/StripeHttp.ts";
import { type CapturedRequest, jsonResponse, stubFetch, TEST_KEY } from "./support.ts";
import * as CreditNote from "../src/CreditNote.ts";
import * as V2CoreAccount from "../src/V2.Core.Account.ts";
import * as V2CoreEvent from "../src/V2.Core.Event.ts";

/**
 * Every operation of every resource module on the wire (effect-finance#146): called with
 * placeholder ids (and empty params where it takes any) over
 * `StripeHttp.layer` and a stubbed `fetch`, it must reach its method and path
 * with the key and `Stripe-Version: DISTILLED_API_VERSION`, and resolve to
 * the body as sent. Each module's first operation must also map a Stripe
 * error and a malformed 2xx onto the neutral channel.
 */

const distilled = installed();
const { modules } = plan(readOperations(distilled.declarations, distilled.module));

/** A module's operation as its export: ids, then params, then options. */
type Exported = (
  ...args: ReadonlyArray<unknown>
) => Effect.Effect<unknown, PaymentsError, StripeHttp>;

const load = async (subpath: string): Promise<Readonly<Record<string, Exported>>> =>
  // SAFETY: every generated module exports its operations as functions of this shape.
  (await import(`../src/${subpath}.ts`)) as Readonly<Record<string, Exported>>;

/** The arguments of a call: an id per path id, `{}` for params, no options. */
const argsOf = (operation: Planned): ReadonlyArray<unknown> => [
  ...operation.ids.map((_, index) => `id_${index + 1}`),
  ...(operation.params === "none" ? [] : [{}]),
];

/** The path the call must reach, its ids substituted in order. */
const pathOf = (operation: Planned): string =>
  operation.ids.reduce(
    (path, _, index) => path.replace(/\{[^}]+\}/, `id_${index + 1}`),
    operation.path,
  );

/** Run one call over a stubbed `fetch`, never retried. */
const run = (
  call: Effect.Effect<unknown, PaymentsError, StripeHttp>,
  respond: (request: CapturedRequest) => Response,
) => {
  const { http, calls } = stubFetch(respond);
  const exit = Effect.runPromise(
    Effect.exit(
      call.pipe(
        Effect.provide(layer({ apiKey: Redacted.make(TEST_KEY), maxNetworkRetries: 0 })),
        Effect.provide(http),
      ),
    ),
  );
  return { exit, calls };
};

const BODY = { id: "obj_1", object: "stub", livemode: false };

describe.each(R.toEntries(modules))("%s", (subpath, operations) => {
  it.each(operations.map((operation) => [operation.exported, operation] as const))(
    "%s reaches its route with the pinned Stripe-Version",
    async (exported, operation) => {
      const module = await load(subpath);
      const call = module[exported];
      expect(call, `${subpath}.${exported}`).toBeTypeOf("function");
      assert.isDefined(call, `${subpath}.${exported}`);
      const { exit, calls } = run(call(...argsOf(operation)), () => jsonResponse(200, BODY));
      expect(await exit).toEqual(expect.objectContaining({ _tag: "Success", value: BODY }));
      expect(calls).toHaveLength(1);
      const [request] = calls;
      expect(request?.method).toBe(operation.method);
      expect(request?.url.origin).toBe(
        operation.upload ? "https://files.stripe.com" : "https://api.stripe.com",
      );
      expect(request?.url.pathname).toBe(pathOf(operation));
      expect(request?.headers.get("stripe-version")).toBe(DISTILLED_API_VERSION);
      expect(request?.headers.get("authorization")).toBe(`Bearer ${TEST_KEY}`);
    },
  );

  const [first] = operations;

  it(`maps a Stripe error from ${first?.exported} onto PaymentInvalidRequestError`, async () => {
    assert.isDefined(first, `${subpath} has no operation`);
    const module = await load(subpath);
    const call = module[first.exported];
    assert.isDefined(call, `${subpath}.${first.exported}`);
    const { exit } = run(call(...argsOf(first)), () =>
      jsonResponse(400, {
        error: { type: "invalid_request_error", message: "No such thing", param: "id" },
      }),
    );
    const result = await exit;
    expect(result._tag).toBe("Failure");
    const error = Exit.isFailure(result) ? result.cause.reasons[0] : undefined;
    expect(error).toMatchObject({ _tag: "Fail", error: expect.any(PaymentInvalidRequestError) });
    expect(error).toMatchObject({ error: { message: "No such thing", param: "id" } });
  });

  it(`fails a malformed 2xx from ${first?.exported} with PaymentProviderError`, async () => {
    assert.isDefined(first, `${subpath} has no operation`);
    const module = await load(subpath);
    const call = module[first.exported];
    assert.isDefined(call, `${subpath}.${first.exported}`);
    const { exit } = run(
      call(...argsOf(first)),
      () => new Response("<html>not json</html>", { status: 200 }),
    );
    const result = await exit;
    const error = Exit.isFailure(result) ? result.cause.reasons[0] : undefined;
    expect(error).toMatchObject({
      _tag: "Fail",
      error: expect.any(PaymentProviderError),
    });
    expect(error).toMatchObject({
      error: { message: "Invalid JSON received from the Stripe API", statusCode: 200 },
    });
  });
});

describe("the resources published for every remaining operation (effect-finance#154)", () => {
  it("form-encode a /v1 write (CreditNote.create)", async () => {
    const { exit, calls } = run(
      CreditNote.create({ invoice: "in_1", memo: "Goodwill", metadata: { order: "42" } }),
      () => jsonResponse(200, BODY),
    );
    expect(await exit).toEqual(expect.objectContaining({ _tag: "Success", value: BODY }));
    const [request] = calls;
    expect(request?.url.pathname).toBe("/v1/credit_notes");
    expect(request?.headers.get("content-type")).toBe("application/x-www-form-urlencoded");
    expect(R.fromEntries(new URLSearchParams(request?.body))).toEqual({
      invoice: "in_1",
      memo: "Goodwill",
      "metadata[order]": "42",
    });
  });

  it("send a /v2 write as JSON, under the pinned Stripe-Version and the caller's key", async () => {
    const { exit, calls } = run(
      V2CoreAccount.update(
        "acct_1",
        { display_name: "Jenny Rosen", metadata: { order: "42" } },
        { idempotencyKey: "account-update-1" },
      ),
      () => jsonResponse(200, BODY),
    );
    expect(await exit).toEqual(expect.objectContaining({ _tag: "Success", value: BODY }));
    const [request] = calls;
    expect(request?.method).toBe("POST");
    expect(request?.url.pathname).toBe("/v2/core/accounts/acct_1");
    expect(request?.headers.get("content-type")).toBe("application/json");
    expect(
      Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Unknown))(request?.body ?? "null"),
    ).toEqual({
      display_name: "Jenny Rosen",
      metadata: { order: "42" },
    });
    expect(request?.headers.get("stripe-version")).toBe(DISTILLED_API_VERSION);
    expect(request?.headers.get("idempotency-key")).toBe("account-update-1");
  });

  it("read a /v2 page's params from the query string (V2.Core.Event.list)", async () => {
    const page = { data: [], next_page_url: null, previous_page_url: null };
    const { exit, calls } = run(V2CoreEvent.list({ limit: 2, object_id: "acct_1" }), () =>
      jsonResponse(200, page),
    );
    expect(await exit).toEqual(expect.objectContaining({ _tag: "Success", value: page }));
    const [request] = calls;
    expect(request?.method).toBe("GET");
    expect(request?.url.pathname).toBe("/v2/core/events");
    expect(request?.url.searchParams.get("limit")).toBe("2");
    expect(request?.url.searchParams.get("object_id")).toBe("acct_1");
    expect(request?.body).toBeUndefined();
  });
});
