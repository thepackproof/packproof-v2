import { sameCaptureAccount, type CapturePhase } from '../../capture/recovery-model';
import type { LocalCapture } from '../../capture';

export type SubmissionStage = 'local' | 'queued' | 'uploading' | 'confirming' | 'review' | 'paused' | 'attention' | 'discard';
export interface SubmissionPresentation {
  stage: SubmissionStage;
  title: string;
  stageLabel: string;
  headline: string;
  detail: string;
  percent: number | null;
  action: 'none' | 'review' | 'resume' | 'sign-in' | 'recovery';
  originalLabel: string;
  originalDetail: string;
  transferLabel: string;
  transferDetail: string;
}

export function originalAvailabilityCopy(available: boolean | undefined): string {
  return available === true ? 'The local original is available on this device.'
    : available === false ? 'The original is not available on this device. Check the recording device and this exact Proof.'
    : 'Local recording availability has not been confirmed. Check saved work and this exact Proof.';
}

/** A read-only projection of the existing operation owner. It never starts or completes work. */
export function submissionPresentation(input: {
  phase: CapturePhase | undefined;
  offline: boolean;
  originalAvailable: boolean | undefined;
  percent: number | null;
}): SubmissionPresentation {
  const confirmedTransport = ['BYTES_RECEIVED', 'PRESERVATION_PENDING', 'FINALIZATION_PENDING', 'SUBMITTED', 'FINALIZED'].includes(input.phase || '');
  const percent = input.phase === 'UPLOADING' && !input.offline && input.percent !== null && Number.isFinite(input.percent)
    ? Math.min(100, Math.max(0, Math.round(input.percent))) : null;
  const originalLabel = input.originalAvailable === true ? 'Original on this device'
    : input.originalAvailable === false ? 'Original unavailable on this device' : 'Local original not checked';
  const originalDetail = originalAvailabilityCopy(input.originalAvailable);
  const base = { originalLabel, originalDetail, percent, transferLabel: confirmedTransport ? 'Recording transferred' : 'Transfer pending',
    transferDetail: confirmedTransport ? 'Transport has completed. Canonical confirmation remains separate.' : 'This operation has not reported a completed transfer.' };
  if (input.phase === 'DISCARD_PENDING') return { ...base, stage: 'discard', title: 'Discard is still pending.', stageLabel: 'DISCARD PENDING', headline: 'Waiting',
    detail: 'The existing discard operation must close before another take can replace it. Open saved work to check its status.', action: 'recovery' };
  if (input.offline) return { ...base, percent: null, stage: 'paused', title: 'Waiting for connection.', stageLabel: 'OFFLINE', headline: 'Paused',
    detail: `${originalDetail} Reconnect to continue this saved operation.`, action: input.phase === 'CONFIRMATION_NEEDED' ? 'review' : 'resume' };
  if (input.phase === 'NEEDS_SIGN_IN') return { ...base, stage: 'attention', title: 'Sign in to continue.', stageLabel: 'SIGN-IN REQUIRED', headline: 'Sign in',
    detail: 'Continue in the original account and environment. The existing operation will be checked before it resumes.', action: 'sign-in' };
  if (input.phase === 'CONFIRMATION_NEEDED') return { ...base, stage: 'review', title: 'Your confirmation is needed.', stageLabel: 'PACKING CONFIRMATION', headline: 'Review needed',
    detail: 'Review this recording and its current packing statement before continuing the saved operation.', action: 'review' };
  if (input.phase === 'NEEDS_ATTENTION') return { ...base, stage: 'attention', title: 'A saved operation needs attention.', stageLabel: 'ACTION NEEDED', headline: 'Check saved work',
    detail: `${originalDetail} Review the operation details below before continuing.`, action: input.originalAvailable === false ? 'recovery' : 'resume' };
  if (input.phase === 'UPLOAD_QUEUED') return { ...base, stage: 'queued', title: 'Your recording is queued.', stageLabel: 'WAITING TO UPLOAD', headline: 'Queued',
    detail: 'The same saved operation is waiting for its upload attempt. Leaving this screen does not create another upload.', action: 'none' };
  if (input.phase === 'UPLOADING') return { ...base, stage: 'uploading', title: 'Saving your Proof.', stageLabel: 'RECORDING TRANSFER', headline: percent === null ? 'Transferring' : `${percent}%`,
    transferLabel: 'Transferring recording', transferDetail: percent === null ? 'Waiting for transport progress.' : `${percent}% transferred. This is not a saved-Proof receipt.`,
    detail: 'Your packing recording is being transferred. You can leave this screen.', action: 'none' };
  if (confirmedTransport) return { ...base, stage: 'confirming', title: 'Confirming your Proof.', stageLabel: 'SERVER CONFIRMATION', headline: 'Confirming',
    detail: 'Your recording reached the server. Waiting for the canonical record and matching preservation receipts.', action: 'none' };
  if (input.phase === 'LOCAL_ONLY' || input.phase === 'RECORDING') return { ...base, stage: 'local',
    title: input.phase === 'RECORDING' ? 'Check the interrupted recording.' : 'Review your recording.', stageLabel: 'LOCAL RECORDING', headline: 'Review needed',
    detail: input.phase === 'RECORDING' ? 'Recording completion has not been confirmed. Inspect any surviving file in the existing recovery task.' : 'This recording has not been submitted. Review the original and its required packing statement.', action: input.phase === 'RECORDING' ? 'recovery' : 'review' };
  return { ...base, stage: 'attention', title: 'Check the saved operation.', stageLabel: 'STATUS UNAVAILABLE', headline: 'Check saved work',
    detail: 'The operation status is unavailable. Open its exact recovery task before starting another take.', action: 'recovery' };
}

/** The legacy transport channel is keyed by Proof. Hide it when operation identity is ambiguous. */
export function operationTransportPercent(input: {
  identity: { userId: string; apiBaseUrl: string; proofId: string; operationId: string };
  captures: LocalCapture[];
  percent: number | null;
}): number | null {
  const operations = new Set(input.captures.filter(row => row.captureUserId === input.identity.userId &&
    row.captureProofId === input.identity.proofId && row.recovery?.proofId === input.identity.proofId &&
    sameCaptureAccount(row.recovery, input.identity.apiBaseUrl, input.identity.userId) && row.recovery.phase === 'UPLOADING')
    .map(row => row.recovery!.operationId));
  return operations.size === 1 && operations.has(input.identity.operationId) ? input.percent : null;
}
