import type { WorkflowType } from "./workflow.js";

export type RetentionPhase = "ACTIVE" | "CLAIM_WINDOW" | "ARCHIVED" | "LEGAL_HOLD";

export interface RetentionPolicy {
  /**
   * Kept for compatibility with current callers. RC1 intentionally performs no
   * automatic evidence deletion until legal/privacy/partner requirements are
   * approved as an explicit policy revision.
   */
  evidenceExpires: false | { afterFinalizedDays: number | null };
  retainWhileActiveCustody: boolean;
  policyVersion: 1;
  minimumTamperProtectionDays: number;
  automaticEvidenceDeletion: false;
  claimWindowDays: number | null;
  archiveAfterClaimWindow: boolean;
  legalHoldSupported: true;
}

export interface RetentionStateInput {
  finalizedAt: string | Date | null | undefined;
  legalHold: boolean;
  archivedAt?: string | Date | null;
}

const COMMERCE_SALE_RETENTION_V1: RetentionPolicy = Object.freeze({
  evidenceExpires: false,
  retainWhileActiveCustody: false,
  policyVersion: 1,
  minimumTamperProtectionDays: 90,
  automaticEvidenceDeletion: false,
  claimWindowDays: null,
  archiveAfterClaimWindow: false,
  legalHoldSupported: true,
});

const GRADING_SUBMISSION_RETENTION_V1: RetentionPolicy = Object.freeze({
  evidenceExpires: false,
  retainWhileActiveCustody: true,
  policyVersion: 1,
  minimumTamperProtectionDays: 90,
  automaticEvidenceDeletion: false,
  claimWindowDays: null,
  archiveAfterClaimWindow: false,
  legalHoldSupported: true,
});

export function retentionPolicyFor(workflowType: WorkflowType): RetentionPolicy {
  return workflowType === "GRADING_SUBMISSION"
    ? GRADING_SUBMISSION_RETENTION_V1
    : COMMERCE_SALE_RETENTION_V1;
}

/**
 * Retention phase is descriptive, not a deletion scheduler. RC1 will not infer
 * that a Proof may be destroyed merely because time has passed.
 */
export function retentionPhaseFor(input: RetentionStateInput): RetentionPhase {
  if (input.legalHold) {
    return "LEGAL_HOLD";
  }
  if (input.archivedAt) {
    return "ARCHIVED";
  }
  if (input.finalizedAt) {
    return "CLAIM_WINDOW";
  }
  return "ACTIVE";
}
