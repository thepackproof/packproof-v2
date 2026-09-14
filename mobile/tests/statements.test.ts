import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { StatementController, readStatementRecord, readStatementRecords, statementJournalKey, type StatementRequest, type StatementScope, type StatementStorage } from '../src/supporting/statements';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
function receipt(body: StatementRequest, actorUserId = 'seller', proofId = 'proof-1', sequence = 1) {
  const supplementId = `sup_${sequence}`, createdAt = '2026-09-14T10:00:00.000Z';
  const canonicalJson = JSON.stringify({ version: 1, domain: 'PACKPROOF_PROOF_SUPPLEMENT', supplementId, proofId, sequence,
    operationId: body.operationId, actorUserId, kind: body.kind, facts: body.facts,
    sourceReference: null, supersedesSupplementId: null, recordedAt: createdAt });
  return { supplementId, proofId, sequence, kind: body.kind, canonicalJson, sha256: createHash('sha256').update(canonicalJson).digest('hex'), createdAt };
}
let scopeCounter = 0;
function fixture(context?: Partial<StatementScope>) {
  const values = new Map<string, string>();
  const storage: StatementStorage = {
    getItem: async key => values.get(key) ?? null,
    setItem: async (key, value) => { values.set(key, value); },
    removeItem: async key => { values.delete(key); },
  };
  const ctx = { scope: `https://api-${++scopeCounter}.example.test`, userId: 'seller', proofId: 'proof-1', ...context };
  const writes: StatementRequest[] = [];
  let records: unknown[] = [], serial = 0, current = true;
  let beforeRequest = async () => undefined;
  let post = async (body: StatementRequest): Promise<unknown> => receipt(body, ctx.userId, ctx.proofId);
  const make = (overrides?: Partial<StatementScope>) => new StatementController({
    context: { ...ctx, ...overrides }, role: (overrides?.userId ?? ctx.userId) === 'buyer' ? 'BUYER' : 'SELLER', storage,
    operationId: () => `operation-${++serial}`,
    assertActive: () => { if (!current) throw new Error('Account changed'); },
    beforeRequest: () => beforeRequest(), list: async () => ({ supplements: records }),
    post: body => { writes.push(body); return post(body); },
  });
  return { ctx, storage, values, writes, make, records: (next: unknown[]) => { records = next; }, post: (next: typeof post) => { post = next; },
    fence: (next: typeof beforeRequest) => { beforeRequest = next; }, leave: () => { current = false; } };
}

test('lost response and restart retain exact text, kind and operation ID on retry', async () => {
  const f = fixture(); f.post(async () => { throw new Error('Response lost'); });
  const first = f.make(); await first.load(); await first.edit('  The seal was intact.  '); await first.submit();
  assert.equal(first.snapshot().intent?.phase, 'SUBMITTING'); assert.match(first.snapshot().error!, /Response lost/);
  await first.edit('An attempted replacement'); assert.equal(first.snapshot().intent?.text, '  The seal was intact.  ');
  first.dispose();
  f.post(async body => receipt(body)); const second = f.make(); await second.load();
  assert.equal(second.snapshot().intent?.phase, 'SUBMITTING'); await second.submit();
  assert.equal(f.writes.length, 2); assert.deepEqual(f.writes[1], f.writes[0]);
  assert.equal(f.writes[0].facts.statement, 'The seal was intact.');
  assert.equal(second.snapshot().intent, null); assert.equal(f.values.size, 0);
  assert.match(second.snapshot().notice!, /Statement recorded/);
});

test('reload reconciles server acceptance without another POST after response loss', async () => {
  const f = fixture(); f.post(async body => { f.records([receipt(body)]); throw new Error('Connection lost'); });
  const first = f.make(); await first.load(); await first.edit('Additional packing context'); await first.submit(); first.dispose();
  const second = f.make(); await second.load();
  assert.equal(f.writes.length, 1); assert.equal(second.snapshot().intent, null);
  assert.equal(second.snapshot().records.length, 1); assert.equal(f.values.size, 0);
});

test('drafts are isolated by API, account and Proof and reload only in their original scope', async () => {
  const f = fixture(); const original = f.make(); await original.load(); await original.edit('Private seller notes');
  for (const other of [{ scope: 'https://other.example.test' }, { userId: 'buyer' }, { proofId: 'proof-2' }]) {
    const model = f.make(other); await model.load(); assert.equal(model.snapshot().intent, null); model.dispose();
  }
  const restored = f.make(); await restored.load(); assert.equal(restored.snapshot().intent?.text, 'Private seller notes');
  assert.notEqual(statementJournalKey(f.ctx), statementJournalKey({ ...f.ctx, proofId: 'proof-2' }));
});

test('rapid asynchronous edits serialize and a submit uses only the last durably saved draft', async () => {
  const f = fixture(); const model = f.make(); await model.load();
  const a = model.edit('First'), b = model.edit('Second'), c = model.edit('Latest statement');
  await model.submit(); await Promise.all([a, b, c]);
  assert.equal(f.writes.length, 1); assert.equal(f.writes[0].facts.statement, 'Latest statement');
  assert.equal(model.snapshot().intent, null);
});

test('storage failure keeps typed text visible, blocks HTTP, and permits an explicit save retry', async () => {
  const f = fixture(); const model = f.make(); await model.load();
  const save = f.storage.setItem; f.storage.setItem = async () => { throw new Error('Storage full'); };
  await model.edit('Keep these details'); await model.submit();
  assert.equal(model.snapshot().intent?.text, 'Keep these details'); assert.equal(model.snapshot().storageBlocked, true); assert.equal(f.writes.length, 0);
  f.storage.setItem = save; await model.edit(model.snapshot().intent!.text); await model.submit();
  assert.equal(f.writes.length, 1); assert.equal(f.writes[0].facts.statement, 'Keep these details');
});

test('SUBMITTING must be persisted before POST; failing that write never sends the request', async () => {
  const f = fixture(); const model = f.make(); await model.load(); await model.edit('Durable consent');
  f.storage.setItem = async () => { throw new Error('Storage unavailable'); };
  await model.submit(); assert.equal(f.writes.length, 0);
  assert.equal(JSON.parse(f.values.get(statementJournalKey(f.ctx))!).phase, 'DRAFT');
  assert.equal(model.snapshot().intent?.text, 'Durable consent');
  assert.equal(model.snapshot().storageBlocked, true);
});

test('refresh recovers a SUBMITTING storage write whose success callback was lost, without resetting text or operation', async () => {
  const f = fixture(); const model = f.make(); await model.load(); await model.edit('Keep the exact intent');
  const operationId = model.snapshot().intent!.operationId;
  const save = f.storage.setItem;
  f.storage.setItem = async (key, value) => { await save(key, value); throw new Error('Storage callback lost'); };
  await model.submit(); assert.equal(f.writes.length, 0); assert.equal(model.snapshot().storageBlocked, true);
  f.storage.setItem = save; await model.refresh();
  assert.equal(model.snapshot().intent?.phase, 'SUBMITTING'); assert.equal(model.snapshot().intent?.operationId, operationId);
  assert.equal(model.snapshot().intent?.text, 'Keep the exact intent'); assert.equal(model.snapshot().storageBlocked, false);
  await model.submit(); assert.equal(f.writes.length, 1); assert.equal(f.writes[0].operationId, operationId);
});

test('a corrupt persisted intent blocks editing and new posts without deleting the saved bytes', async () => {
  const f = fixture(); f.values.set(statementJournalKey(f.ctx), '{broken');
  const model = f.make(); await model.load(); await model.edit('New request'); await model.submit();
  assert.equal(model.snapshot().storageBlocked, true); assert.equal(f.writes.length, 0);
  assert.equal(f.values.get(statementJournalKey(f.ctx)), '{broken');
});

test('another controller cannot overwrite an existing draft or clear a newer operation', async () => {
  const f = fixture(); const first = f.make(), other = f.make(); await first.load(); await other.load();
  await first.edit('Original draft'); await other.edit('Conflicting draft');
  assert.equal(other.snapshot().storageBlocked, true);
  assert.equal(JSON.parse(f.values.get(statementJournalKey(f.ctx))!).text, 'Original draft');
  const pending = deferred<unknown>(); f.post(() => pending.promise);
  const sent = first.submit();
  while (!f.writes.length) await new Promise(resolve => setTimeout(resolve, 0));
  const newer = { ...first.snapshot().intent!, operationId: 'newer-operation', text: 'Newer saved intent' };
  f.values.set(statementJournalKey(f.ctx), JSON.stringify(newer)); pending.resolve(receipt(f.writes[0])); await sent;
  assert.equal(JSON.parse(f.values.get(statementJournalKey(f.ctx))!).operationId, 'newer-operation');
  assert.match(first.snapshot().error!, /different statement/);
});

test('foreign actor, altered text, mismatched kind, and digest corruption cannot clear a pending statement', async () => {
  for (const variant of ['actor', 'text', 'kind', 'digest', 'proof'] as const) {
    const f = fixture(); const model = f.make(); await model.load(); await model.edit('Exact statement');
    f.post(async body => {
      if (variant === 'actor') return receipt(body, 'other-user');
      if (variant === 'text') return receipt({ ...body, facts: { statement: 'Changed' } });
      if (variant === 'kind') return receipt({ ...body, kind: 'RECIPIENT_RESPONSE' });
      if (variant === 'proof') return receipt(body, 'seller', 'another-proof');
      return { ...receipt(body), sha256: '0'.repeat(64) };
    });
    await model.submit(); assert.equal(model.snapshot().intent?.phase, 'SUBMITTING', variant);
    assert.ok(f.values.has(statementJournalKey(f.ctx))); assert.equal(model.snapshot().notice, null);
  }
});

test('account change during auth prevents POST and late responses never update a disposed screen', async () => {
  const f = fixture(); const model = f.make(); await model.load(); await model.edit('Original account');
  const auth = deferred<void>(); f.fence(() => auth.promise); const sent = model.submit();
  while (model.snapshot().intent?.phase !== 'SUBMITTING') await new Promise(resolve => setTimeout(resolve, 0));
  f.leave(); auth.resolve(); await sent; assert.equal(f.writes.length, 0); assert.ok(f.values.has(statementJournalKey(f.ctx)));

  const second = fixture(); const active = second.make(); await active.load(); await active.edit('Keep after leaving');
  const result = deferred<unknown>(); second.post(() => result.promise); const request = active.submit();
  while (!second.writes.length) await new Promise(resolve => setTimeout(resolve, 0));
  active.dispose(); result.resolve(receipt(second.writes[0])); await request;
  assert.equal(active.snapshot().notice, null); assert.ok(second.values.has(statementJournalKey(second.ctx)));
});

test('an accepted statement with failed local cleanup remains recoverable and refresh clears it without reposting', async () => {
  const f = fixture(); f.post(async body => { const row = receipt(body); f.records([row]); return row; });
  const remove = f.storage.removeItem; f.storage.removeItem = async () => { throw new Error('IO unavailable'); };
  const model = f.make(); await model.load(); await model.edit('Preserve my retry'); await model.submit();
  assert.equal(model.snapshot().intent?.phase, 'SUBMITTING'); assert.equal(model.snapshot().records.length, 1);
  f.storage.removeItem = remove; await model.refresh();
  assert.equal(model.snapshot().intent, null); assert.equal(f.writes.length, 1);
});

test('a lost cleanup success callback recovers the accepted statement without a restart or another POST', async () => {
  const f = fixture(); f.post(async body => { const row = receipt(body); f.records([row]); return row; });
  const remove = f.storage.removeItem;
  f.storage.removeItem = async key => { await remove(key); throw new Error('Cleanup callback lost'); };
  const model = f.make(); await model.load(); await model.edit('Recorded before cleanup'); await model.submit();
  assert.equal(model.snapshot().intent?.phase, 'SUBMITTING'); assert.equal(model.snapshot().storageBlocked, true);
  assert.equal(f.values.size, 0);
  await model.refresh();
  assert.equal(model.snapshot().intent, null); assert.equal(model.snapshot().storageBlocked, false);
  assert.equal(f.writes.length, 1); assert.match(model.snapshot().notice!, /Statement recorded/);
});

test('recipient responses use participant attribution and records reject malformed canonical bindings', async () => {
  const f = fixture({ userId: 'buyer' }); const model = f.make(); await model.load(); await model.edit('Received with seal intact'); await model.submit();
  assert.equal(f.writes[0].kind, 'RECIPIENT_RESPONSE');
  const row = receipt(f.writes[0], 'buyer'); assert.equal(readStatementRecord(row, 'proof-1').kind, 'RECIPIENT_RESPONSE');
  assert.throws(() => readStatementRecord({ ...row, sequence: 2 }, 'proof-1'));
  assert.throws(() => readStatementRecords({ supplements: [row, row] }, 'proof-1'));
  assert.throws(() => readStatementRecords({ supplements: null }, 'proof-1'));
});
