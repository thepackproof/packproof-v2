# Packing Station Mode

Packing Station is a persistent fulfillment surface. It is not a second Proof type, evidence pipeline, or integrity tier.

```text
READY → identify order → READY TO PACK → record packing video → PROCESSING → PROOF CREATED → READY
```

The station issues existing domain commands: `resolvePackingStation`, `createOrGetProof`, `initializeEvidenceUpload`, `commitEvidence`, `commitAttestation` (merchant finalize gate), `finalizeProof`, `getProof`.

## Product rule

Transaction and shipping records contextualize a pack. They do not replace physical fulfillment evidence. For this standalone station, continuous packing video is the required capture.

PackProof still records facts, attestations, and external metadata. It does not declare that a seller is truthful or that an item is authentic.

## Resolve

`POST /me/packing-station/resolve` is a seller-scoped read. It matches an authorized transaction by:

- proof id
- transaction id
- commerce order id / reference
- integration external id
- transaction `externalReference`
- tracking number

It never creates a transaction. `createOrGetProof` still owns one-Proof-per-transaction. Another seller’s order returns `STATION_REFERENCE_NOT_FOUND`.

## Client state machine

Station UI phases are not Proof states. Capture, upload, and retry remain local until the server commits evidence.

Seams for later triggers, not implemented in V1:

- identify: `SCAN`, `DEEP_LINK`, `API_EVENT`
- start: `AUTO`, `SCAN`, `SENSOR`
- stop: `RESCAN`, `LABEL`, `SEAL`, `WEIGHT`, `SCANNER`, `API_EVENT`

V1 uses `REFERENCE` / `QUEUE_SELECT` and manual start/stop. Mobile uses the existing camera capture. Web uses a webcam recorder with a video-file fallback.

## Failure

Upload, network, and auth failures keep the local video. Finalized Proofs reject mutation. The station then returns to READY for the next order.
