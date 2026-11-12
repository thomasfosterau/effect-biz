import { assert, describe, expect } from "vite-plus/test";
import { it, layer } from "@effect/vitest";
import * as Arr from "effect/Array";
import * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as HashSet from "effect/HashSet";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Struct from "effect/Struct";
import { FetchHttpClient, HttpClient, HttpClientError, HttpClientRequest } from "effect/http";
import { TestClock } from "effect/testing";
import {
  PaymentAuthenticationError,
  PaymentConfigError,
  PaymentInvalidRequestError,
  PaymentNetworkError,
  PaymentProviderError,
  PaymentRateLimitError,
} from "../src/Payments.PaymentsError.ts";
import {
  checkId,
  checkMinorUnits,
  decimalText,
  epochSecondsOf,
  errorFromStatus,
  exponentFrom,
  formatDecimal,
  isAbsoluteHttpUrl,
  isOk,
  networkError,
  observeResponses,
  omitUndefined,
  pageNumberedList,
  parseDecimal,
  rejectedError,
  responseDecoder,
  scaleToMinor,
  send,
  shareLogin,
  stringField,
  timedOut,
  timeoutOf,
  tokenCache,
} from "../src/Payments.internal.ts";
import {
  jsonResponse,
  reachableFrom,
  stubFetch,
  throwing,
  withTestClock,
} from "../../../tests/stubs.ts";

class LoginFailed extends Schema.TaggedError<LoginFailed, { readonly brand: unique symbol }>()(
  "LoginFailed",
  {
    attempt: Schema.Finite,
  },
) {}

const ok = (token: string) => () => Exit.succeed(token);
const refused = (attempt: number) => Exit.fail(new LoginFailed({ attempt }));

/**
 * A controllable token source for `shareLogin`: a cache `Ref` the `cached`
 * effect reads (optionally pausing a read on a gate), and a login whose every
 * attempt is counted, waits for `gate`, then runs the scripted outcome for
 * that attempt. A successful outcome stores its token, as the real clients do.
 */
const harness = (outcomes: ReadonlyArray<(attempt: number) => Exit.Exit<string, LoginFailed>>) =>
  Effect.gen(function* () {
    const cache = yield* Ref.make(Option.none<string>());
    const logins = yield* Ref.make(0);
    const gate = yield* Deferred.make<void>();
    const readGate = yield* Ref.make(Option.none<Deferred.Deferred<void>>());

    const cached = Effect.fnUntraced(function* () {
      const value = yield* Ref.get(cache);
      // Take the pause (if armed) once: the next read blocks until released.
      const pause = yield* Ref.getAndSet(readGate, Option.none());
      if (Option.isSome(pause)) yield* Deferred.await(pause.value);
      return value;
    });

    const login = Effect.fnUntraced(function* () {
      const attempt = yield* Ref.updateAndGet(logins, (n) => n + 1);
      yield* Deferred.await(gate);
      const script = outcomes[Math.min(attempt, outcomes.length) - 1] ?? refused;
      const outcome = script(attempt);
      if (Exit.isSuccess(outcome)) yield* Ref.set(cache, Option.some(outcome.value));
      return yield* outcome;
    });

    const getToken = yield* shareLogin(cached(), login());
    return { getToken, logins, gate, readGate, cache };
  });

const fork = <A, E>(effect: Effect.Effect<A, E>) =>
  Effect.forkChild(effect, { startImmediately: true });

/** Let every runnable fiber reach its next suspension point. */
const settle = Effect.forEach(Arr.range(1, 10), () => Effect.yieldNow, {
  concurrency: 1,
  discard: true,
});

describe("shareLogin", () => {
  it.effect("a caller arriving right after a failure never joins the settled login", () =>
    Effect.gen(function* () {
      const result = yield* Effect.gen(function* () {
        const { getToken, logins, gate } = yield* harness([refused, ok("tok_2")]);
        const leader = yield* fork(Effect.flip(getToken));
        // A waiter that calls again the moment it sees the failure: it is
        // resumed synchronously by the publish, so if the slot were cleared
        // only afterwards, its second call would join the settled login and
        // replay the stale error instead of logging in afresh.
        const waiter = yield* fork(
          Effect.flip(getToken).pipe(
            Effect.flatMap((first) =>
              Effect.map(Effect.exit(getToken), (second) => ({ first, second })),
            ),
          ),
        );
        yield* settle;
        yield* Deferred.succeed(gate, undefined);
        return {
          leader: yield* Fiber.join(leader),
          waiter: yield* Fiber.join(waiter),
          logins: yield* Ref.get(logins),
        };
      });

      expect(result.leader).toEqual(new LoginFailed({ attempt: 1 }));
      expect(result.waiter.first).toBe(result.leader);
      expect(result.waiter.second).toEqual(Exit.succeed("tok_2"));
      expect(result.logins).toBe(2);
    }),
  );

  it.effect(
    "a leader re-checks the cache, so a caller that took the slot after a success does not log in again",
    () =>
      Effect.gen(function* () {
        const result = yield* Effect.gen(function* () {
          const { getToken, logins, gate, readGate } = yield* harness([ok("tok_1")]);
          const leader = yield* fork(getToken);
          yield* settle;
          // The late caller misses the cache, then pauses before taking the slot.
          const pause = yield* Deferred.make<void>();
          yield* Ref.set(readGate, Option.some(pause));
          const late = yield* fork(getToken);
          yield* settle;
          // The first login succeeds, stores its token and frees the slot…
          yield* Deferred.succeed(gate, undefined);
          const first = yield* Fiber.join(leader);
          // …and only then does the late caller take the (now empty) slot.
          yield* Deferred.succeed(pause, undefined);
          return { first, late: yield* Fiber.join(late), logins: yield* Ref.get(logins) };
        });

        expect(result.first).toBe("tok_1");
        expect(result.late).toBe("tok_1");
        expect(result.logins).toBe(1);
      }),
  );

  it.effect(
    "shares a login failure whose cause contains an interruption; waiters do not re-login",
    () =>
      Effect.gen(function* () {
        const result = yield* Effect.gen(function* () {
          const { getToken, logins, gate } = yield* harness([
            // The login fails on its own, with an interrupt in its cause (e.g.
            // a child it ran was interrupted); the leader is not interrupted.
            (attempt) =>
              Exit.failCause(
                Cause.combine(Cause.fail(new LoginFailed({ attempt })), Cause.interrupt()),
              ),
          ]);
          const fibers = yield* Effect.forEach(
            Array.from({ length: 4 }),
            () => fork(Effect.exit(getToken)),
            { concurrency: 1 },
          );
          yield* settle;
          yield* Deferred.succeed(gate, undefined);
          const exits = yield* Effect.forEach(fibers, Fiber.join, { concurrency: 1 });
          return { exits, logins: yield* Ref.get(logins) };
        });

        expect(result.logins).toBe(1);
        Arr.forEach(result.exits, (exit) => {
          expect(Exit.findErrorOption(exit)).toEqual(Option.some(new LoginFailed({ attempt: 1 })));
        });
      }),
  );

  it.effect("interrupting the leader interrupts its login and lets a waiter take over", () =>
    Effect.gen(function* () {
      const result = yield* Effect.gen(function* () {
        const { getToken, logins, gate } = yield* harness([ok("tok_1")]);
        const leader = yield* fork(getToken);
        yield* settle;
        const waiter = yield* fork(getToken);
        yield* settle;
        yield* Fiber.interrupt(leader);
        yield* settle;
        yield* Deferred.succeed(gate, undefined);
        return {
          leader: yield* Fiber.await(leader),
          waiter: yield* Fiber.join(waiter),
          logins: yield* Ref.get(logins),
        };
      });

      expect(Exit.hasInterrupts(result.leader)).toBe(true);
      expect(result.waiter).toBe("tok_1");
      // The abandoned attempt and the waiter's own.
      expect(result.logins).toBe(2);
    }),
  );
});

describe("scaleToMinor", () => {
  it("scales a mantissa to minor units with integer arithmetic", () => {
    expect(scaleToMinor(1234n, 2, 2)).toBe(1234n);
    expect(scaleToMinor(12n, 0, 2)).toBe(1200n);
    expect(scaleToMinor(5n, 1, 3)).toBe(500n);
    expect(scaleToMinor(7n, 0, 0)).toBe(7n);
    expect(scaleToMinor(0n, 5, 5)).toBe(0n);
  });

  it("refuses more fraction digits than the currency allows rather than rounding", () => {
    expect(scaleToMinor(1001n, 3, 2)).toBeUndefined();
    expect(scaleToMinor(1n, 1, 0)).toBeUndefined();
  });

  it("refuses a magnitude beyond the safe-integer range, and allows the limit itself", () => {
    expect(scaleToMinor(BigInt(Number.MAX_SAFE_INTEGER), 0, 0)).toBe(
      BigInt(Number.MAX_SAFE_INTEGER),
    );
    expect(scaleToMinor(BigInt(Number.MAX_SAFE_INTEGER) + 1n, 0, 0)).toBeUndefined();
    expect(scaleToMinor(BigInt(Number.MAX_SAFE_INTEGER), 0, 2)).toBeUndefined();
  });
});

describe("parseDecimal", () => {
  it("parses a decimal string for the given number of fraction digits", () => {
    expect(parseDecimal("10.00", 2)).toBe(1000);
    expect(parseDecimal("10", 2)).toBe(1000);
    expect(parseDecimal("0.5", 2)).toBe(50);
    expect(parseDecimal("1.234", 3)).toBe(1234);
    expect(parseDecimal("1500", 0)).toBe(1500);
    expect(parseDecimal("-12.34", 2)).toBe(-1234);
  });

  it("never produces -0", () => {
    expect(Object.is(parseDecimal("-0.00", 2), 0)).toBe(true);
    expect(Object.is(parseDecimal("-0", 0), 0)).toBe(true);
  });

  it("rejects malformed text, excess fraction digits and unsafe magnitudes", () => {
    Arr.forEach(["", "abc", "1.", ".5", "+1", "1e3", " 1", "1.2.3", "--1"], (text) => {
      expect(parseDecimal(text, 2)).toBeUndefined();
    });
    expect(parseDecimal("1.001", 2)).toBeUndefined();
    expect(parseDecimal("1.5", 0)).toBeUndefined();
    expect(parseDecimal("90071992547409.92", 2)).toBeUndefined();
    expect(parseDecimal("90071992547409.91", 2)).toBe(Number.MAX_SAFE_INTEGER);
  });
});

describe("decimalText and formatDecimal", () => {
  it("places the decimal point and pads small magnitudes", () => {
    expect(decimalText(false, 1234n, 2)).toBe("12.34");
    expect(decimalText(true, 1234n, 2)).toBe("-12.34");
    expect(decimalText(false, 5n, 2)).toBe("0.05");
    expect(decimalText(false, 0n, 3)).toBe("0.000");
    expect(decimalText(true, 7n, 0)).toBe("-7");
  });

  it("formats safe-integer minor units and refuses anything else", () => {
    expect(formatDecimal(1000, 2)).toBe("10.00");
    expect(formatDecimal(-5, 2)).toBe("-0.05");
    expect(formatDecimal(0, 0)).toBe("0");
    expect(formatDecimal(1234, 3)).toBe("1.234");
    expect(formatDecimal(Number.MAX_SAFE_INTEGER, 2)).toBe("90071992547409.91");
    Arr.forEach([10.5, 2 ** 53, Number.NaN, Number.POSITIVE_INFINITY], (minor) => {
      expect(formatDecimal(minor, 2)).toBeUndefined();
    });
  });

  it("round-trips through parseDecimal", () => {
    Arr.forEach([0, 2, 3], (digits) => {
      Arr.forEach([0, 1, 99, 100, 123456789, -1, -250, Number.MAX_SAFE_INTEGER], (minor) => {
        const text = formatDecimal(minor, digits);
        assert.isDefined(text);
        expect(parseDecimal(text, digits)).toBe(minor);
      });
    });
  });
});

describe("checkMinorUnits", () => {
  it.effect("needs no currency and refuses a negative or non-safe-integer amount", () =>
    Effect.gen(function* () {
      yield* checkMinorUnits(0, "amount");
      yield* checkMinorUnits(Number.MAX_SAFE_INTEGER, "amount");
      const errors = yield* Effect.forEach(
        [-1, 10.5, 2 ** 53, Number.NaN],
        (minor) => Effect.flip(checkMinorUnits(minor, "amount")),
        { concurrency: 1 },
      );
      Arr.forEach(errors, (error) => {
        expect(error).toBeInstanceOf(PaymentInvalidRequestError);
        expect(error.param).toBe("amount");
      });
    }),
  );
});

describe("exponentFrom", () => {
  const exponent = exponentFrom(HashSet.make("jpy"), HashSet.make("kwd"));

  it("looks a currency up in the given tables, case-insensitively, defaulting to two", () => {
    expect(exponent("jpy")).toBe(0);
    expect(exponent("JPY")).toBe(0);
    expect(exponent("KWD")).toBe(3);
    expect(exponent("usd")).toBe(2);
    expect(exponent("")).toBe(2);
  });
});

describe("isOk and isAbsoluteHttpUrl", () => {
  it("accepts exactly the 2xx statuses", () => {
    expect([199, 200, 204, 299, 300, 401].map(isOk)).toEqual([
      false,
      true,
      true,
      true,
      false,
      false,
    ]);
  });

  it("accepts only an absolute http(s) URL", () => {
    expect(isAbsoluteHttpUrl("https://api.example.com")).toBe(true);
    expect(isAbsoluteHttpUrl("http://localhost:12111")).toBe(true);
    Arr.forEach(["", "/v1", "api.example.com", "ftp://example.com"], (value) => {
      expect(isAbsoluteHttpUrl(value)).toBe(false);
    });
  });
});

describe("timeoutOf", () => {
  it.effect("accepts a positive finite number of milliseconds, or Infinity", () =>
    Effect.gen(function* () {
      expect(Duration.toMillis(yield* timeoutOf("Acme", "timeout", 250))).toBe(250);
      expect(Duration.isFinite(yield* timeoutOf("Acme", "timeout", Infinity))).toBe(false);
    }),
  );

  it.effect("refuses anything else with PaymentConfigError naming the provider and option", () =>
    Effect.gen(function* () {
      const millis = [0, -1, Number.NaN, -Infinity];
      const errors = yield* Effect.forEach(
        millis,
        (value) => Effect.flip(timeoutOf("Acme", "loginTimeout", value)),
        {
          concurrency: 1,
        },
      );
      Arr.forEach(Arr.zip(millis, errors), ([value, error]) => {
        expect(error).toBeInstanceOf(PaymentConfigError);
        expect(error.message).toBe(
          `Acme loginTimeout must be a positive number of milliseconds, or Infinity for none (got ${value})`,
        );
      });
    }),
  );
});

layer(FetchHttpClient.layer)("send", (it) => {
  const SECRET = "Bearer not_a_real_secret";
  const request = HttpClientRequest.get("https://api.example.com/v1/things").pipe(
    HttpClientRequest.setHeader("Authorization", SECRET),
  );
  const run = <A, E>(
    effect: (http: HttpClient.HttpClient) => Effect.Effect<A, E>,
    fetch: () => Response | Promise<Response>,
  ) =>
    Effect.flatMap(HttpClient.HttpClient, effect).pipe(
      Effect.provideService(FetchHttpClient.Fetch, stubFetch(fetch).fetch),
    );
  const options = { provider: "Acme", what: "request", limit: Duration.seconds(5) };

  it.effect("reads any status with its JSON body, or {} for a body that is not JSON", () =>
    Effect.gen(function* () {
      expect(
        yield* run(
          (http) => send(http, request, options),
          () => jsonResponse(402, { a: 1 }),
        ),
      ).toMatchObject({
        status: 402,
        json: { a: 1 },
      });
      expect(
        yield* run(
          (http) => send(http, request, options),
          () => new Response("<html>", { status: 502 }),
        ),
      ).toMatchObject({ status: 502, json: {} });
    }),
  );

  it.effect("keeps the response headers, keyed in lower case", () =>
    Effect.gen(function* () {
      const reply = yield* run(
        (http) => send(http, request, options),
        () => new Response("{}", { status: 429, headers: { "Retry-After": "7" } }),
      );
      expect(reply.headers["retry-after"]).toBe("7");
    }),
  );

  it.effect("fails a connection failure with PaymentNetworkError, never carrying the request", () =>
    Effect.gen(function* () {
      const boom = new TypeError("fetch failed");
      const error = yield* run(
        (http) => Effect.flip(send(http, request, options)),
        () => throwing(boom),
      );
      expect(error).toBeInstanceOf(PaymentNetworkError);
      expect(error.cause).toBe(boom);
      expect(reachableFrom(error).strings.filter((value) => value.includes(SECRET))).toEqual([]);
      expect(reachableFrom(error).objects.filter(HttpClientRequest.isHttpClientRequest)).toEqual(
        [],
      );
    }),
  );

  it.effect("fails a request unanswered after the limit with the provider's timeout error", () =>
    Effect.gen(function* () {
      const error = yield* run(
        (http) => withTestClock(Effect.flip(send(http, request, options))),
        () => new Promise<Response>(() => {}),
      );
      expect(error).toBeInstanceOf(PaymentNetworkError);
      expect(error.message).toBe("Acme request timed out after 5000 ms");
      expect(error.message).toBe(timedOut("Acme", "request", Duration.seconds(5)).message);
    }),
  );

  it.effect("maps an HttpClientError onto PaymentNetworkError by its message and cause", () =>
    Effect.sync(() => {
      const cause = new Error("socket hang up");
      const error = networkError(
        new HttpClientError.HttpClientError({
          reason: new HttpClientError.TransportError({ request, cause }),
        }),
      );
      expect(error.cause).toBe(cause);
      expect(reachableFrom(error).objects.filter(HttpClientRequest.isHttpClientRequest)).toEqual(
        [],
      );
    }),
  );
});

describe("tokenCache", () => {
  it.effect("serves a stored token until a minute before it expires", () =>
    Effect.gen(function* () {
      const result = yield* Effect.gen(function* () {
        const cache = yield* tokenCache;
        const empty = yield* cache.cached;
        yield* cache.store("tok_1", 120_000);
        const fresh = yield* cache.cached;
        yield* TestClock.adjust("59 seconds");
        const stillFresh = yield* cache.cached;
        yield* TestClock.adjust("1 second");
        const stale = yield* cache.cached;
        return { empty, fresh, stillFresh, stale };
      });
      expect(result).toEqual({
        empty: Option.none(),
        fresh: Option.some("tok_1"),
        stillFresh: Option.some("tok_1"),
        stale: Option.none(),
      });
    }),
  );

  it.effect("forgets a refused token only while it is still the stored one", () =>
    Effect.gen(function* () {
      const result = yield* Effect.gen(function* () {
        const cache = yield* tokenCache;
        yield* cache.store("tok_2", Number.MAX_SAFE_INTEGER);
        yield* cache.forget("tok_1");
        const kept = yield* cache.cached;
        yield* cache.forget("tok_2");
        const forgotten = yield* cache.cached;
        return { kept, forgotten };
      });
      expect(result).toEqual({ kept: Option.some("tok_2"), forgotten: Option.none() });
    }),
  );

  it.effect("gives every build its own cache", () =>
    Effect.gen(function* () {
      const result = yield* Effect.gen(function* () {
        const first = yield* tokenCache;
        const second = yield* tokenCache;
        yield* first.store("tok_1", Number.MAX_SAFE_INTEGER);
        return yield* second.cached;
      });
      expect(result).toEqual(Option.none());
    }),
  );
});

describe("omitUndefined", () => {
  it("drops exactly the undefined-valued keys", () => {
    const input = { a: 1, b: undefined, c: null, d: "", e: false, f: 0 };
    const output = omitUndefined(input);
    expect(output).toEqual({ a: 1, c: null, d: "", e: false, f: 0 });
    expect(Struct.keys(output)).not.toContain("b");
  });
});

describe("checkId", () => {
  it.effect("passes a non-empty string id", () =>
    Effect.gen(function* () {
      expect(yield* checkId("customer", "cus_1")).toBeUndefined();
    }),
  );

  it.effect("refuses an empty or non-string id before anything is sent", () =>
    Effect.gen(function* () {
      const errors = yield* Effect.forEach(
        ["", undefined, 42],
        // SAFETY: untyped callers can pass anything; that is what is under test.
        (id) => Effect.flip(checkId("customer", id as string)),
        { concurrency: 1 },
      );
      Arr.forEach(errors, (error) => {
        expect(error).toBeInstanceOf(PaymentInvalidRequestError);
        expect(error.message).toBe("The customer id must be a non-empty string");
        expect(error.param).toBe("id");
      });
    }),
  );
});

describe("stringField", () => {
  it("reads a string field, and nothing else", () => {
    expect(stringField({ message: "boom" }, "message")).toBe("boom");
    expect(stringField({ message: 42 }, "message")).toBeUndefined();
    expect(stringField({}, "message")).toBeUndefined();
    expect(stringField(null, "message")).toBeUndefined();
    expect(stringField("message", "length")).toBeUndefined();
  });
});

layer(FetchHttpClient.layer)("observeResponses", (it) => {
  const observe = (fetch: () => Response) =>
    Effect.gen(function* () {
      const watched = yield* observeResponses(yield* HttpClient.HttpClient);
      const before = yield* watched.last;
      const response = yield* watched.client.get("https://api.example.com/v1/things");
      // The body is still readable after the observer read it.
      const text = yield* response.text;
      return { before, text, after: yield* watched.last };
    }).pipe(Effect.provideService(FetchHttpClient.Fetch, stubFetch(fetch).fetch));

  it.effect("records the status, headers and JSON body, and hands the response on unread", () =>
    Effect.gen(function* () {
      const { before, text, after } = yield* observe(() =>
        jsonResponse(409, { error: "conflict" }, { "retry-after": "2" }),
      );
      expect(before).toEqual(Option.none());
      expect(text).toBe('{"error":"conflict"}');
      assert(Option.isSome(after), "a response was observed");
      expect(after.value.status).toBe(409);
      expect(after.value.headers["retry-after"]).toBe("2");
      expect(after.value.body).toEqual(Option.some({ error: "conflict" }));
    }),
  );

  it.effect("records an empty body or one that is not JSON as None", () =>
    Effect.gen(function* () {
      const bodies = ["", "<html>"];
      const results = yield* Effect.forEach(
        bodies,
        (body) => observe(() => new Response(body, { status: 200 })),
        { concurrency: 1 },
      );
      Arr.forEach(Arr.zip(bodies, results), ([body, { text, after }]) => {
        expect(text).toBe(body);
        assert(Option.isSome(after), "a response was observed");
        expect(after.value.body).toEqual(Option.none());
      });
    }),
  );
});

describe("rejectedError", () => {
  const fallback = { message: "The Acme request failed", code: "UnknownAcmeError" };

  it("names the failure by its tag and message, keeping it as the cause", () => {
    const failure = { _tag: "ConfigError", message: "missing credentials" };
    const error = rejectedError(failure, "acme", fallback);
    expect(error).toBeInstanceOf(PaymentProviderError);
    expect(error.provider).toBe("acme");
    expect(error.code).toBe("ConfigError");
    expect(error.message).toBe("missing credentials");
    expect(error.cause).toBe(failure);
  });

  it("falls back on a failure without a tag or message", () => {
    const error = rejectedError(42, "acme", fallback);
    expect(error.code).toBe("UnknownAcmeError");
    expect(error.message).toBe("The Acme request failed");
  });
});

describe("responseDecoder", () => {
  const decoder = responseDecoder({ provider: "acme", name: "Acme" });
  const decodeThing = decoder("thing", Schema.Struct({ id: Schema.String }), (thing) =>
    thing.id.toUpperCase(),
  );

  it.effect("decodes a body and maps it, ignoring unknown fields", () =>
    Effect.gen(function* () {
      expect(yield* decodeThing({ id: "t_1", extra: true })).toBe("T_1");
    }),
  );

  it.effect(
    "fails a body that does not decode with a PaymentProviderError naming the provider",
    () =>
      Effect.gen(function* () {
        const error = yield* Effect.flip(decodeThing({ id: 42 }));
        expect(error).toBeInstanceOf(PaymentProviderError);
        expect(error.provider).toBe("acme");
        expect(error.message).toBe("Acme returned a malformed thing response");
        expect(error.cause).toBeDefined();
      }),
  );
});

describe("epochSecondsOf", () => {
  it("reads an ISO-8601 timestamp as whole Unix seconds", () => {
    expect(epochSecondsOf("2024-01-02T03:04:05Z")).toBe(1_704_164_645);
    expect(epochSecondsOf("2024-01-02T03:04:05.999Z")).toBe(1_704_164_645);
    expect(epochSecondsOf("2026-01-01T10:00:00.900+10:00")).toBe(1_767_225_600);
  });

  it("is 0 for an absent, empty or unparseable timestamp", () => {
    Arr.forEach([undefined, null, "", "not a date"], (value) => {
      expect(epochSecondsOf(value)).toBe(0);
    });
  });
});

describe("errorFromStatus", () => {
  const details = { provider: "acme", message: "boom", code: "E_ACME", param: "amount" };

  it("classifies 401 and 403 as authentication failures", () => {
    Arr.forEach([401, 403], (status) => {
      const error = errorFromStatus(status, details);
      expect(error).toBeInstanceOf(PaymentAuthenticationError);
      expect(error).toMatchObject({ message: "boom", statusCode: status });
    });
  });

  it("classifies 429 as a rate limit", () => {
    const error = errorFromStatus(429, details);
    expect(error).toBeInstanceOf(PaymentRateLimitError);
    expect(error).toMatchObject({ message: "boom", retryAfter: undefined });
  });

  it("reads a rate limit's Retry-After as whole seconds", () => {
    expect(errorFromStatus(429, { ...details, retryAfter: "30" })).toMatchObject({
      retryAfter: 30,
    });
    expect(errorFromStatus(429, { ...details, retryAfter: " 0 " })).toMatchObject({
      retryAfter: 0,
    });
  });

  it("leaves retryAfter out for a Retry-After that is not whole seconds", () => {
    Arr.forEach(["Wed, 21 Oct 2026 07:28:00 GMT", "1.5", "-3", "", "soon"], (retryAfter) => {
      expect(errorFromStatus(429, { ...details, retryAfter })).toMatchObject({
        retryAfter: undefined,
      });
    });
  });

  it("classifies 400, 404 and 422 as invalid requests carrying the param", () => {
    Arr.forEach([400, 404, 422], (status) => {
      const error = errorFromStatus(status, details);
      expect(error).toBeInstanceOf(PaymentInvalidRequestError);
      expect(error).toMatchObject({ message: "boom", param: "amount", statusCode: status });
    });
  });

  it("classifies any other status as a provider error carrying the code", () => {
    Arr.forEach([402, 409, 500, 503], (status) => {
      const error = errorFromStatus(status, details);
      expect(error).toBeInstanceOf(PaymentProviderError);
      expect(error).toMatchObject({
        message: "boom",
        provider: "acme",
        code: "E_ACME",
        statusCode: status,
      });
    });
  });

  it("leaves the param and code out when the body named none", () => {
    expect(errorFromStatus(400, { provider: "acme", message: "m" })).toMatchObject({
      param: undefined,
    });
    expect(errorFromStatus(500, { provider: "acme", message: "m" })).toMatchObject({
      code: undefined,
    });
  });
});

describe("pageNumberedList", () => {
  /** List one page of `data` through `pageNumberedList`, recording the page asked for. */
  const listed = (
    params: { readonly limit?: number | undefined; readonly startingAfter?: string | undefined },
    hasMore: boolean,
    firstPage = 1,
  ) => {
    const asked: Array<number | undefined> = [];
    const result = pageNumberedList(params, { provider: "Acme", firstPage }, (page) => {
      asked.push(page);
      return Effect.succeed({ data: ["x"], hasMore });
    });
    return { result, asked };
  };
  /** The failure of listing from `startingAfter`, and whether the list ran. */
  const failure = Effect.fnUntraced(function* (startingAfter: string, limit?: number) {
    const asked: Array<number | undefined> = [];
    const error = yield* Effect.flip(
      pageNumberedList({ startingAfter, limit }, { provider: "Acme", firstPage: 1 }, (page) => {
        asked.push(page);
        return Effect.succeed({ data: [], hasMore: false });
      }),
    );
    return { error, asked };
  });

  it.effect("lists the vendor's first page by default, with the next page's cursor", () =>
    Effect.gen(function* () {
      const { result, asked } = listed({ limit: 2 }, true);
      expect(yield* result).toEqual({ data: ["x"], hasMore: true, nextCursor: "page=2&size=2" });
      expect(asked).toEqual([undefined]);
      const zeroBased = listed({}, true, 0);
      expect((yield* zeroBased.result).nextCursor).toBe("page=1");
    }),
  );

  it.effect("lists the page a cursor names, for the same limit", () =>
    Effect.gen(function* () {
      const { result, asked } = listed({ limit: 2, startingAfter: "page=2&size=2" }, true);
      expect((yield* result).nextCursor).toBe("page=3&size=2");
      expect(asked).toEqual([2]);
    }),
  );

  it.effect("gives the last page no cursor", () =>
    Effect.gen(function* () {
      const page = yield* listed({ startingAfter: "page=3" }, false).result;
      expect(page).toEqual({ data: ["x"], hasMore: false });
      expect(page).not.toHaveProperty("nextCursor");
    }),
  );

  it.effect.each(["cus_123", "page=", "page=x", "page=2&size=", "page=0", ""])(
    "refuses %j, an item id, a malformed cursor or one below the first page, listing nothing",
    (cursor) =>
      Effect.gen(function* () {
        const { error, asked } = yield* failure(cursor);
        expect(error).toBeInstanceOf(PaymentInvalidRequestError);
        expect(error).toMatchObject({
          param: "startingAfter",
          message: "Acme startingAfter must be the nextCursor of a previous page, not an item id",
        });
        expect(asked).toEqual([]);
      }),
  );

  it.effect.each([
    ["page=2&size=10", 20],
    ["page=2&size=10", undefined],
    ["page=2", 10],
  ] as const)(
    "refuses %s with limit %s: a cursor for another limit would skip or repeat items",
    ([cursor, limit]) =>
      Effect.gen(function* () {
        const { error } = yield* failure(cursor, limit);
        expect(error).toBeInstanceOf(PaymentInvalidRequestError);
        expect(error).toMatchObject({ param: "startingAfter" });
      }),
  );
});
