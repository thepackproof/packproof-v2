import { describe, expect, it } from "vitest";
import { toUserFacingError, isNetworkFailure, OFFLINE_CAPTURE_MESSAGE } from "../../mobile/src/copy/errors.ts";
import { formatDate, greetingForHour, proofIdLabel, shortenId, trackingEnding } from "../../mobile/src/copy/format.ts";
import { deriveNextAction, fieldsLocked, canCaptureEvidence } from "../../mobile/src/copy/next-action.ts";
import {
  awaitingEvidenceCount,
  homeSummaryLine,
  selectAttention,
  toProofCardModel,
} from "../../mobile/src/copy/presentation.ts";
import { humanProofStatus, proofStatusLabel, shipmentStatusLabel } from "../../mobile/src/copy/status.ts";
import { isShipmentAfterFinalization } from "../../mobile/src/copy/chronology.ts";

function proof(partial: Partial<{ proofId: string; role: string; status: string; itemTitle: string; carrier: string }>) {
  return {
    proofId: partial.proofId ?? "proof_01M1ES5F7N0",
    transactionId: "txn_1",
    role: partial.role ?? "SELLER",
    status: partial.status ?? "READY_FOR_EVIDENCE",
    createdAt: "2026-08-29T15:25:06.837Z",
    updatedAt: "2026-08-30T15:25:06.837Z",
    finalizedAt: partial.status === "FINALIZED" ? "2026-08-29T16:00:00.000Z" : null,
    transaction: {
      externalReference: "DM-01M1ES5",
      itemTitle: partial.itemTitle ?? "Vintage film camera",
      transactionDate: "2026-08-20",
      carrier: partial.carrier ?? "UPS Ground",
      trackingNumber: "1Z999AA10123456784",
    },
  };
}

describe("mobile UI status translation", () => {
  it("maps backend Proof statuses to human labels", () => {
    expect(proofStatusLabel("OPEN")).toBe("Getting started");
    expect(proofStatusLabel("READY_FOR_EVIDENCE")).toBe("Ready to capture");
    expect(proofStatusLabel("EVIDENCE_COMMITTED")).toBe("Evidence secured");
    expect(proofStatusLabel("FINALIZED")).toBe("Completed");
  });

  it("does not show raw role+status as the primary label", () => {
    expect(humanProofStatus({ proofStatus: "READY_FOR_EVIDENCE" })).not.toContain("BUYER");
    expect(humanProofStatus({ proofStatus: "READY_FOR_EVIDENCE" })).toBe("Ready to capture");
  });

  it("overlays local capture and shipment states", () => {
    expect(
      humanProofStatus({
        proofStatus: "READY_FOR_EVIDENCE",
        captureStatus: "captured",
        hasLocalCapture: true,
        captureBelongsToProof: true,
      }),
    ).toBe("Recording ready");
    expect(
      humanProofStatus({
        proofStatus: "FINALIZED",
        latestShipmentEventType: "IN_TRANSIT",
      }),
    ).toBe("In transit");
    expect(shipmentStatusLabel("CARRIER_ACCEPTED")).toBe("Package accepted");
  });
});

describe("mobile UI next-action CTA", () => {
  const base = {
    role: "SELLER",
    proofStatus: "READY_FOR_EVIDENCE",
    committedEvidenceCount: 0,
    captureStatus: "idle" as const,
    hasLocalCapture: false,
    captureBelongsToProof: false,
    uploadPercent: null,
    offline: false,
  };

  it("asks a seller to start capture when the Proof is ready", () => {
    expect(deriveNextAction(base).label).toBe("Start evidence capture");
    expect(canCaptureEvidence(base)).toBe(true);
  });

  it("asks to review a local recording before claiming it is secured", () => {
    const action = deriveNextAction({
      ...base,
      hasLocalCapture: true,
      captureBelongsToProof: true,
      captureStatus: "captured",
    });
    expect(action.key).toBe("review_recording");
    expect(action.label).toBe("Review recording");
  });

  it("shows upload progress without claiming a commit", () => {
    const action = deriveNextAction({
      ...base,
      hasLocalCapture: true,
      captureBelongsToProof: true,
      captureStatus: "uploading",
      uploadPercent: 62,
    });
    expect(action.label).toContain("Uploading evidence");
    expect(action.label).toContain("62%");
    expect(action.enabled).toBe(false);
  });

  it("keeps offline recordings on-device until commit", () => {
    const action = deriveNextAction({
      ...base,
      hasLocalCapture: true,
      captureBelongsToProof: true,
      captureStatus: "retry",
      offline: true,
    });
    expect(action.key).toBe("offline_held");
    expect(action.hint).toBe(OFFLINE_CAPTURE_MESSAGE);
    expect(action.enabled).toBe(false);
  });

  it("offers finalize only after evidence is committed", () => {
    const action = deriveNextAction({
      ...base,
      proofStatus: "EVIDENCE_COMMITTED",
      committedEvidenceCount: 1,
    });
    expect(action.key).toBe("finalize");
    expect(action.label).toBe("Finalize PackProof");
  });

  it("locks the record after finalization", () => {
    const action = deriveNextAction({ ...base, proofStatus: "FINALIZED", committedEvidenceCount: 1 });
    expect(action.key).toBe("completed");
    expect(fieldsLocked("FINALIZED")).toBe(true);
    expect(fieldsLocked("READY_FOR_EVIDENCE")).toBe(false);
  });
});

describe("mobile UI proof cards and home attention", () => {
  it("shows human-readable card fields instead of raw IDs", () => {
    const card = toProofCardModel(proof({}));
    expect(card.title).toBe("Vintage film camera");
    expect(card.statusLabel).toBe("Ready to capture");
    expect(card.shipping).toContain("UPS");
    expect(card.orderRef).toContain("Order #");
    expect(card.proofId.startsWith("proof_")).toBe(true);
  });

  it("summarizes what needs attention", () => {
    const items = [proof({ status: "READY_FOR_EVIDENCE" }), proof({ proofId: "proof_2", status: "OPEN" })];
    expect(awaitingEvidenceCount(items)).toBe(1);
    expect(homeSummaryLine({ activeCount: 3, awaitingEvidenceCount: 1, readyToFinalizeCount: 0, invitationCount: 0 })).toContain(
      "3 active",
    );
    const attention = selectAttention({ proofs: items, invitations: [] });
    expect(attention?.title).toBe("Vintage film camera");
    expect(attention?.cta).toBe("Start evidence capture");
  });
});

describe("mobile UI dates, IDs, and errors", () => {
  it("formats timestamps and shortens IDs", () => {
    expect(formatDate("2026-09-01")).toBe("Sep 1, 2026");
    expect(proofIdLabel("proof_01M1ES5F7N0")).toBe("Proof ••••F7N0");
    expect(shortenId("proof_01M1ES5F7N0")).toBe("••••F7N0");
    expect(trackingEnding("1Z999AA10123456784")).toBe("Tracking ending 6784");
    expect(greetingForHour(8)).toBe("Good morning");
  });

  it("translates duplicate and commit failures without raw codes as the title", () => {
    const duplicate = toUserFacingError({ code: "EXTERNAL_REFERENCE_CONFLICT", message: "already bound" });
    expect(duplicate.title).toBe("A PackProof already exists for this order.");
    expect(duplicate.action).toBe("open_existing");
    const commit = toUserFacingError({ code: "UPLOAD_FAILED", message: "evidence commit failed" });
    expect(commit.title).toBe("We couldn’t secure this evidence yet.");
    expect(commit.message).toContain("safely stored");
  });

  it("detects network failures as offline", () => {
    expect(isNetworkFailure(new TypeError("Network request failed"))).toBe(true);
  });

  it("marks shipment events after finalization without treating them as core edits", () => {
    expect(
      isShipmentAfterFinalization("2026-09-01T19:00:00.000Z", "2026-09-01T15:32:00.000Z", "SHIPMENT"),
    ).toBe(true);
    expect(
      isShipmentAfterFinalization("2026-09-01T15:31:00.000Z", "2026-09-01T15:32:00.000Z", "SHIPMENT"),
    ).toBe(false);
  });
});
