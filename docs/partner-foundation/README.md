# Organization foundation candidate - 20-21 October 2026

This implements a gated foundation batch from the attached **PackProof API Infrastructure Development Plan v1.0**, requirements M0 and M1, with the independently useful merchant receiver sample. It is **not foundation release approval or completion of M2-M5**. New organization APIs default off. The owner-approved isolated test foundation is deployed with 90-day GOVERNANCE Object Lock; see [deployment evidence](isolated-deployment-evidence-2026-10-20.json). Production deployment, live provider submission, customer contact and pricing decisions remain separate gates.

## Baseline reconciliation (M0-01)

Implementation base: `main` at `cb82e6e57d50c51e4c55c3e1525a3adc61ce15d5`, repository `thepackproof/packproof-v2`. The plan's documented `bbcea01bdb8574da751125f35ad97ecc976f4dba` is older. The GitHub tree was pinned before editing; backend source was reconciled to that tree. The final candidate is identified by PR #108 and its exact CI artifacts. The [22 October continuation](RELEASE-CONTINUATION-2026-10-22.md) repairs limited SIGNAL behavior and client test expectations and records restored AWS access. Historical results below retain their original source bindings; they are not the current CI status.

| Area | Source actually present at the pinned base | Candidate treatment | Deployment evidence |
| --- | --- | --- | --- |
| Canonical Proof | `domain/create-proof.ts`, `proof-access.ts`, `finalize.ts`; unique transaction/Proof and role constraints | Reuse; explicit assigned operator for new organization imports | Shared capture, attestation, signing and export exercised through isolated authenticated HTTPS |
| Capture/recovery | `capture/service.ts`, `domain/capture-sessions.ts`, `resumable-upload.ts`, `recovery-journal.ts`, `recovery-restore.ts` | Recheck issuing grant and credential; preserve existing protocol | Device and staging gates open |
| Signatures | Manifest signing, KMS runtime, signed supplements and trust registry already exist | Move root signing outside domain transactions; compare exact bytes on commit | Isolated KMS/private-storage restore passed; independent trust review open |
| Portable review | `domain/evidence-review.ts`, `verifier/verify.py`, existing `.pkpr`/ZIP layout | Use existing bounded package exporter with an explicit delegated read capability | Offline/staging full matrix open |
| Partner identity | Owner-bound API tenants/keys; no organization model | New merchant/partner/service/member/delegation associations | Synthetic local/CI/RDS checks plus six real Cognito MFA identities against the private deployed API |
| Event feed | Transactional outbox; legacy sequence cursor | Add transactional tenant counter and signed reconciliation cursor | CI PostgreSQL and isolated RDS concurrency gate passed |
| Claims, parcels, custody, retention | Existing lifecycle/claims/export/identifier/custody/retention services | Retain; no duplicate models or speculative provider activation | Existing source is not deployment certification |
| Web/Android/iOS/desktop | Existing capture hosts and separate SIGNAL work | No UI rewrite; partner intent currently allows WEB/ANDROID only | Actual-build acceptance required |

The older architecture document's exclusions do not override the attached additive program. Conversely, its proposed JWS envelope and trusted timestamps are not satisfied merely by the existing DER ECDSA manifest signatures. Those are separate M2 work with a stable storage/trust prerequisite.

## Implementation map

| Requirement / ticket | Implementation | Migration | Surface / evidence |
| --- | --- | --- | --- |
| M0-02, INV-01/02/05 | [Decisions](DECISIONS.md); canonical core reused | Existing constraints retained | No historical manifest rewrite or automatic buyer participation |
| M0-03, MIG-01/02 | `backend/scripts/organization-preflight.sql`; source pin; replay/integrity tests | Additive only | Historical deployed exports/hashes must still be collected before staging/production migration |
| M1-01, C01-01/02, C08-01/02 | `platform/organizations.ts`, `partner-proofs.ts` | 089 | Two merchants, different owners, one partner, three operators, colliding order IDs |
| M1-02, AUTH-01/02/03 | `organization-access.ts`, `proof-read-grant.ts`; domain read/capture/attestation hooks | 089, 091 | `organization-foundation.test.ts`; new actions, lists, replay and queued delivery recheck current authority |
| C08-03/04, CON-02 | `organization-router.ts`, `partner-router.ts`; encrypted secret replay | 090, 092 | Disabled entitlement bootstrap; fresh human auth for administration; hashed service keys |
| M1-03, T06 | `domain/finalize.ts` | None | Sign outside transaction, rebuild/compare exact candidate, immutable replay; signing-boundary tests |
| M1-03/05, AUTH-03 | Existing policy journal and restore allowlists extended | 092 | Revocations journaled; isolated fresh-target restore preserves authority and denies revoked access; deployed cutover remains gated |
| M1-04, EVT-01–04 | `platform/event-stream.ts`, deferred database triggers | 088 | Legacy `/v1/events` unchanged; new `/event-stream`; local rollback/cursor tests and real-PG gate |
| CON-01/04, C09-04 | `proof-pagination.ts`, problem responses | 088 stream reused | Signed tenant/environment/query cursor; committed membership snapshot |
| M1-04, T08 | `examples/merchant-receiver` | Separate merchant schema | Inbox and job one transaction; restart/duplicate/forgery tests |
| M1-05/06 | PostgreSQL CI gate, [operations](OPERATIONS.md), [acceptance record](ACCEPTANCE.md) | 088–092 | Candidate evidence required before activation; no release recommendation yet |

## Contracts and first synthetic integration

Machine contract: [`backend/partner-openapi.json`](../../backend/partner-openapi.json), served at `/v1/partner-openapi.json`. The legacy contract gains only `/v1/event-stream` and a pointer to this separate profile. Partner paths use `/v1/partner`; human administration uses `/me/organizations`.

1. With an existing privileged, Cognito-verified developer account and recent authentication, create two disabled merchant organizations with different owners and one disabled partner organization. Enable only an explicitly approved synthetic cohort. Self-registration never enables API access.
2. Each merchant owner grants the partner specific scopes and explicit permitted operator users. Add actual authenticated operators as memberships; do not supply display names as identity. Create one server-only principal/credential and one integration namespace for each merchant's source account.
3. Import an order with a stable `Idempotency-Key`, merchant selector and exact delegation ID. The immutable snapshot includes amount as an integer decimal string plus currency, without floating-point conversion. A namespace is not a claim that an external provider is connected.
4. Request capture for the returned Proof. Deliver `launchPath` to the authorized operator through the existing hosted capture entry. It contains a short-lived fragment bearer token; keep it out of logs, analytics and referrers. The person signs in, records/reviews and personally attests through existing first-party services.
5. Reconcile using the signed event stream; treat notifications as hints to fetch current authorized state. Use the [receiver](../../examples/merchant-receiver/README.md). Read review/package under `exports:read`; an open stream periodically rechecks access. A package is not a claims-provider submission.

The server-side [reference adapter](../../examples/merchant-receiver/partner-client.mjs) performs import, resolve, capture request, polling and package download. It deliberately does not record video or attest. Full reusable SDK/controller publication is gated on M1, as required by the plan.

## Current activation status

- **Implemented:** additive organization/delegation/import/capture authorization, commit-safe feed, signed pagination, receiver, signing boundary, contracts, policy journal hooks and runbooks.
- **Locally tested:** the focused results listed in ACCEPTANCE.md. PGlite and a test object store do not establish PostgreSQL concurrency, Object Lock or real device behavior.
- **CI verified:** application candidate `9a070777857812dc8bcc56a898b32f5e2f14effc` passed full backend typecheck/build, 1,397 tests and 15 credential/session guards; 15 tests were skipped. Its focused suite passed all 41 checks, including real PostgreSQL; CodeQL, infrastructure and all dependency audits passed. This candidate fixes a duplicate integration namespace returning 500: it atomically returns a scoped 409 without changing ownership, verified against the deployed image. The unchanged baseline web/mobile failures (84 and two) remain release blockers. See [acceptance](ACCEPTANCE.md) for exact runs.
- **Isolated foundation deployed:** Collin approved the new 90-day GOVERNANCE retention. The [separate test foundation](../../infra/partner-foundation/README.md) is deployed; actual retention, conditional-write, deletion-denial and KMS signing probes passed. The protected recovery drill passed 27 scoped-role and fresh-target checks. The later runtime deployment adds separate API/worker task roles and actual cached-credential fence probes; independent review remains required.
- **Isolated database verified:** source `c03fbf9b6745078fb46a2e3d1b0068bf0d0b8b5e` passed baseline migration preservation and all seven shared organization/capture/concurrency checks on private RDS with TLS. Before/after archives, signatures and 14 frozen entries were verified. The temporary runner, owner-secret role and NAT were removed; encrypted logs and evidence remain. See [migration evidence](isolated-migration-evidence-2026-10-20.json).
- **Protected recovery and MFA verified:** [recovery evidence](isolated-recovery-evidence-2026-10-20.json) records 27 checks, 25 retained journal versions, externally fenced old writer sessions and exact manifest/authority restoration. [Identity evidence](isolated-identity-evidence-2026-10-20.json) records nine required-MFA checks. Temporary runners, roles and network egress were removed; protected evidence and the test pool remain.
- **Deployed runtime:** separate private API and worker Fargate services use distinct ECS-only workload/execution roles, dedicated non-owner PostgreSQL logins, managed configuration and pinned TLS. Both merchants have completed shared capture, preservation, KMS signing and package export through real authenticated endpoints; revoked open capture is denied without changing the retained synthetic original. Exact image, run outcomes, offline verification and pause state are recorded in [runtime evidence](isolated-runtime-evidence-2026-10-21.json).
- **Device / live partner:** actual web/Android sessions, revocation during streamed export/queued delivery and independent M1 review remain open; see [review handoff](RELEASE-REVIEW.md). No named consenting partner or real-device session was supplied. Synthetic endpoint execution does not establish device lifecycle behavior or merchant adoption.
- **M2-M5:** retain the plan's dependency and activation gates. Complete remaining M1 device/streaming/queued-delivery evidence and a recorded technical release review before full SDK activation. The plan does not mandate a separate human reviewer; implementing-agent review must be identified accurately. Independent work may continue while an external activation is blocked. Production and legacy resources are unchanged.
