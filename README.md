# PackProof V2

Independent Proof engine for the PackProof V2 release candidate.

This is **not** a branch of the legacy PackProof application. Legacy code stays in `C:\src\PackProof\repo`. See [docs/LEGACY.md](docs/LEGACY.md).

The Proof is the product. This repository implements one transaction-bound PackProof with server-authoritative state, append-only evidence, and a deterministic final manifest.

## Layout

- `backend/` — modular monolith REST API
- `mobile/` — Expo Android client for capture, recovery, Proof reading, sharing, and receipt/return stages
- `web/` — first-party web client and Packing Station over the canonical Proof API
- `docs/` — binding specification and architecture

## Quick start

```text
cd mobile
npm ci
cd ../backend
npm ci
npm test
npm start
```

Backend regression tests import shared mobile presentation and capture modules,
so install both packages when running the test suite from a fresh checkout.
For the browser client, run `npm ci` and `npm run dev` from `web/`.

Without `DATABASE_URL`, the API uses an on-disk PGlite database under `backend/data/` so the process can run locally. Production and shared development must use PostgreSQL.

```text
GET http://127.0.0.1:3000/health
```

Set `PACKPROOF_DEV_AUTH=true` to create local users via `POST /auth/dev/login`.

Staging API: `https://pa-5faf90eb81cb4764b37bd3dc259a5ac4.ecs.us-east-1.on.aws`. Staging web: `infra/deploy-web.ps1` (S3 + CloudFront, same API). See [docs/WEB_CLIENT.md](docs/WEB_CLIENT.md).

## Documentation

- [Development plan](docs/DEVELOPMENT_PLAN.md)
- [Architecture](docs/architecture.md)
- [Canonical Proof contract](docs/CANONICAL_PROOF_ARCHITECTURE.md)
- [Transaction ingestion](docs/TRANSACTION_INGESTION.md)
- [Automatic fulfillment ingestion](docs/AUTOMATIC_FULFILLMENT_INGESTION.md)
- [Packing Station](docs/PACKING_STATION.md)
- [Shipment observations](docs/SHIPMENT_EVENTS.md)
- [Web reference client](docs/WEB_CLIENT.md)
- [Custody workflow](docs/CUSTODY_WORKFLOW.md) (including guest Proof viewing)
- [Connected accounts](docs/CONNECTED_ACCOUNTS.md)
- [Public API](docs/PUBLIC_API.md)
- [Pilot and release gates](docs/PILOT_RUNBOOK.md)
- [September 5 repository audit](docs/STATE_OF_PACKPROOF_2026-09-05.md)
