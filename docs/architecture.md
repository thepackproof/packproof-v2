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
- KMS only if signing is introduced later
- SQS only for genuine async jobs (none in this slice)
- Secrets Manager for trusted integration credentials. The ECS **task role** (application AWS SDK) may call `secretsmanager:GetSecretValue`, `CreateSecret`, `PutSecretValue`, and `DeleteSecret` on `packproof/staging/integrations/*`. The task execution role is only for image pull, logs, and injected RDS credentials.

Do not use DynamoDB or Firebase as canonical Proof storage. Do not put Proof transitions on Lambda.

## Local run

See `backend/README.md`. Tests use PostgreSQL-compatible PGlite. Runtime uses `DATABASE_URL` PostgreSQL when configured.

`GET /health` and `GET /meta` are unauthenticated. `/meta` returns only service, environment, commit, version, and image identifiers supplied through explicit release variables. It does not dump process environment.

Phase 10 mobile client: `mobile/`. It issues V2 domain commands and renders returned Proof state. It does not own Proof lifecycle.

Web reference client: `web/`. Same API, same canonical Proof. Local Vite for development. Staging hosting is S3 + CloudFront; see [WEB_CLIENT.md](WEB_CLIENT.md).

Packing Station Mode is a client workflow over those commands. Merchant finalization requires qualifying fulfillment capture decided by the server. Preferred station completion is a same-transaction rescan; see [PACKING_STATION.md](PACKING_STATION.md).

## Canonical Proof contract

One evidence core, multiple surfaces. Mobile, future marketplaces, claims desks, and portals consume the same Proof through the API authorization boundary.

See [CANONICAL_PROOF_ARCHITECTURE.md](CANONICAL_PROOF_ARCHITECTURE.md). Account search and account-targeted invitations are described in [USER_SEARCH_AND_INVITATIONS.md](USER_SEARCH_AND_INVITATIONS.md). Custody assets, observations, transfers, `nextAction`, and guest viewing links are described in [CUSTODY_WORKFLOW.md](CUSTODY_WORKFLOW.md).

Provider-neutral purchase import (reference adapter plus the first live marketplace connector) is described in [TRANSACTION_INGESTION.md](TRANSACTION_INGESTION.md). Automatic fulfillment ingestion and the seller packing queue are described in [AUTOMATIC_FULFILLMENT_INGESTION.md](AUTOMATIC_FULFILLMENT_INGESTION.md). Append-only shipment observations and the recomputed shipment integrity supplement are described in [SHIPMENT_EVENTS.md](SHIPMENT_EVENTS.md). The trusted carrier runtime is described in [TRUSTED_SHIPMENT_INTEGRATIONS.md](TRUSTED_SHIPMENT_INTEGRATIONS.md). EasyPost Tracker test/staging tracking is described in [EASYPOST_TRACKING_INTEGRATION.md](EASYPOST_TRACKING_INTEGRATION.md). eBay seller OAuth and Sell Fulfillment order import is described in [EBAY_INTEGRATION.md](EBAY_INTEGRATION.md). Connected accounts (eBay, Shopify, Google, Meta/Facebook) are described in [CONNECTED_ACCOUNTS.md](CONNECTED_ACCOUNTS.md). Direct UPS/FedEx/USPS/Shippo APIs are not implemented. EasyPost is not a production-supported carrier rollout.
