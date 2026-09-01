export type StationBlockReason =
  | "FINALIZED"
  | "NEEDS_PARTICIPANT"
  | "EVIDENCE_ALREADY_COMMITTED"
  | "NOT_READY";

export function normalizeStationReference(raw: string | null | undefined): string {
  let value = String(raw ?? "")
    .replace(/[\u0000-\u001F\u007F]/g, "")
    .trim();
  value = value.replace(/^#+/, "").trim();
  if (/^\][A-Za-z][0-9]/.test(value)) {
    value = value.slice(3).trim();
  }
  return value;
}

export function formatTrackingHint(tracking: string | null | undefined): string | null {
  const cleaned = String(tracking ?? "").replace(/\s+/g, "");
  if (!cleaned) {
    return null;
  }
  const tail = cleaned.slice(-4);
  return `Tracking ending ${tail}`;
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
