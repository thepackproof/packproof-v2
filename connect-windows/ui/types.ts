/** Renderer-safe state only. Tokens and enrollment redemption secrets never cross this boundary. */
export type CheckState = "passed" | "warning" | "blocked" | "not_checked";
export interface ComputerCheck {
  id: string;
  label: string;
  state: CheckState;
  detail: string;
}
export interface SourceContract {
  schema: "packproof.scheduled-csv/v1" | "packproof.scheduled-csv/v2";
  exporterName: string | null;
  exporterVersion: string | null;
  expectedHeaders: string[];
  expectedIntervalSeconds: number | null;
  backfillFrom: string;
  rulesVersion?: string;
  profileVersion?: string;
  confirmedFields?: string[];
  analysisRevision?: number;
  historyPolicy?: {
    mode: "selected_then_new";
    baselineSha256: string;
    observedAt: string;
    initialFileName: string;
    initialFileSha256: string;
  };
}
export interface LocalAnalysis {
  ready: boolean;
  decisions: Array<{
    field: string;
    sourceColumnId: string | null;
    state:
      | "validated"
      | "needs_confirmation"
      | "missing_optional"
      | "missing_required"
      | "incompatible";
    reasonCodes: string[];
    origin: "source_column" | "approved_binding" | "absent";
    candidates: string[];
    examples?: Record<string, string[]>;
  }>;
  shipment?: {
    shipmentReference: string;
    itemTitle: string;
    quantity: number;
    shippedAt: string;
    shipmentDate: string;
    trackingNumber?: string | null;
    carrier?: string | null;
    locationId?: string | null;
  };
  issues: string[];
  headers: string[];
  rowCount: number;
  configuration: Configuration;
  binding: {
    sourceBindingId: string;
    folderDigest: string;
    fileSha256: string;
    headerFingerprint: string;
    draftRevision: number;
    profileVersion: string;
    rulesVersion: string;
  };
}
export interface Configuration {
  sourceName: string;
  integrationAccountId?: string;
  operatorMembershipId?: string;
  locationId?: string | null;
  folderDigest: string;
  mapping: Record<string, string>;
  timeZone: string;
  importValidRows: boolean;
  offlineWindowHours: number;
  sourceContract?: SourceContract;
}
export interface SourceSubscriptionStatus {
  id: string;
  sourceProfile: string;
  displayName: string;
  state: string;
  localPaused: boolean;
  configurationRevision: number;
  grantRevision: number;
  folder?: string;
  folderDigest?: string;
  lastCheckAt?: string;
  lastCollectedAt?: string;
  lastReceiptAt?: string;
  lastErrorCode?: string;
  sourceAsOf?: string;
  freshness?: "current" | "delayed" | "unknown";
  queue: Record<string, number>;
  verifiedCaseId?: string;
  setupQueueId?: string;
  approvalPath?: string;
  files?: Array<{ name: string; byteSize: number; lastWriteAt?: string }>;
  selectedFileName?: string;
  fileSha256?: string;
  headers?: string[];
  rowCount?: number;
  samples?: Array<Record<string, string>>;
  receipt?: {
    id: string;
    state: string;
    counts: Record<string, number>;
    caseIds?: string[];
    original?: { sha256: string; byteSize?: number };
  };
}
export interface SubscriptionDraft {
  folder: string;
  folderDigest: string;
  files: Array<{ name: string; byteSize: number; lastWriteAt?: string }>;
  selectedFileName?: string;
  fileSha256?: string;
  headers?: string[];
  rowCount?: number;
  samples?: Array<Record<string, string>>;
  proposal?: { id: string; subscriptionId?: string };
  approvalPath?: string;
}
export interface SubscriptionProposal {
  displayName: string;
  sourceProfile: string;
  sourceNamespace: string;
  mappingVersion: string;
  mapping: Record<string, string>;
  constants: Record<string, string>;
  historyFrom: string; unknownTimePolicy?: "quarantine" | "retain_unknown";
  historyTo?: string | null;
  expectedIntervalSeconds?: number | null;
  wholeFileUploadApproved: true;
}
export interface ConnectStatus {
  state: string;
  analysis?: LocalAnalysis;
  setup?: { running: boolean; phase?: string };
  capabilities?: { sourceContracts: string[]; rulesVersion: string; typedSourceSubscriptions?: boolean };
  sourceCapabilities?: { typedCollection: boolean };
  sourceSubscriptions?: SourceSubscriptionStatus[];
  subscriptionDraft?: SubscriptionDraft;
  installedVersion?: string;
  installationId?: string;
  environment: string;
  sourceName?: string;
  integrationAccountId?: string;
  operatorMembershipId?: string;
  locationId?: string | null;
  binding?: {
    organizationId?: string;
    organizationName?: string;
    sourceName: string;
    integrationAccountId: string;
    operatorMembershipId: string;
    locationId: string | null;
  };
  configRevision?: number;
  recoveryAvailable?: boolean;
  authorizationNotice?: string;
  checks?: ComputerCheck[];
  enrollment?: {
    id: string;
    comparisonCode: string;
    expiresAt: string;
    approvalPath?: string;
    state: string;
    workspaceName?: string;
  };
  source?: {
    folder: string;
    folderDigest: string;
    accessible: boolean;
    files?: Array<{ name: string; byteSize: number; lastWriteAt?: string }>;
    selectedFileName?: string;
    fileSha256?: string;
    headers?: string[];
    samples?: Array<Record<string, string>>;
  };
  config?: Configuration;
  pendingProposal?: Configuration;
  preview?: {
    id: string;
    previewVersion: string;
    state: string;
    original: { sha256: string; byteSize: number };
    counts: Record<string, number>;
    rows: Array<{
      rowNumber: number;
      status: string;
      errors: string[];
      normalized?: Record<string, unknown>;
      values?: Record<string, string>;
    }>;
    recordIds: string[];
  };
  verification?: {
    complete: boolean;
    recordId?: string;
    recordUrl?: string;
    configRevision?: number;
    fileSha256?: string;
  };
  health: {
    serviceOnline: boolean;
    lastScanAt?: string;
    lastExportAt?: string;
    lastCompletedImportAt?: string;
    lastReceiptReconciledAt?: string;
    sourceFreshness?: "unknown" | "current" | "delayed";
    expectedIntervalSeconds?: number;
    sourceWatermarkAt?: string;
    sourceAccounting?: {
      receivedExports: number;
      acceptedRows: number;
      duplicateRows: number;
      rejectedRows: number;
      pendingRows: number;
      linkedProofs: number;
    };
    quarantinedFileCount?: number;
    queueCount: number | null;
    preservedQueueCount?: number;
    lastErrorCode?: string;
  };
  approvalPath?: string;
}
export interface ConnectBridge {
  chooseNewSubscriptionFolder(): Promise<ConnectStatus>;
  inspectSubscriptionDraft(fileName: string): Promise<ConnectStatus>;
  proposeSubscription(input: SubscriptionProposal): Promise<ConnectStatus>;
  chooseSubscriptionFolder(id: string): Promise<ConnectStatus>;
  inspectSubscriptionFile(input: { id: string; fileName: string }): Promise<ConnectStatus>;
  previewSubscription(input: { id: string; fileName: string; wholeFileUploadApproved: true }): Promise<ConnectStatus>;
  commitSubscription(input: { id: string; wholeBatchApproved: true }): Promise<ConnectStatus>;
  verifySubscription(id: string): Promise<ConnectStatus>;
  pauseSubscription(id: string): Promise<ConnectStatus>;
  resumeSubscription(id: string): Promise<ConnectStatus>;
  openSubscriptionApproval(id: string): Promise<unknown>;
  openSubscriptionCase(id: string): Promise<unknown>;
  getStatus(): Promise<ConnectStatus>;
  checkComputer(): Promise<ConnectStatus>;
  beginEnrollment(): Promise<ConnectStatus>;
  recoverEnrollment(consent: {
    preservePendingWorkApproved: true;
  }): Promise<ConnectStatus>;
  pollEnrollment(): Promise<ConnectStatus>;
  chooseFolder(): Promise<ConnectStatus>;
  previewLocal(fileName: string): Promise<ConnectStatus>;
  analyzeLocal(input: {
    mapping: Record<string, string>;
    confirmedFields: string[];
    backfillFrom?: string;
  }): Promise<ConnectStatus>;
  startSetup(consent: {
    wholeFileUploadApproved: true;
    draftRevision: number;
  }): Promise<ConnectStatus>;
  proposeConfiguration(config: Configuration): Promise<ConnectStatus>;
  previewCloud(consent: {
    wholeFileUploadApproved: true;
  }): Promise<ConnectStatus>;
  commitBatch(consent: { wholeBatchApproved: true }): Promise<ConnectStatus>;
  verifyImport(): Promise<ConnectStatus>;
  proposeActivation(): Promise<ConnectStatus>;
  activate(): Promise<ConnectStatus>;
  pause(): Promise<ConnectStatus>;
  resume(): Promise<ConnectStatus>;
  refresh(): Promise<ConnectStatus>;
  exportDiagnostics(): Promise<unknown>;
  openApproval(): Promise<unknown>;
  openRecord(recordId: string): Promise<unknown>;
  openPortal(): Promise<unknown>;
}
export function getBridge(): ConnectBridge | undefined {
  return (window as Window & { packproofConnect?: ConnectBridge })
    .packproofConnect;
}

export type Status = ConnectStatus;
export type PackProofConnect = ConnectBridge;
