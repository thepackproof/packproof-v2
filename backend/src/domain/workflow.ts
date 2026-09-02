import { DomainError } from "./errors.js";

export const WORKFLOW_TYPES = ["COMMERCE_SALE", "GRADING_SUBMISSION"] as const;
export type WorkflowType = (typeof WORKFLOW_TYPES)[number];
export const DEFAULT_WORKFLOW_TYPE: WorkflowType = "COMMERCE_SALE";

export const OBSERVATION_TYPES = [
  "ORIGIN_CAPTURE",
  "PACKED",
  "RELEASED",
  "RECEIVED",
  "INTAKE_CAPTURE",
  "PROCESS_OUTPUT",
  "RETURN_PACKED",
  "FINAL_RECEIPT",
] as const;
export type ObservationType = (typeof OBSERVATION_TYPES)[number];

export const TRANSFER_TYPES = ["SHIPMENT", "HANDOFF", "INTERNAL", "UNKNOWN"] as const;
export type TransferType = (typeof TRANSFER_TYPES)[number];

export const TRANSFER_STATUSES = ["OPEN", "RECEIVED"] as const;
export type TransferStatus = (typeof TRANSFER_STATUSES)[number];

export const CONTINUITY_RESULTS = [
  "NOT_EVALUATED",
  "CONSISTENT",
  "INCONCLUSIVE",
  "MATERIAL_DIFFERENCE",
] as const;
export type ContinuityResult = (typeof CONTINUITY_RESULTS)[number];

export const ACCESS_LINK_SCOPES = ["STATUS_ONLY", "SUMMARY", "EVIDENCE_VIEW"] as const;
export type AccessLinkScope = (typeof ACCESS_LINK_SCOPES)[number];

export const NEXT_ACTION_TYPES = [
  "CAPTURE_ASSET",
  "PACK_ITEMS",
  "HAND_OFF",
  "WAIT_FOR_RECEIPT",
  "RECEIVE_ITEMS",
  "COMPARE",
  "DOCUMENT_OUTPUT",
  "RETURN_PACK",
  "FINAL_RECEIPT",
  "FINALIZE",
  "COMPLETE",
] as const;
export type NextActionType = (typeof NEXT_ACTION_TYPES)[number];

export const WORKFLOW_STAGES = [
  "AWAITING_DOCUMENTATION",
  "DOCUMENTING",
  "AWAITING_PACK",
  "AWAITING_HANDOFF",
  "IN_TRANSIT",
  "AWAITING_RECEIPT_CAPTURE",
  "AWAITING_COMPARE",
  "AWAITING_PROCESS_OUTPUT",
  "AWAITING_RETURN",
  "AWAITING_FINAL_RECEIPT",
  "READY_TO_FINALIZE",
  "COMPLETE",
] as const;
export type WorkflowStage = (typeof WORKFLOW_STAGES)[number];

export const CUSTODY_OUTCOMES = [
  "IN_PROGRESS",
  "TRANSFER_UNOBSERVED",
  "ORIGIN_RECORD_FINALIZED",
  "ROUND_TRIP_COMPLETE",
] as const;
export type CustodyOutcome = (typeof CUSTODY_OUTCOMES)[number];

export interface NextAction {
  type: NextActionType;
  title: string;
  hint: string;
  assetId?: string;
  captureRecipe?: string;
  transferId?: string;
  actorRole: "SELLER" | "BUYER" | "ANY";
}

export interface WorkflowPolicyView {
  workflowType: WorkflowType;
  workflowStage: WorkflowStage;
  nextAction: NextAction | null;
  canFinalize: boolean;
  validObservationTypes: ObservationType[];
  custodyOutcome: CustodyOutcome | null;
}

export interface WorkflowFacts {
  workflowType: WorkflowType;
  proofStatus: string;
  actorRole: string | null;
  assets: Array<{ id: string; labelIndex: number }>;
  documentedAssetIds: string[];
  packedAssetIds: string[];
  originObservationId: string | null;
  packed: boolean;
  released: boolean;
  received: boolean;
  intakeCaptured: boolean;
  compared: boolean;
  processOutput: boolean;
  returnPacked: boolean;
  finalReceipt: boolean;
  openTransferId: string | null;
  committedEvidenceCount: number;
  packingAttested: boolean;
  fulfillmentCaptureCount: number;
}

export function isWorkflowType(value: unknown): value is WorkflowType {
  return typeof value === "string" && (WORKFLOW_TYPES as readonly string[]).includes(value);
}

export function requireWorkflowType(
  value: unknown,
  fallback: WorkflowType = DEFAULT_WORKFLOW_TYPE,
): WorkflowType {
  if (value == null || value === "") {
    return fallback;
  }
  if (!isWorkflowType(value)) {
    throw new DomainError(
      "INVALID_WORKFLOW_TYPE",
      "workflowType must be COMMERCE_SALE or GRADING_SUBMISSION",
      400,
    );
  }
  return value;
}

export function requireObservationType(value: unknown): ObservationType {
  if (typeof value !== "string" || !(OBSERVATION_TYPES as readonly string[]).includes(value)) {
    throw new DomainError("INVALID_OBSERVATION_TYPE", "observation type is not allowed", 400);
  }
  return value as ObservationType;
}

export function requireTransferType(value: unknown): TransferType {
  if (value == null || value === "") {
    return "SHIPMENT";
  }
  if (typeof value !== "string" || !(TRANSFER_TYPES as readonly string[]).includes(value)) {
    throw new DomainError("INVALID_TRANSFER_TYPE", "transfer type is not allowed", 400);
  }
  return value as TransferType;
}

export function requireAccessLinkScope(value: unknown): AccessLinkScope {
  if (value == null || value === "") {
    return "SUMMARY";
  }
  if (typeof value !== "string" || !(ACCESS_LINK_SCOPES as readonly string[]).includes(value)) {
    throw new DomainError("INVALID_ACCESS_LINK_SCOPE", "access link scope is not allowed", 400);
  }
  return value as AccessLinkScope;
}

export function requireContinuityResult(value: unknown): ContinuityResult {
  if (typeof value !== "string" || !(CONTINUITY_RESULTS as readonly string[]).includes(value)) {
    throw new DomainError("INVALID_CONTINUITY_RESULT", "continuity result is not allowed", 400);
  }
  return value as ContinuityResult;
}

export function evaluateWorkflowPolicy(facts: WorkflowFacts): WorkflowPolicyView {
  const policy = facts.workflowType === "GRADING_SUBMISSION"
    ? evaluateGradingPolicy(facts)
    : evaluateCommercePolicy(facts);
  return { ...policy, custodyOutcome: custodyOutcomeFor(facts) };
}

function evaluateCommercePolicy(facts: WorkflowFacts): Omit<WorkflowPolicyView, "custodyOutcome"> {
  const validObservationTypes: ObservationType[] = ["PACKED", "RELEASED", "RECEIVED"];
  if (facts.proofStatus === "FINALIZED") {
    return {
      workflowType: "COMMERCE_SALE",
      workflowStage: "COMPLETE",
      nextAction: {
        type: "COMPLETE",
        title: "PackProof finalized",
        hint: "The evidence record is sealed. Later carrier observations do not change it.",
        actorRole: "ANY",
      },
      canFinalize: false,
      validObservationTypes,
    };
  }
  const seller = facts.actorRole === "SELLER";
  if (seller && facts.committedEvidenceCount < 1 && facts.fulfillmentCaptureCount < 1) {
    return {
      workflowType: "COMMERCE_SALE",
      workflowStage: "AWAITING_PACK",
      nextAction: {
        type: "PACK_ITEMS",
        title: "Record packing",
        hint: "Record the item being packed and the package being sealed.",
        captureRecipe: "PACKING_STANDARD_V1",
        actorRole: "SELLER",
      },
      canFinalize: false,
      validObservationTypes,
    };
  }
  const canFinalize =
    seller &&
    (facts.fulfillmentCaptureCount > 0 || facts.packed) &&
    (facts.packingAttested || facts.packed);
  return {
    workflowType: "COMMERCE_SALE",
    workflowStage: canFinalize ? "READY_TO_FINALIZE" : "AWAITING_PACK",
    nextAction: canFinalize
      ? {
          type: "FINALIZE",
          title: "Finalize Proof",
          hint: "Review the record, then seal it. This cannot be undone.",
          actorRole: "SELLER",
        }
      : seller
        ? {
            type: "PACK_ITEMS",
            title: "Record packing",
            hint: "Record the item being packed and the package being sealed.",
            captureRecipe: "PACKING_STANDARD_V1",
            actorRole: "SELLER",
          }
        : {
            type: "COMPLETE",
            title: "View Proof",
            hint: "This is the shared evidence record.",
            actorRole: "BUYER",
          },
    canFinalize,
    validObservationTypes,
  };
}

function evaluateGradingPolicy(facts: WorkflowFacts): Omit<WorkflowPolicyView, "custodyOutcome"> {
  const validObservationTypes: ObservationType[] = [...OBSERVATION_TYPES];
  if (facts.proofStatus === "FINALIZED") {
    return {
      workflowType: "GRADING_SUBMISSION",
      workflowStage: "COMPLETE",
      nextAction: {
        type: "COMPLETE",
        title: "PackProof finalized",
        hint: "The evidence record is sealed.",
        actorRole: "ANY",
      },
      canFinalize: false,
      validObservationTypes,
    };
  }

  const undocumented = nextUndocumentedAsset(facts.assets, facts.documentedAssetIds);
  if (facts.assets.length === 0 || undocumented) {
    const index = undocumented?.index ?? 1;
    const total = Math.max(facts.assets.length, undocumented?.total ?? 1);
    return {
      workflowType: "GRADING_SUBMISSION",
      workflowStage: facts.assets.length === 0 ? "AWAITING_DOCUMENTATION" : "DOCUMENTING",
      nextAction: {
        type: "CAPTURE_ASSET",
        title: `Document item ${index} of ${total}`,
        hint: "Capture the front and back of this item.",
        assetId: undocumented?.id,
        captureRecipe: "CARD_STANDARD_V1",
        actorRole: "SELLER",
      },
      canFinalize: false,
      validObservationTypes,
    };
  }

  if (!facts.packed) {
    return {
      workflowType: "GRADING_SUBMISSION",
      workflowStage: "AWAITING_PACK",
      nextAction: {
        type: "PACK_ITEMS",
        title: "Document packing",
        hint: "Record the items being packed for handoff.",
        captureRecipe: "PACKING_STANDARD_V1",
        actorRole: "SELLER",
      },
      canFinalize: false,
      validObservationTypes,
    };
  }

  if (!facts.released) {
    return {
      workflowType: "GRADING_SUBMISSION",
      workflowStage: "AWAITING_HANDOFF",
      nextAction: {
        type: "HAND_OFF",
        title: "Hand off",
        hint: "Record that the packed items left your custody.",
        actorRole: "SELLER",
      },
      canFinalize: false,
      validObservationTypes,
    };
  }

  if (!facts.received) {
    if (facts.actorRole === "BUYER") {
      return {
        workflowType: "GRADING_SUBMISSION",
        workflowStage: "IN_TRANSIT",
        nextAction: {
          type: "RECEIVE_ITEMS",
          title: "Receive items",
          hint: "Record that the package arrived.",
          captureRecipe: "RECEIPT_STANDARD_V1",
          transferId: facts.openTransferId ?? undefined,
          actorRole: "BUYER",
        },
        canFinalize: originOnlyFinalizeReady(facts),
        validObservationTypes,
      };
    }
    return {
      workflowType: "GRADING_SUBMISSION",
      workflowStage: "IN_TRANSIT",
      nextAction: {
        type: "WAIT_FOR_RECEIPT",
        title: "Waiting for receipt",
        hint: "No PackProof observation exists for this interval yet.",
        transferId: facts.openTransferId ?? undefined,
        actorRole: "SELLER",
      },
      canFinalize: originOnlyFinalizeReady(facts),
      validObservationTypes,
    };
  }

  if (!facts.intakeCaptured) {
    return {
      workflowType: "GRADING_SUBMISSION",
      workflowStage: "AWAITING_RECEIPT_CAPTURE",
      nextAction: {
        type: "CAPTURE_ASSET",
        title: "Document received items",
        hint: "Capture the front and back as received.",
        captureRecipe: "RECEIPT_STANDARD_V1",
        actorRole: "BUYER",
      },
      canFinalize: false,
      validObservationTypes,
    };
  }

  if (!facts.compared) {
    return {
      workflowType: "GRADING_SUBMISSION",
      workflowStage: "AWAITING_COMPARE",
      nextAction: {
        type: "COMPARE",
        title: "Compare",
        hint: "Review before-sending evidence beside when-received evidence.",
        actorRole: "ANY",
      },
      canFinalize: false,
      validObservationTypes,
    };
  }

  if (!facts.processOutput) {
    return {
      workflowType: "GRADING_SUBMISSION",
      workflowStage: "AWAITING_PROCESS_OUTPUT",
      nextAction: {
        type: "DOCUMENT_OUTPUT",
        title: "Document processing output",
        hint: "Record the grading or processing result before return packing.",
        actorRole: "BUYER",
      },
      canFinalize: false,
      validObservationTypes,
    };
  }

  if (!facts.returnPacked && facts.actorRole === "BUYER") {
    return {
      workflowType: "GRADING_SUBMISSION",
      workflowStage: "AWAITING_RETURN",
      nextAction: {
        type: "RETURN_PACK",
        title: "Document return packing",
        hint: "Record packing if items are being returned.",
        captureRecipe: "PACKING_STANDARD_V1",
        actorRole: "BUYER",
      },
      canFinalize: false,
      validObservationTypes,
    };
  }

  if (!facts.finalReceipt) {
    return {
      workflowType: "GRADING_SUBMISSION",
      workflowStage: "AWAITING_FINAL_RECEIPT",
      nextAction: {
        type: "FINAL_RECEIPT",
        title: "Record final receipt",
        hint: "Record that the items are back with the originator, or complete this loop.",
        actorRole: "SELLER",
      },
      canFinalize: false,
      validObservationTypes,
    };
  }

  return {
    workflowType: "GRADING_SUBMISSION",
    workflowStage: "READY_TO_FINALIZE",
    nextAction: {
      type: "FINALIZE",
      title: "Finalize Proof",
      hint: "Review the record, then seal it. This cannot be undone.",
      actorRole: "SELLER",
    },
    canFinalize: facts.actorRole === "SELLER",
    validObservationTypes,
  };
}

export function custodyOutcomeFor(input: {
  workflowType: WorkflowType;
  proofStatus: string;
  released: boolean;
  received: boolean;
  finalReceipt: boolean;
}): CustodyOutcome | null {
  if (input.workflowType !== "GRADING_SUBMISSION") {
    return null;
  }
  if (input.proofStatus === "FINALIZED") {
    return input.received && input.finalReceipt
      ? "ROUND_TRIP_COMPLETE"
      : "ORIGIN_RECORD_FINALIZED";
  }
  if (input.received && input.finalReceipt) {
    return "ROUND_TRIP_COMPLETE";
  }
  if (input.released && !input.received) {
    return "TRANSFER_UNOBSERVED";
  }
  return "IN_PROGRESS";
}

export function nextUndocumentedAsset(
  assets: Array<{ id: string; labelIndex: number }>,
  documentedAssetIds: Iterable<string>,
): { id: string; index: number; total: number } | null {
  const documented = new Set(documentedAssetIds);
  const ordered = [...assets].sort((a, b) => a.labelIndex - b.labelIndex);
  const missing = ordered.find((asset) => !documented.has(asset.id));
  if (!missing) {
    return null;
  }
  return { id: missing.id, index: missing.labelIndex, total: ordered.length };
}

function originOnlyFinalizeReady(facts: WorkflowFacts): boolean {
  return (
    facts.actorRole === "SELLER" &&
    facts.packed &&
    facts.released &&
    !facts.received
  );
}

export function continuitySummary(result: ContinuityResult): string {
  switch (result) {
    case "MATERIAL_DIFFERENCE":
      return "Evidence at the receiving observation contains a material visual difference from the origin observation.";
    case "CONSISTENT":
      return "The available observations are materially consistent.";
    case "INCONCLUSIVE":
      return "The available observations are inconclusive.";
    default:
      return "Continuity has not been evaluated.";
  }
}

export function missingObservationCopy(): string {
  return "No PackProof observation exists for this interval.";
}

export function observationLabel(type: ObservationType): string {
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

export function participantFacingRole(workflowType: WorkflowType, role: string): string {
  if (workflowType !== "GRADING_SUBMISSION") {
    return role === "BUYER" ? "Buyer" : role === "SELLER" ? "Seller" : role;
  }
  if (role === "SELLER") {
    return "Originator";
  }
  if (role === "BUYER") {
    return "Receiving participant";
  }
  return role;
}

export function rolesAllowedToSubmitEvidence(
  workflowType: WorkflowType,
  evidenceType: string,
): Array<"SELLER" | "BUYER"> {
  if (workflowType === "GRADING_SUBMISSION") {
    if (evidenceType === "RECEIPT_CAPTURE") {
      return ["BUYER"];
    }
    if (evidenceType === "ASSET_CAPTURE") {
      return ["SELLER", "BUYER"];
    }
    return ["SELLER"];
  }
  return ["SELLER"];
}

export function observationAllowedForRole(
  type: ObservationType,
  role: string,
): boolean {
  switch (type) {
    case "ORIGIN_CAPTURE":
    case "PACKED":
    case "RELEASED":
    case "FINAL_RECEIPT":
      return role === "SELLER";
    case "RECEIVED":
    case "INTAKE_CAPTURE":
    case "PROCESS_OUTPUT":
    case "RETURN_PACKED":
      return role === "BUYER";
    default:
      return false;
  }
}
