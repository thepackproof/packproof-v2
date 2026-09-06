import type { EvidenceAnchor } from "../signature";
import type { ChronologyEntry, ProofView } from "../v2-api";

export type ProofRecordTab = "Evidence" | "Timeline" | "Tracking" | "Receipt";
export interface ProofRecordViewState {
  tab: ProofRecordTab;
  timelineFilter: string;
  selectedEvidenceId?: string | null;
  selectedShipmentId?: string | null;
  playbackTimes?: Record<string, number>;
  offsets: Record<ProofRecordTab, number>;
}

export function initialProofRecordView(): ProofRecordViewState {
  return { tab: "Evidence", timelineFilter: "ALL", offsets: { Evidence: 0, Timeline: 0, Tracking: 0, Receipt: 0 } };
}

/** Presentation ordering never changes canonical event order or timestamps. */
export function orderedRecordEvents(entries: ChronologyEntry[]): ChronologyEntry[] {
  return [...entries].sort((a, b) => {
    const first = Date.parse(a.occurredAt), second = Date.parse(b.occurredAt);
    return (Number.isFinite(first) ? first : Infinity) - (Number.isFinite(second) ? second : Infinity);
  });
}

export function recordEventFilters(entries: ChronologyEntry[]) {
  const labels: Record<string, string> = { ALL: "All events", PROOF: "Proof", SHIPMENT: "Shipment", COMMERCE: "Order" };
  return ["ALL", ...new Set(entries.map(entry => entry.category))].map(category => ({
    category,
    label: labels[category] ?? category,
    count: category === "ALL" ? entries.length : entries.filter(entry => entry.category === category).length,
  }));
}

/** Only bookmarks for this exact committed original belong on its player. */
export function originalBookmarks(evidence: ProofView["evidence"][number], anchors: EvidenceAnchor[]) {
  const superseded = new Set(anchors.map(anchor => anchor.supersedesId).filter(Boolean));
  return anchors.filter(anchor =>
    !superseded.has(anchor.anchorId) && !anchor.stageId && anchor.evidenceId === evidence.evidenceId && Boolean(evidence.sha256) &&
    anchor.sourceHash === evidence.sha256 && Number.isFinite(anchor.startMs) && anchor.startMs >= 0 &&
    anchor.sourceVersion === `sha256:${evidence.sha256}` &&
    Number.isFinite(anchor.endMs) && anchor.endMs > anchor.startMs,
  ).sort((a, b) => a.startMs - b.startMs);
}

export interface ReceiptRecordSummary {
  role: "SELLER" | "BUYER";
  stages: Array<{
    stageId: string;
    type: string;
    actorUserId: string;
    finalizedAt: string | null;
    evidence: Array<{ evidenceId: string; contentType: string; committedAt: string | null }>;
  }>;
}

export function receiptAcknowledgment(record: ReceiptRecordSummary | null): string {
  if (!record) return "Not available";
  const receipt = record.stages.find(stage => stage.type === "RECEIPT");
  if (receipt?.finalizedAt) return "Receipt recording finalized";
  if (receipt?.evidence.some(item => Boolean(item.committedAt))) return "Receipt recording saved · not finalized";
  return "Not recorded";
}
