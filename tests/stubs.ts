/**
 * Test doubles the provider suites share: a stubbed `fetch` served as
 * `effect/http`'s `HttpClient`, a vendor API built on it, a `TestClock`
 * driver, and the walk the wire suites use to prove no secret is reachable
 * from an error.
 *
 * Not a package and never published: a provider's suites import what they
 * need from here, through its `tests/support.ts` when it has its own vendor
 * stub to add.
 * Nothing here names a vendor; no test reaches a live API.
 */

import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";
import { FetchHttpClient } from "effect/http";
import { TestClock } from "effect/testing";

/** A request as the stubbed `fetch` saw it. */
export interface CapturedRequest {
  readonly url: URL;
  readonly method: string;
  readonly headers: Headers;
  readonly init: RequestInit | undefined;
  /** A text or bytes body, decoded; `undefined` for none or for multipart. */
  readonly body: string | undefined;
  /** A multipart body, as sent. */
  readonly form: FormData | undefined;
}

const textOf = (raw: BodyInit | null | undefined): string | undefined =>
  Predicate.isString(raw)
    ? raw
    : raw instanceof Uint8Array
      ? new TextDecoder().decode(raw)
      : undefined;

/** Encode a value as JSON text, as `JSON.stringify` would. */
const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

/** A JSON response with `status`, plus any extra headers. */
export const jsonResponse = (
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): Response =>
  // An `undefined` body has no JSON text: the response is sent without one.
  new Response(body === undefined ? undefined : encodeJson(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });

/**
 * A stubbed `fetch` answering with `handler`, served through
 * `FetchHttpClient.layer` (`http`), and as the bare implementation (`fetch`)
 * for a program that brings its own `FetchHttpClient.layer`, to provide as
 * `FetchHttpClient.Fetch`. `handler` may throw (or return a rejected promise)
 * to simulate a connection failure.
 */
export const stubFetch = (
  handler: (request: CapturedRequest, attempt: number) => Response | Promise<Response>,
) => {
  const calls: Array<CapturedRequest> = [];
  const fetchImpl: typeof globalThis.fetch = async (input, init) => {
    const captured: CapturedRequest = {
      url: new URL(String(input)),
      method: init?.method ?? "GET",
      headers: new Headers(init?.headers),
      init,
      body: textOf(init?.body),
      form: init?.body instanceof FormData ? init.body : undefined,
    };
    calls.push(captured);
    return handler(captured, calls.length);
  };
  const http = FetchHttpClient.layer.pipe(
    Layer.provide(Layer.succeed(FetchHttpClient.Fetch, fetchImpl)),
  );
  return { http, calls, fetch: fetchImpl };
};

/**
 * A stubbed vendor API over {@link stubFetch}: every request is read as a
 * call by `read` (as the vendor would read it) and recorded in `calls`;
 * `answer` maps each call to a body (served as a 200) or a whole `Response`,
 * and may throw to simulate a connection failure. `requests` are the raw
 * requests, `http` the stubbed `HttpClient` and `fetch` the stub alone.
 */
export const stubApi = <Call>(
  read: (request: CapturedRequest) => Call,
  answer: (call: Call, attempt: number) => unknown,
) => {
  const calls: Array<Call> = [];
  const stub = stubFetch((request, attempt) => {
    const call = read(request);
    calls.push(call);
    const body = answer(call, attempt);
    return body instanceof Response ? body : jsonResponse(200, body);
  });
  return { calls, requests: stub.calls, http: stub.http, fetch: stub.fetch };
};

/** Let pending promises (the stubbed `fetch`) settle. */
export const macrotask = Effect.callback<void>((resume) => {
  const timer = setTimeout(() => resume(Effect.void), 0);
  return Effect.sync(() => clearTimeout(timer));
});

/**
 * Run `effect` under a `TestClock`, advancing it until the effect completes,
 * so retry backoff, timeouts and token expiry elapse instantly and
 * deterministically.
 */
export const withTestClock = <A, E>(effect: Effect.Effect<A, E>): Effect.Effect<A, E> =>
  Effect.gen(function* () {
    const fiber = yield* Effect.forkChild(effect);
    /** Advance the clock a second at a time, at most `remaining` times, until `fiber` is done. */
    const advance = (remaining: number): Effect.Effect<void> =>
      Effect.suspend(() =>
        remaining === 0 || fiber.pollUnsafe() !== undefined
          ? Effect.void
          : macrotask.pipe(
              Effect.andThen(TestClock.adjust("1 second")),
              Effect.andThen(advance(remaining - 1)),
            ),
      );
    yield* advance(1000);
    return yield* Fiber.join(fiber);
  }).pipe(Effect.provide(TestClock.layer()));

/**
 * The values an object holds directly: its `Map` / `Set` entries, its own
 * keys and its own data properties' values. None for a primitive.
 */
const childrenOf = (value: unknown): Array<unknown> => {
  if (!Predicate.isObjectKeyword(value)) return [];
  const entries = Predicate.isMap(value)
    ? [...value.keys(), ...value.values()]
    : Predicate.isSet(value)
      ? [...value.values()]
      : [];
  const own = Reflect.ownKeys(value).flatMap((key) => {
    const descriptor = Reflect.getOwnPropertyDescriptor(value, key);
    return descriptor !== undefined && "value" in descriptor ? [key, descriptor.value] : [key];
  });
  return [...entries, ...own];
};

/**
 * Every string and object reachable from `root` through {@link childrenOf}
 * (string- and symbol-keyed properties, enumerable or not, getters left
 * unread), each object once.
 */
export const reachableFrom = (root: unknown) => {
  const strings: Array<string> = [];
  const objects: Array<object> = [];
  // Identity, not structural equality: each distinct object is visited once.
  const seen = new WeakSet<object>();
  /** Visit one breadth-first level of values, then the level below it. */
  const visit = (level: ReadonlyArray<unknown>): void =>
    Arr.match(level, {
      onEmpty: () => undefined,
      onNonEmpty: (values) =>
        visit(
          Arr.flatMap(values, (value) => {
            if (Predicate.isString(value)) strings.push(value);
            if (!Predicate.isObjectKeyword(value) || seen.has(value)) return [];
            seen.add(value);
            objects.push(value);
            return childrenOf(value);
          }),
        ),
    });
  visit([root]);
  return { strings, objects };
};
