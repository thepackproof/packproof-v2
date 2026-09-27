# Shopify fulfillment Proofs

This implementation extends the existing connected-account and commerce worker paths. It does not create a separate order database or a second Proof lifecycle.

## Seller flow

1. Open Account → Sales channels, enter the Shopify shop, and leave **Automatically start Proofs for orders ready to fulfill** selected (or clear it).
2. Authorize PackProof in Shopify. The explicit choice travels in the single-use, seller-bound OAuth state.
3. The background worker checks existing accessible orders and future changes. An eligible order receives one transaction-bound Proof in `READY_FOR_EVIDENCE`, ready in the seller's packing queue.
4. Record and confirm the packing evidence through the existing capture flow. Importing an order does not fabricate evidence, finalize a Proof, mark the Shopify order fulfilled, purchase a label, or notify the buyer.
5. Turn automatic orders off to pause, turn it on to resume, or use **Check for orders now**. Reconnecting preserves the previous pause/opt-in setting. Existing connections are not silently opted in.

Shopify's standard `read_orders` access covers orders created in the last 60 days. Older open orders require Shopify-approved `read_all_orders` access and are not promised by this release.

## Eligibility and identity

- Admin GraphQL is pinned to `2026-07`. Required scopes are `read_orders`, `read_merchant_managed_fulfillment_orders` and `read_locations` (corresponding write scopes also satisfy read access). Previously connected shops must reconnect to grant the additional fulfillment and location scopes.
- Order, order-line, fulfillment, fulfillment-order, and fulfillment-order-line pages are independently paginated. Revision checks reject a changing source rather than combining incompatible pages.
- Ready work comes from merchant-managed fulfillment orders, their status, delivery method, and remaining physical line quantities. Test, cancelled, fully fulfilled, digital-only, held, scheduled, and unsupported split/mixed assignments do not create a ready Proof. Review counts explain the relevant excluded work.
- A pending-payment/COD order can qualify only when the authoritative Shopify fulfillment data says the merchant shipment is ready. Its payment status remains pending; PackProof does not assert that it has been paid.
- A supported single remaining shipment has an explicit source scope. Its checklist covers only the remaining items; previously shipped items and tracking are not represented as newly captured. Existing full-order records cannot silently become remaining-shipment records. Multiple ready shipments or inconsistent allocations require review.
- The existing stable Shopify shop namespace and external order ID remain unchanged. Unique transaction identity plus one Proof per transaction deduplicate initial backfill, polling, exact lookup, reconnects, and repeated webhook deliveries. Later updates remain source revisions; finalized manifests remain immutable.

## Authentication and event recovery

New OAuth exchanges request expiring offline access. Access/refresh tokens and expiries are stored only in the existing managed credential store. Refresh is serialized per shop across workers, API requests, reconnects, and disconnects. Workers refresh before expiry and retry a provider authorization failure once. Missing or revoked authorization requests reconnect; transient errors preserve credentials and use existing retry scheduling.

The Shopify client ID/secret identify the app; each seller must still authorize their own shop. Tokens are bound to that shop and PackProof account. A competing owner cannot retire the legitimate owner's token through a rejected callback.

After credentials are saved, PackProof reconciles webhook subscriptions. Subscription failure is recorded independently and retried; it does not discard successful OAuth credentials. Periodic polling remains the recovery path. The webhook endpoint verifies the HMAC over raw bytes before creating a minimal durable invalidation. Repeated deliveries are deduplicated within their shop.

Fulfillment routing and hold changes can occur without an order timestamp change. Pending invalidations therefore trigger a full accessible-order reconciliation. Events received after the frozen start of a paginated pass remain pending and schedule another pass, including when processing resumes in a different worker invocation.

See [Shopify webhook operations](shopify-webhooks.md) for subscription topics, capability reporting, and the separate mandatory privacy-handler gate for public App Store distribution.

## Deployment and configuration

Preserve the existing deployment topology and all other runtime values. The recorded `packproof-v2-staging-api` service runs the API and background jobs together with `PACKPROOF_PROCESS_ROLE` unset (the `combined` default). Configure Shopify on that service. If a separate API and worker deployment is confirmed, configure Shopify on both services.

| Setting | Value |
| --- | --- |
| `PACKPROOF_SHOPIFY_INTEGRATION_ENABLED` | `true` |
| `PACKPROOF_SHOPIFY_CLIENT_ID` | Registered Shopify app client ID |
| `PACKPROOF_SHOPIFY_APP_CREDENTIAL_REFERENCE` | Managed secret reference containing `{"clientSecret":"…"}` |
| `PACKPROOF_CREDENTIAL_STORE` | `secrets-manager` in hosted environments |
| `PACKPROOF_COMMERCE_AUTOMATION_PROVIDERS` | Include `shopify`, retaining any already enabled providers |
| `PACKPROOF_PUBLIC_URL` | Actual public API base URL, including `/api` if applicable |
| `PACKPROOF_PROCESS_ROLE` | Preserve unset or `combined` on the existing combined service; use `api` and `worker` only for an established split deployment |
| `PACKPROOF_COMMERCE_WORKER` | Must not be `false` on the process running background jobs |

Register `<public API base>/oauth/shopify/callback` as the allowed Shopify redirect. PackProof derives `<public API base>/integrations/webhooks/shopify`, preserving any API path prefix, and provisions shop subscriptions. Keep the secret in managed runtime configuration, never Vite/Expo variables or source code. The app/task role needs access to the existing integration secret namespace.

Apply the repository's additive migrations through its established deployment gate, then deploy the tested release to the existing combined service, or the same release to both services if the deployment is already split. This change introduces no new database migration. Preserve the current deployment configuration, signing settings, origins, and unrelated integrations; do not use a legacy deployment script that replaces them.

Acceptance after deployment:

- Confirm exact `/meta` release identity, API health, worker health and a recent `commerce` heartbeat.
- Connect an authorized shop and verify the granted scopes, token expiry persistence, subscription status, and successful order-read timestamp.
- Verify one real ready order appears as one `READY_FOR_EVIDENCE` Proof while the browser is closed; replay/sync again and confirm no second Proof.
- Check pause/resume, a provider order update and a real HMAC-verified webhook. Fixture tests do not prove live Shopify access or delivery.
- Record/finalize a real test shipment and verify the manifest remains intact after subsequent Shopify updates. Verify refresh and reconnect preserve the same shop and Proof identity.

Rollback automatic intake by removing only `shopify` from the provider rollout list or pausing an individual connection. Preserve tokens, checkpoints, source revisions, existing Proofs and immutable evidence unless the seller disconnects. No database reset is required.

## Execution status

Implementation and automated verification are recorded in the implementation commit/PR. AWS access was restored on 2026-09-24. Runtime configuration and deployment receipts, plus live merchant-order verification, remain pending. Successful local tests do not establish a live rollout.
