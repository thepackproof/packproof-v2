# PackProof — In-Video Shipping Label Scan & Automatic Carrier Binding

## Development Plan for Astra

### Objective

Implement a unified Android packing-capture experience in which PackProof can detect and decode a shipping label barcode while the fulfillment video is actively recording, automatically bind the discovered tracking number and carrier to the active transaction/Proof, establish carrier tracking in the backend, and continue recording without interrupting evidence continuity.

The finished experience should allow a seller to:

1. Start recording the PackProof packing video.
2. Pack the item normally.
3. Present or apply the shipping label while recording.
4. Have PackProof automatically detect the label barcode.
5. Extract and validate the tracking number.
6. Identify the carrier.
7. Bind the tracking information to the active transaction and Proof.
8. Begin carrier tracking automatically.
9. Continue recording without camera interruption.
10. Finish packing and finalize the Proof normally.

The seller should not need to leave the recording interface, manually type a tracking number, or initiate tracking separately.

---

# 1. Current State

PackProof already contains several required building blocks.

## Existing mobile barcode scanning

The Android client already supports barcode scanning using `expo-camera`.

Relevant implementation:

- `mobile/src/screens/BarcodeScanView.tsx`
- `mobile/src/packing-station/scan.ts`

Supported formats currently include:

- QR
- PDF417
- Aztec
- EAN-13
- EAN-8
- UPC-A
- UPC-E
- Code 39
- Code 93
- Code 128
- Codabar
- ITF-14
- Data Matrix

The existing scanner normalizes barcode input and can resolve PackProof references, order references, transaction IDs, and tracking numbers.

## Existing Packing Station workflow

Current mobile workflow:

`SCAN → IDENTIFY ORDER → START PACKING → RECORD → STOP RECORDING → FINISH SCAN → SUBMIT`

The current implementation intentionally separates video capture from barcode scanning because the native recording implementation and `expo-camera` barcode scanner cannot reliably share camera ownership.

Relevant files include:

- `mobile/src/screens/PackingStationScreen.tsx`
- `mobile/src/packing-station/machine.ts`
- `mobile/src/packing-station/submit.ts`
- `mobile/src/capture.ts`

## Existing shipment infrastructure

PackProof already supports shipment metadata and append-only shipment events.

Relevant backend areas include:

- `backend/src/domain/shipment-events.ts`
- `backend/src/domain/shipment-integrity.ts`
- `backend/src/domain/trusted-shipment-sync.ts`
- `backend/src/integrations/shipment-adapter.ts`
- `backend/src/integrations/easypost/*`

PackProof also already supports EasyPost tracking in test/staging mode.

Existing shipment events include concepts such as:

- `LABEL_CREATED`
- `IN_TRANSIT`
- `ARRIVED_AT_FACILITY`
- `OUT_FOR_DELIVERY`
- `DELIVERED`
- `DELIVERY_EXCEPTION`
- `RETURN_TO_SENDER`
- `WEIGHT_RECORDED`

These must be reused rather than duplicated.

---

# 2. Core Product Requirement

Replace the current two-camera-session Android flow with a unified recording surface capable of:

- recording video continuously;
- decoding shipping-label barcodes from the live camera preview;
- continuing video capture during barcode recognition;
- binding decoded shipping information to the active Proof;
- showing immediate UI confirmation;
- preserving the barcode event as part of Proof chronology/provenance.

Target experience:

```text
START PACKING
     ↓
VIDEO RECORDING
     ↓
ITEM PACKED
     ↓
LABEL ENTERS FRAME
     ↓
BARCODE DETECTED
     ↓
TRACKING NUMBER EXTRACTED
     ↓
CARRIER IDENTIFIED
     ↓
TRACKING BOUND TO ACTIVE TRANSACTION
     ↓
CARRIER TRACKING INITIALIZED
     ↓
✓ SHIPPING LABEL VERIFIED / ATTACHED
     ↓
VIDEO CONTINUES
     ↓
BOX SEALED
     ↓
FINISH PACKING
     ↓
UPLOAD / COMMIT / FINALIZE

```

Important terminology:

Do not claim PackProof independently verifies the carrier, package contents, or authenticity.

Preferred language:

- “Shipping label detected”
- “Tracking attached to Proof”
- “Carrier identified”
- “Tracking registered”
- “Carrier observation received”

Avoid:

- “Verified shipment”
- “Verified delivery”
- “Verified UPS label”

unless the specific underlying fact is independently supported.

---

# 3. Critical Architectural Requirement

## Single camera ownership

The primary implementation requirement is to replace the current native video capture handoff with an in-app camera recorder that owns the camera for the complete packing session.

Do not attempt to run:

- native system video recording; and
- a separate `CameraView`

simultaneously.

Instead, create one camera pipeline that provides:

1. live preview;
2. video recording;
3. barcode frame analysis;
4. recording controls;
5. torch control if supported;
6. autofocus behavior;
7. zoom if appropriate;
8. barcode-detection callbacks.

Preferred architecture:

```text
Camera Session
   ├── Preview
   ├── Video Encoder
   └── Barcode Analyzer

```

The barcode analyzer must observe preview frames without interrupting the video encoder.

---

# 4. Technology Evaluation

Astra should first evaluate the most appropriate React Native / Expo-compatible camera stack.

Candidates may include:

- Expo Camera, if the installed/current SDK supports simultaneous video recording and barcode scanning reliably on Android;
- React Native Vision Camera;
- ML Kit Barcode Scanning;
- CameraX-backed native implementation;
- another production-grade equivalent.

Selection criteria:

- simultaneous recording + barcode recognition;
- Android reliability;
- Samsung Galaxy S24 Ultra compatibility;
- Galaxy A16 compatibility;
- Expo/EAS build compatibility;
- no requirement for unsafe native hacks;
- maintained library;
- acceptable bundle impact;
- camera lifecycle stability;
- pause/resume behavior;
- app background behavior;
- permission handling;
- hardware back-navigation safety.

Do not select a library solely because it makes barcode scanning easy. Video continuity is the higher-priority invariant.

---

# 5. New Unified Capture Component

Create a reusable component, conceptually:

`UnifiedPackingCapture`

Possible location:

`mobile/src/capture/UnifiedPackingCapture.tsx`

Responsibilities:

- acquire camera permission;
- acquire microphone permission;
- initialize rear camera;
- display preview;
- begin/stop video recording;
- analyze live frames for supported barcodes;
- debounce repeated barcode reads;
- expose detected barcode events;
- display detection overlays;
- preserve capture even if backend requests fail;
- safely release camera resources on exit.

Suggested component contract:

```ts
type DetectedBarcode = {
  rawValue: string;
  normalizedValue: string;
  format: string;
  detectedAtMs: number;
};

type UnifiedPackingCaptureProps = {
  proofId: string;
  transactionId: string;
  onBarcodeDetected: (barcode: DetectedBarcode) => void;
  onCaptureComplete: (capture: LocalCapture) => void;
  onCaptureFailure: (error: CaptureError) => void;
};

```

Do not embed transaction mutation logic directly into the camera component.

Camera detection and domain mutation must remain separate concerns.

---

# 6. Tracking Number Extraction

Add a dedicated tracking parser layer.

Suggested location:

`mobile/src/shipping/tracking-parser.ts`

and/or server-side equivalent.

Input:

```text
raw barcode

```

Output:

```ts
type ParsedShippingBarcode = {
  trackingNumber: string;
  carrierHint?: string;
  barcodeFormat: string;
  confidence: "EXACT_PATTERN" | "GENERIC";
};

```

Support common carrier formats where safely possible:

- UPS
- USPS
- FedEx
- DHL
- other carriers represented through EasyPost

Do not rely exclusively on visual carrier branding.

The parser should prefer structural recognition of the tracking number itself.

Examples:

- UPS `1Z...`
- USPS numeric tracking formats
- FedEx numeric formats

Carrier inference must be treated as a hint until confirmed by backend/carrier infrastructure.

---

# 7. Server-Side Shipping Binding Endpoint

Add a server-authoritative endpoint for binding a newly scanned tracking number to the active transaction.

Suggested route:

```http
POST /transactions/:transactionId/shipping-label-scan

```

Example body:

```json
{
  "proofId": "proof_...",
  "trackingNumber": "1Z...",
  "carrierHint": "UPS",
  "barcodeFormat": "code128",
  "captureSessionId": "capture_...",
  "detectedAtMs": 48231,
  "idempotencyKey": "..."
}

```

Responsibilities:

1. authenticate seller;
2. verify seller owns/participates in transaction;
3. verify Proof belongs to transaction;
4. verify Proof is mutable;
5. normalize tracking number;
6. validate against any existing tracking number;
7. prevent conflicting replacement;
8. append shipping-label observation;
9. bind tracking to transaction if previously absent;
10. establish trusted shipment tracking when configured;
11. return canonical shipping state.

Potential response:

```json
{
  "transactionId": "...",
  "proofId": "...",
  "trackingNumber": "...",
  "carrier": "UPS",
  "trackingStatus": "REGISTERED",
  "shipmentTrackingEnabled": true
}

```

---

# 8. Immutable / Conflict Rules

This feature must never silently overwrite shipping identity.

Required behavior:

## No existing tracking

If transaction has no tracking number:

```text
SCAN
→ validate
→ bind
→ persist

```

## Same tracking already present

If tracking number matches existing canonical tracking:

```text
SCAN
→ idempotent success

```

## Different tracking already present

If transaction already contains another tracking number:

```text
SCAN
→ reject automatic replacement
→ keep existing canonical tracking
→ notify user

```

Suggested error:

`TRACKING_CONFLICT`

Suggested user copy:

“Another tracking number is already attached to this Proof.”

Do not silently replace tracking identity after capture begins.

---

# 9. Barcode Event Provenance

The barcode detection should become part of Proof provenance.

Record at minimum:

- normalized barcode value;
- tracking number;
- barcode format;
- capture session ID;
- relative video timestamp;
- client platform;
- detection timestamp;
- resulting carrier;
- whether tracking was newly attached or already present.

Do not store unnecessary raw image frames unless explicitly justified.

Suggested event concept:

`SHIPPING_LABEL_DETECTED`

This may be an audit/provenance observation rather than a new mutable Proof state.

Possible event record:

```json
{
  "type": "SHIPPING_LABEL_DETECTED",
  "captureSessionId": "capture_...",
  "relativeTimestampMs": 48231,
  "trackingNumber": "1Z...",
  "barcodeFormat": "code128",
  "carrier": "UPS"
}

```

The video itself remains the primary physical evidence.

The barcode event provides structured correlation to the video.

---

# 10. Video Timestamp Correlation

One of the highest-value parts of this feature is tying the shipping identifier to a precise moment in the fulfillment video.

Store:

`detectedAtMs`

relative to recording start.

Then expose that timestamp in Proof review.

Example:

```text
Packing video — 01:42

01:08  Item placed in box
01:21  Shipping label detected
01:34  Box sealed

```

Future UI should support:

“Jump to label scan”

which seeks directly to the corresponding timestamp.

This should be treated as an important evidence usability feature.

---

# 11. Automatic Carrier Tracking Registration

After tracking is successfully bound:

```text
trackingNumber
      ↓
carrier hint
      ↓
trusted shipment adapter
      ↓
EasyPost tracker registration
      ↓
provider cursor stored
      ↓
webhook / sync
      ↓
append shipment observations

```

Where configured, the seller should not need to click a separate “Track shipment” button.

Initialization should be fire-and-confirm, but failure must not invalidate the packing video or Proof.

Example states:

- `TRACKING_REGISTERED`
- `TRACKING_PENDING`
- `TRACKING_UNAVAILABLE`

Carrier API failure should not stop recording.

---

# 12. EasyPost Integration Changes

Existing EasyPost functionality should be reused.

Add a backend orchestration method conceptually equivalent to:

```ts
ensureShipmentTrackingForTransaction(transactionId)

```

Behavior:

1. load canonical tracking number;
2. check for existing shipment integration;
3. create/reuse tracker;
4. persist provider cursor;
5. import initial carrier observations;
6. remain idempotent.

Do not expose EasyPost credentials to mobile.

All EasyPost communication remains server-side.

---

# 13. Production Carrier Enablement

Current EasyPost implementation is staging/test capable.

Astra should separate implementation from production enablement.

Implementation should work against test mode first.

Production rollout requires:

- production EasyPost credentials;
- production secret namespace;
- webhook endpoint;
- webhook HMAC secret;
- production-mode configuration;
- IAM review;
- rate-limit handling;
- monitoring;
- logging;
- carrier-event smoke tests.

Do not commit credentials to Git.

Use AWS Secrets Manager.

---

# 14. In-Recording UX

During recording, the UI should remain minimal.

Default recording view:

```text
┌───────────────────────────────┐
│ ● REC                    01:32│
│                               │
│          CAMERA               │
│                               │
│                               │
│                               │
│                               │
│     Packing evidence active   │
│                               │
│          [ Finish ]           │
└───────────────────────────────┘

```

When barcode is detected:

```text
┌───────────────────────────────┐
│ ● REC                    01:33│
│                               │
│          CAMERA               │
│                               │
│     ✓ SHIPPING LABEL          │
│       UPS                     │
│       •••• 4821               │
│       Tracking attached       │
│                               │
│          [ Finish ]           │
└───────────────────────────────┘

```

Confirmation should:

- animate in;
- remain visible briefly;
- collapse to a small persistent status badge.

Example persistent badge:

`✓ Label attached`

Haptic feedback should occur once per accepted shipping label.

Do not repeatedly vibrate as the barcode remains in frame.

---

# 15. Barcode Debouncing

Implement aggressive duplicate suppression.

Suggested rules:

- ignore identical barcode for 3–5 seconds after first detection;
- once a tracking number is successfully bound, ignore repeated reads of the same tracking number for the rest of the capture;
- allow other barcodes to continue being analyzed;
- do not immediately bind an unrelated barcode.

This prevents continuous camera-frame callbacks from spamming the backend.

---

# 16. Multiple Barcodes on Shipping Labels

Shipping labels often contain multiple barcodes.

The scanner must not assume the first barcode is the tracking number.

Pipeline:

```text
barcode detected
      ↓
normalize
      ↓
tracking parser
      ↓
recognized shipping candidate?
      ├── no → ignore
      └── yes → backend validation

```

Do not bind:

- postal service routing barcodes;
- internal package IDs;
- facility barcodes;
- QR codes unrelated to tracking;
- order barcodes unless explicitly supported.

---

# 17. Backend Carrier Confirmation

Where possible, allow carrier infrastructure to refine the mobile carrier hint.

Example:

```text
mobile guess: UPS
EasyPost response: UPS
→ canonical carrier = UPS

```

Or:

```text
mobile guess: unknown
EasyPost response: USPS
→ canonical carrier = USPS

```

The trusted provider response should outrank client inference.

---

# 18. Failure Handling

The recording must be isolated from backend failures.

Examples:

## Network unavailable during label scan

- keep recording;
- retain barcode candidate locally;
- show `Tracking pending`;
- retry when connectivity returns.

## Authentication expires

- keep local video;
- retain detected shipping metadata;
- recover after login;
- do not discard capture.

## Carrier API unavailable

- bind tracking locally/server-side if valid;
- mark carrier tracking as pending;
- retry later.

## Unknown tracking format

- continue recording;
- optionally show:

“Barcode detected, but tracking could not be identified.”

Do not terminate capture.

---

# 19. Offline Queue

Extend local capture persistence to include pending shipping-label detections.

Suggested structure:

```ts
type PendingShippingBinding = {
  transactionId: string;
  proofId: string;
  captureSessionId: string;
  trackingNumber: string;
  carrierHint?: string;
  barcodeFormat: string;
  detectedAtMs: number;
  idempotencyKey: string;
};

```

Persist beside the existing durable local capture metadata.

On app recovery:

```text
restore capture
→ restore pending label binding
→ authenticate
→ replay binding
→ continue evidence upload/finalization

```

---

# 20. Proof Presentation

After completion, Proof detail should display:

## Shipping identity

- carrier
- tracking number
- source
- label detected timestamp

## Packing evidence

- video
- “Jump to label scan”

## Shipment chronology

- label attached during packing
- carrier label created
- carrier acceptance
- transit
- weight observation
- delivery

Example:

```text
ORDER CREATED
     ↓
PACKING VIDEO STARTED
     ↓
SHIPPING LABEL DETECTED
UPS •••• 4821
Video 01:21
     ↓
PACKING EVIDENCE COMMITTED
     ↓
PROOF FINALIZED
     ↓
CARRIER ACCEPTED PACKAGE
     ↓
WEIGHT REPORTED: 4.8 lb
     ↓
IN TRANSIT
     ↓
DELIVERED

```

---

# 21. Canonical Proof / Manifest

Do not rewrite existing PackProof integrity semantics.

The final Proof should continue to distinguish:

- transaction context;
- evidence;
- attestations;
- shipping metadata;
- shipment events;
- external observations.

The scanned label event should not masquerade as carrier-confirmed data.

Recommended provenance distinction:

```text
LABEL DETECTION
source = PACKPROOF_CAPTURE

CARRIER EVENT
source = SHIPPING_PROVIDER_API
provider = easypost
carrier = UPS

```

This distinction is important.

---

# 22. Security Requirements

Implement the following protections:

- server-authoritative authorization;
- seller-scoped transaction mutation;
- no cross-user tracking lookup;
- idempotency key required;
- Proof/transaction ownership verification;
- immutable/conflict-safe tracking identity;
- no carrier credentials on client;
- no raw EasyPost errors exposed to clients;
- webhook HMAC verification;
- input length limits;
- barcode sanitization;
- tracking-number normalization.

Do not trust carrier supplied by the mobile client.

Treat it as a hint.

---

# 23. Privacy Requirements

Shipping labels contain personally identifiable information.

Barcode detection should extract only the minimum structured data required.

Do not perform broad OCR of:

- recipient name;
- street address;
- phone number;
- email;
- sender address

for this feature unless specifically required later.

The objective is tracking identity, not label transcription.

---

# 24. Mobile State Machine Changes

Current Packing Station:

```text
READY
→ SCANNING
→ IDENTIFYING
→ READY_TO_PACK
→ RECORDING
→ FINISH_SCANNING
→ VERIFYING_FINISH_SCAN
→ PROCESSING

```

Target:

```text
READY
→ IDENTIFYING
→ READY_TO_PACK
→ RECORDING
     ├── BARCODE_OBSERVED
     ├── TRACKING_BINDING
     ├── TRACKING_ATTACHED
     └── CONTINUE_RECORDING
→ PROCESSING
→ PROOF_CREATED

```

The finish rescan should no longer be required once unified in-video detection is considered reliable.

Keep manual fallback initially.

---

# 25. Migration Strategy

Do not remove the existing flow immediately.

Implement feature flag:

```text
PACKPROOF_UNIFIED_CAPTURE=true

```

During rollout:

```text
Unified capture available?
    ├── yes → new in-video scanning flow
    └── no  → existing scan → record → rescan flow

```

Retain current fallback until physical-device validation passes.

---

# 26. Physical Device Test Matrix

Required hardware:

Primary:

- Samsung Galaxy S24 Ultra

Secondary:

- Samsung Galaxy A16 5G

Required tests:

### A. Continuous recording

Record 2–5 minute video with no dropped capture.

### B. Label detection

Show UPS/USPS/FedEx test labels during recording.

Expected:
tracking detected while recording continues.

### C. Duplicate reads

Leave barcode visible for 10 seconds.

Expected:
one canonical binding.

### D. Multiple label barcodes

Expose label with several barcodes.

Expected:
only tracking number bound.

### E. Wrong barcode

Show unrelated UPC.

Expected:
ignored.

### F. Tracking conflict

Transaction already contains tracking A; scan tracking B.

Expected:
conflict shown, original preserved, recording continues.

### G. Network loss

Disable network before label scan.

Expected:
recording continues, pending binding retained.

### H. App interruption

Simulate Android interruption after detection.

Expected:
local video and pending binding recover.

### I. Carrier initialization

Valid test tracking number.

Expected:
backend tracker initialized.

### J. Video timestamp

Verify “Jump to label scan” seeks to approximate detection moment.

### K. Camera permissions

Permission denied / revoked / restored.

### L. Microphone permissions

Audio failure handled without corrupting capture.

### M. Back button

Hardware back does not destroy active capture without confirmation.

### N. Thermal test

Longer recording on S24 Ultra.

Confirm acceptable temperature and frame stability.

---

# 27. Backend Tests

Add tests covering:

- shipping binding without existing tracking;
- same tracking idempotent replay;
- different tracking conflict;
- unauthorized transaction mutation;
- finalized Proof mutation rejection;
- malformed tracking number;
- EasyPost tracker initialization;
- provider failure;
- webhook shipment updates;
- duplicate provider events;
- capture timestamp provenance;
- carrier hint overridden by trusted provider;
- carrier weight import;
- shipment events after Proof finalization without changing core Proof hash.

---

# 28. Mobile Tests

Add unit/state-machine tests for:

- barcode recognized during RECORDING;
- barcode ignored if unrelated;
- accepted barcode updates UI;
- duplicate suppression;
- tracking pending offline;
- replay after recovery;
- conflict state;
- recording continues through backend failure;
- successful capture submission retains shipping binding.

---

# 29. Observability

Add structured telemetry for:

- barcode detection attempted;
- barcode recognized as tracking;
- carrier inferred;
- tracking binding success;
- tracking conflict;
- carrier initialization success;
- carrier initialization failure;
- offline replay success;
- barcode detector latency.

Do not log full shipping labels or personal information.

Tracking numbers should be masked in ordinary logs.

Example:

`1Z******4821`

---

# 30. Performance Requirements

Target:

- barcode recognition latency under \~500 ms where hardware permits;
- UI confirmation under \~1 second after recognition;
- no visible camera restart;
- no video interruption;
- no major frame-rate degradation;
- no blocking carrier API calls on UI thread.

Barcode recognition should run asynchronously.

---

# 31. UX Polish

Use PackProof motion standards.

On successful detection:

1. subtle frame pulse;
2. short success haptic;
3. animated success chip;
4. carrier + masked tracking displayed;
5. chip shrinks into persistent state.

Example:

`✓ UPS label attached •••• 4821`

On failure:

Do not use disruptive modal dialogs during recording unless absolutely necessary.

Prefer transient banners.

---

# 32. Recommended Implementation Sequence

## Phase 1 — Camera spike

Build proof-of-concept:

```text
preview + recording + barcode recognition

```

on S24 Ultra.

Do not proceed to backend changes until simultaneous camera operations are demonstrated reliably.

## Phase 2 — Unified recorder

Replace native system recorder within Packing Station.

Retain current upload pipeline.

## Phase 3 — Tracking parser

Implement barcode → tracking candidate.

## Phase 4 — Shipping binding API

Implement safe/idempotent backend binding.

## Phase 5 — Capture provenance

Associate label event with video timestamp.

## Phase 6 — Carrier auto-registration

Trigger trusted shipment adapter.

## Phase 7 — Offline/recovery

Persist pending binding with capture.

## Phase 8 — Proof UI

Expose label detection and video timestamp.

## Phase 9 — Physical QA

Run full S24 Ultra and A16 matrix.

## Phase 10 — Remove mandatory finish rescan

Only after unified capture passes hardware validation.

---

# 33. Do Not Regress

Astra must preserve:

- append-only committed evidence;
- SHA-256 evidence integrity;
- deterministic finalization;
- existing idempotency semantics;
- `FULFILLMENT_CAPTURE` requirement;
- Proof/transaction identity constraints;
- carrier-event provenance;
- finalized Proof mutation protection;
- offline capture recovery;
- Cognito authentication;
- existing web flow;
- existing EasyPost test integration;
- P2P behavior.

The new feature must integrate into the canonical Proof engine rather than create a parallel Proof type.

---

# 34. Definition of Done

The feature is complete when this real-world sequence works on the Samsung Galaxy S24 Ultra:

```text
Seller opens PackProof
→ selects/imports an order
→ starts packing capture
→ video begins
→ seller packs item
→ seller applies shipping label
→ PackProof detects tracking barcode while video continues
→ carrier/tracking appears on screen
→ PackProof binds tracking to transaction
→ PackProof registers tracking with trusted carrier integration
→ seller seals package
→ seller stops recording
→ evidence uploads
→ Proof finalizes
→ Proof shows:
     order information
     packing video
     label detection timestamp
     carrier
     tracking number
     shipment chronology
→ later carrier events automatically append
→ carrier-reported weight appears if available
→ Proof integrity remains valid

```

No manual tracking-number entry should be required in the happy path.

No second shipping-label scan should be required in the happy path.

No camera restart should occur when the label is detected.

The packing video must remain continuous.

---

# 35. Desired Final Product Experience

The result should feel almost invisible to the seller.

They should simply record themselves packing the order.

When the shipping label enters the camera view:

```text
✓ Shipping label detected
UPS •••• 4821
Tracking attached to Proof

```

Everything else should happen automatically.

That interaction should connect PackProof’s three strongest evidence sources into one chain:

```text
COMMERCE ORDER
      ↓
PHYSICAL PACKING EVIDENCE
      ↓
SHIPPING LABEL IDENTITY
      ↓
CARRIER OBSERVATIONS
      ↓
DELIVERY RECORD

```

The result should make the Proof materially stronger without adding meaningful work for the seller.

The central implementation principle is:

**Do not make the user document more. Make PackProof recognize more of what is already happening during the act of packing.**