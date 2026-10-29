import { describe, it, expect } from "vite-plus/test";
import { HttpBody, HttpClientRequest } from "effect/http";
import { deleteParamsToQuery } from "../src/internal/deleteQuery.ts";

/**
 * The branches `StripeHttp`'s wire tests cannot reach through Distilled,
 * which always encodes a form body as text and never puts a query on a
 * `DELETE` path: `tests/StripeHttp.test.ts` covers the ordinary `DELETE`.
 */

const FORM = "application/x-www-form-urlencoded";
const encoder = new TextEncoder();

describe("deleteParamsToQuery", () => {
  it("reads a form body that carries only bytes, no text", () => {
    const request = HttpClientRequest.delete("https://api.stripe.com/v1/subscriptions/sub_1").pipe(
      HttpClientRequest.setBody(HttpBody.uint8Array(encoder.encode("invoice_now=true"), FORM)),
    );
    expect(request.body).toMatchObject({ _tag: "Uint8Array", text: undefined });
    const moved = deleteParamsToQuery(request);
    expect(moved.url).toBe("https://api.stripe.com/v1/subscriptions/sub_1?invoice_now=true");
    expect(moved.body._tag).toBe("Empty");
  });

  it("appends to a URL that already has a query", () => {
    const request = HttpClientRequest.delete(
      "https://api.stripe.com/v1/subscriptions/sub_1?prorate=false",
    ).pipe(HttpClientRequest.setBody(HttpBody.text("invoice_now=true", FORM)));
    const moved = deleteParamsToQuery(request);
    expect(moved.url).toBe(
      "https://api.stripe.com/v1/subscriptions/sub_1?prorate=false&invoice_now=true",
    );
    expect(moved.body._tag).toBe("Empty");
  });

  it("drops an empty form body and adds no query", () => {
    const request = HttpClientRequest.delete("https://api.stripe.com/v1/customers/cus_1").pipe(
      HttpClientRequest.setBody(HttpBody.text("", FORM)),
    );
    const moved = deleteParamsToQuery(request);
    expect(moved.url).toBe("https://api.stripe.com/v1/customers/cus_1");
    expect(moved.body._tag).toBe("Empty");
  });

  it("leaves any other request as it is", () => {
    const post = HttpClientRequest.post("https://api.stripe.com/v1/customers").pipe(
      HttpClientRequest.setBody(HttpBody.text("email=a%40b.c", FORM)),
    );
    const json = HttpClientRequest.delete("https://api.stripe.com/v1/customers/cus_1").pipe(
      HttpClientRequest.setBody(HttpBody.text("{}", "application/json")),
    );
    expect(deleteParamsToQuery(post)).toBe(post);
    expect(deleteParamsToQuery(json)).toBe(json);
  });
});
