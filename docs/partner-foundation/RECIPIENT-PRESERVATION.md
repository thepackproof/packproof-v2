# Protected recipient exports

This additive M2 source implements exact-file preservation and recovery for new
claim-bound merchant review exports. It does not activate production, submit a
provider dispute, backfill legacy packets or establish merchant acceptance.

## Combined actual-role lifecycle and restore - 22 October 2026

The [combined cloud evidence](recipient-flow-cloud-evidence-2026-10-22.json)
now establishes fresh recipient database reconstruction alongside actual RDS,
S3 Object Lock and KMS authority. Separate API/worker logins execute the domain
lifecycle; the owner controller only seeds, revokes and fences the synthetic
fixture. Requests, results and approvals wait for their protected journals.
A lost S3 response recovers the exact first artifact with no additional render
or publication; stale claims and revoked membership are denied. A running worker
is fenced with its already-issued credentials before fresh reconstruction.

All nine reconstructed tables match their signed source, and a read-only
follow-up compares the revoked membership and 17 policy entries. The first
restore task completed reconstruction but failed its final test assertion:
the application correctly returned POLICY_RECOVERY_UNAVAILABLE while the harness
expected ORGANIZATION_ACCESS_REVOKED. The corrected follow-up requires the
stronger recovery fence and binds the original failed report by version and hash.
No database replay, rendering, signing or protected publication occurs in that
follow-up. Both reports and source/image identities remain in the evidence.

Ten tasks passed, with one initial harness assertion failure; 61 passing report
check entries include repeated identity checks. All three logins are now disabled,
writers/traffic remain closed, and temporary build/egress resources are removed.
This is a synthetic domain flow, not authenticated HTTP, device, human-review or
merchant-pilot acceptance. Production protection and activation remain gated.

## Earlier storage-only acceptance - 22 October 2026

Three isolated Fargate roles passed 26 storage assertions against the compiled
adapter at application source cb74098996147ebe74a149ccb38fec8f86ce3a60. The worker
reconciled a lost publication response to the same exact artifact and obeyed the
external write fence with cached credentials. API and restore-reader roles read
the pinned versions and were denied latest-version reads and protected writes.
Deletion, retention shortening and cross-bucket access were denied. All tasks
exited 0; every saved report was downloaded and its SHA-256 checked. Infrastructure
and source bindings are in the [cloud evidence](recipient-storage-cloud-evidence-2026-10-22.json).

The run used synthetic files and a two-day test bucket floor. It did not open a
database, run the application HTTP flow or certify physical capture. Full fresh
database restore remains false. All test writers are fenced and temporary build
and egress resources were removed. The claim-review UI and scoped database grant
helper are merged, with production activation still gated.

## Accepted facts and files

Migration 095 adds immutable artifact receipts and freezes terminal export rows.
Request, result and approval each commit with their audit and recovery event.
The worker waits for the request journal; the API reports PRESERVING until the
result journal is durable. Approval initially reports APPROVAL_PRESERVING and
downloads wait for its journal. Case revision, account authority, deadline,
profile and evidence scope are rechecked before protected reads and acceptance.

Every original extracted PNG, captioned JPEG and final recipient file has a
content-addressed key and exact version receipt. The canonical artifact is
conditionally published once at its job key. A lost response is reconciled
against the first artifact, including all request bindings and exact output
versions, before any regeneration. Publication uses If-None-Match and checksum;
actual version bytes, length, digest and COMPLIANCE retention are read back.
No retention mutation, deletion, copy or latest-version download is supported.
Streaming reads and writes are bounded (12 MiB per file, 2 MiB artifact).

Current writer generation and unexpired lease are required at acceptance. Stale
workers cannot acknowledge results. Transient rendering failures use bounded
retries; terminal failures are journaled. Each Proof is limited to 100 protected
requests, in addition to the existing per-user hourly limit.

## Recovery

The signed snapshot includes protected jobs, exact artifact receipts, approvals
and their scoped SignatureCase/snapshot dependencies. Fresh recovery checks each
against its accepted request/result/approval event, historical claim revision,
source actor and source digest. Every protected file and artifact version is
verified before installing domain rows. No renderer or signer regenerates them.
Queued work loses transient leases; accepted terminal rows retain exact facts.
The target remains fenced, with policy revocations replayed separately.
Legacy non-claim exports retain their existing behavior and receive no new
durability or reconstruction claim.

## Deployment admission

`PACKPROOF_CLAIM_EXPORTS_ENABLED=true` requires durable receipts, separate API and
worker process roles and a distinct recipient bucket. The API gets only the
exact-read adapter; only workers receive publication methods. Configuration:

| Setting | Meaning |
| --- | --- |
| PACKPROOF_RECIPIENT_S3_BUCKET / PACKPROOF_RECIPIENT_BUCKET_OWNER | Distinct protected bucket and 12-digit account owner |
| PACKPROOF_RECIPIENT_RETAIN_UNTIL | Explicit reviewed UTC preservation boundary covering the case deadline |
| PACKPROOF_RECIPIENT_COHORT | Reviewed cohort identity |
| PACKPROOF_RECIPIENT_PROTECTION_EVIDENCE_FILE / SHA256 | Local reviewed evidence path and pinned digest (full prefix on both settings) |
| PACKPROOF_API_TASK_ROLE_ARN / PACKPROOF_RECOVERY_TASK_ROLE_ARN | Distinct same-account API and worker identities |
| PACKPROOF_RECOVERY_WRITER_GENERATION | Current migration-controlled generation |

The evidence schema `packproof.recipient-deployment.v1` binds bucket, account,
region, workerRoleArn, apiRoleArn, environment, exact sourceSha, cohort,
retainUntil, verifiedAt, expiresAt, reviewedBy and evidenceReference. Required
true checks are versioningVerified, complianceRetentionVerified,
conditionalCreationVerified, exactVersionReadVerified, apiWritesDenied,
workerDeletionDenied, retentionMutationDenied, crossBucketAccessDenied,
writerFenceVerified and freshRestoreVerified. Evidence is checked at startup,
readiness and protected operations. A file stating these facts is configuration
admission, not independent proof of live role permissions.

Before activation, actual-role cloud tests and a measured restore must establish
these facts for the exact deployed source. Production migrations 093-095,
least-privilege grants, a compatible rollback bridge, human review UI and real
web/Android acceptance remain separate release work. No retention duration is
inferred from a bucket default or from this source merge.

## Verification

Storage tests exercise exact versions, conditional winners, lost responses,
wrong versions, altered bytes, weak/short retention, scope and size bounds.
Deployment tests reject stale or crossed evidence and role/bucket reuse.
Claim integration tests use real synthetic media on Linux/PostgreSQL, lose the
artifact publication response, verify zero additional writes on retry, check
pending durability, reject corruption and stale authority, and reconstruct
exact terminal jobs/files/approvals in a fresh fenced target. Storage is a
versioned fixture; this is not cloud Object Lock acceptance. Exact source and
executed CI results are recorded in the implementation pull request.
