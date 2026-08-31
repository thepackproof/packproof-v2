# PackProof V2 architecture

PackProof V2 is a **separate repository**. It is not a branch of PackProof.

Legacy PackProof remains at `C:\src\PackProof\repo`. Do not restructure it from here. Reuse from legacy only isolated utilities (camera, branding, generic hashing) when a later phase needs them. Do not reuse legacy lifecycle logic.

## Principle

A PackProof is one immutable, transaction-bound evidence record whose history can only be appended to, whose state can only be changed through validated server-side transitions, and whose final contents can be independently integrity-verified.

## Shape

```text
Clients (mobile, web reference client, API tests)
          │
          ▼
     PackProof REST API
          │
          ▼
   Modular monolith (this repo, backend/)
 ├── Transactions
 ├── Integrations (provider-neutral import; reference adapter only)
 ├── Proofs
 ├── Participants
 ├── Invitations
 ├── Evidence
 ├── Finalization
 ├── Authentication adapter
 └── Audit
          │
    ┌─────┴─────┐
    ▼           ▼
PostgreSQL      Object store
Canonical       Evidence bytes
state           (S3 in AWS; local adapter in dev/test)
```

Canonical domain state lives in PostgreSQL. Evidence bytes live in the object store. Clients cache nothing as truth.

## Identity

Domain tables use PackProof user ids (`user_01…`). External auth subjects map through `auth_identities`. Proof tables never store Firebase, Cognito, Google, or Apple identifiers.

## Proof states

`OPEN` → `AWAITING_PARTICIPANT` → `READY_FOR_EVIDENCE` → `EVIDENCE_COMMITTED` → `FINALIZED`

No UI/capture/upload states.

## AWS target (not required to run locally)

- PostgreSQL on RDS or Aurora PostgreSQL
- S3 for evidence objects
- ECS/Fargate for this API
- S3 + CloudFront for the staging web reference client (separate origin; CORS via `PACKPROOF_WEB_ORIGINS`)
- KMS only if signing is introduced later
- SQS only for genuine async jobs (none in this slice)
- CloudWatch logs

Do not use DynamoDB or Firebase as canonical Proof storage. Do not put Proof transitions on Lambda.

## Local run

See `backend/README.md`. Tests use PostgreSQL-compatible PGlite. Runtime uses `DATABASE_URL` PostgreSQL when configured.

Phase 10 mobile client: `mobile/`. It issues V2 domain commands and renders returned Proof state. It does not own Proof lifecycle.

Web reference client: `web/`. Same API, same canonical Proof. Local Vite for development. Staging hosting is S3 + CloudFront; see [WEB_CLIENT.md](WEB_CLIENT.md).

## Canonical Proof contract

One evidence core, multiple surfaces. Mobile, future marketplaces, claims desks, and portals consume the same Proof through the API authorization boundary.

See [CANONICAL_PROOF_ARCHITECTURE.md](CANONICAL_PROOF_ARCHITECTURE.md).

Provider-neutral purchase import (reference adapter only) is described in [TRANSACTION_INGESTION.md](TRANSACTION_INGESTION.md). Live marketplace and carrier connectors are not implemented.
