# Records service operating runbook

Use this runbook alongside the existing [organization operations](../partner-foundation/OPERATIONS.md),
[protected envelope profile](../partner-foundation/ENVELOPE-PROFILE.md),
[recovery specification](../DURABLE_RECOVERY_AND_RETENTION.md) and
[backend release procedure](../../infra/backend-release/README.md).
Those documents define the deployed mechanisms; this runbook defines operator
decisions for the records product. Incident actions require the existing scoped
operator identity and current authorization.

## Ownership and safe diagnostics

The service owner coordinates incidents. The connector maintainer owns provider
mapping/access/reconciliation. The release operator owns deployment and migration.
The evidence custodian owns holds, deletion conflicts and preservation incidents.
Collin assigns the actual people and escalation channel before a pilot is opened.
These role descriptions are not a claim that a staffed support rotation exists.

Collect request/operation/record/connection IDs, environment, safe organization
identifier, timestamps, error codes, deployment identity, retry count, oldest
pending age and the affected workflow. Keep credentials, bearer fragments,
presigned URLs, source payloads, addresses and media contents out of diagnostics.
An authorized support bundle must disclose its contents before being shared.

Treat cross-organization disclosure, changed retained bytes, forged attribution,
lost acknowledged work and restoration of revoked access as stop conditions.
Contain the affected scope, preserve receipts and audit evidence, and investigate
before expanding traffic. Do not clear queues or delete records to make a health
indicator recover.

## Stalled ingestion or processing

1. Find the durable receipt using the operation ID. Distinguish rejected input,
   accepted/pending work, a permanent mapping/access error and an unknown outcome.
2. Compare the source identity and idempotency key with the committed outcome.
   After a lost response, retry the same command and key; do not issue a new key
   to “unstick” a potentially committed record.
3. Inspect worker heartbeat, lease owner/expiry, oldest pending age, attempts,
   outbox state and dependency readiness using the authorized operations surface.
   An expired lease may be reclaimed by the normal worker; an active lease must
   not be manually taken over.
4. Restore a transient dependency and allow bounded retry. For permission/schema
   errors, pause the affected connection and correct the cause. Keep its last
   committed cursor and mapping version.
5. Replay only the bounded failed scope under current organization authority.
   Reconcile accepted receipts to terminal or actionable outcomes and record any
   discrepancy. A CSV retry must preserve rows that already succeeded.

Customer wording: “Processing is delayed” for accepted retryable work; “Action
needed” for a specific mapping/access correction. Never show a completed record
merely because authorization or upload started.

## Missed events, delivery failures or source lag

1. Compare the committed event high-water mark and the last authorized cursor.
   Webhooks are notifications; fetch current authorized state to reconcile.
2. Verify destination health, signed-delivery verification and retry/dead-letter
   state. Preserve stable event identity across retries. Do not sign a replay as
   a new business observation.
3. If a cursor expires, perform an explicit scoped snapshot resynchronization and
   restart the feed; deduplicate stable event IDs. Do not silently reset it.
4. For a provider, compare successful poll time, provider watermark/heartbeat,
   expected cadence and visible records. An authenticated connection can be stale;
   silence alone does not establish health or a failure.
5. Resume with a bounded catch-up range after authorization/mapping is repaired.
   Check record counts, source identities and receipts against the source export.

Use “Freshness unknown” when the source cannot establish a current watermark.
One-time CSV imports display their import time and “Continuous sync not
applicable”; they do not participate in automatic-connection freshness claims.

## Signing service outage or trust failure

1. Identify the affected snapshot and current signing/trust error. Retain the
   original accepted evidence and pending durable job.
2. Inspect the approved signer readiness, key status, trust-list validity,
   exact-source binding and API/worker authority separation. Only the dedicated
   approved signing process may initialize a gated envelope signer.
3. Recover the dependency or approved trust material. Retry sealing against the
   same exact snapshot bytes, then compare the finalized bytes before committing.
4. If candidate context changed, rebuild the candidate through the normal domain
   operation. Never attach a signature to modified bytes or replace a failed
   signature with an unsigned success.
5. Verify the output using published historical trust material and preserve the
   request/result receipt. An available key does not establish physical shipment
   condition, capture time or source truth.

Show “Snapshot pending” or the named trust/integrity failure until verification
succeeds. A protected profile stays unavailable until all its storage, cohort,
writer-fence, human-admission and source-bound acceptance gates pass.

## Search lag or unavailable search

1. Distinguish a failed query from an empty result. Preserve filters and display a
   retry action; do not show “No records” after a backend failure.
2. Try the exact authorized record link or canonical identity lookup. The same
   organization/location restrictions apply to lookup, totals and suggestions.
3. Compare accepted-record and visible-projection times, database readiness and
   measured query plans. Reconcile the bounded stale scope without rewriting the
   underlying evidence or widening tenant access.
4. Recover the query/projection path, verify representative scoped records and
   remove the incident state only after the projection catches up.

## Compromised or expired credentials

1. Identify the credential/principal/grant and the affected organization/source.
   Do not paste the secret into a ticket or diagnostic command.
2. Revoke through the existing administration boundary with fresh human
   authentication. Principal revocation disables its credentials; current grant
   checks must also deny queued work and streamed downloads.
3. Pause the affected connection and destination where required. Preserve records,
   mappings, receipt history and the last committed cursor.
4. Issue a narrowly scoped replacement under the current policy, reconnect using
   the supported provider flow and test one bounded read/ingestion/visible record.
   Do not mark the source active after consent alone.
5. Reconcile affected work and inspect audit history. If a signing key is affected,
   use the established compromise/trust-history procedure; never erase the public
   history needed to evaluate previously signed snapshots.

## Hold, deletion or retention conflict

1. Confirm actor authority, requested scope, customer policy, retention class,
   current holds, dependent claims and object-version retention deadlines.
2. Create or retain the durable review outcome. A deletion request is not evidence
   that bytes were physically erased. A denied request must name the applicable
   reason without disclosing another party's private details.
3. An evidence custodian resolves policy conflicts through the authorized review
   path. Do not disable immutability triggers, shorten retention or remove a hold
   to satisfy a request.
4. Account separately for originals, derivatives, redacted disclosures, existing
   exports, backups and downstream recipients. Record what remains recoverable
   and when backups age out; downloaded copies cannot be recalled by revoking a
   PackProof grant.
5. Before releasing any restored data, reapply deletion/revocation ledgers and
   verify the denied cases again. Do not destroy an encryption/signing key as an
   informal erasure shortcut affecting unrelated retained evidence.

## Corrupt or missing accepted artifact

Stop affected verification/export and preserve the exact object/version identity,
expected digest, receipt, storage error and audit trail. Compare the versioned
original and protected recovery evidence using authorized read-only tooling.
Never silently replace bytes under the accepted artifact identity. Recover only
through the documented preservation mechanism and retain the incident result.
Expose the named artifact as missing/mismatched until the exact bytes are safely
available and independently checked.

## Fresh-target restoration

1. Declare the disaster scenario, incident owner, intended recovery point and
   accepted exposure boundary. Record actual start/end times. The plan proposes
   RPO <=15 minutes and RTO <=4 hours; those are unproven until this scenario is
   measured.
2. Fence old writers, signing and external publication through the approved
   control plane. Keep the restored service private with traffic and workers
   closed. Do not rely solely on a process believing it has lost a lease.
3. Restore PostgreSQL to a new isolated target using the approved backup/PITR
   procedure. Restore original object versions, recovery journals, policy heads,
   public trust history and signing dependencies separately; database restoration
   does not recreate them.
4. Use exact compatible schema/application identities and the existing protected
   recovery validator. Reapply deletion, revocation, grant, hold and writer-fence
   policy before allowing reads or dispatch.
5. Compare representative original digests, manifest/snapshot signatures, current
   grants, rejected revoked grants, deleted-data denials, connector cursors,
   accepted receipts and pending jobs with the pre-incident inventory.
6. Resume one bounded ingestion/reconciliation flow; verify retries do not create
   duplicate records and notifications do not regain revoked access. Reopen
   traffic only after the operator and evidence custodian accept this evidence.
7. Retain the restoration receipt and measured recovery gap/duration. Repeat after
   material storage/identity changes and on the proposed quarterly drill cadence.

Historical isolated restore receipts are useful regression evidence. They do not
establish this candidate's recovery time or current production backup coverage.

## Monitor and report

Track eligible request availability/latency; accepted versus completed commands;
oldest pending/outbox age; processing and projection lag; dead webhook delivery;
connection watermark age; authorization denials; original digest failures; export
duration/bytes and cost. Page for user impact or integrity risk, not successful
low-volume polling. Keep security audit records separate from diagnostic logs.

Measure metadata, queues, originals/derivatives, scanning, thumbnails, polling,
logs, exports/egress, backup and retention costs per accepted record and retained
GB. A budget warning must not remove already accepted evidence. New oversized
work is rejected or delayed before durable acceptance according to the published
admission policy.
