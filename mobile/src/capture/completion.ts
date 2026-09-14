import { bindRecordedCapture, inspectCaptureShipping, persistCaptureMetadata, uploadCaptureFile, uploadCaptureResumable, type LocalCapture } from "../capture";
import { authorizeSellerCapture } from "../attestation/seller-attestation";
import type { PackProofV2Client, ProofView, UploadTarget } from "../v2-api";
import { newIdempotencyKey } from "../v2-api";
import { recoverCaptureCompletion } from "./recover-completion";
import { sameCaptureAccount } from "./recovery-model";
import {nativeStudyForCapture,type NativeStudyTimer} from '../analytics/native-study';
import { identifierCaptureEnabled } from './identifier-observation';
import { prepareIdentifierCheckpoint } from './identifier-storage';
import { beginUploadService, endUploadService, notifyUploadOutcome } from './upload-notifications';
import { useDirectUpload } from './upload-transport';

const active = new Map<string, Promise<ProofView>>();
export function captureCompletionActive(operationId?: string): boolean { return operationId ? active.has(operationId) : active.size > 0; }

export interface SavedCaptureInput {
  client: PackProofV2Client; capture: LocalCapture; userId: string;
  interactive: boolean; needsSellerAttestation: boolean; idempotencyKey?: string | null; assertAccount: () => void;
  onProgress?: (percent: number) => void; onChange?: (capture: LocalCapture) => void;
}

function initializeRecovery(input: SavedCaptureInput) {
  const { capture, client, userId } = input;
  const proofId = capture.captureProofId;
  if (!proofId || capture.captureUserId !== userId) throw Object.assign(new Error("Open the original account to resume this recording."), { code: "ACCOUNT_CHANGED" });
  capture.recovery ??= { version: 1, operationId: capture.captureSessionId ?? newIdempotencyKey(), apiBaseUrl: client.apiBaseUrl,
    userId, proofId, phase: "LOCAL_ONLY", evidenceIdempotencyKey: input.idempotencyKey || newIdempotencyKey(), submitRequested: false,
    needsSellerAttestation: input.needsSellerAttestation, attempt: 0, nextRetryAt: null, updatedAt: new Date().toISOString() };
  if (!sameCaptureAccount(capture.recovery, client.apiBaseUrl, userId)) throw Object.assign(new Error("Open the original server and account to resume this recording."), { code: "ACCOUNT_CHANGED" });
  return capture.recovery;
}

/** Only preparation and deliberate authorization block the screen. No video bytes are sent here. */
export async function prepareSavedCapture(input: SavedCaptureInput): Promise<void> {
  const { capture, client, userId } = input;
  const state = initializeRecovery(input);
  const proofId = state.proofId;
  const study = await nativeStudyForCapture(client, userId, capture.studyTimingRef);
  const save = async () => { await persistCaptureMetadata(capture); input.onChange?.(capture); };
  input.assertAccount();
  study?.phase('confirmation');
  capture.recovery!.needsSellerAttestation = input.needsSellerAttestation;
  await save();
  if (identifierCaptureEnabled(capture.identifierPolicy) && !['SUBMITTED', 'FINALIZED'].includes(capture.recovery!.phase)) {
    // Finish optional observations before the existing single authorization step.
    await inspectCaptureShipping(client, capture);
    input.assertAccount();
    await prepareIdentifierCheckpoint(client, capture, save);
    input.assertAccount();
    await bindRecordedCapture(client, capture, proofId, userId);
    input.assertAccount();
  }
  if (input.needsSellerAttestation && capture.recovery!.phase !== "SUBMITTED") {
    await authorizeSellerCapture({ client, capture, proofId, userId, capturePrepared: identifierCaptureEnabled(capture.identifierPolicy) });
    input.assertAccount();
  } else if (!capture.captureSha256) { await bindRecordedCapture(client, capture, proofId, userId); input.assertAccount(); }
  input.assertAccount();
  state.submitRequested = true;
  state.completionNotificationRequested = true;
  state.lastError = undefined;
  state.nextRetryAt = null;
  if (!['PRESERVATION_PENDING', 'FINALIZATION_PENDING', 'SUBMITTED', 'FINALIZED'].includes(state.phase)) state.phase = 'UPLOAD_QUEUED';
  await save();
}

export function completeSavedCapture(input: SavedCaptureInput): Promise<ProofView> {
  const { capture, client, userId } = input;
  let state;
  try { state = initializeRecovery(input); } catch (error) { return Promise.reject(error); }
  const proofId = state.proofId;
  const operationId = state.operationId;
  const previous = active.get(operationId);
  if (previous) return previous;
  if (active.size >= 2) return Promise.reject(Object.assign(new Error("Two recordings are already resuming. This recording remains queued."), { code: "UPLOAD_LIMIT", status: 429 }));
  let study:NativeStudyTimer|null=null;
  const run = (async () => {
    study=await nativeStudyForCapture(client,userId,capture.studyTimingRef);
    if(!input.interactive||(capture.recovery?.attempt??0)>0)study?.event('recovery_started');
    const save = async () => { await persistCaptureMetadata(capture); input.onChange?.(capture); };
    input.assertAccount();
    if (input.interactive) await prepareSavedCapture(input);
    await beginUploadService(operationId);
    let directTarget: UploadTarget | undefined;
    const freshUpload = !capture.uploadEvidenceId && capture.recovery!.attempt === 0;
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
        if (freshUpload && useDirectUpload(result.upload, client.apiBaseUrl)) directTarget = result.upload;
        return { evidenceId: result.evidenceId, received: result.upload.received === true };
      },
      upload: evidenceId => {study?.phase('upload');return directTarget
        ? uploadCaptureFile({ baseUrl: client.apiBaseUrl, target: directTarget, fileUri: capture.uri, contentType: capture.contentType, onProgress: input.onProgress })
        : uploadCaptureResumable({ client, baseUrl: client.apiBaseUrl, proofId, evidenceId, fileUri: capture.uri, onProgress: input.onProgress });},
      commit: async evidenceId => { await client.commitEvidence(proofId, evidenceId, capture.captureSha256); },
      attest: async (evidenceId, authorization) => (await client.createAttestation(proofId, { statement: "PACKED_DESCRIBED_ITEM", relatedEvidenceId: evidenceId,
        authorization: { challengeId: authorization.challengeId, signature: authorization.signature } })).attestation,
      finalize: async () => {study?.phase('finalization');await client.finalizeProof(proofId);},
    });
    if(proof.status==='FINALIZED')study?.event('server_completed');
    input.assertAccount();
    await notifyUploadOutcome({ ...capture, recovery: state }, proof).then(save).catch(() => undefined);
    study?.end('succeeded');return proof as ProofView;
  })().catch(error=>{
    const code=String(error?.code);
    if(code==='PRESERVATION_PENDING')study?.phase('finalization');
    else if(/ATTESTATION_|BIOMETRIC_|LABEL_REVIEW_REQUIRED|IDENTIFIER_REVIEW_REQUIRED/.test(code))study?.phase('confirmation');
    // A recoverable recording remains one open task; cancellation of a biometric
    // dialog or a transient upload problem is not abandonment of that recording.
    if(capture.recovery?.lastError?.retryable)study?.problem('network');
    else if(/AUTH|ACCOUNT|BIOMETRIC/.test(code))study?.problem('authentication');
    else if(code!=='PRESERVATION_PENDING')study?.problem('unknown');
    throw error;
  }).finally(() => { active.delete(operationId); void endUploadService(operationId); });
  active.set(operationId, run);
  return run;
}
