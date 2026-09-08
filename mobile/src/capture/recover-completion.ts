import { hasDurableReceipt, recoveryRetry, type CaptureRecoveryState, type ProofRecovery } from "./recovery-model";
import { requiresDurableCaptureReceipts } from "./capabilities";

export interface CompletionProof {
  proofId: string; status: string; participationPolicy?: string | null;
  evidence: Array<{ evidenceId: string; validationStatus: string }>;
  attestations?: Array<{ attestedBy: string; relatedEvidenceId?: string | null; authorization?: { signatureVerification?: string; method?: string } }>;
}
export interface CompletionCapture {
  recovery: CaptureRecoveryState; captureSha256?: string; uploadEvidenceId?: string;
}
export interface CompletionDeps {
  assertAccount(): void;
  save(): Promise<void>;
  getProof(): Promise<CompletionProof>;
  getRecovery(): Promise<ProofRecovery>;
  getCapabilities?(): Promise<unknown>;
  initialize(key: string): Promise<string | { evidenceId: string; received: boolean }>;
  upload(evidenceId: string): Promise<void>;
  commit(evidenceId: string): Promise<void>;
  attest(evidenceId: string, authorization: { challengeId: string; signature: string }): Promise<unknown>;
  finalize(): Promise<void>;
  now?: () => number;
}
export class CompletionPending extends Error {
  code = "PRESERVATION_PENDING";
  constructor(message: string) { super(message); }
}
/** One owner drives the journal. Every write intent is durable before its network side effect. */
export async function recoverCaptureCompletion(capture: CompletionCapture, deps: CompletionDeps): Promise<CompletionProof> {
  const state = capture.recovery;
  const now = deps.now ?? Date.now;
  async function phase(value: CaptureRecoveryState["phase"]) { deps.assertAccount(); state.phase = value; await deps.save(); deps.assertAccount(); }
  async function read() { deps.assertAccount(); const proof = await deps.getProof(); deps.assertAccount(); return proof; }
  async function status() { deps.assertAccount(); const result = await deps.getRecovery(); deps.assertAccount(); state.lastServerResult = result; await deps.save(); return result; }
  try {
    if (!state.submitRequested) throw Object.assign(new Error("Review your recording and confirm submission first."), { code: "ATTESTATION_CONFIRMATION_NEEDED" });
    let proof = await read();
    // Read the exact operation before repeating any write. Never substitute another recording on this Proof.
    let server = await status();
    // Resolve from this server on every attempt; never persist a permissive mode.
    // A failed read stops completion. Absent/invalid declarations remain strict.
    const capabilities = await deps.getCapabilities?.();
    deps.assertAccount();
    const durableRequired = requiresDurableCaptureReceipts(capabilities);
    let evidenceId = capture.uploadEvidenceId;
    const committed = evidenceId && proof.evidence.some(item => item.evidenceId === evidenceId && item.validationStatus === "COMMITTED");
    if (!committed) {
      if (proof.status === "FINALIZED") throw Object.assign(new Error("This Proof was finalized with another recording. Your local original is retained for review."), { code: "CAPTURE_ORIGINAL_CONFLICT", status: 409 });
      if (state.needsSellerAttestation && !state.authorization) throw Object.assign(new Error("Confirm your shipment to continue. Your recording is saved on this device."), { code: "ATTESTATION_CONFIRMATION_NEEDED" });
      await phase("UPLOAD_QUEUED");
      const initialized = await deps.initialize(state.evidenceIdempotencyKey);
      evidenceId = typeof initialized === "string" ? initialized : initialized.evidenceId;
      deps.assertAccount(); capture.uploadEvidenceId = evidenceId; await deps.save();
      if (typeof initialized === "string" || !initialized.received) {
        await phase("UPLOADING"); await deps.upload(evidenceId); deps.assertAccount();
      }
      await phase("BYTES_RECEIVED"); await deps.commit(evidenceId); deps.assertAccount();
      proof = await read(); server = await status();
    }
    if (!evidenceId) throw Object.assign(new Error("The server could not identify this recording. Your local original is retained."), { code: "CAPTURE_ORIGINAL_MISSING", status: 409 });
    // Commit receipt loss and pending durability are not a reason to resend the bytes.
    const preserved = server.evidence.find(item => item.evidenceId === evidenceId);
    if (hasDurableReceipt(preserved)) state.preservationReceipt = preserved.receipt;
    await phase(hasDurableReceipt(preserved) ? "CONFIRMATION_NEEDED" : "PRESERVATION_PENDING");
    const accepted = proof.attestations?.find(item => item.attestedBy === state.userId && item.relatedEvidenceId === evidenceId && item.authorization?.signatureVerification === "SERVER_VERIFIED" && item.authorization.method === "ANDROID_BIOMETRIC_STRONG");
    if (state.needsSellerAttestation && !accepted) {
      const authorization = state.authorization;
      if (!authorization || authorization.sha256 !== capture.captureSha256 || Date.parse(authorization.expiresAt) <= now()) {
        state.authorization = undefined;
        await deps.save();
        throw Object.assign(new Error("Your recording is saved. Confirm your statement again to finish; you do not need to retake it."), { code: "ATTESTATION_CONFIRMATION_NEEDED" });
      }
      deps.assertAccount(); await deps.save();
      state.declarationReceipt = await deps.attest(evidenceId, authorization); deps.assertAccount(); await deps.save();
    } else if (accepted) { state.declarationReceipt = accepted; await deps.save(); }
    if (durableRequired && !hasDurableReceipt(preserved)) {
      await phase("PRESERVATION_PENDING");
      throw new CompletionPending("Recording received. Preservation is still in progress. PackProof will safely retry.");
    }
    await phase("FINALIZATION_PENDING");
    if (proof.status !== "FINALIZED") { await deps.finalize(); deps.assertAccount(); }
    proof = await read(); server = await status();
    const finalEvidence = server.evidence.find(item => item.evidenceId === evidenceId);
    const durablyFinalized = hasDurableReceipt(finalEvidence) && hasDurableReceipt(server.finalization);
    if (proof.status !== "FINALIZED" || !proof.evidence.some(item => item.evidenceId === evidenceId && item.validationStatus === "COMMITTED") ||
        (durableRequired && !durablyFinalized)) throw new CompletionPending("Finalization is still in progress. Your local recording is kept.");
    if (hasDurableReceipt(finalEvidence)) state.preservationReceipt = finalEvidence.receipt;
    if (hasDurableReceipt(server.finalization)) state.finalizationReceipt = server.finalization.receipt;
    state.attempt = 0; state.nextRetryAt = durablyFinalized ? null : now() + 300_000; state.lastError = undefined;
    // Canonical submission can finish on an explicitly compatible server. Local
    // cleanup remains impossible until both real durable receipts are confirmed.
    await phase(durablyFinalized ? "FINALIZED" : "SUBMITTED");
    return proof;
  } catch (error) {
    // A context-bound challenge can become stale after an allowed order correction.
    // Discard its authorization, never the recording; the next explicit confirmation
    // obtains and signs a fresh challenge instead of replaying the rejected one.
    if ((error as { code?: string })?.code === "ATTESTATION_CONTEXT_CHANGED") state.authorization = undefined;
    // Preserve the originating journal even if authentication or account selection changed.
    const retry = recoveryRetry(error, state.attempt, now());
    state.attempt += 1; state.nextRetryAt = retry.nextRetryAt;
    state.lastError = { code: retry.code, message: retry.message, retryable: retry.retryable };
    // Preserve useful authoritative phases through a transient outage.
    if (!retry.retryable || !["PRESERVATION_PENDING", "FINALIZATION_PENDING"].includes(state.phase)) state.phase = retry.phase;
    await deps.save();
    throw error;
  }
}
