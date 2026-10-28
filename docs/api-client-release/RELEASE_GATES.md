# API/client release gates

Prepared 28 October 2026. Source baseline: `e4f69c9a690649c41b846468eb48829fb0542617`; tree `a302d78537a6e506c5b3a51fb72b8631f1859f0d`.

**Current decision: HOLD access expansion and full-plan completion claims until the evidence below is attached to the integrated candidate.** Source implementation can continue independently. This document records engineering and evidence gates; it does not request repeated permission for already authorized work.

## Exact candidate evidence record

Fill this record using observed values, never guessed ones:

| Field | Required record |
| --- | --- |
| Source | Integrated commit/tree and reviewed diff; linked CI run(s) |
| Build/runtime | Immutable backend/worker image digests, web bundle and supported mobile build identities |
| Schema | Applied migration names/checksums; preflight baseline; current database privileges; migration-lock duration |
| Environment | Separate staging resource identity, public HTTPS origin, `/meta` response and worker topology |
| Configuration | Feature/cohort IDs, active scopes and consent, strict receipt policy, origins and budgets; secret identifiers only, never values |
| Preservation/trust | Original bucket/version identities, journal protection and retention/hold evidence, key IDs/history, current protection/trust expiry |
| Results | Every test command/scenario, candidate/environment/time, actual result, skips, measurement and remaining limitation |
| Rollback | Compatible immutable image, admission/pause plan, readable retained records and still-enforced current authorization |
| Review | Independent security review scope/findings and disposition; operator/device/provider participants and authorized synthetic data |

All new October 28 checks are pending until their exact results are recorded. Historical reports remain linked for context and cannot be relabeled as a current pass.

## Gates before controlled-cohort activation

| Gate | Required acceptance and evidence | What cannot close it |
| --- | --- | --- |
| **G01 — baseline and migration compatibility** | Restore representative baseline separately; run additive migrations normally; preserve exact frozen manifests, signatures, original object versions, tenant bindings, grants and revocations; measure locks; validate current app and rollback bridge on new schema. | Editing old checksums, deleting tables, silently adopting unknown migrations, source review alone |
| **G02 — identities and authorization** | Two merchants/durable store accounts with the same order number remain isolated. Exercise body/header selectors, IDs, lists/search, snapshots, media, review/export, sessions, jobs and replay. Service principals cannot attest. Revoke membership/grant/credential during capture/stream/queued delivery and verify denials. First-party merchant preservation/access follows its own current policy. | A supplied merchant/operator display name, token shape, an old participant row or a feature flag |
| **G03 — canonical association and items** | Ten concurrent creates with retry keys yield one root. Conflicting immutable content returns stable 409. Reconnect resolves the same durable account/order; complete multi-item snapshots retain every authoritative line. Unsupported split/mixed shipment allocations remain review/excluded. | Matching display references/tracking, dropping lines, synthetic completion or silently creating multiple roots |
| **G04 — capture and recovery** | Actual supported Android and web sessions: correct bound Proof/operator; deliberate review/confirmation; disconnect, authorization expiry, lost commit/finalize response, browser refresh/restart and supported OS interruption; retained original until exact durable receipt. Document unsupported tails/reselect/restart cases. | API-only upload, prebuild, simulator, mocked camera, source tests or a local “finished” screen |
| **G05 — durable readiness and integrity** | Unverified/pending evidence, absent personal confirmation or required receipt never appears Ready. Current protected journal/byte versions and keys are observed. Repeated/lost responses resolve the same operation, evidence and manifest. Tampered package is rejected by an independent verifier with separately obtained digest/trust. | FINALIZED alone in compatibility mode, cached response, successful URL creation, unconfigured signatures or an archive's self-contained digest |
| **G06 — commit-safe feed and snapshot** | Real isolated PostgreSQL: held/late writers and rollbacks; atomic snapshot rows+C from one REPEATABLE READ snapshot; concurrent writes during every page; event dedupe/current GET; worker/process death boundaries; page/auth expiry and history-floor resync; crossed-query/merchant cursors denied. Verify migration backfill. | PGlite/mocks alone, raw sequence watermark, an expiring scheduling lease or unstable HTTP-spanning transaction |
| **G07 — browser-closed provider automation and coverage** | One real merchant-approved provider order arrives while browser is closed. Test actual scopes/token refresh, durable checkpoints, repeat/out-of-order invalidations, reconnect and pause. Explain every eligible order as Ready, in progress, overdue/attention or excluded/unsupported. | OAuth identity success, an imported order counted as packing evidence, live-provider claims inferred from fixtures |
| **G08 — signed receiver and outage recovery** | Independently running HTTPS receiver verifies exact raw body, event ID, timestamp tolerance and altered/stale/invalid rejection; duplicate effects are idempotent. Exercise immediate rotation with receiver overlap, dead-letter diagnostics/retry, revocation and a measured 24-hour outage recovered by durable retry/replay/feed. | Counting ten attempts as a guaranteed 24/72-hour window, replaying with new logical events or contacting a receiver without explicit task authorization |
| **G09 — dashboard/client usability** | Support user finds a known order/tracking/Proof, opens playable authorized committed media within 30 seconds. Verify attribution/timezone, actual readiness, independent export/notification progress, scoped expiry/revoke, retention disclosure, pagination, hidden-tab polling, keyboard/focus/text status and target-browser responsive media. | Screenshot alone, green component tests alone, color-only status or hidden missing captures |
| **G10 — fresh developer and independent HTTPS path** | Fresh engineer follows quickstart/SDK/collection with separate synthetic staging credentials; completes actual supported capture, event, authoritative read and export. Standalone runner uses HTTP only, validates valid/denied cases and generated response compatibility. Record onboarding waiting and undocumented intervention. | An adapter that only creates a Proof, tests importing domain modules or a service key manufacturing human attestation |
| **G11 — capacity and cost** | Public HTTPS metadata p95 at agreed pilot concurrency; separate upload/processing/finalization/preservation/publication/receiver timings; bounded media/export memory and failure load; storage/versions/egress/processing/support interventions per unique finalized Proof. | Guessed prices, zero-error single requests, buffered exports at untested high concurrency or contractual SLA claims |
| **G12 — fresh-target disaster restore** | Isolated restore of PostgreSQL plus exact originals, manifests, encrypted replay records, memberships/grants/revocations, required key history and protected journals. Fence old writers, verify accepted receipt boundary and exact exports against independent digests, then reject alteration. Measure RPO/RTO. | Backup enabled, versioning alone, an expired historical protection receipt or restore over a newer live database |
| **G13 — independent security and privacy review** | Review exact candidate, object-level authorization, scoped links/media residual lifetime, current browser origins, launch-secret handling, SSRF/DNS/redirects, bounded payload/media, audited attribution, log/telemetry exclusions and restore authority. Resolve blocking findings before expansion. | Claiming certification, credentials in artifacts, a self-review presented as independent or hypothetical checklists substituted for findings |
| **G14 — regression and controlled release** | Required CI including real-PG invariants; current web/mobile regression; seller capture, buyer option, receipt/return, sharing/discovery/retention; exact historical hashes; configuration-preserving deployment, health/worker checks and `/meta` verification. One named consenting cohort, rollback rehearsed; observe before expansion. | Automatic migration reset, broad config replacement, old image ignoring new authorization, green unrelated jobs or a merged PR |

## Runtime and scope boundaries

### Feed, cursor and snapshot retention

The existing migration 088 counter serializes event publication in the source transaction. Preserve its event IDs and the legacy raw-sequence endpoint. Consumers deduplicate logical events, use current authorized reads and do not interpret publication order as physical chronology.

The existing signed stream cursor lifetime is **at most seven days**. The October 27 plan proposes **at least 30 days** of replay/change history, independently from media retention. Neither current cursor lifetime nor unpruned rows establishes a 30-day retention commitment. Inventory retained history, storage growth, pruning/floor behavior and recovery; implement and measure any extension before advertising it.

The candidate reconciliation snapshot is one-hour, bounded and credential/delegation bound, not a permanent export. Active snapshots are limited to four per credential; a snapshot is limited to 10,000 Proofs, 16 MiB total and 256 KiB per row. Oversized materialization fails atomically rather than silently truncating. It atomically materializes authorized summary rows with committed boundary C in a fresh REPEATABLE READ transaction; stable pages reauthorize, then clients resume after its `eventCursor`. Expiry or a history floor beyond C requires a new snapshot. It does not create another canonical Proof model or authorization grant.

### Media, signing and physical truth

Retain current 90-day protection semantics from the latest finalized commerce stage, active holds and unfinished-stage blockers. A stable viewer URL is not permanent media. Do not enable automatic physical deletion, reduce protection or overwrite existing object-version identities. Deletion requests remain review requests; do not claim erasure.

Actual-byte hashes, receipt time, signer identity, declared capture time, source provenance and physical truth are distinct. Reuse existing signing/envelope formats and independent verifiers. Without configured/verified key and timestamp authority, disclose that limitation. Proposed metadata RPO≤15 minutes, RTO≤4 hours, metadata p95<500ms, readiness p95≤60 seconds, 99.9% availability and 30-minute onboarding remain objectives until measured with explicit denominators and load.

### Accepted work and revocation

Revocation blocks new partner intake, capture actions, reads, exports, sessions and future external deliveries, including queued work. It must not strand an already acknowledged original. Explicit platform-authorized preservation/reconciliation can finish accepted and personally confirmed work, but cannot invent a missing attestation, substitute another operator or authorize new partner work. Recheck the exact authority required by each recovery job.

## Rollout and rollback

1. Keep new admission disabled while migrations/contracts/CI and isolated validation are prepared. Apply only reviewed additive migrations; retain current runtime settings and original identities.
2. Enable only the named merchant/partner and supported capture surfaces after gates for that cohort pass. Preserve per-connection automation consent/pause and exact provider capabilities.
3. Observe API/error/latency, worker heartbeat/oldest work, eligible coverage, upload recovery, preservation/finalization/publication lag and exhausted deliveries. Correlate request/Proof/operation/event IDs without raw order text, media, credentials or launch/share secrets.
4. Halt expansion immediately for crossed merchant access, wrong-Proof association, altered immutable bytes, concealed original loss or false operator/durability assurance. Pause affected connection/cohort and new writers while preserving current policy and evidence.
5. Roll back through explicit admission/provider/cohort flags and a tested new-schema-aware image. Disabling `PACKPROOF_ORGANIZATIONS_ENABLED` stops new partner admission; already issued human capture also requires disabling the affected organization or revoking its credential/delegation/membership as appropriate. Do not confuse writer pause with policy revocation.
6. Preserve reads needed for accepted evidence and currently authorized merchants. Retain immutable manifests, journals, queued preservation, grants/revocations and new tables. Never reopen access through a legacy image that ignores them, delete evidence, reset migrations or replace the database with an older state. Keep separately authorized preservation reconciliation available.

The existing future-platform writer/read flags, provider automation lists, organization entitlement and process-role settings have different scopes. Record their actual current values and effect; do not invent a universal rollback switch.

## Result ledger template

For each gate retain: `gateId`, `status` (pending/pass/fail/blocked/deferred), exact candidate/environment, executed scenario, observed result/artifact digest, timestamp, reviewer/operator, limitation and corrective action. A conditional feature outside the selected workflow may be deferred with a reason; a critical failed access/integrity/data-loss gate cannot be waived by averaging other passes.

Current record: **all new integrated-candidate gates pending**. Historical evidence and source capabilities are cataloged in [CAPABILITY_LEDGER.md](CAPABILITY_LEDGER.md); full completion awaits concrete evidence, not a documentation declaration.
