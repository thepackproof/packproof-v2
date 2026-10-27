# Enterprise fulfillment pilot — implementation and launch boundary

PackProof reconstructs source-backed fulfillment history from approved existing exports. The first prospect configuration is Winsupply; no Winsupply system, data controller, credentials, API or operating procedure has been validated by this implementation.

## Implemented

- Additive migration `096_enterprise_fulfillment.sql`; consumer Proof tables, statuses, capture and finalization rules are unchanged.
- Enabled merchant organization + explicit site membership; source-granted machine ingestion is distinct from human review.
- Versioned field dictionaries; approved same-site order and fulfillment namespaces support ERP/WMS correspondence without string-only joins.
- Bounded original CSV/JSON ingestion, PDF/JPEG/PNG attachments, preview, quarantine, content-addressed archives, SHA-256 manifests and source-revision history.
- Idempotent commands and reruns; explicit supersession; predecessor-dependent corrections; source-backed active projections.
- Multi-line orders, split fulfillments, multi-order event assertions, handling-unit associations, exact decimal quantities, unknown UOM and timestamp handling.
- Dossier search by native order, shipment or secondary customer PO; ordered timeline, source viewer, reconciliation, uncertainty, annotations and case export.
- Site-scoped source diagnostics, stale-feed indicators, unassociated evidence and reasoned ambiguous-link resolution.
- Server-timed baseline/pilot reviews and stratified scorecards; no invented savings or fraud-reduction claims.
- Authenticated `/enterprise` reviewer workspace with desktop/tablet layout, bounded imports, reviewer queue, original viewer and scorecards.
- Three synthetic examples: normal, two lines across two partial fulfillments, and pick/load discrepancy with missing acknowledgment. A separate ambiguous row requires a reviewer decision.

## Scope and gates

| Plan phase | Engineering status | External gate |
|---|---|---|
| 0: repository audit | Architecture and seams inspected | Site workshop, legal/data scope and semantic sign-off remain open |
| 1: data foundation | Implemented; synthetic acceptance supplied | Approved actual export and verified dictionary |
| 2: reviewer tools | Implemented; component acceptance supplied | Non-engineer usability and partner review |
| 3: real pilot | Evaluation instrumentation ready | Approved 30–50 historical cases, baseline protocol, SME adjudication |
| 4: recurring feed | Source-granted ingestion/replay seam ready; no deployed scheduler or vendor connector | Demonstrated Phase 3 value; source interface/security approval |
| 5: capture/expansion | Deliberately conditional; existing consumer capture retained | A measured evidence gap and separate operational authorization |

A generic ingestion endpoint is **not** a deployed Winsupply connector. No upstream write-back, credit decision, warehouse task, production deployment or prospect contact is performed.

## Entry points

- Backend: `backend/src/enterprise/`.
- API: `/v1/enterprise`; [API contract](API.md).
- UI: `web/src/enterprise/`; authenticated `/enterprise`.
- Local flags: `PACKPROOF_ENTERPRISE_ENABLED=true`, `VITE_PACKPROOF_ENTERPRISE=1`.
- Historical mode separately requires `PACKPROOF_ENTERPRISE_HISTORICAL_ENABLED=true` and a recorded site approval reference.
- Historical attachments require the separately approved content-scanning/handling gate `PACKPROOF_ENTERPRISE_DOCUMENT_REVIEW_APPROVED=true`. Signature sniffing is not malware scanning.
- Organizations must be enabled using the existing organization administration flow. Each local company is its own approved organization/site boundary.
- [Pilot charter](PILOT_CHARTER.md), [source matrix](source-matrix.csv), [reviewer walkthrough](REVIEWER_WALKTHROUGH.md), [security and operations](SECURITY_OPERATIONS.md).

## Verification

The dedicated `Enterprise pilot acceptance` workflow runs:
1. Backend and web type-checking.
2. Enterprise API/DB acceptance for import, splits, quarantine, two-owner isolation, source corrections, mixed UOM, original bytes, membership and machine revocation, timing and gates.
3. One existing consumer merchant capture → attest → finalize regression.
4. Reviewer UI tests for discrepancy discovery, unknown quantities, original fields, annotations and disabled access.
5. Backend and web builds.

The initial candidate passed all these checks. The final branch workflow is the authority for later refinements; do not describe partner acceptance, production migration, live media security or actual Winsupply performance as verified. The local Windows runner could not use loopback sockets and later disconnected, so executable acceptance moved to GitHub Actions. See the workflow logs and JUnit artifact.

## Known pilot constraints

- Maximum 500 source records, 100 lines per record, 20 attachments and 1 MiB decoded bytes per batch; split larger exports.
- Quantities are **stage snapshots**, not arbitrary event deltas. Different snapshots for one line/stage/fulfillment conflict; identical corroborating values are counted once.
- No automatic UOM conversions. Unscoped totals and fulfillment snapshots are not summed together.
- Namespace mappings require explicit source-owner verification; other associations require reasoned human review. Corporate and intercompany access are not enabled.
- CSV line arrays and document lists are JSON-valued columns. Unsupported mandatory data is quarantined.
- Diagnostics show at most 100 recent batches/quarantined records/evidence items; dossier search paginates 25 at a time, audit 500.
- Review measurement sessions are append-only, server-timed and include pauses; adjudication counts are reviewer supplied. No automated ground truth or ROI.
- Retention is explicit site configuration and operationally governed. Automatic enterprise purge and legal-hold automation are not implemented; agree and validate the privileged deletion procedure before admitting historical records. Consumer retention defaults do not apply.
- Deployed S3 IAM, encryption, versioning/Object Lock, runtime SQL grants, document scanning, access revocation in production and backup handling must pass operational preflight.
- Browser/partner usability and load capacity require pilot-environment verification. The component tests do not substitute for a real reviewer walkthrough.
