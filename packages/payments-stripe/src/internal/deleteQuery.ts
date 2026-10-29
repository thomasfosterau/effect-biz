/**
 * A Stripe `DELETE`'s params in the query string, where Distilled sends them
 * as a form body (effect-finance#146). `StripeHttp` maps every request it hands Distilled
 * through {@link deleteParamsToQuery}.
 *
 * @module
 */

import * as Predicate from "effect/Predicate";
import { HttpBody, HttpClientRequest } from "effect/http";

const FORM = "application/x-www-form-urlencoded";

/**
 * `encodeURIComponent` plus the five characters it leaves alone that the
 * SDK's `qs` escapes (`!`, `'`, `(`, `)`, `*`), with the bracket control
 * characters left literal, as the SDK sends them (`cancellation_details[comment]`).
 * Shared with `v2Request.ts`, which re-encodes a `/v2` query the same way.
 */
export const escapeQuery = (text: string): string =>
  encodeURIComponent(text)
    .replace(/[!'()*]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`)
    .replace(/%5B/g, "[")
    .replace(/%5D/g, "]");

/**
 * A `DELETE`'s params, moved from the form body Distilled encodes them into
 * (it keeps a body off a `GET` or `HEAD` only) to the query string, where the
 * Stripe SDKs send them (`DELETE /v1/subscriptions/sub_1?invoice_now=true`);
 * the body and its `Content-Type` are dropped. Any other request passes as is.
 */
export const deleteParamsToQuery = (
  request: HttpClientRequest.HttpClientRequest,
): HttpClientRequest.HttpClientRequest => {
  const { body } = request;
  if (
    request.method !== "DELETE" ||
    !Predicate.isTagged(body, "Uint8Array") ||
    body.contentType !== FORM
  ) {
    return request;
  }
  const query = [...new URLSearchParams(body.text ?? new TextDecoder().decode(body.body))]
    .map(([key, value]) => `${escapeQuery(key)}=${escapeQuery(value)}`)
    .join("&");
  const bodyless = HttpClientRequest.setBody(request, HttpBody.empty);
  return query === ""
    ? bodyless
    : HttpClientRequest.setUrl(
        bodyless,
        `${request.url}${request.url.includes("?") ? "&" : "?"}${query}`,
      );
};
