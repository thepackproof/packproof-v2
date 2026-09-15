import { classifyIdentifier, IDENTIFIER_LIMITS, identifierUtf8Bytes, normalizeSymbology, sanitizeIdentifierPayload } from './core.js';
import type { DecodedIdentifier, IdentifierJournalState, IdentifierObservation, IdentifierReview } from './types.js';
export type { IdentifierJournalState, DecodedIdentifier } from './types.js';

export class IdentifierJournalError extends Error {
  constructor(public code: string, message: string) { super(message); this.name = 'IdentifierJournalError'; }
}
export interface IdentifierJournalOptions {
  persist: (state: IdentifierJournalState) => Promise<void>;
  send: (events: IdentifierObservation[]) => Promise<IdentifierReview>;
  makeId: () => string; assertScope: () => void;
  now?: () => number; random?: () => number;
}
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
const identity = (event: Pick<IdentifierObservation, 'rawText' | 'symbology' | 'symbologyIdentifier' | 'source' | 'recordingRef'>) =>
  JSON.stringify([normalizeSymbology(event.symbology), event.symbologyIdentifier, event.rawText, event.source, event.recordingRef]);
const materialError = (error: unknown): boolean => {
  const e = error as { code?: string; status?: number } | null;
  return e?.status === 401 || e?.status === 403 || e?.status === 409
    || /SCOPE|FORBIDDEN|UNAUTHORIZED|IDEMPOTENCY|CONFLICT|INTEGRITY|STALE|SESSION_MISMATCH/.test(e?.code ?? '');
};
const unavailableCapability = (error: unknown): boolean => {
  const e = error as { code?: string; status?: number } | null;
  return ((e?.status === 404 || e?.status === 405) && (!e.code || e.code === 'HTTP_ERROR'))
    || ['IDENTIFIER_DISABLED','IDENTIFIER_CAPABILITY_UNAVAILABLE','IDENTIFIERS_UNAVAILABLE','CAPTURE_CAPABILITY_UNAVAILABLE'].includes(e?.code ?? '');
};

/** Persist-only observation intake; a single explicit flush batches immutable, unacknowledged IDs.
 * This class never changes capture/Proof identity and never starts another recorder.
 */
export class IdentifierJournal {
  private state: IdentifierJournalState;
  private writes: Promise<void> = Promise.resolve();
  private flight: Promise<IdentifierReview | null> | null = null;
  private retryAfterAt = 0;
  private failures = 0;
  private readonly now: () => number;
  private readonly random: () => number;
  private persistFailed = false;
  private transportUnavailable = false;

  constructor(state: IdentifierJournalState, private readonly options: IdentifierJournalOptions) {
    this.assertScope();
    this.state = clone(state);
    this.transportUnavailable = state.review?.enabled === false;
    this.now = options.now ?? Date.now; this.random = options.random ?? Math.random;
    if (state.schemaVersion !== 1 || state.policy.version !== 1 || !state.apiScope || !state.userId || !state.proofId || !state.sessionId
      || state.events.length > IDENTIFIER_LIMITS.sessionEvents)
      throw new IdentifierJournalError('IDENTIFIER_JOURNAL_INVALID', 'The saved identifier journal is not supported.');
    const ids = new Set<string>(); const sequences = new Set<number>();
    for (const event of state.events) {
      if (event.captureSessionId !== state.sessionId || !event.clientEventId || ids.has(event.clientEventId)
        || !Number.isSafeInteger(event.sequence) || event.sequence < 1 || sequences.has(event.sequence))
        throw new IdentifierJournalError('IDENTIFIER_JOURNAL_INTEGRITY', 'Saved observations must retain their original session and event identities.');
      ids.add(event.clientEventId); sequences.add(event.sequence);
    }
    if (state.acknowledgedEventIds.some(id => !ids.has(id)))
      throw new IdentifierJournalError('IDENTIFIER_JOURNAL_INTEGRITY', 'The saved acknowledgment references an unknown event.');
  }

  private assertScope(): void {
    try { this.options.assertScope(); }
    catch { throw new IdentifierJournalError('IDENTIFIER_SCOPE_MISMATCH', 'Return to the original account and API environment to resume this recording.'); }
  }

  snapshot(): IdentifierJournalState { this.assertScope(); return clone(this.state); }

  private enqueue(action: () => Promise<void>): Promise<void> {
    const operation = this.writes.then(async () => { this.assertScope(); await action(); });
    this.writes = operation.catch(() => undefined);
    return operation;
  }

  private async persist(): Promise<void> {
    this.assertScope();
    try { await this.options.persist(clone(this.state)); this.persistFailed = false; }
    catch (error) {
      if (materialError(error)) throw error;
      this.persistFailed = true;
      this.state.coverage = this.state.events.length ? 'PARTIAL' : 'UNAVAILABLE';
      throw new IdentifierJournalError('IDENTIFIER_STORAGE_UNAVAILABLE', 'Item recognition could not be saved. The recording can continue.');
    }
  }

  async observe(decoded: DecodedIdentifier): Promise<void> {
    // Sanitize immediately so even a pending persistence closure never retains unrelated QR secrets.
    const safe = sanitizeIdentifierPayload(decoded);
    return this.enqueue(async () => {
      if (!this.state.policy.captureEnabled) return;
      if (!Number.isSafeInteger(safe.mediaTimeMs) || safe.mediaTimeMs < 0 || !safe.recordingRef
        || !safe.adapterVersion || !safe.decoderVersion || !safe.capabilityProfile)
        throw new IdentifierJournalError('IDENTIFIER_OBSERVATION_INVALID', 'Identifier observations require capture provenance.');
      // Coalesce identical sightings without ever rewriting a queued/accepted event's body.
      // sightings=1 and first/last equal describe this persisted detection, never a shipped quantity.
      if (this.state.events.some(event => identity(event) === identity(safe))) return;
      const kind = classifyIdentifier(safe).kind;
      const limit = kind === 'OPAQUE' ? IDENTIFIER_LIMITS.sessionEvents
        : IDENTIFIER_LIMITS.sessionEvents - IDENTIFIER_LIMITS.reservedOpaqueEvents;
      if (this.state.events.length >= limit || (safe.rawBytes != null && safe.rawBytes.length > 8192)) {
        this.state.omittedEvents++; this.state.coverage = 'PARTIAL'; await this.persist(); return;
      }
      const clientEventId = this.options.makeId();
      if (!clientEventId || this.state.events.some(event => event.clientEventId === clientEventId))
        throw new IdentifierJournalError('IDENTIFIER_JOURNAL_INTEGRITY', 'Observation IDs must be unique.');
      const event: IdentifierObservation = { ...clone(safe), schemaVersion:1, clientEventId,
        captureSessionId:this.state.sessionId, sequence:Math.max(0, ...this.state.events.map(e => e.sequence)) + 1,
        firstSeenMs:safe.mediaTimeMs, lastSeenMs:safe.mediaTimeMs, sightings:1 };
      if (identifierUtf8Bytes(JSON.stringify({ events:[event] })) > IDENTIFIER_LIMITS.requestBytes) {
        this.state.omittedEvents++; this.state.coverage = 'PARTIAL'; await this.persist(); return;
      }
      this.state.events.push(event);
      // A fresh checkpoint is required after additional local observations.
      this.state.checkpointEventId = null;
      await this.persist();
    });
  }

  /** Wait only for local writes, suitable at Stop before the existing completion coordinator. */
  async drain(): Promise<void> {
    this.assertScope();
    await this.writes;
    this.assertScope();
    if (this.persistFailed) throw new IdentifierJournalError('IDENTIFIER_STORAGE_UNAVAILABLE', 'Item recognition could not be saved.');
  }

  private reconcile(review: IdentifierReview): void {
    if (review.schemaVersion !== 1 || !Number.isSafeInteger(review.revision) || review.revision < 0)
      throw new IdentifierJournalError('IDENTIFIER_RESPONSE_INTEGRITY', 'The server returned an unsupported identifier review.');
    if (review.observations.some(row => row.observation.captureSessionId !== this.state.sessionId))
      throw new IdentifierJournalError('IDENTIFIER_RESPONSE_INTEGRITY', 'The server review belongs to another capture session.');
    if (this.state.review && review.revision < this.state.review.revision) return;
    if (this.state.review?.checkpoint && !review.checkpoint)
      review = {...review,checkpoint:this.state.review.checkpoint,coverage:this.state.review.checkpoint.coverage};
    const localIds = new Set(this.state.events.map(e => e.clientEventId));
    const acknowledged = new Set(this.state.acknowledgedEventIds);
    for (const id of review.acceptedEventIds) if (localIds.has(id)) acknowledged.add(id);
    this.state.acknowledgedEventIds = [...acknowledged];
    this.state.review = clone(review);
    if (!review.enabled) { this.transportUnavailable = true; this.state.coverage = this.state.events.length ? 'PARTIAL' : 'UNAVAILABLE'; }
    // An unsealed server review is provisional; only a sealed coverage result
    // or actual omissions can downgrade the local analyzer's coverage.
    else if ((review.checkpoint && review.coverage !== 'COMPLETE') || review.omittedEvents > 0)
      this.state.coverage = this.state.events.length ? 'PARTIAL' : review.coverage;
  }

  async updateReview(review: IdentifierReview): Promise<void> {
    const saved = clone(review);
    return this.enqueue(async () => { this.reconcile(saved); await this.persist(); });
  }

  async setCheckpointEventId(id: string | null): Promise<void> {
    return this.enqueue(async () => { this.state.checkpointEventId = id; await this.persist(); });
  }

  markUnavailable(): void {
    this.assertScope();
    // Make the coverage visible to an immediate snapshot and queue a durable write.
    this.state.coverage = this.state.events.length ? 'PARTIAL' : 'UNAVAILABLE';
    void this.enqueue(async () => { await this.persist(); }).catch(() => undefined);
  }

  flush(): Promise<IdentifierReview | null> {
    this.assertScope();
    if (this.flight) return this.flight;
    const run = this.flushPending();
    this.flight = run.finally(() => { this.flight = null; });
    return this.flight;
  }

  private async flushPending(): Promise<IdentifierReview | null> {
    await this.writes; this.assertScope();
    if (!this.state.policy.captureEnabled || this.transportUnavailable || this.now() < this.retryAfterAt) return clone(this.state.review);
    // Capture the finite workset; observations arriving during transport are for the next flush.
    const pending = this.state.events.filter(e => !this.state.acknowledgedEventIds.includes(e.clientEventId));
    if (!pending.length) return clone(this.state.review);
    for (let start = 0; start < pending.length;) {
      const batch: IdentifierObservation[] = [];
      while (start < pending.length && batch.length < IDENTIFIER_LIMITS.batchEvents) {
        const candidate = pending[start];
        if (identifierUtf8Bytes(JSON.stringify({ events:[...batch, candidate] })) > IDENTIFIER_LIMITS.requestBytes) break;
        batch.push(clone(candidate)); start++;
      }
      if (!batch.length) { this.state.coverage = 'PARTIAL'; break; }
      try {
        // Retry an earlier storage outage BEFORE attempting any server mutation.
        await this.enqueue(async () => { await this.persist(); });
        this.assertScope();
        const review = await this.options.send(clone(batch));
        this.assertScope();
        await this.updateReview(review);
        this.failures = 0; this.retryAfterAt = 0;
        // Partial acknowledgment is retried with these exact IDs/body on the next flush.
        if (batch.some(e => !this.state.acknowledgedEventIds.includes(e.clientEventId))) {
          await this.enqueue(async () => { this.state.coverage = 'PARTIAL'; await this.persist(); });
          break;
        }
      } catch (error) {
        if (materialError(error)) throw error;
        if (unavailableCapability(error)) this.transportUnavailable = true;
        this.failures++;
        this.retryAfterAt = this.now() + Math.min(8000, 250 * 2 ** Math.min(this.failures - 1, 5)) * (0.75 + this.random() * 0.5);
        this.state.coverage = this.state.events.length ? 'PARTIAL' : 'UNAVAILABLE';
        // An optional service/storage outage never erases a known server conflict or its review.
        try { await this.enqueue(async () => { await this.persist(); }); } catch (saveError) { if (materialError(saveError)) throw saveError; }
        break;
      }
    }
    return clone(this.state.review);
  }
}
