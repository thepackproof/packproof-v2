/** Renderer-safe state only. Tokens and enrollment redemption secrets never cross this boundary. */
export type CheckState = 'passed' | 'warning' | 'blocked' | 'not_checked';
export interface ComputerCheck { id: string; label: string; state: CheckState; detail: string }
export interface SourceContract {
  schema: 'packproof.scheduled-csv/v1'; exporterName: string; exporterVersion: string;
  expectedHeaders: string[]; expectedIntervalSeconds: number; backfillFrom: string;
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
export interface ConnectStatus {
  state: string;
  installedVersion?: string;
  installationId?: string;
  environment: string;
  sourceName?: string;
  integrationAccountId?: string;
  operatorMembershipId?: string;
  locationId?: string | null;
  binding?: { sourceName: string; integrationAccountId: string; operatorMembershipId: string; locationId: string | null };
  configRevision?: number;
  recoveryAvailable?: boolean;
  authorizationNotice?: string;
  checks?: ComputerCheck[];
  enrollment?: { id: string; comparisonCode: string; expiresAt: string; approvalPath?: string; state: string; workspaceName?: string };
  source?: { folder: string; folderDigest: string; accessible: boolean; files?: Array<{ name: string; byteSize: number }>; selectedFileName?: string; fileSha256?: string; headers?: string[]; samples?: Array<Record<string, string>> };
  config?: Configuration;
  pendingProposal?: Configuration;
  preview?: { id: string; previewVersion: string; state: string; original: { sha256: string; byteSize: number }; counts: Record<string, number>; rows: Array<{ rowNumber: number; status: string; errors: string[]; normalized?: Record<string, unknown>; values?: Record<string, string> }>; recordIds: string[] };
  verification?: { complete: boolean; recordId?: string; recordUrl?: string; configRevision?: number; fileSha256?: string };
  health: { serviceOnline: boolean; lastScanAt?: string; lastExportAt?: string; lastCompletedImportAt?: string; lastReceiptReconciledAt?: string; sourceFreshness?: 'unknown'|'current'|'delayed'; expectedIntervalSeconds?: number; sourceWatermarkAt?:string; sourceAccounting?: { receivedExports:number; acceptedRows:number; duplicateRows:number; rejectedRows:number; pendingRows:number; linkedProofs:number }; quarantinedFileCount?:number; queueCount: number | null; preservedQueueCount?: number; lastErrorCode?: string };
  approvalPath?: string;
}
export interface ConnectBridge {
  getStatus(): Promise<ConnectStatus>;
  checkComputer(): Promise<ConnectStatus>;
  beginEnrollment(): Promise<ConnectStatus>;
  recoverEnrollment(consent: { preservePendingWorkApproved: true }): Promise<ConnectStatus>;
  pollEnrollment(): Promise<ConnectStatus>;
  chooseFolder(): Promise<ConnectStatus>;
  previewLocal(fileName: string): Promise<ConnectStatus>;
  proposeConfiguration(config: Configuration): Promise<ConnectStatus>;
  previewCloud(consent: { wholeFileUploadApproved: true }): Promise<ConnectStatus>;
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
export function getBridge(): ConnectBridge | undefined { return (window as Window & { packproofConnect?: ConnectBridge }).packproofConnect; }

export type Status = ConnectStatus;
export type PackProofConnect = ConnectBridge;
