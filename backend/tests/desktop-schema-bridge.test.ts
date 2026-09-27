import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { assertSchemaCurrent, migrate, migrationInventory } from '../src/db/migrate.js';
import { createPgliteDatabase } from '../src/db/pglite.js';
import { splitSqlStatements } from '../src/db/sql.js';
import { auth, commitFulfillmentAndAttest, createHarness, createUser } from './helpers.js';
import { createCaptureSession, completeCaptureSession } from '../src/domain/capture-sessions.js';
import { finalizeProof } from '../src/domain/finalize.js';
import { sha256Hex } from '../src/hash.js';

// Independent release pins: modifying the runtime allowlist must not change the test contract.
const futureId='074_desktop_capture_registration';
const futureChecksum='3d598d733ab8aaf375fc793446b2ed732b42c2bcb9c47fc732af57c9eade692a';

describe('desktop release schema bridge envelope',()=>{
  let opened:Awaited<ReturnType<typeof createPgliteDatabase>>;
  let baseline:Awaited<ReturnType<typeof migrationInventory>>;
  beforeAll(async()=>{opened=await createPgliteDatabase();baseline=await migrationInventory();await migrate(opened.db);});
  afterAll(async()=>{await opened?.close();});
  beforeEach(async()=>{
    await opened.db.query('DELETE FROM schema_migrations');
    for(const item of baseline) await record(item.id,item.checksum);
  });
  async function record(id:string,checksum:string|null){
    await opened.db.query("INSERT INTO schema_migrations(id,checksum,applied_at,checksum_provenance) VALUES($1,$2,NOW(),'EXECUTED_BYTES')",[id,checksum]);
  }
  it('starts with complete 073 schema without requiring or applying 074',async()=>{
    expect(baseline.at(-1)?.id).toBe('073_client_version_activity');
    await expect(assertSchemaCurrent(opened.db)).resolves.toBeUndefined();
    await migrate(opened.db);
    expect((await opened.db.query("SELECT column_name FROM information_schema.columns WHERE table_name='capture_sessions' AND column_name='desktop_context'")).rows).toEqual([]);
  });
  it('accepts only pinned 074 and does not mutate the migration ledger',async()=>{
    await record(futureId,futureChecksum);
    const before=(await opened.db.query('SELECT * FROM schema_migrations ORDER BY id')).rows;
    await expect(assertSchemaCurrent(opened.db)).resolves.toBeUndefined();
    await migrate(opened.db);
    expect((await opened.db.query('SELECT * FROM schema_migrations ORDER BY id')).rows).toEqual(before);
  });
  it.each(['0'.repeat(64),null])('rejects changed or unverified 074 checksum %s',async(checksum)=>{
    await record(futureId,checksum);
    await expect(assertSchemaCurrent(opened.db)).rejects.toThrow('outside this release compatibility envelope');
  });
  it.each(['074_unreviewed_change','075_other_change'])('rejects unrelated migration %s even with the pinned checksum',async(id)=>{
    await record(id,futureChecksum);
    await expect(assertSchemaCurrent(opened.db)).rejects.toThrow('outside this release compatibility envelope');
  });
  it('rejects missing baseline migration even with correct 074',async()=>{
    await record(futureId,futureChecksum);
    await opened.db.query('DELETE FROM schema_migrations WHERE id=$1',[baseline[0].id]);
    await expect(assertSchemaCurrent(opened.db)).rejects.toThrow(`Migration required or checksum mismatch: ${baseline[0].id}`);
  });
  it('rejects changed baseline bytes even with correct 074',async()=>{
    await record(futureId,futureChecksum);
    await opened.db.query('UPDATE schema_migrations SET checksum=$2 WHERE id=$1',[baseline.at(-1)!.id,'0'.repeat(64)]);
    await expect(assertSchemaCurrent(opened.db)).rejects.toThrow(`Migration required or checksum mismatch: ${baseline.at(-1)!.id}`);
  });
});

it('preserves old capture operations and frozen evidence before and after the exact additive migration',async()=>{
  const h=await createHarness();
  try{
    const seller=await createUser(h);
    async function proof(){
      const t=await request(h.app).post('/transactions').set(auth(seller)).send({itemTitle:'Bridge regression'});
      const p=await request(h.app).post(`/transactions/${t.body.transactionId}/proof`).set(auth(seller)).send({});
      expect(p.status).toBe(200);return p.body.proofId as string;
    }
    const frozenId=await proof();
    await commitFulfillmentAndAttest(h,seller,frozenId);
    const frozenBefore=await finalizeProof(h.db,h.clock,seller,frozenId);
    const activeId=await proof();
    const active=await createCaptureSession(h.db,h.clock,seller,activeId,{client:'NATIVE_CAMERA',idempotencyKey:'before-migration'});
    const before=(await h.db.query('SELECT * FROM capture_sessions WHERE id=$1',[active.id])).rows[0];
    const sql=await readFile(new URL('./fixtures/074_desktop_capture_registration.sql',import.meta.url),'utf8');
    expect(createHash('sha256').update(sql).digest('hex')).toBe(futureChecksum);
    await h.db.transaction(async tx=>{
      for(const statement of splitSqlStatements(sql)) await tx.query(statement);
      await tx.query("INSERT INTO schema_migrations(id,checksum,applied_at,checksum_provenance) VALUES($1,$2,NOW(),'EXECUTED_BYTES')",[futureId,futureChecksum]);
    });
    await expect(assertSchemaCurrent(h.db)).resolves.toBeUndefined();
    await migrate(h.db);
    expect((await h.db.query('SELECT * FROM capture_sessions WHERE id=$1',[active.id])).rows[0]).toEqual({...before,desktop_context:null});
    const media=await readFile(new URL('./fixtures/camera-recording.mp4',import.meta.url));
    await expect(completeCaptureSession(h.db,h.clock,seller,activeId,active.id,{sha256:sha256Hex(media),byteSize:media.length,contentType:'video/mp4'})).resolves.toMatchObject({state:'RECORDED',client:'NATIVE_CAMERA'});
    const web=await createCaptureSession(h.db,h.clock,seller,await proof(),{client:'WEB_CAMERA',idempotencyKey:'after-migration'});
    expect(web.client).toBe('WEB_CAMERA');
    const afterId=await proof();
    await commitFulfillmentAndAttest(h,seller,afterId);
    expect((await finalizeProof(h.db,h.clock,seller,afterId)).manifest.sha256).toMatch(/^[a-f0-9]{64}$/);
    const frozenAfter=await finalizeProof(h.db,h.clock,seller,frozenId);
    expect(frozenAfter.manifest).toEqual(frozenBefore.manifest);
    expect((await request(h.app).get('/capabilities')).body).not.toHaveProperty('desktopCapture');
    await expect(createCaptureSession(h.db,h.clock,seller,await proof(),{client:'DESKTOP_CAMERA',idempotencyKey:'unsupported'})).rejects.toMatchObject({code:'CAPTURE_CLIENT_REQUIRED'});
  }finally{await h.close();}
},30000);
