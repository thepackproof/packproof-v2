export interface EvidenceAnchor {
  anchorId: string;
  proofId: string;
  evidenceId: string;
  stageId?: string | null;
  sourceHash: string;
  sourceVersion: string;
  startMs: number;
  endMs: number;
  label: string;
  sourceType: "USER_MARKED" | "SCANNER_TRIGGERED";
  recipeVersion?: string | null;
  sourceCategory: string;
  createdAt: string;
}
export interface SignatureEvidence {
  capturedDurationMs?: number | null;
  evidenceId: string;
  stageId: string | null;
  sha256: string;
  sourceVersion: string;
  contentType: string;
  committedAt: string;
  byteSize: number;
}
export interface SignatureSnapshot {
  snapshotId: string;
  sha256: string;
  createdAt: string;
  data: {
    proofId: string;
    status: string;
    proofVersion: number;
    manifestSha256: string | null;
    order: {
      itemTitle?: string;
      itemDescription?: string;
      quantity?: number;
      source?: string;
    };
    evidence: SignatureEvidence[];
    anchors: EvidenceAnchor[];
    shipping: {
      carrier?: string;
      events: Array<{
        eventId: string;
        eventType: string;
        occurredAt: string;
        source: string;
        provider: string;
        title: string;
      }>;
    };
    statements: Array<{
      attestationId: string;
      statement: string;
      source: string;
    }>;
  };
}
export interface ReturnComparison {
  comparisonId: string;
  outbound: EvidenceAnchor;
  inbound: EvidenceAnchor;
  state: string;
  note: string;
  authorUserId: string;
  supersedesId?: string;
  createdAt: string;
}
export interface SignatureView {
  capabilities?: {
    replay: boolean;
    ask: boolean;
    cases: boolean;
    compare: boolean;
    history: boolean;
    paidAI: false;
  };
  snapshot: SignatureSnapshot;
  comparisons: ReturnComparison[];
  history: { optedIn: boolean; entries: unknown[] };
}
export interface ProofAnswer {
  state: "SUPPORTED" | "NOT_ESTABLISHED";
  answer: string;
  citations: Array<{
    kind: "FIELD" | "EVENT" | "MEDIA" | "ANCHOR";
    id: string;
    source: string;
    label: string;
  }>;
  snapshotId: string;
  assistance: true;
}
export interface CasePreview {
  caseId: string;
  sha256: string;
  approved: boolean;
  preview: {
    title: string;
    summary: string;
    gaps: string[];
    notes?: { text: string; source: string } | null;
    snapshotId: string;
    snapshotSha256: string;
    [key: string]: unknown;
  };
}

export function mediaUri(
  client: {
    evidenceContentUrl: (proofId: string, evidenceId: string) => string;
    lifecycleEvidenceUrl: (
      proofId: string,
      stageId: string,
      evidenceId: string,
    ) => string;
  },
  proofId: string,
  evidence: SignatureEvidence,
): string {
  return evidence.stageId
    ? client.lifecycleEvidenceUrl(
        proofId,
        evidence.stageId,
        evidence.evidenceId,
      )
    : client.evidenceContentUrl(proofId, evidence.evidenceId);
}
export function elapsedLabel(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}
