/**
 * Airwallex implementations of the vendor-neutral payments capabilities.
 *
 * Airwallex's payment-acceptance API maps naturally onto the `Customers`,
 * `PaymentIntents` and `Refunds` capabilities. It has no first-class catalog or
 * subscription billing in the same shape as the core's `Products`, `Prices` and
 * `Subscriptions`, so this provider simply does not implement those — because
 * each capability is its own service, a program only needs to provide the
 * capabilities it actually uses.
 *
 * A few individual operations also have no Airwallex equivalent (deleting a
 * customer, updating a payment intent or refund). Those fail with a neutral
 * {@link PaymentInvalidRequestError} rather than pretending to succeed.
 *
 * @module
 */

import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
// The capability modules are imported by subpath, as namespaces: a bundler can
// then tell that the tags passed to the pure layer constructions below are
// side-effect free, and drop every capability (and its decoders) a program
// does not use.
import * as BillingPortalNS from "@thomasfosterau/effect-biz/Payments.BillingPortal";
import * as CheckoutSessionNS from "@thomasfosterau/effect-biz/Payments.CheckoutSession";
import * as CustomerNS from "@thomasfosterau/effect-biz/Payments.Customer";
import * as IdempotencyKeyNS from "@thomasfosterau/effect-biz/Payments.IdempotencyKey";
import * as PaymentIntentNS from "@thomasfosterau/effect-biz/Payments.PaymentIntent";
import * as RefundNS from "@thomasfosterau/effect-biz/Payments.Refund";
import * as StubNS from "@thomasfosterau/effect-biz/Payments.Stub";
import {
  type Page,
  PaymentInvalidRequestError,
  type PaymentsError,
} from "@thomasfosterau/effect-biz/Payments";
import {
  AirwallexClient,
  layer as clientLayer,
  layerFromEnv as clientLayerFromEnv,
  type AirwallexConfig,
  type AirwallexRequest,
} from "./Airwallex.js";
import {
  decodeCustomer,
  decodeCustomerPage,
  decodePaymentIntent,
  decodePaymentIntentCurrency,
  decodePaymentIntentPage,
  decodeRefund,
  decodeRefundPage,
} from "./internal/mapping.js";
import { checkMinorUnits, pageNumberedList } from "@thomasfosterau/effect-biz/Payments.internal";
import { toMajorNumber } from "./internal/money.js";

/** A fresh idempotency key for a write request. */
const requestId = (): string => globalThis.crypto.randomUUID();

/**
 * The body of a payment intent confirmation: a fresh `request_id`, plus the
 * `payment_method` only when the caller names one.
 */
const confirmBody = (paymentMethod: string | undefined) => {
  const request_id = requestId();
  return paymentMethod ? { request_id, payment_method: { id: paymentMethod } } : { request_id };
};

/**
 * `client.request` for a neutral write: the caller's idempotency key, checked,
 * becomes the request's `requestId`, which the client writes over the fresh
 * `request_id` in the body. With no key the body keeps its fresh id (which
 * deduplicates nothing across a caller's retry).
 */
const write = (
  client: AirwallexClient["Service"],
  request: Omit<AirwallexRequest, "requestId">,
  idempotencyKey: string | undefined,
): Effect.Effect<unknown, PaymentsError> =>
  Effect.flatMap(IdempotencyKeyNS.validate(idempotencyKey), (requestId) =>
    client.request({ ...request, requestId }),
  );

/** Fail with a neutral error for an operation Airwallex does not support. */
const notSupported = (operation: string): Effect.Effect<never, PaymentsError> =>
  Effect.fail(
    new PaymentInvalidRequestError({
      message: `Airwallex does not support ${operation}`,
    }),
  );

/**
 * One page of an Airwallex list. A filter Airwallex cannot apply (`refused`,
 * when set) fails first; then `startingAfter` (a previous page's
 * `nextCursor`) names the 0-based `page_num` to request, and the result
 * carries the cursor of the page after it.
 */
const listPage = <A>(
  params:
    | { readonly limit?: number | undefined; readonly startingAfter?: string | undefined }
    | undefined,
  refused: string | undefined,
  list: (pageNum: number | undefined) => Effect.Effect<Page<A>, PaymentsError>,
): Effect.Effect<Page<A>, PaymentsError> =>
  (refused === undefined ? Effect.void : notSupported(refused)).pipe(
    Effect.andThen(pageNumberedList(params, { provider: "Airwallex", firstPage: 0 }, list)),
  );

// ---------------------------------------------------------------------------
// Customers
// ---------------------------------------------------------------------------

/**
 * Refuse a customer `description`, which this provider does not map onto an
 * Airwallex field, rather than drop it.
 */
const refuseDescription = (description: string | undefined): Effect.Effect<void, PaymentsError> =>
  description === undefined ? Effect.void : notSupported("customer descriptions");

/**
 * Airwallex customers as the {@link CustomerNS.Customers} capability. `list`
 * pages by page number through `nextCursor`, and refuses the `email` filter
 * with {@link PaymentInvalidRequestError}. `del`
 * fails with {@link PaymentInvalidRequestError} (Airwallex has no
 * delete-customer endpoint), and so do a `create` or `update` that set a
 * `description` (this provider maps no Airwallex field to it).
 */
export const customersLayer: Layer.Layer<CustomerNS.Customers, never, AirwallexClient> =
  /* @__PURE__ */ Layer.effect(
    CustomerNS.Customers,
    /* @__PURE__ */ Effect.map(AirwallexClient, (client) =>
      CustomerNS.Customers.of({
        create: (params) =>
          Effect.andThen(refuseDescription(params.description), () =>
            write(
              client,
              {
                method: "POST",
                path: "/api/v1/pa/customers",
                body: {
                  request_id: requestId(),
                  email: params.email,
                  first_name: params.name,
                  phone_number: params.phone,
                  metadata: params.metadata,
                },
              },
              params.idempotencyKey,
            ),
          ).pipe(Effect.flatMap(decodeCustomer)),
        retrieve: (id) =>
          client
            .request({
              method: "GET",
              path: `/api/v1/pa/customers/${id}`,
            })
            .pipe(Effect.flatMap(decodeCustomer)),
        update: (id, params) =>
          Effect.andThen(refuseDescription(params.description), () =>
            client.request({
              method: "POST",
              path: `/api/v1/pa/customers/${id}/update`,
              body: {
                request_id: requestId(),
                email: params.email,
                first_name: params.name,
                phone_number: params.phone,
                metadata: params.metadata,
              },
            }),
          ).pipe(Effect.flatMap(decodeCustomer)),
        del: () => notSupported("deleting customers"),
        list: (params) =>
          listPage(
            params,
            params?.email === undefined ? undefined : "filtering customers by email",
            (pageNum) =>
              client
                .request({
                  method: "GET",
                  path: "/api/v1/pa/customers",
                  query: { page_size: params?.limit, page_num: pageNum },
                })
                .pipe(Effect.flatMap(decodeCustomerPage)),
          ),
      }),
    ),
  );

// ---------------------------------------------------------------------------
// PaymentIntents
// ---------------------------------------------------------------------------

/**
 * Airwallex payment intents as the {@link PaymentIntentNS.PaymentIntents}
 * capability. `list` pages by page number through `nextCursor`. `update` fails with {@link PaymentInvalidRequestError}; use
 * `confirm` or `cancel`.
 */
export const paymentIntentsLayer: Layer.Layer<
  PaymentIntentNS.PaymentIntents,
  never,
  AirwallexClient
> = /* @__PURE__ */ Layer.effect(
  PaymentIntentNS.PaymentIntents,
  /* @__PURE__ */ Effect.map(AirwallexClient, (client) =>
    PaymentIntentNS.PaymentIntents.of({
      create: (params) =>
        toMajorNumber(params.amount, params.currency, "amount").pipe(
          Effect.flatMap((amount) =>
            write(
              client,
              {
                method: "POST",
                path: "/api/v1/pa/payment_intents",
                body: {
                  request_id: requestId(),
                  amount,
                  currency: params.currency,
                  customer_id: params.customer,
                  descriptor: params.description,
                  metadata: params.metadata,
                },
              },
              params.idempotencyKey,
            ),
          ),
          Effect.flatMap(decodePaymentIntent),
        ),
      retrieve: (id) =>
        client
          .request({
            method: "GET",
            path: `/api/v1/pa/payment_intents/${id}`,
          })
          .pipe(Effect.flatMap(decodePaymentIntent)),
      update: () => notSupported("updating payment intents"),
      confirm: (id, params) =>
        write(
          client,
          {
            method: "POST",
            path: `/api/v1/pa/payment_intents/${id}/confirm`,
            body: confirmBody(params?.paymentMethod),
          },
          params?.idempotencyKey,
        ).pipe(Effect.flatMap(decodePaymentIntent)),
      cancel: (id) =>
        client
          .request({
            method: "POST",
            path: `/api/v1/pa/payment_intents/${id}/cancel`,
            body: { request_id: requestId() },
          })
          .pipe(Effect.flatMap(decodePaymentIntent)),
      list: (params) =>
        listPage(params, undefined, (pageNum) =>
          client
            .request({
              method: "GET",
              path: "/api/v1/pa/payment_intents",
              query: { page_size: params?.limit, customer_id: params?.customer, page_num: pageNum },
            })
            .pipe(Effect.flatMap(decodePaymentIntentPage)),
        ),
    }),
  ),
);

// ---------------------------------------------------------------------------
// Refunds
// ---------------------------------------------------------------------------

/**
 * Airwallex refunds as the {@link RefundNS.Refunds} capability. A refund
 * references a `paymentIntent`: `create` without one (a `charge` only) fails
 * with {@link PaymentInvalidRequestError}, and so do `update` and a `list`
 * filtered by `charge`. `list` pages by page number through `nextCursor`.
 */
export const refundsLayer: Layer.Layer<RefundNS.Refunds, never, AirwallexClient> =
  /* @__PURE__ */ Layer.effect(
    RefundNS.Refunds,
    /* @__PURE__ */ Effect.map(AirwallexClient, (client) =>
      RefundNS.Refunds.of({
        create: Effect.fn("AirwallexPayments.Refunds.create")(function* (params) {
          if (!params.paymentIntent) {
            return yield* notSupported(
              "refunds without a payment intent (charges are not supported)",
            );
          }
          // Refuse a bad key, or a negative or fractional amount, before the
          // currency lookup.
          const idempotencyKey = yield* IdempotencyKeyNS.validate(params.idempotencyKey);
          if (params.amount != null) yield* checkMinorUnits(params.amount, "amount");
          // The neutral amount is in minor units; Airwallex needs major units,
          // and the conversion depends on the currency, so resolve it from the
          // payment intent when a partial amount is requested.
          const minor = params.amount;
          const amount =
            minor == null
              ? undefined
              : yield* client
                  .request({
                    method: "GET",
                    path: `/api/v1/pa/payment_intents/${params.paymentIntent}`,
                  })
                  .pipe(
                    Effect.flatMap(decodePaymentIntentCurrency),
                    Effect.flatMap((currency) => toMajorNumber(minor, currency, "amount")),
                  );
          return yield* client
            .request({
              method: "POST",
              path: "/api/v1/pa/refunds",
              body: {
                request_id: requestId(),
                payment_intent_id: params.paymentIntent,
                amount,
                reason: params.reason,
                metadata: params.metadata,
              },
              requestId: idempotencyKey,
            })
            .pipe(Effect.flatMap(decodeRefund));
        }),
        retrieve: (id) =>
          client
            .request({
              method: "GET",
              path: `/api/v1/pa/refunds/${id}`,
            })
            .pipe(Effect.flatMap(decodeRefund)),
        update: () => notSupported("updating refunds"),
        list: (params) =>
          listPage(
            params,
            params?.charge === undefined
              ? undefined
              : "filtering refunds by charge (charges are not supported)",
            (pageNum) =>
              client
                .request({
                  method: "GET",
                  path: "/api/v1/pa/refunds",
                  query: {
                    page_size: params?.limit,
                    payment_intent_id: params?.paymentIntent,
                    page_num: pageNum,
                  },
                })
                .pipe(Effect.flatMap(decodeRefundPage)),
          ),
      }),
    ),
  );

// ---------------------------------------------------------------------------
// Hosted checkout and billing portal (unsupported)
// ---------------------------------------------------------------------------

/**
 * The {@link CheckoutSessionNS.CheckoutSessions} capability for Airwallex: every
 * call fails with {@link PaymentInvalidRequestError}, because this provider
 * does not implement the neutral hosted checkout. It is not part of
 * {@link capabilities} — a program that needs hosted checkout does not
 * type-check against Airwallex by default — and exists for a program that must
 * run on several providers and handles the failure itself.
 */
export const checkoutSessionsLayer: Layer.Layer<CheckoutSessionNS.CheckoutSessions> =
  /* @__PURE__ */ StubNS.checkoutSessions(/* @__PURE__ */ notSupported("hosted checkout sessions"));

/**
 * The {@link BillingPortalNS.BillingPortalSessions} capability for Airwallex:
 * every call fails with {@link PaymentInvalidRequestError}, because this
 * provider has no hosted billing portal. Like {@link checkoutSessionsLayer}, it
 * is not part of {@link capabilities}.
 */
export const billingPortalSessionsLayer: Layer.Layer<BillingPortalNS.BillingPortalSessions> =
  /* @__PURE__ */ StubNS.billingPortalSessions(
    /* @__PURE__ */ notSupported("billing portal sessions"),
  );

// ---------------------------------------------------------------------------
// Bundles
// ---------------------------------------------------------------------------

/**
 * The capabilities Airwallex implements (`Customers`, `PaymentIntents`,
 * `Refunds`), built on top of an existing {@link AirwallexClient}.
 */
export const capabilities: Layer.Layer<
  CustomerNS.Customers | PaymentIntentNS.PaymentIntents | RefundNS.Refunds,
  never,
  AirwallexClient
> = /* @__PURE__ */ Layer.mergeAll(customersLayer, paymentIntentsLayer, refundsLayer);

/**
 * The Airwallex client and its capabilities in one layer, built from
 * configuration. Requires an `HttpClient` (`FetchHttpClient.layer`).
 *
 * @example
 * ```typescript
 * import { Effect, Layer, Redacted } from "effect";
 * import { FetchHttpClient } from "effect/http";
 * import * as Customer from "@thomasfosterau/effect-biz/Payments.Customer";
 * import * as AirwallexPayments from "@thomasfosterau/effect-biz-payments-airwallex/AirwallexPayments";
 *
 * const program = Customer.create({ email: "jane@example.com" });
 *
 * const layer = AirwallexPayments.layer({
 *   clientId: "...",
 *   apiKey: Redacted.make("..."),
 * }).pipe(Layer.provide(FetchHttpClient.layer));
 * // Calls Airwallex when invoked, so it needs real credentials.
 * const run = () => Effect.runPromise(program.pipe(Effect.provide(layer)));
 * ```
 */
export const layer = (config: AirwallexConfig) => Layer.provide(capabilities, clientLayer(config));

/**
 * The Airwallex client and its capabilities in one layer, with the client
 * built from environment variables (`AIRWALLEX_CLIENT_ID`, `AIRWALLEX_API_KEY`,
 * the required `AIRWALLEX_ENV` of `live` or `sandbox`, and the optional
 * `AIRWALLEX_BASE_URL` override; see `Airwallex.layerFromEnv`). Requires an
 * `HttpClient` (`FetchHttpClient.layer`).
 */
export const layerFromEnv = (clientIdVar?: string, apiKeyVar?: string) =>
  Layer.provide(capabilities, clientLayerFromEnv(clientIdVar, apiKeyVar));
