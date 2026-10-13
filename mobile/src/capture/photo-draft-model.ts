import type { ProofView } from '../v2-api';
import { captureSlots, isGradingWorkflow, nextActionNeedsCapture, workflowActionFor } from '../copy/custody';

export interface PhotoDraftContext {
  apiBaseUrl: string; userId: string; proofId: string; actionType: string;
  recipe: string; assetId: string | null; transferId: string | null;
}
export interface PhotoDraftSlot {
  slot: string; uri: string; contentType: string; uploadKey: string;
  evidenceId?: string; sha256?: string; committedAt?: string;
}
export interface PhotoDraft extends PhotoDraftContext {
  schema: 1; id: string; actionKey: string; updatedAt: string;
  phase: 'LOCAL_ONLY' | 'SUBMITTING' | 'COMPLETE';
  slots: PhotoDraftSlot[]; retainedUris: string[];
}
export function photoContextKey(context: PhotoDraftContext): string {
  return JSON.stringify([context.apiBaseUrl.replace(/\/+$/, ''), context.userId, context.proofId,
    context.actionType, context.recipe, context.assetId, context.transferId]);
}
export function photoDraftContext(proof: ProofView, userId: string, apiBaseUrl: string): PhotoDraftContext | null {
  const action = proof.nextAction;
  if (!isGradingWorkflow(proof.workflowType) || proof.status === 'FINALIZED' || !action ||
      !nextActionNeedsCapture(action.type) || !action.captureRecipe || action.captureRecipe === 'PACKING_STANDARD_V1' ||
      !captureSlots(action.captureRecipe).length || !proof.participants.some(p => p.userId === userId) ||
      !action.actorRole || !proof.participants.some(p => p.userId === userId && p.role === action.actorRole)) return null;
  return { apiBaseUrl: apiBaseUrl.replace(/\/+$/, ''), userId, proofId: proof.proofId, actionType: action.type,
    recipe: action.captureRecipe, assetId: action.assetId ?? null, transferId: action.transferId ?? null };
}
export function photoDraftReady(draft: PhotoDraft): boolean {
  return captureSlots(draft.recipe).filter(s => s.required).every(s => draft.slots.some(row => row.slot === s.slot));
}
export function photoDraftRemaining(draft: PhotoDraft): number {
  return captureSlots(draft.recipe).filter(s => s.required && !draft.slots.some(row => row.slot === s.slot)).length;
}
export function replacePhotoSlot(draft: PhotoDraft, slot: PhotoDraftSlot, now: string): PhotoDraft {
  if (draft.phase !== 'LOCAL_ONLY') throw new Error('This photo submission has started. Resume its saved upload before taking another photo.');
  if (!captureSlots(draft.recipe).some(s => s.slot === slot.slot)) throw new Error('This photo does not belong to the required item view.');
  const previous = draft.slots.find(row => row.slot === slot.slot);
  return { ...draft, updatedAt: now, slots: [...draft.slots.filter(row => row.slot !== slot.slot), slot],
    retainedUris: [...new Set([...draft.retainedUris, ...(previous ? [previous.uri] : [])])] };
}

export interface PhotoSubmissionPorts {
  assertAccount(): void;
  getProof(): Promise<ProofView>;
  persist(draft: PhotoDraft): Promise<void>;
  fileExists(uri: string): Promise<boolean>;
  initialize(slot: PhotoDraftSlot): Promise<{ evidenceId: string; upload: unknown }>;
  upload(slot: PhotoDraftSlot, target: unknown): Promise<void>;
  commit(evidenceId: string): Promise<{ evidenceId: string; sha256: string | null; committedAt?: string | null; validationStatus?: string }>;
  apply(draft: PhotoDraft, action: NonNullable<ReturnType<typeof workflowActionFor>>): Promise<void>;
}
const validHash = (value: string | null | undefined): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/i.test(value);
/** Provider-owned submission. Every network await rechecks account identity; originals are never removed here. */
export async function submitPhotoDraft(initial: PhotoDraft, ports: PhotoSubmissionPorts): Promise<PhotoDraft> {
  let draft = { ...initial, slots: initial.slots.map(s => ({ ...s })) };
  const guard = async <T>(promise: Promise<T>): Promise<T> => { const value = await promise; ports.assertAccount(); return value; };
  ports.assertAccount();
  if (draft.phase === 'COMPLETE') return draft;
  if (!photoDraftReady(draft)) throw new Error('Complete each required photo before saving.');
  const proof = await guard(ports.getProof());
  const context = photoDraftContext(proof, draft.userId, draft.apiBaseUrl);
  const alreadyCommitted = draft.slots.every(slot => slot.evidenceId && proof.evidence.some(e =>
    e.evidenceId === slot.evidenceId && e.validationStatus === 'COMMITTED' && validHash(e.sha256)));
  // A lost workflow response can be replayed with its original idempotency key, even after the next step advances.
  // It cannot initialize or upload new bytes under a changed action or finalized Proof.
  const replayOnly = draft.phase === 'SUBMITTING' && alreadyCommitted;
  if ((!context || photoContextKey(context) !== photoContextKey(draft)) && !replayOnly)
    throw new Error('The permitted step changed. Your photos remain on this device. Refresh the Proof before continuing.');
  if (!proof.participants.some(p => p.userId === draft.userId)) throw new Error('This account no longer has participant access. Your photos are retained.');
  const action = workflowActionFor(draft.actionType);
  if (!action) throw new Error('This photo step is unavailable. Your photos are retained.');
  draft.phase = 'SUBMITTING';
  await guard(ports.persist(draft));
  for (let index = 0; index < draft.slots.length; index++) {
    let slot = draft.slots[index];
    const receipt = slot.evidenceId && proof.evidence.find(e => e.evidenceId === slot.evidenceId && e.validationStatus === 'COMMITTED' && validHash(e.sha256));
    if (receipt) {
      draft.slots[index] = { ...slot, sha256: receipt.sha256!, committedAt: receipt.committedAt ?? undefined };
      await guard(ports.persist(draft));
      continue;
    }
    if (replayOnly) throw new Error('The previous photo receipt could not be confirmed. Retry after refreshing.');
    if (!await guard(ports.fileExists(slot.uri))) throw new Error('A selected photo is unavailable on this device. The other photos are retained.');
    const target = await guard(ports.initialize(slot));
    slot = { ...slot, evidenceId: target.evidenceId };
    draft.slots[index] = slot;
    await guard(ports.persist(draft));
    await guard(ports.upload(slot, target.upload));
    const committed = await guard(ports.commit(target.evidenceId));
    if (committed.evidenceId !== target.evidenceId || !validHash(committed.sha256) || committed.validationStatus && committed.validationStatus !== 'COMMITTED')
      throw new Error('The photo receipt is incomplete. Your original is retained; retry to check it.');
    draft.slots[index] = { ...slot, sha256: committed.sha256, committedAt: committed.committedAt ?? undefined };
    await guard(ports.persist(draft));
  }
  await guard(ports.apply(draft, action));
  draft = { ...draft, phase: 'COMPLETE', updatedAt: new Date().toISOString() };
  await guard(ports.persist(draft));
  return draft;
}
