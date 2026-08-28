# PackProof V2

Independent Proof engine for the PackProof V2 release candidate.

This is **not** a branch of the legacy PackProof application. Legacy code stays in `C:\src\PackProof\repo`. See [docs/LEGACY.md](docs/LEGACY.md).

The Proof is the product. This repository implements one transaction-bound PackProof with server-authoritative state, append-only evidence, and a deterministic final manifest.

## Layout

- `backend/` — modular monolith REST API
- `docs/` — binding specification and architecture

## Quick start

```text
cd backend
npm install
npm test
npm start
```

Without `DATABASE_URL`, the API uses an on-disk PGlite database under `backend/data/` so the process can run locally. Production and shared development must use PostgreSQL.

```text
GET http://127.0.0.1:3000/health
```

Set `PACKPROOF_DEV_AUTH=true` to create local users via `POST /auth/dev/login`.

## Documentation

- [Development plan](docs/DEVELOPMENT_PLAN.md)
- [Architecture](docs/architecture.md)
