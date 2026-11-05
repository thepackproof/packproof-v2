# API implementation boundary

The generated [partner contract](../../backend/partner-openapi.json) describes actual mounted routes. `node scripts/check-records-api-readiness.mjs` compares source mounts, parameters, authentication and generated freshness. Static alignment does not prove production activation or customer acceptance.

| Capability | Implemented surface | Boundary |
| --- | --- | --- |
| Canonical records | Partner Proof creation, resolution, listing and source bindings | Canonical Proof IDs, explicit operator, permanent scoped business identity and operational revision. |
| Record operations | Partner/human history, evidence, requirements, lifecycle, amendments and relationships | Current organization/environment/location authority; revision and idempotency protection; operational rows remain distinct from historical signed inventory. |
| Source observations | Partner ingestions and operation resources | Durable source receipts, duplicate/conflict outcomes, recoverable leases and current source/credential/delegation authority. |
| CSV | Human imports and partner /imports preview/commit/outcomes | Preserved UTF-8 originals, mapping/time zone and explicit partial acceptance. One-time imports do not claim ongoing sync. |
| Source files | Partner /upload-sessions, artifact operations and /evidence/{artifactId}/download; human source-artifact routes | Bounded resumable parts, exact digests/versions, durable worker admission, provenance and current streaming authority. Attachments do not become personal attestations. |
| Canonical packages | Partner/human snapshot selection, /exports and package streams | Fixed CORE/LIFECYCLE/ENVELOPE selection; complete-original policy and durable bounded exports; expiry describes hosted access. |
| Operational snapshots | Human requests; human/partner manifest/status/package reads | Exact frozen operational revision, explicit omissions, protected storage/signing/recovery, independent verifier and qualified cohort. Human signing admission only. |
| Snapshot shares | Human/partner /shares and public recipient package resources | Exact fixed selection, hash-only bearer token, encrypted retry response, bounded expiry, permanent revocation and current issuer authority. Downloaded copies cannot be recalled. |
| Deletion review | Human/partner impact and /deletion-requests; human review | Current impact digest, holds and retention; service attribution and deliberate administrator review. Physical or backup erasure is unavailable. |
| Requirement sets | Human requirement-template catalog, immutable publication and exact record/subject assignment | Administrator publication/assignment, reasons, due times, template digest and version preservation. No automatic policy inference or service waiver. |
| Quantities and allocations | Typed attributes on item/entity commands and current entity-reference matching | Exact decimal/unit/tolerance evaluation, named same-record packages/pallets, append-only corrections and explicit ambiguity. Provider-specific packs and cross-shipment allocation remain unqualified. |
| Review routing | Eligible-reviewer resources and issue assignment commands | Human administrator or issues:assign plus proof-write service authority. Assignee must currently read this record; routing does not resolve or impersonate. |
| Portal | Records, attention, setup, connections, packages and team views | Current access precedes searches/counts/results; entity-scoped history/evidence/requirements, guided CSV repair and first-use tour. |
| Clients/events | Node/TypeScript and Python candidate SDKs, committed stream and signed webhook profile | Stable retries, opaque cursors, polling and authenticated binary transfer. Registry publication and Standard Webhooks wire migration are not implied. |

The current contract covers 119 mounted records operations and 145 total operations. All seven originally missing additive partner route families now have source implementations. This does not establish general availability: a supported automatic connector, physical disposition, deployment/restore qualification, source-specific modeling, user studies, independent review and observation remain open.

See [continuation receipt](CONTINUATION_2026-11-04.md), [quantity and requirement conventions](QUANTITIES_AND_REQUIREMENTS.md) and [release gates](RELEASE_GATES.md).
