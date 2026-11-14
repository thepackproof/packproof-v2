# PackProof existing data reconstruction implementation

This is an internal implementation candidate for the November 14 existing-data plan. It extends the hosted modular monolith, existing portal, and Windows collector. It is **not a qualified customer release**. All new admission, collection, read, rule, and export features default to disabled. Actual installed Windows 11 behavior and authorized pilot source semantics remain prerequisites for deployment.

## Baseline reconciliation

Current main was `a9568101df67722a6b03f44154e99c5598f60021`, exactly the reviewed main in the attached plan. PR #163 remained open and draft at `08745308c8621ecbc59fb820da15e40123c4cda9`. This candidate branches from that head, preserving shared CSV validation, exact-original review, separate recurring consent, and canonical first-record verification. It does not merge or overwrite the unqualified redesign.

The PR163 Windows Server evidence does not demonstrate Windows 11 installation, upgrade with retained work, browser/hosted API integration, or ordinary warehouse usability. Those G0 requirements are not replaced by the synthetic tests in this change.

## Implemented path

1. A matching new collector can start from an administrator-approved local file connection without a legacy shipment CSV. Enrollment and exact source approval remain separate. An enrolled collector proposes a specific local source. The server derives the installation, principal, operator, connection and site; proposal alone grants no collection authority.
2. A current administrator reviews the exact profile, mapping/constants, source namespace, original policy, file identity, history and byte/row limits in the browser. Configuration and grant revisions remain distinct.
3. The collector preserves the exact approved UTF-8 original in its encrypted durable spool. The API preserves it at an independently checked object version before acknowledging a typed preview.
4. Versioned commit and background processing retain every row outcome: processing, accepted linked, accepted unlinked, duplicate, conflict, quarantined or rejected. Scoped immutable event/revision identity prevents altered redelivery from silently replacing facts.
5. Exact qualified order/shipment references or human-approved crosswalks associate observations with operational cases. Order-only observations do not fabricate a shipment Proof. Explicit eligible shipment data uses the existing transaction and Proof commands.
6. Rebuildable case views expose source assertions, relationships, operational sequence and received history. Parent-scoped line IDs, leading zeros, null source time, source revisions and copy lineage survive normalization.
7. Source coverage requires both approved source-owner qualification and measured accounting/boundaries. Explainable comparisons use the existing exact quantity engine and shipment allocation, rather than summing order, pick, load and delivery counts.
8. Durable issues retain evaluations and reasoned acknowledge, assign, note, resolve and reopen history. Worker actions have explicit system provenance rather than a fabricated human actor.
9. The portal exposes cases, comparisons, source-specific health, supporting field extracts, first-record review and recurring-source decisions. Case access never authorizes downloading a complete multi-case original.
10. The unsigned investigation JSON profile freezes the projection, assertions, association decisions, issue history, safe extracts, digest inventory, scope omissions and retention summary. Existing signed Proof and operational-snapshot profiles are unchanged. A separately qualified v2 wrapper adds an independently verified signature and frozen inventory without altering v1 bytes.
11. A separately approved historical-file job freezes a finite manifest, source-time interval, update semantics and current capture authority. Protected job progress and independent queue lanes resume after restart while reserving admission and processing for live files. Exact overlap binds the existing receipt; file and row counts derive durable outcomes. Source diagnostics distinguish pending age, unknown capture times and retained bytes from exporter completeness.
12. Qualified local v2 CSV sources can bind actual exporter snapshot-marker, boundary-time and control-total columns. Collector/server validation reads the exact original and agrees through a shared corpus. The owner must qualify those existing controls; ordinary files keep coverage unknown. Historical arrival order cannot replace a newer qualified live boundary or conceal unqualified current work.

## Source contracts

| Profile | Grain and identity |
| --- | --- |
| `packproof.order-lines/v1` | Explicit order and stable parent-scoped order line. |
| `packproof.shipment-handling-units/v1` | Shipment-line allocation with explicit handling-unit relationships. |
| `packproof.operational-observations/v1` | Source snapshots, events, corrections and tombstones with declared time quality. |
| `packproof.operational-observations/v2` | Additive qualified label/carrier and explicit handling-unit handoff assertions. |

Transport schemas are `packproof.typed-source-batch/v1` and the separately approved `packproof.typed-source-batch/v2`. Version one retains its original identity and revision semantics. Version two requires an exact approved identity policy; explicit columns, grain-qualified composite components, actual snapshot boundaries and immutable-event contracts remain distinguishable in source provenance. Local collection is approved NTFS CSV only; approved partner clients can submit bounded CSV or original JSON. The parser derives locators from the original bytes rather than trusting caller-provided row/field pointers. Bounds remain 2 MiB, 1,000 rows and 50 CSV columns. Larger streaming sources and arbitrary vendor formats are not qualified by increasing the HTTP envelope.

An approved subscription binds its connection, site, principal/installation, profile, mapping and constants, namespace, complete-header schema, original consent and history. Grant and configuration identity are retained with pending work. Changed or revoked authority cannot be bypassed with an idempotency cache hit. Existing installation credentials remain CSV-only unless a separately approved typed subscription and server capability negotiation authorize the new source.

The synthetic contract corpus is shared by TypeScript and C# through `typed-source-rules.json` and `backend/tests/fixtures/reconstruction/source-contract-corpus.json`. It is not a source-owner approval for a real warehouse.

## Source to screen evidence

`backend/tests/reconstruction-app.test.ts` exercises the assembled HTTP application, original object store, real isolated database, approved subscriptions, typed preview/commit and worker:

- Order `0010482`, parent-scoped line `004`, allocated 10 each to `S-0021`.
- Loading reports 8 each and delivery reports 8 each.
- Current qualified source boundaries permit a two-unit allocation/loading comparison.
- Each displayed quantity retains its batch, assertion, source revision and derived locator.
- An unrelated order in the same original remains absent from the case field extract and investigation package.

`backend/tests/reconstruction.test.ts` covers reversed arrival, corrected snapshots, split allocation, issue history, source outages, separate flags and complete pagination beyond 1,000 assertions. `connect-windows/service-tests/SourceSubscriptionTests.cs` exercises the headless three-source service and isolates one drifting or unreadable source while others continue. These are internal synthetic acceptance results, not G1/G2 site acceptance.

## Versions and rollback

| Component | Candidate contract |
| --- | --- |
| API | Existing partner API plus opt-in typed batch and source subscription v1 profiles. |
| Browser | Source-specific review and first-batch activation from this exact source candidate. |
| Windows | Internal desktop/service `0.4.0`, explicitly negotiated v1/v2 source contracts and separately enabled historical jobs; protected subscription state and queue schema v4. |
| Database | Additive migrations 110–118; frozen 108/109/113/116/117 policies plus explicit 118 runtime privilege review. |
| Legacy source lane | Existing scheduled CSV v1/v2 and PR163 validation retained. |

The existing queue is migrated without deleting original bytes, keys, credentials or receipts. The old binary must refuse the schema-four queue rather than reset it. Newly staged originals have a recorded capture time; an older entry without that information stays unknown. Rollback pauses the affected source and uses a compatible service or a roll-forward repair. Do not replace the executable with an older reader after migration, delete ProgramData, run a destructive down migration, or transfer queued bytes into a new source grant.

## Independent switches

All switches require the literal value `true`; absent values remain disabled.

| Feature | Environment variable |
| --- | --- |
| Typed admission | `PACKPROOF_TYPED_INTAKE_ENABLED` |
| Source approvals | `PACKPROOF_SOURCE_SUBSCRIPTIONS_ENABLED` |
| Typed Windows authority | `PACKPROOF_MULTI_SOURCE_AGENT_ENABLED` |
| Case reconstruction | `PACKPROOF_CASE_RECONSTRUCTION_ENABLED` |
| Source health | `PACKPROOF_SOURCE_HEALTH_ENABLED` |
| Explainable rules | `PACKPROOF_RECONSTRUCTION_RULES_ENABLED` |
| Investigation exports | `PACKPROOF_RECONSTRUCTION_EXPORTS_ENABLED` |
| Approved v2 source identity | `PACKPROOF_SOURCE_IDENTITY_V2_ENABLED` |
| Explicit cross-case allocations and mappings | `PACKPROOF_CROSS_CASE_ENABLED` |
| Source-owner operational rule policies | `PACKPROOF_SOURCE_RULE_POLICIES_ENABLED` |
| Bounded materialized case pages | `PACKPROOF_PAGED_PROJECTIONS_ENABLED` |
| Qualified signed investigation profile | `PACKPROOF_SIGNED_CASE_EXPORTS_ENABLED` |
| Qualified source disposition and collector compaction | `PACKPROOF_SOURCE_DISPOSITION_ENABLED` |
| Exact approved resumable historical-file jobs | `PACKPROOF_SOURCE_BACKFILL_JOBS_ENABLED` |

The existing organization entitlement remains required. Disabling a reader or a rule does not delete accepted originals. Disabling admission stops new work without silently discarding retained work. See `infra/backend-release/reconstruction-candidate-runbook.md` for reviewed migrations, role separation, release checks and recovery.

## Current qualification and implementation limits

The following requirements remain open and must not be described as completed:

- **G0 / WP01:** actual Windows 11 clean install, pending-work upgrade, signed-out browser approval, hosted first case, unattended next export, reboot/offline/revocation, accessibility and five-person setup acceptance. Source review and local/hosted-server tests are not that evidence.
- **G1 / WP02:** three authorized real pilot feeds, source-owner field and completeness approval, documented export publication conventions and actual identity/correction semantics. No named vendor adapter is qualified without its actual source access.
- **Cross-case qualification:** explicit owner-approved multi-order allocations, per-case assertion partitions, scoped typed entity aliases and namespace rules are implemented. The same external load ID in unrelated receipts does not create an association. Real source owners must still qualify identity cardinality, reuse intervals and allocation meaning.
- **Source keys:** additive v2 policies and equivalent C#/TypeScript interpreters support approved grain-qualified composite identities, source-as-of snapshots and immutable events. These fixtures do not qualify the identifiers or publication semantics of an unknown real source.
- **Rules:** label/carrier acceptance and expected handling-unit handoff rules are implemented behind separate qualified policy bindings. Exact source revisions, carrier account/service, explicit event/deadline times, source completeness and current coverage are prerequisites. Status vocabularies and windows require actual source-owner review.
- **Scale:** ordinary case pages use SQL pagination and revision-bound cursors. Workers maintain complete versioned comparisons and derived source accounting; pending/stale projections suppress comparison totals. The reproducible retained-history workload and actual measured results are recorded separately; local fixture timing is not production PostgreSQL capacity qualification.
- **Recovery evaluations:** immutable evaluation sequence records a healthy, suppressed and healthy-again transition even when its original projection content recurs. Rechecking an unchanged latest projection remains idempotent; a returning identical projection preserves a human resolution. Transient processing gets a bounded short retry ahead of ordinary maintenance, while offline and unresolved-source review keep their normal cadence.
- **Historical collection:** the initial qualified job path is bounded local NTFS CSV on the matching `0.4.0` collector. Cumulative snapshots require approved v2 source-as-of ordering; event deltas require a supported stable event identity contract. Mixed or unknown semantics, out-of-interval/unknown times, changed originals and changed capture authority remain blocked. An approved job is not a source-completeness declaration or a reason to generate historical absence findings.
- **WP10:** a separate v2 signed case package reuses the existing signing provider and independent trust registry. Runtime source/profile/org/env/key/time bindings are required; existing signed Proof/snapshot formats remain unchanged. Exact-version original disposition requires a separate worker-only privileged role and two independently authorized human decisions; collector compaction requires a reconciled completed receipt and matching scope/digest. Immutable normalized audit history remains preserved, and backup erasure is never claimed. Actual production key, role, storage retention and restore qualification remain required before activation.
- **G4 / WP12:** production migration rehearsal, live role preflight, signed Windows distribution, external security/retention acceptance, one-site shadow operation and the 20-investigation value study remain open. No production schema, role, source, Site audience or deployment is changed by preparing this candidate.

The optional WP11 non-file adapter is deferred until a real provider, source version and authorized access are selected. The implementation does not claim universal warehouse integration, physical verification, fraud detection or responsibility assignment.

## Verification record

Final commands, results and CI links are recorded in the pull request. Meaningful checks include the full backend suite, assembled reconstruction HTTP tests, actual database privilege tests, shared C#/TypeScript corpus parity, complete web and desktop tests/builds, native service build/tests and source-review browser checks. Any skipped Windows-only tests and external acceptance gates must remain explicit.

The reference profile targets two to five feeds per case. Dependency validation supports at most500 participating/required policy feeds and fails explicitly above that bound; the source subscription inventory remains independently paginated. No source subset is silently presented as complete.
