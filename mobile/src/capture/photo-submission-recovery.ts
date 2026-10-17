import { photoContextKey, photoDraftReady, type PhotoDraft } from './photo-draft-model';

export const PHOTO_AUTOMATIC_ATTEMPTS = 3;
export function photoRetryDue(draft: PhotoDraft, now = Date.now()): boolean {
  return draft.phase === 'SUBMITTING' && (!draft.retry ||
    (draft.retry.retryable && draft.retry.attempts < PHOTO_AUTOMATIC_ATTEMPTS && draft.retry.nextAttemptAt <= now));
}

export interface PhotoRecoveryPorts {
  assertAccount(): void;
  read(): Promise<PhotoDraft | null>;
  persist(draft: PhotoDraft): Promise<void>;
  submit(draft: PhotoDraft): Promise<PhotoDraft>;
  now?: () => number;
}

/** Resume the durable intent, never a render snapshot or a new upload identity. */
export async function recoverPhotoSubmission(requested: PhotoDraft, ports: PhotoRecoveryPorts, manual = false): Promise<PhotoDraft> {
  ports.assertAccount();
  let draft = await ports.read(); ports.assertAccount();
  if (!draft || draft.id !== requested.id || photoContextKey(draft) !== photoContextKey(requested))
    throw new Error('The saved photo step changed. Reopen its original Proof.');
  if (draft.phase === 'COMPLETE') return draft;
  if (!photoDraftReady(draft)) throw new Error('Complete each required photo before saving.');
  const now = ports.now ?? Date.now;
  if (!manual && !photoRetryDue(draft, now())) return draft;
  const attempts = manual ? 1 : (draft.retry?.attempts ?? 0) + 1;
  draft = { ...draft, phase: 'SUBMITTING', retry: { attempts, nextAttemptAt: now(), retryable: true, message: 'Saving the selected photos and checking the item step.' } };
  // This survives process death before the first network request. No originals are deleted.
  await ports.persist(draft); ports.assertAccount();
  try {
    return await ports.submit(draft);
  } catch (error) {
    ports.assertAccount();
    const latest = await ports.read(); ports.assertAccount();
    if (!latest || latest.id !== draft.id || latest.phase === 'COMPLETE') throw error;
    const e = error as { code?: string; status?: number; message?: string; name?: string };
    const transient = e?.status === 0 || e?.status === 408 || e?.status === 429 || (e?.status ?? 0) >= 500 ||
      ['NETWORK', 'NETWORK_ERROR', 'REQUEST_TIMEOUT', 'TIMEOUT', 'UPLOAD_INTERRUPTED'].includes(e?.code ?? '') || e?.name === 'TypeError';
    const retryable = transient && attempts < PHOTO_AUTOMATIC_ATTEMPTS;
    await ports.persist({ ...latest, retry: { attempts, retryable, nextAttemptAt: now() + Math.min(30_000, 2_000 * 2 ** (attempts - 1)),
      message: retryable ? 'The response did not arrive. Your originals are kept; this same submission will be checked automatically.'
        : 'Your photos are kept. Check the saved submission to continue. ' + (e?.message ?? '') } });
    ports.assertAccount();
    throw error;
  }
}
