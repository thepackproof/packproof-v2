# Paid onboarding publication gate

`scripts/publication-policy-gate.mjs` implements the W12-B software refusal gate. It does not supply PackProof's entity information, approve legal documents, send support messages, or assert that any current public page or former-subscriber workflow has been verified. The existing developer-review legal placeholders remain blocked. Real approval and observed workflow evidence must be supplied by the responsible owner before paid onboarding can open.

Run the explicit publication command from the repository root after supplying actual reviewed records:

```sh
node scripts/publication-policy-gate.mjs \
  --manifest /secure/publication/manifest.json \
  --approval-registry /secure/publication/approval-registry.json \
  --output /secure/publication/publication-receipt.json
```

`PACKPROOF_PUBLICATION_APPROVAL_REGISTRY_SHA256` must already contain the SHA-256 of the exact independently reviewed registry file bytes. Obtain and pin that value through the operator's reviewed configuration process. A hash included by an applicant in its own manifest does not establish approval. No default registry, approver, legal entity, document or approval is installed. The command exits **1** with a bounded reason code if data is absent, invalid, pending, stale or inconsistent. It exits **0** only after every check passes. An output path is replaced atomically with the latest result, including a blocked result, so a failed rerun cannot silently leave an earlier successful receipt there.

Ordinary development verification uses synthetic fixtures and does not require actual legal or customer data:

```sh
node --test scripts/publication-policy-gate.test.mjs
```

The fixtures do not contact a live host or represent real approvals. Tests include refusal of every existing `[... — developer review]` placeholder in `web/src/legal/documents.ts`, changed documents, pending and future approvals, unknown approval hashes, incomplete entity/contact/support fields, stale and failed former-subscriber export evidence, a different release, unavailable pages, and changed served bytes.

## Input records

Keep the manifest, offer, static policy artifacts, approval records and redacted workflow evidence together in a restricted evidence directory. All referenced artifact paths are relative to the manifest directory, must remain within it after resolving symlinks, and are limited to two MiB. The separate approval registry may live outside that directory. File references use `{ "path": "relative-file", "sha256": "exact-raw-file-SHA256" }`. Record files are JSON. Unknown or missing record fields are refused.

The manifest has these exact fields:

| Field | Required value |
| --- | --- |
| `schemaVersion` | `packproof.publication-policy.v1` |
| `environment` | `production` |
| `releaseSha` | Exact 40-character source commit to which observed workflow evidence applies |
| `origin` | Public HTTPS origin, without trailing slash, credentials, port or fragment |
| `entity` | Object containing actual `legalName`, `contactAddress`, `contactEmail`, `supportEmail`, `supportUrl` |
| `documents` | Exactly `terms`, `privacy`, `support`; each has `version`, `artifact` file reference, `approvalRecord` file reference and `servedUrl` |
| `supportEvidence` | File reference to the independently reviewed observed workflow record below |
| `offerPath` | Relative JSON file containing the exact approved `packproof.billing.v1` offer |

Policy artifacts must be static UTF-8 HTML, text or Markdown. Each must visibly identify its version and actual entity. Terms and privacy identify the contact email; support identifies the support email. The set must include the actual contact address and support URL. This is a mechanical completeness check, not a decision about what legal provisions are sufficient. Copy containing known developer placeholders, TODO/TBD markers, sample domains or unfilled company/contact markers is refused.

Each document approval record has exactly these fields:

| Field | Required value |
| --- | --- |
| `schemaVersion` | `packproof.policy-approval.v1` |
| `status` | `approved` |
| `documentKind` | Matching `terms`, `privacy` or `support` |
| `version` | Exact document version |
| `artifactSha256` | SHA-256 of approved artifact bytes |
| `entitySha256` | Canonical JSON SHA-256 of the manifest's exact entity object |
| `reference` | Actual dated approval record's opaque reference; terms must equal the offer's `approvedTermsReference` |
| `approvedAt` | Actual approval timestamp in `YYYY-MM-DDTHH:mm:ss.sssZ`, never in the future |
| `approverId` | Actual attributable approver identifier represented in the pinned registry |

The approval registry has `schemaVersion: "packproof.publication-approval-registry.v1"`, `environment: "production"`, the same `origin`, a future UTC `validUntil`, `approvals` entries `{recordSha256, approverId}`, and `workflowVerifications` entries `{recordSha256, verifierId}`. Each record hash is its exact file-byte SHA-256. The registry must pin the exact document approvals and support verification used in this release. Approvals cannot be established by changing an untrusted manifest, adding a new local record, copying an approver's name, or toggling a Boolean: the independently supplied registry pin must match too. The operator remains responsible for reviewing the real approval source and controlling configuration that pins those hashes; this tool cannot authenticate the human acts described in a forged record that an operator deliberately pins.

## Support and former-subscriber evidence

The support verification record has exactly `schemaVersion: "packproof.support-workflow-verification.v1"`, `source: "observed"`, `reference`, `verifiedAt`, `verifierId`, `environment`, `origin`, `releaseSha`, `entitySha256`, `supportEmail`, `supportUrl`, and `checks`. Every context value must match the manifest. The observation must be within 30 days, never in the future, and the full record's hash/verifier must appear in the pinned registry. This 30-day refresh and the receipt's 24-hour validity are engineering publication limits, not legal deadlines or support promises.

`checks` contains exactly `supportIntake`, `supportReply` and `formerSubscriberExport`. Each has `state: "passed"`, an attributable opaque `evidenceReference`, and an `evidence` file reference. The command reads and verifies the underlying file bytes. Failed, skipped, merely planned, synthetic, stale or missing observed checks cannot pass.

The owner must review the attached observation before pinning it: the support intake actually arrived at the stated channel, a reply reached its intended test recipient, and an account whose paid subscription ended could retrieve an authorized export of its preserved historical evidence. Keep actual cancellation/account-state and export completion receipts, with timestamps, exact release identity, access scope and outcome, in restricted evidence; use redacted copies/references appropriate to the review. An exported test fixture or a support address that merely exists in configuration does not establish these outcomes. The program verifies the reviewed evidence's integrity and context, not the truth of unsupported prose or legal compliance. It performs no message delivery itself.

## Served pages and approval receipt

After all local records and trust pins pass, the command reads each distinct policy URL from the exact configured public origin. Requests use HTTPS, a ten-second timeout, no credentials, no cookies, no redirects, no cache reuse and a two-MiB cap. HTTP 200 and a text content type are required. Returned decoded HTTP response bytes must match the approved artifact exactly. A local screenshot, a developer's statement, an HTTP redirect, a client-rendered application shell or a changed page does not satisfy the served-byte check. Publish the approved static artifacts at their intended URLs before opening paid enrollment; those pages can be reviewed without enabling billing.

The success receipt contains schema `packproof.publication-policy-receipt.v1`, state `passed`, exact `offerVersion`, `canonicalOfferSha256`, `approvedTermsReference`, `releaseSha`, `entitySha256`, `approvalRegistrySha256`, the three document versions/hashes/approval references/served URLs and check timestamps, `supportEvidenceSha256`, `evaluatedAt`, `expiresAt`, and `receiptSha256`. Validity ends at the earliest of 24 hours, registry expiry or the support evidence's 30-day limit. Recheck served pages and supply a fresh reviewed receipt before creating new paid enrollments after expiry.

`receiptSha256` hashes canonical JSON with that field excluded. Canonicalization sorts object keys recursively, preserves array order and hashes UTF-8, matching the backend offer canonicalization. Registry and evidence file hashes instead use their raw file bytes. To compute an entity canonical hash from an actual entity JSON file:

```sh
node --input-type=module -e 'import {readFile} from "node:fs/promises"; import {canonicalSha256} from "./scripts/publication-policy-gate.mjs"; console.log(canonicalSha256(JSON.parse(await readFile(process.argv[1], "utf8"))))' /secure/publication/entity.json
```

The billing module requires `PACKPROOF_PUBLICATION_RECEIPT_FILE` plus a separately pinned `PACKPROOF_PUBLICATION_RECEIPT_SHA256` for approved-offer registration and new paid enrollment, or the equivalent trusted internal configuration options. That second pin is the receipt's canonical digest, not the hash of its formatted file. The module checks freshness, state and exact offer/terms binding. An opaque `approvedTermsReference` by itself cannot open paid enrollment. Existing recorded period replays and historical evidence access remain available; an expired publication receipt never erases records or turns a past successful operation into a new charge. Draft offers remain usable in development without a real approval receipt.

Retain the approved source documents, attributable dated review records, observed support/export evidence, exact served-page artifacts, registry/pins and receipt with the release evidence under the owner's access policy. This gate closes the software refusal requirement. Actual W12-B business acceptance remains pending until the real records and observed outcomes exist.
