# Shopify order event subscriptions

PackProof configures shop-scoped GraphQL subscriptions after a seller's OAuth credentials have been stored. The receiver is the HTTPS public API base configured by `PACKPROOF_PUBLIC_URL` plus `/integrations/webhooks/shopify`, preserving any API path prefix. The OAuth callback uses the same public base plus `/oauth/shopify/callback`. Credentials and webhook payloads are never logged by registration or ingestion.

Registration is idempotent: list all pages of existing subscriptions for the configured endpoint and authorized topics, reuse matching subscriptions, repair filtered subscriptions on that endpoint, and create missing subscriptions. A partially successful registration can resume. HTTP 429 and GraphQL `THROTTLED` responses preserve provider retry guidance. A reported duplicate is accepted only after a fresh API read confirms a matching subscription. Registration failure retains the seller's stored access token and is surfaced in connection capability metadata; the access runner retries it. Scheduled reconciliation remains the recovery path for delayed or dropped notifications.

Do not configure duplicate app-scoped subscriptions for the same order topics in `shopify.app.toml`. Shopify's `webhookSubscriptions` query only lists shop-scoped API subscriptions and cannot detect app-scoped subscriptions.

## Registered topics

| Granted permission | Topics |
| --- | --- |
| Installed application | `app/uninstalled` |
| `read_orders` or `write_orders` | `orders/create`, `orders/updated`, `orders/paid`, `orders/cancelled`, `orders/fulfilled`, `fulfillments/create`, `fulfillments/update` |
| Fulfillment-order read or write scope | `fulfillment_orders/order_routing_complete`, `fulfillment_orders/hold_released`, `fulfillment_orders/placed_on_hold`, `fulfillment_orders/scheduled_fulfillment_order_ready`, `fulfillment_orders/rescheduled`, `fulfillment_orders/moved`, `fulfillment_orders/split`, `fulfillment_orders/merged` |

The fulfillment-order scope can be merchant managed, assigned, third party, or marketplace. PackProof's order fulfillment integration requests merchant-managed access. Subscription setup never requests fulfillment-write permission and never marks an order fulfilled.

The endpoint verifies the HMAC against raw request bytes before processing any topic. An invalid signature returns 401. Recognized order and fulfillment topics create a minimal, deduplicated invalidation for an active store with automatic synchronization enabled. Each invalidation stores the connection, delivery identity, topic, and receipt time; it does not store the customer or order payload. The worker reads Shopify's authoritative order state before deciding whether to create or update a Proof. A repeat delivery acknowledges receipt with `queued: false`. `app/uninstalled` disconnects the integration and removes its access credentials.

Connection capabilities distinguish subscription configuration from successful delivery: `webhookSubscriptionsVerified`, `webhookSubscriptionsVerifiedAt`, `webhookRegistrationErrorCode`, `webhookTopics`, `expectedWebhookTopics`, `webhookDeliveryVerified`, and `lastWebhookReceivedAt`. Subscription verification alone does not claim an actual delivery.

## Public app distribution gate

This fulfillment change does not implement Shopify privacy request processing. Verified `customers/data_request`, `customers/redact`, and `shop/redact` deliveries return `503 SHOPIFY_PRIVACY_HANDLER_UNAVAILABLE`; they are never silently acknowledged as complete or queued. These three compliance subscriptions cannot be provisioned through the shop-scoped Admin API registration flow.

Before submitting or distributing PackProof through the Shopify App Store:

1. Implement durable privacy case intake, access/export or deletion processing, and operational handling of retention obligations for immutable evidence. Include legacy Shopify data and seller-uploaded evidence in the assessment; omitting customer fields from new API queries is insufficient by itself.
2. Configure the three mandatory compliance topics in the app's `shopify.app.toml`, deploy that application configuration, and point them at the implemented processing endpoint.
3. Test valid and invalid HMAC delivery, duplicate handling, durable case receipt, and end-to-end completion. Shopify requires invalid-HMAC requests to return 401 and compliance actions to be handled within its required time frame.

Do not configure the current receiver as a working privacy handler or describe public-app compliance as complete.

## References

- [Shopify webhook subscriptions query](https://shopify.dev/docs/api/admin-graphql/latest/queries/webhookSubscriptions)
- [Subscription input](https://shopify.dev/docs/api/admin-graphql/latest/input-objects/WebhookSubscriptionInput)
- [Webhook subscription topics and scopes](https://shopify.dev/docs/api/admin-graphql/latest/enums/WebhookSubscriptionTopic)
- [Privacy law compliance](https://shopify.dev/docs/apps/build/compliance/privacy-law-compliance)

The list, create, and update operations were checked with Shopify's schema validator during implementation. Subscription and ingestion behavior is covered by `backend/tests/shopify-webhooks.test.ts`.
