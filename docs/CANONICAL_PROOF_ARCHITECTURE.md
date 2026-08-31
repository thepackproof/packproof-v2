# Canonical Proof architecture

PackProof is neutral evidence infrastructure.

**One evidence core, multiple surfaces.** Marketplace apps, the mobile client, claims desks, the web portal, and later enterprise integrations all authorize against the same Proof. They do not own separate evidence models.

```text
         Marketplace
              |
Mobile ------ PackProof API ------ Claims Desk
              |
         Web Portal
              |
              v
      Canonical Proof Core
              |
  --------------------------------
  |        |         |           |
Participants Evidence Events Integrity
```

Not this: a Mobile Proof, a Marketplace Proof, a Claims Proof, and an API Proof.

## Neutrality

PackProof records, timestamps, hashes, preserves, and exposes what occurred inside its system. It does not adjudicate fraud, liability, ownership, authenticity, or claim outcome. It does not label parties verified, guilty, innocent, or correct.

## Trust vocabulary

Every value on a Proof is one of three kinds:

| Kind | Meaning | Examples |
| --- | --- | --- |
| `FACT` | Something PackProof can establish from its own infrastructure | Proof recorded at this time; this participant joined; this object was received; this SHA-256 was computed and stored |
| `ATTESTATION` | A participant claim PackProof recorded but did not independently verify | “I packed the described item.” “I received this package.” |
| `EXTERNAL` | Metadata supplied by a participant or integration | Transaction ID, listing title, tracking number, order description |

`verifiedByPackProof` is false for every `EXTERNAL` record. PackProof does not promote an attestation or external field into a fact.

Do not use product language such as verified seller, authentic item, fraud detected, claim approved, or legitimate transaction unless the statement is literally a PackProof-established fact.

## Canonical Proof

`GET /proofs/:proofId` returns `packproof.proof.canonical/v1` after fail-closed authorization. The representation is assembled from domain state. It is not a raw table dump.

The contract includes:

- **Identity** — `proofId`, timestamps, lifecycle status, transaction id
- **Participants** — identity, role, joined/accepted authorization
- **Invitations** — invitation state without invitation tokens
- **Evidence** — identity, type, submitter, record timestamps, object reference, SHA-256
- **Attestations** — who attested, the bounded statement, related evidence, digest
- **Events** — append-only audit of committed actions (`PROOF_CREATED`, `PARTICIPANT_INVITED`, `PARTICIPANT_JOINED`, `EVIDENCE_COMMITTED`, `ATTESTATION_COMMITTED`, `PROOF_FINALIZED`, and related existing types)
- **Shipment observations** — append-only carrier/participant observations associated with the Proof; they may arrive after `FINALIZED` and are not part of the core manifest
- **Shipment sync availability** — whether an ACTIVE trusted integration connection is bound (`connectionId`, `adapterKey`, `provider`, `status`). Never includes credential references or secrets. EasyPost Tracker observations, when present, are shipment events (`provider = easypost`); they are not core Proof facts.
- **Chronology** — presentation read model over audit + shipment observations (`PROOF` / `COMMERCE` / `SHIPMENT`). Not lifecycle state and not evidence tiers
- **Integrity** — recorded evidence digests and finalized manifest digest
- **Shipment integrity supplement** — a separate recomputed read (`GET /proofs/:id/shipment-integrity`, schema `packproof.shipment.integrity/v1`). It associates current shipment-event hashes with the frozen core manifest. It is not a second Proof, not a new lifecycle status, and not part of the core manifest.
- **Facts / external** — explicit trust classification

`GET /me/proofs` returns `packproof.proof.summary/v1`. It is a discovery index for the authenticated user. Cached `proofId` values are shortcuts. The server remains the authority.

Command responses (`createOrGetProof`, accept, commit, finalize) return the same canonical Proof object so clients do not keep a second model.

## Authorization boundary

Durable reads and writes authenticate, then authorize, then load the Proof.

`authorizeProofAccess` is fail-closed. A caller who is not a joined participant receives `PARTICIPANT_NOT_AUTHORIZED`. Missing Proofs are not distinguished from unauthorized Proofs on the read path.

Future integration credentials must resolve to this same gate. They must not read a parallel store.

## Persistence invariants

- One transaction = one Proof (`UNIQUE(transaction_id)`).
- Evidence is append-only after commit. Committed bytes, digest, submitter, and type cannot be replaced in place.
- Attestations are immutable after insert.
- Audit events and final manifests are immutable.
- After `FINALIZED`, mutation of Proof status, evidence, attestations, transaction facts, shipping identity, and the core manifest is rejected. New shipment observations may still be appended; they do not rewrite the core record. Recomputing the shipment integrity supplement after those appends produces a new digest over the extended event list. That is a current projection, not mutation of historical evidence.

## External references

An external Proof binding is an infrastructure identity association, not editable transaction metadata.

`tenant_key + external_transaction_id → proof_id`

Once established for a tenant on a Proof, the mapping is immutable. There is no silent rebind. A later `PATCH` of `transaction.externalReference` updates participant-supplied metadata only. `createOrGetProof` may establish a missing `packproof:transaction` binding; it must not replace one.

Server-side uniqueness:

- `UNIQUE(tenant_key, external_transaction_id)` — one external transaction cannot resolve to two Proofs
- `UNIQUE(proof_id, tenant_key)` — one tenant cannot hold two identities on the same Proof

Clients cannot be trusted to prevent duplicates. An explicit, auditable rebind is out of scope; until one exists, reject `EXTERNAL_REFERENCE_ALREADY_BOUND`.

`transactions.external_reference` remains `EXTERNAL` metadata. The reserved tenant `packproof:transaction` is the identity slot established from that field when a Proof is first bound. Integration tenants (for example `marketplace:demo-marketplace`) are bound from imported purchases. See [TRANSACTION_INGESTION.md](TRANSACTION_INGESTION.md). This repository does not yet expose API-key marketplace onboarding or live provider connectors.

## Surfaces

All surfaces speak the API. None of them define Proof existence or status.

| Surface | Relationship to the core |
| --- | --- |
| Mobile app | Authenticated participant client |
| Web reference client (`web/`) | Same Proof, same authorization |
| Marketplace / claims / enterprise | Same Proof, scoped credentials later |

Signed webhooks, API keys, billing, and tenant administration are out of scope here. When they appear, they authorize access to this Proof. They do not fork it.
