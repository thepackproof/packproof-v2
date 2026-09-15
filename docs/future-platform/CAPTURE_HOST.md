# Capture host completion contract

WP06 extends the existing authenticated `capture_intents` and `capture_engine_sessions` flow. It adds a signed, immutable completion receipt; recording, sealing, evidence upload, seller attestation and finalization keep their existing behavior. A sealed recording or a host UI event is never completion.

## Launch and completion

1. The signed-in seller creates an intent through the existing capture-intent endpoint. Keep the returned `intentId` with the host's original Proof and actor context. Launch tokens remain short lived and single use; keep their existing URL-fragment transport and do not log them.
2. Existing binding associates the intent with one recording session and server-created context. Keep the session ID and `contextSha256` returned by binding. Original order context, actor and allowed surfaces are still enforced by the existing engine.
3. The recording follows the existing seal, upload, commit, attestation and Proof finalization path. An upload that is pending, failed, cancelled or committed without a finalized Proof cannot obtain a completion receipt.
4. The authenticated receipt issuer calls `issueCaptureCompletionReceipt(db, clock, actor, captureId, signer)`. It checks the original consumed intent, capture session, committed evidence identity and digest, sealed capsule digest, frozen final manifest digest and exact source/capsule inclusion in that manifest.
5. Subsequent calls return the exact same stored canonical bytes, receipt ID and signature. `readCaptureCompletionReceipt(db, actor, captureId)` retrieves an already issued receipt without signing again. Both authorize the original capture actor as a current seller participant, including active-account and recovery-policy checks.

The route integration uses these exported functions behind existing authentication. Completion signing requires the configured `ManifestSigner`; the service fails closed with `CAPTURE_COMPLETION_SIGNING_UNAVAILABLE` (503) if no signer is available. Pending completion returns `CAPTURE_COMPLETION_PENDING` (409), and read-before-issuance returns `CAPTURE_COMPLETION_NOT_ISSUED` (404). A signed receipt does not upgrade an unsigned historical root into a historically signed root; it signs the current server assertion about that root's exact frozen digest.

The private server-side SDK in `packages/capture-sdk/server.mjs` adds `issueCompletionReceipt(proofId, captureId, {idempotencyKey, expectedContext, trustedKey})` and `readCompletionReceipt(proofId, captureId, {expectedContext, trustedKey})`. These use POST and GET respectively at `/v1/proofs/:id/capture-sessions/:captureId/completion-receipt`, verify the returned envelope, and reject pending or invalid completions. POST sends an empty body and requires an idempotency key plus `evidence:write` scope; GET requires `proofs:read`. Both remain behind the future-platform pilot gate and exact tenant allowlist. Credentials stay on the host server; HTTP redirects are refused. The legacy root-manifest receipt verifier remains available unchanged.

## Destination and audience

Existing intents do **not** register third-party hosts or callback URLs. This release therefore supports authenticated host polling with a deterministic destination only:

| Field | Value |
| --- | --- |
| Audience | `packproof:capture-intent:<original intentId>` |
| Return target | `/proofs/<original proofId>` |
| Delivery | Authenticated poll of PackProof; no network callback |

The destination is derived from server-issued opaque IDs and is included in the signed payload. No external URL, arbitrary application scheme, redirect URL or client-provided completion state is accepted. The return target identifies the existing Proof inside PackProof; it is not permission to navigate a third-party host, and a host should use its own locally retained navigation state after verification. Third-party host registration and independently allowlisted return destinations remain a future extension; this receipt must not be presented as such a registration system.

## Verification and replay handling

`verifyCaptureCompletionReceipt(receipt, expectedContext, trustedKey)` returns true only when canonical payload bytes, SHA-256 and signature all verify, every expected context field matches, the destination is the fixed destination for the original intent/Proof, and the independently trusted key ID, algorithm and active status match. Both backend and SDK enforce P-256 for ECDSA or at least 2048-bit RSA for RSA-PSS. Keys are supplied through the established trusted configuration/registry, never from an untrusted receipt. Hosts remain responsible for checking that their trust-registry snapshot is current before supplying an active key.

Expected context includes actor, Proof, transaction and order digest, original intent/session, context and capsule digests, evidence/source digest, final manifest ID/digest, audience and return target. Preserve launch/bind values locally and obtain later evidence/finalization values from authenticated server responses. Do not construct the expected context by copying the receipt being verified. Root manifests and source bytes can additionally be verified through their existing integrity mechanisms.

Replaying a receipt for another actor, Proof, session, intent, destination or digest fails verification. Repeating the same valid completion for the same context is intentionally idempotent: use `receiptId` as the host's completion-action deduplication key. Receipts are durable statements of a completed operation, not expiring launch tokens, authorization to charge, or evidence of a new capture. They do not promise that the recording proves the physical item or a claim outcome.

## Persistence and coverage

Migration `062_capture_completion_receipts.sql` creates a separate immutable receipt table with one receipt per intent and session. It does not alter existing capture rows or frozen manifests. Concurrent issuance serializes on the original engine session and stored receipts survive signer outages and rotation. Issuance appends `CAPTURE_COMPLETION_RECEIPT_ISSUED` to the audit log in the same transaction, recording identifiers and digests only; retries do not create duplicate audit events. Read and replay recheck stored canonical bytes/digest and original binding consistency before returning the receipt. The receipt currently follows the primary database's backup/restore path; exporting it into the separate recovery journal is not implemented by this additive contract.

`backend/tests/capture-completion-receipt.test.ts` uses an actual fixture recording, the existing evidence commit/finalize services, and a generated test-only P-256 key. Coverage includes early completion, unavailable signer, exact persisted retries, wrong-account access, context-swapping replay, changed digests/signatures, revoked or missing trusted keys, immutable rows and constrained destinations. No production keys are created by this feature.
