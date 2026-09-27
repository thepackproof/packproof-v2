import { DesktopApi, DesktopApiError } from './api.js';
import type { EvidenceTransport, UploadReceipt, CaptureAuthorization } from './evidence/types.js';

const LOCAL_LIMITS: CaptureAuthorization = { maxRecordingBytes: 250_000_000, maxRecordingSeconds: 300 };

/** Bridges the durable queue to authoritative PackProof commands; never invents a remote receipt. */
export class DesktopEvidenceTransport implements EvidenceTransport {
  constructor(private readonly api: DesktopApi) {}
  async authorizeCapture(input: Parameters<EvidenceTransport['authorizeCapture']>[0], signal: AbortSignal): Promise<CaptureAuthorization> {
    this.api.assertAccount(input.accountId); signal.throwIfAborted();
    // Local capture is useful offline. It conveys no server permission or billing reservation.
    return { ...LOCAL_LIMITS };
  }
  async registerCapture(input: Parameters<EvidenceTransport['registerCapture']>[0], signal: AbortSignal): Promise<CaptureAuthorization> {
    this.api.assertAccount(input.accountId);
    const capabilities = await this.api.getCapabilities(signal);
    const policy = capabilities.desktopCapture;
    if (!policy || !Array.isArray(policy.registrationVersions) || !policy.registrationVersions.includes(1) || policy.client !== 'DESKTOP_CAMERA' || policy.surface !== 'DESKTOP' || policy.timingProvenance !== 'CLIENT_REPORTED_NOT_INDEPENDENTLY_VERIFIED' || !Number.isSafeInteger(policy.maxBytes) || policy.maxBytes < 1 || !Number.isSafeInteger(policy.maxDurationSeconds) || policy.maxDurationSeconds < 1) throw new DesktopApiError('DESKTOP_CAPTURE_UNSUPPORTED', 'This server has not enabled desktop recording yet. Your original is safely retained on this computer.', 409);
    if (input.byteSize > policy.maxBytes || input.recordedDurationMs > policy.maxDurationSeconds * 1000) throw new DesktopApiError('CAPTURE_RECORDING_LIMIT', 'This recording exceeds the server recording limit. Your original remains on this computer.', 422);
    if (!['win32', 'darwin'].includes(input.metadata.platform)) throw new DesktopApiError('UNSUPPORTED_DESKTOP_PLATFORM', 'Desktop recording is supported on Windows and macOS.', 422);
    if (!input.metadata.endedAt) throw new DesktopApiError('INCOMPLETE_CAPTURE', 'Finish recording before uploading. The local original is preserved.', 422);
    this.api.assertAccount(input.accountId);
    const session = input.captureSessionId ? await this.api.recoverCaptureSession(input.proofId, input.captureSessionId, signal) : await this.api.registerDesktopRecording(input.proofId, input.jobId, {
      sha256: input.sha256, byteSize: input.byteSize, contentType: input.mimeType,
      recordedDurationMs: input.recordedDurationMs, interrupted: false,
      desktopContext: { schemaVersion: 1, installationId: input.metadata.installationId, appVersion: input.metadata.appVersion, platform: input.metadata.platform as 'win32' | 'darwin', captureStartedAt: input.metadata.startedAt, captureEndedAt: input.metadata.endedAt, ...(input.metadata.camera ? { cameraLabel: input.metadata.camera.slice(0, 256) } : {}), offline: input.metadata.offline ?? false },
    }, signal);
    if (session.state === 'COMMITTED') return session;
    // Record each original observation with stable retry identity. Never overwrite a conflicting order label.
    for (const [index, detection] of input.metadata.detections.entries()) {
      this.api.assertAccount(input.accountId);
      if (detection.confirmed && detection.notThisPackage) throw new DesktopApiError('INVALID_LABEL_REVIEW', 'A label cannot both identify this package and belong to another package.', 400);
      const observation = await this.api.bindCaptureShipping(input.proofId, session.id, { rawValue: detection.value, format: detection.format ?? 'UNKNOWN', detectedAtMs: Math.round(detection.detectedAtMs), idempotencyKey: `${input.jobId}:scan:${index}`, ...(detection.confirmed ? { confirmed: true } : {}) }, signal);
      if (detection.notThisPackage && observation.observationId && observation.status !== 'BOUND') {
        this.api.assertAccount(input.accountId);
        await this.api.resolveCaptureShippingObservation(input.proofId, session.id, observation.observationId, signal);
      }
    }
    this.api.assertAccount(input.accountId);
    return session;
  }
  async initializeUpload(input: Parameters<EvidenceTransport['initializeUpload']>[0], signal: AbortSignal): Promise<{ evidenceId: string }> {
    this.api.assertAccount(input.accountId);
    return this.api.initializeEvidenceUpload(input.proofId, { contentType: input.mimeType, byteSize: input.byteSize, captureSessionId: input.captureSessionId, idempotencyKey: input.jobId, evidenceType: 'FULFILLMENT_CAPTURE' }, signal);
  }
  async inspectUpload(input: Parameters<EvidenceTransport['inspectUpload']>[0], signal: AbortSignal): ReturnType<EvidenceTransport['inspectUpload']> {
    this.api.assertAccount(input.accountId);
    const proof = await this.api.getProof(input.proofId, signal);
    const evidence = proof.evidence.find(row => row.evidenceId === input.evidenceId);
    if (!evidence) throw new DesktopApiError('EVIDENCE_NOT_FOUND', 'The server could not find this upload. Your local recording is preserved.', 404);
    if (evidence.validationStatus === 'COMMITTED' && evidence.committedAt && evidence.sha256 && evidence.byteSize != null) return { status: 'COMMITTED', sha256: evidence.sha256, byteSize: evidence.byteSize };
    if (evidence.validationStatus === 'REJECTED') return { status: 'REJECTED' };
    this.api.assertAccount(input.accountId);
    const parts = await this.api.listUploadParts(input.proofId, input.evidenceId, signal);
    return { status: 'PENDING', parts: parts.parts, partSize: parts.partSize };
  }
  async uploadPart(input: Parameters<EvidenceTransport['uploadPart']>[0], signal: AbortSignal): Promise<UploadReceipt> {
    this.api.assertAccount(input.accountId);
    const receipt = await this.api.uploadPart(input.proofId, input.evidenceId, input.partNumber, input.bytes, signal);
    return assertReceipt(receipt, { sha256: input.sha256, byteSize: input.bytes.byteLength });
  }
  async completeUpload(input: Parameters<EvidenceTransport['completeUpload']>[0], signal: AbortSignal): Promise<UploadReceipt> {
    this.api.assertAccount(input.accountId);
    const receipt = await this.api.completeUploadParts(input.proofId, input.evidenceId, input.byteSize, signal);
    if (!receipt.readyToCommit) throw new DesktopApiError('UPLOAD_UNCONFIRMED', 'PackProof has not confirmed the complete upload.', 409);
    return assertReceipt(receipt, input);
  }
  async commitUpload(input: Parameters<EvidenceTransport['commitUpload']>[0], signal: AbortSignal): Promise<UploadReceipt> {
    this.api.assertAccount(input.accountId);
    const response = await this.api.commitEvidence(input.proofId, input.evidenceId, input.sha256, signal);
    const evidence = response.proof.evidence.find(row => row.evidenceId === input.evidenceId);
    if (!evidence || evidence.validationStatus !== 'COMMITTED' || !evidence.committedAt || !evidence.sha256 || evidence.byteSize == null) throw new DesktopApiError('COMMIT_UNCONFIRMED', 'PackProof has not confirmed preservation of this recording. The local original is retained.', 409);
    return assertReceipt({ sha256: evidence.sha256, byteSize: evidence.byteSize }, input);
  }
  async attestAndFinalize(input: Parameters<EvidenceTransport['attestAndFinalize']>[0], signal: AbortSignal): Promise<void> {
    this.api.assertAccount(input.accountId);
    if (input.statement !== 'PACKED_DESCRIBED_ITEM' && input.statement.replace(/\.$/, '') !== 'The item shown and attached in this Proof is the item I am shipping') throw new DesktopApiError('INVALID_ATTESTATION', 'Confirm the shipping statement before completing this Proof.', 400);
    const proof = await this.api.getProof(input.proofId, signal);
    if (proof.status === 'FINALIZED') return;
    this.api.assertAccount(input.accountId);
    const review = await this.api.getCaptureShippingReview(input.proofId, input.captureSessionId, signal);
    if (review.reviewRequired) throw new DesktopApiError('LABEL_REVIEW_REQUIRED', 'Review the labels seen in this recording in PackProof before completion. Your recording is preserved.', 409);
    this.api.assertAccount(input.accountId);
    await this.api.createAttestation(input.proofId, { statement: 'PACKED_DESCRIBED_ITEM', relatedEvidenceId: input.evidenceId }, signal);
    this.api.assertAccount(input.accountId);
    const result = await this.api.finalizeProof(input.proofId, signal);
    if (result.proof.status !== 'FINALIZED') throw new DesktopApiError('FINALIZATION_PENDING', 'PackProof is still preserving this Proof. Completion will be checked again.', 503);
  }
  async discardUpload(input: Parameters<NonNullable<EvidenceTransport['discardUpload']>>[0], signal: AbortSignal): Promise<void> {
    this.api.assertAccount(input.accountId);
    if (input.evidenceId) await this.api.discardUpload(input.proofId, input.evidenceId, signal);
    else if (input.captureSessionId) await this.api.cancelCaptureSession(input.proofId, input.captureSessionId, signal);
  }
}
function assertReceipt(receipt: UploadReceipt, expected: UploadReceipt): UploadReceipt {
  if (receipt.sha256 !== expected.sha256 || receipt.byteSize !== expected.byteSize) throw new DesktopApiError('EVIDENCE_DIGEST_MISMATCH', 'The server bytes do not match the original recording. The local original is retained.', 409);
  return { sha256: receipt.sha256, byteSize: receipt.byteSize };
}
