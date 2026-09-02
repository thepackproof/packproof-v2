# Packing Station Mode

Packing Station is a persistent fulfillment surface. It is not a second Proof type, evidence pipeline, or integrity tier.

```text
Current target:  SCAN → PACK → SCAN
Next:            remove Start Packing when in-app record+scan is reliable
Enterprise:      JUST PACK
```

The station issues existing domain commands: `resolvePackingStation`, `createOrGetProof`, `initializeEvidenceUpload` with `evidenceType: FULFILLMENT_CAPTURE`, `commitEvidence`, `commitAttestation` (merchant attribution), `finalizeProof`, `getProof`.

Finish-scan resolution uses `resolvePackingStation` only. It must not call `createOrGetProof`.

## Canonical PackProof requirement

A new merchant PackProof (`COUNTERPARTY_OPTIONAL`) cannot finalize without qualifying physical fulfillment evidence. Attestation alone is insufficient.

```text
TRANSACTION CONTEXT
+ QUALIFYING PHYSICAL FULFILLMENT EVIDENCE
+ REQUIRED ATTRIBUTION / ATTESTATION
+ OTHER APPLICABLE FINALIZATION CONDITIONS
========================================
FINALIZABLE PACKPROOF
```

`evaluateFinalizeRequirements` in the backend is the single eligibility predicate. Clients must not treat UI state as authorization. Missing capture returns `FULFILLMENT_CAPTURE_REQUIRED`: “Packing evidence is required before this Proof can be finalized.”

Already-finalized Proofs stay finalized. The new rule applies to new finalization attempts only. Historical merchant Proofs without capture are not rewritten.

P2P (`COUNTERPARTY_REQUIRED`) still requires a joined buyer and any committed evidence. That path is unchanged and is no longer the ordinary create default; it must be requested explicitly.

## Evidence semantics

| Concept | Meaning |
| --- | --- |
| Transaction metadata | What was expected (order, items, shipping). |
| Scan / reference | Which transaction or package is being processed. **Not** packing evidence. Initial scan identifies. Finish scan binds completion. Neither is `FULFILLMENT_CAPTURE`. |
| Fulfillment capture (`FULFILLMENT_CAPTURE`) | What physically happened while packing. Qualifies merchant finalization. |
| Generic seller evidence (`SELLER_EVIDENCE`) | Other committed media. Does not satisfy the merchant capture requirement. |
| Attestation | What the participant asserts (`PACKED_DESCRIBED_ITEM`). Attribution, not a substitute for capture. |
| Cryptographic commit | Integrity of recorded evidence (SHA-256, append-only). |
| Carrier timeline | What happened after handoff. |

Continuous packing video is the current qualifying implementation of fulfillment capture. The domain predicate checks evidence purpose (`FULFILLMENT_CAPTURE`), not MIME type, filename, client route, or `hasVideo`. Future authenticated sources (fixed station camera, warehouse camera, machinery, scanner/weight/camera systems) can satisfy the same physical-fulfillment condition by using an allowed capture type. There are no Gold / Silver / Bronze Proofs.

`evidence_type` is constrained in the database to `SELLER_EVIDENCE` | `FULFILLMENT_CAPTURE`. Unknown client values are rejected (`INVALID_EVIDENCE_TYPE`). Purpose is already part of the canonical Proof and final manifest.

## Product rule

Do not reduce friction by deleting evidence. Reduce friction by automating the creation of evidence.

A transaction record tells you what was bought. A shipping record tells you where the package went. PackProof records what was actually packed.

PackProof still records facts, attestations, and external metadata. It does not declare that a seller is truthful or that an item is authentic.

## Resolve and same-transaction finish

`POST /me/packing-station/resolve` is a seller-scoped read. It matches an authorized transaction by:

- proof id
- transaction id
- commerce order id / reference
- integration external id
- transaction `externalReference`
- tracking number

The client extracts a barcode or typed value. The server resolves it. Matching is exact after conservative normalization (trim, strip control characters, leading `#`, known AIM symbology prefix `]X0`). No fuzzy matching. Ambiguity remains `409 STATION_REFERENCE_AMBIGUOUS`. Unauthorized or unknown references return `404 STATION_REFERENCE_NOT_FOUND` with no cross-seller leakage.

A finish scan must resolve through that same endpoint, then compare canonical `transactionId` (and `proofId` when both sides have one). Do not compare raw barcode strings, order display labels, or tracking suffixes. A different barcode that resolves to the active transaction is a valid completion trigger. A barcode that resolves to any other transaction must not stop recording, must not change the active Proof, and must not start another Proof.

Client copy for that case: “Different order scanned. Finish packing the current order first.”

## Client state machine

Station UI phases are not Proof states. Capture, upload, and retry remain local until the server commits evidence.

```text
READY → SCANNING → IDENTIFYING → READY TO PACK → RECORDING
  → FINISH_SCANNING → VERIFYING_FINISH_SCAN
  → PROCESSING → PROOF CREATED → READY
```

Same transaction + held capture → `PROCESSING` (`stopTrigger: RESCAN`).
Same transaction + live webcam still recording → stay `RECORDING` with `stopTrigger: RESCAN`, then stop the recorder and `CAPTURE_READY`.
Different / unknown / cancelled / failed finish scan → `RECORDING` with order and capture intact.

Seams:

- identify: `SCAN`, `REFERENCE`, `QUEUE_SELECT`, `DEEP_LINK`, `API_EVENT`
- start: `AUTO`, `SCAN`, `SENSOR` (start remains `MANUAL` after READY TO PACK)
- stop: `RESCAN` (preferred), `MANUAL` (Finished Packing fallback)

`FULFILLMENT_CAPTURE_STARTED` / extra client audit events are not added. The committed evidence row and existing `EVIDENCE_COMMITTED` audit event remain canonical.

### Auto-start recording

Not implemented. Mobile packing video uses the native camera (`expo-image-picker`). Barcode scanning uses `expo-camera`. Those cannot share the camera reliably. Auto-starting record immediately after identify would fight that handoff. Keep READY TO PACK → Start Packing until an in-app recorder can own the camera for both video and a later finish scan.

## Mobile camera handoff

Expo/Android does not run barcode `CameraView` and native packing video at the same time on one camera.

Sequence actually used:

1. Identify scan with `expo-camera`.
2. Start Packing opens the native camera; that session **is** the fulfillment video. Stopping the native camera is the declared end of capture.
3. The file is persisted (`CAPTURE_HELD` / durable local capture).
4. Finish scan re-opens `expo-camera` against the free camera.
5. Server resolve + same-transaction check binds that completed capture. The finish scan is not inserted into the video timeline.

If scan-from-recording-preview or a hardware wedge later exists, finish scan could occur without ending video first. Until then, evidence continuity beats simultaneous scan+record.

Failed finish scans must not discard the durable file. Retry finish scan or use Finished Packing.

App kill with a durable file restores `RECOVERY` (retry upload). Finish-scan UX is live-session only.

## Web scanner

Web uses the keyboard / USB-wedge adapter (`detectWebScanAdapter`, currently `KEYBOARD`). Browser `BarcodeDetector` is not enabled.

Webcam `MediaRecorder` can keep running while the seller scans. A matching finish resolve stops the recorder, then the existing submit path runs. A mismatch leaves the recorder running.

## `/fulfillment` alignment

The existing fulfillment page remains. If a merchant order has no qualifying capture, it states that packing evidence is required and links into Packing Station (`/station?reference=…`). Attestation remains available as attribution. Complete is enabled only when the server `canComplete` flag is true (capture + attestation + no pending evidence).

## Failure

Upload, network, and auth failures keep the local video. Camera permission denial, unreadable barcodes, unmatched, ambiguous, or wrong-package finish scans, and finalized Proofs return the station to a usable retry state without dropping recorded video. Finalized Proofs reject mutation. Manual Finished Packing remains a secondary fallback.

## Physical device validation

Required on hardware before calling scan-to-stop done. Not marked passed in this milestone.

Target first: Samsung Galaxy S24 Ultra. Optionally Galaxy A16.

- **A** — initial scan: supported label, debounce, unknown/wrong recovery
- **B** — capture: continuous packing video, durable local file, usable UI
- **C** — valid rescan: same canonical transaction, one `FULFILLMENT_CAPTURE` submit, attest, finalize, READY
- **D** — wrong rescan: order A retained, order B does not start
- **E** — network down during finish resolve or upload: capture kept, retry works
- **F** — auth expired after recording: local video kept, sign-in recovery
- **G** — second package after READY: order A unchanged
