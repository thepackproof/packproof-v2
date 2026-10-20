import type { LocalCapture } from '../capture';

export function requiresRecordingRecovery(capture: LocalCapture | null | undefined): boolean {
  return Boolean(capture && (capture.interrupted || capture.recovery?.phase === 'RECORDING' || capture.localFileAvailable === false));
}

/** A camera-open request cannot silently replace an already retained take. */
export function assertRecordingReplacement(capture: LocalCapture | null, proofId: string, confirmedUri?: string): void {
  if (!capture) return;
  if (capture.captureProofId && capture.captureProofId !== proofId)
    throw new Error('Return to the original Proof to review the saved recording.');
  if (capture.uri !== confirmedUri)
    throw new Error('Your recording is kept. Review it or explicitly choose Retake before opening another recording.');
  if(capture.replacement?.decision==='pending')throw new Error('Choose which take to keep before recording another.');
  if (capture.uploadEvidenceId || capture.recovery?.submitRequested)
    throw new Error('This recording has entered submission. Check its existing save before recording again.');
}

export function assertContinuousRecording(capture: LocalCapture): void {
  if(capture.replacement && capture.replacement.decision!=='accepted')throw new Error('Choose which take to keep before submitting.');
  if (requiresRecordingRecovery(capture)) throw Object.assign(new Error('This interrupted take is kept for inspection. Record a new continuous take before submitting.'), { code: 'CAPTURE_ORIGINAL_INTERRUPTED' });
}
