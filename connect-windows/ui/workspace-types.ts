import type { ConnectStatus } from "./types";

export const sourceRoles = ["order", "picking", "packing", "shipping", "evidence", "handoff", "delivery", "returns"] as const;
export type SourceRole = (typeof sourceRoles)[number];
export const setupSteps = [...sourceRoles, "review", "output", "activate", "overview"] as const;
export type WorkspaceStep = (typeof setupSteps)[number];

export interface WorkspaceSource {
  id: string;
  folder: string;
  roles: SourceRole[];
  generation: number;
  transport?: "file" | "folder" | "api";
  displayName?: string;
  sourceNamespace?: string;
  state: string;
  recognition: {
    state: string;
    message: string;
    fields?: string[];
    sample?: Record<string, string>;
    question?: string;
    relatedChoices?: {role:SourceRole;options:{id:string;displayName:string}[]}[];
    suggestedOrderColumn?: string;
    profileVersion?: string;
  };
}

export interface OrderSummary {
  proofId: string;
  revision: number;
  orderReference: string;
}
export interface OrderDetail extends OrderSummary {
  lines: Record<string,unknown>[];
  events: Record<string,unknown>[];
  evidence: Record<string,unknown>[];
  packages?: Record<string,unknown>[];
  conflicts?: string[];
  totals?: {events:number;evidence:number;lines:number};
}
export interface WorkspaceStatus {
  orders?: OrderSummary[];
  syncState?: string;
  canReadOrders?: boolean;
  viewKey?: string | null;
  attention?: string | null;
  expiresAt?: string | null;
  step: WorkspaceStep;
  phase: "draft" | "awaiting_approval" | "active";
  sources: WorkspaceSource[];
  outputFolder?: string | null;
  outputState?: "ready" | "unavailable" | "denied" | "unselected";
  approvalPath?: string | null;
}

export interface ProofOutput {
  folder?: string | null;
  state: "not_configured" | "ready" | "pending" | "current" | "access_denied" | "unavailable";
  errorCode?: string | null;
  pending: number;
  completedRevision?: number | null;
}

export interface DraftPreview {
  examples: {
    orderReference: string; source: string;
    lines: {lineId:string;sku:string;quantity:string;unit:string}[];
    packages: string[];
    events: {kind:string; source:string; fileName:string; occurredAt:string; shared:boolean}[];
  }[];
  scannedFiles: number; unreadFiles: number; unresolved: number; limited: boolean;
}
export interface AttentionReport {
  items:{sourceId?:string;fileName?:string;locator?:string;kind?:string;reason?:string}[];
  hasMore:boolean;
}
export interface WorkspaceBridge {
  workspaceAttention():Promise<AttentionReport>;
  workspaceSearchOrders(query:string):Promise<OrderSummary[]>;
  chooseWorkspaceRelatedSource(sourceId:string,expectedGeneration:number,role:SourceRole,relatedId:string):Promise<ConnectStatus>;
  confirmWorkspaceOrderMap(sourceId:string, expectedGeneration:number, profileVersion:string):Promise<ConnectStatus>;
  openWorkspaceReview():Promise<void>;
  openWorkspaceOrder(proofId:string,revision:number):Promise<void>;
  getWorkspaceStatus():Promise<ConnectStatus>;
  addWorkspaceDirectSource(sourceNamespace?:string):Promise<ConnectStatus>;
  copyWorkspaceDirectProfile(sourceId:string):Promise<void>;
  workspaceDraftPreview(): Promise<DraftPreview>;
  workspaceOrderDetail(proofId: string, revision: number): Promise<OrderDetail>;
  chooseWorkspaceFolder(role: SourceRole): Promise<ConnectStatus>;
  reuseWorkspaceFolder(sourceId: string, role: SourceRole): Promise<ConnectStatus>;
  removeWorkspaceRole(sourceId: string, role: SourceRole): Promise<ConnectStatus>;
  inspectWorkspaceSource(sourceId: string): Promise<ConnectStatus>;
  saveWorkspaceStep(step: WorkspaceStep): Promise<ConnectStatus>;
  chooseWorkspaceOutput(): Promise<ConnectStatus>;
  activateWorkspace(allowPendingOutput?: true): Promise<ConnectStatus>;
  pauseWorkspaceSource(sourceId: string): Promise<ConnectStatus>;
  resumeWorkspaceSource(sourceId: string): Promise<ConnectStatus>;
  openWorkspaceApproval(): Promise<void>;
  openWorkspaceOutput(): Promise<void>;
}

