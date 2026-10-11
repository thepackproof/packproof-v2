import { selectTaskHome, type HomeAction } from '../../../mobile/src/experience/task-home';
import { taskProofs, canContributeToTask } from '../../../web/src/mobile-task/task-proofs';
import { presentProof } from '../../../web/src/proof-presentation';
import type { FulfillmentQueueItem, PackProofDesktop, ProofCollectionItem, UploadView } from '../shared/contracts';

const pending = (job: UploadView) => !['COMPLETE', 'DISCARDED'].includes(job.state);
const active = new Set(['LOCAL','HASHING','READY','UPLOADING','VERIFYING','COMMITTING','FINALIZING','RETRYING','RECORDING','AUTHORIZING','CAPTURING']);
const waiting = new Set(['WAITING_FOR_NETWORK']);
export function desktopHomeState(input: { proofs: ProofCollectionItem[]; uploads: UploadView[]; orders: FulfillmentQueueItem[]; online: boolean; reconciled: boolean; selection?: string; interactions?: Record<string, number> }) {
  const contribute = (id: string) => canContributeToTask(input.proofs.find(proof => proof.proofId === id));
  return selectTaskHome({ ...input, proofs: taskProofs(input.proofs),
    // Desktop review remains inside the guarded Packing Station. A restarted incomplete
    // journal is INTERRUPTED, never a falsely reviewable finished original.
    captures: [],
    jobs: input.uploads.filter(pending).map(job => ({ id: job.id, proofId: job.proofId, authorized: contribute(job.proofId), active: input.online && active.has(job.state), waiting: waiting.has(job.state) || !input.online && active.has(job.state), intervention: !!job.interrupted || !active.has(job.state) && !waiting.has(job.state), reason: job.error })),
    orders: input.orders.map(order => ({ id: order.transactionId, proofId: order.proofId, title: order.itemSummary, ready: order.workflowState === 'READY_TO_PACK', authorized: contribute(order.proofId), createdAt: order.orderedAt || '' })),
  });
}

export type DesktopHomeDestination = { page: 'proofs' | 'station' | 'uploads'; proofId: string };
/** Only the fresh authorized record can offer capture. Local recovery is account-bound and read-only. */
export async function resolveDesktopHomeTask(bridge: Pick<PackProofDesktop, 'proofs' | 'uploads'>, action: HomeAction, owner: string, current: () => boolean): Promise<DesktopHomeDestination | null> {
  if (!action.targetId || !current()) return null;
  await bridge.proofs.scope(owner);
  if (!current()) return null;
  const jobs = await bridge.uploads.list();
  await bridge.proofs.scope(owner);
  if (!current()) return null;
  let job = jobs.find(row => pending(row) && row.proofId === action.targetId && (!action.sessionId || row.id === action.sessionId));
  if (action.kind === 'review_upload' && job) return { page: 'uploads', proofId: action.targetId };
  const proof = await bridge.proofs.current(action.targetId, owner);
  if (!current()) return null;
  const currentJobs = await bridge.uploads.list();
  await bridge.proofs.scope(owner);
  if (!current()) return null;
  job = currentJobs.find(row => pending(row) && row.proofId === action.targetId && (!action.sessionId || row.id === action.sessionId));
  const view = presentProof(proof, owner);
  if (proof.proofId !== action.targetId) throw new Error('The returned Proof does not match this task. Refresh your workspace.');
  if (proof.status === 'FINALIZED' || !view.canContribute || view.diagnostic || action.sessionId && !job) return { page: 'proofs', proofId: proof.proofId };
  if (job) return { page: 'uploads', proofId: proof.proofId };
  return { page: view.nextAction.type === 'RECORD_PACKING' ? 'station' : 'proofs', proofId: proof.proofId };
}
