import type { WorkflowType } from "./workflow.js";

export interface RetentionPolicy {
  evidenceExpires: false | { afterFinalizedDays: number | null };
  retainWhileActiveCustody: boolean;
}

export function retentionPolicyFor(workflowType: WorkflowType): RetentionPolicy {
  if (workflowType === "GRADING_SUBMISSION") {
    return {
      evidenceExpires: false,
      retainWhileActiveCustody: true,
    };
  }
  return {
    evidenceExpires: false,
    retainWhileActiveCustody: false,
  };
}
