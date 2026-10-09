import { selectTaskHome, type HomeInput } from "../../../mobile/src/experience/task-home";
import type { CanonicalProof, FulfillmentQueueItem, ProofCollectionItem } from "../api/types";
import type { LocalRecordingSummary } from "../capture-queue";
import { workstationPresentation } from "../components/WorkstationProofTable";
import { presentProof } from "../proof-presentation";

/** Only display adaptation. Server Proof states and local upload ownership stay unchanged. */
export function mobileHomeState(input: { proofs: ProofCollectionItem[]; recordings: LocalRecordingSummary[]; usable: ReadonlySet<string>; queue: FulfillmentQueueItem[]; online: boolean; reconciled: boolean; selection?: string; interactions?: Record<string, number> }) {
  const proofs: HomeInput["proofs"] = input.proofs.map(proof => {
    const view = workstationPresentation(proof);
    const action: HomeInput["proofs"][number]["action"] = view.diagnostic ? "unknown" : proof.accessKind === "RECEIVER" || proof.invitationId ? "continue" : !view.canContribute ? "view" : view.nextAction.type === "REVIEW_CONFIRM" ? "finalize" : view.nextAction.type === "RECORD_PACKING" ? "capture" : view.nextAction.type === "WORKFLOW_ACTION" ? "continue" : "view";
    return { id: proof.proofId, title: proof.transaction.itemTitle || "Shipment Proof", status: proof.status, authorized: true, action, continuationAfterFinalization: !!view.canContribute && view.nextAction.type === "WORKFLOW_ACTION", createdAt: proof.createdAt, updatedAt: proof.updatedAt, completed: proof.status === "FINALIZED" && !!proof.finalizedAt };
  });
  const contribute = (id: string) => {
    const proof = input.proofs.find(row => row.proofId === id);
    return !!proof && !proof.invitationId && proof.accessKind !== "RECEIVER" && !!workstationPresentation(proof).canContribute && !workstationPresentation(proof).diagnostic;
  };
  const pending = input.recordings.filter(row => !row.finalized && !row.submitted && !row.discardRequested);
  return selectTaskHome({ proofs, online: input.online, reconciled: input.reconciled, selection: input.selection, interactions: input.interactions,
    captures: pending.filter(row => !row.accepted).map(row => ({ id: row.key, proofId: row.proofId, authorized: contribute(row.proofId), usable: input.usable.has(row.key), needsReview: true, interrupted: row.interrupted })),
    jobs: pending.filter(row => row.accepted || !input.usable.has(row.key)).map(row => ({ id: row.key, proofId: row.proofId, authorized: contribute(row.proofId), active: !!row.active && input.online, waiting: !row.active && !row.retryStopped && (!row.errorMessage || !!row.retryScheduled), intervention: !!row.retryStopped || (!!row.errorMessage && !row.retryScheduled) || !row.available, reason: row.errorMessage })),
    orders: input.queue.map(row => ({ id: row.transactionId, proofId: row.proofId, title: row.itemSummary, ready: row.workflowState === "READY_TO_PACK", authorized: contribute(row.proofId), createdAt: row.orderedAt || "" })),
  });
}

/** A fresh authorized canonical record determines the route, never a stale button label. */
export function mobileProofDestination(proof: CanonicalProof, userId: string, recording?: LocalRecordingSummary) {
  const base = `/proofs/${encodeURIComponent(proof.proofId)}`;
  const view = presentProof(proof, userId);
  if (view.canContribute && !view.diagnostic && view.nextAction.type === "WORKFLOW_ACTION" && proof.workflowType !== "GRADING_SUBMISSION") return `/receipt/${encodeURIComponent(proof.proofId)}`;
  if (proof.status === "FINALIZED" || view.diagnostic || !view.canContribute) return base;
  if (recording && !recording.finalized && !recording.submitted) return recording.kind === "station" && !recording.accepted ? `${base}/capture` : recording.kind === "stage" ? `/receipt/${encodeURIComponent(proof.proofId)}` : "/activity";
  if (view.nextAction.type === "RECORD_PACKING") return `${base}/capture`;
  if (view.nextAction.type === "REVIEW_CONFIRM") return `${base}/finalize`;
  if (view.nextAction.type === "WORKFLOW_ACTION" && proof.workflowType !== "GRADING_SUBMISSION") return `/receipt/${encodeURIComponent(proof.proofId)}`;
  if (proof.workflowType === "GRADING_SUBMISSION" && proof.nextAction?.type === "FINALIZE") return `${base}/finalize`;
  return base;
}

const playbackChecks = new WeakMap<Blob, Promise<boolean>>();
export function usableSavedRecording(file: Blob): Promise<boolean> {
  const cached = playbackChecks.get(file);
  if (cached) return cached;
  if (!file.size || !file.type.startsWith("video/") || typeof URL.createObjectURL !== "function") return Promise.resolve(false);
  const check = new Promise<boolean>(resolve => {
    const video = document.createElement("video"), url = URL.createObjectURL(file);
    let finished = false;
    const finish = (usable: boolean) => {
      if (finished) return;
      finished = true; clearTimeout(timer); video.onloadedmetadata = null; video.onerror = null;
      video.removeAttribute("src"); video.load(); URL.revokeObjectURL(url); resolve(usable);
    };
    const timer = setTimeout(() => finish(false), 3000);
    video.preload = "metadata";
    video.onloadedmetadata = () => finish(video.videoWidth > 0 && video.videoHeight > 0 && video.duration > 0);
    video.onerror = () => finish(false);
    video.src = url;
  });
  playbackChecks.set(file, check);
  return check;
}
