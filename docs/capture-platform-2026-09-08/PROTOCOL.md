# Capture protocol candidate v1

All endpoints require the existing authenticated participant session unless `/v1` is specified. No endpoint accepts arbitrary Proof reassignment. Supported candidate clients are Android and browser; schema identifiers alone do not certify a surface.

| Method / route | Contract |
|---|---|
| POST `/capture-intents` | `{proofId, allowedSurfaces?}` → opaque launch token, intent ID, 10-minute expiry, native/browser fragment paths. |
| POST `/v1/proofs/:id/capture-intents` | Same intent operation; tenant-bound, `evidence:write`, required stable Idempotency-Key; encrypted replay result. |
| POST `/capture-sessions/bind` | `{launchToken, capabilities}` → existing source session plus immutable CaptureContext. Redeem once. |
| POST `/capture-sessions/:id/receipts` | `{sequence,observations,segments}` → exact idempotent batch receipt; bytes remain unverified until source commitment. |
| POST `/proofs/:proofId/capture-sessions/:id/complete` | Existing original media registration before seal. |
| POST `/capture-sessions/:id/seal` | `{source,segments,observations,sha256}` → immutable, server-recomputed manifest root. Client-derived media rejected until uploaded through a trusted derivative path. |
| POST `/proofs/:proofId/evidence/uploads` | Existing source authorization; immutable session ID required. |
| POST `/proofs/:proofId/evidence/:evidenceId/commit` | Existing independent object/media validation, now also validates every declared chunk digest. |
| POST `/proofs/:proofId/attestation-challenges` | Existing native device authorization challenge includes `captureManifestSha256` and exact statement digest. |
| POST `/capture-sessions/:id/finalize` | Calls canonical Proof finalization; requires this capture’s committed source and existing attestation/preservation gates. |
| GET `/capture-sessions/:id/status` | Safe state, manifest root and declared capabilities. |
| GET `/capture-sessions/:id/receipt` | Completed receipt containing canonical signed Proof manifest; host verifies the pinned signing-key registry. |
| GET `/proofs/:id/capture-capsule` | Authorized reviewer timeline, evidence IDs, source times, requirement/capability disclosures. |

Source formats: MP4, WebM, QuickTime. Limits: 250 MB, 300 seconds; 2,048 chunks; 4,096 observations; batch maximum 128 observations / 64 segments / 128 KiB. Segments cover ordered contiguous byte ranges of one original file. A chunk is not necessarily an independently playable video segment; `timing` and `incrementalMedia` distinguish the guarantees. Do not infer native live fragment recovery from final-file chunk hashes.

Roots use SHA-256 with UTF-8 domain prefixes. Canonical JSON supports only plain JSON objects, sorted UTF-16 keys, arrays in recorded order, finite numbers and exact strings. Keys are not Unicode-normalized; undefined and nonfinite numbers are rejected. Attestation is outside the pre-attestation manifest to avoid a circular hash dependency; the final Proof signs both the capture root and its associated attestation.

Capabilities and observations are client assertions unless a separately implemented verifier says otherwise. Current app/hardware origin is never promoted to server-verified. Models are uncalibrated barcode decoders only. Server byte verification proves content integrity, not real-world correctness.

Recovery retains old schema verification. Breaking changes require a new schema ID, negotiation, frozen fixtures and migration notes. No old observation set or original is rewritten when models or policy versions change.
