import { describe, expect, it } from "vitest";
import { toUserFacingError, isNetworkFailure, OFFLINE_CAPTURE_MESSAGE } from "../../mobile/src/copy/errors.ts";
import { formatDate, greetingForHour, proofIdLabel, shortenId, trackingEnding } from "../../mobile/src/copy/format.ts";
import {
  deriveNextAction,
  fieldsLocked,
  canCaptureEvidence,
  shouldShowRequiredAction,
  isCompletedAction,
} from "../../mobile/src/copy/next-action.ts";
import {
  awaitingEvidenceCount,
  filterProofLibrary,
  homeSummaryLine,
  invitationCardModel,
  proofLibraryGroup,
  selectAttention,
  toProofCardModel,
} from "../../mobile/src/copy/presentation.ts";
import { humanProofStatus, proofStatusLabel, shipmentStatusLabel } from "../../mobile/src/copy/status.ts";
import { chronologyCategoryLabel, isShipmentAfterFinalization } from "../../mobile/src/copy/chronology.ts";
import { resolveBackRoute } from "../../mobile/src/app/navigation.ts";
import {
  assetItemLabel,
  captureEvidenceType,
  comparisonPairs,
  continuityResultLabel,
  inviteParticipantHint,
  inviteParticipantTitle,
  observationProgressLabel,
  participantFacingRole,
} from "../../mobile/src/copy/custody.ts";

function proof(
  partial: Partial<{
    proofId: string;
    role: string;
    status: string;
    itemTitle: string;
    carrier: string;
    transactionValue: number;
    currency: string;
    updatedAt: string;
  }>,
) {
  return {
    proofId: partial.proofId ?? "proof_01M1ES5F7N0",
    transactionId: "txn_1",
    role: partial.role ?? "SELLER",
    status: partial.status ?? "READY_FOR_EVIDENCE",
    createdAt: "2026-08-29T15:25:06.837Z",
    updatedAt: partial.updatedAt ?? "2026-08-30T15:25:06.837Z",
    finalizedAt: partial.status === "FINALIZED" ? "2026-08-29T16:00:00.000Z" : null,
    transaction: {
      externalReference: "DM-01M1ES5",
      itemTitle: partial.itemTitle ?? "Vintage film camera",
      transactionDate: "2026-08-20",
      carrier: partial.carrier ?? "UPS Ground",
      trackingNumber: "1Z999AA10123456784",
      transactionValue: partial.transactionValue ?? 250.5,
      currency: partial.currency ?? "USD",
    },
  };
}

describe("mobile UI status translation", () => {
  it("maps backend Proof statuses to human labels", () => {
    expect(proofStatusLabel("OPEN")).toBe("In progress");
    expect(proofStatusLabel("AWAITING_PARTICIPANT")).toBe("Waiting for buyer");
    expect(proofStatusLabel("READY_FOR_EVIDENCE")).toBe("Packing evidence needed");
    expect(proofStatusLabel("EVIDENCE_COMMITTED")).toBe("Ready to finalize");
    expect(proofStatusLabel("FINALIZED")).toBe("Completed");
  });

  it("does not show raw backend enums in ordinary labels", () => {
    expect(humanProofStatus({ proofStatus: "READY_FOR_EVIDENCE" })).not.toContain("READY_FOR_EVIDENCE");
    expect(humanProofStatus({ proofStatus: "READY_FOR_EVIDENCE" })).not.toContain("BUYER");
    expect(humanProofStatus({ proofStatus: "READY_FOR_EVIDENCE" })).toBe("Packing evidence needed");
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
    expect(
      humanProofStatus({
        proofStatus: "EVIDENCE_COMMITTED",
        hasShipping: true,
      }),
    ).toBe("Awaiting shipment");
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

  it("asks a seller to record packing video when the Proof is ready for evidence", () => {
    const action = deriveNextAction(base);
    expect(action.key).toBe("start_capture");
    expect(action.label).toBe("Record packing video");
    expect(shouldShowRequiredAction(action)).toBe(true);
    expect(canCaptureEvidence(base)).toBe(true);
  });

  it("does not require a buyer before capture when the backend already allows evidence", () => {
    const optional = deriveNextAction({
      ...base,
      participationPolicy: "COUNTERPARTY_OPTIONAL",
    });
    expect(optional.key).toBe("start_capture");
    expect(canCaptureEvidence(base)).toBe(true);

    const requiredButReady = deriveNextAction({
      ...base,
      participationPolicy: "COUNTERPARTY_REQUIRED",
    });
    expect(requiredButReady.key).toBe("start_capture");
  });

  it("asks to add a buyer only when the backend still requires a counterparty", () => {
    const action = deriveNextAction({
      ...base,
      proofStatus: "AWAITING_PARTICIPANT",
      participationPolicy: "COUNTERPARTY_REQUIRED",
    });
    expect(action.key).toBe("add_participant");
    expect(action.label).toBe("Add buyer");
    expect(shouldShowRequiredAction(action)).toBe(true);
  });

  it("does not invent a buyer or purchase-details gate for optional participation", () => {
    const action = deriveNextAction({
      ...base,
      proofStatus: "OPEN",
      participationPolicy: "COUNTERPARTY_OPTIONAL",
    });
    expect(action.key).toBe("none");
    expect(shouldShowRequiredAction(action)).toBe(false);
    expect(canCaptureEvidence({ ...base, proofStatus: "OPEN" })).toBe(false);

    const unspecified = deriveNextAction({
      ...base,
      proofStatus: "OPEN",
    });
    expect(unspecified.key).toBe("none");
    expect(shouldShowRequiredAction(unspecified)).toBe(false);
  });

  it("shows Record packing video for READY_FOR_EVIDENCE even when no buyer exists", () => {
    const action = deriveNextAction({
      ...base,
      proofStatus: "READY_FOR_EVIDENCE",
      participationPolicy: "COUNTERPARTY_OPTIONAL",
    });
    expect(action.key).toBe("start_capture");
    expect(action.label).toBe("Record packing video");
    expect(shouldShowRequiredAction(action)).toBe(true);
    expect(action.key).not.toBe("add_participant");
  });

  it("does not show a required-action card for a buyer who only needs to view the record", () => {
    const action = deriveNextAction({ ...base, role: "BUYER" });
    expect(action.key).toBe("view_record");
    expect(shouldShowRequiredAction(action)).toBe(false);
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
    expect(action.label).toBe("Finalize Proof");
  });

  it("locks the record after finalization and shows a completion state instead of a next step", () => {
    const action = deriveNextAction({ ...base, proofStatus: "FINALIZED", committedEvidenceCount: 1 });
    expect(action.key).toBe("completed");
    expect(isCompletedAction(action)).toBe(true);
    expect(shouldShowRequiredAction(action)).toBe(false);
    expect(fieldsLocked("FINALIZED")).toBe(true);
    expect(fieldsLocked("READY_FOR_EVIDENCE")).toBe(false);
  });
});

describe("mobile UI proof cards and library", () => {
  it("shows human-readable card fields instead of raw IDs", () => {
    const card = toProofCardModel(proof({}));
    expect(card.title).toBe("Vintage film camera");
    expect(card.statusLabel).toBe("Packing evidence needed");
    expect(card.priceLabel).toContain("250.50");
    expect(card.shipping).toContain("UPS");
    expect(card.orderRef).toContain("Order #");
    expect(card.proofId.startsWith("proof_")).toBe(true);
  });

  it("groups In Progress vs Completed from backend status", () => {
    expect(proofLibraryGroup("READY_FOR_EVIDENCE")).toBe("in_progress");
    expect(proofLibraryGroup("OPEN")).toBe("in_progress");
    expect(proofLibraryGroup("FINALIZED")).toBe("completed");
  });

  it("searches title, order, tracking, and sorts by date or price", () => {
    const camera = proof({ itemTitle: "Vintage film camera", transactionValue: 250.5, updatedAt: "2026-08-30T15:00:00.000Z" });
    const watch = proof({
      proofId: "proof_watch",
      itemTitle: "Rolex Submariner",
      transactionValue: 8450,
      updatedAt: "2026-08-20T15:00:00.000Z",
    });
    const found = filterProofLibrary([camera, watch], { view: "in_progress", query: "rolex" });
    expect(found).toHaveLength(1);
    expect(found[0]?.transaction.itemTitle).toBe("Rolex Submariner");

    const byOrder = filterProofLibrary([camera, watch], { view: "in_progress", query: "DM-01" });
    expect(byOrder).toHaveLength(2);

    const newest = filterProofLibrary([camera, watch], { view: "in_progress", sort: "newest" });
    expect(newest[0]?.proofId).toBe(camera.proofId);

    const oldest = filterProofLibrary([camera, watch], { view: "in_progress", sort: "oldest" });
    expect(oldest[0]?.proofId).toBe(watch.proofId);

    const high = filterProofLibrary([camera, watch], { view: "in_progress", sort: "price_high" });
    expect(high[0]?.transaction.itemTitle).toBe("Rolex Submariner");

    const sellers = filterProofLibrary([camera, { ...watch, role: "BUYER" }], {
      view: "in_progress",
      role: "seller",
    });
    expect(sellers).toHaveLength(1);
    expect(sellers[0]?.role).toBe("SELLER");
  });

  it("renders invitation cards as in-progress library items", () => {
    const card = invitationCardModel({
      invitationId: "inv_1",
      createdAt: "2026-08-31T12:00:00.000Z",
      transaction: { itemTitle: "Sealed carton", externalReference: "INV-1" },
      inviter: { displayName: "Nora", username: "nora" },
    });
    expect(card.title).toBe("Sealed carton");
    expect(card.statusLabel).toBe("Invitation received");
    expect(card.statusLabel).not.toContain("READY");
  });

  it("summarizes what needs attention", () => {
    const items = [proof({ status: "READY_FOR_EVIDENCE" }), proof({ proofId: "proof_2", status: "OPEN" })];
    expect(awaitingEvidenceCount(items)).toBe(1);
    expect(homeSummaryLine({ activeCount: 3, awaitingEvidenceCount: 1, readyToFinalizeCount: 0, invitationCount: 0 })).toContain(
      "3 active",
    );
    const attention = selectAttention({ proofs: items, invitations: [] });
    expect(attention?.title).toBe("Vintage film camera");
    expect(attention?.cta).toBe("Record packing video");
  });
});

describe("Proof Record provenance and navigation", () => {
  it("keeps commerce, carrier, PackProof, evidence, and integrity labels", () => {
    expect(chronologyCategoryLabel("COMMERCE", "MARKETPLACE_API", "ebay", "TRANSACTION_IMPORTED")).toBe("Commerce event");
    expect(chronologyCategoryLabel("SHIPMENT", "SHIPPING_PROVIDER_API", "ups", "IN_TRANSIT")).toBe("Carrier observation");
    expect(chronologyCategoryLabel("SHIPMENT", "SHIPPING_PROVIDER_API", "easypost", "IN_TRANSIT")).toBe(
      "Carrier observation via EasyPost",
    );
    expect(chronologyCategoryLabel("PROOF", "PACKPROOF", null, "PROOF_CREATED")).toBe("PackProof event");
    expect(chronologyCategoryLabel("PROOF", "PACKPROOF", null, "EVIDENCE_COMMITTED")).toBe("Evidence event");
    expect(chronologyCategoryLabel("PROOF", "PACKPROOF", null, "PROOF_FINALIZED")).toBe("Integrity event");
    expect(chronologyCategoryLabel("COMMERCE", "MARKETPLACE_API", "ebay", "EVIDENCE_COMMITTED")).toBe("Commerce event");
  });

  it("returns from temporary flows without restoring a tab bar", () => {
    expect(resolveBackRoute("capture")).toBe("proof");
    expect(resolveBackRoute("event")).toBe("proof");
    expect(resolveBackRoute("scan")).toBe("create");
    expect(resolveBackRoute("proof")).toBe("home");
    expect(resolveBackRoute("account")).toBe("home");
    expect(resolveBackRoute("create")).toBe("home");
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

describe("mobile custody presentation copy", () => {
  it("maps grading roles to originator and receiving participant", () => {
    expect(participantFacingRole("GRADING_SUBMISSION", "SELLER")).toBe("Originator");
    expect(participantFacingRole("GRADING_SUBMISSION", "BUYER")).toBe("Receiving participant");
    expect(participantFacingRole("COMMERCE_SALE", "SELLER")).toBe("Seller");
    expect(participantFacingRole("COMMERCE_SALE", "BUYER")).toBe("Buyer");
  });

  it("labels assets and observation progress for grading UI", () => {
    expect(assetItemLabel({ labelIndex: 2 })).toBe("Item 2");
    expect(assetItemLabel({ label: "Card A" })).toBe("Card A");
    expect(observationProgressLabel("ORIGIN_CAPTURE")).toBe("Documented");
    expect(observationProgressLabel("RELEASED")).toBe("Handed off");
  });

  it("preserves commerce fulfillment capture even with packing recipe", () => {
    expect(
      captureEvidenceType({
        workflowType: undefined,
        captureRecipe: "PACKING_STANDARD_V1",
        nextActionType: "PACK_ITEMS",
      }),
    ).toBe("FULFILLMENT_CAPTURE");
    expect(
      captureEvidenceType({
        workflowType: "GRADING_SUBMISSION",
        captureRecipe: "PACKING_STANDARD_V1",
        nextActionType: "PACK_ITEMS",
      }),
    ).toBe("PACKING_CAPTURE");
  });

  it("uses receiving-participant invite copy only for grading", () => {
    expect(inviteParticipantTitle("COMMERCE_SALE")).toBe("Add buyer");
    expect(inviteParticipantTitle("GRADING_SUBMISSION")).toBe("Add receiving participant");
    expect(inviteParticipantHint("GRADING_SUBMISSION")).toContain("receiving participant");
    expect(inviteParticipantHint("COMMERCE_SALE")).not.toContain("receiving participant");
  });

  it("pairs origin and receipt captures for side-by-side compare", () => {
    const pairs = comparisonPairs({
      continuity: [
        {
          evidencePairs: [
            { slot: "FRONT", originEvidenceId: "evd_o_f", receivedEvidenceId: "evd_r_f" },
            { slot: "BACK", originEvidenceId: "evd_o_b", receivedEvidenceId: "evd_r_b" },
          ],
        },
      ],
    });
    expect(pairs.map((row) => row.slot)).toEqual(["FRONT", "BACK"]);
    expect(continuityResultLabel("MATERIAL_DIFFERENCE")).toBe("Material difference");
    expect(continuityResultLabel("CONSISTENT")).toBe("Consistent");
  });
});
