# Direct capture and Packing Relay

The September 2026 primary packing policy uses one standard for both optional and required counterparty commerce Proofs. A generic attachment cannot substitute for `FULFILLMENT_CAPTURE`. Finalization also requires the seller's packing attestation. Buyer participation rules remain unchanged.

## Capture contract

Authenticated seller routes:

- `POST /proofs/:id/capture-sessions` with `client: WEB_CAMERA | NATIVE_CAMERA` and `idempotencyKey` immediately before recording. The returned session is bound to the actor, Proof, packing workflow, and `packproof.direct-capture/v1` policy. Its `expiresAt` bounds the authorized start to 30 minutes. Clients must not start recording after it.
- Persist the recording and session ID in the app-owned local queue before networking. Camera errors must never open a gallery picker. A recording made without preauthorization cannot obtain a session retroactively through the supported client.
- `POST /proofs/:id/capture-sessions/:sessionId/complete` with `sha256`, `byteSize`, and `contentType` registers the recording. Supported containers are MP4, WebM, and QuickTime; maximum size is 200 MiB. Its digest, size, type, participant, and Proof cannot subsequently change. `recordedAt` is server registration time, not an independently attested camera timestamp.
- The preauthorized acquisition may finish/register after a network or authentication interruption, up to the seven-day `recoverUntil` deadline. Delayed registration is explicitly audited; offline timing is not independently attested. This does not create a session after capture or authorize a new recording on an expired start lease.
- `POST .../:sessionId/recover` re-reads the same registered recording and upload binding. Renew authentication as the same account first. It does not extend deadlines or replace footage. An expired original remains in the local queue for explicit handling; no silent eligibility upgrade occurs.
- Initialize the existing `/proofs/:id/evidence/uploads` route with `captureSessionId` and `evidenceType: FULFILLMENT_CAPTURE`. The same session can bind exactly one upload. Retry uses its original idempotency key. Resumable parts and normal staging uploads remain transports for those original bytes.
- Commit computes SHA-256 from the stored original independently, compares byte size and digest to the registered recording, validates its actual media container/video packets with `ffprobe`, promotes immutable bytes, and then records commitment. Unsupported/truncated media stays pending with a recovery error. Source duration is exposed as `capturedDurationMs` when available from the container; missing duration is not fabricated.
- `POST .../:sessionId/cancel` rejects an unfinished upload and closes that session. It cannot discard committed evidence.

The same capture commands exist below `/v1/proofs/:id/capture-sessions` with API tenant ownership, `evidence:write`, and the public API idempotency boundary. API keys cannot impersonate a different Proof participant by supplying an actor ID.

A session verifies authorization and workflow eligibility. It does not independently attest physical camera origin or prevent a compromised client from injecting media. User interfaces and public copy must retain that distinction.

## Historical records

Migration 028 adds `capture_origin` to the evidence projection: existing rows are explicitly `LEGACY_UNKNOWN`; new supporting attachments are `UPLOADED_ATTACHMENT`; eligible camera sessions are `AUTHORIZED_CAPTURE_SESSION`. It never rewrites old sealed manifests, originals, hashes, or committed evidence. Existing committed fulfillment evidence retains historical eligibility. Pending historical uploads cannot be relabeled as new direct capture and must be discarded or preserved for explicit handling before a new recording.

## Single station relay

`POST /me/packing-relay` creates an eight-hour device lease, a controller capability, and a five-minute pairing secret. A signed-in camera on the same account redeems it at `/:stationId/pair`; only one camera can pair. The returned camera capability and controller capability have different command permissions. Capabilities are sent in `X-PackProof-Station-Token`, never query parameters. Only hashes are stored server-side.

Read `GET /:stationId` to resume current state and unacknowledged commands. Both devices see the same selected `proofId`, pending capture binding, and queue position. Resolve an order with the existing packing-station resolver first; a barcode remains lookup input, not evidence of contents.

Controller `POST /:stationId/commands` accepts `sequence`, `idempotencyKey`, and `type: SELECT_ORDER | START | FINISH | NEXT`; selection and next require `proofId`. Exact retries are replayed. Changed commands, gaps, and a next command before camera acknowledgement fail. Camera `POST /:stationId/ack` acknowledges the next command only. START acknowledgement binds a same-actor, same-root-Proof packing session issued at or after that START command. An unexpired ISSUED session produces RECORDING. If the camera restarted after persisting its recording but before acknowledgement, a recoverable RECORDED/UPLOADING session produces SAVING and a COMMITTED session produces SAVED; it never claims resumed physical recording. The unique historical START binding remains after NEXT and cannot be claimed by another station. FINISH acknowledgement requires durable registration. NEXT cannot replace the current order until the original capture is committed. In-progress and saving states survive both device disconnects because PostgreSQL holds the command log and binding; local originals remain on the camera.

`POST /:stationId/renew` renews a still-valid lease without changing pairing or current order. Expired station leases do not erase capture sessions. Recovery of an expired station's original recording uses its original capture recovery contract; it must not be assigned to a new order.

Keyboard scanner and ordinary button controls should issue the same explicit commands. No ambient recording, automatic start from incidental scans, multi-station custody guarantee, or unsupported hardware assurance is implied. The remaining release evidence is a real 20-order paired-device pilot including camera/controller disconnects and restart. Automated tests cover 100 repeated and out-of-order sequences, wrong actors/orders, missing sessions, digest conflicts, malformed media, durable recovery and unchanged final hashes.

## Receipt and return captures

The same `POST /proofs/:id/capture-sessions` accepts an optional `stageId`. The server derives the workflow step from that existing stage and validates its actor: the buyer owns receipt and return packing; the seller owns return receipt. The root must be sealed and the selected stage must still be writable. It never routes buyer receipt into the seller's primary capture permission.

Complete, recover and cancel use the session's stored stage. Lifecycle video initialization requires that same `captureSessionId`; commitment verifies source bytes and codec under the same policy. Supporting images remain separately labeled attachments and cannot replace the required recording in a new stage. Existing committed historical stage evidence retains unknown legacy origin; previously sealed stage manifests are returned unchanged. Receipt and return session metadata is included only when making a new stage manifest.

Sessions expose `registrationTiming`; evidence projections expose `captureRegistrationTiming`. `DELAYED_NOT_INDEPENDENTLY_ATTESTED` identifies a recording registered after the initial start window. `WITHIN_START_WINDOW` identifies when registration reached the server; it is not proof of physical recording time. Reviewers must not infer continuous custody or independently attested camera timing from either label.

## Reported recording interruptions

Capture completion accepts optional `interrupted: boolean` and `recordedDurationMs: integer` (0–1,800,000). These values are explicitly client-reported acquisition context. They do not establish trusted capture time, continuous recording, or media duration. Server-probed `capturedDurationMs` stays a separate field.

Migration 031 stores append-only client reports. A later false or omitted interruption field cannot erase a previous true. A duration cannot change once provided. Reports are attributed to the authenticated capture actor, with an audit event; updates and deletion are rejected. Session recovery, canonical evidence, signature source snapshots and newly sealed root/stage manifests expose `clientReportedCapture` with `CLIENT_REPORTED_NOT_INDEPENDENTLY_VERIFIED` provenance. No report means unknown; false means the client reported no interruption, not independent verification of continuity. Historical sealed manifests remain unchanged.
