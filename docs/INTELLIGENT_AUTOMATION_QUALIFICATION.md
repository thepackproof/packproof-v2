# Intelligent automation qualification record

November 17, 2026 · Internal Connect 0.4.1 candidate · Development branch `codex/intelligent-automation-20261117`

The first release gate remains open until a Windows 11 installation creates and verifies the first shipment, collects the next export with the UI closed, and repeats after a reboot under the approved source. The following record links engineering evidence to the November 16 plan. The warehouse pilot needs an authorized environment, named source owners, real qualified exports, and independently observed results.

## Hosted release update

On November 17, 2026, the Windows candidate built the unsigned Connect 0.4.1 development installer for PR #166. Native service installation, protected storage, historical queue upgrade and repair passed on the Windows runner. The built renderer passed all 14 keyboard and layout checks. The Windows 11 first-shipment, next-export and reboot checks and signed public distribution remain open. [Windows run 44054752393](https://github.com/thepackproof/packproof-v2/actions/runs/44054752393)

The apex site deployed version 81, and CloudFront deployed the web build from `fb9f80a`. The hosted backend still runs the preceding release. The reviewed immutable backend image is staged.

## Historical lab baseline and deployment identity

| Component | Evidence available | Consequence |
| --- | --- | --- |
| Main | `a9568101df67722a6b03f44154e99c5598f60021` | Earlier code and migration sequence through 109. |
| Connect PR #163 | `edd2254b1e7590c114e5e62d12365a743186f7ce` | Brought forward the local storage/readiness repair, queue inspection and exact browser review. |
| Reconstruction PR #164 | `66a258e9eaeaea7695fff18f76ce0de3212c0573` | Based on an earlier Connect revision. Integration merge `96b8d7e` preserves source-aware collection, case projections, backfill and the #163 fixes. |
| Runtime PR #165 | `e0923cb299612030828430917590ccbea3337190` | Integration merge `1ff7e76` retains the coordinated API/worker release machinery and previous rollout record. |
| Hosted API and browser | Public probes at 08:00:53 UTC on Nov 17 returned HTTP 200 for API meta, readiness, health and the browser approval shell. API source `debf53231d6f3ce8990afa74fbc47defac4f4ecb`, version `connect-v2-2026.11.16-debf5323`. Shell SHA-256 `f7c75c9be08796b7b8a2a4d586f283f0a3ba88d93b54b9ec44953b22fe527b72`. | The observed production deployment predates 0.4.1. These endpoints do not expose tenant decisions or grant state. |
| Hosted worker, database and flags | Read-only ECS inspection at 08:07:26 UTC on Nov 17 found API task definition 56 and worker task definition 6 running image digest `sha256:1aba206f8eaade4798c0dd277b5d0acea895cc69e19eb2960fbeeaddc5e84e82`. Neither task definition supplied the new interpretation, reorder or observation switches through environment settings, secrets or environment files. The Nov 16 rollout recorded 108 applied migration receipts. | Current private database receipts, grants, and authenticated processing still need verification during staged qualification. |
| Desktop and local state | Source version 0.4.1 at `f1b4a55`. The historical screenshots/installer versions cannot establish which binary or queue is on the test PC now. | Record the actual installer digest, service executable version, queue health and Windows build for each machine. |

### Queue and database compatibility

| On-disk input | Integrated reader/writer | Qualification |
| --- | --- | --- |
| New or valid historical format 1 | Verify retained schema, identities and key material. Initialize or migrate atomically to 4. | Exercise nonempty legacy data with the exact previous writer. |
| Format 2, ordinary shipment or source-partitioned | Source-aware reader checks exact schema and row ownership. Preserve configuration/grant, stable request/receipt identifiers and encrypted bytes through migration to 4. | `QueueSchemaCompatibilityTests`, `SourceSubscriptionTests` and historical-writer upgrade harness. The earlier 0.2.3 shipment-only repair supports a narrower subset. |
| Format 3 | Preserve source identity and retention state across migration to 4. | `SchemaThreeMigrationTests`, `SourceCompactionTests`. |
| Format 4 | Validate tables, indexes, marker agreement, work identities, foreign keys and queue-to-work relationships before reuse. | `QueueSchemaCompatibilityTests`, `BackfillQueueTests`. |
| Unknown format/layout, conflicting markers, missing key/original | Refuse unsafe writes and retain evidence for recovery. Read the logical SQLite state including WAL. | Run downgrade refusal, missing-key and corrupted-metadata tests, then repeat against a retained Windows test installation. Recover with a compatible reader or roll forward. |
| PostgreSQL 110–120 | Reuse #164 subscriptions, typed intake, case/assertion history, allocations, projections, retention and backfill migrations. | Inspect applied receipts and runtime role policy before upgrading any target. |
| PostgreSQL 121 | Add nullable immutable `partner_import_jobs.shipment_interpretation`; legacy rows retain their previous evidence. | Run isolated migrations, repeat under separate runtime roles, rehearse restore, and verify version-paired worker execution before admitting the new policy. |

## Work-package evidence

All changes below target the same internal candidate. Source commits identify the implementation. Tests shown are repeatable repository entry points. Component builds, release artifacts, private deployments and installed/site acceptance are separate outcomes. A source change or synthetic fixture alone cannot satisfy the rightmost column.

| WP | Reused implementation and added behavior | Engineering evidence | Remaining qualification or next action |
| --- | --- | --- | --- |
| 00 | Integration merges above, candidate version and queue compatibility `0f56366`. | Baseline web suite passed 591 tests. Connect initially had one stale source-home expectation among 101 tests. Later revisions passed the affected renderer suite. | Capture actual installed/live inventory and nonempty retained-work upgrade on the target PC. |
| 01 | Shared CSV rules and TypeScript/C# interpreters, source revision pinning, explicit outcomes and durable receipt decision `9a817de`. | `connect-csv-corpus.test.ts`, `CsvSemanticsTests.cs`, migration 121, partner receipt/SDK contract `5769c46`. | Verify hosted old/new contract negotiation and both actual runtime roles. |
| 02 | NTFS snapshot, delimited parser and local analysis now support validated fields, grain and consolidated clarification `f57c7a0`, `5335625`. | Corpus across both runtimes, exact-byte boundary tests `65f7899`, renderer tests. Empty, encoding, collision and limit failures are exercised. | Obtain source-owner acceptance of field/row meanings and measure Windows profiling latency. |
| 03 | Reuse distinct source, initial-batch and recurring grants. Verify receipt identity and imported Proof provenance `e30ae93`, current-workspace review `2307183`, `0c495a9`, `27d737b`. | `record-agents.test.ts`, `GuidedSetupTests.cs`, `SourceReviewBindingTests.cs`, acceptance helper `cd54517`. Windows CI defines packaging, artifact hashing and native smokes. | Produce a commit-identifiable installer and capture separate authenticated first/next/reboot receipts from the target installation. |
| 04 | Existing source approval/revision paths gain opt-in exact column reordering, disclosure/mapping diff and receipt provenance `5518601`, `1eb7dd8`. | Scheduled and typed validation, source-subscription authority, portal review and `CsvHeaderPolicyTests.cs`. PostgreSQL covered pre-storage rejection, stale revision and immutable original headers. | Owner approves a specific policy revision. Run an allowed reorder and a blocked disclosure change on installed Windows. |
| 05 | Existing queue, receipt reconciliation and source scheduler gain durable retries and recoverable publication handling `0f56366`, `e1f2b00`. | Queue, restart, retry, storage and isolation tests. A portable .NET run passed 233 tests with five Windows-only skips at that checkpoint. | Perform native locked-file, storage-pressure, interrupted-upgrade, restart and outage exercises with retained protected work. |
| 06 | Extend desktop source controls and portal review with current source health, explicit approval stages, retry times and owner actions `f57c7a0`, `9947820`, `5b6281e`. | Desktop component tests, portal tests, built Electron layout/keyboard harness. | Execute scaling, keyboard and screen-reader checks on installed Windows and observe all five participants. |
| 07 | Existing typed observations/cases, exact allocation and coverage-aware comparisons `a4ecb1b`. Shipments and titles require evidence from their own source subscription at `5c9d68d`. Split allocations and carrier context use the exact qualifying source edges at `45b0bab`. | Real PostgreSQL synthetic reconstruction tests exercise duplicates, corrections, copied lineage, partial inputs and 10/8/8. | Sign off real order, loading and delivery profiles, identity namespace, allocation, quantity units, clocks, publication boundaries, revisions and coverage. |
| 08 | Existing fault/concurrency/scale suites, migration-pool isolation `762edad`, and family-separated offline evaluation harness `53271c6`. | Synthetic evaluation and bounded scale runs exercise the harness. Keep measurement denominator, host, workload, missing runs and faulty decisions visible. | Independent reviewer and source owners freeze holdouts. Measure installed profiling, file-to-record latency, automation coverage and interruptions against a pre-change baseline. |
| 09 | Existing coordinated rollout tooling plus default-off, per-source observation `a69bdad`. Shadow evaluation runs only after admitted legacy CSV receipt creation. | Affected scheduled/typed suites passed 35/35 on PostgreSQL 16.15. Tests cover consent, no extra upload, no repeat count on replay, redacted output and log-sink failure. | Obtain authorization for isolated rollout. Verify deployed worker/API pairing and browser, exercise rollback/restore, review shadow disagreements, then authorize one pilot source. Public release remains gated. |

## Integrated lab results

| Gate | Observed outcome |
| --- | --- |
| First and next shipment | Test `backend/tests/connect-scheduled-http.test.ts` at `ce50da6` opened a real loopback listener, used sandbox credentials, PostgreSQL 16.15 and a filesystem original store. The assembled API rejected the preapproval upload with 403 and the revoked credential with 401. Both successful imports replayed to their original receipt IDs and both reopened original versions matched their submitted bytes. The worker entry point ran in the test process. |
| PostgreSQL release suite | On `45b0bab`, 18 of 19 test files completed together before a test worker exited. The remaining paging file passed all 14 tests in isolation. All 281 distinct tests have a passing result, including role separation and migration 121. |
| Desktop, portal and service | 112 Connect renderer/IPC tests and 594 portal tests passed. The .NET service suite passed 242 with five Windows-only skips. Both self-contained win-x64 native components cross-published. The packaging checks validated the 0.4.1 bridge and service layout, including 191 required binaries and four configuration files. Installed Windows 11 and a Windows-built setup executable remain open. |
| Revocation and record links | At `9a0960b` the desktop suppresses stale record/case links and previews after known revoked, expired or unauthorized access, including loss of access to one source. Opening a link requires fresh confirmation of the applicable scope. Typecheck, 61 focused desktop tests and 68 service tests passed. The Linux Chromium fallback stopped before rendering because its process socket was denied (0/14 layouts exercised). Run the built Electron checks on the native candidate runner. |
| Full backend sweep | A broader run on the changing integration tree encountered interim failures and was stopped to isolate the capacity run. The research worker passed on retry after its CI dependencies were installed. The affected shadow/reorder tests passed on retry. Reconstruction paging passed on actual PostgreSQL. The complete repository-wide CI run remains open. |
| Interpretation | A synthetic family-separated exercise yielded 8 correct automatic assignments out of 8 attempted, covering 8 of 14 labeled fields. Six reports came from five families. This small developer corpus supplies no warehouse-wide accuracy estimate. |
| Local profiling | .NET 10.0.14 on Linux x86-64 with 9 visible Xeon Platinum 8573C CPUs parsed and interpreted a 673,348-byte, 1,000-row, 50-column fixture in 124 ms median and 146 ms p95 over 20 measured iterations after three warmups. The exact CSV SHA-256 was `100bbd04ca18dcac4df79d3d65c49811922643dea40e8184518631f09f825b74`. Measurements begin with the input bytes in memory. Windows file publication, capture, upload and projection latency require separate measurements. |
| Reconstruction capacity | PostgreSQL 16.15, clean commit `43001b1`, 1,010,002 observations and 10,001 shipment cases. The isolated run passed 10 of 11 enforced targets. All 1,000 burst observations were accepted. All 10,001 cases had current durable quantity issues. Over ten admission batches the median was 305.09 ms and p95 was 1,039.82 ms against a strict 1,000 ms limit. Ordinary and hot case-page p95 were 90.89 and 528.23 ms. Projection and durable issue lag after final arrival were 83.55 and 82.95 seconds. This workload includes actual application authentication and excludes HTTP transport. An earlier attempt exposed a migration-pool lock timeout (corrected in `762edad`), and another stopped during seeding under host resource contention. |
| Capacity after batching | `e92f3d8` bulk-inserts bounded preview rows under the same locks and reads only required row-state predicates at commit. Backend type checking and 60 PostgreSQL tests passed, including ordered 1,000-row and mixed/quarantined-row cases. The full isolated rerun with the same limits and workload met all **11 of 11** enforced targets. Across ten 100-row batches, admission median was 161.23 ms and p95 was 976.48 ms, with no misses. Ordinary/hot page p95 were 102.58/438.70 ms, and projection/issue lags were each about 82.38 s. All 1,000 burst observations were accepted. Process exit was 1 during postmeasurement schema cleanup (SQLSTATE 53200), after the completed workload report was persisted. A teardown-only lock-budget increase allowed cleanup to finish with exit 0. The synthetic schema and originals directory were confirmed absent and the database was stopped. |
| Paired deployment and rollback | `be84bb9` and `3c113a5` add an explicit v7 image build and a deployment check that binds API and worker to a reviewed image and separately checks both predecessor readers. All 22 focused operator checks passed. A TLS PostgreSQL 16.15 check exercised the restricted rollback logins. Live predecessor `debf53231` rejects the new ledger at startup. Rehearse schema and privileges on a production-layout restore with compatible rollback or separately qualified cutover before changing the production database. |
| Release preflight | The v7 archive contains the exact 120 SQL files through migration 121. PostgreSQL qualification covered API insert/read, worker read and immutable decisions. The archived preflight entry point loaded with its packaged dependencies. Building and executing the actual container image and exercising the Windows installer remain outstanding. |
| Optional 0.4.1 historical backfill | Migration 122 admits 0.4.1 job creation and preserves the existing source grant, prior 0.4.0 jobs and queued receipts. PostgreSQL checks covered both collector versions, grant retention, replay, restricted roles and an unsupported collector. | The independent v8 archive and preflight bind the full 121-row catalog. Actual image, role and predecessor receipts are required for release. See [the v8 backfill preflight](../infra/backend-release/BACKFILL_041_PREFLIGHT.md). |

The loopback trace identified the following synthetic records. They are local test identifiers and cannot be opened in the hosted portal.

| Export | Completed import | Canonical Proof | Original SHA-256 |
| --- | --- | --- | --- |
| First | `partner_import_01M7M91GGY6FJCE87J5SZKC4DT` | `proof_01M7M91GW3K3VMZ8XY8QNMCWJR` | `89f121603613c73401fc5a13ea85a9c2059618f506c943462e752e8b53409f9e` |
| Next | `partner_import_01M7M91HA0YHYMSZ7KPH7BA74H` | `proof_01M7M91HFHZHJRW1F4786J4V7V` | `1b1f245ddd0d38bf959952e2fd59f23c811369af850d3dba92e823a7034c283e` |

## Acceptance ledger

Each row gives a concrete verification route and expected outcome. **Fixture** identifies a software or integration check. **Installed** adds a target Windows/browser step. **Site** needs independent human or exporter evidence. Fixture coverage is limited to the listed cases. No aggregate pass count establishes site acceptance.

In this table, backend test names resolve under `backend/tests`, C# test names under `connect-windows/service-tests`, desktop components under `connect-windows/ui`, and browser tests under `web/src/tests`. The shared shipment and typed corpora are in `backend/tests/fixtures`.

| ID | Scenario and expected result | Evidence or outstanding gate |
| --- | --- | --- |
| A01 | Recognized shipment headers map automatically across all rows. | Fixture · shared shipment corpus, `CsvSemanticsTests`, `ConnectApp.test.tsx`. Site · verify a qualified export. |
| A02 | `OrderNum` cannot become a shipment ID. | Fixture · semantic corpus, `source-contracts-v2.test.ts`. |
| A03 | Competing shipment columns require one focused decision with local examples. | Fixture · `connect-csv-corpus.test.ts`, `ConnectApp.test.tsx`. |
| A04 | An invalid value after the sample stops admission. | Fixture · full-file corpus through both interpreters and exact-byte limits. |
| A05 | Normalized collisions prevent automatic binding. | Fixture · shared corpus and `FolderSource.Parse`. |
| A06 | Leading zeros and reused line IDs remain distinct by parent. | Fixture · `source-contracts-v2.test.ts`, `typed-imports.test.ts`. |
| A07 | Missing offsets remain unknown or require review. | Fixture · scheduled CSV and typed contract corpora, explicit-time and history checks. |
| A08 | Missing or incompatible units suppress comparisons. | Fixture · `reconstruction-rules.test.ts`, `source-contracts.test.ts`. Site · qualify actual units. |
| A09 | A saved mapping applies only under its source and configuration revision. | Fixture · `record-agents.test.ts`, `source-subscriptions.test.ts`, `GuidedSetupTests`. |
| A10 | Identical-looking inputs cannot cross site or tenant. | Fixture · `source-associations.test.ts`, `typed-imports.test.ts`, source-authorization tests. |
| A11 | Approved reorder retains observed order, bytes and mapping fingerprint. | Fixture · `CsvHeaderPolicyTests`, `scheduled-csv-source.test.ts`, `source-subscriptions.test.ts`. Installed · unattended next export. |
| A12 | Rename or grain change stops automatic interpretation. | Fixture · local/hosted header policy tests, shipment-grain corpus. Site · confirm exporter meaning. |
| A13 | A new unmapped column cannot silently expand full-original upload. | Fixture · local validation and PostgreSQL storage-spy regression in `source-subscriptions.test.ts`. |
| A14 | A stale browser revision cannot approve a different source meaning. | Fixture · subscription and agent approval tests plus `SourceReviewBindingTests`. |
| A15 | Before source consent, preview stays local. | Fixture · guided setup/renderer tests. Installed · verify zero original-byte transmission using isolated server/storage audit. |
| A16 | Split shipments retain their own explicit allocations. | Fixture · `reconstruction-rules.test.ts`, `shipment-projections.test.ts`. Site · verify actual split. |
| A17 | A shared load cannot disclose another order's evidence. | Fixture · `typed-imports.test.ts` multi-order hold and `reconstruction-app.test.ts` scoped extract. |
| A18 | Reused tracking strings need exact account/carrier/package scope. | Fixture · `operational-presence-rules.test.ts` and exact references. Site · qualify tracking reuse policy. |
| A19 | Similar description, date or quantity cannot auto-merge identities. | Fixture · exact binding and manual crosswalk tests in `source-associations.test.ts`. Site · include independently labeled lookalikes in holdout. |
| A20 | Duplicate file or timeout after acceptance reconciles to one effect. | Fixture · `typed-imports.test.ts`, `RecoveryTests`, guided setup reconciliation. Installed · interrupt transport. |
| A21 | Reused idempotency key with a changed body conflicts. | Fixture · `typed-imports.test.ts` and partner import idempotency cases. |
| A22 | Identical business values with distinct event identity survive. | Fixture · `source-contracts-v2.test.ts`, typed identity and conflicts. Site · qualify exporter duplicate/event semantics. |
| A23 | Late corrections and older snapshots preserve history. | Fixture · `typed-imports.test.ts`, `reconstruction.test.ts`, `shipment-projections.test.ts`. |
| A24 | Copied data cannot count as independent confirmation. | Fixture · `reconstruction-rules.test.ts` copied-source comparison case. |
| A25 | A partial or stale export cannot prove absence or shortage. | Fixture · `reconstruction-rules.test.ts`, `reconstruction.test.ts`. Site · qualify coverage. |
| A26 | 10 allocated, 8 reported loaded and 8 reported delivered yields a scoped two-unit difference. | Fixture · three-feed `reconstruction.test.ts` and comparisons. Site · match three signed profiles to actual preserved originals. |
| A27 | Locked or unpublished files wait without a partial success. | Fixture · source scheduler/publication retry tests. Installed · hold a real NTFS writer lock and release it. |
| A28 | Bounded folder reconciliation finds eligible work without a notification. | Fixture · collector scan/cursor checks in `RecoveryTests`. Installed · publish while the UI is closed. |
| A29 | Interrupted capture, submission or worker lease resumes using existing identity. | Fixture · durable queue tests, `typed-imports.test.ts` lease/prefix rollback cases. Installed · interrupt process or reboot at each durable boundary. |
| A30 | A blocked source leaves other current sources collecting. | Fixture · `SourceSubscriptionTests`, `GlobalSourcePauseTests`, `source-subscriptions.test.ts`. |
| A31 | Expired offline authority or uncertain time stops new capture. | Fixture · `ClockObservationTests`, `ConnectionObservationTests`, source policy checks. Installed · outage beyond granted window. |
| A32 | Revocation during retry/processing blocks further authority. | Fixture · typed-import current authorization, source pause/revoke and worker replay tests. Installed · revoke while queued. |
| A33 | Disk, key or corrupt state failure preserves the remaining evidence. | Fixture · `StorageReadinessTests`, `QueueSchemaCompatibilityTests`, recoverable SQLite failures. Installed · real protected store, controlled low-space and fault exercise. |
| A34 | Reparse/hard-link/path escapes fail closed. | Installed · `scripts/smoke-native-foundation.ps1` and `tests/native-security-probes.cs` in Connect. Windows kernel behavior needs native evidence. |
| A35 | Denied or absent initial/recurring permission cannot enable the next operation. | Fixture · `GuidedSetupTests`, `record-agents.test.ts`, `source-subscriptions.test.ts`. Installed · record browser denial. |
| A36 | Login, wrong workspace and expired review return to a valid stage or require restart. | Fixture · `connect-approval-return.test.ts`, `agent-connections.test.tsx`, exact review tests. Installed · real signed-out stage-specific handoff. |
| A37 | Collector/API/worker mismatch blocks new capability admission. | Fixture · capability and source authority tests, including missing worker marker. Hosted · verify the marker against the actual worker image and role. |
| A38 | A retained nonempty encrypted queue survives upgrade with stable keys, bytes and receipt state. | Fixture · `QueueSchemaCompatibilityTests`, `SchemaThreeMigrationTests`. Installed · historical-writer seed, packaged LocalService upgrade and Windows 11 evidence. |
| A39 | A shipment-only older reader refuses a newer queue without a reset. | Fixture · `QueueSchemaCompatibilityTests`. Installed · verify the supported refusal/roll-forward procedure on a test copy. |
| A40 | First export, UI closed, reboot, next export all produce verified records. | Installed · required workflow below. Individual harness phases alone cannot close this case. |
| A41 | Standard users and source owners receive actions allowed by their role. | Fixture · portal/source authority tests. Installed · complete handoff using real separate people/accounts. |
| A42 | Keyboard, assistive technology, themes and scaling permit setup and correction. | Fixture · `check-renderer-layout.cjs` and renderer tests. Installed · screen reader, keyboard, narrow window, 1280×720 and 1920×1080 at 100%, 150%, 200%. |
| A43 | Source text remains inert in UI, navigation and human exports. | Fixture · Connect `tests/security.test.ts`, approval-target allowlist, escaped rendering and export tests. Installed · adversarial report sample in each supported viewer. |
| A44 | A case viewer cannot download a multi-case original without separate authority. | Fixture · `reconstruction-app.test.ts` authorized excerpt case and `source-retention.test.ts`. |
| A45 | Four of five representative nontechnical participants complete setup unassisted. | Site · record every attempt, assistance, timing, misunderstandings and remediation. Participants have not been observed for this candidate. |

## First installed acceptance and promotion

Use the [installed Windows 11 acceptance procedure](CONNECT_AUTOMATION_INSTALLED_ACCEPTANCE.md) with the repository helper `connect-windows/scripts/publish-acceptance-export.mjs`. It publishes one synthetic file at a time to a dedicated NTFS test folder. Its `check` operation compares the file digest, receipt counts, row, canonical Proof and exact import event with authenticated responses obtained separately.

1. Record installer digest, OS/service identity, nonempty queue inventory, repository commit, API/worker revisions, browser artifact and approved test source configuration.
2. Publish `first`, inspect locally, verify no pre-consent original upload, approve source scope, approve the exact first batch, and check its actual receipt and Proof.
3. Enable recurring collection separately. Close the UI. Publish `ui-closed`, reboot, publish `after-reboot`, then execute the bounded `offline` exercise. Capture each distinct receipt/Proof and source timings.
4. Revoke during a retry, verify scoped refusal and retained work, then exercise a supported pause/roll-forward in the isolated environment. Preserve exact IDs in the authorized acceptance record.
5. Stage shadow comparison only for named existing source revisions. Review disagreements and abstentions against independent ground truth. Enable automatic interpretation for one approved source only after technical, source-owner and usability gates pass. Expand to three feeds after validating their scope and coverage. Record deployment and pilot approval separately.

The [API guide](EXISTING_DATA_API.md) documents the default-off shadow selector and header policy. Worker revision markers declare release-owner qualification and must match the deployed worker. Removing a shadow selector stops comparison. Disabling new admission preserves retained evidence and receipts. Record actual rollback/restore outcomes, Windows analysis p95, file-to-verified-record p95, mapping precision and coverage, and human interruptions before making a pilot performance claim.
