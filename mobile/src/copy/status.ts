export type ProofStatusValue =
  | "OPEN"
  | "AWAITING_PARTICIPANT"
  | "READY_FOR_EVIDENCE"
  | "EVIDENCE_COMMITTED"
  | "FINALIZED"
  | string;

export type LocalCaptureStatus =
  | "idle"
  | "capturing"
  | "captured"
  | "preparing"
  | "uploading"
  | "uploaded"
  | "committed"
  | "retry";

export type IntegrityState = "none" | "secured" | "finalized";

const PROOF_STATUS_LABELS: Record<string, string> = {
  OPEN: "In progress",
  AWAITING_PARTICIPANT: "Waiting for buyer",
  READY_FOR_EVIDENCE: "Packing evidence needed",
  EVIDENCE_COMMITTED: "Ready to finalize",
  FINALIZED: "Completed",
};

export function proofStatusLabel(status: string | null | undefined): string {
  if (!status) {
    return "In progress";
  }
  return PROOF_STATUS_LABELS[status] ?? humanizeEnum(status);
}

export function humanizeEnum(value: string): string {
  return value
    .replace(/[_-]+/g, " ")
    .toLowerCase()
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

export function captureStatusLabel(status: LocalCaptureStatus): string {
  switch (status) {
    case "capturing":
      return "Recording";
    case "captured":
      return "Recording ready";
    case "preparing":
      return "Preparing";
    case "uploading":
      return "Uploading evidence";
    case "uploaded":
      return "Securing evidence";
    case "committed":
      return "Committed";
    case "retry":
      return "Waiting to upload";
    default:
      return "";
  }
}

export function shipmentStatusLabel(eventType: string | null | undefined): string {
  switch ((eventType ?? "").toUpperCase()) {
    case "LABEL_CREATED":
      return "Label created";
    case "CARRIER_ACCEPTED":
      return "Package accepted";
    case "WEIGHT_RECORDED":
      return "Weight reported";
    case "IN_TRANSIT":
      return "In transit";
    case "ARRIVED_AT_FACILITY":
      return "Arrived at facility";
    case "DEPARTED_FACILITY":
      return "Departed facility";
    case "OUT_FOR_DELIVERY":
      return "Out for delivery";
    case "DELIVERED":
      return "Delivered";
    case "DELIVERY_EXCEPTION":
      return "Delivery exception";
    case "RETURN_TO_SENDER":
      return "Return to sender";
    case "RETURN_IN_TRANSIT":
      return "Return in transit";
    case "RETURN_DELIVERED":
      return "Return delivered";
    case "CARRIER_EVENT":
      return "Carrier update";
    default:
      return eventType ? humanizeEnum(eventType) : "";
  }
}

export function humanProofStatus(input: {
  proofStatus: string | null | undefined;
  captureStatus?: LocalCaptureStatus;
  hasLocalCapture?: boolean;
  captureBelongsToProof?: boolean;
  latestShipmentEventType?: string | null;
  hasShipping?: boolean;
}): string {
  if (input.proofStatus === "FINALIZED") {
    const shipment = shipmentStatusLabel(input.latestShipmentEventType);
    if (shipment && input.latestShipmentEventType && input.latestShipmentEventType !== "LABEL_CREATED") {
      return shipment;
    }
    return "Completed";
  }
  if (input.captureBelongsToProof && input.hasLocalCapture && input.captureStatus && input.captureStatus !== "idle") {
    const capture = captureStatusLabel(input.captureStatus);
    if (capture) {
      return capture;
    }
  }
  if (input.proofStatus === "EVIDENCE_COMMITTED" && input.hasShipping) {
    return "Awaiting shipment";
  }
  return proofStatusLabel(input.proofStatus);
}

export function integrityState(input: {
  proofStatus: string | null | undefined;
  committedEvidenceCount?: number;
}): IntegrityState {
  if (input.proofStatus === "FINALIZED") {
    return "finalized";
  }
  if (input.proofStatus === "EVIDENCE_COMMITTED" || (input.committedEvidenceCount ?? 0) > 0) {
    return "secured";
  }
  return "none";
}

export function invitationStateLabel(state: string | null | undefined): string {
  switch (state) {
    case "SELF":
      return "You";
    case "PARTICIPANT":
      return "Already participating";
    case "INVITED":
      return "Invitation pending";
    case "INELIGIBLE":
      return "Unavailable";
    default:
      return "Invite";
  }
}

export function sourceLabel(source: string | null | undefined, provider?: string | null): string {
  const value = (source ?? "").toUpperCase();
  if (value.includes("MARKETPLACE") || value.includes("COMMERCE") || value === "IMPORTED") {
    return providerDisplay(provider) ? `Imported from ${providerDisplay(provider)}` : "Imported";
  }
  if (value.includes("CARRIER") || value.includes("EASYPOST")) {
    return provider === "easypost" ? "Carrier observation via EasyPost" : "Carrier observation";
  }
  if (value.includes("PARTICIPANT")) {
    return "Participant supplied";
  }
  if (value.includes("PACKPROOF") || value === "SYSTEM" || value === "PROOF") {
    return "PackProof";
  }
  return source ? humanizeEnum(source) : "PackProof";
}

export function providerDisplay(provider: string | null | undefined): string {
  switch ((provider ?? "").toLowerCase()) {
    case "demo-marketplace":
    case "demo_marketplace":
      return "Demo Marketplace";
    case "demo-storefront":
      return "Demo Storefront";
    case "demo-carrier":
      return "Demo Carrier";
    case "easypost":
      return "EasyPost";
    case "ebay":
      return "eBay";
    default:
      return provider ? humanizeEnum(provider) : "";
  }
}

export function sourceExplanation(): string {
  return "Source labels describe where information came from. They are not evidence levels.";
}
