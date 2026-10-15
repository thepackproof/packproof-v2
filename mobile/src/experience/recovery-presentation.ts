import { activityGroup, activityRecordingUsable, type ActivityCaptureState } from "./activity-model";

/** Deduplicate only the exact recording represented by a Proof task. Other
 * local originals on that Proof must remain individually discoverable. */
export function recordingRepresentedByTask(capture: { captureProofId?: string; captureSessionId?: string; uri: string; recovery?: { operationId: string } }, tasks: Array<{ proofId: string; action?: { sessionId?: string } }>): boolean {
  return tasks.some(task => task.proofId === capture.captureProofId && Boolean(task.action?.sessionId)
    && [capture.captureSessionId, capture.uri, capture.recovery?.operationId].includes(task.action?.sessionId));
}

/** Failed navigation leaves an update unread; read acknowledgement remains
 * best effort after the authorized destination actually opens. */
export async function markNotificationAfterOpen(open: () => Promise<boolean>, markRead: () => Promise<unknown>): Promise<boolean> {
  if (await open() !== true) return false;
  await markRead().catch(() => undefined);
  return true;
}

export interface RecoveryPresentation {
  title: string;
  message: string;
  action: "resume" | "view" | "refresh" | "details" | null;
  actionLabel: string | null;
  tone: "neutral" | "attention" | "error" | "success";
  live: boolean;
}

/** Android copy only. Existing scoped selectors and the provider still decide
 * whether an operation may run. Transfer progress is never Proof finalization. */
export function recoveryPresentation(capture: ActivityCaptureState & { captureStageId?: string }, options: {
  offline: boolean;
  active: boolean;
  proofFinalized?: boolean;
}): RecoveryPresentation {
  const state = capture.recovery;
  const result = (title: string, message: string, action: RecoveryPresentation["action"], actionLabel: string | null,
    tone: RecoveryPresentation["tone"] = "neutral", live = false): RecoveryPresentation => ({ title, message, action, actionLabel, tone, live });
  if (!state) return result("Check recording details", "The current submission status is unavailable. Check this recording’s recovery options.", "details", "Review recording details", "attention");
  if (state.phase === "FINALIZED") return result(capture.captureStageId ? "Stage recording finalized" : "Your Proof is finalized", "The server confirmed this submission. Local-copy options are available below.", "view", "View Proof", "success");
  if (state.phase === "SUBMITTED") return result("Recording submitted", capture.localFileAvailable === false ? "The original is unavailable on this device. Check the device used to record while preservation is confirmed." : "Your local original is kept until preservation is confirmed.", "view", "View Proof");
  if (state.phase === "DISCARD_PENDING") return result("Discard pending", capture.localFileAvailable === false ? "The original is unavailable here. PackProof still needs to close the incomplete upload." : options.offline ? "Reconnect so PackProof can close this incomplete upload. Its local original is kept until then." : "Closing the incomplete upload before removing the local original.", null, null, "attention");
  if (capture.localFileAvailable === false) return result("Original unavailable here", "Check the device used to record. This device cannot resume the upload without its original.", "details", "Review recovery options", "error");
  if (!activityRecordingUsable(capture)) return result("Recording interrupted", "A complete playable video was not confirmed. Surviving bytes are kept; they cannot be submitted as continuous evidence.", "details", "Review recovery options", "error");
  if (options.proofFinalized && !capture.captureStageId) return result("Check the finalized Proof", "Your local recording is kept while PackProof checks it against the finalized record.", options.offline ? "details" : "resume", options.offline ? "View recording details" : "Check status", "attention");
  if (state.phase === "LOCAL_ONLY" && !state.submitRequested) return result("Recording saved on this device", options.offline ? "Not uploaded yet. Review it now; reconnect to securely confirm and submit." : "Not uploaded yet. Review your recording and required declaration before submitting.", "resume", "Review recording");
  if (state.phase === "NEEDS_SIGN_IN") return result("Sign in to finish your upload", "The original is saved in this account. Reconnect and sign in to resume it.", options.offline ? "details" : "resume", options.offline ? "View recording details" : "Resume upload", "attention");
  if (state.phase === "CONFIRMATION_NEEDED") return result("Confirmation needed", "Your recording is kept. Review and confirm the required declaration on your device.", "resume", "Review confirmation", "attention");
  if (activityGroup(capture) === "attention") return result("Let’s finish your upload", "Your original is kept. Resolve the issue below and resume this same recording.", options.offline ? "details" : "resume", options.offline ? "View recording details" : "Resume upload", "error");
  if (options.offline) return result("Waiting for connection", "Your recording is saved on this device. PackProof can continue when the connection returns.", null, null, "attention");
  if (["BYTES_RECEIVED", "PRESERVATION_PENDING", "FINALIZATION_PENDING"].includes(state.phase)) {
    return result(state.phase === "FINALIZATION_PENDING" ? (capture.captureStageId ? "Finishing this step" : "Finishing your Proof") : "Checking server confirmation",
      state.phase === "FINALIZATION_PENDING" ? "Recording received. Your local original stays until preservation is confirmed."
        : "The upload reached the server. Its commitment and preservation are being checked; your original is kept.", "refresh", "Check status");
  }
  if (state.phase === "UPLOADING" && options.active) return result("Uploading your recording", "Your saved original stays on this device. You can leave this screen while it uploads.", null, null, "neutral", true);
  if (state.lastError?.retryable) return result("Waiting to retry", "The connection interrupted this upload. Your original is kept and the same upload will retry.", null, null, "attention");
  return result("Waiting to upload", "Your recording is queued. Its saved original stays on this device.", null, null);
}
