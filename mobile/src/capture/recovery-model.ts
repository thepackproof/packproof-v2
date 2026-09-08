/** Local workflow state is never canonical Proof state. No credentials or biometric samples. */
export type CapturePhase = "RECORDING" | "LOCAL_ONLY" | "UPLOAD_QUEUED" | "UPLOADING" | "BYTES_RECEIVED" | "PRESERVATION_PENDING" | "CONFIRMATION_NEEDED" | "FINALIZATION_PENDING" | "SUBMITTED" | "FINALIZED" | "NEEDS_SIGN_IN" | "NEEDS_ATTENTION";
export interface DurableReceipt {
  operationId: string; eventSha256: string; envelopeSha256: string;
  objectKey: string; objectVersionId: string | null; preservedAt: string; signature: unknown;
}
export interface RecoveryOperation {
  operationId: string | null;
  status: "COMMITTED_PENDING_DURABILITY" | "PRESERVED" | "FAILED" | "LEGACY_UNCONFIRMED";
  receipt: DurableReceipt | null;
}
export interface ProofRecovery {
  proofId: string;
  evidence: Array<RecoveryOperation & { evidenceId: string }>;
  declarations: Array<RecoveryOperation & { attestationId: string }>;
  stages?: Array<RecoveryOperation & { stageId: string }>;
  finalization: RecoveryOperation;
}
export interface CaptureRecoveryState {
  version: 1; operationId: string; apiBaseUrl: string; userId: string; proofId: string;
  stageId?: string;
  phase: CapturePhase; evidenceIdempotencyKey: string; submitRequested: boolean;
  needsSellerAttestation: boolean; attempt: number; nextRetryAt: number | null;
  lastError?: { code: string; message: string; retryable: boolean };
  authorization?: { challengeId: string; signature: string; expiresAt: string; sha256: string };
  declarationReceipt?: unknown;
  preservationReceipt?: DurableReceipt;
  finalizationReceipt?: DurableReceipt;
  lastServerResult?: ProofRecovery;
  updatedAt: string;
}
export function captureRecoveryLabel(phase: CapturePhase): string {
  switch (phase) {
    case "RECORDING": return "Recording on this device";
    case "LOCAL_ONLY": case "UPLOAD_QUEUED": return "Saved on this device. Upload pending.";
    case "UPLOADING": return "Uploading your saved recording";
    case "BYTES_RECEIVED": case "PRESERVATION_PENDING": return "Recording received. Preservation in progress.";
    case "CONFIRMATION_NEEDED": return "Recording preserved. Confirmation needed.";
    case "FINALIZATION_PENDING": return "Finalizing your Proof. Local recording kept.";
    case "SUBMITTED": return "Submitted. Local recording kept until preservation is confirmed.";
    case "FINALIZED": return "Proof finalized and available";
    case "NEEDS_SIGN_IN": return "Your recording is saved. Sign in to continue.";
    case "NEEDS_ATTENTION": return "Your recording is saved. Review the next step.";
  }
}
export function sameCaptureAccount(state: Pick<CaptureRecoveryState, "userId" | "apiBaseUrl">, apiBaseUrl: string, userId: string): boolean {
  return state.userId === userId && state.apiBaseUrl.replace(/\/+$/, "") === apiBaseUrl.replace(/\/+$/, "");
}
export function recoveryRetry(error: unknown, attempt: number, now = Date.now(), random = Math.random()): { retryable: boolean; phase: CapturePhase; code: string; message: string; nextRetryAt: number | null } {
  const input = error as { code?: string; status?: number; message?: string };
  const code = input?.code || "NETWORK";
  const auth = input?.status === 401 || ["UNAUTHENTICATED", "TOKEN_EXPIRED", "SESSION_EXPIRED", "ACCOUNT_CHANGED"].includes(code);
  const intervention = /BIOMETRIC|ATTESTATION_|CAPTURE_SESSION_EXPIRED|CAPTURE_ORIGINAL|CAPABILITY|STORAGE|PROOF_NOT_READY|FULFILLMENT_CAPTURE_REQUIRED/.test(code);
  const retryable = !auth && !intervention && (input?.status == null || input.status === 0 || input.status >= 500 || input.status === 429 || input.status === 408 || code === "PRESERVATION_PENDING");
  return { code, message: input?.message || "Your recording is saved. Reconnect and retry.", retryable,
    phase: auth ? "NEEDS_SIGN_IN" : retryable ? "UPLOAD_QUEUED" : "NEEDS_ATTENTION",
    nextRetryAt: retryable ? now + Math.round(Math.min(300_000, 2_000 * 2 ** Math.min(attempt, 8)) * (0.75 + Math.max(0, Math.min(1, random)) * 0.5)) : null };
}
export function hasDurableReceipt(operation: RecoveryOperation | null | undefined): operation is RecoveryOperation & { receipt: DurableReceipt } {
  return operation?.status === "PRESERVED" && !!operation.receipt?.operationId && !!operation.receipt.eventSha256 && !!operation.receipt.envelopeSha256 && !!operation.receipt.preservedAt && !!operation.receipt.signature;
}
/** Explicit cleanup requires both server receipts, never upload progress or a local completion bit. */
export function mayCleanUpCapture(state: CaptureRecoveryState): boolean {
  const result = state.lastServerResult;
  return state.phase === "FINALIZED" && !!state.preservationReceipt && !!state.finalizationReceipt && !!result &&
    hasDurableReceipt(state.stageId ? result.stages?.find(stage => stage.stageId === state.stageId) : result.finalization) && result.evidence.some(item => hasDurableReceipt(item) && item.receipt.operationId === state.preservationReceipt!.operationId);
}
