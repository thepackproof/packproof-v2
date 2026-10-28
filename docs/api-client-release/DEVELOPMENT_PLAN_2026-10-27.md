# PackProof API & Client Dashboard Development Plan

**Prepared for Collin Neri and the PackProof development team | October 27, 2026**

## 1. Product outcome and release boundary

PackProof should fit into a client's existing order or fulfillment workflow: connect once, associate each eligible transaction with its canonical Proof, capture through the supported PackProof experience, and let PackProof preserve and process the evidence automatically. Client staff open a simple dashboard whenever they need to find, play, share, or export a Proof.

The first release is complete when a real external integration can create or find an order-bound Proof, launch capture for the correct authorized operator, survive an interruption, observe authoritative completion, and retrieve the same record through the API and dashboard.

“Hands-off” means automatic synchronization, association, upload recovery, finalization after deliberate confirmation, notifications, and reconciliation. Physical recording and human attestation still require an authorized person or configured capture source. An imported order is not packing evidence.

**Keep the established platform:** Node/Express modular monolith, PostgreSQL authority, S3 evidence, Cognito user identity, existing mobile/web clients and database-backed background jobs. Extend the existing public API and viewer. Platform-specific adapters translate into the same domain services.

Initial scope: one proven merchant/partner workflow, existing Android/web capture, one small dashboard, recoverable background operation, documented API and independent HTTPS acceptance tests. Continue current app improvements on the shared core.

## 2. Examination: existing foundations and material gaps

This plan is based on repository documentation and the inspected OpenAPI contract from `thepackproof/packproof-v2`, plus prior PackProof architectural decisions. Repository descriptions establish documented behavior, not a successful production test. The referenced October 20 ASTRA plan was identified in prior context; its full document was not available in this session. No runtime, device, or production acceptance results are asserted here.

| Area | Evidence examined | Development implication |
|---|---|---|
| Universal API | PUBLIC_API describes `/v1/proofs`, tenant keys/scopes, idempotency, events, uploads, access links and packages | Reuse these contracts; a second order/proof API is unnecessary |
| Developer access | PUBLIC_API restricts developer access, keys and developer webhooks to an exact account allowlist | Introduce explicit merchant/partner eligibility and authorization before onboarding external clients |
| Actor model | Keys currently act as one tenant owner's recorded identity; delegated organization membership is excluded | Separate integration identity, merchant permission and actual operator attribution before employee/partner capture |
| Capture launch | Existing capture/viewer links open authenticated first-party applications; capture links are not bearer grants | Preserve this useful path; add narrowly scoped session launch only where needed |
| Recovery | Resumable upload and recovery receipts are documented; browser root-capture recovery exists | Test real interruption/receipt durability; document platform-specific recovery limits |
| Event delivery | Transactional outbox, leases, signed webhooks, retry history and replay exist | Harden and verify them rather than introducing another broker by default |
| Polling | PUBLIC_API explicitly warns that a sequence cursor can skip a late commit | Add a commit-safe change feed plus state reconciliation before advertising dependable catch-up |
| Dashboard | WEB_CLIENT already describes Proofs, search, Recording / Activity / Tracking, Sales channels and recovery | Simplify and extend this surface; preserve useful existing work |
| API contract quality | Inspected OpenAPI operation responses include generic object schemas | Replace underspecified response/error schemas with complete DTOs and enforce generated-client compatibility |
| Commerce adapters | Older architecture/fulfillment pages say live connectors are future; CONNECTED_ACCOUNTS and SHOPIFY_FULFILLMENT describe implemented Shopify/eBay paths with pending live validation | Reconcile docs, code, deployment and provider approvals; do not rebuild a connector or claim it is live from documentation alone |
| Integrity/signing | Public API/execution docs describe hashes and signing as future/unconfigured; more recent project context refers to integrity-envelope work | Inventory the actual candidate implementation, key configuration and verifier; expose only demonstrated assurance |
| Capacity/retention | Pilot docs identify bounded media processing, real PostgreSQL/load/restore gates, and deletion review rather than automatic day-90 destruction | Measure capacity and restore; preserve current retention safeguards |

**First deliverable:** a candidate capability ledger containing feature, code path, schema migration, public contract, configuration, automated test, staging observation and production status. Each row is implemented, configured, validated, deferred or blocked. Resolve contradictory documentation against the tested candidate.

### Invariants to preserve

- One transaction has one canonical root Proof, protected by database uniqueness.
- Only validated server commands change canonical Proof state.
- Capture, upload and connection health are separate from Proof lifecycle.
- Committed evidence, attestations and finalized core manifests remain immutable.
- External identities never silently rebind.
- Receipt/return stages and shipment observations retain their existing separately linked supplement semantics.
- Merchant order context, integration assertions, PackProof-established facts and human attestations retain distinct provenance.
- Existing Android/web commerce capture continues to work.

## 3. The effortless integration journey

### Client setup

1. A merchant signs in, creates or selects its workspace, and authorizes the integration.
2. The client chooses the supported provider connection or uses a server-side API key. Store credentials in its server secret manager.
3. PackProof displays connection health and runs a synthetic setup check.
4. The integration submits one eligible transaction using the existing `POST /v1/proofs`.
5. The response returns the canonical Proof and existing capture/viewer links.
6. The operator opens capture on the correct order, records one uninterrupted video, reviews it and deliberately confirms the statement.
7. PackProof resumes upload, verifies and commits evidence, records the attributable confirmation, and finalizes through existing domain rules.
8. A signed `proof.finalized` event tells the integration the core Proof is ready. It stores the stable authenticated viewer URL against the original order.
9. The dashboard and API expose the same authoritative Proof.

The merchant should authorize a device/operator once per appropriate session, not retype order details or sign in for every parcel. Do not add a second manual “Finalize” step to the established ordinary capture flow.

### Minimal existing request

```http
POST /v1/proofs
Authorization: Bearer <server-side-key>
Idempotency-Key: order-1001
Content-Type: application/json

{
  "externalId": "merchant-order-1001",
  "transaction": {
    "itemTitle": "Collectible card",
    "quantity": 1,
    "transactionValue": 3000,
    "currency": "USD",
    "shipping": {
      "carrier": "UPS",
      "trackingNumber": "confirmed-tracking-number"
    }
  }
}
```

The documented response envelope is `{ apiVersion, externalId, proof, links }`. Use the actual generated response type; do not invent a second envelope. The integration reads `proof.proofId`, `proof.status`, `links.capture` and `links.viewer`.

This sample follows the existing contract. The quickstart must explicitly document monetary units, required versus optional fields, accepted item arrays, size limits, and conflict behavior. Multi-item orders must retain every authoritative line item.

Supported consumption modes share the same API: provider connection for a merchant, direct API for a custom system, and hosted capture/viewing for partners who want minimal UI work. An SDK is optional.

## 4. Identity, merchant permission and stable transaction association

### Distinct actors

| Identity | Meaning | Authority |
|---|---|---|
| Merchant/workspace | Business controlling the transaction and evidence access policy | Authorizes integration and staff access |
| Integration application | Software making an API call | Only active merchant grants and allowed scopes |
| Operator | Person recording or confirming evidence | Their authenticated, granted actions |
| Subject/participant | Party or item relationship described by the Proof | Does not automatically gain access |
| Capture source | App, session, device or external system producing a record | Attributed source, never automatic proof of truth |

Do not represent every client employee as the merchant owner. Do not treat a platform credential or a supplied operator name as human confirmation.

### Authorization implementation

Retain scoped hashed API keys for direct merchant integrations. Add integration applications and merchant grants for partners serving multiple merchants. Credential format alone does not solve delegation; OAuth client credentials, if introduced, authenticate software and still require merchant authorization.

Proposed additive records, reconciled with existing tables:

- `integration_applications`: app identity, status and allowed capabilities.
- `merchant_grants`: application, existing tenant/workspace, scopes, grantor, status, expiry and revocation.
- `workspace_memberships`: user, merchant, role and status, only for the pilot's actual staff needs.
- `capture_sessions`: Proof, authorized operator, grant, source, expiry, recovery reference and status.
- Audit attribution: retain application/key, merchant grant, operator subject and source separately.

Effective permission is the intersection of credential scope, active merchant grant, current user/session rights where required, and resource policy. Check this on API reads, mutations, media, exports, new partner job actions and new session creation. A supplied merchant ID is only a selector.

Revoking a partner grant stops new partner intake, capture actions, reads and future external delivery, including queued actions. First-party preservation/reconciliation of already accepted evidence continues under explicit platform authority so revocation cannot strand an acknowledged original. It may finish a previously authorized and confirmed operation; it cannot invent a missing attestation or authorize new partner work. Merchant first-party access follows its own current policy.

Current owner-mode credentials retain documented compatibility while new partner credentials receive no human-attestation authority by default. Historical audit entries and manifests are not rewritten. Expand authorization through explicit resource grants rather than adding staff to frozen participant sets.

Replace developer eligibility deliberately with merchant/application enrollment and grants. Keep first-party administration restricted. Until this is deployed, onboarding remains a controlled named pilot rather than pretending external self-service works.

### Transaction identity

Preserve current immutable tenant/external-ID bindings and `UNIQUE(transaction_id)` on Proofs. Normalize official imports using the merchant plus stable provider/account namespace plus external transaction identity. The namespace uses a durable store/account identity, not an ephemeral connection row ID; reconnecting must not create a new transaction.

For direct API keys, document the existing tenant-scoped `externalId` namespace. Multi-store clients must disambiguate order IDs. Add any normalization/mapping internally without changing historical bindings.

Cross-channel reconciliation must resolve a known binding to the same canonical transaction only after merchant authorization and trusted source checks. Never merge two orders merely because display order numbers or tracking numbers match. Ambiguous matches go to review. Existing API-tenant isolation remains enforced, including between tenants with the same owner.

Split or mixed fulfillment must follow existing supported shipment scope. Unsupported allocations require review; do not silently create multiple roots or claim one video covers every shipment.

## 5. API development contract

Paths below distinguish existing capabilities from proposed additions. Confirm exact route/DTO behavior in the candidate ledger before implementation.

| Capability | Existing surface to retain | Planned work |
|---|---|---|
| Create/find canonical Proof | `POST /v1/proofs` | Complete request/response schemas; stable identity and concurrency tests |
| Search/list/read | `GET /v1/proofs`, `GET /v1/proofs/{id}` | Add compatible order/tracking/date/status filters, tenant-scoped indexes and documented pagination |
| Review and integrity context | `GET /v1/proofs/{id}/review`, manifest/recovery reads | Typed readiness, recovery and assurance fields; preserve trust classifications |
| Evidence upload | Existing admitted init/parts/complete/commit routes | Reuse resumability and authoritative receipts; no wholesale direct-S3 PUT replacement |
| Hosted capture | Existing authenticated `links.capture` | Proposed `POST /v1/proofs/{id}/capture-sessions` only if partner workflow requires a resumable, bound launch |
| Secure guest viewing | Existing access-link route | Clear media scope, expiry, revocation and audited creation |
| Package | Existing `GET /v1/proofs/{id}/package` | Retain pilot behavior; introduce an additive asynchronous export job only if load measurements require it |
| Webhooks | Existing subscriptions, delivery history and retry routes | Enrollment, test delivery, rotation behavior and operational retry/replay verification |
| Reliable catch-up | Existing `/events` has documented caveat | Proposed `GET /v1/changes?after=...` with commit-safe publication cursors and resync policy |
| Connection health | Existing first-party connected-account/store APIs | Typed last success, consent/pause state, credential health, backlog, coverage and safe next action |

A capture launch token, if needed, is single-use, short-lived and bound to Proof, merchant, grant, session and allowed return origin. It locates the permitted workflow; it does not silently authenticate an invented employee or authorize attestation. Keep credentials out of query logs, referrers and analytics; use a secure token exchange and clear launch material after exchange. Recheck current rights when resuming or committing.

### Contract rules

- Keep `/v1` additive and preserve existing response meanings. New routes/fields do not justify an API-version reset.
- Complete OpenAPI 3.1 schemas for canonical Proof envelopes, summaries, evidence, sessions, pagination, events, error codes and scopes. Keep the existing specification version unless tooling requires a tested change.
- Generate a small TypeScript client and documentation from the contract; validate examples against a running API. Eliminate stray or irrelevant operation parameters.
- Preserve current idempotency semantics: same principal/tenant, method, path, key and payload replay the committed result; changed payload returns `409 IDEMPOTENCY_CONFLICT`. Keep business uniqueness beyond replay-cache expiry.
- Inventory current idempotency retention first. Proposed minimum documented replay period for new integrations is seven days, subject to operational approval. Do not shorten existing retention. Expired replay caches never permit duplicate Proofs.
- Preserve `EXTERNAL_ID_CONFLICT` for changed transaction content; source updates use the existing audited revision model and cannot mutate a finalized snapshot.
- Keep request IDs and stable machine-readable errors. Adopt RFC 9457-compatible details additively or through negotiated media type, retaining existing clients' error codes.
- Document existing limits, including the documented tenant budget of 120 requests/minute and upload bounds of 5 MiB parts, 48 parts and 250,000,000 total bytes. Reconcile them with actual admission code and load tests before promising larger workloads.
- Default SDK metadata timeout: proposed 15 seconds; bounded exponential backoff with jitter for transport failures and retryable server errors. Honor `Retry-After`. Renew upload authorization rather than repeatedly retrying an expired target.
- Use exact-origin browser policies, authenticated object-level checks, bounded payloads and safe upload-content validation. Do not log credentials, access-link tokens, raw order text or media.

## 6. Reliable background operation

Retain the transactional outbox and PostgreSQL lease-based worker. A new queue service is justified only by measured isolation, throughput or long-running-work requirements. Preserve combined versus split API/worker deployment configuration already in use.

### Canonical state versus operational status

Canonical commerce states remain:

`READY_FOR_EVIDENCE → EVIDENCE_COMMITTED → FINALIZED`

The explicit counterparty-required path retains `OPEN` and `AWAITING_PARTICIPANT`. Existing domain rules remain authoritative.

Use separate operational projections for capture/upload progress, recovery/preservation receipt, export generation, connection state and webhook delivery. A webhook failure cannot unfinalize a Proof. A missing thumbnail cannot invalidate preserved originals.

Dashboard “Ready” requires authoritative finalization and the durable preservation/recovery receipts required by the candidate contract. A local “finished” screen or cached finalize response alone is insufficient. Exports may complete later.

### Failure behavior

| Failure | Automatic response | Escalation |
|---|---|---|
| Duplicate intake or concurrent create | Database uniqueness plus atomic idempotency return one existing canonical result | Alert only for contradictory identity/payload |
| Provider/webhook event repeats | Verify source, durably record/deduplicate intake before acknowledgement, process idempotently | Invalid signatures rejected and monitored |
| Upload interruption or expired authorization | Resume retained upload journal and server-confirmed parts; renew authorization | Operator only if original is missing, rejected or unsupported recovery is required |
| Lost commit/finalize response | Read Proof and recovery receipts; replay original command | Never initialize duplicate evidence to resolve uncertainty |
| Storage verification, database or optional signing dependency fails | Retain source and operation state; bounded retry, no false readiness | PackProof operations with operation/request IDs |
| Worker dies between storage and DB writes | Reuse immutable/deterministic artifact identity; reconcile unreferenced artifacts and unfinished operations | Preserve originals; no cleanup that races recovery |
| Partner endpoint unavailable | Durable bounded backoff, original event ID, fresh delivery signature, visible delivery status | Integration owner after retry exhaustion |
| Source authorization revoked | Pause source sync, preserve current Proofs and source checkpoints, show reconnect action | Merchant reconnects |
| Wrong/ambiguous order association | Hold association for review; preserve original and recorded attribution | Authorized operator resolves; no silent reassignment |
| Expected capture never arrives | Coverage projection identifies overdue eligible work | Merchant sees a specific next action |

Preserve current webhook signing format and five-minute verification tolerance unless an explicitly compatible extension is needed. Document secret rotation overlap, stable event IDs, distinct attempt IDs, destination allowlisting, DNS/public-address checks, redirect refusal and network timeouts.

Current docs specify ten webhook delivery attempts. Measure their elapsed retry horizon; do not describe that as a guaranteed 72-hour delivery window. The pilot must recover from a 24-hour receiver outage through automatic retries or durable replay/catch-up. Proposed replay/change-feed retention is at least 30 days, independently of media retention.

### Commit-safe catch-up

A raw database sequence is allocated before commit and cannot safely act as a committed high-water mark. Preserve the existing event IDs and legacy event endpoint behavior.

Add a publication feed using a serialized per-tenant publisher: it selects all committed, unpublished outbox events without advancing a raw-ID watermark, assigns monotonically increasing publication positions, and commits positions plus publication rows in one transaction. Serialize publishers for each tenant with a PostgreSQL row or transaction-level advisory lock held through the entire publication transaction. A scheduling lease alone is insufficient because it can expire while a stale worker is still writing. Enforce uniqueness on tenant plus publication position and tenant plus logical event ID, so a later visible page cannot be followed by an earlier uncommitted position. A late source commit receives a later publication position.

The new feed cursor refers to those committed publication positions. Consumers still deduplicate logical event IDs and fetch current Proof state; publication order is not a guarantee of physical event chronology. Index unpublished work and tenant/publication position. Feed retention expiry returns an explicit resync requirement. Provide a snapshot/reconciliation job and a cutover boundary; backfill and verify before enabling the feed.

For snapshot/resync, build a tenant-scoped materialized snapshot inside one PostgreSQL REPEATABLE READ transaction and read the committed publication boundary C from that same database snapshot. Persist the snapshot's rows and C atomically, then serve its stable pages without holding an HTTP-spanning database transaction. After reading all snapshot pages, the client consumes feed positions greater than C and deduplicates event IDs; authoritative GET resolves current state. Every relevant canonical mutation must write its outbox event in the same source transaction. A source change absent from the snapshot cannot have a visible publication at or below C; a pre-snapshot change published later can appear in both paths and is safely reconciled. Bind snapshot pages to current merchant authorization and a documented expiry. If snapshot/feed retention expires before completion, restart resync. Test concurrent writes on every snapshot page, late commits, cursor-expiry resync and worker death around every boundary.

### Scheduled reconciliation

Run server-side jobs while every client browser is closed:

- Continue provider page checkpoints and reconcile eligible orders against bound Proofs.
- Detect expected packing work without committed evidence.
- Recover stalled operations, unpublished events and expired worker leases.
- Recheck durable preservation receipts and package availability.
- Reconcile subscriptions/credential refresh only where the provider supports them.
- Report active holds, retention deadlines and deletion-review blockers.

Retries are bounded. Missing physical evidence and absent consent are actionable exceptions, never synthetic data to manufacture completion.

## 7. Simple dashboard clients can use on demand

Extend the existing web app. For the client review experience, use **Proofs**, **Connections** and **Settings**. Retain Orders/Station entry points for users who pack. Keep internal infrastructure/security operations in the protected administration surface.

### Proofs home

A search box accepts order reference, tracking number or Proof ID. Add date, connection and status filters, cursor pagination, clear empty states and a visible “last updated” indicator.

Each row shows:

| Column | Purpose |
|---|---|
| Order / Proof reference | Open the correct record quickly |
| Item or shipment summary | Distinguish similar orders and supported partial shipments |
| Recorded by / captured at | Attribution, with source and timezone available |
| Status | Awaiting capture, In progress, Ready, Needs attention |
| Next action | Only when the client can resolve an issue |

These are presentation groups over canonical state and operational projections. Do not add them to `ProofStatus`. Expanded progress may say Recording, Uploading or Processing. Show “Proof ready · notification retrying” when those facts coexist.

Small counts show Ready, In progress and Needs attention. Include coverage such as “42 eligible orders · 39 ready · 2 awaiting capture · 1 needs attention.” Show excluded/unsupported work separately so a low failure count does not hide missing capture.

### Proof detail

Default to the recording with a concise order header. Reuse Recording / Activity / Tracking where it works.

- Play only authorized committed media; preserve playback position.
- Show items/shipment scope, operator attribution and server receipt time.
- Timeline entries identify PackProof facts, human attestations and external observations.
- Integrity disclosure explains what was checked, which manifest is frozen and whether a signature is configured and verified.
- Download the portable package; show export progress separately.
- Share through an explicit scoped, expiring, revocable grant.
- Show media preservation/access window and any hold or unavailable-media reason.

Stable authenticated dashboard links remain usable during authorized retention. Do not use an expiring storage URL as the permanent client link. If presigned delivery is introduced, issue brief media access after checking live permission; already issued URLs may remain usable until their expiry. Immediate revocation requires authorization-aware delivery. Preserve stronger checks already present.

### Connections

Each connection card shows merchant/store identity, actual capability, automation opt-in/pause state, last successful order read, sync freshness/backlog, credential health, webhook health and a clear reconnect action. Identity-only providers must not imply order import.

Put API key rotation, scopes, webhook diagnostics and developer examples behind a developer/settings disclosure. Most clients should need only “Connected” or a concrete corrective action.

### Dashboard implementation constraints

Use shared API DTOs and existing components. Start with indexed PostgreSQL filters and an active-page refresh interval; pause unnecessary hidden-tab polling. Push updates can follow measured need. Test keyboard access, focus, status text beyond color, responsive layout and playable media on target browsers.

## 8. Evidence, preservation and “view whenever”

Separate byte integrity, signer identity, receipt time, declared capture time, provenance and physical-world truth. A valid hash/signature does not establish truthful packing contents or unobserved custody.

Preserve immutable originals and exact storage-version identities. Derived previews/exports retain lineage to committed sources. Any new signed envelope includes algorithm, key ID, canonicalization version and verification result. Use existing integrity-envelope work if it exists and passes conformance; do not build a competing signature format.

For the initial release, retain current 90-day protection semantics from the latest finalized commerce stage, active holds and unfinished-stage blockers. Display the actual policy; a permanent URL is not a promise of permanent media storage. Longer client retention is a deliberate policy/configuration extension.

Do not enable automatic physical deletion as part of this project. Current deletion requests trigger review. Object-lock floors, backups, holds and downstream exports must be considered by the existing authorized process.

Recovery design must cover PostgreSQL, originals, manifests, encrypted replay records, grants and required key history. Use managed backups/PITR and versioned object storage according to confirmed deployment capabilities. Restore into an isolated environment and verify actual Proof/media/export linkage.

Proposed planning objectives, pending restore measurement: metadata RPO at most 15 minutes and service RTO at most four hours. These are not guarantees of zero acknowledged-data loss. A durable receipt means the platform has verified and recorded the defined preservation step; disaster-recovery guarantees require separately demonstrated infrastructure protection.

## 9. Developer experience and measurable targets

Provide one quickstart, one generated TypeScript client, a runnable external adapter, a Bruno/Postman collection, signature-verification examples, a deterministic sandbox and an external acceptance runner. Use separate staging credentials and synthetic data: a sandbox label alone is not infrastructure isolation.

The quickstart must finish a real canonical sandbox Proof through supported operator capture, then receive an event, read it and export it. Document expected setup/approval delays separately. Include ready, incomplete upload, expired authorization, conflicting identity, revoked grant and failed delivery fixtures.

All targets below are proposed launch criteria, not measured results or contractual SLAs:

| Target | Measurement |
|---|---|
| First complete sandbox Proof in 30 minutes | Fresh external engineer following the quickstart; exclude enrollment waiting time and record failures |
| Zero routine dashboard actions after setup | Successful order sync + actual capture + automatic completion; no manual recovery or finalize |
| Find a known Proof in 30 seconds | Client support user searches order/tracking and opens playable evidence |
| Metadata API p95 under 500 ms | Measured at public HTTPS boundary at the agreed pilot load, excluding large media/export transfer |
| Ready within p95 60 seconds after required data/confirmation | From all required evidence/attestation being accepted to durable readiness; report upload duration separately |
| No integrity or cross-merchant access failures | Any failure blocks expansion |
| 100% controlled recovery scenarios | Required originals survive supported disconnect/restart/lost-response cases without duplicate commitment |
| Coverage is explainable | Every eligible imported transaction is ready, in progress, overdue or explicitly excluded |
| Monthly metadata availability objective 99.9% | Define valid-request denominator and measurement before presenting as a commitment |

Measure support interventions per 100 Proofs and retry recovery without staff work. Those two metrics determine whether operation is truly hands-off.

## 10. Implementation sequence and engineering backlog

Planning estimate: **six to eight weeks after baseline reconciliation for one experienced backend engineer, one web/full-stack engineer and part-time QA/product support**, assuming repository foundations pass and provider access is available. This is a scope estimate, not a commitment. Significant recovery, authorization or native-device failures require re-estimation. Parallelize dashboard read work with contract/DX work after their interfaces are stable.

| Phase | Deliverables / owner | Acceptance gate | Rollout and rollback |
|---|---|---|---|
| 0. Baseline, 3–5 engineering days | Backend lead: capability ledger, exact deployed/candidate SHAs, current schema/limits, docs conflicts, existing tests and restore design | One existing Proof completes through external HTTPS; historical hashes unchanged; unknown gates explicit | Read-only inventory and isolated validation; no production config changes |
| 1. Safe client access, week 1–2 | Backend: eligible merchant enrollment, app/grant model, minimal staff permissions, compatible external identity/DTOs | Two merchants with similar order IDs remain isolated; revoked grant denied; concurrent retries yield one root; legacy flows pass | Feature-flag pilot grants; additive migrations; disable new grants without reopening access |
| 2. One complete workflow, week 2–3 | Backend + web/mobile: order-bound capture launch, existing recorder/recovery, attributed confirmation, durable readiness | Real operator capture interrupted and resumed; API/dashboard same root and digest; no manual finalization | Enable one merchant; preserve journals and old authenticated link path |
| 3. Hands-off jobs, week 3–4 | Backend: verified adapter automation, inbox/outbox hardening, commit-safe feed, reconciliation and actionable exceptions | Browser-closed import; duplicate/late events; worker crash; 24-hour webhook outage recovery; no skipped changes | Per-connection pause and publisher/worker flags; retain pending jobs/feed rows |
| 4. Simple dashboard + DX, week 3–5 | Web/full-stack: Proofs/detail/connection health; backend: indexed filters, typed schema/client, quickstart and acceptance collection | Support user finds/plays proof in 30 seconds; fresh engineer completes sandbox; privacy/accessibility checks | Release read-only UI to pilot users; prior viewer remains available |
| 5. Production-like proof, week 5–8 | Backend + QA: real PostgreSQL concurrency, load/cost, restore, device runs, independent security review and pilot | All critical scenarios below pass on exact release; actual provider/device receipts; no hidden manual repair | Staging → one merchant/partner → small consenting cohort; halt expansion on any integrity/access/data-loss issue |

### Ticket set

| ID | Priority | Buildable work | Definition of done |
|---|---|---|---|
| PP-API-01 | P0 | Candidate capability ledger and documentation reconciliation | Every claimed feature maps to code/config/test/staging evidence |
| PP-API-02 | P0 | Merchant enrollment, integration app and grant authorization | External client can enroll within controlled pilot; admin protection and tenant isolation retained |
| PP-API-03 | P0 | Operator attribution and session launch | Human confirmation cannot be forged by a platform key; ordinary sign-in/capture preserved |
| PP-API-04 | P0 | Stable source identity and canonical binding | Reconnect, direct retry and official import do not create accidental duplicate roots |
| PP-API-05 | P0 | Full OpenAPI DTOs and compatible errors | Generated client round-trips real canonical responses; examples and diff checks pass |
| PP-API-06 | P0 | Recovery/readiness contract | Lost responses and restart resolve to authoritative preservation receipts |
| PP-API-07 | P0 | Commit-safe publication feed | Late lower-ID commits remain discoverable; cursor expiry/resync and backfill tested |
| PP-API-08 | P0 | Background intake and reconciliation | Eligible order arrives with browser closed; coverage accounts for every discovered item |
| PP-API-09 | P0 | Webhook delivery operations | Signature, replay, rotation, endpoint outage and recovery demonstrated |
| PP-API-10 | P0 | Simple Proofs/detail dashboard | Search, statuses, playback, attribution, export and scoped sharing work |
| PP-API-11 | P1 | Connection health and exception actions | Freshness, pause, reconnect and retry explain actual server state |
| PP-API-12 | P0 | Independent HTTPS acceptance runner | Runs without importing app/domain modules and exercises both valid and denied requests |
| PP-API-13 | P0 | Quickstart, SDK and deterministic fixtures | A new engineer completes it without undocumented operator intervention |
| PP-API-14 | P0 | Production-like load, restore and device validation | Real receipts/measurements attached to candidate; unsupported cases visible |
| PP-API-15 | P0 | Safe deployment and compatibility gates | Additive migration, current mobile/web regression, historical hash comparison and rollback verified |
| PP-API-16 | P1 | Usage/cost ledger | Unique finalized proof and storage/processing usage counted idempotently without new billing side effects |

Phase dependencies: 01 precedes estimates; 02–04 precede partner capture; 05 precedes SDK generation; 06–09 precede hands-off claims; 10–13 can overlap after contracts stabilize; 14–15 precede access expansion. No production write or deployment is performed by this planning task.

## 11. Required acceptance scenarios

1. A fresh authorized merchant uses the documented server-side API to create, capture, finalize, receive an event, view and export one Proof.
2. Ten concurrent creates with the same external identity and differing retry keys yield one transaction/Proof. Conflicting content fails explicitly.
3. Two stores share order “1001”; each resolves only to its own record. Reconnect preserves identity.
4. A partner authorized for merchant A cannot select merchant B in a body/header, job, list, search, export, session or media request.
5. An integration cannot impersonate an operator or receiver. Revoked merchant/staff/session grants reject new actions.
6. The supported Android and browser root-capture paths survive disconnect, refresh/restart where promised, expired authorization and lost commit responses.
7. Pending/unverified evidence, missing required confirmation or missing preservation receipts never appears Ready.
8. Kill a worker around storage promotion, DB commit and event publication; restart completes/reconciles without duplicate evidence or false completion.
9. Receive duplicate/out-of-order provider and partner events; canonical state and completion effects remain correct.
10. A transaction commits below an already allocated event sequence; the new publication feed still delivers it. Concurrent changes during every snapshot page and cursor-expiry resync leave no missing canonical records.
11. Keep the partner endpoint unavailable for 24 hours; durable retry/replay/catch-up restores the client without Proof-state regression.
12. A signed webhook with altered bytes, stale timestamp or invalid secret is rejected; secret rotation and retries remain usable.
13. Summary-only, expired and revoked viewing links cannot access media; documented residual URL lifetime is verified if signed media URLs are used.
14. Change source order/tracking after finalization; preserve the root snapshot and classify later observations separately.
15. Supported and unsupported split/mixed shipments display accurate coverage; no unrelated recording is assigned silently.
16. Restore database plus object versions/required keys; verify a finalized package against an independently obtained digest, then alter a file and confirm rejection.
17. Hold/active-stage/retention rules prevent premature destruction; deletion review does not falsely claim erasure.
18. Existing seller capture, deliberate confirmation, optional buyer participation, receipt/return stages, sharing and discovery pass regression on both devices and web.

Run integration/concurrency tests against real isolated PostgreSQL as well as the existing fast suite. PGlite tests, prebuild and mocked transports cannot establish cloud concurrency, physical camera behavior, restore success or live provider delivery. Complete required CI and independent review for the exact candidate.

## 12. Operations, cost and release control

Track API success/latency, worker heartbeat and oldest work age, source-sync freshness, eligible-order coverage, failed/resumed uploads, preservation receipt lag, finalization lag, publication lag and exhausted webhook deliveries. Correlate tenant, Proof, operation, event and request IDs while excluding sensitive payloads.

Alert PackProof operations for platform failures or overdue recovery. Show clients only failures they can resolve, with a clear action and the last successful step. Separate debugging logs from access/security audit.

Use the established deployment/migration gate and immutable image identity. Verify `/meta` matches the candidate and web bundle. Use expand-and-contract schema changes, feature flags and backward-compatible reads. Never roll back by deleting evidence, resetting migrations or dropping new audit tables. Do not roll back authorization into a state that ignores newly established grants.

Start with one existing-deployment topology and a named pilot. Split API and media workers only when load measurements show memory, latency or job isolation requires it. Current buffered media/export paths deserve particular measurement; improve bounded streaming before increasing upload promises.

Estimate storage from actual volume:

`raw storage GB ≈ proofs/day × average original MB × retained days / 1,000`

Illustration only: 1,000 proofs/day × 40 MB × 90 days is about 3,600 GB of originals before versions, backups, previews and export copies. Track bytes uploaded, transformations, retained versions, playback/download egress and logs per finalized Proof. Set per-tenant concurrency/storage budgets and operational cost alerts from measured pilot use. No cloud prices are assumed.

## 13. Decisions and scope controls

| Decision | Reason / tradeoff | Revisit when |
|---|---|---|
| Extend modular monolith and current managed infrastructure | Fastest route with fewer operational systems; shared runtime requires capacity discipline | Measured workloads need independent isolation/scaling |
| Keep current `POST /v1/proofs` intake | Existing developer contract already matches the golden path | A proven semantic requirement cannot fit additively |
| Hosted supported capture first | Least partner implementation work; browser/device limits must be explicit | A real partner needs embedded capture and can validate SDK behavior |
| Scoped keys plus merchant grants | Reuses foundations while preventing partner-as-human attribution | Marketplace distribution or enterprise federation requires additional flows |
| Existing PostgreSQL outbox plus safe publication feed | Repairs catch-up without a broker migration | Publish throughput/latency exceeds tested capacity |
| Small dashboard over existing viewer | Clients can retrieve evidence without a second application model | Pilot users demonstrate an unmet workflow |
| Preserve current retention/deletion protections | Prevents a convenience project from weakening evidence preservation | A separately defined client/privacy retention policy is implemented and validated |

Do not make broad connector coverage, new iOS/desktop applications, AI fraud decisions, a claims-management suite, a new cloud, microservices, custom cryptography or large analytics dashboards prerequisites for this release. Existing station/custody/lifecycle capabilities remain compatible. Expand only from a proven client workflow.

### First development instruction

Reconcile the candidate, then deliver one externally testable vertical slice:

**Authorized transaction → correct operator capture → interruption recovery → deliberate confirmation → preserved canonical Proof → signed event → searchable dashboard playback/export.**

Every later ticket should reduce integration effort, remove routine manual work, or make that record easier to retrieve without weakening its evidence or authorization guarantees.

## 14. Source references

Repository files read from the default branch during preparation. Some documents contain older statements superseded elsewhere; resolving them is PP-API-01.

- [Public API contract and limitations](https://github.com/thepackproof/packproof-v2/blob/main/docs/PUBLIC_API.md), inspected blob `052282ea34f55adc7c1a81942028e68c6d83b5ed`.
- [OpenAPI contract](https://github.com/thepackproof/packproof-v2/blob/main/backend/openapi.json), inspected beginning, blob `021b78c5e3e323fd94d1d26a46be5196f1a024ae`.
- [Architecture](https://github.com/thepackproof/packproof-v2/blob/main/docs/architecture.md).
- [Development plan and invariants](https://github.com/thepackproof/packproof-v2/blob/main/docs/DEVELOPMENT_PLAN.md).
- [Canonical Proof architecture](https://github.com/thepackproof/packproof-v2/blob/main/docs/CANONICAL_PROOF_ARCHITECTURE.md).
- [Web client and current ordinary capture/viewing flow](https://github.com/thepackproof/packproof-v2/blob/main/docs/WEB_CLIENT.md).
- [Automatic fulfillment ingestion and stable account namespaces](https://github.com/thepackproof/packproof-v2/blob/main/docs/AUTOMATIC_FULFILLMENT_INGESTION.md).
- [Connected accounts](https://github.com/thepackproof/packproof-v2/blob/main/docs/CONNECTED_ACCOUNTS.md).
- [Shopify fulfillment implementation and pending runtime validation](https://github.com/thepackproof/packproof-v2/blob/main/docs/SHOPIFY_FULFILLMENT.md).
- [Execution record](https://github.com/thepackproof/packproof-v2/blob/main/docs/COMPREHENSIVE_PLAN_EXECUTION.md).
- [Pilot/release gates](https://github.com/thepackproof/packproof-v2/blob/main/docs/PILOT_RUNBOOK.md).
- [V2 Custody Evidence Architecture Extension, September 2](https://docs.google.com/document/d/1TQoTekLSLqtnPi_xXWkN_ShptfoY7N5dJDzODTrhCeY/edit): prior generalization principles; current lifecycle details follow the candidate repository contract.
- [OpenAPI 3.1.0](https://spec.openapis.org/oas/v3.1.0): machine-readable HTTP interface specification; this plan does not claim it is the latest specification version.
- [RFC 9457](https://www.rfc-editor.org/rfc/rfc9457.html): standard machine-readable HTTP problem details.
- [AWS S3 presigned URLs](https://docs.aws.amazon.com/AmazonS3/latest/userguide/using-presigned-url.html): bearer access and expiry behavior relevant to permanent-viewer design.