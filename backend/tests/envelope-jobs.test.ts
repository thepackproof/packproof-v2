import { generateKeyPairSync, randomBytes, sign } from 'node:crypto';
import { FlattenedSign } from 'jose';
import { afterEach, describe, expect, it } from 'vitest';
import { createHarness, createUser, commitFulfillmentAndAttest, type TestHarness } from './helpers.js';
import { createTransaction } from '../src/domain/transactions.js';
import { createOrGetProof } from '../src/domain/create-proof.js';
import { finalizeProof } from '../src/domain/finalize.js';
import { processRecoveryOutbox, type RecoveryPublisher } from '../src/domain/recovery-journal.js';
import { processPolicyRecoveryOutbox } from '../src/domain/policy-recovery.js';
import { enqueueEnvelopeFromRecovery, processEnvelopeJob, envelopeJobStatus, envelopeBundleKey, type EnvelopeStore, type EnvelopeWorker, type ProtectedReceipt } from '../src/integrity/envelope-jobs.js';
import { ENVELOPE_TYPE, jcsBytes, sha256, type ExactObject } from '../src/integrity/envelope-profile.js';
import type { Database } from '../src/db/database.js';
import { VersionedMemoryObjectStore } from './versioned-memory-object-store.js';
import { createPgDatabase } from '../src/db/postgres.js';

const postgresUrl = process.env.PACKPROOF_ENVELOPE_TEST_DATABASE_URL;

const keys = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
const pem = keys.publicKey.export({ type: 'spki', format: 'pem' }).toString();
const until = '2027-10-22T05:00:00.000Z';
let now = new Date('2026-10-22T05:00:00.000Z');
const clock = { now: () => new Date(now) };
class Journal {
  objects = new Map<string, Buffer>();
  async putIfAbsent(key: string, bytes: Buffer) { if (this.objects.has(key)) return { created: false }; this.objects.set(key, bytes); return { created: true }; }
  async get(key: string) { const body = this.objects.get(key); return body ? { body, contentType: 'application/json' } : null; }
  async head(key: string) { return this.objects.has(key) ? { versionId: 'protected-journal-version' } : null; }
}
class ProtectedStore implements EnvelopeStore {
  objects = new Map<string, { body: Buffer; object: ExactObject }>();
  lostBundleResponse = false; invalidProtection = false; assertOutside = () => {};
  async find(bucket: string, key: string) { this.assertOutside(); return this.objects.get(`${bucket}/${key}`) ?? null; }
  async preserve(bucket: string, key: string, body: Buffer, retainUntil: string) {
    this.assertOutside(); const id = `${bucket}/${key}`;
    if (!this.objects.has(id)) this.objects.set(id, { body, object: { bucket, key, versionId: `v${this.objects.size + 1}` } });
    if (key.includes('/envelopes/') && this.lostBundleResponse) { this.lostBundleResponse = false; throw Error('Lost response after preservation'); }
    const saved = this.objects.get(id)!;
    return this.verify({ storage: saved.object, sha256: sha256(saved.body), byteSize: saved.body.length }, retainUntil);
  }
  async verify(artifact: { storage: ExactObject; sha256: string; byteSize: number }, retainUntil: string): Promise<ProtectedReceipt> {
    this.assertOutside(); const saved = this.objects.get(`${artifact.storage.bucket}/${artifact.storage.key}`);
    if (!saved || saved.object.versionId !== artifact.storage.versionId || sha256(saved.body) !== artifact.sha256 || saved.body.length !== artifact.byteSize) throw Error('ENVELOPE_OBJECT_DIGEST_MISMATCH');
    return { object: saved.object, sha256: artifact.sha256, byteSize: artifact.byteSize, mode: 'COMPLIANCE', retainUntil: this.invalidProtection ? now.toISOString() : retainUntil, verifiedAt: now.toISOString() };
  }
}
describe('durable additive signing from real finalized records', () => {
  let h: TestHarness;
  let closePostgres: (() => Promise<void>) | undefined, secondDb: Database | undefined;
  afterEach(async () => { await h?.close(); await closePostgres?.(); closePostgres=undefined; secondDb=undefined; now = new Date('2026-10-22T05:00:00.000Z'); });
  async function setup() {
    let opened: ReturnType<typeof createPgDatabase> | undefined;
    if (postgresUrl) {
      const admin = createPgDatabase(postgresUrl), schema = `envelope_test_${randomBytes(10).toString('hex')}`;
      await admin.db.query(`CREATE SCHEMA ${schema}`);
      const url = new URL(postgresUrl); url.searchParams.set('options', `-c search_path=${schema}`);
      opened = createPgDatabase(url.toString()); const other = createPgDatabase(url.toString()); secondDb=other.db;
      const first=opened;closePostgres=async()=>{await Promise.all([first.close(),other.close()]);await admin.db.query(`DROP SCHEMA ${schema} CASCADE`);await admin.close();};
      expect((await opened.db.query<{version:string}>('SELECT version() AS version')).rows[0].version).toMatch(/^PostgreSQL /);
    }
    h = await createHarness(clock, { objectStore: new VersionedMemoryObjectStore(), opened });
    const seller = await createUser(h), transaction = await createTransaction(h.db, clock, seller, { itemTitle: 'Frozen source' });
    const { proofId } = await createOrGetProof(h.db, clock, seller, transaction.transactionId);
    const journal = new Journal(), store = new ProtectedStore();
    const publisher: RecoveryPublisher = { store: journal, protectedStoreVerified: true, writerGeneration: 'initial', trustedPublicKey: async id => id === 'journal-key' ? pem : null,
      signer: { signManifest: async input => ({ algorithm: 'ECDSA_SHA_256', keyId: 'journal-key', signedAt: now.toISOString(), signatureBase64: sign('sha256', Buffer.from(input.canonicalJson), keys.privateKey).toString('base64') }) } };
    await commitFulfillmentAndAttest(h, seller, proofId);
    async function drain() {
      for (let i = 0; i < 100; i++) { const result = await processPolicyRecoveryOutbox(h.db, clock, publisher); if (!result.processed) break; expect(result.state).toBe('DURABLE'); }
      for (let i = 0; i < 100; i++) { const result = await processRecoveryOutbox(h.db, clock, publisher); if (!result.processed) break; expect(result.state).toBe('DURABLE'); }
    }
    await drain();
    await finalizeProof(h.db, clock, seller, proofId, publisher.signer, { requireDurableReceipts: true }); await drain();
    const frozen = (await h.db.query<{ canonical_json: string; sha256: string }>('SELECT canonical_json,sha256 FROM final_manifests WHERE proof_id=$1', [proofId])).rows[0];
    for (const media of JSON.parse(frozen.canonical_json).evidence) {
      const saved = await h.objectStore.get(media.objectKey, { versionId: media.objectVersionId });
      store.objects.set(`evidence-fixture/${media.objectKey}`, { body: saved!.body, object: { bucket: 'evidence-fixture', key: media.objectKey, versionId: media.objectVersionId } });
    }
    const input = { sourceOperationId: `finalize:${proofId}`, evidenceBucket: 'evidence-fixture', artifactBucket: 'envelope-fixture', issuer: 'https://issuer.example.test', keyId: 'envelope-key', retainUntil: until, writerGeneration: 'initial' };
    const job = await enqueueEnvelopeFromRecovery(h.db, clock, input);
    let signCalls = 0, inTransaction = 0;
    const guardedDb: Database = { query: h.db.query.bind(h.db), transaction: async fn => h.db.transaction(async tx => { inTransaction++; try { return await fn(tx); } finally { inTransaction--; } }) };
    store.assertOutside = () => expect(inTransaction).toBe(0);
    const worker: EnvelopeWorker = { writerGeneration: 'initial', store, sourceJournal: publisher, trustedPublicKey: async (issuer, id) => issuer === input.issuer && id === input.keyId ? pem : null,
      sign: async (kid, bytes) => { expect(inTransaction).toBe(0); signCalls++; return new FlattenedSign(bytes).setProtectedHeader(JSON.parse(jcsBytes({ alg: 'ES256', kid, typ: ENVELOPE_TYPE }).toString())).sign(keys.privateKey); } };
    return { seller, proofId, input, job, worker, store, journal, publisher, drain, frozen, db: guardedDb, signCalls: () => signCalls };
  }
  it('waits for a protected job, signs outside transactions, and waits for a protected result without changing the core', async () => {
    const f = await setup();
    expect(await processEnvelopeJob(f.db, clock, f.worker)).toEqual({ processed: 0 }); expect(f.signCalls()).toBe(0);
    await f.drain();
    expect(await processEnvelopeJob(f.db, clock, f.worker)).toEqual({ processed: 1, state: 'SIGNED_PENDING_DURABILITY' });
    expect(await envelopeJobStatus(f.db, f.job.operationId)).toEqual({ state: 'SIGNED_PENDING_DURABILITY' });
    await f.drain(); expect(await envelopeJobStatus(f.db, f.job.operationId)).toEqual({ state: 'READY' });
    expect(await processEnvelopeJob(f.db, clock, f.worker)).toEqual({ processed: 0 });
    expect(f.signCalls()).toBe(1);
    expect((await h.db.query('SELECT canonical_json,sha256 FROM final_manifests WHERE proof_id=$1', [f.proofId])).rows[0]).toEqual(f.frozen);
    const replay = await finalizeProof(h.db, clock, f.seller, f.proofId, f.publisher.signer, { requireDurableReceipts: true }); expect(replay.proof.status).toBe('FINALIZED');
    await expect(h.db.query("UPDATE integrity_envelope_results SET bundle_json='{}'")).rejects.toThrow('AUDIT_IMMUTABLE');
  });
  it('reuses the first signature after a lost protected-storage response', async () => {
    const f = await setup(); await f.drain(); f.store.lostBundleResponse = true;
    expect((await processEnvelopeJob(f.db, clock, f.worker)).state).toBe('PENDING');
    const first = (await f.store.find('envelope-fixture', envelopeBundleKey(f.job.operationId)))!.body;
    now = new Date(now.getTime() + 3000);
    expect((await processEnvelopeJob(f.db, clock, f.worker)).state).toBe('SIGNED_PENDING_DURABILITY');
    expect(f.signCalls()).toBe(1);
    expect((await h.db.query('SELECT bundle_json FROM integrity_envelope_results')).rows[0].bundle_json).toBe(first.toString());
  });
  it('recovers a database crash after publication without resigning', async () => {
    const f = await setup(); await f.drain(); let crash = true;
    const db: Database = { ...f.db, transaction: fn => f.db.transaction(tx => fn({ ...tx, query: async <T>(sql: string, args?: unknown[]) => {
      const result = await tx.query<T>(sql, args); if (crash && sql.startsWith('INSERT INTO integrity_envelope_results')) { crash = false; throw Error('Injected database crash'); } return result;
    } })) };
    expect((await processEnvelopeJob(db, clock, f.worker)).state).toBe('PENDING');
    expect((await h.db.query('SELECT * FROM integrity_envelope_results')).rows).toHaveLength(0);
    now = new Date(now.getTime() + 3000); expect((await processEnvelopeJob(f.db, clock, f.worker)).state).toBe('SIGNED_PENDING_DURABILITY'); expect(f.signCalls()).toBe(1);
  });
  it('does not acknowledge a worker whose lease expired during signing', async () => {
    const f = await setup(); await f.drain(); const original = f.store.find.bind(f.store);let expire=true;
    f.store.find = async (...args) => { const result = await original(...args); if(result&&expire){expire=false;now = new Date(now.getTime() + 121000);}return result; };
    expect((await processEnvelopeJob(f.db, clock, f.worker)).state).toBe('LEASE_LOST');
    expect((await h.db.query('SELECT * FROM integrity_envelope_results')).rows).toHaveLength(0);
    now=new Date(now.getTime()+3000);expect((await processEnvelopeJob(f.db, clock, f.worker)).state).toBe('SIGNED_PENDING_DURABILITY'); expect(f.signCalls()).toBe(1);
  });
  it('fences a held-open worker and reconciles its protected candidate under the replacement generation', async () => {
    const f = await setup(); await f.drain(); const original = f.worker.sign;
    const find=f.store.find.bind(f.store);let fence=true;
    f.store.find=async(...args)=>{const result=await find(...args);if(result&&fence){fence=false;await h.db.query("UPDATE recovery_writer_fence SET writes_enabled=false,generation='replacement'");}return result;};
    expect((await processEnvelopeJob(f.db, clock, f.worker)).state).toBe('PENDING');
    expect((await h.db.query('SELECT * FROM integrity_envelope_results')).rows).toHaveLength(0);
    await expect(processEnvelopeJob(f.db, clock, f.worker)).rejects.toThrow('ENVELOPE_WRITER_FENCED');
    await h.db.query('UPDATE recovery_writer_fence SET writes_enabled=true');
    now = new Date(now.getTime() + 3000); f.worker.writerGeneration = 'replacement'; f.worker.sign = original;
    expect((await processEnvelopeJob(f.db, clock, f.worker)).state).toBe('SIGNED_PENDING_DURABILITY'); expect(f.signCalls()).toBe(1);
  });
  it('does not sign unprotected originals or promote a false receipt', async () => {
    const f = await setup(); await f.drain(); f.store.invalidProtection = true;
    expect((await processEnvelopeJob(f.db, clock, f.worker)).state).toBe('DEAD_LETTER'); expect(f.signCalls()).toBe(0);
    expect((await h.db.query('SELECT * FROM integrity_envelope_results')).rows).toHaveLength(0);
  });
  it('renews leases between bounded object checks while all storage work stays outside transactions', async () => {
    const f=await setup();await f.drain();const verify=f.store.verify.bind(f.store),start=now.getTime();
    f.store.verify=async(...args)=>{now=new Date(now.getTime()+45000);return verify(...args);};
    expect((await processEnvelopeJob(f.db,clock,f.worker)).state).toBe('SIGNED_PENDING_DURABILITY');
    expect(now.getTime()-start).toBeGreaterThan(120000);expect(f.signCalls()).toBe(1);
  });
  it('rejects modified media before signing', async () => {
    const f = await setup(); await f.drain(); f.store.objects.values().next().value!.body = Buffer.from('modified');
    expect((await processEnvelopeJob(f.db, clock, f.worker)).state).toBe('DEAD_LETTER'); expect(f.signCalls()).toBe(0);
  });
  it('rejects replay changes and immutable request mutation', async () => {
    const f = await setup();
    expect(await enqueueEnvelopeFromRecovery(f.db, clock, f.input)).toEqual({ operationId: f.job.operationId, replayed: true });
    await expect(enqueueEnvelopeFromRecovery(f.db, clock, { ...f.input, issuer: 'https://substitute.example.test' })).rejects.toThrow('ENVELOPE_OPERATION_CONFLICT');
    await expect(h.db.query("UPDATE integrity_envelope_jobs SET request_json='{}'")).rejects.toThrow('AUDIT_IMMUTABLE');
  });
  it('does not trust a substituted signing key', async () => {
    const f = await setup(); await f.drain(); const wrong = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    f.worker.sign = async (kid, bytes) => new FlattenedSign(bytes).setProtectedHeader({ alg: 'ES256', kid, typ: ENVELOPE_TYPE }).sign(wrong.privateKey);
    expect((await processEnvelopeJob(f.db, clock, f.worker)).state).toBe('PENDING');
    expect((await h.db.query('SELECT * FROM integrity_envelope_results')).rows).toHaveLength(0);
    expect(await f.store.find('envelope-fixture', envelopeBundleKey(f.job.operationId))).toBeNull();
  });
  it('refuses a source whose exact protected journal version is unavailable', async () => {
    const f = await setup(); await f.drain(); f.worker.sourceJournal = { ...f.publisher, store: { ...f.publisher.store, putIfAbsent: f.journal.putIfAbsent.bind(f.journal), get: async () => null } };
    expect((await processEnvelopeJob(f.db, clock, f.worker)).state).toBe('PENDING'); expect(f.signCalls()).toBe(0);
  });
  it.skipIf(!postgresUrl)('accepts one conditional-write winner across overlapping leases on independent PostgreSQL pools', async () => {
    const f=await setup();await f.drain();const sign=f.worker.sign;
    let release!:()=>void,entered!:()=>void;const held=new Promise<void>(resolve=>{release=resolve;}),started=new Promise<void>(resolve=>{entered=resolve;});
    let first=true;
    f.worker.sign=async(...args)=>{if(first){first=false;entered();await held;}return sign(...args);};
    const old=processEnvelopeJob(f.db,clock,f.worker);await started;
    try{
      expect(await processEnvelopeJob(secondDb!,clock,f.worker)).toEqual({processed:0});
      now=new Date(now.getTime()+121000);
      expect((await processEnvelopeJob(secondDb!,clock,f.worker)).state).toBe('SIGNED_PENDING_DURABILITY');
    }finally{release();}
    expect((await old).state).toBe('LEASE_LOST');
    const result=(await h.db.query<{bundle_json:string}>('SELECT bundle_json FROM integrity_envelope_results')).rows;
    expect(result).toHaveLength(1);expect(result[0].bundle_json).toBe((await f.store.find('envelope-fixture',envelopeBundleKey(f.job.operationId)))!.body.toString());
    expect(f.signCalls()).toBe(2); // Two mathematical signatures; exactly one accepted immutable result.
  });
});
