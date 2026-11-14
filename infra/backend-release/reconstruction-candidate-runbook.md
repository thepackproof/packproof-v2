# Existing data reconstruction candidate qualification

This candidate extends the hosted API, records portal and installed Windows service with typed, approved existing-data sources. New behavior remains disabled by default. Code and synthetic fixture results do not qualify installed Windows collection, customer feed semantics, production performance or customer rollout.

## Exact source and schema

Preserve the historical108 and109 migration operators, manifests and policy digests. The new runtime privilege profile is selected explicitly with `throughMigration: 116`; its predecessor defaults remain109. The complete source inventory must contain the checksum-pinned113 prefix and exactly the 114–116 additions in the new reconstruction-v2 profile. The original reconstruction-v1/113 source and ACL review remain frozen. Earlier additive tables are shown for context:

| Migration | Ownership |
| --- | --- |
| 110 existing data reconstruction | Original batch and row receipts, typed identities, cases, assertions, relationships, immutable decisions and outbox |
| 111 source subscriptions | Approved installation/source scope and immutable configuration revisions |
| 112 reconstruction exports | Frozen internal investigation extracts and retention decision history |
| 113 reconstruction issue history | Rule runs, evaluations, system and human review actions, bounded scheduling state |
| 114 operational case allocations | Per-case observation partitions, typed aliases/rules, explicit shared links and source-as-of revision ledger |
| 115 operational projection indexes | Derived source accounting, revision-bound comparison and summary materializations, bounded-page indexes |
| 116 case export retention | Additive signed case results, independent disposition approvals/work/results and receipt-bound compaction commands |

The new preflight inspects an already migrated candidate target. It does not apply migrations or grant privileges. Before any customer database change, the release owner must separately rehearse exact migrations on an authorized restored copy, compare retained data and existing ACLs, test the compatible prior/new readers, and record rollback/roll-forward ownership. Existing pinned108/109 operators reject this candidate inventory intentionally; do not relax their guards to force an upgrade.

## Database role separation

`planRecordsRuntimePrivileges(db, {...review, throughMigration: 116})` produces owner-reviewable column-scoped SQL. Execute a reviewed plan only in an independently authorized migration operation, then run actual-login verification for both distinct roles. This planner never creates roles, changes memberships or grants canonical platform permissions.

| Runtime | Permitted new writes | Denied decisions and history changes |
| --- | --- | --- |
| API | Source proposals and human approvals; typed previews and commit/reconcile state; crosswalk and human action append; scoped export and retention decision append | Modification/deletion of original bytes, row values, immutable assertions, decisions, exports and issue history |
| Worker | Batch leases and processing outcomes; typed identity/case/assertion/relation/outbox append; rule evaluations, system-only issue actions and schedule state | Source grants, configuration revisions, human crosswalk approvals, human review actors/assignments, exports and retention decisions |

The separately reviewed platform baseline must allow each actual API/worker login `UPDATE(id)` on `platform_memberships` and `proofs` for existing `FOR SHARE`/`FOR UPDATE` authorization and inherited preservation locks. This grants no membership role/revocation or Proof content/status columns. A schema owner must review the two qualified `GRANT UPDATE(id) ON TABLE public.platform_memberships, public.proofs TO <api_role>, <worker_role>` statements alongside current baseline grants. The v2 preflight checks these effective column privileges, rejects grant options, and refuses admission when either role lacks a required lock column. Frozen M2 and reconstruction113 policies do not change.

Worker issue INSERT excludes human actor/assignee columns. The database CHECK also rejects a human action with no human actor. Source-policy checks and human grant changes serialize on the same principal advisory lock, so read-only worker grant access does not need a fake UPDATE privilege. Existing tenant/location/current-credential checks remain necessary in the application; database role separation is an additional boundary.

## Read-only runtime preflight

Run `/release/reconstruction-v2-runtime-preflight.mjs api` and separately `worker` under the actual candidate API and worker logins on an approved isolated target. Runtime configuration must disable migration on startup. Supply credentials through normal secret references, never command arguments or diagnostic files.

The review is supplied as `PACKPROOF_RECONSTRUCTION_V2_REVIEW_JSON`, with its exact JSON digest in `PACKPROOF_RECONSTRUCTION_V2_REVIEW_SHA256`. It contains schema `packproof.reconstruction-release-review/v2`, exact40-character `source`, full `inventorySha256`, records-only `recordsMigrationSha256`, distinct `apiRole`/`workerRole`/`ownerRole`, `{host,database}` target, exact ECS `clusterArn`, immutable ECR `candidateImage`, and an `expiresAt` within24 hours. `featureActivation` and `customerReleaseQualified` must both be false. Bind `PACKPROOF_RELEASE_SHA` to the same source. Obtain digest values from the exact reviewed candidate's migration bytes and `recordsMigrationInventory(116)`; do not substitute the historical109 hashes.

The preflight verifies actual ECS image and cluster, TLS, separate non-owner actual login, repeatable-read/read-only transaction, complete exact migration receipts, current116 column catalog/ACLs including inherited and PUBLIC rights, existing M2 authority, and durability configuration. It emits a source/image/review-bound receipt. This is runtime admission evidence, not installed product or pilot acceptance.

## Independent activation boundaries

| Capability | Environment variable |
| --- | --- |
| Typed input | `PACKPROOF_TYPED_INTAKE_ENABLED` |
| Source proposals and approvals | `PACKPROOF_SOURCE_SUBSCRIPTIONS_ENABLED` |
| Multi-source collector authority | `PACKPROOF_MULTI_SOURCE_AGENT_ENABLED` |
| Case reconstruction | `PACKPROOF_CASE_RECONSTRUCTION_ENABLED` |
| Measured source health | `PACKPROOF_SOURCE_HEALTH_ENABLED` |
| Reconstruction exception rules | `PACKPROOF_RECONSTRUCTION_RULES_ENABLED` |
| Internal investigation export | `PACKPROOF_RECONSTRUCTION_EXPORTS_ENABLED` |

Set no new flag merely to make a test screen appear. Qualify the API/browser/service versions together. Stop new admissions before disabling a processing capability; accepted originals and pending operations stay preserved. Source revocation/pause and rules can be isolated without deleting source data.

## Recovery ownership

| Symptom | Scope and retained information | Authorized next step and reconciliation |
| --- | --- | --- |
| Source loses permission or schema changes | Pause that source; keep original batches, queue, receipts and mappings | Source owner restores access or administrator approves a new exact revision; inspect/preview again and reconcile all receipt outcomes |
| Exporter silent or carrier delayed | Keep other sources useful; mark freshness/coverage unknown or delayed | Source owner checks the exporter/cadence and completeness contract; suppress absence conclusions until qualified information returns |
| Temporary network, rate limit or lost response | Stable queue/submission identities; no reset or replacement credential | Retry within approved policy; reconcile the original durable receipt before acknowledging or compacting |
| Service stopped, reboot or UI closed | Protected state, source checkpoints and pending spool remain | Restart the matching service; inspect current grants and receipt accounting; actual Windows recovery must be exercised |
| Disk pressure or queue unreadable | Stop admission at the shared safety boundary; preserve spool/database/keys | Administrator repairs storage/access without deleting ProgramData; matching binary must reopen and reconcile retained work |
| Credential/grant changed with pending work | Old inputs retain original credential/configuration identity | Explicit compatible recovery or preserve blocked; never silently transfer work into new authority |
| Ambiguous identity | Keep observation accepted-unlinked; existing case unchanged | Administrator approves an evidence-backed scoped crosswalk; bounded replay rechecks current authority and accounts every outcome |
| Projection/rule failure | Original receipt remains authoritative; read can show prior known version | Technical reviewer fixes/replays bounded affected work; compare projection revision and immutable rule history |
| Original retrieval unavailable | Display unavailability and retained lineage; no full shared original through case access | Source administrator investigates storage/retention; case viewers use only permitted derived extracts |
| Retention deletion or legal hold request | Immutable decision ledger records policy/hold/review state | Authorized administrator reviews all layers. Execution remains unavailable until the worker-only exact-version runtime is qualified and independently approved. Holds and shared-source impact are rechecked before deletion; normalized audit history stays preserved and no backup erasure is claimed |

Do not use “delete ProgramData and reinstall” or destructive down migrations as recovery procedures.

## Evidence still required for release

G0 requires a real Windows11 clean install, signed-out browser approval restoration, exact first import, separate recurring approval, unattended next export with the UI closed, pending-work upgrade and recovery. G1–G3 require three authorized pilot feeds and source-owner validation of identity, field meaning, units, snapshots/corrections, time quality, scope and completeness. Test a10 allocated/8 loaded/8 received case plus correction, split shipment, stale delivery and cross-site ambiguity variants.

G4 additionally requires signed distribution/upgrade qualification, security and retained-data migration evidence, actual PostgreSQL concurrency and role gates, measured load/retention behavior, five representative setup/investigation participants and the20-case investigation comparison. The provisional100,000 observations/day, million-observation history,100/second burst and latency targets are measured by the separate reconstruction-scale qualification workflow; inspect its exact candidate, fixture, hardware and latency result before treating them as qualified. A CI PostgreSQL result does not qualify production capacity or network latency. A concrete non-file vendor adapter remains separately unqualified until actual provider access exists.

Current portable verification includes the desktop TypeScript tests/build, shared C#/TypeScript semantic corpus, backend receipt/projection/authorization fixtures, and actual PGlite ACL checks. CI's existing PostgreSQL16 gate now includes reconstruction116 ACL/intake/authorization/projection tests, and Windows candidate CI runs on shared rule/corpus changes. Passing portable tests is not a substitute for the outstanding installed/pilot gates.

## Version-two activation and retention execution

The new Windows candidate is 0.3.0. Protected local state and queue schema3 add a metadata-only downgrade barrier while preserving schema2 originals, keys, receipts and pending work. Version-one source contracts remain compatible with0.2.0 and0.3.0; version-two identity policies require0.3.0, the exact shared semantic corpus and explicit server capability negotiation. Metadata and queue migrations preserve retained work; older binaries must refuse incompatible data.

New default-off switches are `PACKPROOF_SOURCE_IDENTITY_V2_ENABLED`, `PACKPROOF_CROSS_CASE_ENABLED`, `PACKPROOF_SOURCE_RULE_POLICIES_ENABLED`, `PACKPROOF_PAGED_PROJECTIONS_ENABLED`, `PACKPROOF_SIGNED_CASE_EXPORTS_ENABLED` and `PACKPROOF_SOURCE_DISPOSITION_ENABLED`. Run the projection worker before issue evaluation when bounded projections are activated; stale/pending comparisons remain unavailable.

Signed case exports require `PACKPROOF_SIGNED_CASE_EXPORT_BINDING_FILE` and its independently pinned `_SHA256`, the exact running release source, the additive case profile digest, approved organization/environment scope, expiry and the existing qualified KMS signer/current independently signed trust registry. Synthetic test signing is explicitly sandbox-only. Read `/cases/:caseId/export-capabilities` under the current case session to distinguish availability from a requested feature switch.

Disposition requires `PACKPROOF_SOURCE_DISPOSITION_BINDING_FILE`, its `_SHA256`, and the separately bound `PACKPROOF_SOURCE_DISPOSITION_PRIVILEGED_ROLE_ARN`. Only the dedicated worker role constructs the exact-version S3/STS transport; ordinary API storage has no committed-original delete method. Startup verifies current role, bucket ownership/region/versioning and current source qualification. A request and a different authorized administrator's approval bind current full-source impact and policy. Execution rechecks all current grants, holds and retain-until boundaries. A lost response is reconciled against the exact version. No prefix, bulk delete, unversioned deletion, governance bypass or backup erasure is available.

Collector compaction follows a server-issued completed disposition command. The service matches the current organization, environment, principal, installation, subscription, site/operator, original capture configuration/grant, current erasure grant, completed receipt and original digest, then requests a fresh30-second online permit immediately before the atomic local operation. The permit is bound to the exact command and credential; it compacts only acknowledged completed payload. Prospective holds protect remaining layers and do not claim to undo an already-authorized in-flight operation. Pending or mismatched work remains preserved. Cloud originals, local payloads, immutable normalized audit history and backups retain separate availability statements.

Projection scheduling defaults to at most100 cases per pass every250ms, with nonoverlapping jobs. Validated overrides are `PACKPROOF_CASE_PROJECTION_MAX_CASES_PER_PASS` (1–100) and `PACKPROOF_CASE_PROJECTION_INTERVAL_MS` (250–60000). Typed admission processing retains its bounded two batches per five seconds. Measure the selected schedule and queue lag on the actual deployment; configuration does not establish capacity.

The scale harness initializes retained-history projections with four bounded, independent calls to the real domain synchronizers, recorded separately from measurements. The first case initializes source counters once. Timed reads and the competing live ingestion/projection/issue schedules keep their runtime bounds. Phase checkpoints, bootstrap query timings and estimated read-only query plans are preserved in partial JSON, including interruption. Initialization timings are not advertised as live ingestion capacity.
