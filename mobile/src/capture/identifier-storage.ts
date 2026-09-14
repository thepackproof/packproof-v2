import * as FileSystem from 'expo-file-system';
import { IdentifierJournal } from '../../../backend/src/identifiers/journal';
import type { IdentifierJournalState, IdentifierPolicy, IdentifierReview } from '../../../backend/src/identifiers/types';
import type { UnifiedBarcodeDetection } from '../../modules/packproof-unified-camera';
import type { LocalCapture } from '../capture';
import { newIdempotencyKey, type PackProofV2Client } from '../v2-api';
import { approvedIdentifierShipping, identifierCaptureEnabled, identifierObservation } from './identifier-observation';
import { readShippingJournal, shippingQueue } from './shipping-scan-storage';

type CaptureIdentity = { captureSessionId?: string; captureProofId?: string; captureUserId?: string; identifierPolicy?: IdentifierPolicy; recovery?: { apiBaseUrl: string } };
const active = new Map<string, IdentifierCapture>();
const opening = new Map<string, Promise<IdentifierCapture>>();

function journalUri(sessionId: string): string {
  if (!FileSystem.documentDirectory || !/^[A-Za-z0-9_-]{1,96}$/.test(sessionId)) throw new Error('Code observation storage is unavailable.');
  return `${FileSystem.documentDirectory}packproof-identifiers-${sessionId}.json`;
}

async function persist(state: IdentifierJournalState): Promise<void> {
  const uri = journalUri(state.sessionId);
  await FileSystem.writeAsStringAsync(`${uri}.pending`, JSON.stringify(state));
  await FileSystem.moveAsync({ from: `${uri}.pending`, to: uri });
}

export class IdentifierCapture {
  readonly journal: IdentifierJournal;
  private client: PackProofV2Client;
  private readonly scope: { userId: string; apiScope: string };
  private stopped = false;
  private accepting = true;
  private shippingInFlight = new Map<string, Promise<unknown>>();
  constructor(client: PackProofV2Client, state: IdentifierJournalState) {
    this.client = client;
    this.scope = { userId: state.userId, apiScope: state.apiScope };
    this.journal = new IdentifierJournal(state, {
      makeId: newIdempotencyKey, persist,
      assertScope: () => this.assertScope(),
      send: events => this.client.recordCaptureIdentifiers(state.proofId, state.sessionId, events),
    });
  }
  assertScope(): void {
    this.client.assertCaptureAccount(this.scope.userId, this.scope.apiScope);
  }
  renew(client: PackProofV2Client, capture: CaptureIdentity): void {
    const state = this.journal.snapshot();
    if (state.userId !== capture.captureUserId || state.proofId !== capture.captureProofId || state.apiScope !== client.apiBaseUrl)
      throw Object.assign(new Error('Open this saved recording in its original account.'), { code: 'ACCOUNT_CHANGED' });
    this.client = client; this.assertScope();
  }
  async observe(event: UnifiedBarcodeDetection): Promise<void> {
    if (!this.accepting || this.stopped) return;
    await this.journal.observe(identifierObservation(event, this.journal.snapshot().sessionId, this.journal.snapshot().policy.surface));
  }
  markUnavailable(): void { this.journal.markUnavailable(); }
  async flush(): Promise<IdentifierReview | null> {
    if (this.stopped) return this.journal.snapshot().review;
    const review = await this.journal.flush();
    this.assertScope();
    if (review) await this.forwardShipping(review);
    return review;
  }
  private async forwardShipping(review: IdentifierReview): Promise<void> {
    const state = this.journal.snapshot();
    const journal = await readShippingJournal(state.sessionId) ?? { proofId: state.proofId, sessionId: state.sessionId, userId: state.userId, entries: [] };
    this.assertScope();
    if (journal.proofId !== state.proofId || journal.userId !== state.userId) throw Object.assign(new Error('Open the original account to review these codes.'), { code: 'ACCOUNT_CHANGED' });
    const queue = shippingQueue(this.client, journal);
    for (const row of review.observations) {
      const scan = approvedIdentifierShipping(row);
      if (!scan || this.shippingInFlight.has(row.clientEventId)) continue;
      // Only authoritative routing reaches the unchanged shipping-specific defenses.
      const work = queue.detect(scan);
      this.shippingInFlight.set(row.clientEventId, work);
      void work.catch(() => undefined);
    }
    // A label request runs independently of optional product resolution and the encoder.
    await queue.flush();
  }
  async refresh(): Promise<IdentifierReview | null> {
    this.assertScope();
    const state = this.journal.snapshot();
    try {
      const review = await this.client.getCaptureIdentifiers(state.proofId, state.sessionId);
      this.assertScope();
      await this.journal.updateReview(review);
      return review;
    } catch (error) {
      if (identifierFailureBlocks(error)) throw error;
      this.journal.markUnavailable(); await this.journal.drain();
      return this.journal.snapshot().review;
    }
  }
  async stopIntake(): Promise<void> { this.accepting = false; await this.journal.drain(); }
  async freeze(): Promise<void> { this.accepting = false; this.stopped = true; await this.journal.drain(); }
  async settleShipping(): Promise<void> { await Promise.allSettled([...this.shippingInFlight.values()]); this.assertScope(); }
  resume(): void { this.stopped = false; }
}

export function identifierFailureBlocks(error: unknown): boolean {
  const e = error as { code?: string; status?: number };
  return e?.status === 401 || e?.status === 403 || e?.status === 409 || /ACCOUNT_CHANGED|SCOPE|FORBIDDEN|UNAUTHORIZED|INTEGRITY|REVIEW_REQUIRED|IDEMPOTENCY/.test(e?.code ?? '');
}

/** Journal storage is independent of original media and survives camera/process teardown. */
export async function captureIdentifiers(client: PackProofV2Client, capture: CaptureIdentity, fresh = false): Promise<IdentifierCapture | null> {
  if (!identifierCaptureEnabled(capture.identifierPolicy) || !capture.captureSessionId || !capture.captureProofId || !capture.captureUserId) return null;
  const sessionId = capture.captureSessionId;
  client.assertCaptureAccount(capture.captureUserId, capture.recovery?.apiBaseUrl ?? client.apiBaseUrl);
  const existing = active.get(sessionId);
  if (existing) { existing.renew(client, capture); return existing; }
  const pending = opening.get(sessionId);
  if (pending) { const handle = await pending; handle.renew(client, capture); return handle; }
  const create = (async () => {
  let state: IdentifierJournalState;
  const uri = journalUri(sessionId);
  if ((await FileSystem.getInfoAsync(uri)).exists) {
    state = JSON.parse(await FileSystem.readAsStringAsync(uri)) as IdentifierJournalState;
    if (state.schemaVersion !== 1 || state.apiScope !== client.apiBaseUrl || state.userId !== capture.captureUserId || state.proofId !== capture.captureProofId || state.sessionId !== sessionId || !Array.isArray(state.events) || state.events.length > 512)
      throw Object.assign(new Error('The saved code journal does not match this recording. Keep the original.'), { code: 'IDENTIFIER_INTEGRITY_ERROR' });
  } else {
    state = { schemaVersion: 1, apiScope: client.apiBaseUrl, userId: capture.captureUserId!, proofId: capture.captureProofId!,
      sessionId, policy: capture.identifierPolicy!, events: [], acknowledgedEventIds: [], omittedEvents: 0,
      coverage: fresh ? 'COMPLETE' : 'UNAVAILABLE', review: null, checkpointEventId: null };
    await persist(state);
  }
  const result = new IdentifierCapture(client, state); active.set(sessionId, result); return result;
  })();
  opening.set(sessionId, create);
  try { return await create; } finally { opening.delete(sessionId); }
}

export async function readIdentifierReview(client: PackProofV2Client, capture: LocalCapture): Promise<IdentifierReview | null> {
  const handle = await captureIdentifiers(client, capture);
  if (!handle) return null;
  await handle.flush();
  return handle.refresh();
}

/** Optional outages are recorded, while an acknowledged material conflict always blocks. */
export async function prepareIdentifierCheckpoint(client: PackProofV2Client, capture: LocalCapture, save: () => Promise<void>): Promise<void> {
  if (!identifierCaptureEnabled(capture.identifierPolicy)) return;
  let handle: IdentifierCapture | null = null;
  try {
    handle = await captureIdentifiers(client, capture);
    if (!handle) return;
    handle.resume();
    await handle.stopIntake();
    await handle.flush();
    // Join an earlier in-flight batch, then reconcile the fully drained Stop workset.
    await handle.flush();
    await handle.settleShipping();
    await handle.refresh();
    const state = handle.journal.snapshot();
    // The first server checkpoint is immutable; later supplemental revisions do
    // not authorize replacing it or broaden an already-held seller signature.
    if (state.review?.checkpoint) {
      await handle.freeze();
      if (capture.identifierCheckpoint && capture.identifierCheckpoint.sha256 !== state.review.checkpoint.sha256 && capture.recovery) capture.recovery.authorization = undefined;
      capture.identifierCheckpoint = state.review.checkpoint;
      capture.identifierCoverage = state.review.checkpoint.coverage;
      await save();
      return;
    }
    if (state.review?.reviewRequired) throw Object.assign(new Error('Check the item codes in this recording before confirming your shipment.'), { code: 'IDENTIFIER_REVIEW_REQUIRED', status: 409 });
    await handle.freeze();
    const lastSequence = state.events.reduce((last, row) => Math.max(last, row.sequence), 0);
    const pending = state.events.some(row => !state.acknowledgedEventIds.includes(row.clientEventId));
    const coverage = state.coverage === 'UNAVAILABLE' ? 'UNAVAILABLE' : pending || state.omittedEvents ? 'PARTIAL' : state.coverage;
    if (!capture.identifierCheckpointRequest || capture.identifierCheckpointRequest.revision !== (state.review?.revision ?? 0) || capture.identifierCheckpointRequest.lastSequence !== lastSequence) {
      capture.identifierCheckpointRequest = { clientEventId: newIdempotencyKey(), revision: state.review?.revision ?? 0, lastSequence, coverage, omittedEvents: state.omittedEvents };
      await handle.journal.setCheckpointEventId(capture.identifierCheckpointRequest.clientEventId);
      await save();
    }
    const review = await client.checkpointCaptureIdentifiers(state.proofId, state.sessionId, capture.identifierCheckpointRequest);
    handle.assertScope();
    if (review.reviewRequired) throw Object.assign(new Error('Review the code mismatch before confirming this shipment.'), { code: 'IDENTIFIER_REVIEW_REQUIRED', status: 409 });
    if (capture.identifierCheckpoint?.sha256 !== review.checkpoint?.sha256 && capture.recovery) capture.recovery.authorization = undefined;
    capture.identifierCheckpoint = review.checkpoint ?? undefined;
    capture.identifierCoverage = review.checkpoint?.coverage ?? coverage;
    await handle.journal.updateReview(review); await save();
  } catch (error) {
    if (identifierFailureBlocks(error)) throw error;
    handle?.markUnavailable();
    if (handle?.journal.snapshot().review?.reviewRequired) throw Object.assign(new Error('Check the saved code mismatch before confirming your shipment.'), { code: 'IDENTIFIER_REVIEW_REQUIRED', status: 409 });
    capture.identifierCoverage = 'UNAVAILABLE';
    await handle?.freeze().catch(() => undefined);
    await save();
  }
}
