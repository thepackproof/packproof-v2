import { bindRecordedCapture, persistCaptureMetadata, uploadCaptureResumable, type LocalCapture } from "../capture";
import { authorizeSellerCapture } from "../attestation/seller-attestation";
import type { PackProofV2Client, ProofView } from "../v2-api";
import { newIdempotencyKey } from "../v2-api";
import { recoverCaptureCompletion } from "./recover-completion";
import { sameCaptureAccount } from "./recovery-model";
import {nativeStudyForCapture,type NativeStudyTimer} from '../analytics/native-study';

const active = new Map<string, Promise<ProofView>>();
export function captureCompletionActive(): boolean { return active.size > 0; }

export function completeSavedCapture(input: {
  client: PackProofV2Client; capture: LocalCapture; userId: string;
  interactive: boolean; needsSellerAttestation: boolean; idempotencyKey?: string | null; assertAccount: () => void;
  onProgress?: (percent: number) => void; onChange?: (capture: LocalCapture) => void;
}): Promise<ProofView> {
  const { capture, client, userId } = input;
  const proofId = capture.captureProofId;
  if (!proofId || capture.captureUserId !== userId) return Promise.reject(Object.assign(new Error("Open the original account to resume this recording."), { code: "ACCOUNT_CHANGED" }));
  capture.recovery ??= { version: 1, operationId: capture.captureSessionId ?? newIdempotencyKey(), apiBaseUrl: client.apiBaseUrl,
    userId, proofId, phase: "LOCAL_ONLY", evidenceIdempotencyKey: input.idempotencyKey || newIdempotencyKey(), submitRequested: false,
    needsSellerAttestation: input.needsSellerAttestation, attempt: 0, nextRetryAt: null, updatedAt: new Date().toISOString() };
  if (!sameCaptureAccount(capture.recovery, client.apiBaseUrl, userId)) return Promise.reject(Object.assign(new Error("Open the original server and account to resume this recording."), { code: "ACCOUNT_CHANGED" }));
  const operationId = capture.recovery.operationId;
  const previous = active.get(operationId);
  if (previous) return previous;
  if (active.size >= 2) return Promise.reject(Object.assign(new Error("Two recordings are already resuming. This recording remains queued."), { code: "UPLOAD_LIMIT", status: 429 }));
  let study:NativeStudyTimer|null=null;
  const run = (async () => {
    study=await nativeStudyForCapture(client,userId,capture.studyTimingRef);
    if(!input.interactive||(capture.recovery?.attempt??0)>0)study?.event('recovery_started');
    const save = async () => { await persistCaptureMetadata(capture); input.onChange?.(capture); };
    input.assertAccount();
    if (input.interactive) {
      study?.phase('confirmation');
      // Persist the intent before a prompt or HTTP request; background work never opens a biometric dialog.
      capture.recovery!.submitRequested = true; capture.recovery!.needsSellerAttestation = input.needsSellerAttestation;
      await save();
      if (input.needsSellerAttestation && capture.recovery!.phase !== "SUBMITTED") {
        await authorizeSellerCapture({ client, capture, proofId, userId });
        input.assertAccount();
      } else if (!capture.captureSha256) { await bindRecordedCapture(client, capture, proofId, userId); input.assertAccount(); }
      await save();
    }
    const awaitingServer = ['PRESERVATION_PENDING','FINALIZATION_PENDING','SUBMITTED'].includes(capture.recovery?.phase ?? '');
    study?.phase(awaitingServer ? 'finalization' : 'upload');
    study?.event('upload_pending');
    const proof = await recoverCaptureCompletion(capture as LocalCapture & { recovery: NonNullable<LocalCapture["recovery"]> }, {
      assertAccount: input.assertAccount, save,
      getProof: () => client.getProof(proofId), getRecovery: () => client.getProofRecovery(proofId),
      getCapabilities: () => client.getCapabilities(),
      initialize: async key => {
        study?.phase('upload');
        const result = await client.initializeEvidenceUpload(proofId, { contentType: capture.contentType, byteSize: capture.byteSize ?? undefined,
          captureSessionId: capture.captureSessionId, evidenceType: "FULFILLMENT_CAPTURE", idempotencyKey: key });
        return { evidenceId: result.evidenceId, received: result.upload.received === true };
      },
      upload: evidenceId => {study?.phase('upload');return uploadCaptureResumable({ client, baseUrl: client.apiBaseUrl, proofId, evidenceId, fileUri: capture.uri, onProgress: input.onProgress });},
      commit: async evidenceId => { await client.commitEvidence(proofId, evidenceId, capture.captureSha256); },
      attest: async (evidenceId, authorization) => (await client.createAttestation(proofId, { statement: "PACKED_DESCRIBED_ITEM", relatedEvidenceId: evidenceId,
        authorization: { challengeId: authorization.challengeId, signature: authorization.signature } })).attestation,
      finalize: async () => {study?.phase('finalization');await client.finalizeProof(proofId);},
    });
    if(proof.status==='FINALIZED')study?.event('server_completed');
    study?.end('succeeded');return proof as ProofView;
  })().catch(error=>{
    const code=String(error?.code);
    if(code==='PRESERVATION_PENDING')study?.phase('finalization');
    else if(/ATTESTATION_|BIOMETRIC_|LABEL_REVIEW_REQUIRED/.test(code))study?.phase('confirmation');
    // A recoverable recording remains one open task; cancellation of a biometric
    // dialog or a transient upload problem is not abandonment of that recording.
    if(capture.recovery?.lastError?.retryable)study?.problem('network');
    else if(/AUTH|ACCOUNT|BIOMETRIC/.test(code))study?.problem('authentication');
    else if(code!=='PRESERVATION_PENDING')study?.problem('unknown');
    throw error;
  }).finally(() => { active.delete(operationId); });
  active.set(operationId, run);
  return run;
}
