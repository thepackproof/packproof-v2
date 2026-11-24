# PackProof V2

Independent repository. Not a branch or fork of the legacy PackProof app.

Authoritative specification: [docs/DEVELOPMENT_PLAN.md](docs/DEVELOPMENT_PLAN.md)

Architecture for this repo: [docs/architecture.md](docs/architecture.md)

Legacy system (do not modify from this repo): `C:\src\PackProof\repo` at `origin/master` (`c24cd22`). Recommended tag in that repo, applied separately: `legacy-v1`.

Clients use the [canonical Proof contract](docs/CANONICAL_PROOF_ARCHITECTURE.md). The API owns Proof identity, evidence history and access checks. Warehouse integrations use the [order workspace API](docs/ORDER_WORKSPACE_API.md) with the approved organization, facility and source scope.
