# Submitted original artifacts

Organization uploads attach originals to an existing organization owned Proof. They are operational evidence with their own immutable receipts and exact preserved object versions. They do not change a finalized capture manifest, complete a capture session, create a declaration, establish physical condition, or impersonate an assigned human operator.

The source assurance is `organization_submitted` for a service credential and `human_uploaded_attachment` for an authenticated workspace member. A reported timestamp preserves the submitted UTC offset separately from normalized time and server receipt time. No original is described as scanned or malware free. Derivatives are not produced by this path; their eventual identities and transformation versions must remain separate from the original.

The immutable receipt retains submitted logical JSON metadata separately from normalized fields. Received whole files freeze their server computed SHA-256, byte count and exact staging VersionId before completion is accepted; preservation must match all three even when no client digest was supplied. Known credential, private key and signed URL forms are rejected from metadata.

A requirement can explicitly opt in to `SOURCE_ARTIFACT` in `acceptedEvidenceTypes`. Its subject must match the artifact's immutable subject, and its acceptance time must fall on or before the requirement's due time plus grace. Reported time and reservation time do not establish deadline compliance. Detail coverage, list coverage, ready and missing views use the same rule. This option never substitutes a submitted attachment for a capture or declaration requirement.

| Action | Partner path, under `/v1/partner` | Human path, under `/me/records` |
| --- | --- | --- |
| Initialize | `POST /upload-sessions` | `POST /source-upload-sessions` |
| Resume/status | `GET /upload-sessions/:id` | `GET /source-upload-sessions/:id` |
| Whole original | `PUT /upload-sessions/:id/bytes` | `PUT /source-upload-sessions/:id/bytes` |
| Confirm parts | `GET /upload-sessions/:id/parts` | `GET /source-upload-sessions/:id/parts` |
| Upload part | `PUT /upload-sessions/:id/parts/:partNumber` | `PUT /source-upload-sessions/:id/parts/:partNumber` |
| Assemble parts | `POST /upload-sessions/:id/parts/complete` | `POST /source-upload-sessions/:id/parts/complete` |
| Accept completion | `POST /upload-sessions/:id/complete` | `POST /source-upload-sessions/:id/complete` |
| Completion status | `GET /artifact-operations/:operationId` | `GET /source-artifact-operations/:operationId` |
| List attachments | `GET /proofs/:proofId/source-artifacts` | `GET /:proofId/source-artifacts` |
| Download | `POST /evidence/:artifactOrEvidenceId/download` | `GET /:proofId/source-artifacts/:artifactId/blob` |

Human routes require `organizationId` and `environment` query selectors and an active human session. Initialization takes an `Idempotency-Key` and JSON:

```json
{
  "proofId": "proof_example",
  "connectionId": "integration_example",
  "sourceArtifactId": "original-provider-identity",
  "filename": "original.png",
  "contentType": "image/png",
  "byteSize": 128,
  "reportedAt": "2026-11-03T12:00:00-05:00"
}
```

`sha256` and `subjectId` are optional. A supplied SHA-256 must match the server computed complete file digest. A subject must be the Proof or one of its own entities. Humans may omit `connectionId` for a manual attachment; service uploads must identify a current source connection already bound to the Proof. An omitted source artifact identity receives a server identity. Reusing a permanent identity requires resuming the original session; a changed original requires a distinct identity.

Limits are 250,000,000 bytes per original, two active uploads per logical principal or human in an organization, 10 GB of reservations per organization/environment/day, seven day reservations, and at most two times the reserved file size of ingress. Parts are one based, 5 MiB except the final remainder. Every request has an exact fixed `Content-Length`. Supported media are JPEG, PNG, WebP, MP4, WebM, QuickTime, PDF, MPEG audio, MP4 audio, and WAV. Admission checks file signatures; it does not perform a malware scan. Invalid, oversized or partial bytes never become a committed original.

Initialization returns `sessionId`, `artifactId`, an authenticated `upload` contract, `partsUrl`, `assembleUrl`, `completeUrl`, `expiresAt` and `receivedParts`. Upload only absent parts after confirming their server SHA-256 and size. `parts/complete` assembles the original; then `complete` returns a durable 202 operation. Whole file upload skips assembly. Completion is intrinsically idempotent for that session's accepted staging VersionId. Operation states are `queued`, `running`, `succeeded`, `failed`. `succeeded` exposes the server SHA-256, byte count, media type and acceptance timestamp. `202` does not mean preservation or recovery publication has completed.

Upload receipts, received parts, received whole files, completion candidates and accepted results are included in the protected recovery checkpoint workflow. Their associated record revision, audit and outbox events commit atomically. Exact original object versions are verified during fresh restore; pending parts are verified before restoring resumability. Worker leases are cleared and reclaimed after restore. Quotas are rebuilt conservatively from immutable reservations rather than reset by a database restore.

Service sessions and completion reads are bound to the originating principal, credential, delegation and environment. Current authorization surrounds initialization replay, every ingress and completion action, worker work and result acceptance. A pause/resume control revision invalidates previously admitted work even after the connection resumes. Current location and membership policy applies independently of the authority present at initialization. A failed or expired worker lease cannot publish an orphan preservation as an accepted result.

Downloads require current `exports:read` for partner credentials; human downloads require current record read permission. The partner gateway internally resolves an artifact or capture evidence ID to its organization owned Proof. It issues no public reusable ticket and supports exact version ranges through the existing preserved object reader. Authorization is checked before sending and repeatedly during the bounded stream. Downloads are audited, private/no-store, sandboxed, and served as attachments with sanitized server filenames. PDFs and unsupported browser media are isolated as `application/octet-stream`.

Lists accept `limit` from 1 to 100 and a signed, expiring `cursor`, bound to the Proof, environment, organization, current actor binding and page size. Responses include `nextCursor`, `hasMore`, `total` and `downloadAvailable`; accepted attachments use state `available`. Other records remain visibly pending or failed.

Deployment qualification still requires independently verified private gateway configuration, storage versioning, IAM separation, retention and hold enforcement, recovery signer and journal policy, current production database role grants, and hosted revocation/restore drills. Local content-addressed version files and synthetic storage tests establish development behavior; they do not establish production Object Lock, protected storage or completed deployment approval.
