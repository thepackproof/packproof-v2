import type {
  StationBlockReason,
  StationError,
  StationOrderContext,
  StationProofSnapshot,
} from "./types";

export function normalizeStationReference(raw: string | null | undefined): string {
  return String(raw ?? "")
    .trim()
    .replace(/^#+/, "")
    .trim();
}

export function formatOrderLabel(reference: string | null | undefined): string {
  const value = normalizeStationReference(reference);
  return value ? `Order #${value}` : "Order";
}

export function formatItemSummary(
  title: string | null | undefined,
  extraCount = 0,
): string {
  const name = String(title ?? "").trim() || "Item";
  return extraCount > 0 ? `${name} + ${extraCount} more` : name;
}

export function itemSummaryFromProof(proof: StationProofSnapshot): string {
  const items = proof.transaction.items ?? [];
  if (items.length > 1) {
    return formatItemSummary(items[0]?.title ?? proof.transaction.itemTitle, items.length - 1);
  }
  return formatItemSummary(items[0]?.title ?? proof.transaction.itemTitle);
}

export function committedEvidenceCount(proof: StationProofSnapshot): number {
  return proof.evidence.filter((item) => item.validationStatus === "COMMITTED").length;
}

export function sellerHasPackingAttestation(
  proof: StationProofSnapshot,
  actorUserId: string,
): boolean {
  return (proof.attestations ?? []).some(
    (row) => row.statement === "PACKED_DESCRIBED_ITEM" && row.attestedBy === actorUserId,
  );
}

export function proofHasBuyer(proof: StationProofSnapshot): boolean {
  return proof.participants.some((row) => row.role === "BUYER");
}

export function stationContextFromProof(
  proof: StationProofSnapshot,
  labels?: { orderLabel?: string; itemSummary?: string },
): StationOrderContext {
  const committed = committedEvidenceCount(proof);
  const alreadyFinalized = proof.status === "FINALIZED";
  const alreadyHasCommittedEvidence = committed > 0;
  const blockReason = blockReasonForProof(proof.status, committed);
  return {
    transactionId: proof.transactionId,
    proofId: proof.proofId,
    proofStatus: proof.status,
    participationPolicy: proof.participationPolicy ?? null,
    orderLabel: labels?.orderLabel ?? formatOrderLabel(proof.transaction.externalReference),
    itemSummary: labels?.itemSummary ?? itemSummaryFromProof(proof),
    alreadyFinalized,
    alreadyHasCommittedEvidence,
    captureReady: blockReason == null && proof.status === "READY_FOR_EVIDENCE" && committed === 0,
    blockReason,
  };
}

export function blockReasonForProof(
  status: string | null | undefined,
  committedEvidence: number,
): StationBlockReason | null {
  if (status === "FINALIZED") {
    return "FINALIZED";
  }
  if (status === "OPEN" || status === "AWAITING_PARTICIPANT") {
    return "NEEDS_PARTICIPANT";
  }
  if (committedEvidence > 0) {
    return "EVIDENCE_ALREADY_COMMITTED";
  }
  if (status === "READY_FOR_EVIDENCE") {
    return null;
  }
  if (status == null || status === "") {
    return null;
  }
  return "NOT_READY";
}

export function errorForBlockReason(reason: StationBlockReason): StationError {
  switch (reason) {
    case "FINALIZED":
      return {
        code: "PROOF_ALREADY_FINALIZED",
        message: "This PackProof is already complete. Identify the next order.",
      };
    case "NEEDS_PARTICIPANT":
      return {
        code: "PROOF_NOT_READY",
        message: "This PackProof is waiting for a buyer before packing evidence can be added.",
      };
    case "EVIDENCE_ALREADY_COMMITTED":
      return {
        code: "EVIDENCE_ALREADY_COMMITTED",
        message: "This order already has packing evidence. Identify the next order.",
      };
    default:
      return {
        code: "PROOF_NOT_READY",
        message: "This PackProof is not ready to pack.",
      };
  }
}

export function stationErrorFromUnknown(error: unknown): StationError {
  if (error && typeof error === "object") {
    const candidate = error as { code?: string; message?: string; status?: number };
    if (candidate.status === 401 || candidate.code === "UNAUTHENTICATED") {
      return {
        code: "UNAUTHENTICATED",
        message: "Session expired. Sign in again, then retry. Recorded video is kept.",
      };
    }
    if (typeof candidate.code === "string" && candidate.code.trim()) {
      return {
        code: candidate.code,
        message: candidate.message || candidate.code,
      };
    }
    if (error instanceof Error && error.message) {
      return { code: "UNKNOWN", message: error.message };
    }
  }
  return { code: "UNKNOWN", message: "Something went wrong." };
}

