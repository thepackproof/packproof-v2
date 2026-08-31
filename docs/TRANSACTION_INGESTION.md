# Transaction ingestion

PackProof can populate an existing V2 transaction from an external purchase or shipping system. This is an **ingestion boundary**, not a new Proof lifecycle.

No live marketplace or carrier is supported yet. This repository ships a provider-neutral contract, a domain import service, and a **reference** adapter (`demo-marketplace`) for tests and local development.

## Shape

```text
Reference or future trusted adapter
          │  ImportedTransaction (DTO only)
          ▼
   importNormalizedTransaction()
          │
          ▼
 Transaction + shipping + provenance metadata
          │
          ├── transaction_integration_identities  (import idempotency)
          └── createOrGetProof()
                    │
                    ▼
         proof_external_references
         (immutable tenant + external id → Proof)
```

PostgreSQL remains canonical state. Clients never write Proof status. One transaction still has at most one Proof.

## Normalized import contract

Adapters produce an `ImportedTransaction` input DTO. It is **not** stored as canonical JSON. The service copies fields into the existing transaction and shipping tables.

```ts
interface ImportedTransaction {
  provider: string;
  externalTransactionId: string;
  transactionDate: string | null;
  itemTitle: string | null;
  itemDescription: string | null;
  quantity: number | null;
  transactionValue: number | null;
  currency: string | null;
  shipping: {
    carrier: string | null;
    service: string | null;
    trackingNumber: string | null;
    shipmentDate: string | null;
  } | null;
  buyer?: {
    externalId?: string | null;
    displayName?: string | null;
    email?: string | null;
  } | null;
  provenance: {
    source: ProvenanceSource;
    sourceRecordId?: string | null;
    importedAt: string;
  };
}
```

Do not add provider-specific columns such as `ebay_order_id` to Proof or transaction tables.

## Provenance

Provenance names the **origin of the facts**. It is not a proof level, confidence level, verification level, or evidence tier.

| Source | Meaning |
| --- | --- |
| `MARKETPLACE_API` | Purchase facts from a marketplace API adapter |
| `STOREFRONT_API` | Purchase facts from a storefront/commerce API adapter |
| `SHIPPING_PROVIDER_API` | Shipping facts from a carrier/label API adapter |
| `LABEL_SCAN` | Shipping facts from a scanned label |
| `PARTICIPANT_SUPPLIED` | Entered by a PackProof participant (manual create/update) |

Imported rows store a normalized `metadata.import` object (source, adapter, tenant, fingerprint, buyer display fields, first `importedAt`). Authority for “this is an import” is `transaction_integration_identities`, not client-supplied metadata. A SHA-256 fingerprint of the normalized facts may be stored. Raw provider payloads, OAuth tokens, and secrets are not stored.

## External identity and idempotency

Two related mappings exist. They are not duplicates of each other:

1. **Transaction import identity** — `tenant_key + external_transaction_id → transaction_id` in `transaction_integration_identities`. Needed because a purchase can be imported before a Proof exists.
2. **Proof identity** — the existing immutable `proof_external_references` row, established when `createOrGetProof` runs.

Tenant keys are derived from provider + provenance source, for example `marketplace:demo-marketplace`. The reserved `packproof:transaction` slot still comes from `transactions.external_reference` as before.

Retrying the same provider + external transaction ID returns the same transaction. If that transaction already has a Proof, the same Proof is returned. An established binding is not silently pointed at a different external transaction. A conflict with another seller’s Proof fails closed (`EXTERNAL_REFERENCE_CONFLICT` or `INTEGRATION_IDENTITY_CONFLICT`).

Finalized transaction and shipping facts cannot change. An identical retry after finalization is idempotent.

## Trusted integration vs participant-supplied data

| Path | Who is trusted | Route |
| --- | --- | --- |
| Manual create / PATCH | Authenticated participant | `POST /transactions`, `PATCH /transactions/:id` |
| Reference import | Authenticated participant asking PackProof to run a **reference** adapter | `POST /integrations/transactions/import` with `mode: "reference"` |
| Future marketplace / carrier | Server-side adapter with server-side credentials | Not exposed on the participant import route |

`POST /integrations/transactions/import` accepts only `adapterKey`, optional `externalTransactionId`, `createProof`, and `mode`. It rejects bodies that include purchase fields, `provider`, or raw marketplace payloads. Ordinary clients cannot impersonate eBay or Shopify by posting an `ImportedTransaction`.

Future trusted adapters should be `kind: "trusted"`, hold OAuth/API credentials only on the server, and use a separate server-to-server gate. Do not put marketplace tokens in Expo config, browser JavaScript, transaction metadata, manifests, audit events, or client storage.

## Adapter plug-in

Implement `IntegrationAdapter`:

```ts
interface IntegrationAdapter {
  readonly adapterKey: string;
  readonly kind: "reference" | "trusted";
  fetchPurchase(input: { externalTransactionId?: string | null }): Promise<ImportedTransaction>;
}
```

Register the adapter in `IntegrationAdapterRegistry`. Keep provider HTTP, OAuth, and pagination inside the adapter. `importNormalizedTransaction` must stay provider-neutral.

This slice registers only `demo-marketplace` (`kind: "reference"`). It simulates a marketplace order for local UX and tests. It is **not** eBay, Shopify, Shippo, EasyPost, or any other live connector.

## API

`POST /integrations/transactions/import` (authenticated)

```json
{
  "adapterKey": "demo-marketplace",
  "mode": "reference",
  "externalTransactionId": "DM-1001",
  "createProof": true
}
```

Response includes the canonical transaction (with `provenance`), external identity, and the canonical Proof when one exists. `createProof: true` runs the existing `createOrGetProof` command.

## Audit and manifest

When an imported transaction is attached to a Proof, the service appends `TRANSACTION_IMPORTED`, `SHIPPING_DETAILS_IMPORTED` (if shipping facts exist), and the existing `EXTERNAL_REFERENCE_BOUND` events. Identical retries do not add redundant events.

Finalization still freezes the canonical transaction and shipping contract. When import provenance exists, a deterministic `transaction.provenance` object is included (source, adapter, tenant, fingerprint). Credentials and raw provider JSON are not.

## Clients

Mobile and web offer **Import purchase** (reference adapter) and **Enter manually**. The review screen renders server-returned transaction fields. Clients do not invent a parallel transaction model.
