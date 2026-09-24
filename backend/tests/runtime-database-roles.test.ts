import { afterAll,afterEach,beforeAll,beforeEach,describe,expect,it } from 'vitest';
import { readFile } from 'node:fs/promises';
import { generateKeyPairSync,sign } from 'node:crypto';
import request from 'supertest';
import { createHarness,createUser,auth,commitFulfillmentAndAttest,type TestHarness } from './helpers.js';
import { splitSqlStatements } from '../src/db/sql.js';
import { createTransaction } from '../src/domain/transactions.js';
import { createOrGetProof } from '../src/domain/create-proof.js';
import { createCaptureSession } from '../src/domain/capture-sessions.js';
import { finalizeProof } from '../src/domain/finalize.js';
import { processPolicyRecoveryOutbox } from '../src/domain/policy-recovery.js';
import { processRecoveryOutbox,type RecoveryPublisher } from '../src/domain/recovery-journal.js';
import { assertSchemaCurrent } from '../src/db/migrate.js';

const clock={now:()=>new Date('2026-09-24T12:00:00.000Z')};
let h:TestHarness,admin:string;
const combined='packproof_test_combined';
const keys=generateKeyPairSync('ec',{namedCurve:'prime256v1'}),publicKey=keys.publicKey.export({format:'pem',type:'spki'}).toString();
const objects=new Map<string,Buffer>();
const publisher:RecoveryPublisher={
  protectedStoreVerified:true,writerGeneration:'initial',trustedPublicKey:async id=>id==='test-role-key'?publicKey:null,
  signer:{signManifest:async input=>({algorithm:'ECDSA_SHA_256',keyId:'test-role-key',signedAt:clock.now().toISOString(),signatureBase64:sign('sha256',Buffer.from(input.canonicalJson),keys.privateKey).toString('base64')})},
  store:{
    get:async key=>objects.has(key)?{body:objects.get(key)!,contentType:'application/json'}:null,
    head:async key=>objects.has(key)?{versionId:'test-immutable-version'}:null,
    putIfAbsent:async(key,body)=>{if(objects.has(key))return{created:false};objects.set(key,body);return{created:true};},
  },
};
async function drainPolicies(){for(let i=0;i<100;i++){const result=await processPolicyRecoveryOutbox(h.db,clock,publisher);if(!result.processed)return;expect(result.state).toBe('DURABLE');}throw new Error('Policy publication did not finish');}
async function drainRecovery(){for(let i=0;i<20;i++){const result=await processRecoveryOutbox(h.db,clock,publisher);if(!result.processed)return;expect(result.state).toBe('DURABLE');}throw new Error('Recovery publication did not finish');}

beforeAll(async()=>{
  h=await createHarness(clock);admin=await createUser(h);
  await h.db.query("INSERT INTO user_system_roles(user_id,role,granted_at) VALUES($1,'SYSTEM_ADMIN',$2)",[admin,clock.now().toISOString()]);
  const script=await readFile(new URL('../../infra/sql/runtime-roles.sql',import.meta.url),'utf8');
  for(const sql of splitSqlStatements(script))await h.db.query(sql);
  // Reapplying the privilege script must neither widen grants nor break workers.
  for(const sql of splitSqlStatements(script))await h.db.query(sql);
  await h.db.query(`CREATE ROLE ${combined} LOGIN INHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS`);
  await h.db.query(`GRANT packproof_runtime,packproof_recovery TO ${combined}`);
},30000);
beforeEach(async()=>{await h.db.query(`SET SESSION AUTHORIZATION ${combined}`);});
afterEach(async()=>{await h.db.query('RESET SESSION AUTHORIZATION');});
afterAll(async()=>{await h?.close();});

describe('combined application login under runtime and recovery database groups',()=>{
  it('checks the real SQL session authority and reads the schema without owner powers',async()=>{
    expect((await h.db.query('SELECT current_user AS actor,session_user AS login')).rows[0]).toEqual({actor:combined,login:combined});
    expect((await h.db.query('SELECT rolsuper,rolcreatedb,rolcreaterole,rolreplication,rolbypassrls FROM pg_roles WHERE rolname=current_user')).rows[0]).toEqual({rolsuper:false,rolcreatedb:false,rolcreaterole:false,rolreplication:false,rolbypassrls:false});
    await assertSchemaCurrent(h.db);
    await expect(h.db.query('CREATE TABLE public.forbidden_runtime_ddl(id integer)')).rejects.toThrow(/permission denied/);
    await expect(h.db.query('ALTER TABLE users DISABLE TRIGGER ALL')).rejects.toThrow(/owner/);
    await expect(h.db.query('CREATE ROLE forbidden_runtime_role')).rejects.toThrow(/permission denied/);
    await expect(h.db.query('SET ROLE postgres')).rejects.toThrow(/permission denied/);
    await expect(h.db.query("UPDATE schema_migrations SET checksum='changed' WHERE false")).rejects.toThrow(/permission denied/);
  });
  it('preserves ordinary account, proof, capture and audited account-management operations',async()=>{
    const user=await createUser(h);
    const transaction=await createTransaction(h.db,clock,user,{itemTitle:'Least-privilege capture'});
    const proof=await createOrGetProof(h.db,clock,user,transaction.transactionId);
    expect((await createCaptureSession(h.db,clock,user,proof.proofId,{client:'WEB_CAMERA',idempotencyKey:'roles-capture'})).state).toBe('ISSUED');
    const result=await request(h.app).post(`/admin/users/${user}/status`).set(auth(admin)).send({operationId:'roles-account-disable',reason:'Verify least privilege account action',confirmation:user,expectedVersion:0,status:'DISABLED'});
    expect(result.status).toBe(200);
    expect((await h.db.query('SELECT status FROM users WHERE id=$1',[user])).rows[0].status).toBe('DISABLED');
    expect((await h.db.query('SELECT id FROM system_admin_audit_events WHERE target_id=$1',[user])).rows).toHaveLength(1);
    expect((await h.db.query('SELECT actor_id FROM admin_command_receipts WHERE actor_id=$1',[admin])).rows).toHaveLength(1);
  });
  it('denies role assignment and modification or removal of append-only records',async()=>{
    const user=await createUser(h);
    await expect(h.db.query("INSERT INTO user_system_roles(user_id,role,granted_at) VALUES($1,'SYSTEM_ADMIN',$2)",[user,clock.now().toISOString()])).rejects.toThrow(/permission denied/);
    for(const table of ['user_system_roles','system_admin_audit_events','admin_command_receipts','billing_allowance_adjustments','final_manifests','audit_events','recovery_events','proof_supplements','policy_recovery_events']){
      await expect(h.db.query(`DELETE FROM ${table} WHERE false`)).rejects.toThrow(/permission denied/);
      await expect(h.db.query(`TRUNCATE ${table}`)).rejects.toThrow(/permission denied/);
    }
    await expect(h.db.query("UPDATE user_system_roles SET role='SYSTEM_ADMIN' WHERE false")).rejects.toThrow(/permission denied/);
    await expect(h.db.query("UPDATE system_admin_audit_events SET reason='changed reason' WHERE false")).rejects.toThrow(/permission denied/);
    await expect(h.db.query("UPDATE admin_command_receipts SET response_json='{}' WHERE false")).rejects.toThrow(/permission denied/);
    await expect(h.db.query('UPDATE billing_allowance_adjustments SET delta=100 WHERE false')).rejects.toThrow(/permission denied/);
  });
  it('permits required publisher row locks but cannot reopen writer or policy fences',async()=>{
    await h.db.transaction(async tx=>{
      await tx.query('SELECT * FROM recovery_writer_fence WHERE singleton=1 FOR UPDATE');
      await tx.query('SELECT mode FROM policy_recovery_fence WHERE singleton=1 FOR UPDATE');
    });
    for(const sql of [
      "UPDATE recovery_writer_fence SET generation='unauthorized' WHERE singleton=1",
      'UPDATE recovery_writer_fence SET writes_enabled=true WHERE singleton=1',
      "UPDATE policy_recovery_fence SET mode='NORMAL' WHERE singleton=1",
      'UPDATE policy_recovery_fence SET durability_required=false WHERE singleton=1',
      'UPDATE policy_recovery_fence SET expected_sequence=NULL WHERE singleton=1',
      'DELETE FROM recovery_writer_fence WHERE false',
      'DELETE FROM policy_recovery_fence WHERE false',
    ])await expect(h.db.query(sql)).rejects.toThrow(/permission denied/);
  });
  it('publishes account policy and core recovery receipts and finalizes evidence under combined privileges',async()=>{
    const seller=await createUser(h);
    const transaction=await createTransaction(h.db,clock,seller,{itemTitle:'Privilege-verified preservation'});
    const proof=await createOrGetProof(h.db,clock,seller,transaction.transactionId);
    await commitFulfillmentAndAttest(h,seller,proof.proofId);
    await drainPolicies();await drainRecovery();
    await finalizeProof(h.db,clock,seller,proof.proofId,publisher.signer,{requireDurableReceipts:true});
    await drainPolicies();await drainRecovery();
    const final=await finalizeProof(h.db,clock,seller,proof.proofId,publisher.signer,{requireDurableReceipts:true});
    expect(final.proof.status).toBe('FINALIZED');
    expect((await h.db.query('SELECT state FROM recovery_delivery WHERE operation_id=$1',[`finalize:${proof.proofId}`])).rows[0].state).toBe('DURABLE');
    const fence=(await h.db.query<{reconciled_sequence:string;reconciled_head_sha256:string}>('SELECT reconciled_sequence,reconciled_head_sha256 FROM policy_recovery_fence')).rows[0];
    expect(Number(fence.reconciled_sequence)).toBeGreaterThan(0);expect(fence.reconciled_head_sha256).toMatch(/^[a-f0-9]{64}$/);
    await expect(h.db.query("UPDATE evidence SET sha256='changed' WHERE proof_id=$1",[proof.proofId])).rejects.toThrow('EVIDENCE_ALREADY_COMMITTED');
  },30000);
});
