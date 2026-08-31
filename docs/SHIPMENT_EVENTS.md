# Shipment observations

PackProof records **shipment identity** and **shipment observations** as separate things.

This repository does not connect to a live carrier. It adds an append-only observation log, a reference `demo-carrier` adapter, and a chronology read model. A future UPS/FedEx/USPS/Shippo/EasyPost adapter plugs into the same domain service.

## Identity vs observations

| Store | Meaning | Mutable after finalization? |
| --- | --- | --- |
| `transaction_shipping` | Shipment identity / static facts: carrier, service, tracking number, shipment date | **No.** Same freeze as other transaction facts. |
| `shipment_events` | Append-only observations about that shipment: accepted, in transit, delivered, … | **Inserts remain allowed.** Updates and deletes are rejected. |

Do not turn `transaction_shipping` into a tracking-history table. One transaction currently has one shipping identity row (`UNIQUE(transaction_id)`). That is enough for this slice. `shipment_events.shipping_id` points at that row so a later multi-package model can add more identity rows without rewriting observations.

A Proof must exist before an observation can be stored (`proof_id` is required and immutable). The manual flow is: import or create the transaction, create the Proof, associate shipping identity, then record observations.

## Schema

`shipment_events` (migration `009_shipment_events.sql`):

- identity: `id`, `proof_id`, `transaction_id`, `shipping_id`
- observation: `event_type`, `occurred_at` (source time), `observed_at` / `created_at` (when PackProof recorded it)
- provenance: `source`, `provider`, `source_event_id`
- payload: `carrier`, `location_text`, `event_data` (JSONB), optional `payload_sha256`
- integrity: `content_sha256`, `previous_event_sha256`, `core_manifest_sha256`, `sha256`
- dedupe: `dedupe_fingerprint`

Database triggers reject `UPDATE` and `DELETE` (`SHIPMENT_EVENT_IMMUTABLE`). There is **no** trigger that rejects insert after `FINALIZED`. That is intentional.

Credentials, OAuth tokens, and raw secret-bearing provider payloads are not stored.

## Normalized event types

Canonical types:

`LABEL_CREATED`, `CARRIER_ACCEPTED`, `WEIGHT_RECORDED`, `IN_TRANSIT`, `ARRIVED_AT_FACILITY`, `DEPARTED_FACILITY`, `OUT_FOR_DELIVERY`, `DELIVERED`, `DELIVERY_EXCEPTION`, `RETURN_TO_SENDER`, `RETURN_IN_TRANSIT`, `RETURN_DELIVERED`, `CARRIER_EVENT`

Unknown carrier vocabulary becomes `CARRIER_EVENT` with the original status in `event_data.carrierStatus`. UPS/FedEx/USPS strings are not added to the domain enum.

Return-related types are stored when observed. Return **workflows** are out of scope.

## Provenance

Reuse the existing sources. They name origin, not confidence, proof level, evidence tier, or verification strength.

| Source | Meaning |
| --- | --- |
| `SHIPPING_PROVIDER_API` | Observation produced by a carrier/label adapter |
| `LABEL_SCAN` | Observation from a scanned label |
| `MARKETPLACE_API` / `STOREFRONT_API` | Observation supplied by a commerce adapter |
| `PARTICIPANT_SUPPLIED` | Entered by a joined PackProof participant |

Each event makes four times/origins clear:

- **what** was observed (`event_type` + `event_data`)
- **when the source says it occurred** (`occurred_at`)
- **when PackProof recorded it** (`observed_at`)
- **where it came from** (`source`, `provider`)

Accurate statement: “UPS reported delivery at X and PackProof recorded that observation at Y.”

PackProof does **not** claim it verified delivery.

## Deduplication

Carrier polling must not create duplicate timeline rows.

1. When `source_event_id` is present: unique on `(provider, source_event_id)`.
2. When it is absent: unique on `(transaction_id, dedupe_fingerprint)` where the fingerprint is SHA-256 of canonical `{ transactionId, shippingId, provider, eventType, occurredAt, carrier, locationText, eventData }`.

A retry of the same observation returns the existing row and does **not** append another `SHIPMENT_EVENT_RECORDED` audit event.

Same provider event id bound to a different transaction/Proof, or the same id with different normalized content, fails closed (`SHIPMENT_EVENT_CONFLICT`). Existing rows are never updated.

## Post-finalization behavior

Core PackProof still finalizes when packing/evidence collection is complete.

`transaction` and `transaction_shipping` remain frozen after `FINALIZED`.

Shipment **events** may still be inserted. They do not:

- alter the original manifest JSON or SHA-256
- modify transaction or shipping identity
- modify committed evidence
- reopen the Proof or change Proof status

They remain append-only observations associated with the same Proof. They do not become a second Proof.

## Hash association

Each observation stores:

- `content_sha256` — SHA-256 of the canonical **normalized** event (identity, type, times, provenance, event data). Not a raw provider blob.
- `sha256` — SHA-256 of `{ contentSha256, previousEventSha256, coreManifestSha256, proofId }`
- `previous_event_sha256` — integrity digest of the previous observation on the same shipping identity, in **append** order (`created_at`, `id`)
- `core_manifest_sha256` — the frozen core manifest digest **if it already exists at insert time**; otherwise null

Pre-finalization events keep `core_manifest_sha256 = null`. They are not rewritten after finalization. Later events store the current core digest and continue the append chain from the last observation.

Chronology **display** order uses `occurred_at` (source time). Hash-chain order uses append time. Those can differ; that is expected.

Optional `payload_sha256` may fingerprint a provider payload the adapter saw. Raw provider JSON is not canonical Proof state.

## Shipment integrity supplement

Pre-finalization events keep `core_manifest_sha256 = null` and are never rewritten. If packing then finalizes and no later carrier event arrives, those rows stay associated through `proof_id` only. Their event chain never receives a `core_manifest_sha256`. That is the remaining integrity edge this supplement closes.

```text
CORE PACKPROOF
Frozen canonical manifest
Immutable
        +
SHIPMENT EVENTS
Append-only observations
Immutable
        +
SHIPMENT INTEGRITY SUPPLEMENT
Deterministic cryptographic association
Recomputable from canonical rows
Does not mutate either of the above
```

The supplement is not a Proof lifecycle state, not a second Proof, and not a blockchain. It does not publish blocks, mint tokens, or create an independently consensus-verified ledger. It is an integrity/read artifact for the existing canonical Proof.

### Persistence

The current supplement is **recomputed on request** from canonical database state. There is no supplement table and no migration in this slice. Nothing is updated or deleted because nothing is stored.

A later shipment event changes the current digest. That is a new projection over a longer immutable event list. Earlier event rows and the frozen core manifest stay unchanged. Historical supplement snapshots are out of scope.

### Canonical structure

Schema: `packproof.shipment.supplement/v1`.

The integrity envelope is `packproof.shipment.integrity/v1`.

```ts
{
  schema: "packproof.shipment.supplement/v1",
  proofId,
  transactionId,
  coreManifestSha256,
  shipment: {
    shippingId,
    carrier,
    service,
    trackingNumber,
    shipmentDate
  },
  events: [
    { shipmentEventId, sha256 }  // append order: created_at, id
  ]
}
```

`shipmentSupplementSha256 = SHA-256(canonicalize(supplement))` using the same canonicalization helper as the core manifest.

Events are listed in **append order**, not chronology `occurredAt` order. A late observation with an earlier source time stays later in the supplement. Clients cannot choose this order.

### When it can link

A fully linked supplement requires a finalized core manifest SHA.

| State | Result |
| --- | --- |
| Proof not finalized | `CORE_NOT_FINALIZED`. No invented root hash. `supplement` is null. `linkedToFinalizedProof` is false. |
| No shipping identity | `NO_SHIPMENT`. PackProof does not fabricate a shipment. |
| Finalized + shipping identity, including zero events | `LINKED`. Empty `events: []` is valid. |
| Finalized + shipping + events | `LINKED`. Includes every current event hash and the frozen core SHA. |

### Verification

`GET /proofs/:id/shipment-integrity` authorizes like other Proof reads, then independently recomputes:

1. Stored core manifest JSON hashes to the stored core SHA.
2. Each event `content_sha256` from current normalized content.
3. Each event `sha256` from its stored content hash, stored previous hash, stored `core_manifest_sha256` at insert time, and proof id.
4. Append-chain previous pointers.
5. Events belong to this Proof and shipping identity.
6. Supplement canonical content and SHA-256 from those rows.

Clients must not recompute this. They display the server result.

A passing check means PackProof’s stored shipment record still hashes together with the frozen core. It does **not** mean the carrier’s real-world statement is true, that delivery happened, or that the observation is stronger evidence.

## Chronology read model

`GET /proofs/:id` includes:

- `shipmentObservations` — identity, events, latest
- `chronology` — presentation entries `{ id, occurredAt, category, title, description, source, relatedEntityId, eventType }`

Categories are `PROOF`, `COMMERCE`, and `SHIPMENT`. They are source groupings for UI, not evidence levels.

`GET /proofs/:id/chronology` and `GET /proofs/:id/shipment-events` return the same canonical data for clients that do not want the full Proof payload.

The timeline is a read model. It is not lifecycle state. Web and mobile render this server projection; they do not invent a second chronology.

Core finalization appears as “Core PackProof finalized” with the manifest hash. Later carrier observations remain visible after that point without implying they changed the frozen core.

## Trusted carrier-adapter boundary

| Path | Who is trusted | Route |
| --- | --- | --- |
| Reference import | Authenticated seller asking PackProof to run a **reference** adapter | `POST /integrations/shipment-events/import` with `mode: "reference"` |
| Participant observation | Joined participant | `POST /transactions/:id/shipment-events` — provenance is always `PARTICIPANT_SUPPLIED` |
| Future live carrier | Server-side adapter with server-side credentials | Not exposed on the reference import route |

The reference import route accepts only `adapterKey`, `mode`, `transactionId` and/or `externalTransactionId`, and optional `throughEventType`. It rejects carrier facts and raw provider payloads. Ordinary clients cannot pretend to be UPS by posting tracking events.

`demo-carrier` is `kind: "reference"`. A future live adapter must be `kind: "trusted"`, hold API secrets only on the server, and use a separate server-to-server gate. Do not put carrier tokens in Expo config, browser JavaScript, shipment events, manifests, audit events, or client storage.

## How a future UPS / FedEx / USPS / Shippo / EasyPost adapter plugs in

Implement `ShipmentObservationAdapter`:

```ts
interface ShipmentObservationAdapter {
  readonly adapterKey: string;
  readonly kind: "reference" | "trusted";
  fetchShipmentEvents(input: {
    transactionId: string;
    trackingNumber: string | null;
    externalTransactionId: string | null;
    throughEventType?: string | null;
  }): Promise<ImportedShipmentEvent[]>;
}
```

Keep HTTP, OAuth, polling, and provider pagination **inside the adapter**. Map provider statuses onto the normalized types (or `CARRIER_EVENT`). Pass `sourceEventId` when the provider has a stable activity id. Register the adapter on `IntegrationAdapterRegistry` as a shipment adapter.

Then call `importShipmentObservations()` / `recordShipmentEvent()`. Do not teach the domain service UPS XML, FedEx JSON, or EasyPost tracker shapes.

This slice registers only `demo-carrier`. It emits a deterministic fake timeline for tests and local UX. It is not a live carrier.

## API

- `POST /integrations/shipment-events/import`
- `GET /transactions/:id/shipment-events`
- `POST /transactions/:id/shipment-events` (participant-supplied)
- `GET /proofs/:id/shipment-events`
- `GET /proofs/:id/chronology`
- `GET /proofs/:id/shipment-integrity`

Audit: `SHIPMENT_EVENT_RECORDED` with `{ shipmentEventId, eventType, source, provider }`. This is not a Proof lifecycle transition.
