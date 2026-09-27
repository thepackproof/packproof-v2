# Desktop capture acceptance contract

Desktop may record while disconnected. A local file is **secured locally**, not
uploaded, committed, server-authorized at recording time, or independently timed.
The server accepts a completed desktop recording through a separate provenance
contract; the desktop must never synthesize a `WEB_CAMERA` or `NATIVE_CAMERA`
start session after the recording took place.

## Capability gate

Before synchronizing, require `GET /capabilities` to advertise
`desktopCapture.registrationVersions` containing `1`, `client: DESKTOP_CAMERA`,
and `timingProvenance: CLIENT_REPORTED_NOT_INDEPENDENTLY_VERIFIED`.
An older or incompatible backend leaves the local original intact and the job
paused with an API update requirement. A cached capability can inform offline
capture limits but does not guarantee later acceptance or available allowance.

Current global recording limits remain 250,000,000 bytes and 300 seconds. The
account's approved allowance may be lower. Capturing offline does not reserve
allowance or guarantee permission when the device reconnects.

## Registration

`POST /proofs/:id/capture-sessions/desktop-registration`

Authenticate the originating PackProof account and provide a stable
`Idempotency-Key`. Body:

```json
{
  "sha256": "64 lowercase hexadecimal characters",
  "byteSize": 123456,
  "contentType": "video/webm",
  "recordedDurationMs": 120000,
  "interrupted": false,
  "desktopContext": {
    "schemaVersion": 1,
    "installationId": "opaque installation identifier",
    "appVersion": "1.0.0",
    "platform": "win32",
    "captureStartedAt": "2026-09-27T10:00:00.000Z",
    "captureEndedAt": "2026-09-27T10:02:00.000Z",
    "cameraLabel": "USB Camera",
    "offline": true
  }
}
```

`platform` is `win32` or `darwin`; `cameraLabel` is optional. MP4, WebM and
QuickTime containers follow existing capture validation. All times, device
identity, camera selection and offline state are participant-supplied assertions.

The server transaction verifies the seller, writable canonical Proof, supported
parcel and intake context; reserves normal account allowance; pins current
order context; persists immutable desktop context and original file digest; and
registers the session. Any failure rolls back its new session and reservation.
It does not create a Proof, change an external transaction mapping, or override
a finalized Proof. Version 1 supports seller packing, not commerce return stages.

Response: the standard capture session view in `RECORDED` state, with
`client: DESKTOP_CAMERA`, policy `packproof.desktop-client-capture/v1`, and
`registrationTiming: POST_CAPTURE_CLIENT_REPORTED`. Its `recordedAt` is the
server registration timestamp, not the claimed physical recording start.
`clientReportedCapture.desktopContext` retains the original client report.

Retry exactly the same account, Proof, key, original bytes and desktop context.
Persist the returned session ID before authorizing transport. Existing recovery
endpoints reconcile subsequent session/evidence state. The seven-day transport
recovery window begins at server registration; it is not a capture timestamp
attestation.

## Existing evidence pipeline

Use the existing fulfillment evidence initialization, resumable transport,
server media/hash verification and commitment contracts. Original bytes must
match the registered size/digest. Send barcode observations through the existing
shipping-label workflow; server mismatch review and offset validation still
apply. An observed conflicting label cannot silently replace tracking identity.

Obtain explicit seller confirmation before committing the existing
`PACKED_DESCRIBED_ITEM` attestation. Desktop uses authenticated account
confirmation and must not submit or display a fabricated biometric claim.
Finalization still enforces committed fulfillment evidence, the attestation,
shipping review, identifier barriers, current intake context, and configured
durable receipt requirements.

Canonical evidence and the frozen manifest use
`origin: CLIENT_REPORTED_DESKTOP_CAPTURE`. The manifest records the server
registration timestamp separately from client-reported capture dates. Physical
camera origin and timing are not independently verified. Existing web/native
capture semantics and historical frozen manifests remain unchanged.

## Rollout

Apply additive migration `074_desktop_capture_registration` using the normal
reviewed migration path, then release this backend and verify capabilities before
enabling desktop synchronization. Check the deployed migration inventory and
checksums against the exact candidate first. Do not modify earlier migrations,
silently adopt checksums, or invoke the older mobile-intake migration runner:
that runner explicitly permits only migrations 067 and 068.

Runtime `PACKPROOF_MIGRATE_ON_START=false` requires migration before API startup;
startup otherwise rejects a missing migration. Preserve existing runtime
configuration, integrations and durability policy during deployment. This file
documents the candidate contract; it does not certify deployment or hardware
acceptance.
