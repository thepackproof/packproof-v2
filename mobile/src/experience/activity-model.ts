import type { CaptureRecoveryState } from "../capture/recovery-model";

export interface ActivityCaptureState {
  interrupted?: boolean;
  byteSize?: number | null;
  durationMs?: number | null;
  localFileAvailable?: boolean;
  recovery?: Pick<CaptureRecoveryState, "phase" | "submitRequested" | "lastError">;
}

/** Recovery grouping never turns scheduled automatic retries into a required user action. */
export function activityGroup(capture: ActivityCaptureState): "attention" | "uploading" | "completed" {
  const state = capture.recovery;
  if (state?.phase === "FINALIZED") return "completed";
  if (!state || !activityRecordingUsable(capture) || ["NEEDS_ATTENTION", "NEEDS_SIGN_IN", "CONFIRMATION_NEEDED"].includes(state.phase)) return "attention";
  if (!state.submitRequested && state.phase === "LOCAL_ONLY") return "attention";
  if (state.lastError && !state.lastError.retryable) return "attention";
  return "uploading";
}

/** Unexpected stop is reviewable only after a completed native recording was validated. */
export function activityRecordingUsable(capture: ActivityCaptureState): boolean {
  return Boolean(capture.recovery && capture.recovery.phase !== "RECORDING" && capture.localFileAvailable !== false && Number(capture.byteSize) > 0 && Number(capture.durationMs) > 0);
}
