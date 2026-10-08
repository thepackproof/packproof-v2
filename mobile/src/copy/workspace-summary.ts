import type { LocalCapture } from '../capture';
import type { FulfillmentQueueItem, InvitationInboxView, ProofCollectionItem } from '../v2-api';
import type { LocalCaptureStatus } from './status';
import { localProofWork, mergeProofInvitations, presentationForProof, type PresentedProof } from './proof-list';
import { orderPresentation } from './orders';

/** One retained recording can also be the active recording; count it only once. */
export function workspaceRecordings(saved: LocalCapture[], current: LocalCapture | null): LocalCapture[] {
  return [...new Map([...saved, ...(current ? [current] : [])].map(capture => [capture.uri, capture])).values()];
}

export function pendingWorkspaceRecordings(saved: LocalCapture[], current: LocalCapture | null): number {
  return workspaceRecordings(saved, current).filter(capture => capture.recovery?.phase !== 'FINALIZED').length;
}

export function workspaceProofRows(input: {
  proofs: ProofCollectionItem[];
  invitations: InvitationInboxView[];
  recordings: LocalCapture[];
  localCapture: LocalCapture | null;
  captureProofId?: string | null;
  captureStatus: LocalCaptureStatus;
  uploadProgressByProof: Record<string, number | null>;
}): PresentedProof[] {
  return mergeProofInvitations(input.proofs, input.invitations).map(item => {
    const capture = input.recordings.find(recording => recording.captureProofId === item.proofId && recording.recovery?.phase !== 'FINALIZED')
      ?? (input.captureProofId === item.proofId ? input.localCapture : null);
    const uploading = Object.prototype.hasOwnProperty.call(input.uploadProgressByProof, item.proofId);
    return { ...item, presentation: presentationForProof(item, item.role, localProofWork(capture,
      uploading ? 'uploading' : input.captureProofId === item.proofId ? input.captureStatus : undefined,
      uploading ? input.uploadProgressByProof[item.proofId] : undefined)) };
  });
}

export function recentWorkspaceProofs(rows: PresentedProof[], limit = 5): PresentedProof[] {
  return [...rows].sort((a, b) => (Date.parse(b.updatedAt) || 0) - (Date.parse(a.updatedAt) || 0) || a.proofId.localeCompare(b.proofId)).slice(0, limit);
}

export function readyWorkspaceOrders(
  queue: FulfillmentQueueItem[],
  proofs: ProofCollectionItem[],
  saved: LocalCapture[] = [],
  current: LocalCapture | null = null,
): FulfillmentQueueItem[] {
  const finalized = new Set(proofs.filter(proof => proof.status === 'FINALIZED').map(proof => proof.proofId));
  const unfinished = new Set([...saved, ...(current ? [current] : [])]
    .filter(capture => !['FINALIZED', 'SUBMITTED'].includes(capture.recovery?.phase ?? ''))
    .map(capture => capture.captureProofId).filter(Boolean));
  return [...new Map(queue.map(order => [order.proofId, order])).values()].filter(order =>
    orderPresentation(order).state === 'ready' && !finalized.has(order.proofId) && !unfinished.has(order.proofId));
}
