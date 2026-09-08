export interface QueueOrder {
  proofId: string;
  proofStatus: string;
  workflowState: string;
  evidenceCount: number;
  pendingEvidenceCount: number;
}
export interface DraftProof {
  proofId: string;
  status: string;
  role: string;
  workflowType?: string;
}
export interface OrderPresentation {
  state: "ready" | "attention" | "excluded";
  label: string;
  action: string;
}

export function orderPresentation(item: QueueOrder): OrderPresentation {
  if (item.proofStatus === "FINALIZED" || item.workflowState === "COMPLETED" || item.workflowState === "REMOVED_FROM_FULFILLMENT")
    return { state: "excluded", label: "", action: "View Proof" };
  if (item.pendingEvidenceCount > 0)
    return { state: "attention", label: "Finish saving", action: "Open Proof" };
  if (item.workflowState === "IN_PROGRESS" || item.evidenceCount > 0)
    return { state: "attention", label: "Finish your Proof", action: "Open Proof" };
  if (item.proofStatus === "READY_FOR_EVIDENCE" && item.workflowState === "READY_TO_PACK")
    return { state: "ready", label: "Ready to pack", action: "Open camera preview" };
  return { state: "attention", label: "Review order setup", action: "Open Proof" };
}

/** Pass the complete server queue, including excluded work, so it cannot reappear as a manual draft. */
export function classifyOrders<Q extends QueueOrder, D extends DraftProof>(input: {
  allQueue: Q[];
  queueLoaded: boolean;
  proofs: D[];
  pendingProofIds: Iterable<string>;
}): { ready: Q[]; attention: Q[]; drafts: D[] } {
  const pending = new Set(input.pendingProofIds);
  const known = new Set(input.allQueue.map(item => item.proofId));
  const finalized = new Set(input.proofs.filter(item => item.status === "FINALIZED").map(item => item.proofId));
  const queue = input.allQueue.filter(item => !pending.has(item.proofId) && !finalized.has(item.proofId));
  return {
    ready: queue.filter(item => orderPresentation(item).state === "ready"),
    attention: queue.filter(item => orderPresentation(item).state === "attention"),
    drafts: input.queueLoaded ? input.proofs.filter(item =>
      item.role === "SELLER" && item.status !== "FINALIZED" && !known.has(item.proofId)
      && !pending.has(item.proofId) && (!item.workflowType || item.workflowType === "COMMERCE_SALE")) : [],
  };
}

export function orderDestination(input: {
  proofStatus: string;
  workflowType?: string;
  seller: boolean;
  hasLocalCapture: boolean;
  committedEvidenceCount: number;
}): "capture" | "proof" {
  if (input.proofStatus === "FINALIZED" || !input.seller || input.workflowType && input.workflowType !== "COMMERCE_SALE") return "proof";
  return input.hasLocalCapture || input.proofStatus === "READY_FOR_EVIDENCE" && input.committedEvidenceCount === 0 ? "capture" : "proof";
}

export function matchesOrderQuery(query: string, values: Array<string | null | undefined>): boolean {
  const needle = query.trim().toLowerCase();
  return !needle || values.filter(Boolean).join(" ").toLowerCase().includes(needle);
}

export function orderChannelNotice(connections: Array<{
  providerDisplay: string;
  status: string;
  autoSyncEnabled?: boolean;
  lastErrorCode?: string | null;
  sync?: { runStatus?: string; initialSyncCompletedAt?: string | null };
}>): { kind: "error" | "waiting"; message: string } | null {
  const reconnect = connections.find(connection => connection.status === "NEEDS_REAUTH");
  if (reconnect) return { kind: "error", message: `${reconnect.providerDisplay} needs reconnecting before its orders can update.` };
  const failed = connections.find(connection => connection.sync?.runStatus === "FAILED" || connection.status === "ERROR"
    || Boolean(connection.lastErrorCode) && connection.sync?.runStatus !== "RETRYING");
  if (failed) return { kind: "error", message: `${failed.providerDisplay} orders could not update. Review your sales channel and try again.` };
  const retrying = connections.find(connection => connection.sync?.runStatus === "RETRYING");
  if (retrying) return { kind: "waiting", message: `${retrying.providerDisplay} is retrying its last order check. Existing orders remain available.` };
  const initial = connections.find(connection => connection.status === "ACTIVE" && connection.autoSyncEnabled && !connection.sync?.initialSyncCompletedAt);
  return initial ? { kind: "waiting", message: `${initial.providerDisplay}'s first order check is pending or in progress.` } : null;
}
