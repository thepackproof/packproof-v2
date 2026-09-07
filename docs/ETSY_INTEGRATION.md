# Etsy account integration

PackProof connects a seller's Etsy shop to the existing fulfillment queue. Eligible orders create the same canonical transaction and Proof used by the web workspace and Android app. Etsy supplies order context; the seller still records the packing video and submits the packing attestation. Creating a Proof does not assert that packing occurred or that an order shipped.

## Etsy approval and account consent

The application shown on September 7, 2026 is **Pending Personal Approval**. Credentials alone do not establish an approved integration. Etsy must approve the application purpose, and each seller must grant OAuth consent before PackProof can read that seller's orders. Code deployment cannot complete Etsy's review or grant a seller's consent.

Etsy currently describes Personal Apps as limited-scale access subject to the approved use case. Commercial Access is a later review for broader distribution; it first requires an approved Personal App. Current documentation does not promise a fixed five-shop entitlement. A Seller App is restricted to its owner's shop and cannot substitute for PackProof's integration with other sellers. [Etsy application access](https://developers.etsy.com/documentation/), [application approval requirements](https://www.etsy.com/legal/api/).

## Server configuration

Configure the API, never a Vite or Expo client bundle:

| Variable | Purpose |
| --- | --- |
| `PACKPROOF_ETSY_INTEGRATION_ENABLED` | Enables the Etsy provider when its required configuration is present. |
| `PACKPROOF_ETSY_CLIENT_ID` | Etsy application's keystring. |
| `PACKPROOF_ETSY_APP_CREDENTIAL_REFERENCE` | Reference to the server credential containing the application's shared secret. |
| `PACKPROOF_ETSY_SHARED_SECRET` | Server environment alternative to an application credential reference. Use the managed credential reference for deployed setup. |
| `PACKPROOF_ETSY_REDIRECT_URI` | The exact HTTPS callback registered for this Etsy application. |
| `PACKPROOF_CREDENTIAL_STORE=secrets-manager` | Durable server credential storage for deployed environments. |

Apply migrations `050_etsy_connected_accounts.sql` and `051_etsy_request_budget.sql` through the normal API deployment migration process. Background intake requires `PACKPROOF_PROCESS_ROLE=combined`, or a running `worker` process alongside an `api` process. `PACKPROOF_COMMERCE_WORKER=false` disables scheduled commerce work; a working manual sync alone does not establish background readiness.

The callback is `GET /oauth/etsy/callback` on the API. When using the website's API proxy, register:

```text
https://thepackproof.com/api/oauth/etsy/callback
```

Register the value in Etsy's developer dashboard exactly, including hostname, case, and trailing-slash choice. It must match `PACKPROOF_ETSY_REDIRECT_URI`. No wildcard, mobile custom scheme, or unregistered callback is substituted. [Etsy OAuth authentication](https://developers.etsy.com/documentation/essentials/authentication/).

The application credential's `material.sharedSecret` contains the shared secret; `material.clientSecret` and the environment-store `material.apiKey` are compatibility aliases. A typical managed application reference is `packproof/staging/integrations/etsy/app`. Store the credential through the existing credential-store interface. Do not commit real credentials to source control, include them in URLs, expose them through connection responses, or print them in request logs.

Hosted Etsy enablement requires the managed credential store; an in-memory store is rejected outside development and test. Per-account credentials retain the Etsy shop and user identity alongside the access and refresh tokens. Refresh persists both replacement tokens and verifies the same user and required scopes. Disconnect removes PackProof's stored credentials and disables synchronization. Etsy does not document a public v3 token-revocation endpoint; removing the authorization in the seller's Etsy account is a separate provider action.

The backend requests only `shops_r transactions_r`. Authorization uses PKCE with S256 and a single-use state. API calls send the application keystring and shared secret together in `x-api-key`; OAuth requests use the keystring as `client_id`. Private order reads additionally use the complete Etsy bearer token, including its numeric user prefix. [Request requirements](https://developers.etsy.com/documentation/essentials/requests/).

## Seller workflow and synchronization

On web, open **Account → Connections → Connect Etsy**. On Android, open **Account → Connected Accounts → Connect Etsy**. Etsy account authorization runs in Etsy's browser consent flow. PackProof identifies the shop from the authorized Etsy user; the client does not supply an arbitrary shop to import.

Choose **Automatically prepare eligible paid orders for recording** to enable background intake. **Check for orders now** runs an immediate synchronization. Authorizing a shop alone does not silently enable background Proof creation. The existing pending backlog is included, even if the orders were created before the connection.

The server polls opted-in active connections approximately every five minutes. Once per hour, a reconciliation runs in two phases: all paid, unshipped receipts without an order-age cutoff, then changed receipts of every status over the previous 60 days. Incremental runs overlap the previous window by 15 minutes to tolerate ordering and timing differences. Pages are bounded and the cursor is persisted against its shop, connection, and fixed synchronization window. A failed page does not count as successfully completed work.

The existing commerce worker uses leases and durable scheduling. A `Retry-After` delay is reflected in the next run time. Pausing automatic intake or disconnecting prevents further scheduled imports, including an in-flight run that no longer owns an enabled connection. Reconnecting the same shop keeps its existing preference and canonical identity; reauthorization as a different shop is rejected.

The import identity is the Etsy shop namespace plus receipt ID. Repeated pages, manual checks, reconnects, and worker retries create or retrieve one transaction and one Proof. The Proof uses `COUNTERPARTY_OPTIONAL` and starts ready for seller evidence. There is no Etsy-specific Proof lifecycle, automatic evidence commitment, or automatic finalization.

Explicit provider status updates may remove an order from the active packing queue while preserving its Proof and audit history. An order missing from one API page is not treated as canceled.

## Which orders are prepared automatically

The first supported capture path is a complete physical order awaiting one packing session. Multiple physical items and quantities can belong to that order; they are retained as ordered. The integration does not silently trim an order down to only its unshipped or physical lines.

| Etsy order data | Automatic creation |
| --- | --- |
| Paid, unshipped, wholly physical, consistent complete fulfillment data | Eligible for the existing commerce ingestion rules. |
| Unpaid or payment processing | Wait for confirmed payment. |
| Completed, already shipped, or every item marked shipped | No new packing Proof is prepared, including a completed order with an inconsistent unshipped flag. |
| Canceled or refunded, including a partial refund | Excluded from automatic capture. |
| Partially shipped or multiple shipment records | Excluded; the adapter cannot safely infer the intended parcel and remaining item quantities. |
| Digital-only or mixed physical and digital | Excluded from the complete physical-order capture path. |
| Unknown fulfillment flags, invalid quantities, inconsistent currencies, or unconfirmed status | Excluded with a reason rather than guessed. |

Paid pending complex orders appear as counts and reason summaries in web **Orders → Orders requiring review**, web Connections, and Android Connected marketplaces. The UI does not fabricate a Proof action for an excluded order. Exclusions do not authorize deletion or alteration of an existing Proof. Sellers must review complex orders separately; this integration does not claim to automate every pending order variant.

## Quotas and delivery model

The supplied dashboard shows **5 requests per second and 5,000 requests per day**. These are application-wide limits across public and OAuth calls. Etsy's daily window rolls over the previous 24 hours; it does not reset at midnight. `429` responses carry `retry-after` seconds. [Etsy rate limits](https://developers.etsy.com/documentation/essentials/rate-limits/).

For capacity planning, a one-page poll every five minutes costs 288 requests per shop per day before additional reconciliation pages, token refreshes, and manual operations. This is a calculation, not a quota guarantee. A PostgreSQL-backed application budget spaces requests by at least 300 ms and caps internally counted calls at 4,500 per rolling day, leaving headroom below the dashboard quota. Provider cooldowns are shared across shop connections and processes; a deferred call retains synchronization progress.

This implementation uses scheduled polling and manual synchronization. An Etsy webhook subscription is not required. Etsy now offers order-event webhooks to approved Personal and Commercial applications; optional webhook delivery would require separate portal configuration and signature verification. [Etsy webhooks](https://developers.etsy.com/documentation/essentials/webhooks/).

## Data and provider boundaries

Order reads use Etsy's official v3 API. The integration does not scrape storefront pages, buy labels, mark Etsy orders shipped, issue refunds, change listings, or send buyers order notifications. Those operations are not needed to create a packing Proof.

Addresses, buyer email, and private messages are excluded from the normalized order payload. Etsy may restrict address fields by region and separately approve email access; neither is required for PackProof intake. Missing data is not fabricated. [Official receipt schema](https://www.etsy.com/openapi/generated/oas/3.0.0.json).

Imported marketplace fields represent the order context observed during import. They do not become evidence that the physical contents match the order. The canonical manifest and committed evidence remain immutable; subsequent provider status changes belong to the fulfillment projection and audit history.

Etsy attribution is displayed in the connection interface. PackProof's terms and privacy policy govern the seller's use of PackProof. Provider data must only be retained as needed for that service, and current order displays must respect Etsy's freshness requirements. Immutable historical Proof context must not be presented as a live Etsy status. [Etsy API terms](https://www.etsy.com/legal/api/).

## Verification recorded during implementation

The final local checks passed on September 7, 2026: 59 Etsy backend tests covering provider contracts, receipt normalization, real HTTP/domain intake, credential rotation, shared quotas and configuration; 141 web tests; and two mobile commerce HTTP/copy tests. Existing connected-account, shared commerce and credential-store regression tests also passed. Backend, web and mobile TypeScript checks and backend/web production builds passed. Quota recovery was verified through nine cooldowns without disabling automatic intake or duplicating a Proof; ordinary repeated failures retain their bounded failure policy.

These tests use controlled provider responses; they do not establish that the application's real credentials are approved or that a real seller has authorized it. AWS access did not return a result during this session, so no Etsy credentials were installed in the deployed managed store and no production deployment or live Etsy acceptance is claimed. Hosted release checks are recorded in the implementation pull request.

## Live acceptance

Automated provider fixtures and domain tests cannot prove Etsy has approved the application or that a real seller has completed consent. Before claiming the live integration works, verify all of the following with an approved app and a consenting shop:

1. Connect Etsy from PackProof, approve the requested read access, and return to the correct PackProof account.
2. Confirm the actual Etsy shop name appears and survives an API restart.
3. Synchronize an eligible physical order and open its automatically created Proof from the fulfillment queue.
4. Repeat synchronization and reconnect the same shop; confirm the same transaction and Proof are reused.
5. Confirm another PackProof account cannot access the shop connection or its orders.
6. Verify unpaid, canceled, refunded, digital-only, and shipped orders follow the documented eligibility rules.
7. Verify a subsequent scheduled synchronization runs while the seller has no browser or app open.
8. Capture, attest, finalize, reload, and share the resulting canonical Proof through the existing seller workflow.
9. Disconnect Etsy, confirm polling stops, and confirm previously recorded Proof evidence remains accessible under its existing permissions.

Record live results separately from automated test results. Do not describe a pending application or fixture-only run as a completed live connection.
