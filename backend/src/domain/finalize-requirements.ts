import type { ParticipationPolicy } from "./participation.js";
import type { WorkflowType } from "./workflow.js";

export interface FinalizeRequirementInput {
  participationPolicy: ParticipationPolicy;
  workflowType?: WorkflowType | string;
  proofStatus: string;
  hasSeller: boolean;
  hasBuyer: boolean;
  pendingEvidenceCount: number;
  committedEvidenceCount: number;
  committedFulfillmentCaptureCount: number;
  packingAttested: boolean;
  assetCount?: number;
  documentedAssetCount?: number;
  packed?: boolean;
  released?: boolean;
  received?: boolean;
  intakeCaptured?: boolean;
  compared?: boolean;
  processOutput?: boolean;
  returnPacked?: boolean;
  finalReceipt?: boolean;
}

export type FinalizeEvaluation =
  | { ok: true }
  | { ok: false; code: string; message: string };

export function evaluateFinalizeRequirements(
  input: FinalizeRequirementInput,
): FinalizeEvaluation {
  if (!input.hasSeller) {
    return {
      ok: false,
      code: "PROOF_NOT_READY_FOR_FINALIZATION",
      message: "Seller must be joined",
    };
  }
  if (input.pendingEvidenceCount > 0) {
    return {
      ok: false,
      code: "PROOF_NOT_READY_FOR_FINALIZATION",
      message: "Uncommitted evidence must be committed or is not ready",
    };
  }

  if (input.workflowType === "GRADING_SUBMISSION") {
    return evaluateGradingFinalize(input);
  }

  const merchantOptional = input.participationPolicy === "COUNTERPARTY_OPTIONAL";
  if (merchantOptional) {
    return evaluateMerchantFinalize(input);
  }
  return evaluatePeerFinalize(input);
}

function evaluateMerchantFinalize(input: FinalizeRequirementInput): FinalizeEvaluation {
  if (input.proofStatus !== "READY_FOR_EVIDENCE" && input.proofStatus !== "EVIDENCE_COMMITTED") {
    return {
      ok: false,
      code: "PROOF_NOT_READY_FOR_FINALIZATION",
      message: "Merchant Proof is not ready for finalization",
    };
  }
  if (input.committedFulfillmentCaptureCount < 1) {
    return {
      ok: false,
      code: "FULFILLMENT_CAPTURE_REQUIRED",
      message: "Packing evidence is required before this Proof can be finalized.",
    };
  }
  if (!input.packingAttested) {
    return {
      ok: false,
      code: "PROOF_NOT_READY_FOR_FINALIZATION",
      message: "Seller packing attestation is required",
    };
  }
  return { ok: true };
}

function evaluatePeerFinalize(input: FinalizeRequirementInput): FinalizeEvaluation {
  if (!input.hasBuyer) {
    return {
      ok: false,
      code: "PROOF_NOT_READY_FOR_FINALIZATION",
      message: "Seller and buyer must both be joined",
    };
  }
  if (input.proofStatus !== "EVIDENCE_COMMITTED") {
    return {
      ok: false,
      code: "PROOF_NOT_READY_FOR_FINALIZATION",
      message: "Required evidence is not committed",
    };
  }
  if (input.committedEvidenceCount < 1) {
    return {
      ok: false,
      code: "PROOF_NOT_READY_FOR_FINALIZATION",
      message: "Required evidence is not committed",
    };
  }
  return { ok: true };
}

function evaluateGradingFinalize(input: FinalizeRequirementInput): FinalizeEvaluation {
  if (
    input.proofStatus !== "EVIDENCE_COMMITTED" ||
    input.committedEvidenceCount < 1 ||
    !input.assetCount ||
    input.documentedAssetCount !== input.assetCount
  ) {
    return {
      ok: false,
      code: "PROOF_NOT_READY_FOR_FINALIZATION",
      message: "Document every item with committed origin evidence before finalizing",
    };
  }
  if (!input.packed || !input.released) {
    return {
      ok: false,
      code: "PROOF_NOT_READY_FOR_FINALIZATION",
      message: "Document, pack, and hand off items before finalizing",
    };
  }
  if (input.received && !input.finalReceipt) {
    return {
      ok: false,
      code: "PROOF_NOT_READY_FOR_FINALIZATION",
      message: "Record final receipt before finalizing",
    };
  }
  if (
    input.received &&
    (!input.intakeCaptured || !input.compared || !input.processOutput || !input.returnPacked)
  ) {
    return {
      ok: false,
      code: "PROOF_NOT_READY_FOR_FINALIZATION",
      message: "Complete receipt capture, comparison, processing output, and return packing before finalizing",
    };
  }
  return { ok: true };
}
