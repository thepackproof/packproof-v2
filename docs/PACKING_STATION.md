# Packing Station Mode

Packing Station is a persistent fulfillment surface. It is not a second Proof type, evidence pipeline, or integrity tier.

```text
Current target:  SCAN → READY TO PACK → RECORD → DONE
Future target:   SCAN → PACK → SCAN
Enterprise:      JUST PACK
```

The station issues existing domain commands: `resolvePackingStation`, `createOrGetProof`, `initializeEvidenceUpload` with `evidenceType: FULFILLMENT_CAPTURE`, `commitEvidence`, `commitAttestation` (merchant attribution), `finalizeProof`, `getProof`.

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

P2P (`COUNTERPARTY_REQUIRED`) still requires a joined buyer and any committed evidence. That path is unchanged.

## Evidence semantics

| Concept | Meaning |
| --- | --- |
| Transaction metadata | What was expected (order, items, shipping). |
| Scan / reference | Which transaction or package is being processed. **Not** packing evidence. |
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

## Resolve and scan-to-identify

`POST /me/packing-station/resolve` is a seller-scoped read. It matches an authorized transaction by:

- proof id
- transaction id
- commerce order id / reference
- integration external id
- transaction `externalReference`
- tracking number

The client extracts a barcode or typed value. The server resolves it. Matching is exact after conservative normalization (trim, strip control characters, leading `#`, known AIM symbology prefix `]X0`). No fuzzy matching. Ambiguity remains `409 STATION_REFERENCE_AMBIGUOUS`. Unauthorized or unknown references return `404 STATION_REFERENCE_NOT_FOUND` with no cross-seller leakage.

Scan identifies the order. It does not begin recording in this milestone and never satisfies fulfillment capture.

## Client state machine

Station UI phases are not Proof states. Capture, upload, and retry remain local until the server commits evidence.

```text
READY → SCANNING → IDENTIFYING → READY TO PACK → RECORDING → PROCESSING → PROOF CREATED → READY
```

Seams for later triggers:

- identify: `SCAN`, `REFERENCE`, `QUEUE_SELECT`, `DEEP_LINK`, `API_EVENT`
- start: `AUTO`, `SCAN`, `SENSOR` (V1 start is `MANUAL` after READY TO PACK)
- stop: `RESCAN`, `LABEL`, `SEAL`, `WEIGHT`, `SCANNER`, `API_EVENT` (not fully implemented). A future scan-to-stop must confirm the barcode matches the transaction currently being packed.

Mobile uses `expo-camera` for live barcode scanning, then the existing packing-video capture path. Web uses a keyboard / USB-wedge scan field (`detectWebScanAdapter`, currently `KEYBOARD`). Browser `BarcodeDetector` camera scanning is not enabled in this milestone.

Manual reference entry and imported-order selection remain fallbacks, not equal primary workflows.

## `/fulfillment` alignment

The existing fulfillment page remains. If a merchant order has no qualifying capture, it states that packing evidence is required and links into Packing Station (`/station?reference=…`). Attestation remains available as attribution. Complete is enabled only when the server `canComplete` flag is true (capture + attestation + no pending evidence).

## Failure

Upload, network, and auth failures keep the local video. Camera permission denial, unreadable barcodes, unmatched or ambiguous references, and finalized Proofs return the station to a usable READY/retry state without dropping recorded video. Finalized Proofs reject mutation.
