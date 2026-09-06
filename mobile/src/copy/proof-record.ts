import type { EvidenceAnchor } from "../signature";
import type { ChronologyEntry, ProofView } from "../v2-api";
import type { NextAction } from "./next-action";

export type ProofRecordTab = "Evidence" | "Timeline" | "Tracking" | "Receipt";
export interface ProofRecordViewState {
  tab: ProofRecordTab;
  timelineFilter: string;
  detailsExpanded?: boolean;
  selectedEvidenceId?: string | null;
  selectedEvidenceStageId?: string | null;
  selectedShipmentId?: string | null;
  playbackTimes?: Record<string, number>;
  offsets: Record<ProofRecordTab, number>;
}

export function initialProofRecordView(): ProofRecordViewState {
  return { tab: "Evidence", timelineFilter: "MILESTONES", offsets: { Evidence: 0, Timeline: 0, Tracking: 0, Receipt: 0 } };
}

/** The header describes the Proof itself. Delivery and local upload state have their own places. */
export function recordProofStatus(status: string): string {
  const labels: Record<string, string> = {
    OPEN: "In progress", AWAITING_PARTICIPANT: "Waiting for buyer",
    READY_FOR_EVIDENCE: "Recording needed", EVIDENCE_COMMITTED: "Ready to finalize", FINALIZED: "Proof finalized",
  };
  return labels[status] ?? "In progress";
}

/** Ordinary Proof guidance follows the same action as its button, even if a server hint is stale. */
export function recordNextStepCopy(local: NextAction, server: { title: string; hint?: string | null } | null, grading: boolean) {
  if (grading && server) return { title: server.title, hint: server.hint || "" };
  const hints: Partial<Record<NextAction["key"], string>> = {
    start_capture: "Show the item, packing, and sealed package.",
    review_recording: "Review your recording, then save it to this Proof.",
    uploading: "Keep PackProof open while your recording uploads.",
    securing: "Saving your recording to this Proof…",
    finalize: "Your recording is saved. Review and finalize this Proof to lock the packing record.",
    add_participant: "Invite the buyer to continue.",
  };
  return { title: local.label, hint: hints[local.key] ?? local.hint };
}

const DETAIL_ONLY_EVENTS = new Set([
  "PROOF_ACCESSED", "PROOF_VIEWED_VIA_ACCESS_LINK", "EVIDENCE_UPLOAD_CREATED",
  "DISCLOSURE_SCOPE_REVIEWED", "CASE_PACKET_PREVIEWED",
]);

/** This only filters the presentation; the complete audit history remains available. */
export function recordActivityEvents(entries: ChronologyEntry[], detailed = false): ChronologyEntry[] {
  return orderedRecordEvents(detailed ? entries : entries.filter(entry => !DETAIL_ONLY_EVENTS.has(entry.eventType.toUpperCase())));
}

export type RecordEvidence = ProofView["evidence"][number] & { stageId?: string | null; stageType?: string };

/** Receipt and return media are additions to this same Proof, with their original stage identity. */
export function committedRecordEvidence(proof: Pick<ProofView, "evidence" | "commerceStages">): RecordEvidence[] {
  return [
    ...proof.evidence.filter(item => item.validationStatus === "COMMITTED"),
    ...(proof.commerceStages ?? []).flatMap(stage => stage.evidence
      .filter(item => Boolean(item.committedAt && item.sha256))
      .map(item => ({
        ...item,
        byteSize: item.byteSize == null ? null : Number(item.byteSize),
        evidenceType: item.contentType.startsWith("video/") ? "VIDEO" : "FILE",
        validationStatus: "COMMITTED",
        stageId: stage.stageId,
        stageType: stage.type,
      }))),
  ];
}

export function recordEvidenceKey(evidence: RecordEvidence): string {
  return evidence.stageId ? `${evidence.stageId}:${evidence.evidenceId}` : evidence.evidenceId;
}

export function recordEvidenceLabel(evidence: RecordEvidence): string {
  if (evidence.stageId) return ({ RECEIPT: "Receipt recording", RETURN_PACKING: "Return packing", RETURN_RECEIPT: "Returned delivery" } as Record<string, string>)[evidence.stageType ?? ""] ?? "Additional recording";
  return evidence.contentType?.startsWith("video/") ? "Packing recording" : "Original file";
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
export function originalBookmarks(evidence: RecordEvidence, anchors: EvidenceAnchor[]) {
  if (evidence.stageId) return [];
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
