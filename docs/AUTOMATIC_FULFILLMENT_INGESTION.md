# Automatic fulfillment ingestion

PackProof can automatically create the **same canonical Proof** when a storefront order becomes ready for physical fulfillment. This is a workflow around the existing Proof. It is not a second Proof type, evidence level, or verification tier.

This repository does **not** connect to Shopify, eBay, Amazon, Etsy, WooCommerce, or Walmart yet. It ships the provider-neutral architecture, a deterministic reference storefront (`demo-storefront`), and a seller fulfillment queue.

```text
Storefront order becomes ready for fulfillment
        ↓
PackProof sees it (manual sync now; webhook later)
        ↓
Transaction created-or-found
        ↓
PackProof created-or-found
        ↓
Seller sees it in Fulfillment Queue
        ↓
Seller packs with qualifying fulfillment capture
        ↓
Seller attests (attribution)
        ↓
Complete PackProof
```

The seller does not create each PackProof by hand. The seller does not wait for a buyer PackProof account. A new merchant PackProof cannot finalize without qualifying physical fulfillment evidence (`FULFILLMENT_CAPTURE`) plus the required packing attestation. Attestation alone is not enough. See [PACKING_STATION.md](PACKING_STATION.md).

## Product goal

Power sellers fulfill many paid physical orders. PackProof should appear as work to pack, not as a form to fill. Future Shopify and eBay adapters plug into this same service.

## Commerce connections

Reuse `integration_connections`. A commerce connection belongs to one PackProof user (`owner_user_id`). That owner is the seller participant on generated Proofs.

Safe public fields: connection id, adapter, provider, external account reference, status, last sync time, last error category, ready-order count. `credential_reference` and secrets never leave the server.

Development-only: `POST /dev/integrations/demo-storefront/connect` when `PACKPROOF_DEV_AUTH=true`. Production/Cognito mode does not expose this route and does not pretend Shopify is connected.

## Stable commerce tenant identity

`provider + external order id` is not globally unique. Two Shopify stores can both have order `#1001`.

```text
commerce tenant = adapter prefix + provider + external account/store identity
commerce tenant + external order id → one transaction → one Proof
```

Tenant keys:

- Marketplace import without an account: `marketplace:demo-marketplace` (unchanged)
- Commerce / storefront with a store identity: `storefront:demo-storefront:demo-store-001`

The account identity is `integration_connections.external_account_reference` supplied by the adapter (for example `demo-store-001`). It is not a display name and not the internal connection id. Recreating a connection for the same store keeps the same tenant.

Identity lives in `transaction_integration_identities`. `transactions.external_reference` remains display metadata. If that global unique slot would collide, commerce import stores `{account}/{orderId}`.

## Normalized fulfillment order

Adapters implement `CommerceFulfillmentAdapter`. They do not insert into `transactions`, `proofs`, or `proof_external_references`. They return `NormalizedFulfillmentOrder` and the existing `importNormalizedTransaction()` copies fields into canonical tables.

Normalized payment: `CONFIRMED` | `PENDING` | `FAILED` | `REFUNDED` | `UNKNOWN`

Normalized fulfillment: `AWAITING_FULFILLMENT` | `IN_PROGRESS` | `FULFILLED` | `CANCELLED` | `UNKNOWN`

Provider vocabulary (Shopify `financial_status`, eBay `NOT_STARTED`, Amazon `Unshipped`) stays inside adapters.

Provenance is `STOREFRONT_API` or `MARKETPLACE_API`. Ordinary clients cannot post those sources. They may only ask PackProof to run a registered adapter.

## Fulfillment eligibility

Automatic Proof creation happens only when:

```text
payment CONFIRMED
AND physical fulfillment required
AND not cancelled
AND fulfillment is AWAITING_FULFILLMENT or IN_PROGRESS
```

Partially fulfilled physical orders (`IN_PROGRESS`) remain eligible. Digital-only, unpaid, cancelled, and already fulfilled orders are recorded in the sync projection and do not create Proofs.

This eligibility is not Proof status.

## Automatic create-or-get

`executeCommerceFulfillmentSync({ connectionId })`:

1. Authorize the connection owner.
2. Load an `ACTIVE` connection.
3. Resolve the commerce adapter.
4. Load credentials only for `kind: "trusted"` adapters.
5. List normalized orders.
6. Upsert `commerce_order_records`.
7. For newly eligible orders: `importNormalizedTransaction` then `createOrGetProof` with `COUNTERPARTY_OPTIONAL`.
8. Bind the sync row to the transaction. The binding cannot silently move to another transaction.

A future Shopify webhook or scheduler should call this same function. There is no EventBridge, cron, SQS, or worker in this slice.

Sync is idempotent. A second pass discovers the same orders and creates zero transactions, Proofs, or extra import audit events.

## Multi-item transactions

`transaction_items` is the authoritative line-item collection. Rows belong to one transaction, order by `position`, and freeze after core finalization.

`itemTitle` / `quantity` / `itemDescription` on `transactions` remain display summaries for older clients. When no child rows exist, reads synthesize a one-item view from those columns.

Imported multi-item orders persist every line. The final manifest includes `transaction.items` only when stored child rows exist, so existing manual/P2P manifests keep their previous shape.

## Participant policy

`proofs.participation_policy` is `COUNTERPARTY_REQUIRED` or `COUNTERPARTY_OPTIONAL`. It is set at Proof creation and is immutable.

| Flow | Policy | Effect |
| --- | --- | --- |
| Ordinary seller create (default) | `COUNTERPARTY_OPTIONAL` | Seller is joined immediately. Status is `READY_FOR_EVIDENCE` without a buyer. Seller may capture evidence and finalize. A PackProof buyer may still be invited later. |
| Explicit P2P | `COUNTERPARTY_REQUIRED` | Requested via `createOrGetProof` / `POST /transactions/:id/proof` body `{ participationPolicy: "COUNTERPARTY_REQUIRED" }`. Invite moves `OPEN` → `AWAITING_PARTICIPANT`. Accept → `READY_FOR_EVIDENCE`. Finalize still needs seller, buyer, and committed evidence. |
| Auto commerce | `COUNTERPARTY_OPTIONAL` | Same optional-counterparty rules as ordinary seller create. |

Do not fabricate a PackProof buyer from a marketplace customer. External buyer id and a safe display name may be stored as import context. Email, phone, and shipping address are not required and are not stored on the commerce path.

## Packing attestation and fulfillment capture

The default merchant statement is the existing `PACKED_DESCRIBED_ITEM` attestation: “I attest that I packed this order as described.” It is attributable, timestamped, immutable, shown as a user attestation, and included in the merchant final manifest. It is not a substitute for physical fulfillment evidence.

Merchant Proofs may finalize from `READY_FOR_EVIDENCE` or `EVIDENCE_COMMITTED` when:

- the seller is authorized
- participation policy is `COUNTERPARTY_OPTIONAL`
- at least one committed `FULFILLMENT_CAPTURE` exists
- the packing attestation exists
- any actually-added evidence is fully committed
- other canonical invariants pass

Eligibility is decided by `evaluateFinalizeRequirements`. MIME type and filename do not qualify capture. Already-finalized Proofs are not rewritten if they were completed under an earlier policy.

PackProof does not invent evidence rows and does not mark nonexistent media `EVIDENCE_COMMITTED`. Station packing video is committed as `FULFILLMENT_CAPTURE` through the existing upload / SHA-256 / commit path. Pending uncommitted media blocks finalization. Generic `SELLER_EVIDENCE` (including an unrelated `video/mp4`) does not satisfy the merchant capture requirement.

## Mutable projection vs immutable Proof

| Store | Role | Mutable? |
| --- | --- | --- |
| Canonical transaction, items, Proof, attestations, manifest | Evidence core | Frozen after `FINALIZED` |
| `commerce_order_records` | What the storefront last reported | Yes. External order state may change. |
| `commerce_connection_sync_states` | Last sync attempt / cursor | Yes |
| Fulfillment queue `workflowState` | Read model | Derived. Not Proof status. |

Queue states: `READY_TO_PACK`, `IN_PROGRESS`, `COMPLETED`, `REMOVED_FROM_FULFILLMENT`.

Do not add `READY_TO_PACK`, `PACKING`, or `SHIPPED` to `ProofStatus`.

If an order becomes cancelled after a Proof exists: keep the transaction and Proof, leave finalized content immutable, and remove the order from the ready queue. If a pending order later becomes eligible: create-or-get transaction and Proof.

The core manifest does **not** include last sync time, current external fulfillment state, queue position, provider cursor, or connection status.

## Seller fulfillment queue

`GET /me/fulfillment-queue?filter=ready|completed|all`

Server-authoritative. Default order is oldest fulfillment-eligible order first. Items include order reference, items, money, Proof status, participation policy, attestation flag, evidence counts, `canComplete`, and `workflowState`. Credentials are never included. A seller cannot see another seller’s queue.

## Reconciliation and future webhooks

Manual `POST /me/commerce-connections/:id/sync` is enough for this slice. A later Shopify webhook should normalize the payload inside the Shopify adapter, then call `executeCommerceFulfillmentSync` or a single-order variant that still uses `importNormalizedTransaction`.

## Future Shopify adapter

A later adapter (`kind: "trusted"`) should:

- keep OAuth tokens in the credential store
- use a stable shop identity as `external_account_reference`
- map paid / unfulfilled / physical orders onto the normalized states
- normalize line items
- call this same ingestion service

Do not add `shopify_order_id`, `shop_domain`, or `shopify_financial_status` to canonical tables.

## Future eBay adapter

A later eBay adapter should map seller account, external order id, payment confirmation, and fulfillment status onto the same DTOs. Do not add `ebay_seller_id` columns to canonical tables.

## Security and PII

- Clients cannot submit arbitrary order JSON as `STOREFRONT_API` or `MARKETPLACE_API`.
- No OAuth tokens in browser, Expo, transaction metadata, manifests, audit events, or client storage.
- Commerce import does not store buyer email, phone, or full address.
- Raw provider payloads are not stored.
- Users cannot sync or list another seller’s connection or queue.

## Idempotency

Retrying sync for the same commerce tenant + order id returns the same transaction and Proof. Identical retries do not append another `TRANSACTION_IMPORTED` event. Chronology may show a single **Order imported** commerce event with source Demo Storefront. That is provenance, not a claim that PackProof verified the commercial facts.

## Demo Storefront

`demo-storefront` is a reference adapter. It is not Shopify.

Deterministic catalog for each connected account (`demo-store-001` by default):

| Order | Scenario | Eligible? |
| --- | --- | --- |
| DS-1001 | Paid physical unfulfilled single item | yes |
| DS-1002 | Paid physical high-value | yes |
| DS-1003 | Paid physical multi-item | yes |
| DS-1004 | Quantity > 1 | yes |
| DS-1005 | Unpaid / pending | no |
| DS-1006 | Cancelled | no |
| DS-1007 | Already fulfilled | no |
| DS-1008 | Digital-only | no |
| DS-1009 | Partially fulfilled physical | yes |
| DS-1010 | Second eligible physical | yes |

First sync: 10 discovered, 6 eligible, 6 transactions, 6 Proofs. Second sync: 10 discovered, 0 new Proofs.

Development simulate (`PACKPROOF_DEV_AUTH` only) can make DS-1005 eligible or cancel DS-1001 without accepting a client-built trusted payload.
