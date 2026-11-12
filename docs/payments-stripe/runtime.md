# Runtime: a `process` global

What the capability layers need from the runtime.

The capability layers need a `process` global with an `env` object. Distilled reads `process.env.DISTILLED_DEBUG_HTTP`, unguarded, each time it builds a request and each time it reads a response, so where there is no `process` global every call that reaches Distilled dies with a defect, not a `PaymentsError`. Node, Bun and Deno have one; on **Cloudflare Workers, enable the `nodejs_compat` compatibility flag**. The resource modules run on Distilled too, so the same holds for each of their calls. Loading the package and building the layers do not touch `process`, and neither does `Webhook.verify`.

**Leave `DISTILLED_DEBUG_HTTP` unset outside local debugging.** While it is set, Distilled writes to `console.error`, for every request, the method and full URL (a `GET`'s query string included) and the first 400 characters of the request body (as JSON), and for every response the status and the first 400 characters of the body. Those characters can hold part or all of a payment intent's or checkout session's `client_secret`, and whatever customer data the call carries. The `Authorization` header, and so the API key, is not logged.
