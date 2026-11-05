# Operational snapshot profile v1

This is an additive, organization-submitted assertion profile. Source code and
synthetic fixtures support the profile; production availability remains disabled
until its exact current deployment is independently qualified. A valid signature
does not establish shipment correctness, physical condition or the truth of a
source assertion. The live operational dashboard remains a different view.

## Identity and bytes

| Object | Profile or path |
| --- | --- |
| Frozen manifest | `packproof.operational-record-manifest.v1` |
| Signed payload | `packproof.operational-snapshot.v1` |
| JWS type | `application/packproof-operational-snapshot+jws` |
| Transport | `packproof.operational-snapshot-package.v1` |
| Evaluation | `packproof.requirement-evaluation.v1` |
| Manifest | `operational/manifest.json` |
| Signature | `operational/envelope.jws.json` |
| Original core bytes | `core/manifest.json` |
| Immediate prior manifest, when declared | `operational/prior-manifest.json` |
| Included originals | `originals/{artifactId}` |

The manifest and signed payload use RFC 8785 JCS and UTF-8. The flattened JWS has
exactly `protected`, `payload` and `signature`; the protected header has exactly
`alg: ES256`, `kid` and the type above. P-256 signatures use fixed-width JOSE
encoding. No other algorithm is admitted. The payload has exactly `profile`,
`snapshotId`, `organizationId`, `environment`, `proofId`, `revision`,
`manifestPath`, `manifestSha256`, `issuer` and `issuedAt`.

Historical core manifests remain opaque original bytes. When a finalized capture manifest exists, its recorded SHA-256
is checked directly; their bytes and existing signature interpretation are never
rewritten. Each core original must be included with matching exact commitments
or explicitly omitted. A prior manifest must match its declared digest, snapshot
ID, organization, environment, Proof and an earlier revision. Core linkage may move from explicitly absent to a preserved finalized capture manifest; an existing core digest cannot change or disappear.

## Frozen manifest schema

Unknown fields are rejected at every defined object boundary. The authoritative
executable validators are `operational-snapshot-profile.ts` and the independent
`verifier/operational_snapshot.py`. The published JSON Schema describes structural
validation; the validators additionally enforce membership, evaluation, linkage,
canonical bytes and digests.

The exact manifest root fields are:

```
profile, assertion, snapshotId, organizationId, environment, proofId, revision,
priorSnapshot, core, evaluation, actor, record, entities, links, requirements,
waivers, issues, actions, amendments, artifacts, omissions
```

`assertion` is always `ORGANIZATION_SUBMITTED`. Environment is `sandbox` or
`live`; revision is a positive integer. `core` contains `manifestSha256`: a SHA-256 for a preserved finalized capture manifest, or explicit null for an API-only record with no finalized capture. Absence never substitutes for a missing, corrupt or non-durable finalized manifest. A null core omits core/manifest.json from the archive and carries no fabricated core receipt; the independent report labels coreCapture:NOT_PRESENT. Existing packages and their original core bytes keep their prior interpretation. Older verifier builds that require core linkage reject an API-only package; use the current verifier.
`priorSnapshot` is null or `{snapshotId, manifestSha256}`. `evaluation` contains
`at` and `version`. Timestamps are valid UTC instants with millisecond precision.
`actor` contains the accepted human `userId`, `membershipId`, `role` (OWNER or
ADMIN) and nullable `locationId`. `record` contains nullable `title`, `reference`,
and `locationId`, plus `lifecycle`, `reviewState` and `updatedAt`.

The following rows preserve their neutral source values. IDs are unique inside
each section, subject references stay in the declared Proof/entity scope, and
parent, supersession and derivation chains must be acyclic.

| Section | Exact fields |
| --- | --- |
| entities | id, proof_id, kind, external_reference, parent_id, attributes, actor_user_id, supersedes_id, created_at |
| links | id, proof_id, evidence_id, subject_id, reason, actor_user_id, created_at |
| requirements | id, proof_id, subject_id, stage, title, template_version, accepted_evidence_types, due_at, grace_period_ms, created_at, evaluation_status, matching_artifact_ids |
| waivers | id, requirement_id, reason, actor_user_id, created_at |
| issues | id, proof_id, category, severity, title, subject_id, rule_version, compared_sources, created_at |
| actions | id, sequence, issue_id, action, reason, actor_user_id, created_at |
| amendments | id, proof_id, supersedes_id, assertion, reason, actor_user_id, created_at |

Requirement matching uses only included accepted artifacts of an accepted type,
accepted by the frozen deadline plus grace, associated with the declared subject.
Capture requirements can cover the Proof root or an explicit linked subject.
Source artifacts match only their explicitly declared subject. Reservation and
reported times never substitute for server acceptance time.
Matching IDs are sorted. Waiver wins, then nonempty matches mean `satisfied`;
otherwise a null or future deadline means `not_yet_due`, and an elapsed deadline
means `missing`. This is reproducible evaluation of submitted records, not a
physical judgment.

Each artifact has exactly `artifactId`, `path`, `kind`, `evidenceType`, `sha256`,
`byteSize`, `contentType`, `storage`, `source` and `derivation`. `kind` is
`CAPTURE_ORIGINAL` or `SOURCE_ARTIFACT`; `storage` is exact bucket, key and non-null
VersionId. `source` has `kind`, nullable `reference` and `reportedAt`, and
`receivedAt`, `acceptedAt`, nullable `actorId`, `connectionId` and `receiptSha256`. Source
artifacts require an origin actor and receipt digest; service submissions and
human uploads retain distinct source kinds. Derivation is null or
`{sourceArtifactId, recipeSha256}`.
An omission has exactly `artifactId`, `reason` and `detail`. Reasons distinguish
`MISSING`, `QUARANTINED`, `WITHHELD`, `UNAVAILABLE` and `PENDING`; included and
omitted IDs are disjoint. Omissions remain visible in the signed inventory.

Bounds are 10,000 rows per operational section, 4,000 included originals, 10,000
omissions, 200 MiB total original bytes, 8 MiB manifest bytes and 16 MiB combined
manifest/core/prior metadata. The encoded ZIP has the existing 220 MiB limit.

## Admission and preservation

A first-party human OWNER or ADMIN requests an empty body or a deliberate
`withheldArtifacts: [{artifactId, reason}]` list. `If-Match` supplies the expected
record revision; `Idempotency-Key` supplies stable command identity. The service
uses one repeatable database view, the recovery writer fence and the record lock.
It never accepts caller digests, object identities, membership or signing bytes.

The candidate, actor, idempotency facts, audit, event outbox and reconstructable
recovery event commit together. A replay reauthorizes the current caller. A stale
revision returns 412; conflicting idempotency input returns 409. A later edit
requires a later snapshot, linked to the preserved previous snapshot.

The worker admits only the independently preserved accepted event, verifies its
signature and exact protected journal version, and protects every required exact
artifact and metadata version through the declared deadline before signing.
It rechecks current actor, membership, role, location, organization, cohort,
lease and writer generation between external calls and before result acceptance.
Migration 103 supplies a narrow readonly definer function to lock those authority
rows. PUBLIC execution is revoked; separately qualified API/worker roles require
explicit execution permission. Location grants and ownership do not gain UPDATE
permission. API delivery insertion is limited to snapshot ID and next-attempt
time; only workers can mutate the lease/state projection or insert results.
Managed KMS startup checks the exact ARN and P-256 SPKI. Current authenticated
key history is checked before and after signing. API processes have no signer or
result-writing capability.

Conditional publication chooses a single protected result. A lost response reads
and verifies the winner rather than signing a replacement. Immutable accepted
result, receipt, audit and recovery outbox commit under the live lease/fence.
Status is `PENDING`, `SIGNED_PENDING_DURABILITY`, `READY` or `FAILED`. Only a
preserved result and result recovery event make it `READY`.
Transient failures retry the original candidate. A terminal failure retains its
receipt and original files for administrator review and maintenance replay;
changing the frozen candidate is not a retry. A later operational revision may
create a new candidate linked to the latest preserved signed snapshot. Failed
unsigned attempts remain visible in receipt history.

Fresh reconstruction verifies the original candidate and result bytes, source
recovery signature, independent issuer trust, exact artifact versions and
protection. It reconstructs jobs without copying mutable leases and never
resigns historical results. Access-policy/deletion replay remains required;
restored traffic and writers stay closed.

## Activation boundary

`PACKPROOF_OPERATIONAL_SNAPSHOTS_ENABLED` defaults to false. Enabling the flag
alone is insufficient. The environment factory requires separate API/worker
identities, actual exact database privilege checks, protected versioned stores,
current independently authenticated key history, cohort/cutover/retention/fence,
and an independently signed qualification bound to the exact source commit and
`OPERATIONAL_PROFILE_SHA256`. Legacy envelope deployment evidence is insufficient.

The qualification JWS type is
`application/packproof-operational-qualification+jws`, signed by a separately
pinned review authority distinct from the snapshot signing key. It names current
bindings and hashed evidence for actual runtime roles, storage/version protection,
conditional creation/lost responses, human HTTP/revocation, leases/fences,
independent trust/compromised keys, and fresh restoration/unchanged signatures.
It expires within seven days and is rechecked during use. Local synthetic tests
are source verification, not production qualification.

Recipient verification uses independently obtained issuer/key policy. A bundled
public key cannot establish trust. Reports separate mathematical signature,
key policy, untrusted timestamp, operational scope, omissions and physical truth.
Snapshot-specific recipient approval, redaction/disclosure policy and any
irreversible deletion remain their own controlled workflows.

The unreleased profile qualification digest includes OPTIONAL_MONOTONIC_PRESERVED_CORE_V1. Existing qualification evidence cannot enable a changed source/profile tuple. API-only acceptance keeps organization-submitted assurance, current human package selection, protected source/result preservation, independent issuer trust and all streaming/recovery gates; it never manufactures a personal attestation.
