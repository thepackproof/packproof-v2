# PackProof intake: connected commerce execution

Implementation date: 2026-09-15. This record describes code and local validation, not a live order-read or deployed store capability. Deployment identity and actual provider-read evidence belong in `INTAKE_DEPLOYMENT_CONTEXT.md`.

## Existing paths reused

`commerce-fulfillment-sync.ts` remains the single source normalization/import path. Both `fetchAndImportCommerceOrder` and scheduled pages call its same transaction-scoped importer, preserving `tenantKeyForImport` + stable commerce account + provider order ID, existing `importNormalizedTransaction`, one canonical transaction/Proof, line-item quantities, fulfillment eligibility, append-only source revisions, and finalized manifests. Exact reads do not advance the background sync checkpoint. No provider mutation or buyer invitation is added.

| Provider | Exact order read | Incremental reads / pagination | Stable namespace | Production verification in this execution |
| --- | --- | --- | --- | --- |
| eBay | Existing Fulfillment `getOrder`, seller token, current order ID | `lastmodifieddate` bounded window; 50 orders/page; persisted offset | Existing environment + stable eBay user identity (existing hash format), never connection ID or username | Not available: no authorized live API response has been observed by this work package |
| Shopify | Existing Admin GraphQL `order(id:)` hydration, numeric legacy ID preserved as a string | Existing `updated_at` window and opaque GraphQL cursor; 10 orders/page; nested line/fulfillment pages and revision checks retained | Existing shop-handle tenant; OAuth verifies `myshopifyDomain`; no namespace migration | Not available: no authorized live API response has been observed by this work package |
| Etsy | Existing exact receipt adapter, not newly enabled by this work | Existing paid/unshipped initial pass and incremental receipt pagination retained | Existing numeric shop identity | Existing code compatibility tested; no new live capability claim |

Shopify remains pinned to Admin API `2026-07`, requesting `read_orders`. Product barcode fields are read only when `read_products`/`write_products` was already granted; this release adds no scope. Default Shopify access excludes orders older than 60 days. eBay/Shopify reconcile the bounded 60-day source window once daily and overlap incremental reads by 15 minutes. Existing Etsy reconciliation policy is retained. Unpaid, cancelled, digital-only, fully fulfilled and unsupported partial orders do not create ready Proofs; partial quantity/package details already represented by the provider adapter remain intact.

## Durable scheduling and recovery

Use the existing backend image and `backend/src/index.ts` worker entry path. PostgreSQL stores connection opt-in, next-run time, frozen source window, cursor, attempt count, 120-second renewable lease/fencing token and last success. No additional queue service is required. The operational scheduler records `commerce` heartbeats in `operational_worker_heartbeats`; the API role does not run jobs.

Each dispatch selects at most five eligible connections and processes at most five fully imported pages per connection. Selection filters the provider rollout list before applying the connection limit, so disabled providers cannot starve enabled ones. Completed windows schedule the next poll at five minutes plus deterministic 0–10% connection jitter; incomplete windows resume at the next scheduler tick. Expired leases permit recovery after process death. A competing worker losing a lease does not count as a provider outage.

Migration `068_commerce_sync_checkpoints.sql` adds only an operational checkpoint table. SHA-256 hashes of completed outgoing cursors detect loops across process restarts and page budgets, not only within a single invocation. Completed windows clear their hashes. Replaying an imported page reuses its normalized fingerprint and canonical Proof without another source import/audit event.

Ordinary transient failures use exponential backoff starting at 30 seconds, connection jitter, a 15-minute cap, and an exhausted `FAILED` state after eight attempts. Provider 429/quota responses honor numeric/date `Retry-After`; Shopify GraphQL `THROTTLED` additionally uses requested cost, available capacity and restore rate. Rate-limit cooldowns remain retryable without exhausting ordinary outage attempts. A revoked token sets reconnect required. Explicit retry/opt-in can resume the retained checkpoint. Existing queue and finalized evidence remain available throughout.

Shopify webhook HMAC verification stays in the existing HTTP route before enqueueing. Existing supported topics are `orders/create`, `orders/updated`, `orders/cancelled`, `orders/paid`, `fulfillments/create`, `fulfillments/update`. New inbox delivery identities hash provider + stable source account + provider delivery ID into the existing unique-key format, retaining compatibility with older binaries. No claim is made that subscriptions or actual production delivery have been verified. eBay order synchronization uses polling; eBay account-deletion notifications are separate and unchanged.

## Required release configuration

| Setting / resource | Required value or evidence |
| --- | --- |
| API service | Existing `packproof-v2-staging-api` service; its current unset `PACKPROOF_PROCESS_ROLE` runs API and jobs together. Additive migrations use the reviewed controlled runner |
| Worker execution | Existing combined process, same pinned release image and credential references; require a fresh `commerce` heartbeat. No separate worker service was introduced. Explicit `api`/`worker` roles remain available for a separately planned split |
| Worker switch | `PACKPROOF_COMMERCE_WORKER` must not be `false` for commerce jobs |
| Provider rollout | `PACKPROOF_COMMERCE_AUTOMATION_PROVIDERS=ebay,shopify` only after each included provider is verified; comma-separated independent `ebay`, `shopify`, `etsy` allowlist; omitted/empty disables automatic providers |
| Seller consent | Existing `integration_connections.auto_sync_enabled=true`, explicitly set by its owner; OAuth alone does not opt in |
| Provider access | Existing app/user secret references and actual needed grants; never copy tokens into this record |
| Health evidence | Fresh `commerce` heartbeat, connection `lastSucceededAt`, completed initial sync, canonical eligible order and recorded retry/lease recovery |

The provider allowlist applies to all background polling, including connections that opted in before this release. An empty list pauses that polling while preserving stored preferences, cursors and existing records. The existing manual connection-sync endpoint remains outside this gate. A healthy scheduler heartbeat does not establish that a seller order was read successfully; final deployment evidence records the aggregate connection state and verified provider boundaries.

The owned `/me/integration-connections` response adds safe capability metadata: automation availability/reason, stable account identity, environment, granted scopes, exact-read/pagination support, successful order-read timestamp, and poll interval. Registration/configuration is distinguished from a successful read. `webhookDeliveryVerified=false` remains explicit until a real provider delivery is independently qualified. Source native-app Share support is a separate device observation and cannot be inferred from these API capabilities.

Rollback: clear the affected provider from `PACKPROOF_COMMERCE_AUTOMATION_PROVIDERS` or pause the seller connection, leaving existing Proof reads, uploads, commits and finalized manifests intact. `PACKPROOF_COMMERCE_WORKER=false` stops all commerce polling. Preserve additive schema and saved cursor state; do not reset the database.

## Verification evidence

Local validation completed: `npm --prefix backend run typecheck` passed. `npm --prefix backend test -- tests/commerce-automation.test.ts tests/etsy-commerce-intake.test.ts tests/shopify-graphql.test.ts tests/commerce-pagination.test.ts` passed 47/47 tests across four suites. `git diff --check` passed. These results precede the final shared release commit and must be tied to that candidate in the handoff.

Affected suites: `commerce-automation.test.ts`, `commerce-pagination.test.ts`, `shopify-graphql.test.ts`, `etsy-commerce-intake.test.ts`. Added boundaries cover cross-run cursor loops, exhausted outages, server-directed rate-limit recovery, exact/sync/reconnect convergence, same ID across stores, foreign account/order rejection, provider-specific rollout and account-scoped webhook deduplication. Existing cancellation/finalized-manifest, nested-page and lease-recovery gates are reused. See final execution handoff for actual command result; fixture success is not a live account read.

The existing Shopify `PackProofOrderRevision` query used for exact lookup was checked with the Shopify schema validator successfully. Official references: [eBay getOrder](https://developer.ebay.com/api-docs/sell/fulfillment/resources/order/methods/getOrder), [eBay getOrders](https://developer.ebay.com/api-docs/sell/fulfillment/resources/order/methods/getOrders), [Shopify order](https://shopify.dev/docs/api/admin-graphql/2026-07/queries/order), [Shopify orders](https://shopify.dev/docs/api/admin-graphql/2026-07/queries/orders).
