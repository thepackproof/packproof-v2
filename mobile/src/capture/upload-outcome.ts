import type { CompletionCapture, CompletionProof } from './recover-completion';

export function uploadCompletionConfirmed(capture: CompletionCapture, proof: CompletionProof): boolean {
  return capture.recovery.completionNotificationRequested === true && !capture.recovery.discardRequested &&
    capture.recovery.proofId === proof.proofId && proof.status === 'FINALIZED' &&
    ['SUBMITTED', 'FINALIZED'].includes(capture.recovery.phase) &&
    proof.evidence.some(item => item.evidenceId === capture.uploadEvidenceId && item.validationStatus === 'COMMITTED');
}
