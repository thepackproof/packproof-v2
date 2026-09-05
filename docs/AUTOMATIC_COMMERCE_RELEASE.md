# Automatic commerce intake — September 5, 2026

The U7 implementation uses the existing transaction import service and canonical one-Proof-per-transaction model. Orders become actionable after an explicit seller opt-in; a connected OAuth account alone does not enable background creation.

## Delivered contract

- `POST /me/commerce-connections/:connectionId/automation` with `{ "enabled": true }` activates durable initial work. Setting false fences in-flight work and pauses future reads. Only the owner can change this setting.
- `GET /me/integration-connections?capability=commerce` reports the opt-in, policy, initial completion, latest attempt/success, retry state, progress and ready-order count. OAuth success and a successful full order read remain distinct.
- `POST /me/commerce-connections/:connectionId/sync` remains an explicit recovery command. It resumes saved pages and clears its page cursor on completion. A pass is bounded to 20 pages; background work processes up to five pages per connection per tick and continues until complete.
- `GET /transactions/:id/commerce-context` returns the authorized participant's operational order projection and recent immutable source revisions, including remaining quantities, variants, fulfillment/package identities when provided. This projection never substitutes for a finalized manifest.

Paid physical orders awaiting fulfillment or partially fulfilled orders are eligible. Cancelled, held, fully fulfilled, unpaid and digital-only orders are excluded. A label, tracking number or buyer account is not required. Missing values remain unknown rather than being invented. Shopify fulfillment IDs and available line quantities are preserved as source context; they do not create multiple root Proofs. Unavailable partial quantities remain unknown.

## Worker and recovery

`src/index.ts` runs the commerce worker by default; set `PACKPROOF_COMMERCE_WORKER=false` to stop it for rollback. It operates independently of browser tabs and only touches opted-in active connections. The 15-second worker tick checks for work; successful connections become due after 60 seconds. Initial reads and periodic reconciliation cover a bounded recent 60-day update window, subject to provider access. Incremental reads overlap 15 minutes; full reconciliation runs every 15 minutes. These are scheduling settings, not published latency guarantees.

Migration 027 adds database leases with fencing tokens, page/window checkpoints, attempts, backoff, initial completion, progress, append-only source revisions and a minimal webhook inbox. Retries start at 30 seconds and cap at 15 minutes. After eight consecutive failures or a non-retryable error, the connection enters an inspectable FAILED state. Manual refresh or explicitly enabling automation again retries the checkpoint. Reauthorization resumes a previously enabled connection without adding consent to another connection.

Transport reads have 20-second deadlines. Token refresh keeps the existing eBay refresh token when the provider returns only a replacement access token. Temporary provider failures remain retryable instead of automatically becoming reconnect demands. Disconnect, revoked credentials, scope errors and expired worker leases cannot authorize later commits.

Shopify order and fulfillment webhooks are HMAC verified before a minimal delivery ID/topic/connection invalidation is persisted. The endpoint then acknowledges delivery. Workers refetch authoritative provider state; payload contents cannot set Proof state. Duplicate delivery IDs are harmless. Scheduled reads also repair missed notifications. Shopify webhook subscriptions must be configured on the authorized app before webhook latency can be claimed. eBay intake uses polling; account-deletion signatures stay on the existing boundary.

## Evidence and identity boundaries

Source revisions compare provider update times while holding an order lock. Older provider versions cannot overwrite newer operational state. Unknown timestamps cannot replace known timestamps. Same-timestamp reads follow the current authoritative provider read; webhooks never apply an untrusted event snapshot directly.

Each revision retains connection, source record, provider update time, observation time, mapping version, normalized content and digest. Before finalization, permitted source changes use the existing import service. Seller corrections mark affected context as participant supplied, retain the original provider source and corrected field list, and survive later provider refreshes. After finalization, changes are preserved as separate source supplements; the exact canonical JSON and digest remain unchanged. Cancellation only changes operational eligibility and never deletes evidence.

eBay identities now include provider environment and a digest of the immutable OAuth merchant user ID; display-name changes do not allocate new Proofs. Existing environment-only imports gain an owner-checked scoped alias to the same transaction, preserving old identities and manifests. Manual and automatic intake share this namespace. Tenant normalization accepts periods consistently with existing merchant account validation. Store identity collisions are prevented by database constraints.

## Validation and operational gates

Automated checks cover pagination and cursor clearing, failed-page recovery, retry backoff, cancellation ordering, source immutability, finalized-snapshot preservation, seller-correction provenance, opt-in background creation, pause, duplicate webhook invalidations, foreign-store rejection, lease recovery and eBay refresh responses. Shopify GraphQL transport checks cover exact numeric identities, migration from REST checkpoints, frozen search windows, nested item pagination, duplicate cursors, revision races, HTTP-200 errors, tenant isolation and lease heartbeats. Existing connected-account and eBay tests additionally cover OAuth, revoked authorization, account deletion and persisted credentials.

A real production order has **not** been imported in this development environment. To release a provider, verify its app approval, authorized seller, granted scopes, billing/quota limits, initial/paged order read, token expiry/reconnect, cancellation and a new eligible order created while no PackProof browser tab is open. Retain the exact deployed web/API revision and test evidence. The plan's seller usability test, real Android/browser walkthrough and provider p95 latency targets require that deployed environment.

The Shopify adapter uses Admin GraphQL version 2026-07 for shop identity, orders, fulfillment items and uninstall. OAuth requests only `read_orders`, which permits the order and fulfillment fields used here. Search windows include a creation-date floor of 60 days; `read_all_orders` and buyer personal data are not requested. The callback rejects missing order access instead of fabricating granted scopes. Shopify app approval and live merchant authorization remain provider-managed gates; this implementation does not establish approval. eBay production keysets and merchant authorization likewise remain provider-managed gates. Demo adapters never establish provider readiness.

GraphQL order pages contain at most ten summaries. Each order's line items and each fulfillment's line items are independently paged in groups of 100; fulfillment arrays are requested without truncation. Each network read renews and checks the fenced worker lease. Order and fulfillment revisions are compared across reads, followed by a final order revision check; a changing order is retried before any partial page can be checkpointed. Repeated nested cursors or more than 250 nested continuation pages produce an inspectable error instead of partial data. Existing REST checkpoints restart their frozen window; exact decimal legacy order/item/fulfillment IDs preserve canonical Proof identity. GraphQL continuation state stores only the shop, provider cursor and validated time bounds, never a provider-supplied URL or token. Removed items use Shopify's current quantity, and zero-current-quantity lines do not enter the active packing checklist.

All seven GraphQL operations passed the Shopify Admin skill's schema validator on 2026-09-05. Its bundled schema is 2026-04; the runtime remains pinned to 2026-07, and the selected fields, enum mappings and scope alternatives were checked against Shopify's current 2026-07 reference. Production store transport and app review still require the operator's actual app credentials and granted store access.

## Primary references

- [Shopify GraphQL orders](https://shopify.dev/docs/api/admin-graphql/2026-07/queries/orders): cursor pagination and updated-date search.
- [Shopify Order](https://shopify.dev/docs/api/admin-graphql/2026-07/objects/Order), [Fulfillment](https://shopify.dev/docs/api/admin-graphql/2026-07/objects/Fulfillment), and [FulfillmentLineItem](https://shopify.dev/docs/api/admin-graphql/2026-07/objects/FulfillmentLineItem): recent order access, read scope alternatives and nested data.
- [Shopify global IDs](https://shopify.dev/docs/api/usage/gids): equivalent REST and GraphQL resource identity.
- [Shopify webhook guidance](https://shopify.dev/docs/apps/build/webhooks): verify deliveries, deduplicate and reconcile source state.
- [Shopify appUninstall](https://shopify.dev/docs/api/admin-graphql/2026-07/mutations/appUninstall): disconnect through GraphQL.
- [eBay authorization](https://developer.ebay.com/develop/guides/sell/authorization): server token refresh and revoked consent.
- [eBay getOrders](https://developer.ebay.com/api-docs/sell/fulfillment/resources/order/methods/getOrders): bounded order reads, paging and modified-date filters.

The eBay parser uses provider `fulfillmentStartInstructions` to identify physical shipping; digital and unknown fulfillment methods do not silently become physical orders. Unit prices divide `lineItemCost` by quantity, as confirmed by the [official eBay OpenAPI contract](https://developer.ebay.com/api-docs/master/sell/fulfillment/openapi/3/sell_fulfillment_v1_oas3.json). Shopify physical eligibility requires an explicit `requiresShipping: true` line with a positive current quantity.
