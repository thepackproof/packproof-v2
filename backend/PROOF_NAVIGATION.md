# Proof navigation contract — 8 September 2026

`src/domain/proof-presentation.ts` is a pure TypeScript module imported by the server, mobile and web. It owns row status, attention membership, next action, evidence completion, shipment status, share capability and safe unknown-state diagnostics. It has no Node, database or platform imports. `withLocalProofWork` overlays only account-scoped recoverable local work. It cannot finalize a record. `canContribute` is independent of sharing; a buyer's active receipt stage can need recovery while the seller's evidence is complete and sharing remains seller-controlled.

## Server facts and presentation

| Server / viewer facts | Status | Next action | Attention |
| --- | --- | --- | --- |
| Pending targeted invitation | Invitation received | Accept invitation | Yes |
| Required participant has not joined | Waiting for participant | View Proof | No |
| Authorized seller; qualifying fulfillment capture missing | Recording needed | Record packing | Yes |
| Authorized seller; qualifying capture committed | Confirmation needed | Review and confirm | Yes |
| Buyer waiting on seller | Waiting for participant | View Proof | No |
| Finalized state and server finalization timestamp | Proof completed | View Proof | No |
| Existing viewer-owned receipt/return work | Applicable recording/confirmation needed | Applicable workflow action | Yes, including finalized root |
| Cancelled source order, unfinalized root | Order cancelled | View Proof | No |
| Unknown/closed/expired lifecycle state | Truthful neutral status plus diagnostic | View Proof | No |
| Local upload progressing | Uploading, optional progress | View Proof | No |
| Local upload needs recovery | Upload interrupted | Resume upload | Yes |
| Interrupted recording without continuous resume support | Recording unfinished | Review interrupted recording | Yes |

The current finalization rules require qualifying `FULFILLMENT_CAPTURE` and seller attestation for commerce and peer Proofs. Generic committed evidence must not cause a false confirmation-ready or complete label. Grading uses its existing viewer-role-aware workflow policy. Capture eligibility does not change. Sharing and shipping delivery never finalize evidence.

## Collection compatibility and pagination

`GET /me/proofs` without query parameters retains the old participant-only response and 100-item limit.

New clients use `GET /me/proofs?view=all|attention|completed&q=...&limit=100&offset=0`. Response: `{proofs,total,nextOffset}`. Omitted `nextOffset` is never assumed to mean a complete legacy result. `nextOffset: null` terminates the new query. Search covers title, reference, canonical Proof ID, source and authorized tracking number. Filtering, sorting and totals apply to the complete accessible collection before slicing. No local page produces an authoritative total. The implementation reads all authorized row facts in a single collection query and evaluates the shared classifier before slicing; grading records use their existing custody policy. This avoids duplicating action semantics in SQL. Very large installations may later move the same contract into an indexed projection.

Authenticated canonical GET responses include the same `presentation`. Internal command projections without a viewer omit it; clients re-fetch the viewer-authorized Proof after writes. Each new row includes `presentation`, `source`, `invitationId`, and `accessKind`:

- `PARTICIPANT`: existing canonical Proof access; `/proof/:id`.
- `INVITATION`: unaccepted targeted invitation; accept through existing invitations API before opening participant-only detail.
- `RECEIVER`: existing targeted receipt access; open `/receipt/:id` and use the lifecycle API. Pending receipt invitations have `invitationId: "receipt:<proofId>"`; they must not call the ordinary invitation acceptance endpoint.

Rows are deduplicated by canonical Proof ID, prioritizing participant, ordinary invitation, then receipt access. Invitation and receipt discovery omit shipping identifiers, financial data and private source details. Receipt discovery does not grant participant/root-media access. All and attention sort actionable first, then update time, with ID tie-breaker. Completed sorts by finalization time and ID. Clients preserve the visible order until refresh to avoid moving a touched row.

## Sharing

Early creation already used `/proofs/:id/disclosure/preview` and `/grants`. It remains subject to the original explicit preview approval and seller authority. Narrow disclosure purposes, media scopes and original-review rules are unchanged.

`POST /proofs/:id/disclosure/reuse {token}` validates an already cached SHARED_PROOF link against the actor's current seller access, canonical Proof ID, exact live disclosure categories, policy, expiry and revocation. It returns the same link metadata, token and URL without minting a token, changing scope, or incrementing a public view count. Persistence remains hash-only for tokens. New clients cache successful links per account, Proof and scope; on later taps they validate this endpoint online. Offline copying uses an existing nonexpired cache with a sync explanation. Fresh devices without a cached token require a newly reviewed grant; server hash-only token storage cannot reconstruct a lost secret.

Public responses add `evidenceState` (`NOT_RECORDED`, `UPLOADING`, `AVAILABLE`, `NOT_SHARED`) with explicit copy. A pending shared-record upload says "Evidence is still uploading" but never exposes its bytes, object key or an accessible media entry. Pending means a server-authorized upload has not been committed, including one whose connection stopped; it does not claim byte transfer is advancing. Scoped historical grants do not learn about unrelated pending sources. Original playback and downloads continue to require committed, authorized media.

## Canonical intake

`commerce-fulfillment-sync.ts` already calls `importNormalizedTransaction(... createProof: true)`, which reuses the immutable tenant/external transaction binding and `createOrGetProof`. No client-side order merge, replacement queue, migration, reseed or new write-on-list path is introduced. Existing cancellation updates remain source metadata; they do not delete or finalize the canonical Proof. Regression suites cover repeated imports, shop separation, cancellation and provider pagination.

## Recovering confirmation without a local file

Capture issuance and evidence initialization already accept both `READY_FOR_EVIDENCE` and `EVIDENCE_COMMITTED`. A supporting attachment must never block the still-required native packing video; previously committed bytes remain immutable.

Authenticated canonical evidence exposes `captureSessionId` and `captureClient` only to the original uploader. These are null for other participants and for internal projections without an identified viewer; public scopes do not include them. A seller can review a server-committed original, then use its session ID and committed SHA-256 with the existing attestation challenge endpoint. That endpoint already accepts the original owner's committed native packing session, checks the exact Proof, digest, shipping review and current transaction context, and requires a fresh P-256 signature from Android's biometric workflow. Confirmation does not require re-uploading or recovering a local media file, and it cannot manufacture another participant's attestation. Web-camera sessions remain ineligible for Android native-session authorization. No biometric samples are stored.
