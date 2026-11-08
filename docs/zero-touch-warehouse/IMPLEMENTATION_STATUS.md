# Zero-touch warehouse implementation status

This is the primary ledger for the November 7 development plan. Source implementation, local verification, hosted deployment and customer qualification are separate states. Baseline: `575b42f1d297736a89ee6d5167d7e25b6b0e4ad2` on `thepackproof/packproof-v2/main`. Windows G0–G4 receipts remain in `docs/windows-connect/EVIDENCE.json` and are not relabeled here.

## Implemented candidate

- Existing Windows service/configuration: optional administrator-approved `packproof.scheduled-csv/v1` source contract captures named exporter/version, exact ordered headers, expected cadence and explicit-offset backfill boundary. Native checks and hosted preview/worker checks reject schema drift. Legacy approved configurations remain readable and do not imply source qualification.
- Recurring intake: existing encrypted queue and immutable CSV preview/commit/status retained. Rotating batches bound each scan to 100 files; malformed bounded originals enter encrypted quarantine while unaffected files continue. Oversized or changing files stay at source with an error. No network shares or arbitrary file discovery were added.
- Deterministic references: source IDs resolve within merchant, environment, connection and exact location using immutable binding, explicit human crosswalk, then a unique child backed by an accepted source receipt. Approximate tracking/time matches are excluded. Generated location binding keys cannot be mistaken for a literal exporter ID.
- Durable unresolved receipts: complete logical JSON, SHA-256, source clock, first receipt, schema/mapping version and initial candidate set are retained before acknowledgement. Current authorization is rechecked before each bounded processing pass. Conflicts remain conflicts. Administrator mapping/replay is explicit, audited and never transfers receipt ownership to another credential.
- Assembly: source events pass through the existing connection-bound ingestion API and append-only shipment chain. Entity facts and corrections use the existing records/quantity rules, revision and outbox. Unknown units become existing quantity exceptions. No personal review, waiver, attestation or signature is generated. Exact location is rechecked after the canonical record lock.
- CSV location identity: identical padded shipment IDs at separate sites produce distinct canonical Proofs; retries recover their respective bindings. Immutable CSV/core snapshots are not rewritten by later observations.
- Original media: the new exact reference resolver can be used before the existing source-artifact initialization/upload/completion path. Its binding, byte digest, exact storage version, authorization, streaming and privacy checks remain authoritative. Unmatched files must remain in the authorized source/spool until a relationship is approved; this candidate does not claim automatic camera/NVR or arbitrary sidecar-file intake.
- Portal: permission-scoped retained-observation queue, authorized target search, explicit mapping approval, repair/replay, pagination, original source lineage and separate service/scan/export/import/reconciliation facts. Source freshness does not advance from an empty scan or heartbeat. The older-open-issue/500-newer-resolved regression is fixed without treating absent evidence as a passed requirement.
- Additive public contract and TypeScript/Python clients cover exact reference resolution and source observations. Existing ingestion and artifact routes retain their connection-bound Proof checks. An association in `submitted` state points to an event operation; that separate operation must also succeed.

## Database and release boundary

`109_source_associations.sql` adds `record_source_crosswalks`, `record_source_pending`, append-only `record_source_resolution_attempts`, and a frozen source-control revision on partner import jobs. Original bytes/identity and submitted associations are immutable. Replay may record a newer explicitly approved control revision without changing the original revision or payload.

Current runtime privilege planning includes 109. Worker permissions permit only the receipt admissions and append-only entity/issue writes required by stored source assembly; approval, crosswalk, replay, human review, waivers and installation configuration remain API/human responsibilities. API roles cannot write event-processing results or preserved artifact results. Historical 096–107 and 108 operators keep their exact frozen source envelopes; they must not be used to install 109. A new restored-database/role/image qualification is required before deploying this schema.

## Work package and gate disposition

| Package | Source / local verification | External acceptance still required |
|---|---|---|
| WP00 | Baseline and bounded touched-surface inventory complete | Named pilot/exporter/version, source owner and rollout cohort |
| WP01 | Existing recurring intake enhanced; synthetic CSV-to-canonical-record tests | Actual Windows service to approved hosted sandbox |
| WP02 | Versioned approved mapping, exact headers/backfill, location-scoped IDs | Customer-original field and cadence reconciliation |
| WP03 | Resolver, durable exception receipts, explicit mappings/replay | Hosted concurrent/revocation acceptance |
| WP04 | Existing event/entity/quantity/outbox assembly and append-only corrections | Named-source multievent reconciliation |
| WP05 | Safe reference preflight reuses existing exact-original artifact path | Approved source media contract and actual original transfer; no camera claim |
| WP06 | Bounded scan, quarantine, retries, separate health/accounting and repair history | Windows interruption/full-disk/reboot and hosted recovery/restore drill |
| WP07 | Existing wizard and portal extended; UI regression checks | Browser/assistive-technology checks and five observed first-time users |
| WP08 | Additive migration and narrow runtime policy; contract/build/security checks | Restored PostgreSQL, actual distinct API/worker logins, current images, signed Windows11 lifecycle and protected branch/review enforcement |
| WP09 | Scorecard/rollout criteria retained from plan | Authorized warehouse dataset, live observation, manual baseline comparison and customer signoff |

| Gate | State and missing evidence |
|---|---|
| D0 | Engineering baseline complete; named-source/customer portion blocked |
| D1 | Local synthetic server/CSV/record path verified; actual native-to-hosted sandbox blocked |
| D2 | Deterministic source fixtures verified locally; hosted acceptance pending |
| D3 | Blocked: signed Windows11 package and interruption/accessibility acceptance |
| D4 | Blocked: named exporter/version, customer originals and five-user study |
| D5 | Blocked by D0–D4 plus current-target migration/roles/image/canary receipts |
| G0 | Prior internal Windows Server foundation receipt retained; not Windows11 qualification |
| G1 | Blocked: approved hosted nonproduction organization and native end-to-end run |
| G2 | Blocked: protected signed candidate and Windows11 lifecycle/security/accessibility |
| G3 | Blocked: approved named source, reconciliation and five-user/pilot observation |
| G4 | Blocked by G1–G3 and fresh signed download/install/import production canary |

## Deployment and ownership

No production schema, roles, source cohort, API image, website version or signed client is claimed deployed by this change. The AWS account verification was cancelled without a new result. The GitHub connector can publish source/PRs and inspect CI but cannot dispatch the protected signing workflow. The last repository receipt reports production source `e346452ade2744820fb2f429d7aeb94fef376419` and image `sha256:d1775ac9ff380b7364814ed1ad7504c8eef6e82484f686d9e381dcf16c816ff0`; this is historical evidence, not a fresh live inspection.

Required owners: source/customer owner supplies exact exporter/version, authorized originals, locations/cadence/retention and pilot contact; release administrator supplies approved restored/nonproduction target and protected signing execution; Windows tester supplies an actual Windows11 x64 lifecycle run; operational testers supply five observed onboarding attempts and a representative live window. These are missing evidence/access, not a request to repeat implementation authorization.

The first source remains **Scheduled CSV Export Folder v1 — synthetic engineering fixtures only**. No named WMS, ERP, camera, customer or exporter edition is qualified. Source reconciliation demonstrated in tests is fixture-specific; real source shipment counts, P95 latency, cost, five-user success and retrieval-time improvement are unmeasured. No new preservation SLA is claimed.

## Exact verification receipts

See `EVIDENCE.json` for commands, counts, source-tree identity, source publication and CI links. A built portal is not a deployed API; an unsigned CI installer is not a signed release. Final source and CI receipts will be reconciled in this ledger after publication.
