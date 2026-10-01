# Experimental physical-surface evidence API

This implementation is an isolated R&D capability. No profile is qualified; the server rejects any worker result that claims consistency, difference, or a qualified physical identity. Surface work cannot change the root Proof manifest or block ordinary recording/finalization.

## Configuration

All flags default to false. Set explicit `true` only in the local R&D environment:

| Variable | Purpose |
| --- | --- |
| `PACKPROOF_SURFACE_COLLECTION` | Optional source uploads, enrollment and observation commands |
| `PACKPROOF_SURFACE_EXTRACTION` | Lease and execute extraction jobs |
| `PACKPROOF_SURFACE_INTERNAL_COMPARISON` | Request and process research comparisons |
| `PACKPROOF_SURFACE_CUSTOMER_FINDINGS` | Reserved gate; current executable always reports false |
| `PACKPROOF_SURFACE_KILL_SWITCH` | Stop all new optional collection and analysis; retained records remain readable |
| `PACKPROOF_SURFACE_PYTHON` | Absolute path to the pinned Python environment executable |
| `PACKPROOF_SURFACE_WORKER_ROOT` | Absolute path to `surface-worker/` |
| `PACKPROOF_SURFACE_TIMEOUT_MS` | Process timeout, 15000 default, 1000–60000 allowed |
| `PACKPROOF_LISTEN_HOST` | Use `127.0.0.1` for local development |

Restart the R&D processes after changing environment flags. Do not point this build at a production database or submit it to an app store. The local launcher supplies isolated database, storage and authentication settings.

## HTTP contract

Every endpoint is authenticated and scoped beneath `/proofs/:proofId/surfaces`. Reads require Proof participation or the accepted commerce recipient. All responses use `Cache-Control: private, no-store`. This feature is not exposed by public Proof links or partner API keys.

- `GET /` returns schema `surface-api/1`, capabilities, enrollments, observations and comparisons.
- `POST /media` with `Idempotency-Key` reserves an original: `{captureSessionId: string|null, contentType: "image/jpeg"|"image/png", byteSize, sha256}`. Returns `{sourceId, committed, upload:{method:"PUT",url,headers}}`.
- `PUT /media/:sourceId` sends authenticated raw original bytes to that returned URL. The server verifies the length and SHA-256, snapshots/promotes the bytes with the existing immutable object-store routines, and records an append-only source extension. A duplicate identical upload succeeds; changed bytes fail.
- `GET /media/:sourceId` downloads the authorized source and rechecks its committed hash. Expired originals return 410.
- `POST /intents` takes `{operation:"enrollment"|"observation"|"comparison", requestDigest}` and returns a five-minute, single-command intent. The digest is SHA-256 of UTF-8 JSON with recursively sorted object keys, preserving array order, **excluding** `intentId`. Body values must be finite. The intent binds actor, Proof, operation and exact command; it does not certify the camera or scene time.
- `POST /enrollments`, `/observations` or `/comparisons` take the command plus `intentId` and an `Idempotency-Key`. The same key and original command return the same record even after intent expiry. Conflicting key reuse fails.
- `GET /comparisons/:comparisonId` returns the server result and operational state.
- `GET /export` returns a coherent, authorized `surface-export/1` JSON snapshot, including exact canonical record bytes, source commitments, analysis commitments, root bytes and the surface extension chain. Originals and private templates are not embedded.

A capture command contains:

```json
{
  "schemaVersion": "surface-command/1",
  "captureSessionId": "cap_example",
  "shipmentLegId": "OUTBOUND",
  "captureMode": "offline",
  "contextStage": "unknown",
  "captureProfileId": "android-research",
  "deviceMetadata": {},
  "continuityEvents": [],
  "sources": [{"sourceId":"surface_media_example","sha256":"64 lower-case hex characters","frameTimeMs":1200}],
  "regions": []
}
```

Observation commands additionally require `enrollmentId`. Regions use `{id,sourceId,group,polygon,process,trackId}` with four original-pixel points in TL/TR/BR/BL order. Groups are `print`, `carton`, `context`. Processes are `inkjet`, `laser`, `thermal_transfer`, `direct_thermal`, `substrate`, `unknown`. Empty regions are accepted and result in unsupported/insufficient coverage unless bounded worker candidate hints are available. `deviceMetadata.regionHints` can carry native same-frame barcode geometry; these are unverified proposals, never confirmed material or parcel tracks.

`captureMode` is `live`, `offline`, or `supplemental`. `contextStage` is `before_opening`, `during_unpacking`, `after_opening`, or `unknown`. These are attributed client reports. Unavailable optical data stays null. Standalone later observations may use `captureSessionId:null`; enrollment must reference its original authorized root packing session or the return packing stage for a return baseline. Sources must be uploaded by the attributed actor. An observation cannot reuse the enrolled image's exact bytes as a later scene.

A comparison command is `{schemaVersion:"surface-command/1",enrollmentId,observationId,requestedScope:"label"|"carton"|"assembly"}`. A controlled rerun can additionally include `supersedesComparisonId`, which must reference the same two source records. It creates a new append-only comparison and analysis; earlier results remain accessible. The server derives tenant, package and shipping-leg bindings and does not accept client scores, match decisions or qualification fields.

## Evidence and worker invariants

Migration 076 adds isolated source, intent, record, leased job, analysis and extension tables. Committed sources, records, analyses and extensions reject updates/deletes at the database layer. The independent extension chain records the original manifest digest when one exists; records before root finalization explicitly contain a null root digest. A configured manifest signer signs extensions; development without a signer explicitly exports null signatures. A digest alone is not a server signature.

Source images are capped at 8 MiB each, six images and 8 MiB total per capture, 24 reservations and 32 MiB per Proof. Regions are capped at 24 and command JSON at 64 KiB. There are at most 60 fresh intents per actor/Proof/hour and 20 comparison requests per Proof. Pending reservations count toward the budget. Idempotent recovery reuses the original source reservation.

PostgreSQL leases use `FOR UPDATE SKIP LOCKED`, independent lease tokens, expiry and three bounded attempts. A stale worker cannot commit an analysis after another worker takes over. The final analysis, extension, audit and job completion commit together. Timeout, missing source, decoder error and process failure remain operational errors, never physical differences. A changed worker/profile/dependency-lock byte inventory invalidates an old job until a new controlled analysis is requested.

The adapter recomputes source digests immediately before launching Python and validates job ID, exact source list, pinned method versions, unqualified scope states and exact template/artifact canonical hashes. Python's canonical JSON strings are preserved without number reserialization. Raw descriptors, comparison scores, and templates stay private in the database; viewer results contain explicit scope, structural coverage, method and limitations.

The child process receives a minimal environment without cloud credentials, bounded time/output, a temporary directory and only required originals. The Python entrypoint also applies CPU, address-space, file-size and descriptor limits. This is a bounded development subprocess, **not** an OS security boundary: production requires the documented no-network, read-only, capability-restricted decoder container and independent security review. Native platform attestation verification and camera sensor certification are not claimed.

## Verification and remaining gates

`tests/surface-fingerprint.test.ts` covers disabled compatibility, cross-Proof/actor checks, digest and intent substitution, idempotency conflict/recovery, exact image replay, late source commitment with unchanged root bytes, database immutability, lease/crash recovery and stale delivery, worker failure versus findings, private result omission, and authenticated byte transport. The separate worker E2E test exercises real Python, original downloads and the offline export verifier using explicitly synthetic images.

Physical accuracy, optical device profiles, shipping wear, print-process qualification, and operational cost targets remain unmeasured. No synthetic test establishes those properties. R&D source retention is governed by the local experimental workspace; integration with production retention/deletion operations remains a rollout gate. Reanalysis, exports and feature disablement do not rewrite the original Proof.
