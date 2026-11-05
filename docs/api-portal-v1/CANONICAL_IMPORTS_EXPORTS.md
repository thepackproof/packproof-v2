# Service CSV imports and fixed canonical exports

These additive routes use the existing organization credential middleware, current credential and delegation policy, canonical PostgreSQL Proofs, source bindings and private object storage. They do not make a service principal into a human participant or grant new signing rights. Production activation still requires deployment, privilege and recovery acceptance.

## Service CSV

| Route | Input and current authority | Result |
| --- | --- | --- |
| `POST /v1/partner/imports/preview` | `Idempotency-Key`; `{integrationAccountId,operatorMembershipId,csv,mapping?,timeZone,sourceName?}`; `imports:write`, `imports:read`, `proofs:write`, `proofs:read` | 201 immutable source preview |
| `GET /v1/partner/imports/:importId` | Same current principal, credential, merchant, environment and delegation; `imports:read`; current selected operator/location and any referenced Proof authority | Current preview, row outcomes and safe corrections CSV |
| `POST /v1/partner/imports/:importId/commit` | `Idempotency-Key`; `{previewVersion,importValidRows:boolean}`; current `imports:write`, `proofs:write` plus status-read authority | 202 durable queued receipt |

Limits are the same bounded parser used by human imports: UTF-8 text, 2 MiB, 1,000 data rows, 50 columns and 10,000 characters per cell. An explicit IANA time zone is required. Leading zeros and source values remain strings. Local ambiguous timestamps and ambiguous headers require a corrected preview. Formula-like cells are escaped when returned as correction CSV.

The exact original UTF-8 bytes are create-only preserved and server-hashed at an exact storage version before a preview is acknowledged. The preview version binds source digest, parser profile, mapping, time zone, integration account, operator assignment and source name. Source receipt and parsed rows are immutable. Correcting a row creates a new preview; successful prior rows remain deduplicated.

The actual service actor calls the existing `importPartnerOrder` primitive, which records the service creator and origin principal and assigns the real active operator. A permanent SHIPMENT binding uses the supplied source account and shipment reference. The same source reference and normalized payload is a duplicate; changed details or operator assignment require explicit correction rather than a silent merge. Imports never infer physical truth from a tracking number. A spreadsheet is a one-time import, with no automatic synchronization claim.

The worker uses a 120-second lease and validates the exact original digest/version, current credential/grant/operator/location and lease again after external storage calls and before each committed canonical row. Accepted rows and their result IDs survive retries. Failed eligible rows may be retried with the same receipt; attempts are bounded at five. A worker that loses its lease cannot acknowledge a row. Partial imports require the explicit `importValidRows:true` choice whenever unresolved row errors exist. A delegated service cannot import a located row without an accepted explicit site-grant profile.

## Canonical selection aliases

`GET /v1/partner/proofs/:proofId/snapshots` lists up to 100 currently usable immutable CORE, LIFECYCLE and accepted ENVELOPE selections. `GET /v1/partner/proofs/:proofId/snapshots/:kind/:snapshotId` returns their scoped metadata and limitations. Both require current `exports:read`; envelope reads retain existing deployment, cohort and preservation checks. They do not request a signature or create a new snapshot.

A selection is `{proofId,kind,snapshotId,sha256,scope}`. The scopes are `FROZEN_CORE_ONLY`, `SEALED_COMMERCE_LIFECYCLE` and `ACCEPTED_PROTECTED_RECORD`. The alias exposes no storage keys or presigned URL. Its selection hash is SHA-256 of the existing canonical sorted JSON serialization. Signature presence is reported separately from independent verification and trust.

## Durable canonical package jobs

| Route | Contract |
| --- | --- |
| `POST /v1/partner/exports` | `Idempotency-Key`; `{proofId,kind,snapshotId,expiresAt?}`; current `exports:create` and `exports:read`; 202 queued receipt |
| `GET /v1/partner/exports` | Last 100 jobs owned by the exact current service credential and delegation; current `exports:read` |
| `GET /v1/partner/exports/:exportId` | Current exact owner and current Proof export authority |
| `GET /v1/partner/exports/:exportId/package` | Current exact owner and Proof authority before and throughout the authenticated ZIP stream |

The OWNER/ADMIN human wrappers use organization/environment query selectors:

* `GET /me/records/:proofId/canonical-snapshots`
* `GET /me/records/:proofId/canonical-snapshots/:kind/:snapshotId`
* `POST /me/records/:proofId/canonical-exports` with `{kind,snapshotId,expiresAt?}` and `Idempotency-Key`
* `GET /me/records/canonical-exports`
* `GET /me/records/canonical-exports/:exportId`
* `GET /me/records/canonical-exports/:exportId/package`

Human job ownership binds the requesting current membership. Reviewers and operators cannot use these full-package organization exports; existing assigned-participant legacy policy remains separate. A role change, site revocation, disabled organization, credential/grant revocation or expiry is checked again during processing and download. Rotation does not silently transfer job authority to another credential.

The receipt contains `id`, `operationId`, `kind:'canonical_package'`, organization/environment, `proofId`, exact `selection`, `selectionSha256`, `state`, `receivedAt`, `updatedAt`, `expiresAt`, `readyAt`, `downloadAvailable`, `lastErrorCode` and, only when ready, `{sha256,byteSize,contentType:'application/zip',versionBound:true}` artifact metadata. States are `queued`, `running`, `ready`, `action_needed` and `expired`.

Expiry defaults to 24 hours and is bounded at seven days. It controls stored download availability; it does not create a share, extend a share expiry, prove recipient delivery or promise byte erasure. The receipt says `expiryMeaning:'STORED_DOWNLOAD_AVAILABILITY'` and `shareCreated:false`. No `If-Match` is needed for an immutable selected snapshot. An idempotent replay cannot change its selection or expiry.

The canonical job profile requires complete selected originals. There is no omissions-consent field: an unavailable or changed required original results in `action_needed`, never a ready partial package. The fixed CORE profile excludes later stages, supplement heads, shipping projections and events outside the frozen root inventory. LIFECYCLE selects only its existing signed index. ENVELOPE reuses only an already preserved protected operation and its existing trust checks. Later operational revisions, requirements, issues, relationships, amendments and review notes remain outside these canonical profiles. Every receipt says `operationalSnapshot:false`.

At most ten active canonical jobs are accepted per merchant/environment. A worker lease is 120 seconds. A private disk spool and streaming ZIP/object-store APIs bound memory and enforce the existing 200 MiB original / 220 MiB package budget. The server pins and verifies the staging version when committing, then verifies the exact committed version, digest and byte length before atomically marking a receipt ready. The archive timestamp and selection are fixed at acceptance for deterministic retries. A lost worker lease cannot publish a ready artifact. Downloads stream only the preserved exact version, recheck authority and availability during delivery, and reject length or digest mismatch.

## Runtime wiring and privileges

Mount `createPartnerImportsRouter`, `createPartnerSnapshotsRouter` and `createPartnerExportsRouter` inside the existing authenticated partner router. Mount `createRecordSnapshotsRouter` and `createRecordCanonicalExportsRouter` before the general human records router. Call `processPendingPartnerImports(deps,limit?)` and `processPendingCanonicalExports(deps,limit?)` from the existing durable worker scanner. Receipt state is PostgreSQL-canonical; an in-process timer is not acceptance.

Migration 101 adds `partner_import_jobs`, `partner_import_rows` and `record_canonical_export_jobs`. API runtime needs SELECT and INSERT on those tables; commit/status paths need only their documented mutable state/lease/result columns updated. Workers require mutable row status/result/attempt columns and job state/lease/error/artifact columns. Immutable source, authority, selection and completed-artifact triggers must remain intact. No runtime DELETE is required. This source implementation does not itself assert deployed least privilege, immutable journal coverage, restore qualification or launch approval.
