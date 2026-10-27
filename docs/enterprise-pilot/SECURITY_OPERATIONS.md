# Security, operating gates and rollback

## Actual posture

The module is additive within PackProof's modular monolith. It reuses the authentication adapter, active-account/policy checks, organization credentials, PostgreSQL transactions and private object-store abstraction. It does not invoke external AI, transmit prospect data to analytics, write to operational systems or modify Proof finalization.

All stored domain IDs are server generated. Native order, line, fulfillment, document and handling-unit identifiers are namespaced through site/source ownership. Source records, original asset metadata, mapping versions, manifests, assertions, reviewer decisions, measurements and audit records reject ordinary updates/deletes through database triggers. Active heads are mutable derived projections.

Ingest hashes prove the bytes retained by PackProof. They do not validate physical quantities, item identity, upstream timestamp truth, a signature's scope or the authenticity of a source system.

## Required before deployment or historical admission

- Obtain local/legal-entity, IT/security and data-owner authorization; select one site/mode. Record exactly which fields and original types may be processed.
- Verify deployment environment, S3 region/residency, private bucket policy, TLS, encryption/KMS policy, committed-bucket routing, object versioning/retention and backup terms.
- Extend least-privilege SQL grants to the new tables deliberately. Existing hardened runtime role migrations/scripts do not automatically prove access to new enterprise tables.
- Verify the configured object-store task role can conditionally write/read the **enterprise/site/source/committed** prefix. Existing evidence-prefix IAM is not a universal grant. Do not enable the module to discover permissions by failing actual customer uploads.
- Validate conditional writes, exact version identity and byte-identical retrieval against real S3. Local adapter tests are not deployed storage verification.
- Approve malware scanning and attachment handling. The MVP performs MIME/signature/size checks and restricted attachment delivery; it does **not** contain a malware scanner. Historical attachment ingestion remains gated until a site-approved external review/scanning procedure is documented and the document-review flag is explicitly enabled.
- Agree retention/deletion, holds, legal process, incident expectations, exports and backup erasure. Site retention_days is explicit metadata; no automatic enterprise deletion worker or legal-hold service is claimed. Before enabling historical mode, rehearse the approved privileged purge procedure on a synthetic site, including database trigger exceptions under the migration/admin role, object versions/backups and audit evidence. Ordinary runtime access must not bypass immutable-record triggers.
- Validate short-lived service credentials, source grants, employee/site revocation, review/export audit and distinct-owner site isolation in the chosen pilot environment.
- Verify the reviewer browser flow and source semantics with a non-engineer/SME. Exercise the two partial releases, missing acknowledgment and unsupported unit/time cases.
- Validate batch volume/capacity. Current limits are for a historical pilot, not high-volume production ingestion.
- Record approval references for the site, each mapping dictionary, any namespace correspondence and document handling.

## Flags and release sequence

1. Keep enterprise and historical flags absent/false in production by default.
2. Back up the target database and inventory current migrations/role privileges.
3. Review and apply migration 096 with the configured migration role; do not edit an applied migration checksum.
4. Grant only the required table/prefix access after checking the approved policy. Preserve existing consumer deployment and storage policies.
5. In isolated staging, enable `PACKPROOF_ENTERPRISE_ENABLED=true`; enable the web shortcut with `VITE_PACKPROOF_ENTERPRISE=1`.
6. Use a dedicated synthetic organization/site first. Run the focused workflow and reviewer walkthrough against the candidate.
7. After written partner approvals, explicitly enable `PACKPROOF_ENTERPRISE_HISTORICAL_ENABLED=true` in the selected pilot environment; create a HISTORICAL site with its approval reference and agreed retention.
8. Only after attachment policy validation, explicitly enable `PACKPROOF_ENTERPRISE_DOCUMENT_REVIEW_APPROVED=true`.
9. Enable recurring ingress only after a real historical evaluation demonstrates value and the source interface owner authorizes it. No recurring job is created by this change.

No production backend behavior, migration, new IAM grant, partner credential, historical import or external message is executed by this implementation branch.

## Safe replay

Retry a failed/lost HTTP response with the same idempotency key and unchanged envelope. Reusing a key for a changed request returns a conflict. New batches deduplicate source key + revision; a differing revision needs explicit supersession. Ingested files use deterministic content addresses, so a storage candidate can survive a rolled-back database transaction safely. Do not clean content-addressed originals with consumer staging cleanup.

Predecessor-dependent source corrections remain quarantined when their exact predecessor is not current. Replaying can retry them; it never resolves ambiguous entity identity by time proximity. An authorized reviewer must provide a reasoned association decision.

## Rollback

Disable enterprise/historical flags and remove the web shortcut first. Revoke source grants/credentials if needed. Consumer create/capture/finalize paths are unchanged.

Migration 096 is additive. Keep it and retained pilot evidence while rolling application code back to a release whose schema compatibility policy has been reviewed. The existing strict migration inventory can reject an older binary when forward migrations exist; **do not assume** reverting code alone is a safe deploy. Prefer the current candidate with the enterprise flag off, or a reviewed compatibility release. Never silently delete migration-history rows or alter consumer Proof tables.

If no historical data exists and a fully destructive rollback is authorized, use the migration/admin role and an independently reviewed reverse-order teardown restricted to the enterprise tables/prefix. Before any actual data purge, verify written retention/hold authorization, object-lock constraints and backups. Retain the required administrative audit outside the purged scope. This branch does not run a destructive rollback.

## Recurring connector seam

A future approved file-drop/API worker should use a source-granted service credential, store its cursor securely, preview then commit the same bounded envelope, and retain batch/manifest IDs. Use stable source revisions and idempotency keys, bounded exponential retry for retryable failures, quarantine diagnostics for semantic errors, and incremental backfills. Monitor freshness from successful imports and reconcile source counts. The source adapter is read-only; no source credentials, polling schedules or private Winsupply endpoints are invented.
