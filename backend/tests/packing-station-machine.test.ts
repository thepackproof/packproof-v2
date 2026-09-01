import { describe, expect, it } from "vitest";
import {
  initialStationState,
  reduceStation,
  restoreStationState,
  stationCanFinishScan,
  stationCanIdentify,
  stationHasPreservedCapture,
  stationPhaseLabel,
} from "../../mobile/src/packing-station/machine.ts";
import { finishScanMatchesActive, stationContextFromProof } from "../../mobile/src/packing-station/display.ts";
import type { StationOrderContext, StationProofSnapshot } from "../../mobile/src/packing-station/types.ts";

const readyOrder: StationOrderContext = {
  transactionId: "txn_1",
  proofId: "proof_1",
  proofStatus: "READY_FOR_EVIDENCE",
  participationPolicy: "COUNTERPARTY_OPTIONAL",
  orderLabel: "Order #4821",
  itemSummary: "Pokémon Charizard PSA 10",
  alreadyFinalized: false,
  alreadyHasCommittedEvidence: false,
  captureReady: true,
  blockReason: null,
};

const capture = {
  handle: "file://pack.mp4",
  contentType: "video/mp4",
  byteSize: 2048,
  durationMs: 12_000,
};

function toRecording(options?: { capture?: boolean }) {
  let state = initialStationState();
  state = reduceStation(state, { type: "SCAN_STARTED" });
  state = reduceStation(state, { type: "SCAN_DECODED", value: "4821" });
  state = reduceStation(state, { type: "IDENTIFY_RESOLVED", context: readyOrder, method: "SCAN" });
  state = reduceStation(state, { type: "START_RECORDING", trigger: "MANUAL" });
  if (options?.capture) {
    state = reduceStation(state, { type: "CAPTURE_HELD", capture, idempotencyKey: "idem_held" });
  }
  return state;
}

function proof(status: string, extras: Partial<StationProofSnapshot> = {}): StationProofSnapshot {
  return {
    proofId: "proof_1",
    transactionId: "txn_1",
    status,
    participationPolicy: "COUNTERPARTY_OPTIONAL",
    participants: [{ userId: "seller", role: "SELLER" }],
    evidence: [],
    attestations: [],
    transaction: { externalReference: "4821", itemTitle: "Pokémon Charizard PSA 10" },
    ...extras,
  };
}

describe("packing station state machine", () => {
  it("resolves an order, records, completes, and resets for a second transaction", () => {
    let state = initialStationState();
    state = reduceStation(state, { type: "SET_REFERENCE", reference: "4821" });
    state = reduceStation(state, { type: "IDENTIFY_STARTED", method: "REFERENCE", reference: "4821" });
    expect(state.phase).toBe("IDENTIFYING");
    state = reduceStation(state, { type: "IDENTIFY_RESOLVED", context: readyOrder, method: "REFERENCE" });
    expect(state.phase).toBe("READY_TO_RECORD");
    expect(state.order?.proofId).toBe("proof_1");

    state = reduceStation(state, { type: "START_RECORDING", trigger: "MANUAL" });
    expect(state.phase).toBe("RECORDING");
    state = reduceStation(state, { type: "CAPTURE_READY", capture, trigger: "MANUAL" });
    expect(state.phase).toBe("PROCESSING");
    expect(stationHasPreservedCapture(state)).toBe(true);
    state = reduceStation(state, { type: "PROCESSING_STARTED", idempotencyKey: "idem_1", submitStep: "upload" });
    state = reduceStation(state, { type: "COMPLETED", completion: "FINALIZED" });
    expect(state.phase).toBe("PROOF_CREATED");
    expect(state.capture).toBeNull();

    state = reduceStation(state, { type: "RESET" });
    expect(state.phase).toBe("READY");
    expect(state.order).toBeNull();

    const second: StationOrderContext = {
      ...readyOrder,
      transactionId: "txn_2",
      proofId: "proof_2",
      orderLabel: "Order #4822",
    };
    state = reduceStation(state, { type: "IDENTIFY_STARTED", method: "QUEUE_SELECT" });
    state = reduceStation(state, { type: "IDENTIFY_RESOLVED", context: second, method: "QUEUE_SELECT" });
    expect(state.order?.proofId).toBe("proof_2");
    expect(state.phase).toBe("READY_TO_RECORD");
  });

  it("reuses the resolved Proof context instead of opening a second session", () => {
    const context = stationContextFromProof(proof("READY_FOR_EVIDENCE"));
    expect(context.proofId).toBe("proof_1");
    expect(context.captureReady).toBe(true);
    const again = stationContextFromProof(proof("READY_FOR_EVIDENCE"));
    expect(again.proofId).toBe(context.proofId);
  });

  it("keeps captured video after upload failure so retry can resume", () => {
    let state = initialStationState();
    state = reduceStation(state, { type: "IDENTIFY_STARTED", method: "SCAN" });
    state = reduceStation(state, { type: "IDENTIFY_RESOLVED", context: readyOrder, method: "SCAN" });
    state = reduceStation(state, { type: "START_RECORDING" });
    state = reduceStation(state, { type: "CAPTURE_READY", capture });
    state = reduceStation(state, {
      type: "PROCESSING_FAILED",
      error: { code: "UPLOAD_FAILED", message: "network down" },
      canRetry: true,
    });
    expect(state.phase).toBe("RECOVERY");
    expect(state.capture?.handle).toBe(capture.handle);
    expect(reduceStation(state, { type: "RESET" }).capture?.handle).toBe(capture.handle);
    state = reduceStation(state, { type: "RETRY" });
    expect(state.phase).toBe("PROCESSING");
    expect(state.capture?.handle).toBe(capture.handle);
  });

  it("does not start capture on a finalized Proof and can return to READY", () => {
    const finalized = stationContextFromProof(
      proof("FINALIZED", {
        evidence: [{ validationStatus: "COMMITTED" }],
      }),
    );
    expect(finalized.captureReady).toBe(false);
    expect(finalized.blockReason).toBe("FINALIZED");
    let state = initialStationState();
    state = reduceStation(state, { type: "IDENTIFY_STARTED", method: "REFERENCE" });
    state = reduceStation(state, { type: "IDENTIFY_RESOLVED", context: finalized, method: "REFERENCE" });
    expect(state.phase).toBe("RECOVERY");
    expect(reduceStation(state, { type: "START_RECORDING" }).phase).toBe("RECOVERY");
    state = reduceStation(state, { type: "RESET" });
    expect(state.phase).toBe("READY");
    expect(state.order).toBeNull();
  });

  it("keeps READY after an invalid reference and after auth failure with no capture", () => {
    let state = initialStationState();
    state = reduceStation(state, { type: "IDENTIFY_STARTED", method: "REFERENCE", reference: "NOPE" });
    state = reduceStation(state, {
      type: "IDENTIFY_FAILED",
      error: { code: "STATION_REFERENCE_NOT_FOUND", message: "No packing order matched that reference" },
    });
    expect(state.phase).toBe("RECOVERY");
    expect(state.order).toBeNull();
    expect(state.capture).toBeNull();
    state = reduceStation(state, { type: "RESET" });
    expect(state.phase).toBe("READY");
    expect(stationCanIdentify(state)).toBe(true);

    state = reduceStation(state, { type: "IDENTIFY_STARTED", method: "REFERENCE" });
    state = reduceStation(state, { type: "IDENTIFY_RESOLVED", context: readyOrder, method: "REFERENCE" });
    state = reduceStation(state, { type: "AUTH_FAILED" });
    expect(state.phase).toBe("RECOVERY");
    expect(state.error?.code).toBe("UNAUTHENTICATED");
    expect(state.order?.proofId).toBe("proof_1");
  });

  it("scans from READY into identifying, then READY TO PACK, and ignores a second decode", () => {
    let state = initialStationState();
    state = reduceStation(state, { type: "SCAN_STARTED" });
    expect(state.phase).toBe("SCANNING");
    state = reduceStation(state, { type: "SCAN_DECODED", value: "4821" });
    expect(state.phase).toBe("IDENTIFYING");
    expect(state.identifyMethod).toBe("SCAN");
    expect(state.referenceInput).toBe("4821");
    const identifying = state;
    state = reduceStation(state, { type: "SCAN_DECODED", value: "9999" });
    expect(state).toBe(identifying);
    state = reduceStation(state, { type: "IDENTIFY_RESOLVED", context: readyOrder, method: "SCAN" });
    expect(state.phase).toBe("READY_TO_RECORD");
    expect(state.order?.orderLabel).toBe("Order #4821");
  });

  it("returns to a retryable state on invalid, unauthorized, ambiguous, and finalized scans", () => {
    let state = initialStationState();
    state = reduceStation(state, { type: "SCAN_STARTED" });
    state = reduceStation(state, { type: "SCAN_DECODED", value: "NOPE" });
    state = reduceStation(state, {
      type: "IDENTIFY_FAILED",
      error: { code: "STATION_REFERENCE_NOT_FOUND", message: "No packing order matched that reference" },
    });
    expect(state.phase).toBe("RECOVERY");
    expect(state.canRetry).toBe(true);
    expect(state.capture).toBeNull();
    state = reduceStation(state, { type: "SCAN_STARTED" });
    expect(state.phase).toBe("SCANNING");
    state = reduceStation(state, { type: "SCAN_DECODED", value: "AMBIG" });
    state = reduceStation(state, {
      type: "IDENTIFY_FAILED",
      error: { code: "STATION_REFERENCE_AMBIGUOUS", message: "More than one order matched that reference" },
    });
    expect(state.phase).toBe("RECOVERY");
    state = reduceStation(state, { type: "RESET" });
    expect(state.phase).toBe("READY");

    const finalized = stationContextFromProof(
      proof("FINALIZED", {
        evidence: [{ validationStatus: "COMMITTED" }],
      }),
    );
    state = reduceStation(state, { type: "SCAN_STARTED" });
    state = reduceStation(state, { type: "SCAN_DECODED", value: "DONE" });
    state = reduceStation(state, { type: "IDENTIFY_RESOLVED", context: finalized, method: "SCAN" });
    expect(state.phase).toBe("RECOVERY");
    expect(state.error?.code).toBe("PROOF_ALREADY_FINALIZED");
    state = reduceStation(state, { type: "RESET" });
    expect(state.phase).toBe("READY");
  });

  it("cancels scanning, recovers from scanner failure, and still identifies by reference or queue", () => {
    let state = initialStationState();
    state = reduceStation(state, { type: "SCAN_STARTED" });
    state = reduceStation(state, { type: "SCAN_CANCELLED" });
    expect(state.phase).toBe("READY");

    state = reduceStation(state, { type: "SCAN_STARTED" });
    state = reduceStation(state, {
      type: "SCAN_FAILED",
      error: { code: "CAMERA_PERMISSION_DENIED", message: "Camera permission is required to scan labels." },
    });
    expect(state.phase).toBe("RECOVERY");
    expect(state.canRetry).toBe(true);
    expect(stationCanIdentify(state)).toBe(true);

    state = reduceStation(state, { type: "RESET" });
    state = reduceStation(state, { type: "SET_REFERENCE", reference: "4821" });
    state = reduceStation(state, { type: "IDENTIFY_STARTED", method: "REFERENCE", reference: "4821" });
    state = reduceStation(state, { type: "IDENTIFY_RESOLVED", context: readyOrder, method: "REFERENCE" });
    expect(state.phase).toBe("READY_TO_RECORD");
    state = reduceStation(state, { type: "RESET" });
    state = reduceStation(state, { type: "IDENTIFY_STARTED", method: "QUEUE_SELECT" });
    state = reduceStation(state, { type: "IDENTIFY_RESOLVED", context: readyOrder, method: "QUEUE_SELECT" });
    expect(state.phase).toBe("READY_TO_RECORD");
  });

  it("does not start a second identify while captured video is preserved", () => {
    let state = initialStationState();
    state = reduceStation(state, { type: "IDENTIFY_STARTED", method: "SCAN" });
    state = reduceStation(state, { type: "IDENTIFY_RESOLVED", context: readyOrder, method: "SCAN" });
    state = reduceStation(state, { type: "START_RECORDING" });
    state = reduceStation(state, { type: "CAPTURE_READY", capture });
    const blocked = reduceStation(state, { type: "SCAN_STARTED" });
    expect(blocked.phase).toBe("RECOVERY");
    expect(blocked.capture?.handle).toBe(capture.handle);
  });

  it("rescans the same canonical transaction to finish a held capture", () => {
    let state = toRecording({ capture: true });
    expect(stationCanFinishScan(state)).toBe(true);
    expect(stationPhaseLabel(state)).toBe("SCAN TO FINISH");
    state = reduceStation(state, { type: "FINISH_SCAN_STARTED" });
    expect(state.phase).toBe("FINISH_SCANNING");
    expect(state.capture?.handle).toBe(capture.handle);
    expect(state.order?.transactionId).toBe("txn_1");
    state = reduceStation(state, { type: "FINISH_SCAN_DECODED", value: "9400111899223344556677" });
    expect(state.phase).toBe("VERIFYING_FINISH_SCAN");
    const verifying = state;
    state = reduceStation(state, { type: "FINISH_SCAN_DECODED", value: "duplicate" });
    expect(state).toBe(verifying);
    state = reduceStation(state, {
      type: "FINISH_RESOLVED",
      resolved: { transactionId: "txn_1", proofId: "proof_1" },
    });
    expect(state.phase).toBe("PROCESSING");
    expect(state.stopTrigger).toBe("RESCAN");
    expect(state.capture?.handle).toBe(capture.handle);
    expect(state.order?.proofId).toBe("proof_1");
  });

  it("keeps recording when a finish scan resolves to a different transaction", () => {
    let state = toRecording({ capture: true });
    state = reduceStation(state, { type: "FINISH_SCAN_STARTED" });
    state = reduceStation(state, { type: "FINISH_SCAN_DECODED", value: "DS-1002" });
    state = reduceStation(state, {
      type: "FINISH_RESOLVED",
      resolved: { transactionId: "txn_other", proofId: "proof_other" },
    });
    expect(state.phase).toBe("RECORDING");
    expect(state.error?.code).toBe("WRONG_PACKAGE");
    expect(state.error?.message).toBe("Different order scanned. Finish packing the current order first.");
    expect(state.capture?.handle).toBe(capture.handle);
    expect(state.order?.transactionId).toBe("txn_1");
    expect(state.stopTrigger).toBeNull();
  });

  it("matches the same transaction through a different identifier and fails closed on proof mismatch", () => {
    expect(
      finishScanMatchesActive(
        { transactionId: "txn_1", proofId: "proof_1" },
        { transactionId: "txn_1", proofId: "proof_1" },
      ),
    ).toBe(true);
    expect(
      finishScanMatchesActive(
        { transactionId: "txn_1", proofId: "proof_1" },
        { transactionId: "txn_1", proofId: null },
      ),
    ).toBe(true);
    expect(
      finishScanMatchesActive(
        { transactionId: "txn_1", proofId: "proof_1" },
        { transactionId: "txn_2", proofId: "proof_1" },
      ),
    ).toBe(false);
    expect(
      finishScanMatchesActive(
        { transactionId: "txn_1", proofId: "proof_1" },
        { transactionId: "txn_1", proofId: "proof_other" },
      ),
    ).toBe(false);

    let state = toRecording({ capture: true });
    state = reduceStation(state, { type: "FINISH_SCAN_STARTED" });
    state = reduceStation(state, { type: "FINISH_SCAN_DECODED", value: "ORDER-A" });
    state = reduceStation(state, {
      type: "FINISH_RESOLVED",
      resolved: { transactionId: "txn_1", proofId: "proof_1" },
    });
    expect(state.phase).toBe("PROCESSING");

    state = toRecording({ capture: true });
    state = reduceStation(state, { type: "FINISH_SCAN_STARTED" });
    state = reduceStation(state, { type: "FINISH_SCAN_DECODED", value: "ORDER-A" });
    state = reduceStation(state, {
      type: "FINISH_RESOLVED",
      resolved: { transactionId: "txn_1", proofId: "proof_other" },
    });
    expect(state.phase).toBe("RECORDING");
    expect(state.error?.code).toBe("WRONG_PACKAGE");
    expect(state.capture?.handle).toBe(capture.handle);
  });

  it("returns to RECORDING with the capture intact for unknown, ambiguous, cancelled, and failed finish scans", () => {
    let state = toRecording({ capture: true });
    state = reduceStation(state, { type: "FINISH_SCAN_STARTED" });
    state = reduceStation(state, { type: "FINISH_SCAN_DECODED", value: "NOPE" });
    state = reduceStation(state, {
      type: "FINISH_SCAN_FAILED",
      error: { code: "STATION_REFERENCE_NOT_FOUND", message: "No packing order matched that reference" },
    });
    expect(state.phase).toBe("RECORDING");
    expect(state.capture?.handle).toBe(capture.handle);
    expect(state.order?.transactionId).toBe("txn_1");
    expect(state.canRetry).toBe(true);

    state = reduceStation(state, { type: "FINISH_SCAN_STARTED" });
    state = reduceStation(state, { type: "FINISH_SCAN_DECODED", value: "AMBIG" });
    state = reduceStation(state, {
      type: "FINISH_SCAN_FAILED",
      error: { code: "STATION_REFERENCE_AMBIGUOUS", message: "More than one order matched that reference" },
    });
    expect(state.phase).toBe("RECORDING");
    expect(state.capture?.handle).toBe(capture.handle);

    state = reduceStation(state, { type: "FINISH_SCAN_STARTED" });
    state = reduceStation(state, { type: "FINISH_SCAN_CANCELLED" });
    expect(state.phase).toBe("RECORDING");
    expect(state.error).toBeNull();
    expect(state.capture?.handle).toBe(capture.handle);

    state = reduceStation(state, { type: "FINISH_SCAN_STARTED" });
    state = reduceStation(state, { type: "FINISH_SCAN_DECODED", value: "4821" });
    state = reduceStation(state, {
      type: "FINISH_SCAN_FAILED",
      error: { code: "NETWORK", message: "Network unavailable" },
    });
    expect(state.phase).toBe("RECORDING");
    expect(state.capture?.handle).toBe(capture.handle);

    state = reduceStation(state, { type: "FINISH_SCAN_STARTED" });
    state = reduceStation(state, { type: "AUTH_FAILED" });
    expect(state.phase).toBe("RECORDING");
    expect(state.error?.code).toBe("UNAUTHENTICATED");
    expect(state.capture?.handle).toBe(capture.handle);
    expect(state.order?.proofId).toBe("proof_1");
  });

  it("signals a live recorder to stop after a matching finish scan without capture", () => {
    let state = toRecording();
    expect(stationPhaseLabel(state)).toBe("RECORDING");
    state = reduceStation(state, { type: "FINISH_SCAN_STARTED" });
    state = reduceStation(state, { type: "FINISH_SCAN_DECODED", value: "4821" });
    state = reduceStation(state, {
      type: "FINISH_RESOLVED",
      resolved: { transactionId: "txn_1", proofId: "proof_1" },
    });
    expect(state.phase).toBe("RECORDING");
    expect(state.stopTrigger).toBe("RESCAN");
    expect(state.capture).toBeNull();
    state = reduceStation(state, { type: "CAPTURE_READY", capture, trigger: "RESCAN" });
    expect(state.phase).toBe("PROCESSING");
    expect(state.stopTrigger).toBe("RESCAN");
  });

  it("uses Finished Packing as a fallback that still preserves capture", () => {
    let state = toRecording({ capture: true });
    state = reduceStation(state, { type: "FINISH_SCAN_STARTED" });
    state = reduceStation(state, { type: "FINISH_MANUAL" });
    expect(state.phase).toBe("PROCESSING");
    expect(state.stopTrigger).toBe("MANUAL");
    expect(state.capture?.handle).toBe(capture.handle);
  });

  it("does not start a second identify while a finish scan is active", () => {
    let state = toRecording({ capture: true });
    state = reduceStation(state, { type: "FINISH_SCAN_STARTED" });
    const blocked = reduceStation(state, { type: "SCAN_STARTED" });
    expect(blocked.phase).toBe("RECOVERY");
    expect(blocked.capture?.handle).toBe(capture.handle);
    expect(blocked.order?.transactionId).toBe("txn_1");
  });

  it("restores an interrupted finish scan with video into RECOVERY", () => {
    const restored = restoreStationState({
      phase: "FINISH_SCANNING",
      order: readyOrder,
      capture,
      evidenceIdempotencyKey: "idem_keep",
    });
    expect(restored.phase).toBe("RECOVERY");
    expect(restored.capture?.handle).toBe(capture.handle);
    expect(restored.canRetry).toBe(true);
  });

  it("restores an interrupted upload into RECOVERY without dropping the video", () => {
    const restored = restoreStationState({
      phase: "PROCESSING",
      order: readyOrder,
      capture,
      evidenceIdempotencyKey: "idem_keep",
    });
    expect(restored.phase).toBe("RECOVERY");
    expect(restored.capture?.handle).toBe(capture.handle);
    expect(restored.canRetry).toBe(true);
    expect(restored.evidenceIdempotencyKey).toBe("idem_keep");
  });
});
