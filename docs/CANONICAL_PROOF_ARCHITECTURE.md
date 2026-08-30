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
- **Integrity** — recorded evidence digests and finalized manifest digest
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
- After `FINALIZED`, mutation is rejected.

## External references

Integrations must not create a second Proof for the same external transaction.

`proof_external_references` enforces:

`UNIQUE(tenant_key, external_transaction_id) → proof_id`

Tenant key plus external transaction identifier resolve to at most one Proof. The mapping is written server-side. Clients cannot be trusted to prevent duplicates.

The reserved tenant `packproof:transaction` binds a transaction `externalReference` when a Proof is created. Other tenants (for example `marketplace:example`) are the future integration seam. This repository does not yet expose API-key or marketplace onboarding.

## Surfaces

All surfaces speak the API. None of them define Proof existence or status.

| Surface | Relationship to the core |
| --- | --- |
| Mobile app | Authenticated participant client |
| Web portal | Same Proof, same authorization |
| Marketplace / claims / enterprise | Same Proof, scoped credentials later |

Signed webhooks, API keys, billing, and tenant administration are out of scope here. When they appear, they authorize access to this Proof. They do not fork it.
