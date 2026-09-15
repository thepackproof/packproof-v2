import { sha256 } from '@noble/hashes/sha256';

export type StatementKind = 'CORRECTION' | 'RECIPIENT_RESPONSE';
export type StatementScope = { scope: string; userId: string; proofId: string };
export type StatementIntent = StatementScope & { version: 1; operationId: string; text: string; kind: StatementKind; phase: 'DRAFT' | 'SUBMITTING' };
export type StatementRecord = { supplementId: string; proofId: string; sequence: number; kind: string; canonicalJson: string; sha256: string; createdAt: string };
export type StatementStorage = { getItem(key: string): Promise<string | null>; setItem(key: string, value: string): Promise<void>; removeItem(key: string): Promise<void> };
export type StatementRequest = { operationId: string; kind: StatementKind; facts: { statement: string } };
export type StatementState = { loaded: boolean; intent: StatementIntent | null; records: StatementRecord[]; busy: boolean; saving: boolean; storageBlocked: boolean; error: string | null; notice: string | null };

const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const id = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9:_-]{8,200}$/.test(value);
const storageMessage = 'Your statement could not be saved for recovery. Keep this screen open, free some device storage, and try saving it again.';
const conflictMessage = 'A different statement is saved for this Proof. Reload the saved statement before continuing.';
const staleMessage = 'Open the original account and Proof to continue this statement.';

export function statementJournalKey(value: StatementScope): string {
  return `packproof.statement.v1:${JSON.stringify([value.scope.replace(/\/+$/, ''), value.userId, value.proofId])}`;
}

export function readStatementIntent(raw: string | null, scope: StatementScope): StatementIntent | null {
  if (raw === null) return null;
  let value: unknown;
  try { value = JSON.parse(raw); } catch { throw new Error('The saved statement needs recovery. Keep it on this device and contact support.'); }
  if (!object(value) || value.version !== 1 || value.scope !== scope.scope || value.userId !== scope.userId || value.proofId !== scope.proofId ||
    !id(value.operationId) || typeof value.text !== 'string' || value.text.length > 4000 ||
    !['CORRECTION', 'RECIPIENT_RESPONSE'].includes(String(value.kind)) || !['DRAFT', 'SUBMITTING'].includes(String(value.phase))) {
    throw new Error('The saved statement needs recovery. Keep it on this device and contact support.');
  }
  return value as StatementIntent;
}

export function statementFacts(record: StatementRecord): Record<string, unknown> {
  const canonical: unknown = JSON.parse(record.canonicalJson);
  return object(canonical) && object(canonical.facts) ? canonical.facts : {};
}

/** Digest consistency and exact envelope binding; this does not assert independent signing-key trust. */
export function readStatementRecord(value: unknown, proofId: string): StatementRecord {
  const unavailable = () => new Error('Statement records could not be verified. Your saved statement remains on this device.');
  if (!object(value) || typeof value.supplementId !== 'string' || !value.supplementId || value.proofId !== proofId ||
    !Number.isSafeInteger(value.sequence) || Number(value.sequence) < 1 || typeof value.kind !== 'string' ||
    typeof value.canonicalJson !== 'string' || value.canonicalJson.length > 100_000 ||
    typeof value.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(value.sha256) ||
    typeof value.createdAt !== 'string' || !Number.isFinite(Date.parse(value.createdAt))) throw unavailable();
  let facts: unknown;
  try { facts = JSON.parse(value.canonicalJson); } catch { throw unavailable(); }
  const digest = Array.from(sha256(value.canonicalJson), byte => byte.toString(16).padStart(2, '0')).join('');
  if (digest !== value.sha256 || !object(facts) || facts.version !== 1 || facts.domain !== 'PACKPROOF_PROOF_SUPPLEMENT' ||
    facts.supplementId !== value.supplementId || facts.proofId !== proofId || facts.sequence !== value.sequence || facts.kind !== value.kind ||
    typeof facts.recordedAt !== 'string' || Date.parse(facts.recordedAt) !== Date.parse(value.createdAt)) throw unavailable();
  return value as StatementRecord;
}

export function readStatementRecords(value: unknown, proofId: string): StatementRecord[] {
  if (!object(value) || !Array.isArray(value.supplements)) throw new Error('Additional statements are temporarily unavailable. Your saved statement remains on this device.');
  const records = value.supplements.map(row => readStatementRecord(row, proofId)).sort((a, b) => a.sequence - b.sequence);
  if (new Set(records.map(row => row.supplementId)).size !== records.length || new Set(records.map(row => row.sequence)).size !== records.length)
    throw new Error('Statement records could not be verified. Retry loading this Proof.');
  return records;
}

export function statementWasAccepted(record: StatementRecord, intent: StatementIntent): boolean {
  const checked = readStatementRecord(record, intent.proofId);
  const canonical = JSON.parse(checked.canonicalJson) as Record<string, unknown>;
  return checked.kind === intent.kind && canonical.operationId === intent.operationId && canonical.actorUserId === intent.userId &&
    canonical.kind === intent.kind && object(canonical.facts) && Object.keys(canonical.facts).length === 1 &&
    canonical.facts.statement === intent.text.trim() && canonical.sourceReference === null && canonical.supersedesSupplementId === null;
}

// AsyncStorage has no compare-and-swap. Serializing all in-process readers/writers
// of this key also protects a remounted screen from the previous screen's late IO.
const locks = new Map<string, Promise<unknown>>();
async function withJournalLock<T>(key: string, work: () => Promise<T>): Promise<T> {
  const old = locks.get(key) ?? Promise.resolve();
  const next = old.catch(() => undefined).then(work);
  locks.set(key, next);
  try { return await next; } finally { if (locks.get(key) === next) locks.delete(key); }
}
const same = (a: StatementIntent | null, b: StatementIntent | null) => JSON.stringify(a) === JSON.stringify(b);

export class StatementController {
  private state: StatementState = { loaded: false, intent: null, records: [], busy: false, saving: false, storageBlocked: false, error: null, notice: null };
  private persisted: StatementIntent | null = null;
  private active = true;
  private loadFailed = false;
  private sending = false;
  private saves = 0;
  private tasks: Promise<unknown> = Promise.resolve();
  readonly context: StatementScope;
  readonly key: string;
  constructor(private options: {
    context: StatementScope; role: string; storage: StatementStorage; operationId: () => string;
    assertActive: () => void; beforeRequest: () => Promise<void>;
    list: () => Promise<unknown>; post: (body: StatementRequest) => Promise<unknown>;
    changed?: (state: StatementState) => void;
  }) {
    this.context = { ...options.context, scope: options.context.scope.replace(/\/+$/, '') };
    this.key = statementJournalKey(this.context);
  }
  snapshot(): StatementState { return { ...this.state, intent: this.state.intent ? { ...this.state.intent } : null, records: [...this.state.records] }; }
  dispose(): void { this.active = false; }
  private guard(): void { if (!this.active) throw new Error(staleMessage); this.options.assertActive(); }
  private update(change: Partial<StatementState>): void {
    try { this.guard(); } catch { return; }
    this.state = { ...this.state, ...change }; this.options.changed?.(this.snapshot());
  }
  private enqueue(work: () => Promise<void>): Promise<void> {
    const next = this.tasks.catch(() => undefined).then(work); this.tasks = next; return next;
  }
  private async stored(): Promise<StatementIntent | null> {
    this.guard(); const raw = await this.options.storage.getItem(this.key); this.guard(); return readStatementIntent(raw, this.context);
  }
  async load(): Promise<void> {
    await this.enqueue(async () => {
      this.guard();
      try {
        const saved = await withJournalLock(this.key, () => this.stored()); this.guard();
        this.persisted = saved; this.loadFailed = false;
        this.update({ loaded: true, intent: saved, storageBlocked: false, error: null });
      } catch (error) {
        this.loadFailed = true;
        this.update({ loaded: true, storageBlocked: true, error: error instanceof Error ? error.message : storageMessage });
      }
    });
    await this.refresh();
  }
  async refresh(): Promise<void> {
    try {
      if (this.state.storageBlocked && !this.savingDraft()) {
        await withJournalLock(this.key, async () => {
          const saved = await this.stored(), current = this.state.intent;
          // A storage call can report failure after its bytes were written. Adopt
          // only this exact visible request, never reset a different typed draft.
          if (current && saved && same({ ...current, phase: 'DRAFT' }, { ...saved, phase: 'DRAFT' })) {
            this.persisted = saved; this.loadFailed = false;
            this.update({ intent: saved, storageBlocked: false, error: null });
          }
        });
      }
      this.guard(); await this.options.beforeRequest(); this.guard();
      const result = await this.options.list(); this.guard();
      const records = readStatementRecords(result, this.context.proofId);
      // An older GET cannot erase an append already confirmed by a newer POST.
      this.update({ records: [...new Map([...records, ...this.state.records].map(row => [row.supplementId, row])).values()].sort((a, b) => a.sequence - b.sequence) });
      const pending = this.state.intent;
      if (pending?.phase === 'SUBMITTING') {
        const found = records.find(row => statementWasAccepted(row, pending));
        if (found) await this.accept(found, pending);
      }
    } catch (error) { this.update({ error: error instanceof Error ? error.message : 'Additional statements could not load. Your draft is kept.' }); }
  }
  private savingDraft(): boolean { return this.saves > 0; }
  edit(text: string): Promise<void> {
    this.guard();
    if (!this.state.loaded || this.loadFailed || this.sending || this.state.intent?.phase === 'SUBMITTING') return Promise.resolve();
    if (text.length > 4000) return Promise.resolve();
    if (!['BUYER', 'SELLER'].includes(this.options.role)) return Promise.reject(new Error('Only Proof participants can add a statement.'));
    const intent: StatementIntent = { ...this.context, version: 1, operationId: this.options.operationId(), text,
      kind: this.options.role === 'BUYER' ? 'RECIPIENT_RESPONSE' : 'CORRECTION', phase: 'DRAFT' };
    if (!id(intent.operationId)) return Promise.reject(new Error('A statement identifier could not be prepared. Try again.'));
    this.saves += 1; this.update({ intent, saving: true, notice: null });
    return this.enqueue(async () => {
      try {
        await withJournalLock(this.key, async () => {
          const saved = await this.stored();
          if (!same(saved, this.persisted) || saved?.phase === 'SUBMITTING') throw new Error(conflictMessage);
          this.guard(); await this.options.storage.setItem(this.key, JSON.stringify(intent)); this.guard();
          this.persisted = intent;
        });
        if (this.state.intent?.operationId === intent.operationId) this.update({ storageBlocked: false, error: null });
      } catch (error) { this.update({ storageBlocked: true, error: error instanceof Error && error.message === conflictMessage ? conflictMessage : storageMessage }); }
      finally { this.saves -= 1; this.update({ saving: this.saves > 0 }); }
    });
  }
  async submit(): Promise<void> {
    this.guard();
    if (this.sending || !this.state.loaded || this.loadFailed || !this.state.intent?.text.trim()) return;
    this.sending = true; this.update({ busy: true, error: null, notice: null });
    let prepared = false;
    try {
      await this.tasks; this.guard();
      if (this.state.storageBlocked) throw new Error(storageMessage);
      const pending = this.state.intent!;
      const submitted: StatementIntent = { ...pending, phase: 'SUBMITTING' };
      await withJournalLock(this.key, async () => {
        const saved = await this.stored();
        if (!same(saved, pending)) throw new Error(conflictMessage);
        this.guard(); await this.options.storage.setItem(this.key, JSON.stringify(submitted)); this.guard();
        this.persisted = submitted; this.update({ intent: submitted });
      });
      prepared = true;
      await this.options.beforeRequest(); this.guard();
      const result = await this.options.post({ operationId: submitted.operationId, kind: submitted.kind, facts: { statement: submitted.text.trim() } });
      this.guard(); await this.accept(readStatementRecord(result, submitted.proofId), submitted);
    } catch (error) {
      this.update({ ...(!prepared ? { storageBlocked: true } : {}), error: !prepared && !(error instanceof Error && error.message === conflictMessage)
        ? `${storageMessage} Refresh statements to recover its saved request.`
        : error instanceof Error ? error.message : 'Your statement could not be confirmed. Retry the same saved statement.' });
    } finally { this.sending = false; this.update({ busy: false }); }
  }
  private async accept(record: StatementRecord, pending: StatementIntent): Promise<void> {
    this.guard();
    if (!statementWasAccepted(record, pending)) throw new Error('The returned statement does not match your saved request. Retry the same statement.');
    this.update({ records: [...this.state.records.filter(row => row.supplementId !== record.supplementId), record].sort((a, b) => a.sequence - b.sequence) });
    await withJournalLock(this.key, async () => {
      const saved = await this.stored();
      // A foreground refresh and POST may confirm the same request concurrently.
      if (saved === null && this.state.intent === null) return;
      // AsyncStorage can remove the bytes and then lose its success callback.
      // A verified server receipt can clear this exact in-memory request without
      // touching storage again; a newer visible request must remain untouched.
      if (saved === null && same(this.state.intent, pending)) {
        this.persisted = null;
        this.update({ intent: null, storageBlocked: false, error: null, notice: 'Statement recorded. Preservation confirmation may still be pending.' });
        return;
      }
      if (!same(saved, pending)) throw new Error(conflictMessage);
      this.guard();
      try { await this.options.storage.removeItem(this.key); } catch { this.update({ storageBlocked: true }); throw new Error('The statement is recorded, but its saved retry could not be cleared. Reload to confirm it safely.'); }
      this.guard(); this.persisted = null;
      this.update({ intent: null, storageBlocked: false, error: null, notice: 'Statement recorded. Preservation confirmation may still be pending.' });
    });
  }
}
