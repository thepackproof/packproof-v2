# Operational snapshots: required signed extension

**Implementation status: additive source profile implemented; deployment remains
disabled and unqualified.** The live operational record view is not a signed
snapshot. Migration 103, the separate operational-snapshot manifest/signing/
preservation worker, exact-scope package and standalone verifier now implement
the source profile described in [OPERATIONAL_SNAPSHOT_PROFILE.md](OPERATIONAL_SNAPSHOT_PROFILE.md).
Its capability stays unavailable without independently authenticated qualification
for the exact current source, profile, workloads, storage, keys and recovery
boundary. Source fixtures do not establish general availability.

The existing canonical evidence package and additive integrity envelope remain
available only under their existing eligibility and activation rules. They cover
the exact original/core, stage or supplement inventories they declare. They do
not cover the new operational records tables, requirement evaluations, issue
reviews, operational amendments or entity relationships. The records media
gateway explicitly identifies its package scope as `canonical-proof-v1`.

## Why the existing signing path cannot accept an arbitrary operational JSON file

`integrity/envelope-access.ts` admits only an authorized first-party human request
for an already preserved CORE, STAGE or SUPPLEMENT within the enabled merchant
cohort and cutover. `integrity/envelope-jobs.ts` derives that request exclusively
from a DURABLE `PROOF_FINALIZED`, `STAGE_FINALIZED` or `SUPPLEMENT_COMMITTED`
recovery event. It validates the known manifest domain and derives exact original
object versions from that event. It does not accept client-supplied membership,
artifact digests, storage identities, or arbitrary signing bytes.

The new profile extends `domain/recovery-journal.ts` with frozen operational
tables, source-artifact state and immutable operational candidates/results.
Fresh restoration verifies the original signed result and exact protected
versions before reconstruction; it never resigns a historical result or opens
restored traffic. `record_state` and current authorization/deletion controls still
require independent policy-journal replay. Legacy envelope jobs continue to admit
only their original source kinds; new operational JSON is never sent to that
legacy signer.

The source-bound envelope deployment evidence, separate workload identities,
exact database privilege policy, writer fencing, protected versioned objects,
authenticated key history and fresh-restore requirements apply to the reviewed
existing profile. A new JSON file, a generated key, or a successful local
signature cannot extend that production qualification. Calling the signer
directly would bypass the accepted-source and reconstruction boundary.

## Required implementation and acceptance sequence

| Boundary | Required work before the capability can be enabled |
| --- | --- |
| Versioned contract | Publish an explicit operational manifest/profile with strict schema, neutral assertion semantics, tenant/environment, Proof ID, operational revision, prior-snapshot linkage, core manifest digest and declared scope. Version the transport if its descriptor or membership rules change. Preserve existing signed bytes and package v1/v2 interpretation. |
| Consistent candidate | Authorize an eligible human, require the expected revision and idempotency key, and freeze the operational state, entities, links, requirement template/evaluation, waivers, compared source values, issue actions and amendments from one consistent database view. Time-dependent requirement evaluations need a frozen evaluation time and version. A later edit creates a later candidate. |
| Exact evidence selection | Bind only accepted artifacts to exact bucket/key/VersionId, server digest and byte count, with source/receipt times and derivation history. Describe missing, quarantined, intentionally withheld and unavailable evidence separately. Do not enumerate a changing live list after candidate acceptance. |
| Durable acceptance | Commit the immutable candidate, actor attribution, idempotency result, audit and recovery/outbox event together. Introduce and validate the operational source event and restore schema. Return a pending receipt after durable command acceptance; do not label it signed or protected before those checks finish. |
| Restricted background work | Qualify API/worker table permissions for the added rows. API processes must not gain signing or result-writing authority. Workers require current actor/tenant/location/cohort authorization, an unexpired lease and current writer generation before and after external work. Preserve conditional-write winner and lost-response reconciliation behavior. |
| Preservation and signing | Independently protect the frozen candidate/recovery source and every required exact artifact version through the required deadline before signing. Reuse the managed-key and authenticated trust boundary only through an explicitly supported profile. A signing outage leaves the candidate pending and retains accepted evidence. |
| Accepted result and recovery | Preserve the exact result and commit its immutable receipt/audit/outbox atomically under the live fence. Keep readiness pending until result durability is established. Reconstruct candidate, result, exact artifact scope and authorization/deletion ledgers in a fresh database without resigning or exposing restored traffic. |
| Independent verification | Extend the standalone Python verifier to validate the new schema, canonical bytes, permitted algorithm, independent issuer/key trust, tenant/revision/core/prior linkage, complete declared membership, artifact digests/byte counts and omissions. A key bundled with the package cannot establish trust. Keep signature mathematics, key policy, timestamp, operational coverage and physical truth separate. |
| Controlled disclosure | Add snapshot-specific recipient/actions/expiry/revocation policy, and separately signed disclosure manifests where originals are omitted or redacted. Reauthorize export generation and streaming. A new operational snapshot must not inherit an unrestricted organization grant accidentally. |
| Actual deployment qualification | Record current source, runtime roles, exact storage policies/versions, key-history distribution, crash/revocation/lease tests and fresh restore. Preserve feature, cohort, human-admission and protection gates. Do not replace deployment evidence with self-authored acceptance booleans. |

Required independent fixtures include a valid new snapshot, late operational
addition, stale expected revision, conflicting idempotency payload, lost response
after preservation, expired and stolen lease, fenced worker, membership/location
revocation, missing/changed/withheld artifact, wrong core/prior/tenant linkage,
signer outage, compromised key, unsupported schema, and fresh restoration with
unchanged historical signature bytes.

## Current release behavior

The operational dashboard may show its current API data, history, evidence and
review actions, with explicit assurance that it is a live operational view. It
must keep operational snapshot creation unavailable unless the new profile's
current qualification, human admission and protection gates pass. The separately authorized
canonical package download must identify the narrower captured-evidence scope.
No unsigned operational download or HTML report is a substitute for the required
versioned signed operational snapshot.

See [VERIFICATION.md](VERIFICATION.md) for the supported offline recipient
workflow and [ENVELOPE-PROFILE.md](../partner-foundation/ENVELOPE-PROFILE.md) for
the existing integrity profile and its activation boundary.
