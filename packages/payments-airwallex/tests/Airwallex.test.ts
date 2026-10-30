import { assert, describe, it, expect } from "vite-plus/test";
import * as Arr from "effect/Array";
import * as Cause from "effect/Cause";
import * as ConfigProvider from "effect/ConfigProvider";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Predicate from "effect/Predicate";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import { TestClock } from "effect/testing";
import {
  PaymentAuthenticationError,
  PaymentConfigError,
  PaymentInvalidRequestError,
  PaymentNetworkError,
  PaymentRateLimitError,
} from "@thomasfosterau/effect-biz/Payments";
import { AirwallexClient, layerFromEnv, make, type AirwallexConfig } from "../src/Airwallex.ts";
import {
  type CapturedRequest,
  jsonResponse,
  macrotask,
  stubFetch as stubSharedFetch,
} from "../../../tests/stubs.ts";

const LOGIN_PATH = "/api/v1/authentication/login";

/** An ISO-8601 timestamp `milliseconds` from now, as a login response's `expires_at`. */
const isoIn = (milliseconds: number): string =>
  DateTime.formatIso(DateTime.add(DateTime.nowUnsafe(), { milliseconds }));

/** `JSON.stringify` through `Schema`. */
const toJsonText = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

/** `JSON.parse` through `Schema`. */
const fromJsonText = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Unknown));
const LOGIN_RESPONSE = () =>
  jsonResponse(201, {
    token: "tok_123",
    expires_at: isoIn(30 * 60 * 1000),
  });

/**
 * A stub `fetch` that answers the LOGIN_PATH handshake then delegates to
 * `handler`, served to the client as `effect/http`'s `HttpClient`. No test
 * here reaches the vendor.
 */
const stubFetch = (handler: (request: CapturedRequest) => Response) =>
  stubSharedFetch((request) =>
    request.url.href.endsWith(LOGIN_PATH) ? LOGIN_RESPONSE() : handler(request),
  );

const config = (over: Partial<AirwallexConfig>): AirwallexConfig => ({
  clientId: "client_1",
  apiKey: Redacted.make("key_1"),
  ...over,
});

/**
 * Every string reachable from `value` through its own properties, enumerable
 * or not — what a logger that walks the object could print.
 */
const stringsIn = (value: unknown, seen = new WeakSet<object>()): Array<string> => {
  if (Predicate.isString(value)) return [value];
  if (!Predicate.isObject(value) || seen.has(value)) return [];
  seen.add(value);
  return Object.getOwnPropertyNames(value).flatMap((key) =>
    stringsIn(Object.getOwnPropertyDescriptor(value, key)?.value, seen),
  );
};

describe("Airwallex client", () => {
  it("logs in once, caches the token, and authorizes requests", async () => {
    const { http, calls } = stubFetch(() => jsonResponse(200, { id: "cus_1", email: "a@b.com" }));

    const program = Effect.fn("program")(function* () {
      const client = yield* make(config({}));
      const first = yield* client.request({
        method: "GET",
        path: "/api/v1/pa/customers/cus_1",
      });
      const second = yield* client.request({
        method: "GET",
        path: "/api/v1/pa/customers/cus_1",
      });
      return { first, second };
    });

    const result = await Effect.runPromise(program().pipe(Effect.provide(http)));
    expect(result.first).toMatchObject({ id: "cus_1" });

    // One login + two resource requests, and the token only fetched once.
    const logins = calls.filter((c) => c.url.href.endsWith(LOGIN_PATH));
    expect(logins).toHaveLength(1);
    const resourceCall = calls.find((c) => c.url.href.includes("/pa/customers"));
    assert.isDefined(resourceCall);
    expect(resourceCall.headers.get("authorization")).toBe("Bearer tok_123");
  });

  it("sends client credentials on the login request", async () => {
    const { http, calls } = stubFetch(() => jsonResponse(200, { items: [], has_more: false }));

    await Effect.runPromise(
      Effect.gen(function* () {
        const client = yield* make(config({}));
        yield* client.request({ method: "GET", path: "/api/v1/pa/customers" });
      }).pipe(Effect.provide(http)),
    );

    const login = calls.find((c) => c.url.href.endsWith(LOGIN_PATH));
    assert.isDefined(login);
    expect(login.method).toBe("POST");
    expect(login.headers.get("x-client-id")).toBe("client_1");
    expect(login.headers.get("x-api-key")).toBe("key_1");
  });

  it("maps an HTTP 401 to a neutral authentication error", async () => {
    const { http } = stubFetch(() =>
      jsonResponse(401, { code: "unauthorized", message: "invalid token" }),
    );

    const error = await Effect.runPromise(
      Effect.gen(function* () {
        const client = yield* make(config({}));
        return yield* client.request({
          method: "GET",
          path: "/api/v1/pa/customers/cus_1",
        });
      }).pipe(Effect.flip, Effect.provide(http)),
    );

    expect(error).toBeInstanceOf(PaymentAuthenticationError);
    expect(error.message).toBe("invalid token");
  });

  it("maps an HTTP 429 to a rate limit carrying Retry-After in seconds", async () => {
    const request = (retryAfter: Record<string, string>) => {
      const { http } = stubFetch(() =>
        jsonResponse(429, { code: "too_many_requests", message: "slow down" }, retryAfter),
      );
      return Effect.runPromise(
        Effect.gen(function* () {
          const client = yield* make(config({}));
          return yield* client.request({ method: "GET", path: "/api/v1/pa/customers/cus_1" });
        }).pipe(Effect.flip, Effect.provide(http)),
      );
    };

    const error = await request({ "Retry-After": "12" });
    expect(error).toBeInstanceOf(PaymentRateLimitError);
    expect(error).toMatchObject({ message: "slow down", retryAfter: 12 });
    expect(await request({})).toMatchObject({ retryAfter: undefined });
  });

  it("fails with a config error when credentials are missing", async () => {
    const { http } = stubFetch(() => jsonResponse(200, {}));
    const error = await Effect.runPromise(
      make(config({ clientId: "", apiKey: Redacted.make("") })).pipe(
        Effect.flip,
        Effect.provide(http),
      ),
    );
    expect(error).toBeInstanceOf(PaymentConfigError);
  });
  it("sends Content-Type: application/json on a bodyless POST", async () => {
    const { http, calls } = stubFetch(() => new Response(null, { status: 204 }));

    await Effect.runPromise(
      Effect.gen(function* () {
        const client = yield* make(config({}));
        yield* client.request({ method: "POST", path: "/api/v1/pa/payment_intents/int_1/cancel" });
      }).pipe(Effect.provide(http)),
    );

    const post = calls.find((c) => c.url.href.endsWith("/api/v1/pa/payment_intents/int_1/cancel"));
    assert.isDefined(post);
    expect(post.method).toBe("POST");
    expect(post.body).toBeUndefined();
    expect(post.headers.get("content-type")).toBe("application/json");
  });

  it("logs in once for concurrent first requests", async () => {
    const { http, calls } = stubFetch(() => jsonResponse(200, { id: "x" }));

    await Effect.runPromise(
      Effect.gen(function* () {
        const client = yield* make(config({}));
        yield* Effect.all(
          Array.from({ length: 5 }, () =>
            client.request({ method: "GET", path: "/api/v1/pa/customers/cus_1" }),
          ),
          { concurrency: "unbounded" },
        );
      }).pipe(Effect.provide(http)),
    );

    expect(calls.filter((c) => c.url.href.endsWith(LOGIN_PATH))).toHaveLength(1);
    expect(calls.filter((c) => c.url.href.endsWith("/api/v1/pa/customers/cus_1"))).toHaveLength(5);
  });

  it("forgets the cached token after a 401 and logs in again on the next call", async () => {
    let resourceCalls = 0;
    const { http, calls } = stubFetch(() => {
      resourceCalls += 1;
      return resourceCalls === 1
        ? jsonResponse(401, { message: "token revoked" })
        : jsonResponse(200, { id: "x" });
    });

    const second = await Effect.runPromise(
      Effect.gen(function* () {
        const client = yield* make(config({}));
        const first = yield* Effect.flip(
          client.request({ method: "GET", path: "/api/v1/pa/customers/cus_1" }),
        );
        expect(first).toBeInstanceOf(PaymentAuthenticationError);
        return yield* client.request({
          method: "GET",
          path: "/api/v1/pa/customers/cus_1",
        });
      }).pipe(Effect.provide(http)),
    );

    expect(second).toMatchObject({ id: "x" });
    expect(calls.filter((c) => c.url.href.endsWith(LOGIN_PATH))).toHaveLength(2);
  });
  it("keeps a newer token when a request made with the old one gets a late 401", async () => {
    // Login 1 hands out a token that is already inside the refresh window, so
    // the next caller logs in again (login 2) while the first request is
    // still in flight. The first request's 401 then arrives late.
    let logins = 0;
    let releaseSlow!: () => void;
    const slowReleased = new Promise<void>((resolve) => {
      releaseSlow = resolve;
    });
    let markSlowStarted!: () => void;
    const slowStarted = new Promise<void>((resolve) => {
      markSlowStarted = resolve;
    });
    const seen: Array<{ url: string; authorization: string | null }> = [];
    const { http } = stubSharedFetch(async (request) => {
      const url = request.url.href;
      const authorization = request.headers.get("authorization");
      seen.push({ url, authorization });
      if (url.endsWith("/api/v1/authentication/login")) {
        logins += 1;
        return logins === 1
          ? jsonResponse(200, {
              token: "tok_1",
              expires_at: isoIn(30_000),
            })
          : jsonResponse(200, {
              token: "tok_2",
              expires_at: isoIn(3_600_000),
            });
      }
      if (url.endsWith("/api/v1/pa/customers/SLOW")) {
        markSlowStarted();
        await slowReleased;
        return jsonResponse(401, { message: "token revoked" });
      }
      return jsonResponse(200, { id: "x" });
    });

    await Effect.runPromise(
      Effect.gen(function* () {
        const client = yield* make(config({}));
        const slow = yield* Effect.forkChild(
          Effect.flip(client.request({ method: "GET", path: "/api/v1/pa/customers/SLOW" })),
        );
        yield* Effect.tryPromise(() => slowStarted);
        // Refreshes the token (login 2) while the T1 request is in flight.
        yield* client.request({ method: "GET", path: "/api/v1/pa/customers/FAST" });
        releaseSlow();
        const error = yield* Fiber.join(slow);
        expect(error).toBeInstanceOf(PaymentAuthenticationError);
        // T2 must survive T1's late 401: no third login, and T2 is sent.
        yield* client.request({ method: "GET", path: "/api/v1/pa/customers/FAST" });
      }).pipe(Effect.provide(http)),
    );

    expect(logins).toBe(2);
    const fast = seen.filter((c) => c.url.endsWith("/api/v1/pa/customers/FAST"));
    expect(fast.map((c) => c.authorization)).toEqual(["Bearer tok_2", "Bearer tok_2"]);
    const slow = seen.find((c) => c.url.endsWith("/api/v1/pa/customers/SLOW"));
    assert.isDefined(slow);
    expect(slow.authorization).toBe("Bearer tok_1");
  });
});

/**
 * A stub `fetch` whose Nth login (1-based, listed in `hung`) never answers
 * until the client aborts it; every other call answers normally. `aborted`
 * counts the hung requests the client cancelled.
 */
const hangingFetch = (hung: {
  logins?: ReadonlyArray<number>;
  refused?: ReadonlyArray<number>;
  resources?: boolean;
}) => {
  const resources: Array<string | null> = [];
  const state = { logins: 0, aborted: 0, resources };
  const hang = (init: RequestInit | undefined) =>
    new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => {
        state.aborted += 1;
        reject(new Error("aborted"));
      });
    });
  const { http } = stubSharedFetch(async ({ url, init }) => {
    if (url.href.endsWith(LOGIN_PATH)) {
      state.logins += 1;
      if (hung.refused?.includes(state.logins)) {
        // Answered on a later macrotask, so concurrent callers queue behind it.
        await new Promise((resolve) => setTimeout(resolve, 0));
        return jsonResponse(401, { message: "invalid client" });
      }
      return hung.logins?.includes(state.logins) ? hang(init) : LOGIN_RESPONSE();
    }
    state.resources.push(new Headers(init?.headers).get("authorization"));
    return hung.resources ? hang(init) : jsonResponse(200, { id: "x" });
  });
  return { http, state };
};

describe("Airwallex client timeouts", () => {
  const get = { method: "GET", path: "/api/v1/pa/customers/cus_1" } as const;

  it("fails a login that never answers with a network error after the login timeout", async () => {
    const { http, state } = hangingFetch({ logins: [1] });

    const { error, pendingBefore } = await Effect.runPromise(
      Effect.gen(function* () {
        const client = yield* make(config({ loginTimeout: 10_000 }));
        const fiber = yield* Effect.forkChild(Effect.flip(client.request(get)));
        yield* macrotask;
        yield* TestClock.adjust("9 seconds");
        yield* macrotask;
        const pendingBefore = fiber.pollUnsafe() === undefined;
        yield* TestClock.adjust("1 second");
        return { error: yield* Fiber.join(fiber), pendingBefore };
      }).pipe(Effect.provide(http), Effect.provide(TestClock.layer())),
    );

    expect(pendingBefore).toBe(true);
    expect(error).toBeInstanceOf(PaymentNetworkError);
    expect(error.message).toBe("Airwallex login timed out after 10000 ms");
    expect(state.aborted).toBe(1);
    expect(state.resources).toHaveLength(0);
  });

  it("fails every caller queued behind a hung login with its error, after one login timeout", async () => {
    const { http, state } = hangingFetch({ logins: [1] });

    const { errors, pendingBefore, after } = await Effect.runPromise(
      Effect.gen(function* () {
        const client = yield* make(config({ loginTimeout: 10_000 }));
        const leader = yield* Effect.forkChild(Effect.flip(client.request(get)));
        yield* macrotask;
        // Four more callers arrive while the login is in flight.
        const queued = yield* Effect.forEach(Array.from({ length: 4 }), () =>
          Effect.forkChild(Effect.flip(client.request(get))),
        );
        yield* macrotask;
        yield* TestClock.adjust("9 seconds");
        yield* macrotask;
        const fibers = [leader, ...queued];
        const pendingBefore = fibers.every((fiber) => fiber.pollUnsafe() === undefined);
        yield* TestClock.adjust("1 second");
        const errors = yield* Effect.forEach(fibers, Fiber.join);
        // A caller arriving after the failure starts a fresh login.
        const after = yield* client.request(get);
        return { errors, pendingBefore, after };
      }).pipe(Effect.provide(http), Effect.provide(TestClock.layer())),
    );

    expect(pendingBefore).toBe(true);
    expect(errors).toHaveLength(5);
    // One login attempt, and every caller sees its very error.
    Arr.forEach(errors, (error) => expect(error).toBe(errors[0]));
    expect(errors[0]).toBeInstanceOf(PaymentNetworkError);
    expect(errors[0]?.message).toBe("Airwallex login timed out after 10000 ms");
    expect(after).toMatchObject({ id: "x" });
    expect(state.logins).toBe(2);
    expect(state.aborted).toBe(1);
    expect(state.resources).toEqual(["Bearer tok_123"]);
  });

  it("shares a refused login's error with the callers waiting on it, then retries afresh", async () => {
    const { http, state } = hangingFetch({ refused: [1] });

    const { errors, after } = await Effect.runPromise(
      Effect.gen(function* () {
        const client = yield* make(config({}));
        const errors = yield* Effect.all(
          Array.from({ length: 5 }, () => Effect.flip(client.request(get))),
          { concurrency: "unbounded" },
        );
        const after = yield* client.request(get);
        return { errors, after };
      }).pipe(Effect.provide(http)),
    );

    expect(errors).toHaveLength(5);
    Arr.forEach(errors, (error) => expect(error).toBe(errors[0]));
    expect(errors[0]).toBeInstanceOf(PaymentAuthenticationError);
    expect(after).toMatchObject({ id: "x" });
    // One refused login for the five, then one fresh login; nothing cached on failure.
    expect(state.logins).toBe(2);
    expect(state.resources).toEqual(["Bearer tok_123"]);
  });

  it("lets a waiter give up without disturbing the login it was waiting on", async () => {
    const { http, state } = hangingFetch({ logins: [1] });

    const { leader, waiter } = await Effect.runPromise(
      Effect.gen(function* () {
        const client = yield* make(config({ loginTimeout: 10_000 }));
        const leader = yield* Effect.forkChild(Effect.flip(client.request(get)));
        yield* macrotask;
        const waiter = yield* Effect.forkChild(
          Effect.flip(client.request(get).pipe(Effect.timeout("2 seconds"))),
        );
        yield* macrotask;
        yield* TestClock.adjust("10 seconds");
        return { leader: yield* Fiber.join(leader), waiter: yield* Fiber.join(waiter) };
      }).pipe(Effect.provide(http), Effect.provide(TestClock.layer())),
    );

    expect(Cause.isTimeoutError(waiter)).toBe(true);
    expect(leader).toBeInstanceOf(PaymentNetworkError);
    expect(state.logins).toBe(1);
  });

  it("hands the login on when an outer timeout interrupts the caller running it", async () => {
    const { http, state } = hangingFetch({ logins: [1] });

    const { first, second, third } = await Effect.runPromise(
      Effect.gen(function* () {
        const client = yield* make(config({ loginTimeout: 10_000 }));
        // The caller gives up after 2 s, well inside the 10 s login timeout,
        // interrupting the login it is running.
        const first = yield* Effect.forkChild(
          Effect.flip(client.request(get).pipe(Effect.timeout("2 seconds"))),
        );
        yield* macrotask;
        // Waiting on the leader's login when the leader is interrupted.
        const second = yield* Effect.forkChild(client.request(get));
        const third = yield* Effect.forkChild(client.request(get));
        yield* macrotask;
        yield* TestClock.adjust("2 seconds");
        return {
          first: yield* Fiber.join(first),
          second: yield* Fiber.join(second),
          third: yield* Fiber.join(third),
        };
      }).pipe(Effect.provide(http), Effect.provide(TestClock.layer())),
    );

    expect(Cause.isTimeoutError(first)).toBe(true);
    // The waiters are not stranded: one of them logs in afresh for both.
    expect(second).toMatchObject({ id: "x" });
    expect(third).toMatchObject({ id: "x" });
    expect(state.logins).toBe(2);
    expect(state.aborted).toBe(1);
  });

  it("rejects a zero, negative or NaN timeout with a config error, and accepts Infinity", async () => {
    const { http } = hangingFetch({});
    const invalid: ReadonlyArray<Partial<AirwallexConfig>> = [
      { loginTimeout: 0 },
      { loginTimeout: -1 },
      { loginTimeout: Number.NaN },
      { timeout: 0 },
      { timeout: -5_000 },
      { timeout: Number.NEGATIVE_INFINITY },
    ];
    const errors = await Effect.runPromise(
      Effect.forEach(
        invalid,
        (over) => make(config(over)).pipe(Effect.flip, Effect.provide(http)),
        { concurrency: 1 },
      ),
    );
    Arr.forEach(errors, (error) => {
      expect(error).toBeInstanceOf(PaymentConfigError);
      expect(error.message).toMatch(/^Airwallex (loginTimeout|timeout) must be a positive number/);
    });
    const result = await Effect.runPromise(
      Effect.flatMap(
        make(config({ loginTimeout: Number.POSITIVE_INFINITY, timeout: Number.POSITIVE_INFINITY })),
        (client) => client.request(get),
      ).pipe(Effect.provide(http)),
    );
    expect(result).toMatchObject({ id: "x" });
  });

  it("fails a resource request that never answers with a network error after the timeout", async () => {
    const { http, state } = hangingFetch({ resources: true });

    const error = await Effect.runPromise(
      Effect.gen(function* () {
        const client = yield* make(config({ timeout: 5_000 }));
        const fiber = yield* Effect.forkChild(Effect.flip(client.request(get)));
        yield* macrotask;
        yield* macrotask;
        yield* TestClock.adjust("5 seconds");
        return yield* Fiber.join(fiber);
      }).pipe(Effect.provide(http), Effect.provide(TestClock.layer())),
    );

    expect(error).toBeInstanceOf(PaymentNetworkError);
    expect(error.message).toBe("Airwallex request timed out after 5000 ms");
    expect(state.aborted).toBe(1);
  });
});

describe("Airwallex client secrets", () => {
  const SECRET = "key_1";
  const get = { method: "GET", path: "/api/v1/pa/customers/cus_1" } as const;

  it("reads the apiKey from configuration as a Redacted", async () => {
    const { http, calls } = stubFetch(() => jsonResponse(200, { id: "x" }));
    await Effect.runPromise(
      Effect.flatMap(AirwallexClient, (client) => client.request(get)).pipe(
        Effect.provide(layerFromEnv()),
        Effect.provide(http),
        Effect.provide(
          ConfigProvider.layer(
            ConfigProvider.fromUnknown({
              AIRWALLEX_CLIENT_ID: "client_env",
              AIRWALLEX_API_KEY: "secret_env",
              AIRWALLEX_ENV: "live",
            }),
          ),
        ),
      ),
    );
    const login = calls.find((c) => c.url.href.endsWith(LOGIN_PATH));
    assert.isDefined(login);
    expect(login.headers.get("x-client-id")).toBe("client_env");
    expect(login.headers.get("x-api-key")).toBe("secret_env");
  });

  it("fails with PaymentConfigError when the apiKey variable is absent", async () => {
    const { http } = stubFetch(() => jsonResponse(200, {}));
    const error = await Effect.runPromise(
      Effect.flip(
        Layer.build(layerFromEnv()).pipe(
          Effect.scoped,
          Effect.provide(http),
          Effect.provide(
            ConfigProvider.layer(
              ConfigProvider.fromUnknown({
                AIRWALLEX_CLIENT_ID: "client_env",
                AIRWALLEX_ENV: "live",
              }),
            ),
          ),
        ),
      ),
    );
    expect(error).toBeInstanceOf(PaymentConfigError);
  });

  it("keeps the apiKey out of the config's string and JSON forms", () => {
    const { apiKey } = config({});
    // Through `unknown`: the stringification a consumer's logger applies.
    const asText = (value: unknown): string => String(value);
    expect(asText(apiKey)).not.toContain(SECRET);
    expect(toJsonText(config({}))).not.toContain(SECRET);
  });

  it("never carries the apiKey in an error", async () => {
    const answers: ReadonlyArray<() => Response> = [
      () => jsonResponse(401, { code: "credentials_invalid", message: "Invalid credentials" }),
      () => {
        throw new TypeError("fetch failed");
      },
      () => jsonResponse(201, { token: 42 }),
      () => jsonResponse(201, { token: "tok_leak", expires_at: 5 }),
    ];
    const errors = await Effect.runPromise(
      Effect.forEach(
        answers,
        (answer) => {
          const { http } = stubSharedFetch(answer);
          return Effect.flatMap(make(config({})), (client) =>
            Effect.flip(client.request(get)),
          ).pipe(Effect.provide(http));
        },
        { concurrency: 1 },
      ),
    );
    Arr.forEach(errors, (error) => {
      // The request (whose headers carry the credentials) is never kept.
      expect(Predicate.hasProperty(error.cause, "request")).toBe(false);
      Arr.forEach([SECRET, "tok_leak"], (leak) => {
        expect(toJsonText(error)).not.toContain(leak);
        expect(String(error)).not.toContain(leak);
        // Anywhere in the error's object graph, not just its serialised forms.
        expect(stringsIn(error).filter((text) => text.includes(leak))).toEqual([]);
        expect(toJsonText(error.cause ?? null)).not.toContain(leak);
      });
    });
  });
});

describe("Airwallex client requestId (request_id)", () => {
  const create = {
    method: "POST",
    path: "/api/v1/pa/customers/create",
    body: { request_id: "fresh-per-call", email: "a@b.com" },
  } as const;
  const bodyOf = (call: CapturedRequest | undefined) => fromJsonText(call?.body ?? "null");

  it("writes the requestId into the body, replacing the layer's request_id", async () => {
    const { http, calls } = stubFetch(() => jsonResponse(201, { id: "cus_1" }));
    await Effect.runPromise(
      Effect.flatMap(make(config({})), (client) =>
        client.request({ ...create, requestId: "signup-7" }),
      ).pipe(Effect.provide(http)),
    );
    const post = calls.find((c) => c.url.href.endsWith("/customers/create"));
    assert.isDefined(post);
    expect(bodyOf(post)).toEqual({ request_id: "signup-7", email: "a@b.com" });
  });

  it("creates a body when the POST had none", async () => {
    const { http, calls } = stubFetch(() => jsonResponse(200, { id: "pi_1" }));
    await Effect.runPromise(
      Effect.flatMap(make(config({})), (client) =>
        client.request({
          method: "POST",
          path: "/api/v1/pa/payment_intents/pi_1/cancel",
          requestId: "c-1",
        }),
      ).pipe(Effect.provide(http)),
    );
    expect(bodyOf(calls.find((c) => c.url.href.endsWith("/cancel")))).toEqual({
      request_id: "c-1",
    });
  });

  it("leaves the body as it was without a requestId", async () => {
    const { http, calls } = stubFetch(() => jsonResponse(201, { id: "cus_1" }));
    await Effect.runPromise(
      Effect.flatMap(make(config({})), (client) => client.request(create)).pipe(
        Effect.provide(http),
      ),
    );
    expect(bodyOf(calls.find((c) => c.url.href.endsWith("/customers/create")))).toEqual(
      create.body,
    );
  });

  it("sends the same request_id when the caller retries a write that failed in flight", async () => {
    let attempts = 0;
    const { http, calls } = stubFetch(() => {
      attempts += 1;
      if (attempts === 1) throw new TypeError("fetch failed");
      return jsonResponse(201, { id: "cus_1" });
    });
    const outcome = await Effect.runPromise(
      Effect.gen(function* () {
        const client = yield* make(config({}));
        const write = client.request({ ...create, requestId: "signup-8" });
        const first = yield* Effect.flip(write);
        const second = yield* write;
        return { first, second };
      }).pipe(Effect.provide(http)),
    );
    expect(outcome.first).toBeInstanceOf(PaymentNetworkError);
    expect(outcome.second).toMatchObject({ id: "cus_1" });
    const posts = calls.filter((c) => c.url.href.endsWith("/customers/create"));
    expect(posts.map((c) => bodyOf(c))).toMatchObject([
      { request_id: "signup-8" },
      { request_id: "signup-8" },
    ]);
  });

  it("refuses an empty id, a non-POST, or a non-object body, before sending anything", async () => {
    const { http, calls } = stubFetch(() => jsonResponse(200, {}));
    const errors = await Effect.runPromise(
      Effect.gen(function* () {
        const client = yield* make(config({}));
        return yield* Effect.all([
          Effect.flip(client.request({ ...create, requestId: "" })),
          Effect.flip(client.request({ method: "GET", path: "/api/v1/x", requestId: "r" })),
          Effect.flip(client.request({ ...create, body: [1], requestId: "r" })),
          Effect.flip(client.request({ ...create, body: "text", requestId: "r" })),
        ]);
      }).pipe(Effect.provide(http)),
    );
    Arr.forEach(errors, (error) => expect(error).toBeInstanceOf(PaymentInvalidRequestError));
    expect(calls).toEqual([]);
  });
});

// Effect rc.118's ConfigProvider treats a literal empty string as a MISSING
// value (it was a present "" through rc.117). For the credentials that changes
// nothing observable (an empty value never authenticated); for the base URL it
// means `AIRWALLEX_BASE_URL=` falls back to the default endpoint instead of
// producing an unusable request URL.
describe("Airwallex layerFromEnv and empty variables", () => {
  const build = (
    values: Record<string, string>,
    options: { readonly preserveEmptyStrings?: boolean } = {},
  ) => {
    const { http, calls } = stubFetch(() => jsonResponse(200, { id: "x" }));
    const program = Effect.flatMap(AirwallexClient, (client) =>
      client.request({ method: "GET", path: "/probe" }),
    ).pipe(
      Effect.provide(layerFromEnv()),
      Effect.provide(http),
      Effect.provide(
        ConfigProvider.layer(
          ConfigProvider.fromEnv({ env: { AIRWALLEX_ENV: "live", ...values }, ...options }),
        ),
      ),
    );
    return { program, calls };
  };

  it("fails with PaymentConfigError when the client id variable is empty", async () => {
    const { program, calls } = build({ AIRWALLEX_CLIENT_ID: "", AIRWALLEX_API_KEY: "secret_env" });
    const error = await Effect.runPromise(Effect.flip(program));
    expect(error).toBeInstanceOf(PaymentConfigError);
    expect(calls).toHaveLength(0);
  });

  it("fails with PaymentConfigError when the api key variable is empty", async () => {
    const { program, calls } = build({ AIRWALLEX_CLIENT_ID: "client_env", AIRWALLEX_API_KEY: "" });
    const error = await Effect.runPromise(Effect.flip(program));
    expect(error).toBeInstanceOf(PaymentConfigError);
    expect(calls).toHaveLength(0);
  });

  it("uses the AIRWALLEX_ENV endpoint when AIRWALLEX_BASE_URL is empty", async () => {
    const { program, calls } = build({
      AIRWALLEX_CLIENT_ID: "client_env",
      AIRWALLEX_API_KEY: "secret_env",
      AIRWALLEX_BASE_URL: "",
    });
    await Effect.runPromise(program);
    expect(calls[0]?.url.href).toBe(`https://api.airwallex.com${LOGIN_PATH}`);
  });

  it("still honours a non-empty AIRWALLEX_BASE_URL", async () => {
    const { program, calls } = build({
      AIRWALLEX_CLIENT_ID: "client_env",
      AIRWALLEX_API_KEY: "secret_env",
      AIRWALLEX_BASE_URL: "https://sandbox.example.test",
    });
    await Effect.runPromise(program);
    expect(calls[0]?.url.href).toBe(`https://sandbox.example.test${LOGIN_PATH}`);
  });

  it("fails loudly with PaymentConfigError, not the live default, when a preserving provider keeps a blank AIRWALLEX_BASE_URL", async () => {
    const { program, calls } = build(
      {
        AIRWALLEX_CLIENT_ID: "client_env",
        AIRWALLEX_API_KEY: "secret_env",
        AIRWALLEX_BASE_URL: "",
      },
      { preserveEmptyStrings: true },
    );
    const error = await Effect.runPromise(Effect.flip(program));
    expect(error).toBeInstanceOf(PaymentConfigError);
    expect(error.message).toContain("baseUrl");
    expect(calls).toHaveLength(0);
  });
});

// effect-finance#90: AIRWALLEX_ENV is required and selects the endpoint; AIRWALLEX_BASE_URL,
// when set, still wins.
describe("Airwallex AIRWALLEX_ENV", () => {
  const CREDENTIALS = { AIRWALLEX_CLIENT_ID: "client_env", AIRWALLEX_API_KEY: "secret_env" };
  const build = (values: Record<string, string>) => {
    const { http, calls } = stubFetch(() => jsonResponse(200, { id: "x" }));
    const program = Effect.flatMap(AirwallexClient, (client) =>
      client.request({ method: "GET", path: "/probe" }),
    ).pipe(
      Effect.provide(layerFromEnv()),
      Effect.provide(http),
      Effect.provide(ConfigProvider.layer(ConfigProvider.fromEnv({ env: values }))),
    );
    return { program, calls };
  };

  it.each([
    ["live", "https://api.airwallex.com"],
    ["sandbox", "https://api.sandbox.airwallex.com"],
  ] as const)("sends %s requests to %s", async (environment, host) => {
    const { program, calls } = build({ ...CREDENTIALS, AIRWALLEX_ENV: environment });
    await Effect.runPromise(program);
    expect(calls.map((call) => call.url.href)).toEqual([`${host}${LOGIN_PATH}`, `${host}/probe`]);
  });

  it.each([
    ["is unset", CREDENTIALS],
    ["is empty", { ...CREDENTIALS, AIRWALLEX_ENV: "" }],
    ["is not live or sandbox", { ...CREDENTIALS, AIRWALLEX_ENV: "production" }],
    [
      "is unset, even with AIRWALLEX_BASE_URL",
      { ...CREDENTIALS, AIRWALLEX_BASE_URL: "https://proxy.example.test" },
    ],
  ] as const)(
    "fails with a PaymentConfigError naming AIRWALLEX_ENV when it %s",
    async (_label, values) => {
      const { program, calls } = build(values);
      const error = await Effect.runPromise(Effect.flip(program));
      expect(error).toBeInstanceOf(PaymentConfigError);
      expect(error.message).toContain("AIRWALLEX_ENV");
      expect(calls).toHaveLength(0);
    },
  );

  it("lets AIRWALLEX_BASE_URL override the AIRWALLEX_ENV endpoint", async () => {
    const { program, calls } = build({
      ...CREDENTIALS,
      AIRWALLEX_ENV: "sandbox",
      AIRWALLEX_BASE_URL: "https://proxy.example.test",
    });
    await Effect.runPromise(program);
    expect(calls[0]?.url.href).toBe(`https://proxy.example.test${LOGIN_PATH}`);
  });

  it("maps make's environment option, live by default, with baseUrl winning", async () => {
    const loginUrl = async (over: Partial<AirwallexConfig>) => {
      const { http, calls } = stubFetch(() => jsonResponse(200, { id: "x" }));
      await Effect.runPromise(
        make(config(over)).pipe(
          Effect.flatMap((client) => client.request({ method: "GET", path: "/probe" })),
          Effect.provide(http),
        ),
      );
      return calls[0]?.url.href;
    };
    expect(await loginUrl({})).toBe(`https://api.airwallex.com${LOGIN_PATH}`);
    expect(await loginUrl({ environment: "live" })).toBe(`https://api.airwallex.com${LOGIN_PATH}`);
    expect(await loginUrl({ environment: "sandbox" })).toBe(
      `https://api.sandbox.airwallex.com${LOGIN_PATH}`,
    );
    expect(await loginUrl({ environment: "sandbox", baseUrl: "https://proxy.example.test" })).toBe(
      `https://proxy.example.test${LOGIN_PATH}`,
    );
  });
});

describe("Airwallex make validates baseUrl", () => {
  const attempt = (baseUrl: string) => {
    const { http, calls } = stubFetch(() => jsonResponse(200, { id: "x" }));
    const program = make(config({ baseUrl })).pipe(Effect.provide(http));
    return { program, calls };
  };

  Arr.forEach(["", "   ", "api.example.test", "/v1", "ftp://example.test", "not a url"], (bad) => {
    it(`rejects ${toJsonText(bad)} with PaymentConfigError and sends nothing`, async () => {
      const { program, calls } = attempt(bad);
      const error = await Effect.runPromise(Effect.flip(program));
      expect(error).toBeInstanceOf(PaymentConfigError);
      expect(error.message).toContain("baseUrl");
      expect(calls).toHaveLength(0);
    });
  });

  it("accepts an absolute https URL and an http one (a local mock)", async () => {
    await expect(
      Effect.runPromise(
        Effect.forEach(
          ["https://sandbox.example.test", "http://localhost:8080"],
          (ok) => attempt(ok).program,
          { concurrency: 1, discard: true },
        ),
      ),
    ).resolves.toBeUndefined();
  });
});
