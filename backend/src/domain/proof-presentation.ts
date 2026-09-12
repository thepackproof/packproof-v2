/** Shared, platform-independent navigation contract. Server facts remain authoritative. */
export type ProofNextActionType = 'VIEW_PROOF' | 'ACCEPT_INVITATION' | 'RECORD_PACKING' | 'REVIEW_CONFIRM' | 'RESUME_UPLOAD' | 'CONTINUE_RECORDING' | 'RECOVER_RECORDING' | 'WORKFLOW_ACTION';
export interface ProofPresentation {
  proofId: string;
  displayStatus: string;
  needsAttention: boolean;
  nextAction: { type: ProofNextActionType; label: string };
  completed: boolean;
  canContribute?: boolean;
  shipmentStatus: string | null;
  share: { available: boolean; reason: string | null };
  diagnostic: string | null;
}
export interface ProofPresentationInput {
  proofId: string;
  status: string;
  role?: string | null;
  workflowType?: string;
  finalizedAt?: string | null;
  invitationId?: string | null;
  committedEvidenceCount?: number;
  fulfillmentCaptureCount?: number;
  packingAttested?: boolean;
  participationPolicy?: string;
  orderCancelled?: boolean;
  shipmentStatus?: string | null;
  canShare?: boolean;
  workflowNextAction?: { type: string; title: string; actorRole: string } | null;
  pendingStage?: { type: string; hasEvidence: boolean } | null;
}
export interface LocalProofWork {
  state: 'UPLOADING' | 'UPLOAD_INTERRUPTED' | 'CAPTURE_UNFINISHED' | 'CONFIRMATION_NEEDED';
  canResumeCapture?: boolean;
  progress?: number;
}
const states = new Set(['OPEN', 'AWAITING_PARTICIPANT', 'READY_FOR_EVIDENCE', 'EVIDENCE_COMMITTED', 'FINALIZED']);
export function classifyProofPresentation(input: ProofPresentationInput): ProofPresentation {
  const result: ProofPresentation = {
    proofId: input.proofId, displayStatus: 'Proof status unavailable', needsAttention: false,
    nextAction: { type: 'VIEW_PROOF', label: 'View Proof' },
    completed: input.status === 'FINALIZED' && Boolean(input.finalizedAt),
    shipmentStatus: input.shipmentStatus ?? null,
    share: { available: Boolean(input.proofId) && (input.canShare ?? input.role === 'SELLER') && !input.invitationId,
      reason: !input.proofId ? 'Connect to create a share link' : input.invitationId ? 'Accept the invitation to share this Proof' : (input.canShare ?? input.role === 'SELLER') ? null : 'The seller manages sharing for this Proof' },
    canContribute: Boolean(input.pendingStage && input.role) || ((input.status === 'READY_FOR_EVIDENCE' || input.status === 'EVIDENCE_COMMITTED') && (input.role === 'SELLER' || (input.workflowType === 'GRADING_SUBMISSION' && (input.workflowNextAction?.actorRole === input.role || input.workflowNextAction?.actorRole === 'ANY')))),
    diagnostic: null,
  };
  const action = (displayStatus: string, type: ProofNextActionType, label: string) => ({...result, displayStatus, needsAttention: true, nextAction: {type, label}});
  if (input.invitationId) return action('Invitation received', 'ACCEPT_INVITATION', 'Accept invitation');
  if (!states.has(input.status)) return {...result, displayStatus: ({CANCELLED:'Proof cancelled',EXPIRED:'Proof expired',CLOSED:'Proof closed'} as Record<string,string>)[input.status] ?? result.displayStatus,
    diagnostic: `UNRECOGNIZED_PROOF_STATE:${input.status}`};
  if (input.status === 'FINALIZED' && !input.finalizedAt) return {...result, diagnostic:'FINALIZED_TIMESTAMP_MISSING'};
  if (input.pendingStage && input.role) {
    const stageName = ({RECEIPT:'Receipt', RETURN_PACKING:'Return packing', RETURN_RECEIPT:'Return receipt'} as Record<string,string>)[input.pendingStage.type] ?? 'Evidence';
    return action(`${stageName} ${input.pendingStage.hasEvidence ? 'confirmation' : 'recording'} needed`, 'WORKFLOW_ACTION', input.pendingStage.hasEvidence ? 'Review and confirm' : `Record ${stageName.toLowerCase()}`);
  }
  if (result.completed) return {...result, displayStatus:'Proof completed'};
  if (input.orderCancelled) return {...result, displayStatus:'Order cancelled'};
  if (!input.role || input.status === 'OPEN' || input.status === 'AWAITING_PARTICIPANT') return {...result, displayStatus:'Waiting for participant'};
  if (input.workflowType && !['COMMERCE_SALE','GRADING_SUBMISSION'].includes(input.workflowType)) return {...result, diagnostic:`UNRECOGNIZED_WORKFLOW:${input.workflowType}`};
  if (input.workflowType === 'GRADING_SUBMISSION') {
    const next = input.workflowNextAction;
    if (next && !['COMPLETE','WAIT_FOR_RECEIPT'].includes(next.type) && (next.actorRole === input.role || next.actorRole === 'ANY')) return action(next.title, 'WORKFLOW_ACTION', next.title);
    return {...result, displayStatus:'Waiting for participant'};
  }
  if (input.role !== 'SELLER') return {...result, displayStatus:'Waiting for participant'};
  // Any old evidence is insufficient: packing requires the qualifying server-committed capture.
  if ((input.fulfillmentCaptureCount ?? 0) < 1) return action('Recording needed', 'RECORD_PACKING', 'Record packing');
  return action('Confirmation needed', 'REVIEW_CONFIRM', 'Review and confirm');
}
/** Local recovery changes presentation only; it never commits or finalizes a Proof. */
export function withLocalProofWork(presentation: ProofPresentation, work?: LocalProofWork | null): ProofPresentation {
  if (!work || presentation.nextAction.type === 'ACCEPT_INVITATION' || !presentation.canContribute || presentation.diagnostic) return presentation;
  if (work.state === 'UPLOADING') {
    const progress = typeof work.progress === 'number' && Number.isFinite(work.progress)
      ? Math.round(Math.max(0, Math.min(100, work.progress)))
      : null;
    return {
      ...presentation,
      displayStatus: progress !== null && progress >= 100 ? 'Upload complete · sealing Proof…' : progress !== null ? `Uploading · ${progress}%` : 'Uploading',
      needsAttention: false,
      nextAction: { type: 'VIEW_PROOF', label: 'View Proof' },
    };
  }
  if (work.state === 'UPLOAD_INTERRUPTED') return {...presentation,displayStatus:'Upload interrupted',needsAttention:true,nextAction:{type:'RESUME_UPLOAD',label:'Resume upload'}};
  if (work.state === 'CAPTURE_UNFINISHED') return {...presentation,displayStatus:'Recording unfinished',needsAttention:true,nextAction:{type:work.canResumeCapture?'CONTINUE_RECORDING':'RECOVER_RECORDING',label:work.canResumeCapture?'Continue recording':'Review interrupted recording'}};
  return {...presentation,displayStatus:'Confirmation needed',needsAttention:true,nextAction:{type:'REVIEW_CONFIRM',label:'Review and confirm'}};
}
