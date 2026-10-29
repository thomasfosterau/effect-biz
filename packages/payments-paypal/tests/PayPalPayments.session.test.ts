import { describe, it, expect } from "vite-plus/test";
import * as Arr from "effect/Array";
import * as Cause from "effect/Cause";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import type { HttpClient } from "effect/http";
import { TestClock } from "effect/testing";
import * as Product from "@thomasfosterau/effect-biz/Payments.Product";
import {
  PaymentAuthenticationError,
  PaymentConfigError,
  PaymentNetworkError,
  PaymentRateLimitError,
} from "@thomasfosterau/effect-biz/Payments";
import * as PayPalPayments from "../src/PayPalPayments.ts";
import type { PayPalConfig } from "../src/PayPalPayments.ts";
import { type CapturedRequest, jsonResponse, stubFetch, toJson, withTestClock } from "./support.ts";

/**
 * The OAuth session behind `PayPalPayments.layer` / `layerFromEnv`
 * (`internal/auth.ts`): one shared, time-boxed login, the token it caches and
 * when it is forgotten, and the configuration the session accepts. Every call
 * here is a `Product.retrieve`, the lightest capability call; the wire-level
 * login, refresh and endpoint behaviour is in `PayPalPayments.wire.test.ts`.
 * These cases ran against the hand-written `PayPalClient` until effect-finance#146 removed
 * it; the session they exercise is the same.
 */

type Capabilities = Layer.Success<typeof PayPalPayments.capabilities>;

const LOGIN_PATH = "/v1/oauth2/token";
const PRODUCT = { id: "PROD-1", name: "Premium", create_time: "2026-01-01T00:00:00Z" };
const LOGIN_RESPONSE = () => jsonResponse(200, { access_token: "at_1", expires_in: 3600 });

const config = (over: Partial<PayPalConfig> = {}): PayPalConfig => ({
  clientId: "client_1",
  clientSecret: Redacted.make("secret_1"),
  ...over,
});

const isLogin = (request: CapturedRequest): boolean => request.url.pathname === LOGIN_PATH;

/** Run `effect` over `PayPalPayments.layer(config(over))` and `http`. */
const run = <A, E>(
  effect: Effect.Effect<A, E, Capabilities>,
  http: Layer.Layer<HttpClient.HttpClient>,
  over: Partial<PayPalConfig> = {},
): Effect.Effect<A, E | PaymentConfigError> =>
  effect.pipe(Effect.provide(PayPalPayments.layer(config(over))), Effect.provide(http));

/** Let pending promises (the stubbed `fetch`) settle. */
const macrotask = Effect.callback<void>((resume) => {
  const timer = setTimeout(() => resume(Effect.void), 0);
  return Effect.sync(() => clearTimeout(timer));
});

/**
 * A stubbed PayPal whose Nth login (1-based) never answers until the client
 * aborts it (`logins`) or is refused on a later macrotask (`refused`), and
 * whose resource requests answer with the product, or never (`resources`).
 * `aborted` counts the hung requests the client cancelled, `resources` the
 * `Authorization` header of each resource request.
 */
const hangingPayPal = (hung: {
  readonly logins?: ReadonlyArray<number>;
  readonly refused?: ReadonlyArray<number>;
  readonly resources?: boolean;
}) => {
  const state = { logins: 0, aborted: 0, resources: [] as Array<string | null> };
  const hang = (request: CapturedRequest) =>
    new Promise<Response>((_resolve, reject) => {
      request.init?.signal?.addEventListener("abort", () => {
        state.aborted += 1;
        reject(new Error("aborted"));
      });
    });
  const { http } = stubFetch(async (request) => {
    if (isLogin(request)) {
      state.logins += 1;
      if (hung.refused?.includes(state.logins)) {
        // Answered on a later macrotask, so concurrent callers queue behind it.
        await new Promise((resolve) => setTimeout(resolve, 0));
        return jsonResponse(401, { message: "invalid client" });
      }
      return hung.logins?.includes(state.logins) ? hang(request) : LOGIN_RESPONSE();
    }
    state.resources.push(request.headers.get("authorization"));
    return hung.resources ? hang(request) : jsonResponse(200, PRODUCT);
  });
  return { http, state };
};

const retrieve = Product.retrieve("PROD-1");

describe("PayPalPayments session: a rate-limited login", () => {
  it("fails with PaymentRateLimitError carrying Retry-After in seconds", async () => {
    const { http } = stubFetch(() =>
      jsonResponse(
        429,
        { name: "RATE_LIMIT_REACHED", message: "Slow down" },
        { "Retry-After": "9" },
      ),
    );
    const error = await Effect.runPromise(Effect.flip(run(retrieve, http)));
    expect(error).toBeInstanceOf(PaymentRateLimitError);
    expect(error).toMatchObject({ message: "Slow down", retryAfter: 9 });
  });
});

describe("PayPalPayments session: the cached token", () => {
  it("keeps a newer token when a call made with the old one gets a late 401", async () => {
    // Login 1 hands out a token that is already inside the refresh window, so
    // the next caller logs in again (login 2) while the first call is still
    // in flight. The first call's 401 then arrives late.
    let logins = 0;
    let releaseSlow!: () => void;
    const slowReleased = new Promise<void>((resolve) => {
      releaseSlow = resolve;
    });
    let markSlowStarted!: () => void;
    const slowStarted = new Promise<void>((resolve) => {
      markSlowStarted = resolve;
    });
    const { http, calls } = stubFetch(async (request) => {
      if (isLogin(request)) {
        logins += 1;
        return logins === 1
          ? jsonResponse(200, { access_token: "at_1", expires_in: 30 })
          : jsonResponse(200, { access_token: "at_2", expires_in: 3600 });
      }
      if (request.url.pathname.endsWith("/SLOW")) {
        markSlowStarted();
        await slowReleased;
        return jsonResponse(401, { message: "token revoked" });
      }
      return jsonResponse(200, PRODUCT);
    });

    await Effect.runPromise(
      run(
        Effect.gen(function* () {
          const slow = yield* Effect.forkChild(Effect.flip(Product.retrieve("SLOW")));
          yield* Effect.tryPromise(() => slowStarted);
          // Refreshes the token (login 2) while the SLOW call is in flight.
          yield* Product.retrieve("FAST");
          releaseSlow();
          const error = yield* Fiber.join(slow);
          expect(error).toBeInstanceOf(PaymentAuthenticationError);
          // The new token must survive the late 401: no third login.
          yield* Product.retrieve("FAST");
        }),
        http,
      ),
    );

    expect(logins).toBe(2);
    const authorizationOf = (suffix: string) =>
      calls
        .filter((request) => request.url.pathname.endsWith(suffix))
        .map((request) => request.headers.get("authorization"));
    expect(authorizationOf("/FAST")).toEqual(["Bearer at_2", "Bearer at_2"]);
    expect(authorizationOf("/SLOW")).toEqual(["Bearer at_1"]);
  });
});

describe("PayPalPayments session: login timeouts", () => {
  it("fails a login that never answers with a network error after the login timeout", async () => {
    const { http, state } = hangingPayPal({ logins: [1] });

    const { error, pendingBefore } = await Effect.runPromise(
      Effect.gen(function* () {
        const fiber = yield* Effect.forkChild(Effect.flip(retrieve));
        yield* macrotask;
        yield* TestClock.adjust("9 seconds");
        yield* macrotask;
        const pendingBefore = fiber.pollUnsafe() === undefined;
        yield* TestClock.adjust("1 second");
        return { error: yield* Fiber.join(fiber), pendingBefore };
      }).pipe(
        Effect.provide(PayPalPayments.layer(config({ loginTimeout: 10_000 }))),
        Effect.provide(http),
        Effect.provide(TestClock.layer()),
      ),
    );

    expect(pendingBefore).toBe(true);
    expect(error).toBeInstanceOf(PaymentNetworkError);
    expect(error.message).toBe("PayPal login timed out after 10000 ms");
    expect(state.aborted).toBe(1);
    expect(state.resources).toHaveLength(0);
  });

  it("fails every caller queued behind a hung login with its error, after one login timeout", async () => {
    const { http, state } = hangingPayPal({ logins: [1] });

    const { errors, pendingBefore, after } = await Effect.runPromise(
      Effect.gen(function* () {
        const leader = yield* Effect.forkChild(Effect.flip(retrieve));
        yield* macrotask;
        // Four more callers arrive while the login is in flight.
        const queued = yield* Effect.forEach(
          Array.from({ length: 4 }),
          () => Effect.forkChild(Effect.flip(retrieve)),
          { concurrency: 1 },
        );
        yield* macrotask;
        yield* TestClock.adjust("9 seconds");
        yield* macrotask;
        const fibers = [leader, ...queued];
        const pendingBefore = fibers.every((fiber) => fiber.pollUnsafe() === undefined);
        yield* TestClock.adjust("1 second");
        const errors = yield* Effect.forEach(fibers, Fiber.join, { concurrency: 1 });
        // A caller arriving after the failure starts a fresh login.
        const after = yield* retrieve;
        return { errors, pendingBefore, after };
      }).pipe(
        Effect.provide(PayPalPayments.layer(config({ loginTimeout: 10_000 }))),
        Effect.provide(http),
        Effect.provide(TestClock.layer()),
      ),
    );

    expect(pendingBefore).toBe(true);
    expect(errors).toHaveLength(5);
    // One login attempt, and every caller sees its very error.
    Arr.forEach(errors, (error) => expect(error).toBe(errors[0]));
    expect(errors[0]).toBeInstanceOf(PaymentNetworkError);
    expect(errors[0]?.message).toBe("PayPal login timed out after 10000 ms");
    expect(after.id).toBe("PROD-1");
    expect(state.logins).toBe(2);
    expect(state.aborted).toBe(1);
    expect(state.resources).toEqual(["Bearer at_1"]);
  });

  it("shares a refused login's error with the callers waiting on it, then retries afresh", async () => {
    const { http, state } = hangingPayPal({ refused: [1] });

    const { errors, after } = await Effect.runPromise(
      run(
        Effect.gen(function* () {
          const errors = yield* Effect.all(
            Array.from({ length: 5 }, () => Effect.flip(retrieve)),
            { concurrency: "unbounded" },
          );
          const after = yield* retrieve;
          return { errors, after };
        }),
        http,
      ),
    );

    expect(errors).toHaveLength(5);
    Arr.forEach(errors, (error) => expect(error).toBe(errors[0]));
    expect(errors[0]).toBeInstanceOf(PaymentAuthenticationError);
    expect(after.id).toBe("PROD-1");
    // One refused login for the five, then one fresh login; nothing cached on failure.
    expect(state.logins).toBe(2);
    expect(state.resources).toEqual(["Bearer at_1"]);
  });

  it("lets a waiter give up without disturbing the login it was waiting on", async () => {
    const { http, state } = hangingPayPal({ logins: [1] });

    const { leader, waiter } = await Effect.runPromise(
      Effect.gen(function* () {
        const leader = yield* Effect.forkChild(Effect.flip(retrieve));
        yield* macrotask;
        const waiter = yield* Effect.forkChild(
          Effect.flip(retrieve.pipe(Effect.timeout("2 seconds"))),
        );
        yield* macrotask;
        yield* TestClock.adjust("10 seconds");
        return { leader: yield* Fiber.join(leader), waiter: yield* Fiber.join(waiter) };
      }).pipe(
        Effect.provide(PayPalPayments.layer(config({ loginTimeout: 10_000 }))),
        Effect.provide(http),
        Effect.provide(TestClock.layer()),
      ),
    );

    expect(Cause.isTimeoutError(waiter)).toBe(true);
    expect(leader).toBeInstanceOf(PaymentNetworkError);
    expect(state.logins).toBe(1);
  });

  it("hands the login on when an outer timeout interrupts the caller running it", async () => {
    const { http, state } = hangingPayPal({ logins: [1] });

    const { first, second, third } = await Effect.runPromise(
      Effect.gen(function* () {
        // The caller gives up after 2 s, well inside the 10 s login timeout,
        // interrupting the login it is running.
        const first = yield* Effect.forkChild(
          Effect.flip(retrieve.pipe(Effect.timeout("2 seconds"))),
        );
        yield* macrotask;
        // Waiting on the leader's login when the leader is interrupted.
        const second = yield* Effect.forkChild(retrieve);
        const third = yield* Effect.forkChild(retrieve);
        yield* macrotask;
        yield* TestClock.adjust("2 seconds");
        return {
          first: yield* Fiber.join(first),
          second: yield* Fiber.join(second),
          third: yield* Fiber.join(third),
        };
      }).pipe(
        Effect.provide(PayPalPayments.layer(config({ loginTimeout: 10_000 }))),
        Effect.provide(http),
        Effect.provide(TestClock.layer()),
      ),
    );

    expect(Cause.isTimeoutError(first)).toBe(true);
    // The waiters are not stranded: one of them logs in afresh for both.
    expect(second.id).toBe("PROD-1");
    expect(third.id).toBe("PROD-1");
    expect(state.logins).toBe(2);
    expect(state.aborted).toBe(1);
  });

  it("aborts a resource request that never answers after the timeout", async () => {
    const { http, state } = hangingPayPal({ resources: true });

    const error = await Effect.runPromise(
      withTestClock(Effect.flip(run(retrieve, http, { timeout: 5_000 }))),
    );

    expect(error).toBeInstanceOf(PaymentNetworkError);
    expect(error.message).toBe("PayPal request timed out after 5000 ms");
    expect(state.aborted).toBe(1);
  });
});

describe("PayPalPayments session: configuration", () => {
  it("rejects a zero, negative or NaN timeout with a config error, and accepts Infinity", async () => {
    const invalid: ReadonlyArray<Partial<PayPalConfig>> = [
      { loginTimeout: 0 },
      { loginTimeout: -1 },
      { loginTimeout: Number.NaN },
      { timeout: 0 },
      { timeout: -5_000 },
      { timeout: Number.NEGATIVE_INFINITY },
    ];
    await Effect.runPromise(
      Effect.forEach(
        invalid,
        (over) => {
          const { http, state } = hangingPayPal({});
          return Effect.flip(run(retrieve, http, over)).pipe(
            Effect.map((error) => {
              expect(error).toBeInstanceOf(PaymentConfigError);
              expect(error.message).toMatch(
                /^PayPal (loginTimeout|timeout) must be a positive number/,
              );
              expect(state.logins).toBe(0);
            }),
          );
        },
        { concurrency: 1, discard: true },
      ),
    );
    const { http } = hangingPayPal({});
    const product = await Effect.runPromise(
      run(retrieve, http, {
        loginTimeout: Number.POSITIVE_INFINITY,
        timeout: Number.POSITIVE_INFINITY,
      }),
    );
    expect(product.id).toBe("PROD-1");
  });

  it("fails with a config error when the credentials are missing", async () => {
    const { http, calls } = stubFetch(() => jsonResponse(200, PRODUCT));
    const error = await Effect.runPromise(
      Effect.flip(run(retrieve, http, { clientId: "", clientSecret: Redacted.make("") })),
    );
    expect(error).toBeInstanceOf(PaymentConfigError);
    expect(calls).toEqual([]);
  });

  Arr.forEach(["", "   ", "api.example.test", "/v1", "ftp://example.test", "not a url"], (bad) => {
    it(`rejects the baseUrl ${toJson(bad)} with PaymentConfigError and sends nothing`, async () => {
      const { http, calls } = stubFetch(() => jsonResponse(200, PRODUCT));
      const error = await Effect.runPromise(Effect.flip(run(retrieve, http, { baseUrl: bad })));
      expect(error).toBeInstanceOf(PaymentConfigError);
      expect(error.message).toContain("baseUrl");
      expect(calls).toEqual([]);
    });
  });

  it("accepts an absolute https baseUrl and an http one (a local mock)", async () => {
    await Effect.runPromise(
      Effect.forEach(
        ["https://sandbox.example.test", "http://localhost:8080"],
        (baseUrl) => {
          const { http, calls } = stubFetch((request) =>
            isLogin(request) ? LOGIN_RESPONSE() : jsonResponse(200, PRODUCT),
          );
          return run(retrieve, http, { baseUrl }).pipe(
            Effect.map(() =>
              expect(calls.map((request) => request.url.origin)).toEqual([baseUrl, baseUrl]),
            ),
          );
        },
        { concurrency: 1, discard: true },
      ),
    );
  });

  it("keeps the clientSecret out of the config's string and JSON forms", () => {
    expect(String(config().clientSecret)).not.toContain("secret_1");
    expect(toJson(config())).not.toContain("secret_1");
  });
});

// Effect rc.118's ConfigProvider treats a literal empty string as a MISSING
// value (it was a present "" through rc.117). For the credentials that changes
// nothing observable (an empty value never authenticated); for the base URL it
// means `PAYPAL_BASE_URL=` falls back to the PAYPAL_ENV endpoint instead of
// producing an unusable request URL.
describe("PayPalPayments session: layerFromEnv", () => {
  const CREDENTIALS = { PAYPAL_CLIENT_ID: "client_env", PAYPAL_CLIENT_SECRET: "secret_env" };

  /** `Product.retrieve` over `layerFromEnv()`, reading `env`. */
  const fromEnv = (
    env: Record<string, string>,
    options: { readonly preserveEmptyStrings?: boolean } = {},
  ) => {
    const { http, calls } = stubFetch((request) =>
      isLogin(request) ? LOGIN_RESPONSE() : jsonResponse(200, PRODUCT),
    );
    const program = retrieve.pipe(
      Effect.provide(PayPalPayments.layerFromEnv()),
      Effect.provide(http),
      Effect.provide(ConfigProvider.layer(ConfigProvider.fromEnv({ env, ...options }))),
    );
    return { program, calls };
  };

  it("reads the clientSecret as a Redacted and logs in with it", async () => {
    const { program, calls } = fromEnv({ ...CREDENTIALS, PAYPAL_ENV: "live" });
    await Effect.runPromise(program);
    expect(calls.find(isLogin)?.headers.get("authorization")).toBe(
      `Basic ${btoa("client_env:secret_env")}`,
    );
  });

  it.each([
    ["the client secret is absent", { PAYPAL_CLIENT_ID: "client_env" }],
    ["the client id is empty", { ...CREDENTIALS, PAYPAL_CLIENT_ID: "" }],
    ["the client secret is empty", { ...CREDENTIALS, PAYPAL_CLIENT_SECRET: "" }],
  ] as const)("fails with PaymentConfigError, sending nothing, when %s", async (_label, values) => {
    const { program, calls } = fromEnv({ PAYPAL_ENV: "live", ...values });
    const error = await Effect.runPromise(Effect.flip(program));
    expect(error).toBeInstanceOf(PaymentConfigError);
    expect(calls).toEqual([]);
  });

  it("fails with a PaymentConfigError naming PAYPAL_ENV when it is unset, even with PAYPAL_BASE_URL", async () => {
    const { program, calls } = fromEnv({
      ...CREDENTIALS,
      PAYPAL_BASE_URL: "https://proxy.example.test",
    });
    const error = await Effect.runPromise(Effect.flip(program));
    expect(error).toBeInstanceOf(PaymentConfigError);
    expect(error.message).toContain("PAYPAL_ENV");
    expect(calls).toEqual([]);
  });

  it("fails loudly with PaymentConfigError, not the live default, when a preserving provider keeps a blank PAYPAL_BASE_URL", async () => {
    const { program, calls } = fromEnv(
      { ...CREDENTIALS, PAYPAL_ENV: "live", PAYPAL_BASE_URL: "" },
      { preserveEmptyStrings: true },
    );
    const error = await Effect.runPromise(Effect.flip(program));
    expect(error).toBeInstanceOf(PaymentConfigError);
    expect(error.message).toContain("baseUrl");
    expect(calls).toEqual([]);
  });
});
