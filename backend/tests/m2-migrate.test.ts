import {beforeAll,afterAll,describe,it,expect} from 'vitest';
import {randomBytes,createHash} from 'node:crypto';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {migrationInventory,migrate} from '../src/db/migrate.js';
import {splitSqlStatements} from '../src/db/sql.js';
import {insertUser} from '../src/domain/users.js';
import {createTransaction} from '../src/domain/transactions.js';
import {createOrGetProof} from '../src/domain/create-proof.js';
import {openIsolatedTestDatabase} from './isolated-test-database.js';
import {MIGRATIONS,NEW_TABLES,BASELINE_DIGEST,digest,inspectInventory,inspectState,inspectionReceipt,validateInspection,applyInTransaction} from '../scripts/m2-migrate.mjs';
import {run} from '../scripts/m2-migrate-cli.mjs';

const binding={source:'a'.repeat(40),compatibleImage:'sha256:'+'b'.repeat(64),compatibilityEvidenceSha256:'c'.repeat(64)};
const now=new Date('2026-10-22T12:00:00Z'),clock={now:()=>new Date(now)};
let inventory:Awaited<ReturnType<typeof migrationInventory>>;
const baseline=()=>inventory.filter(r=>!MIGRATIONS.some(m=>m.id===r.id));
// The retired operator is pinned to the October 22 093-095 program. Rebuild
// its historical 94-file candidate fixture, not the current API/client schema.
beforeAll(async()=>{
 inventory=(await migrationInventory()).filter(row=>row.id<='095_recipient_export_preservation');
});

describe('exact inactive M2 migration inventory',()=>{
 it('accepts only 91 baseline or 94 complete receipts, with exact reviewed bytes',()=>{
  expect(digest(baseline().map(({id,checksum})=>({id,checksum})))).toBe(BASELINE_DIGEST);
  expect(inspectInventory(inventory,baseline())).toMatchObject({pending:true,appliedCount:91});
  expect(inspectInventory(inventory,inventory)).toMatchObject({pending:false,appliedCount:94});
  expect(()=>inspectInventory(inventory,[...baseline(),MIGRATIONS[0]])).toThrow('M2_APPLIED_INVENTORY_MISMATCH');
  expect(()=>inspectInventory(inventory.map((r,i)=>i?r:{...r,sql:r.sql+'\n'}),baseline())).toThrow('M2_MIGRATION_BYTES_MISMATCH');
  expect(()=>inspectInventory(inventory,baseline().map((r,i)=>i?r:{...r,checksum:'d'.repeat(64)}))).toThrow('M2_APPLIED_CHECKSUM_MISMATCH');
  expect(()=>inspectInventory([...inventory,{id:'future'}],inventory)).toThrow('M2_CANDIDATE_INVENTORY_MISMATCH');
 });
 it('keeps current later migrations outside the fixture and rejects them in the retired operator',async()=>{
  const current=await migrationInventory();
  expect(inventory).toHaveLength(94);
  expect(baseline()).toHaveLength(91);
  const later=current.filter(row=>row.id>'095_recipient_export_preservation');
  expect(later.length).toBeGreaterThan(0);
  expect(()=>inspectInventory(current,inventory)).toThrow('M2_CANDIDATE_INVENTORY_MISMATCH');
  expect(()=>inspectInventory(inventory,[...inventory,...later].map(({id,checksum})=>({id,checksum})))).toThrow('M2_APPLIED_INVENTORY_MISMATCH');
 });
 it('binds a fresh inspection to exact state, source, bridge image and reviewed bridge evidence',()=>{
  const state=inspectInventory(inventory,baseline()),receipt=inspectionReceipt(state,binding,now);
  expect(()=>validateInspection(receipt,state,binding,now)).not.toThrow();
  expect(()=>validateInspection(receipt,{...state,appliedCount:94},binding,now)).toThrow('M2_INSPECTION_STATE_CHANGED');
  expect(()=>validateInspection({...receipt,compatibleImage:'sha256:'+'d'.repeat(64)},state,binding,now)).toThrow('M2_INSPECTION_BINDING_MISMATCH');
  expect(()=>validateInspection(receipt,state,{...binding,compatibilityEvidenceSha256:'d'.repeat(64)},now)).toThrow('M2_INSPECTION_BINDING_MISMATCH');
  expect(()=>validateInspection(receipt,state,binding,new Date(now.getTime()+900001))).toThrow('M2_INSPECTION_EXPIRED');
  expect(()=>inspectionReceipt(state,{...binding,compatibilityEvidenceSha256:undefined},now)).toThrow('M2_COMPATIBILITY_EVIDENCE_REQUIRED');
 });
 it('refuses implicit owner use, feature activation and missing apply inspection before connecting',async()=>{
  await expect(run('--apply',{})).rejects.toThrow('EXPLICIT_OWNER_OPERATOR_REQUIRED');
  const env={PACKPROOF_OPERATOR_PURPOSE:'m2-inactive-production-migration',PACKPROOF_ENVIRONMENT:'production',PACKPROOF_MIGRATE_ON_START:'false',PACKPROOF_DB_USER:'packproof',PACKPROOF_DB_PASSWORD:'synthetic',PACKPROOF_RELEASE_SHA:binding.source,PACKPROOF_COMPATIBILITY_IMAGE_DIGEST:binding.compatibleImage,PACKPROOF_COMPATIBILITY_EVIDENCE_SHA256:binding.compatibilityEvidenceSha256};
  await expect(run('--apply',env)).rejects.toThrow('M2_INACTIVE_FEATURES_REQUIRED');
  await expect(run('--apply',{...env,PACKPROOF_ORGANIZATIONS_ENABLED:'false',PACKPROOF_CLAIM_EXPORTS_ENABLED:'false'})).rejects.toThrow('INSPECTION_REQUIRED');
 });
});

describe('inactive M2 migration transaction and preservation',()=>{
 let opened:Awaited<ReturnType<typeof openIsolatedTestDatabase>>,directory:string,proofId:string,actor:string;
 const suffix=randomBytes(8).toString('hex'),runtime=`m2_migration_runtime_${suffix}`,broad=`m2_migration_group_${suffix}`,runtimeRoles=[runtime];
 const options={...binding,runtimeRoles,splitSqlStatements,now};
 const hash=(s:string)=>createHash('sha256').update(s).digest('hex');
 beforeAll(async()=>{
  opened=await openIsolatedTestDatabase();directory=await mkdtemp(path.join(os.tmpdir(),'m2-migration-'));
  for(const row of baseline())await writeFile(path.join(directory,row.id+'.sql'),row.sql);
  await migrate(opened.db,directory);
  const db=opened.db,schema=(await db.query<{name:string}>('SELECT current_schema() AS name')).rows[0].name;
  for(const role of [runtime,broad])await db.query(`CREATE ROLE ${role} NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS`);
  await db.query(`GRANT USAGE ON SCHEMA ${schema} TO ${runtime}`);
  await db.query(`GRANT SELECT ON ALL TABLES IN SCHEMA ${schema} TO ${runtime}`);
  await db.query(`GRANT INSERT ON rnd_sources TO ${runtime}`);
  await db.query(`GRANT UPDATE(last_used_at) ON platform_credentials TO ${runtime}`);
  await db.query(`GRANT ${broad} TO ${runtime}`);
  await db.query(`ALTER DEFAULT PRIVILEGES IN SCHEMA ${schema} GRANT ALL ON TABLES TO ${broad}`);
  actor=await insertUser(db,clock);
  proofId=(await createOrGetProof(db,clock,actor,(await createTransaction(db,clock,actor,{itemTitle:'Synthetic migration preservation fixture'})).transactionId)).proofId;
  // Owner-seeded historical bytes exercise preservation; no device/signature validity claim.
  await db.query('INSERT INTO final_manifests(id,proof_id,canonical_json,sha256,created_at) VALUES($1,$2,$3,$4,$5)',['migration-manifest',proofId,'{"synthetic":true}',hash('{"synthetic":true}'),now.toISOString()]);
  await db.query('INSERT INTO signature_snapshots(id,proof_id,actor_user_id,payload_json,sha256,created_at) VALUES($1,$2,$3,$4,$5,$6)',['migration-snapshot',proofId,actor,'{}',hash('{}'),now.toISOString()]);
  await db.query('INSERT INTO signature_cases(id,proof_id,snapshot_id,actor_user_id,payload_json,sha256,created_at) VALUES($1,$2,$3,$4,$5,$6,$7)',['migration-case',proofId,'migration-snapshot',actor,'{}',hash('{}'),now.toISOString()]);
  await db.query("INSERT INTO recipient_export_jobs(id,proof_id,case_id,actor_user_id,idempotency_key,request_json,request_sha256,profile_id,state,created_at,artifact_json,artifact_sha256) VALUES($1,$2,$3,$4,'historical','{}',$5,'historical','READY',$6,'{}',$5)",['migration-export',proofId,'migration-case',actor,hash('{}'),now.toISOString()]);
  await db.query('INSERT INTO recipient_export_approvals(job_id,actor_user_id,artifact_sha256,approved_at,legibility_confirmed) VALUES($1,$2,$3,$4,true)',['migration-export',actor,hash('{}'),now.toISOString()]);
 },60000);
 afterAll(async()=>{
  if(opened){for(const role of [runtime,broad]){await opened.db.query(`DROP OWNED BY ${role}`);await opened.db.query(`DROP ROLE ${role}`);}await opened.close();}
  if(directory){if(path.dirname(path.resolve(directory))!==path.resolve(os.tmpdir()))throw Error('Unexpected temporary directory');await rm(directory,{recursive:true,force:true});}
 });
 it('rejects in-flight jobs and drift without applying any DDL',async()=>{
  const db=opened.db,before=await inspectState(db,inventory,runtimeRoles),receipt=inspectionReceipt(before,binding,now);
  await expect(db.transaction(async tx=>{
   await tx.query("INSERT INTO recipient_export_jobs(id,proof_id,case_id,actor_user_id,idempotency_key,request_json,request_sha256,profile_id,state,created_at) VALUES('inflight',$1,'migration-case',$2,'inflight','{}',$3,'historical','QUEUED',$4)",[proofId,actor,hash('{}'),now.toISOString()]);
   await applyInTransaction(tx,inventory,receipt,options);
  })).rejects.toThrow('M2_RECIPIENT_WORK_IN_FLIGHT');
  await expect(db.transaction(async tx=>{
   await tx.query(`GRANT UPDATE ON rnd_sources TO ${runtime}`);
   await applyInTransaction(tx,inventory,receipt,options);
  })).rejects.toThrow('M2_INSPECTION_STATE_CHANGED');
  expect(await inspectState(db,inventory,runtimeRoles)).toEqual(before);
 });
 it('rolls back DDL, receipts, constraints and changed trigger bodies together',async()=>{
  const db=opened.db,before=await inspectState(db,inventory,runtimeRoles),receipt=inspectionReceipt(before,binding,now);
  const body=(await db.query("SELECT prosrc FROM pg_proc WHERE pronamespace=current_schema()::regnamespace AND proname='protect_recipient_export_job'")).rows;
  let injected=false;
  await expect(db.transaction(tx=>applyInTransaction({...tx,query:async(sql:string,args?:unknown[])=>{
   const result=await tx.query(sql,args);
   if(sql.includes('CREATE OR REPLACE FUNCTION protect_recipient_export_job')){injected=true;throw Error('SYNTHETIC_M2_FAILURE');}
   return result;
  }},inventory,receipt,options))).rejects.toThrow('SYNTHETIC_M2_FAILURE');
  expect(injected).toBe(true);expect(await inspectState(db,inventory,runtimeRoles)).toEqual(before);
  expect((await db.query("SELECT prosrc FROM pg_proc WHERE pronamespace=current_schema()::regnamespace AND proname='protect_recipient_export_job'")).rows).toEqual(body);
 });
 it('preserves frozen records and existing authority while stripping new-table default grants',async()=>{
  const db=opened.db,before=await inspectState(db,inventory,runtimeRoles),receipt=inspectionReceipt(before,binding,now);
  const after=await db.transaction(tx=>applyInTransaction(tx,inventory,receipt,options));
  expect(after).toMatchObject({pending:false,appliedCount:94,alreadyApplied:false});
  expect(after.frozen).toEqual(before.frozen);expect(after.frozen.final_manifests.count).toBe(1);expect(after.frozen.recipient_export_approvals.count).toBe(1);
  expect(after.runtimeAuthorityDigest).toBe(before.runtimeAuthorityDigest);
  const asRuntime=(sql:string)=>db.transaction(async tx=>{await tx.query(`SET LOCAL ROLE ${runtime}`);return tx.query(sql);});
  for(const table of NEW_TABLES)await expect(asRuntime(`SELECT * FROM ${table}`)).rejects.toMatchObject({code:'42501'});
  expect((await asRuntime("SELECT has_table_privilege(current_user,'rnd_sources','INSERT') AS allowed,has_column_privilege(current_user,'platform_credentials','last_used_at','UPDATE') AS telemetry")).rows[0]).toEqual({allowed:true,telemetry:true});
  await expect(db.query("UPDATE recipient_export_jobs SET attempts=attempts+1 WHERE id='migration-export'")).rejects.toThrow('RECIPIENT_EXPORT_IMMUTABLE');
  const next=inspectionReceipt(await inspectState(db,inventory,runtimeRoles),binding,now);
  expect((await db.transaction(tx=>applyInTransaction(tx,inventory,next,options))).alreadyApplied).toBe(true);
  console.info(JSON.stringify({event:'m2_inactive_migration_test',engine:process.env.PACKPROOF_TEST_DATABASE_URL?'postgresql':'pglite',appliedCount:after.appliedCount,frozen:after.frozen,runtimeAuthorityUnchanged:true,newRuntimeGrants:false,featureActivation:false}));
 });
 it('refuses later activation or damaged protection instead of silently reapplying',async()=>{
  const db=opened.db;
  await expect(db.transaction(async tx=>{await tx.query(`GRANT SELECT ON claim_cases TO ${broad}`);await inspectState(tx,inventory,runtimeRoles);})).rejects.toThrow('M2_RUNTIME_GRANTS_PRESENT');
  await expect(db.transaction(async tx=>{await tx.query('ALTER TABLE claim_cases DISABLE TRIGGER claim_cases_immutable');await inspectState(tx,inventory,runtimeRoles);})).rejects.toThrow('M2_IMMUTABILITY_GUARDS_MISMATCH');
  await expect(db.transaction(async tx=>{await tx.query('ALTER TABLE recipient_export_jobs RENAME CONSTRAINT recipient_export_job_proof TO altered_job_proof');await inspectState(tx,inventory,runtimeRoles);})).rejects.toThrow('M2_ASSOCIATION_GUARDS_MISMATCH');
  await expect(inspectState(db,inventory,[(await db.query<{name:string}>('SELECT current_user AS name')).rows[0].name])).rejects.toThrow('M2_RUNTIME_AUTHORITY_UNSAFE');
 });
});
