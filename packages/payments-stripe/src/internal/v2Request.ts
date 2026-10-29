/**
 * The two places where stripe-node 23 sends a `/v2` request differently from
 * Distilled (effect-finance#181). `StripeHttp` maps every request it hands Distilled through
 * {@link v2RequestPolicy}, which tells a `/v2` request by its URL, as the SDK
 * does by its path (`getAPIMode`).
 *
 * @module
 */

import * as Arr from "effect/Array";
import * as HashMap from "effect/HashMap";
import * as Option from "effect/Option";
import { HttpClientRequest } from "effect/http";
import { escapeQuery } from "./deleteQuery.js";

/**
 * A `/v2` request's array query params with an index per item
 * (`include[0]=a&include[1]=b`), where Distilled sends repeated `include[]`
 * keys. stripe-node and stripe-python have sent indexed keys to `/v2` since
 * November 2025 (`repeat` before that); neither has ever sent `key[]`, which
 * nothing says `/v2` reads. A query with no `[]` key passes as it is.
 */
const indexArrayQuery = (
  request: HttpClientRequest.HttpClientRequest,
): HttpClientRequest.HttpClientRequest => {
  const at = request.url.indexOf("?");
  if (at === -1) return request;
  const entries = [...new URLSearchParams(request.url.slice(at + 1))];
  if (!entries.some(([key]) => key.endsWith("[]"))) return request;
  const [, pairs] = Arr.mapAccum(
    entries,
    HashMap.empty<string, number>(),
    (counts, [key, value]): readonly [HashMap.HashMap<string, number>, string] => {
      if (!key.endsWith("[]")) return [counts, `${escapeQuery(key)}=${escapeQuery(value)}`];
      const index = Option.getOrElse(HashMap.get(counts, key), () => 0);
      return [
        HashMap.set(counts, key, index + 1),
        `${escapeQuery(`${key.slice(0, -2)}[${index}]`)}=${escapeQuery(value)}`,
      ];
    },
  );
  const query = pairs.join("&");
  return HttpClientRequest.setUrl(request, `${request.url.slice(0, at)}?${query}`);
};

/**
 * The SDK's `/v2` request policy, for requests to `apiBaseUrl`: a `/v2`
 * `DELETE` without an `Idempotency-Key` gets `generatedKey` (stripe-node keys
 * every `/v2` `POST` and `DELETE`, `_defaultIdempotencyKey`), and a `/v2`
 * request's array query params are indexed. `generatedKey` is made once per
 * call, so every attempt of the call carries the same one; `undefined` adds
 * none. Any other request passes as it is.
 */
export const v2RequestPolicy =
  (apiBaseUrl: string, generatedKey: string | undefined) =>
  (request: HttpClientRequest.HttpClientRequest): HttpClientRequest.HttpClientRequest => {
    if (!request.url.startsWith(`${apiBaseUrl}/v2/`)) return request;
    const keyed =
      request.method === "DELETE" &&
      generatedKey !== undefined &&
      request.headers["idempotency-key"] === undefined
        ? HttpClientRequest.setHeader(request, "Idempotency-Key", generatedKey)
        : request;
    return indexArrayQuery(keyed);
  };
