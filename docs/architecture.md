# PackProof V2 architecture

PackProof V2 is a **separate repository**. It is not a branch of PackProof.

Legacy PackProof remains at `C:\src\PackProof\repo`. Do not restructure it from here. Reuse from legacy only isolated utilities (camera, branding, generic hashing) when a later phase needs them. Do not reuse legacy lifecycle logic.

## Current source and historical descriptions

This architecture describes the shared modular monolith. Older exclusions below are bounded by their original slice; they do not override implemented additive organization, recovery or integrity-envelope work. The API/client release [capability ledger](api-client-release/CAPABILITY_LEDGER.md) pins source baseline `e4f69c9a690649c41b846468eb48829fb0542617` and separates implementation from configured, observed and production status. New October 28 candidate checks remain pending until recorded for the integrated commit.

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
 ├── Integrations (reference adapters + trusted runtime, including EasyPost Trackers in test/staging and demo-storefront commerce fulfillment)
 ├── Proofs
 ├── Participants
 ├── Invitations
 ├── Evidence
 ├── Custody (assets, observations, transfers; see CUSTODY_WORKFLOW.md)
 ├── Shipment observations
 ├── Shipment integrity (recomputed read)
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

Evidence upload authorization applies only to a staging object. Commitment hashes a storage-identity-locked snapshot and promotes it to a separate, server-only, content-addressed key before PostgreSQL records the digest and committed key. Previously issued client PUT URLs can therefore change only unreferenced staging bytes. Committed evidence rows reject all updates and deletes at the database layer.

## Identity

Domain tables use PackProof user ids (`user_01…`). External auth subjects map through `auth_identities`. Proof tables never store Firebase, Cognito, Google, or Apple identifiers.

## Proof states

Ordinary Proofs default to `COUNTERPARTY_OPTIONAL` and start at `READY_FOR_EVIDENCE`:

`READY_FOR_EVIDENCE` → `EVIDENCE_COMMITTED` → `FINALIZED`

`COUNTERPARTY_REQUIRED` Proofs, when explicitly requested, still use:

`OPEN` → `AWAITING_PARTICIPANT` → `READY_FOR_EVIDENCE` → `EVIDENCE_COMMITTED` → `FINALIZED`

No UI/capture/upload states. Buyer participation is optional on the ordinary path. It remains required only when the stored policy is `COUNTERPARTY_REQUIRED`.

## AWS target (not required to run locally)

- PostgreSQL on RDS or Aurora PostgreSQL
- S3 for evidence objects
- ECS/Fargate for this API
- S3 + CloudFront for the staging web reference client (separate origin; CORS via `PACKPROOF_WEB_ORIGINS`)
- KMS signing/recovery runtime is implemented; activation and trusted key history depend on reviewed deployment configuration
- PostgreSQL outbox/leases remain the default background mechanism; add a queue service only for measured workload requirements
- Secrets Manager for trusted integration credentials. The ECS **task role** (application AWS SDK) may call `secretsmanager:GetSecretValue`, `CreateSecret`, `PutSecretValue`, and `DeleteSecret` on `packproof/staging/integrations/*`. The task execution role is only for image pull, logs, and injected RDS credentials.

Do not use DynamoDB or Firebase as canonical Proof storage. Do not put Proof transitions on Lambda.

## Local run

See `backend/README.md`. Tests use PostgreSQL-compatible PGlite. Runtime uses `DATABASE_URL` PostgreSQL when configured.

`GET /health` and `GET /meta` are unauthenticated. `/meta` returns only service, environment, commit, version, and image identifiers supplied through explicit release variables. It does not dump process environment.

Phase 10 mobile client: `mobile/`. It issues V2 domain commands and renders returned Proof state. It does not own Proof lifecycle.

Web reference client: `web/`. Same API, same canonical Proof. Local Vite for development. Staging hosting is S3 + CloudFront; see [WEB_CLIENT.md](WEB_CLIENT.md).

Packing Station Mode is a client workflow over those commands. Merchant finalization requires qualifying fulfillment capture decided by the server. The current ordinary/batch candidate uses one video, review, consent and automatic authoritative finalization; see [redesign contracts](ui-ux-redesign-2026-09-08/DESIGN_AND_STATE.md). Legacy station journals retain recovery compatibility.

## Canonical Proof contract

One evidence core, multiple surfaces. Mobile, authorized partner integrations, claims desks, and portals consume the same Proof through the API authorization boundary.

See [CANONICAL_PROOF_ARCHITECTURE.md](CANONICAL_PROOF_ARCHITECTURE.md). Account search and account-targeted invitations are described in [USER_SEARCH_AND_INVITATIONS.md](USER_SEARCH_AND_INVITATIONS.md). Custody assets, observations, transfers, `nextAction`, and guest viewing links are described in [CUSTODY_WORKFLOW.md](CUSTODY_WORKFLOW.md).

Provider-neutral purchase import (reference adapter plus the first live marketplace connector) is described in [TRANSACTION_INGESTION.md](TRANSACTION_INGESTION.md). Automatic fulfillment ingestion and the seller packing queue are described in [AUTOMATIC_FULFILLMENT_INGESTION.md](AUTOMATIC_FULFILLMENT_INGESTION.md). Append-only shipment observations and the recomputed shipment integrity supplement are described in [SHIPMENT_EVENTS.md](SHIPMENT_EVENTS.md). The trusted carrier runtime is described in [TRUSTED_SHIPMENT_INTEGRATIONS.md](TRUSTED_SHIPMENT_INTEGRATIONS.md). EasyPost Tracker test/staging tracking is described in [EASYPOST_TRACKING_INTEGRATION.md](EASYPOST_TRACKING_INTEGRATION.md). eBay seller OAuth and Sell Fulfillment order import is described in [EBAY_INTEGRATION.md](EBAY_INTEGRATION.md). Connected accounts (eBay, Shopify, Google, Meta/Facebook) are described in [CONNECTED_ACCOUNTS.md](CONNECTED_ACCOUNTS.md). Direct UPS/FedEx/USPS/Shippo APIs are not implemented. EasyPost is not a production-supported carrier rollout.

## Public platform and lifecycle additions (September 2026)

The comprehensive plan adds a versioned platform boundary over the existing modular monolith. `src/platform` owns tenant/key authentication, scopes, idempotency, rate budgets and a neutral domain-event outbox. It translates commands into the existing domain and cannot directly assign finalized state or trusted evidence hashes. Human tokens and API keys authenticate distinct HTTP surfaces.

Migrations 023–026 are additive. API tenant bindings are immutable and external IDs are scoped by tenant. API management writes and request audits retain the actor/key identity without raw secrets. Outbox events commit with their originating domain audit. PostgreSQL delivery leases support multiple workers; receivers must deduplicate event IDs because delivery is at least once. No queue broker or new service is required.

Resumable evidence parts are bounded and hash-verified. Local client upload state never becomes Proof state. Receipt and return stages have their own frozen manifests and a targeted receiver grant; they reference the frozen root and previous stage instead of reopening it. Retention controls are supplementary audit records. Exported packages include the exact core manifest plus clearly separated shipping, access and lifecycle supplements.

The pilot API allocates 1 GiB for bounded media processing. Bounded media/export paths still need exact-candidate capacity validation before high concurrency. Sandbox labels isolate partner namespaces but do not replace a separate staging deployment. See [PUBLIC_API.md](PUBLIC_API.md), [COMPREHENSIVE_PLAN_EXECUTION.md](COMPREHENSIVE_PLAN_EXECUTION.md), and [PILOT_RUNBOOK.md](PILOT_RUNBOOK.md) for the contract, limitations and launch gates.


## Organization and API/client additions

The owner-key `/v1` profile remains compatible. The implemented organization foundation adds `/v1/partner`, authenticated `/me/organizations` administration, service principals/credentials, actual human memberships, scoped expiring delegations and immutable source-account/order bindings (migrations 089–092). Service credentials cannot create personal attestations. Current membership, credential and delegation policy is checked on reads, capture, replay, queued external delivery and streaming access; immutable participant and manifest history is retained after revocation. Enrollment/activation is a controlled-cohort operation, not public self-service.

Migration 088 already supplies a commit-safe event stream through a transactional per-tenant counter and deferred source-transaction triggers. Preserve the legacy sequence endpoint and use the signed stream for dependable catch-up. The API/client candidate's materialized reconciliation snapshot extends that feed, rather than introducing another event authority. Existing signed cursors expire in at most seven days; the proposed 30-day replay objective requires its own retention and recovery evidence.

Existing root signing, integrity-envelope jobs (migration 093), key/trust checks and independent verifiers must be reused. A verified signature authenticates particular bytes under a particular key; it does not prove physical packing truth or an independently trusted capture time. Configured assurance and protected storage/restore claims require current environment evidence.

The client dashboard remains a read surface over authoritative canonical Proofs. Its Ready projection must require the applicable durable evidence, declaration and finalization receipts, while export generation and webhook delivery remain independent operational facts. Preserve legacy logical completion semantics without presenting unconfirmed legacy records as durable preservation.

Rollback is configuration-led and uses a new-schema-aware compatibility image. Stop new admission or the affected connection/cohort, retain readable records, keep current grant/revocation enforcement, and let explicitly authorized preservation work reconcile already accepted evidence. Never drop additive tables, undo grants/revocations, delete pending journals, rewrite manifests or replace original object-version identities to obtain compatibility. See [release gates](api-client-release/RELEASE_GATES.md).
