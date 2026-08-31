# PackProof V2 — Strict Development Plan and Architecture Directive

This document is the authoritative implementation specification for this repository.

If existing code conflicts with this specification, this specification takes precedence.
If an implementation decision is not explicitly required to complete this specification, do not implement it.

PackProof V2 is an independent repository. It is not a branch of PackProof.

## Core principle

A PackProof is one immutable, transaction-bound evidence record whose history can only be appended to, whose state can only be changed through validated server-side transitions, and whose final contents can be independently integrity-verified.

## Invariants

1. One transaction = one Proof. `UNIQUE(transaction_id)`. Create Proof is idempotent.
2. Proof existence is server-side and persistent.
3. Clients cannot directly set Proof status. They issue domain commands.
4. Evidence is append-only after commit.
5. Invitations are permissions, not Proof state.
6. Capture/upload state is not Proof state.
7. Finalization produces an immutable hashed canonical manifest.

## Release-candidate scope

Supported: two users, two devices, one transaction, one Proof, seller, buyer, PackProof user search, account-targeted invitation, acceptance, seller evidence, SHA-256, commit, server-side validation, finalize, retrieve Proof/manifest, minimal UI, retries/idempotency.

Out of scope: Salesforce, Zendesk, live carriers, live marketplaces, returns, receiver capture, witness, analytics, billing, orgs, GraphQL, Kafka, Kubernetes, Firebase/Firestore domain storage, microservices, extra tiers, AI analysis.

A provider-neutral transaction ingestion seam with a reference adapter is in scope. Append-only shipment observations associated with a Proof are in scope. A recomputed shipment integrity supplement that links those observations to the frozen core manifest is in scope. A trusted carrier integration runtime (credential store, connections, sync, webhook verification, fake trusted adapter) is in scope. An EasyPost Tracker adapter (`easypost-tracker`) is in scope for **test/staging tracking observations only**; it is not a production EasyPost rollout and does not buy labels. Real eBay/Shopify/Shippo/UPS/FedEx/USPS connectors are not.

## Required flow

Seller signs in → create transaction → create-or-get Proof → search PackProof users → invite by internal user id → buyer signs in → pending invitation appears in discovery → accept invitation → seller captures → upload → server verifies SHA-256 → commit → finalize → both retrieve the same finalized Proof.

The beta-ready invitation path is account search. Invitees do not handle invitation tokens. Token and invitation-ID acceptance remain as compatibility fallbacks.

## Commands

`createTransaction()`, `importTransaction()`, `createOrGetProof()`, `getProof()`, `searchUsers()`, `searchUsersForProof()`, `createInvitation()`, `acceptInvitation()`, `initializeEvidenceUpload()`, `commitEvidence()`, `verifyEvidenceHash()`, `finalizeProof()`, `getManifest()`, `importShipmentEvents()`, `getShipmentIntegrity()`, `executeTrustedShipmentSync()`.

## API

REST only:

- `POST /transactions`
- `GET /transactions/:id`
- `POST /integrations/transactions/import`
- `POST /integrations/shipment-events/import`
- `POST /transactions/:id/proof`
- `GET /proofs/:id`
- `GET /users/search`
- `GET /proofs/:id/users/search`
- `GET /invitations`
- `GET /proofs/:id/shipment-events`
- `GET /proofs/:id/chronology`
- `GET /proofs/:id/shipment-integrity`
- `POST /transactions/:id/shipment-sync`
- `POST /integrations/webhooks/:adapterKey`
- `GET /transactions/:id/shipment-events`
- `POST /transactions/:id/shipment-events`
- `POST /proofs/:id/invitations`
- `POST /invitations/:token/accept`
- `POST /proofs/:id/evidence/uploads`
- `POST /proofs/:id/evidence/:evidenceId/commit`
- `POST /proofs/:id/finalize`
- `GET /proofs/:id/manifest`

## Proof states

`OPEN` | `AWAITING_PARTICIPANT` | `READY_FOR_EVIDENCE` | `EVIDENCE_COMMITTED` | `FINALIZED`

## Idempotent commands

Transaction creation with external identifiers, Proof creation, invitation creation, invitation acceptance, participant creation, evidence upload init, evidence commit, finalization, shipment-event ingest.

## Errors

Unsuccessful requests must not leave a half-mutated Proof. Explicit codes including `PROOF_ALREADY_FINALIZED`, `PROOF_NOT_READY_FOR_FINALIZATION`, `PARTICIPANT_NOT_AUTHORIZED`, `INVITATION_EXPIRED`, `CANNOT_INVITE_SELF`, `ALREADY_PARTICIPANT`, `INVALID_SEARCH`, `EVIDENCE_ALREADY_COMMITTED`, `INVALID_PROOF_TRANSITION`, `SHIPMENT_EVENT_CONFLICT`, `SHIPMENT_EVENT_IMMUTABLE`, `INTEGRATION_TRUST_BOUNDARY`, `WEBHOOK_SIGNATURE_INVALID`.

## Definition of done

Database enforces one Proof per transaction. Proofs survive navigation, restart, logout. Invitations only authorize. Evidence retry-safe and independently hashed. Transitions server-side. Premature finalize rejected. Manifest deterministic, hashed, immutable. Repeated finalize returns the same manifest. API and domain tests pass. Two-device test is a later phase. The first-party web client in `web/` is a reference surface for the same API; it does not define Proof state.

## Development order

Phase 1 freeze legacy by reference. Phase 2 backend foundation. Phase 3 schema. Phase 4 transaction + Proof. Phase 5 participants + invitations. Phase 6 evidence. Phase 7 audit. Phase 8 finalization. Phase 9 API tests. Phase 10 minimal mobile. Phase 11 two-device test.

Do not skip ahead to mobile until the API workflow is stable.
