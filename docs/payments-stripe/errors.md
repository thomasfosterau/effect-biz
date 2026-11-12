# Errors

How Stripe failures map onto the neutral `PaymentsError` channel.

Every capability and resource-module call fails with the core's `PaymentsError` and nothing else; Distilled's error classes never escape. A failure is classified from the response's status and Stripe's error envelope (`{ error: { type, code, message, param } }`), the status winning for 401, 403 and 429 as in the SDK:

| Stripe failure | Neutral error |
| --- | --- |
| 401, or `type: "authentication_error"` | `PaymentAuthenticationError` |
| 429, or `type: "rate_limit_error"` | `PaymentRateLimitError` (`retryAfter` from `Retry-After`) |
| `type: "invalid_request_error"` | `PaymentInvalidRequestError` (`param` from the envelope) |
| a connection failure or timeout | `PaymentNetworkError` |
| anything else: a card error, 403 (permission), an idempotency error, an API error, a non-Stripe error page | `PaymentProviderError` (`provider: "stripe"`, `code` Stripe's `code`, or the kind when it sent none: `StripeCardError`, `StripePermissionError`, `StripeIdempotencyError`, `StripeAPIError`, …) |
| a 2xx a capability cannot decode | `PaymentProviderError` |

A failure the client retries (a connection failure, `409`, a `5xx`, `Stripe-Should-Retry: true`) surfaces only after the last attempt. The key never reaches an error or a log line.
