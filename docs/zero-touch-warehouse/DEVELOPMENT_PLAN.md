# PACKPROOF
# Zero-Touch Warehouse Integration & Autonomous Proof Assembly
## Full development plan and coding-agent execution specification

**Prepared:** November 7, 2026  
**Repository:** `thepackproof/packproof-v2`  
**Planning reference:** `main` at `575b42f1d297736a89ee6d5167d7e25b6b0e4ad2` (observed November 7, 2026)  
**Document status:** Implementation plan. The work and production qualification described here are **not** claimed complete.  
**Primary outcome:** After an authorized, one-time setup, routine warehouse data flows into PackProof automatically, is correctly linked to shipments, and appears in a useful unified operational Proof without manual PackProof entry.

> **Product contract:** PackProof should operate in the background. A customer interacts with PackProof to configure access, inspect a record, or resolve a genuine exception—not to keep shipment evidence flowing every day.

---

## 1. Executive decisions

1. **Extend, do not rebuild.** Retain the existing canonical Proof ID and records API; PostgreSQL, S3, worker/outbox infrastructure, organization permissions, existing source-artifact and source-event flows, and the records portal.
2. **Continue Windows Connect, not a second installer.** `connect-windows/` and `docs/windows-connect/` already contain an implemented unattended local-service and setup foundation. It is an **internal candidate**, with Windows 11, signed distribution, production deployment, and approved-source acceptance still gated. The new program must close those gates and reuse its service, queue, encryption, native packaging, and UI.
3. **Qualify one real source first.** The first supported release is **Scheduled CSV Export Folder v1** on Windows 11 x64, backed by the existing service-import API. Obtain an explicit named exporter/version and customer-approved sample before claiming compatibility. Optional second-source events and existing files are admitted only after their exact authority and matching contracts are qualified.
4. **No magical access to all warehouse data.** PackProof can ingest the information a customer is authorized to expose through supported exports, APIs, webhooks, or media feeds. It must show unavailable sources and missing coverage, never imply a complete view when sources are absent.
5. **Correctness beats forced automation.** Deterministic identities and approved crosswalks can link data automatically. Ambiguous identifiers must be quarantined for exception review; never silently link to the most plausible shipment.
6. **A Proof is one canonical record, not a new data silo.** Operational record projections may update as information arrives; original files and finalized manifests remain immutable. Later updates do not alter the scope of an earlier signature.
7. **No service-generated human attestation.** An unattended connector must not impersonate an employee, waive requirements, attest physical truth, or silently create a personal signature. Existing source files remain attributed to their actual source and assurance level.
8. **Automatic means no routine clicks, not no exceptions.** Normal supported shipments require no PackProof interaction after setup. Revoked credentials, ambiguous source identities, missing or contradictory evidence, policy changes, or legal approvals may require a human.
9. **Preserve release controls.** API-only source work and protected signing remain separate; role, migration, key, retention, and restoration safeguards are not bypassed to speed launch.
10. **Build vertical slices.** Finish one tested end-to-end path before adding other adapters, a generic plugin marketplace, an AI matching model, new microservices, or a redesigned dashboard.

### What the audit and latest source already establish

| Subsystem | Existing foundation | Remaining work for this goal |
|---|---|---|
| Partner API and service imports | Scoped credentials; immutable CSV preview/commit; queued work; canonical Proof creation; permanent source bindings | Validate an authorized hosted source end-to-end; reconcile real exporter data and recurring runs |
| Continuous source events | Durable source observations; identity ledger; leases, retries, conflicts; requires an existing `proofId` | Add a safe **source reference -> Proof ID resolver** and cross-system correlation workflow, without bypassing bindings |
| Operational records | Shipment, stop, package, pallet, item, return entities; timelines; source artifacts; requirements/issues; operational revisions | Add deterministic, idempotent assembly from normalized events and authoritative source relationships |
| Browser dashboard | Authenticated records portal, search, detail, evidence, issue and source-management views | Show automation health, freshness, unmapped events, source lineage, and actionable explanations; validate with real data |
| Windows Connect | Unattended .NET service, encrypted spool, local folder source, setup UI, pause/revoke/diagnostics, installer candidate | Deploy backend/portal changes, qualify signed Windows 11 install/upgrade/reboot and actual customer exporter |
| Cryptographic evidence | Server-side digests, source-original retention, immutable/finalized capture boundaries, KMS signing | Distinguish ongoing unsigned operational views from already finalized/signed selections; complete any protected-profile gate before marketing the stronger claim |
| Production release | Working existing customer API and live website; source tests and internal Windows artifacts | The new Windows Connect API/portal changes are not yet deployed; controlled migration and acceptance remain outstanding |

**Source evidence:** `docs/windows-connect/IMPLEMENTATION_STATUS.md`, `docs/windows-connect/BLOCKERS.md`, `docs/windows-connect/DEVELOPMENT_PLAN.md`, `docs/api-portal-v1/QUICKSTART.md`, `docs/api-portal-v1/RECORDS_CONTRACT.md`, `backend/src/records/ingestions.ts`, `backend/src/records/connections.ts` (all in the repository linked in §13). A green source test is not a customer-ready connection.

---

## 2. Exact definition of the customer experience

### Setup: once per supported source

An authorized workspace administrator selects a supported source, installs or enables the appropriate connector, approves the organization's environment and location scope, authenticates through the existing PackProof flow, identifies the source/export version and data locations, previews actual sample records, approves mappings and an initial backfill boundary, then enables recurring collection.

**The setup confirmation screen must show a real imported sample Proof** and explain its sources and any missing evidence. A successful login or empty-folder scan is not equivalent to a successful data import. The customer can pause, revoke, or replace a source later.

### Day-to-day: no PackProof input on the happy path

An order is prepared and shipped using the customer's existing WMS/ERP/TMS and approved evidence sources. PackProof receives the source update, preserves its source identity and original data, resolves an existing Proof or creates one exactly once, appends relevant entities/events/files, computes source freshness and coverage, and updates the dashboard. No one manually creates a Proof, copies an order ID, uploads a document, or flags a routine event through PackProof.

### Exception path: transparent, bounded, human-directed

When data cannot be safely matched, the source stops updating, credentials expire, or required evidence never appears, PackProof creates an actionable condition. The original data is retained without a false shipment association, valid processing continues for unaffected records, and the dashboard explains the reason and recovery path. Resuming/reprocessing must not duplicate old records.

### Scope of “all data”

“All data” means **all relevant and authorized information emitted by the particular qualified integrations**, not an unconditional extraction of every database table, camera stream, workstation, or employee event. A source-coverage inventory must identify what is **connected**, **not available**, **late**, **intentionally excluded**, or **not yet qualified**.

---

## 3. Target architecture: small additions to the existing platform

| Pipeline stage | Responsibility |
|---|---|
| Warehouse sources | Approved WMS/ERP/TMS exports, authorized event feeds, original documents or media |
| Durable intake | Existing Windows Connect or service connector; original files, hashes, source identity, receipts and retries |
| Source normalization | Map approved source fields, timestamps, locations, quantities and provenance using a versioned rule |
| Reference resolution | Match against explicit source bindings and approved crosswalks; quarantine ambiguous items |
| Canonical PackProof Proof | Existing Proof ID and operational records; append entities, timeline, original artifacts and issues |
| Customer experience | Existing records portal, health/recovery views, authorized exports and shares |

**Do not introduce:** another canonical Proof table, an independent evidence store, a second customer dashboard, a new identity provider, an event-bus replacement, a general-purpose rules engine, or a standalone Windows-hosted PackProof API.

### Internal normalized source envelope (planned contract; not an already published API)

Use a bounded, versioned internal representation **only if the current import/event contracts cannot carry the needed metadata**. Its required conceptual fields are:

| Field | Meaning |
|---|---|
| `organizationId`, `environment`, `connectionId` | Authorized source namespace; not inferred from payload |
| `sourceKind`, `sourceSchemaVersion`, `mappingVersion` | Named exporter and interpretation contract |
| `sourceEventId` / `sourceObjectId` | Stable external identity, preserved without losing leading zeros |
| `sourceEntityType` | Order, shipment, package, pallet, item, scan, status, document, video, etc. |
| `references` | Explicit source-scoped shipment, order, package, tracking, and location identifiers |
| `reportedAt`, `receivedAt` | Separate source assertion clock and server receipt clock |
| `payloadSha256`, `originalArtifactId` | Verifiable source payload identity and original reference |
| `provenance`, `assuranceScope` | Organization-submitted / existing-file / qualified capture, not a truth verdict |
| `operationId`, `processingState`, `errorCode` | Durable receipt and reconciliation state |

Do not accept unspecified extra fields containing access tokens, private URLs, personal secrets, or credentials. Sensitive source fields require explicit minimization and customer approval. Map source-specific details to existing record entities and metadata; do not make a new public API unless an acceptance test demonstrates the present contract is insufficient.

---

## 4. Core matching and assembly rules

### Source identity: never guess silently

Use the following resolution order within **the same organization, environment, authorized location and source namespace**:

1. Existing immutable binding of an accepted source shipment ID to a canonical Proof ID.
2. An explicit, versioned customer-approved crosswalk from a different system's external shipment reference to that bound shipment.
3. A package/pallet/item reference known to be a unique child of a bound shipment under an approved source mapping.
4. Tracking number or timing similarity may produce **candidate suggestions only**; they do not create irreversible links without an approved deterministic policy and uniqueness proof.

**If zero or multiple canonical candidates remain, mark `unresolved` and keep the original event.** Do not create a conflicting record to make a dashboard look complete. An exception requires a safe resolution action; after approval, replay queued observations idempotently. Preserve the original candidate set and rule version as audit evidence.

### Real-world cardinalities the resolver must support

- One order split into two shipments.
- Two orders consolidated into one shipment.
- Multiple packages on one tracking movement.
- Same numeric shipment ID reused at different locations or sources.
- Label created before a physical handoff.
- Delivery event arriving before an older delayed loading event.
- A reprinted label, changed tracking number, or corrected item quantity.
- Return linked to an outbound shipment without overwriting the outbound evidence.

### Proof assembly is deterministic and append-only

**Create once:** on first authoritative shipment-level source reference, use the existing service import / Proof creation primitive with a stable source account, external ID, operator assignment and idempotency key. Creation is not a personal attestation.

**Update continuously:** resolve the Proof, append accepted source observations and child entity facts, associate exact originals using the existing source-artifact path, and update operational revisions through existing record commands/outbox. Preserve every correction as a new attributed fact rather than rewriting history. Never mutate the frozen core manifest.

**Recompute:** project timeline, known package/item counts, ordered events, source freshness, quantity comparisons, applicable requirement coverage, and actionable issues from current accepted facts. Distinguish `not_yet_due`, `missing`, `satisfied` and `waived` according to existing definitions. A missing event is not evidence that a real-world activity did not occur.

**Explain:** every customer-visible fact should be traceable to its source, receipt time, reported time, relevant binding, rule version, and original document or file where available. “Received,” “connected,” “verified bytes,” “human-reviewed,” and “physically established” are not interchangeable statuses.

### Automated record vs signed record

An automatically assembled **operational Proof view** may continue updating. Existing signed/core snapshots bind particular finalized selections; signing must not imply that later imported operational data was covered. If a policy permits a signed operational snapshot, use only the separately qualified profile and its approval/authority gates. Do not silently create human approvals, waivers, or attestations in order to achieve zero-touch collection.

---

## 5. Work packages, implementation order, and exit criteria

**Sequencing rule:** execute WP00 -> WP01 -> WP02 -> WP03 -> WP04 -> WP05, then WP06/WP07 in parallel where independent; WP08 -> WP09. Deployment/pilot gates remain separate from source completion.

### WP00 — Baseline, scope lock, and release preflight

**Goal:** prevent rework and identify the actual deployable state.

**Implementation actions**
- Read `AGENTS.md`, `docs/windows-connect/AGENT_START_HERE.md`, `IMPLEMENTATION_STATUS.md`, `BLOCKERS.md`, `EVIDENCE.json`, and the records contracts at the exact current main SHA.
- Inventory only the touched surfaces: Windows service/installer, service CSV import, event ingestion, source bindings, source artifacts, records projection, portal, scheduler, infrastructure migrations and grants.
- Record current commit, CI results, API image, database migration/role eligibility, source/version owner, enabled organization cohort, existing setup artifact and whether a signed build is available.
- Reconcile the Windows Connect G1-G4 blockers without duplicating implemented W01-W10 work.
- Define the first pilot's source export schema, mapping owner, time zone, location identities, event cadence, evidence types, retention and source coverage. Explicitly mark unprovided external prerequisites.

**Exit:** one baseline and dependency ledger; no guessed deployment state; scope limited to one qualified source and defined additional data feeds.

### WP01 — A qualified recurring intake path

**Goal:** approved source files become durable, exactly-attributed import outcomes without manual PackProof actions.

**Reuse:** `connect-windows/service/`, `connect-windows/ui/`, `backend/src/records/partner-imports.ts`, `agent-enrollments.ts`, `agent-restrictions.ts`, existing partner import endpoints, S3 original preservation.

**Implementation actions**
- Qualify the actual exporter/edition: UTF-8, header names, file naming, write-completion signal, cadence, source IDs, date/time zone, max size/rows, and duplicate/rewrite behavior.
- Configure folder access for the real `LocalService` identity; observe only approved local NTFS source paths. Do not add SMB/UNC, raw SQL, or arbitrary filesystem crawlers in v1.
- Detect completed immutable export files; securely spool, hash, queue and submit using the existing preview/commit/status semantics. Verify server-side exact-original receipt and individual row outcomes.
- Maintain source checkpoints that survive restart, logoff, reboot, failed network, lost response, renewal, and service replacement. Resume using stable command IDs, not a new import per retry.
- Record `last folder checked`, `last export detected`, `last accepted import`, and `last receipt reconciled` separately.

**Exit:** one actual approved exporter -> running Windows service -> hosted sandbox -> correct canonical records, including restart and lost-response tests. Mock HTTP tests are necessary but not sufficient.

### WP02 — Versioned normalization and source identity

**Goal:** each incoming item has an unambiguous typed identity and traceable interpretation.

**Likely touchpoints:** existing `backend/src/records/csv.ts`, `imports.ts`, `partner-imports.ts`, `ingestions.ts`, `platform_external_bindings`, selected additive migrations only if needed.

**Implementation actions**
- Define named, versioned source mappings for shipment/order/package/item identities and timestamps; preserve leading zeros, locale, time zone and decimal quantity precision.
- Bind every accepted source object under organization/environment/connection/authorized location scope, including source version, mapping version and digest.
- Reject schema drift and unknown required fields with safe `mapping_needs_review` receipts. Keep unaffected imports processing.
- Prefer existing permanent binding tables. Add a narrow additive source-identity/crosswalk table only where current tables cannot express qualified child references or explicit cross-source mappings.
- Never mutate historical migrations. Extend the API/worker privilege plan and rollback rehearsal for every additive schema change.

**Exit:** deterministic fixtures for duplicate ID reuse, mapping version changes, Unicode/zero-padded IDs, quantities, split and consolidated shipments, correction and unauthorized location.

### WP03 — Deterministic correlation and pending association queue

**Goal:** data from multiple authorized systems consistently attaches to the right Proof.

**Likely touchpoints:** new small resolver module under `backend/src/records/` plus existing binding, record access, ingestion/outbox code. Avoid placing complex matching in the Windows worker or browser.

**Implementation actions**
- Build a pure matching function with auditable rule precedence and a bounded database transaction applying the result.
- Look up immutable source bindings first; support only approved versioned crosswalks and unique child references. Do not infer tenant, site or shipment from a label string alone.
- Make outcomes explicit: `linked`, `already_linked`, `unresolved_no_match`, `unresolved_ambiguous`, `blocked_policy`, `source_conflict`, `retryable_error`.
- Persist unresolved receipts and their candidate/rule metadata; allow authorized administrator resolution and replay; prohibit a service principal from silently granting location access or impersonating a reviewer.
- Guard concurrent creates and binds with existing idempotency, lease and transaction controls. Backfill old events without duplicate Proofs.

**Exit:** zero wrong cross-shipment associations in the specified fixture suite; all ambiguous or unauthorized cases stay unlinked and visible; simultaneous processing is deterministic.

### WP04 — Automatic operational Proof assembly

**Goal:** incoming accepted sources maintain one readable shipment record without manual entry.

**Reuse:** `backend/src/records/service.ts`, `types.ts`, `quantities.ts`, `requirement-templates.ts`, `issue-assignments.ts`, `source-artifacts.ts`, existing `recordShipmentEvent`, `record_state`, outbox and portal reads.

**Implementation actions**
- Convert accepted source operations into existing Proof/entity/timeline/evidence-link operations using the real service actor and current authorization rules.
- Support stable source-observation references and append-only correction/amendment semantics. Do not overwrite originals or modify finalized manifests.
- Associate package/pallet/item/stop relationships and exact units; use existing rational/decimal quantity rules. Unknown pack sizes or units become exceptions, not fabricated conversion values.
- Materialize efficient summary projections only if a measured query/performance test shows current reads insufficient; preserve canonical data as the authority.
- Recalculate coverage and issues on relevant updates, with clear distinctions between unavailable, late, not-yet-due, missing, reviewed and verified scope. Do not auto-waive or auto-close based on missing data.

**Exit:** a sequence of out-of-order shipment events and documents yields one Proof whose record, counts, timeline and audit history are consistent; replay creates no duplicate state.

### WP05 — Existing photos, documents and video association

**Goal:** authorized original media appears with the right shipment and honest provenance.

**Reuse:** `backend/src/records/source-artifacts.ts` and partner artifact routes, existing exact-version S3 storage and digest verification, media gateway and safe access grants.

**Implementation actions**
- Establish a source-to-artifact contract: original byte digest, exact storage version, source system, observed station/location, source timestamps, source shipment/package reference and owner authorization.
- Integrate approved export-side image/document attachment references or a qualified media transfer path. Start with file artifacts; require separate camera/NVR vendor qualification for continuous video.
- Use the WP03 resolver before linking artifacts. An ambiguous camera file remains a preserved unlinked source receipt, not a misleading Proof attachment.
- Enforce bounded sizes, content types, access, malware/quarantine requirements when applicable, privacy/retention obligations, and no exposure of original object keys to customers.
- Display source-media assurance separately from original PackProof capture assurance.

**Exit:** exact original can be downloaded by an authorized reviewer; digest matches; site or organization revocation denies access; unmatched media is not falsely linked.

### WP06 — Continuous processing, reconciliation and failure recovery

**Goal:** the system continues without human babysitting, and tells the truth when it cannot.

**Reuse:** existing Windows encrypted spool, import receipts, `backend/src/records/connections.ts`, `ingestions.ts`, `operations/runtime-jobs.ts`, event/outbox, leased workers and existing support tools.

**Implementation actions**
- Define a per-source cadence and honest freshness watermark. A file-source heartbeat cannot be “up to date” merely because the folder was scanned if no fresh expected export was received.
- Add explicit reconciliation: source objects observed vs durable receipts vs accepted rows vs canonical Proof/record associations; use stable source IDs and checkpoints.
- Implement bounded retry/backoff, poison-item isolation, quarantine, dead-letter visibility and replay after correction; retain original bytes and first receipt.
- Detect stalled scans, expiring credentials, invalid mappings, unresolved correlations, outage, disk quota and delayed processing; display safe error codes and exact affected scope.
- Ensure paused/revoked sources stop new work, and current authorizations are rechecked before queued work publishes; recovered work must not bypass revoked locations.
- Keep a bounded operator-facing health history, alert deduplication, and an actionable repair instruction for each failure category. Do not create a new monitoring platform.

**Exit:** interruption matrix passes for logoff, reboot, service crash, disk saturation, duplicate export, dropped HTTP response, credential renewal/revocation, worker crash and stale source; zero silently lost accepted objects.

### WP07 — Complete setup UX and dashboard presentation

**Goal:** setup is doable by a nondeveloper and Proofs are immediately useful to managers.

**Reuse:** existing Connect setup and `web/src/records/RecordsPortal.tsx`, `AgentConnections.tsx`, `ConnectionActions.tsx`, `ImportWizard.tsx`, `SourceArtifacts.tsx`, portal models and styles.

**Implementation actions**
- Reuse the current Connect wizard. Add only missing steps: name/version verification, mapping preview, backfill cutoff, first record confirmation, continuous sync enablement and status troubleshooting.
- Replace simulated setup success with server-side receipts and an actual dashboard link; state which scopes, sites and data types are enabled.
- Show a source health summary: service running, folder accessible, last export seen, last accepted result, last reconciled watermark and pending errors as **different fields**.
- Make Proof detail chronological, source-attributed and fast to scan: shipment summary, entities, expected-vs-observed, time-line, evidence, exceptions, source coverage and confidence/assurance notes.
- Show unresolved inbound source items in a permission-scoped exception queue; support authorized mapping/crosswalk correction and safe replay.
- Preserve the existing light/dark visual system, keyboard accessibility, readable status text, screen-reader announcements, mobile-responsive review and large-record pagination. Include the known >500-issues regression in release checks.

**Exit:** at least five first-time users can complete an authorized install/connect/first-record journey without developer intervention; managers can find a shipment, understand what is missing, and explain its source lineage. User-study results are recorded, not assumed.

### WP08 — Security, migration and signed-release gates

**Goal:** protect customer information and make deployment reproducible.

**Implementation actions**
- Enforce required CI on protected main/release branches; require review and exact commit test results, including role/migration and independent security checks.
- Verify the existing migration-108 compatibility and distinct API/worker role authorization with a restored nonproduction database. No historical migration edits, production role shortcuts or synthetic reset of customer data.
- Confirm Windows signed candidate with publisher/timestamp verification and Windows 11 x64 install/upgrade/repair/uninstall/reboot/UAC, local service identity, counterfeit-peer and low-privilege checks.
- Validate storage, KMS, exact-original versioning, customer source secrets, revocation, least privilege, logs without secrets, retention and actual restore paths.
- Capture API image digest, database/role receipt, website version, Windows build hash, tested source/version and deployment cohort in a single release manifest.
- Keep the separate mobile secure-token-storage correction as a required security remediation before broadly promoting workflows dependent on those mobile credentials; do not let unrelated UI refactors expand this project.

**Exit:** all relevant automated, hosted, native and security release gates pass on the exact candidate; deployment history is independently reproducible; no new capture/assurance claim is implied.

### WP09 — Pilot qualification and measured rollout

**Goal:** prove a real warehouse's routine work produces useful records without routine PackProof intervention.

**Implementation actions**
- Obtain named source owner, exact exporter/version, authorized sample exports and any approved evidence files, real source access policy, pilot location, data-retention approval, and a designated operational contact.
- Define source-backed completeness rules and manual baseline before observation. Conduct a historical import and a live recurring window, including at least one deliberate interruption/recovery drill.
- Reconcile source shipments, packages, exported rows, media receipts, Proof IDs, unresolved items and issue counts—both counts and selected per-record traces.
- Compare existing manual cross-system evidence retrieval against PackProof review using the same shipment set. Track time to useful Proof, source freshness, coverage and human interventions.
- Use sandbox/staged cohort, opt-in activation and a clear rollback/pause path. Run an observation window with representative operational cycles, including an off-hours period. No network-wide or universal compatibility claim from one successful customer.

**Exit:** all acceptance gates in §7 pass with signed-off customer/source evidence; named supported source/version and limitations published; canary and rollback receipts retained.

---

## 6. API, schema and ownership constraints

### Integrate through existing contracts first

Use existing service CSV preview/commit/status; canonical Proof creation and source bindings; `/v1/partner/...` source observations; source artifacts; record reads; scoped exports; and existing event/outbox. The source event ingest route currently requires a `proofId` already bound to the same connection: **do not weaken this check**. The new resolver should produce a valid authorized Proof ID *before* calling that existing path, or expose a narrow additive internal operation with identical policy constraints.

Only add a public endpoint if the pilot's tested flow requires it. If added, publish an additive versioned contract, SDK support, permission matrix, negative tests and migration/rollback documentation. Never grant a connector authority to make a human review or physical-capture attestation.

### Minimal durable state, only when existing tables are insufficient

| State | Preferred approach |
|---|---|
| Source connection, paused state, freshness, credential ownership | Existing `platform_integration_accounts`, `record_connection_state`, agent enrollment/restrictions |
| Canonical Proof | Existing `proofs` and records overlay keyed by Proof ID |
| Existing source shipment identities | `platform_external_bindings` and partner import identities |
| Source event originals / retry / conflict | Existing source ingestion operations and receipts |
| Imported files | Existing exact-version source-artifact storage and receipts |
| Explicit cross-system child associations | Narrow additive source-crosswalk / pending-association rows **only if required** |
| Operational view / issues / review | Existing records entities, timeline, rules, issues and revision/outbox |

Any new source-crosswalk table needs a unique scoped identity, immutable original source identifier, explicit current approved target, rule/version, initiator, timestamp, history, tenant/location access, no broad SELECT grants, and additive migrations. Store external timestamps and server receipt time separately. No unscoped global mapping based solely on shipment-number text.

---

## 7. Release acceptance tests and nonnegotiable metrics

Targets below are **go/no-go criteria for the first named supported connector**, not claims about present PackProof performance.

| Area | Required acceptance |
|---|---|
| Routine autonomy | **0 routine PackProof actions** after setup for every unambiguous eligible fixture shipment; human action allowed only for real exception categories |
| Source accounting | **100% of observed qualified source objects** end in an auditable accepted, duplicate, rejected, unresolved or retryable state; no silent disappearance |
| Association correctness | **0 incorrect cross-shipment / cross-organization / cross-location links** in the signed-off fixture and controlled pilot sample; ambiguity stays unresolved |
| Duplicate/replay behavior | **Exactly one canonical record** per qualified source shipment identity under retries, concurrency and duplicate exports; corrections are separate history |
| Media integrity | 100% of accepted original artifacts pass server byte-length and digest/version checks; altered or mismatched bytes rejected |
| Freshness | A measurable, source-specific cadence and alerting threshold is agreed; no “up to date” claim without a recent real source result |
| Safety and permissions | All negative tests for tenant isolation, site restriction, service scope, revocation, impersonation and secret leakage pass |
| Recovery | Crash/reboot/offline/full-disk/lost-ack scenarios have bounded replay with no silent loss; a measurable restore drill is required for any preservation SLA |
| Usability | Five first-time users attempt the supported setup; failures and assistance are recorded. No developer intervention to finish the happy path |
| Operational review | A manager can find a shipment, trace each material fact to its source and see missing/late/unmatched evidence without hunting through multiple systems |

**Pilot scorecard:** source shipment count; correctly linked Proofs; unresolved correlation rate; missed/late source rate; time-to-first-useful-record; evidence retrieval time compared with baseline; manual PackProof interventions per 100 eligible shipments; error recovery time; P95 ingest-to-portal latency; cost per shipment/GB and support time. Define the exact measurement denominator before collecting results. Report coverage alongside missing-source counts, not a false universal completeness percentage.

### Mandatory adversarial fixture matrix

1. Duplicate CSV export or the same file submitted twice.
2. Lost acknowledgment after server commit; service retries with same idempotency key.
3. Windows service killed during file read, spool write, upload, and server polling.
4. Windows logoff/reboot; credentials rotated or revoked; expired delegated authority.
5. Source ID reused at another location; source record with no location; cross-tenant ID collision.
6. Split shipment, merged order, wrong tracking number and changed shipping label.
7. Package/video arriving before the shipment record exists; later replay resolves it safely.
8. Delivery arrives before loading, different clock offsets, DST ambiguity, late historical backfill.
9. Changed quantity/unit requiring a correction, unsupported pack conversion and conflicting sources.
10. Media digest mismatch, unavailable exact storage version and too-large source artifact.
11. Stale source with healthy local service but no new export.
12. 501 issues on one record, with an older unresolved issue and 500 newer resolved issues.
13. Outbox/worker crash after a database commit but before client response.
14. Malicious or accidental source secrets, external object keys or private URLs in metadata.
15. Attempted auto-review, auto-waiver, personal attestation or forged source-origin assertion from a service principal.

For each test, store input fixture, exact revision, expected state transitions, actual receipts, relevant SQL/query evidence and whether the test ran in a local fixture, hosted test, actual Windows device, or customer pilot. A simulated test cannot fulfill a physical-machine or provider-qualification gate.

---

## 8. Delivery gates and deployment sequence

**D0 — Source alignment.** Current main/ref and implementation inventory, named first-source contract, chosen pilot scope, status ledger. Internal engineering may proceed without external pilot data, but a supported-source claim may not.

**D1 — Synthetic vertical slice.** Full bounded CSV export -> native service -> existing hosted sandbox API -> canonical Proof -> records portal. All expected identities and signed receipts reconcile; negative tests pass. Requires approved nonproduction API/database/role deployment.

**D2 — Deterministic assembly.** Multi-event, split-shipment, correction, artifact and out-of-order fixtures produce exactly the correct operational record. Ambiguities are actionable and never silently linked.

**D3 — Unattended resilience.** Actual Windows 11 x64 release candidate, interruption tests, health/reconciliation, access revocation, accessibility and signed installer pass.

**D4 — Named source acceptance.** Customer-approved exporter/version and original data reconcile against source, including evidence permissions and honest coverage. Five first-time users complete the onboarding study.

**D5 — Staged production canary.** Reviewed migration/roles, published immutable API image and signed Windows build, exact deployment cohort, current-source reconciling records, monitoring and rollback; no generalized launch before D0-D4.

**Do not relabel existing Windows Connect G0–G4 gates as passed.** Map their receipts into D1/D3/D4/D5, and leave existing blockers open until their required evidence actually exists.

---

## 9. External prerequisites and genuine blockers

These prerequisites **do not prevent independent source implementation**, but they prevent claiming a customer-qualified connector or completing certain release gates.

- A named warehouse exporter/WMS/ERP product, its version and actual supported integration method.
- An authorized customer/source owner and permission to access specific order/shipment data and evidence.
- Representative originals: CSV exports, a cross-system identity sample, and any opted-in documents/photos/videos. Synthetic fixtures can support development but not customer acceptance.
- Source fields/cadence: stable shipment/package IDs, location mapping, event timestamps with time zone, update/correction behavior, and how completed exports are signaled.
- Approved nonproduction organization, administrator/role access and reviewed migration/privilege target.
- An accessible Windows 11 x64 test device and authorized signing/release identity.
- Customer privacy, recording permissions, retention expectations, network/security approval and pilot success criteria.

If one of these remains unavailable, mark the exact gate blocked, continue independent work, and do not fabricate credentials, access, source compatibility or acceptance receipts.

---

## 10. Coding-agent execution rules (prevent wasted work)

1. **Read this plan and the existing Connect status first.** Do not rerun a repository-wide 2,000+ file audit or rewrite another Windows setup plan.
2. **Use one integration vertical slice.** No universal WMS adapter, connector marketplace, arbitrary SQL access, SMB/UNC crawler, NVR reverse engineering, robotics work, AI event inference, or open-ended vendor research in the first release.
3. **No platform replacement.** Preserve Node/Express backend, React portal, PostgreSQL, S3, KMS, canonical Proof, existing Windows service and established API boundaries. Add the smallest cohesive module that passes the acceptance test.
4. **No duplicate authority.** The Windows worker collects and submits; the hosted backend enforces identity, business rules, finalization and signing. Do not let installers or services sign as humans.
5. **No automatic merging on approximate identity.** If safe resolution is not possible, preserve the raw item, record the ambiguity and surface it. Do not engineer a confidence model to hide the blocker.
6. **Tests before breadth.** Add fixture and negative tests for each new invariant, run targeted checks during work and full affected checks at the gate. Do not disable tests or loosen permissions to pass CI.
7. **Minimal schema changes.** Use current tables and event/receipt mechanisms; if necessary add additive migrations and grants, preserving prior migration checksums and rollback compatibility.
8. **One primary status ledger.** Record implemented/tested/deployed/customer-accepted separately with source hashes, commands, test results, artifact hashes and working links. Avoid multiple contradictory progress docs.
9. **Bound external failures.** After two unchanged retries of the same externally blocked action, record diagnosis, exact missing permission or artifact, impact and owner. Continue independent work; do not repeatedly attempt production changes.
10. **Do not silently deploy.** Require reviewed current-target preflight, applicable authorization and exact release/canary gates. A merged PR is not deployment. A deployed API is not customer source acceptance.
11. **Keep the interface consistent.** Extend the current records portal and Connect wizard; do not build a replacement website or redesign unrelated mobile screens.
12. **Stop at scope completion.** Once the named source's complete accepted journey works and all launch gates have evidence, defer other adapters or experimental features into a separate backlog.

### Required completion handoff

The coding agent's final report must name: current SHA; changed paths; new migration/permissions; applicable backend, frontend, Windows, native and end-to-end tests with pass/fail/skip counts; signed artifact identity/hash; API image/deployment receipt; supported exporter and its exact version; source reconciliation numbers; first-run usability result; preserved/signed assurance scope; passed/blocked D0–D5 and Windows G0–G4; unresolved owner dependencies; and what was intentionally excluded.

---

## 11. What we deliberately defer

- Universal discovery of WMS/ERP/TMS databases, arbitrary SQL credentials and unsupported vendor APIs.
- Direct camera/NVR integrations without approved manufacturer access, lawful retention scope, timestamp semantics and a validated matching method.
- Probabilistic / AI-only event-to-shipment links, video interpretation as fact, or fraud adjudication.
- Robotics, sensors beyond the named pilot, geographic expansion, on-premises PackProof server, a new billing/identity/monitoring stack, and new mobile/desktop UI families.
- Cross-customer analytics and automatic law/retention decisions that require qualified policies.

These can be valuable later, but none is necessary to prove the first unattended warehouse pipeline.

---

## 12. Final acceptance demonstration: what the founder should see

The acceptance demonstration should be understandable without reading source code:

1. A nontechnical tester installs the **signed** current Connect client and approves an authorized source.
2. Setup previews the real source format, maps identifiers and imports a representative shipment.
3. The customer returns to their normal WMS workflow; **no PackProof operator clicks occur**.
4. A new export is produced. PackProof ingests it, creates or updates the correct canonical Proof once, and shows the source receipt.
5. A later delivery document/event is received from an approved source and attaches to the same Proof using a documented deterministic reference.
6. The dashboard displays timeline, shipment entities, evidence, source provenance, freshness and explicitly missing information.
7. The source is deliberately interrupted, then restored. Backlog is reconciled without duplicate Proofs, silent data loss or false “current” labels.
8. An ambiguous or unauthorized event stays unlinked and visible for human resolution. It does **not** corrupt another shipment.
9. An authorized reviewer retrieves originals and an appropriate available export, with exact statements of what was and was not signed.
10. The test team retains links to source receipts, test runs, Windows artifact hash and the deployment manifest, so the outcome can be reproduced.

**Definition of done:** For one named supported warehouse source and agreed source coverage, PackProof produces and maintains operational shipment records with **zero routine PackProof entry after setup**, safe and observable exceptions, reproducible deployment, and customer-accepted reconciliation. A broad claim that it can ingest “every warehouse system” is not part of this definition.

---

## 13. Traceable source references

- [Repository main](https://github.com/thepackproof/packproof-v2/tree/main)
- [Windows Connect status](https://github.com/thepackproof/packproof-v2/blob/main/docs/windows-connect/IMPLEMENTATION_STATUS.md)
- [Windows Connect blockers](https://github.com/thepackproof/packproof-v2/blob/main/docs/windows-connect/BLOCKERS.md)
- [Existing Windows Connect plan](https://github.com/thepackproof/packproof-v2/blob/main/docs/windows-connect/DEVELOPMENT_PLAN.md)
- [Records contract](https://github.com/thepackproof/packproof-v2/blob/main/docs/api-portal-v1/RECORDS_CONTRACT.md)
- [Records quickstart](https://github.com/thepackproof/packproof-v2/blob/main/docs/api-portal-v1/QUICKSTART.md)
- [Source ingestion contract](https://github.com/thepackproof/packproof-v2/blob/main/docs/api-portal-v1/SOURCE_INGESTIONS.md)
- [Connections implementation](https://github.com/thepackproof/packproof-v2/blob/main/backend/src/records/connections.ts)
- [Source ingestion implementation](https://github.com/thepackproof/packproof-v2/blob/main/backend/src/records/ingestions.ts)
- [Service CSV implementation](https://github.com/thepackproof/packproof-v2/blob/main/backend/src/records/partner-imports.ts)
- [Operational records service](https://github.com/thepackproof/packproof-v2/blob/main/backend/src/records/service.ts)
- [Records portal](https://github.com/thepackproof/packproof-v2/blob/main/web/src/records/RecordsPortal.tsx)

**Revalidation note:** The reference commit was observed November 7. The implementation agent must re-check current head and source status before making changes. Reference links to `/blob/main/` resolve to the repository's then-current state, not a fixed immutable snapshot.
