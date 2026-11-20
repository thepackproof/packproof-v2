import type { ConnectStatus } from "./types";
import type { FacilityDraft, FacilityInputs } from "./guided-workflow-types";

export const sourceRoles = ["order", "picking", "packing", "shipping", "evidence", "handoff", "delivery", "returns"] as const;
export type SourceRole = (typeof sourceRoles)[number];
export const setupSteps = [...sourceRoles, "review", "output", "activate", "overview"] as const;
export type WorkspaceStep = (typeof setupSteps)[number];

export interface WorkspaceSource {
  id: string;
  folder: string;
  roles: SourceRole[];
  generation: number;
  issue?:string|null;
  coverageGap?:boolean;
  lastScanAt?:string|null;
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
    packingSchema?: string|null;
    profileVersion?: string;
  };
}

export interface OrderSummary {
  proofId: string;
  revision: number;
  orderReference: string;
  updatedAt?:string;
  customerName?:string;
  latestKind?:string;
  issue?:string;
  fulfillmentStatus?:string;
  locationId?:string;
  matchedSubjects?:{id:string;type:string;namespace:string}[];
}
export interface OrderDetail extends OrderSummary {
  facilities?:string[];
  integrity?:string;
  originalArtifacts?:Record<string,unknown>[];
  lines: Record<string,unknown>[];
  events: Record<string,unknown>[];
  evidence: Record<string,unknown>[];
  packages?: Record<string,unknown>[];
  conflicts?: string[];
  totals?: {events:number;evidence:number;lines:number};
}
export interface WorkspaceStatus {
  guidedSetupAvailable?: boolean;
  orders?: OrderSummary[];
  totalOrders?:number|null;
  nextBefore?:number|null;
  updatedToday?:number|null;
  updatedLast24Hours?:number|null;
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
    displayReference?:string|null;
    lookupReferences?:string[];
    orderId?:string; orderNamespace?:string;
    cartonCount?:number;
    labelCount?:number;
    cartons?:{id:string; namespace:string; status:string; lastKind?:string|null; occurredAt?:string|null}[];
    lines: {lineId:string;sku:string;quantity:string;unit:string}[];
    packages: string[];
    events: {
      kind:string; source:string; fileName:string; occurredAt:string; shared:boolean;
      sourceId?:string; locator?:string; profileVersion?:string; version?:string; recordHash?:string;
      qualifiedWeight?:string|null; qualifiedWeightUnit?:string|null;
      entity?:{namespace:string;type:string;id:string};
      references?:{namespace:string;type:string;id:string}[];
      fieldLineage?:Record<string,string>|null;
    }[];
  }[];
  scannedFiles: number; unreadFiles: number; unresolved: number; limited: boolean;
}
export interface AttentionReport {
  orderIssueCount?:number;
  orderIssues?:OrderSummary[];
  nextIssuesBefore?:number|null;
  items:{proofId?:string;revision?:number;orderReference?:string;sourceId?:string;fileName?:string;locator?:string;kind?:string;reason?:string}[];
  hasMore:boolean;
}
export interface WorkspaceSourceRecord {
  kind:'original'|'derived_excerpt';
  eventKey:string;
  sourceId:string;
  receiptId:string;
  fileName:string;
  originalSha256?:string;
  fields?:Record<string,unknown>;
  lines?:Record<string,unknown>[];
  profileVersion?:string;
  eventKind?:string;
  fieldLineage?:Record<string,string>;
  locator?:string;
  observedAt?:string;
  occurredAt?:string|null;
  version?:string;
  originalText?:string;
  mediaType?:string;
  reason?:string;
  artifact?:{receiptId:string;fileName:string;mediaType:string;originalSha256:string;bytesBase64:string};
}
export interface WorkspaceFolderSuggestion {
  folder: string;
  kind: 'selected' | 'prepared' | 'discovered';
  label?: string;
  evidence?: string;
}
export interface WorkspaceBridge {
  getFacilityDraft?(): Promise<FacilityDraft>;
  saveFacilityDraft?(expectedRevision: number, changes: FacilityInputs): Promise<FacilityDraft>;
  replayFacilityDraft?(expectedRevision: number): Promise<FacilityDraft>;
  workspaceOrderPage?(before:number):Promise<{orders:OrderSummary[];nextBefore?:number|null}>;
  workspaceSourceRecord?(proofId:string,revision:number,eventKey:string):Promise<WorkspaceSourceRecord>;
  getWorkspaceFolderSuggestion?(role:SourceRole):Promise<WorkspaceFolderSuggestion|null>;
  discoverWorkspaceFolders?(role:SourceRole):Promise<WorkspaceFolderSuggestion[]>;
  useWorkspaceFolderSuggestion?(role:SourceRole,expectedFolder:string):Promise<ConnectStatus>;
  replaceWorkspaceFolder?(sourceId:string,expectedGeneration:number):Promise<ConnectStatus>;
  workspaceAttention(before?:number):Promise<AttentionReport>;
  workspaceSearchOrders(query:string):Promise<OrderSummary[]>;
  chooseWorkspaceRelatedSource(sourceId:string,expectedGeneration:number,role:SourceRole,relatedId:string):Promise<ConnectStatus>;
  confirmWorkspaceOrderMap(sourceId:string, expectedGeneration:number, profileVersion:string):Promise<ConnectStatus>;
  openWorkspaceReview():Promise<void>;
  openWorkspaceOrder(proofId:string,revision:number,subject?:string):Promise<void>;
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

