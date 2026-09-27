export type EvidenceState = 'AUTHORIZING' | 'RECORDING' | 'INTERRUPTED' | 'LOCAL' | 'HASHING' | 'WAITING_FOR_NETWORK' | 'WAITING_FOR_AUTH' | 'READY' | 'UPLOADING' | 'VERIFYING' | 'COMMITTING' | 'FINALIZING' | 'COMPLETE' | 'RETRYING' | 'FAILED' | 'DISCARDED';

export interface BarcodeDetection { value: string; format?: string; detectedAtMs: number; confirmed?: boolean; notThisPackage?: boolean }
export interface CaptureInput {
  proofId: string;
  label?: string;
  mimeType: string;
  camera?: string;
  appVersion: string;
  installationId: string;
  offline?: boolean;
}
export interface CaptureFinish {
  attestation: boolean;
  detections?: BarcodeDetection[];
  recordedDurationMs?: number;
  startedAt?: string;
  endedAt?: string;
}
export interface CaptureAuthorization {
  /** Absent for a local recording not yet registered with the server. */
  id?: string;
  maxRecordingBytes: number;
  maxRecordingSeconds: number;
  recoverUntil?: string;
}
export interface UploadContext { accountId: string; proofId: string; jobId: string }
export interface UploadIdentity extends UploadContext { evidenceId: string }
export interface UploadReceipt { sha256: string; byteSize: number }
export interface ServerPart extends UploadReceipt { partNumber: number }
export interface EvidenceTransport {
  authorizeCapture(input: UploadContext, signal: AbortSignal): Promise<CaptureAuthorization>;
  registerCapture(input: UploadContext & UploadReceipt & { captureSessionId?: string; mimeType: string; recordedDurationMs: number; metadata: CaptureMetadata }, signal: AbortSignal): Promise<CaptureAuthorization>;
  initializeUpload(input: UploadContext & UploadReceipt & { captureSessionId: string; mimeType: string }, signal: AbortSignal): Promise<{ evidenceId: string }>;
  inspectUpload(input: UploadIdentity, signal: AbortSignal): Promise<{ status: 'PENDING' | 'COMMITTED' | 'REJECTED'; sha256?: string; byteSize?: number; parts?: ServerPart[]; partSize?: number }>;
  uploadPart(input: UploadIdentity & { partNumber: number; bytes: Buffer; sha256: string }, signal: AbortSignal): Promise<UploadReceipt>;
  completeUpload(input: UploadIdentity & UploadReceipt, signal: AbortSignal): Promise<UploadReceipt>;
  commitUpload(input: UploadIdentity & UploadReceipt, signal: AbortSignal): Promise<UploadReceipt>;
  attestAndFinalize(input: UploadIdentity & { captureSessionId: string; statement: string }, signal: AbortSignal): Promise<void>;
  discardUpload?(input: UploadContext & { evidenceId?: string; captureSessionId?: string }, signal: AbortSignal): Promise<void>;
}
export interface CaptureMetadata {
  captureSource: 'DESKTOP_CAMERA';
  camera?: string;
  appVersion: string;
  installationId: string;
  platform: string;
  offline?: boolean;
  startedAt: string;
  endedAt?: string;
  detections: BarcodeDetection[];
  provenance: 'CLIENT_REPORTED_NOT_INDEPENDENTLY_VERIFIED';
}
export interface EvidenceJobView {
  id: string;
  proofId: string;
  label: string;
  state: EvidenceState;
  byteSize: number;
  uploadedBytes: number;
  progress: number;
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
  error?: string;
  errorCode?: string;
  evidenceId?: string;
  sha256?: string;
  maxRecordingBytes: number;
  maxRecordingSeconds: number;
  localCopyAvailable: boolean;
}
export interface EvidenceEngineOptions {
  rootDir: string;
  encryptionKey: Buffer;
  api: EvidenceTransport;
  onChange?: (jobs: EvidenceJobView[]) => void;
  onComplete?: (job: EvidenceJobView) => void;
  now?: () => number;
  /** Disable periodic processing for deterministic tests. */
  automaticProcessing?: boolean;
}
