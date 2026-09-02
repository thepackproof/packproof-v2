export const STATION_RESOLVE_SCHEMA = "packproof.packing-station.resolve/v1" as const;

export type StationPhase =
  | "READY"
  | "SCANNING"
  | "IDENTIFYING"
  | "READY_TO_RECORD"
  | "RECORDING"
  | "FINISH_SCANNING"
  | "VERIFYING_FINISH_SCAN"
  | "PROCESSING"
  | "PROOF_CREATED"
  | "RECOVERY";

export type IdentifyMethod = "SCAN" | "REFERENCE" | "QUEUE_SELECT" | "DEEP_LINK" | "API_EVENT";

export type StartTrigger = "MANUAL" | "AUTO" | "SCAN" | "SENSOR";

export type StopTrigger =
  | "MANUAL"
  | "RESCAN"
  | "LABEL"
  | "SEAL"
  | "WEIGHT"
  | "SCANNER"
  | "API_EVENT";

export type SubmitStep = "upload" | "commit" | "attest" | "finalize" | "refresh";

export type StationMatchKind =
  | "PROOF_ID"
  | "TRANSACTION_ID"
  | "TRACKING_NUMBER"
  | "EXTERNAL_ORDER_ID"
  | "INTEGRATION_IDENTITY"
  | "EXTERNAL_REFERENCE";

export type StationBlockReason =
  | "FINALIZED"
  | "NEEDS_PARTICIPANT"
  | "EVIDENCE_ALREADY_COMMITTED"
  | "NOT_READY";

export type StationErrorCode =
  | "STATION_REFERENCE_NOT_FOUND"
  | "STATION_REFERENCE_AMBIGUOUS"
  | "STATION_REFERENCE_INVALID"
  | "PROOF_ALREADY_FINALIZED"
  | "PROOF_NOT_READY"
  | "EVIDENCE_ALREADY_COMMITTED"
  | "UNAUTHENTICATED"
  | "UPLOAD_FAILED"
  | "NETWORK"
  | "CAPTURE_FAILED"
  | "CAMERA_PERMISSION_DENIED"
  | "SCANNER_UNAVAILABLE"
  | "SCAN_UNREADABLE"
  | "SCAN_UNSUPPORTED"
  | "WRONG_PACKAGE"
  | "UNKNOWN";

export interface StationError {
  code: StationErrorCode | string;
  message: string;
}

export interface StationCaptureRef {
  handle: string;
  contentType: string;
  byteSize: number | null;
  durationMs: number | null;
}

export interface StationOrderContext {
  transactionId: string;
  proofId: string;
  proofStatus: string;
  participationPolicy: string | null;
  orderLabel: string;
  itemSummary: string;
  trackingHint?: string | null;
  alreadyFinalized: boolean;
  alreadyHasCommittedEvidence: boolean;
  captureReady: boolean;
  blockReason: StationBlockReason | null;
}

export interface StationState {
  phase: StationPhase;
  identifyMethod: IdentifyMethod | null;
  startTrigger: StartTrigger | null;
  stopTrigger: StopTrigger | null;
  referenceInput: string;
  order: StationOrderContext | null;
  capture: StationCaptureRef | null;
  evidenceIdempotencyKey: string | null;
  submitStep: SubmitStep | null;
  uploadPercent: number | null;
  completion: "FINALIZED" | "EVIDENCE_COMMITTED" | null;
  error: StationError | null;
  canRetry: boolean;
}

export type StationEvent =
  | { type: "SET_REFERENCE"; reference: string }
  | { type: "SCAN_STARTED" }
  | { type: "SCAN_CANCELLED" }
  | { type: "SCAN_DECODED"; value: string }
  | { type: "SCAN_FAILED"; error: StationError }
  | { type: "IDENTIFY_STARTED"; method: IdentifyMethod; reference?: string }
  | { type: "IDENTIFY_RESOLVED"; context: StationOrderContext; method: IdentifyMethod }
  | { type: "IDENTIFY_FAILED"; error: StationError }
  | { type: "START_RECORDING"; trigger?: StartTrigger }
  | { type: "RECORDING_STARTED" }
  | { type: "FINISH_SCAN_STARTED" }
  | { type: "FINISH_SCAN_CANCELLED" }
  | { type: "FINISH_SCAN_DECODED"; value: string }
  | { type: "FINISH_SCAN_FAILED"; error: StationError }
  | {
      type: "FINISH_RESOLVED";
      resolved: { transactionId: string; proofId: string | null };
    }
  | { type: "FINISH_MANUAL" }
  | { type: "FINISH_RECORDING"; trigger?: StopTrigger }
  | { type: "CAPTURE_HELD"; capture: StationCaptureRef; idempotencyKey?: string | null }
  | { type: "CAPTURE_READY"; capture: StationCaptureRef; trigger?: StopTrigger }
  | { type: "CAPTURE_CANCELLED" }
  | { type: "PROCESSING_STARTED"; idempotencyKey?: string | null; submitStep?: SubmitStep }
  | { type: "PROCESSING_PROGRESS"; uploadPercent?: number | null; submitStep?: SubmitStep }
  | { type: "COMPLETED"; completion: "FINALIZED" | "EVIDENCE_COMMITTED" }
  | { type: "PROCESSING_FAILED"; error: StationError; canRetry: boolean }
  | { type: "RETRY" }
  | { type: "RESET" }
  | { type: "AUTH_FAILED"; error?: StationError }
  | { type: "DISCARD_CAPTURE" };

export interface PackingStationResolveView {
  schema: typeof STATION_RESOLVE_SCHEMA | string;
  reference: string;
  matchedBy: StationMatchKind | string;
  transactionId: string;
  proofId: string | null;
  proofStatus: string | null;
  participationPolicy: string | null;
  orderLabel: string;
  itemSummary: string;
  trackingHint?: string | null;
  committedEvidenceCount: number;
  captureReady: boolean;
  alreadyFinalized: boolean;
  alreadyHasCommittedEvidence: boolean;
  blockReason: StationBlockReason | string | null;
}

export interface StationProofSnapshot {
  proofId: string;
  transactionId: string;
  status: string;
  participationPolicy?: string | null;
  participants: Array<{ userId: string; role: string }>;
  evidence: Array<{ evidenceId?: string; validationStatus: string; evidenceType?: string }>;
  attestations?: Array<{ statement: string; attestedBy: string }>;
  transaction: {
    externalReference?: string | null;
    itemTitle?: string | null;
    items?: Array<{ title: string | null }>;
  };
}

export interface StationCandidate {
  proofId: string;
  transactionId: string;
  orderLabel: string;
  itemSummary: string;
}
