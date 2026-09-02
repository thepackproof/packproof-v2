export type CustodyWorkflowType = "COMMERCE_SALE" | "GRADING_SUBMISSION" | string;

export interface CaptureSlotSpec {
  slot: string;
  prompt: string;
  accept: string;
  required: boolean;
}

export function isGradingWorkflow(workflowType?: string | null): boolean {
  return workflowType === "GRADING_SUBMISSION";
}

export function participantFacingRole(workflowType: string | null | undefined, role: string | null | undefined): string {
  const normalized = (role ?? "").toUpperCase();
  if (workflowType === "GRADING_SUBMISSION") {
    if (normalized === "SELLER") {
      return "Originator";
    }
    if (normalized === "BUYER") {
      return "Receiving participant";
    }
  }
  if (normalized === "SELLER") {
    return "Seller";
  }
  if (normalized === "BUYER") {
    return "Buyer";
  }
  return role ? role.replace(/_/g, " ").toLowerCase() : "";
}

export function observationProgressLabel(type: string): string {
  switch (type) {
    case "ORIGIN_CAPTURE":
      return "Documented";
    case "PACKED":
      return "Packed";
    case "RELEASED":
      return "Handed off";
    case "RECEIVED":
      return "Received";
    case "INTAKE_CAPTURE":
      return "Documented on receipt";
    case "PROCESS_OUTPUT":
      return "Processing documented";
    case "RETURN_PACKED":
      return "Return packed";
    case "FINAL_RECEIPT":
      return "Final receipt";
    default:
      return "Recorded";
  }
}

export function captureEvidenceType(input: {
  workflowType?: string | null;
  captureRecipe?: string | null;
  nextActionType?: string | null;
}): "FULFILLMENT_CAPTURE" | "ASSET_CAPTURE" | "PACKING_CAPTURE" | "RECEIPT_CAPTURE" {
  if (input.workflowType !== "GRADING_SUBMISSION") {
    return "FULFILLMENT_CAPTURE";
  }
  switch (input.captureRecipe) {
    case "CARD_STANDARD_V1":
    case "CARD_DETAILED_V1":
      return "ASSET_CAPTURE";
    case "PACKING_STANDARD_V1":
      return "PACKING_CAPTURE";
    case "RECEIPT_STANDARD_V1":
      return "RECEIPT_CAPTURE";
    default:
      break;
  }
  switch (input.nextActionType) {
    case "PACK_ITEMS":
    case "RETURN_PACK":
      return "PACKING_CAPTURE";
    case "RECEIVE_ITEMS":
    case "FINAL_RECEIPT":
      return "RECEIPT_CAPTURE";
    default:
      return "ASSET_CAPTURE";
  }
}

export function captureSlots(recipe?: string | null): CaptureSlotSpec[] {
  switch (recipe) {
    case "CARD_STANDARD_V1":
    case "CARD_DETAILED_V1":
      return [
        { slot: "FRONT", prompt: "Capture the front", accept: "image/*", required: true },
        { slot: "BACK", prompt: "Capture the back", accept: "image/*", required: true },
      ];
    case "PACKING_STANDARD_V1":
      return [
        { slot: "PACKING_VIDEO", prompt: "Record packing", accept: "video/*,image/*", required: true },
      ];
    case "RECEIPT_STANDARD_V1":
      return [
        { slot: "PACKAGE", prompt: "Capture the package as received", accept: "image/*", required: true },
        { slot: "ITEM_FRONT", prompt: "Capture the front as received", accept: "image/*", required: true },
        { slot: "ITEM_BACK", prompt: "Capture the back as received", accept: "image/*", required: true },
      ];
    default:
      return [];
  }
}

export function workflowActionFor(nextActionType: string | null | undefined):
  | "document"
  | "pack"
  | "handoff"
  | "receive"
  | "compare"
  | "output"
  | "return-pack"
  | "final-receipt"
  | null {
  switch (nextActionType) {
    case "CAPTURE_ASSET":
      return "document";
    case "PACK_ITEMS":
      return "pack";
    case "HAND_OFF":
      return "handoff";
    case "RECEIVE_ITEMS":
      return "receive";
    case "COMPARE":
      return "compare";
    case "DOCUMENT_OUTPUT":
      return "output";
    case "RETURN_PACK":
      return "return-pack";
    case "FINAL_RECEIPT":
      return "final-receipt";
    default:
      return null;
  }
}

export function nextActionNeedsCapture(nextActionType: string | null | undefined): boolean {
  return (
    nextActionType === "CAPTURE_ASSET" ||
    nextActionType === "PACK_ITEMS" ||
    nextActionType === "RETURN_PACK" ||
    nextActionType === "FINAL_RECEIPT"
  );
}

export function assetItemLabel(asset: { label?: string | null; labelIndex?: number | null }): string {
  const labeled = asset.label?.trim();
  if (labeled) {
    return labeled;
  }
  return `Item ${asset.labelIndex ?? 1}`;
}

export function inviteParticipantTitle(workflowType?: string | null): string {
  return isGradingWorkflow(workflowType) ? "Add receiving participant" : "Add buyer";
}

export function inviteParticipantHint(workflowType?: string | null): string {
  return isGradingWorkflow(workflowType)
    ? "Search PackProof username. Joining records the receiving participant; it does not confirm the item."
    : "Search PackProof username. Joining records participation; it does not confirm the item.";
}

export function continuityResultLabel(result?: string | null): string {
  switch (result) {
    case "CONSISTENT":
      return "Consistent";
    case "INCONCLUSIVE":
      return "Inconclusive";
    case "MATERIAL_DIFFERENCE":
      return "Material difference";
    default:
      return "Not evaluated";
  }
}

export function comparisonSlotLabel(slot: string): string {
  switch (slot) {
    case "FRONT":
    case "ITEM_FRONT":
      return "Front";
    case "BACK":
    case "ITEM_BACK":
      return "Back";
    case "PACKAGE":
      return "Package";
    default:
      return slot.replace(/_/g, " ").toLowerCase();
  }
}

export interface ComparisonPair {
  slot: string;
  originEvidenceId: string | null;
  receivedEvidenceId: string | null;
}

export function comparisonPairs(input: {
  continuity?: Array<{ evidencePairs?: ComparisonPair[] }> | null;
  observations?: Array<{
    type: string;
    evidence?: Array<{ evidenceId: string; slot: string }>;
  }> | null;
}): ComparisonPair[] {
  const latest = input.continuity?.[input.continuity.length - 1];
  if (latest?.evidencePairs && latest.evidencePairs.length > 0) {
    return visualPairs(latest.evidencePairs);
  }
  const origin = input.observations?.find((row) => row.type === "ORIGIN_CAPTURE");
  const received =
    input.observations?.find((row) => row.type === "INTAKE_CAPTURE") ??
    input.observations?.find((row) => row.type === "RECEIVED");
  if (!origin && !received) {
    return [];
  }
  const originMap = slotMap(origin?.evidence ?? []);
  const receivedMap = slotMap(received?.evidence ?? []);
  const slots = new Set([...originMap.keys(), ...receivedMap.keys()]);
  if (slots.size === 0) {
    slots.add("FRONT");
    slots.add("BACK");
  }
  return visualPairs(
    [...slots].sort().map((slot) => ({
      slot,
      originEvidenceId: originMap.get(slot) ?? null,
      receivedEvidenceId: receivedMap.get(slot) ?? null,
    })),
  );
}

function slotMap(evidence: Array<{ evidenceId: string; slot: string }>): Map<string, string> {
  const mapped = new Map<string, string>();
  for (const row of evidence) {
    mapped.set(normalizeComparisonSlot(row.slot), row.evidenceId);
  }
  return mapped;
}

function normalizeComparisonSlot(slot: string): string {
  if (slot === "ITEM_FRONT") {
    return "FRONT";
  }
  if (slot === "ITEM_BACK") {
    return "BACK";
  }
  return slot;
}

function visualPairs(pairs: ComparisonPair[]): ComparisonPair[] {
  const normalized = pairs.map((pair) => ({
    ...pair,
    slot: normalizeComparisonSlot(pair.slot),
  }));
  const preferred = ["FRONT", "BACK"].flatMap((slot) =>
    normalized.filter((pair) => pair.slot === slot),
  );
  return preferred.length > 0 ? preferred : normalized;
}
