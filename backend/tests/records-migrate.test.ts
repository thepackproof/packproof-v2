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
import {MIGRATIONS,inspectInventory,inspectState,inspectionReceipt,validateInspection,applyInTransaction} from '../scripts/records-migrate.mjs';

const binding={source:'a'.repeat(40),compatibleImage:'sha256:'+'b'.repeat(64),compatibilityEvidenceSha256:'c'.repeat(64),rehearsalSha256:'d'.repeat(64)};
const now=new Date('2026-11-05T12:00:00Z'),clock={now:()=>new Date(now)};
let inventory:Awaited<ReturnType<typeof migrationInventory>>;
beforeAll(async()=>{inventory=await migrationInventory();});

describe('records release source and inspection boundaries',()=>{
 it('admits exactly 94 historical or 106 complete receipts, never a partial or changed upgrade',()=>{
  const before=inventory.filter(row=>Number(row.id.slice(0,3))<=95);
  expect(MIGRATIONS).toHaveLength(12);
  expect(inspectInventory(inventory,before)).toMatchObject({pending:true,appliedCount:94});
  expect(inspectInventory(inventory,inventory)).toMatchObject({pending:false,appliedCount:106});
  expect(()=>inspectInventory(inventory,[...before,MIGRATIONS[0]])).toThrow('RECORDS_APPLIED_INVENTORY_MISMATCH');
  expect(()=>inspectInventory(inventory,before.map((row,i)=>i?row:{...row,checksum:'e'.repeat(64)}))).toThrow('RECORDS_APPLIED_CHECKSUM_MISMATCH');
  expect(()=>inspectInventory(inventory.map((row,i)=>i?row:{...row,sql:row.sql+'\n'}),before)).toThrow('RECORDS_MIGRATION_BYTES_MISMATCH');
  expect(()=>inspectInventory([...inventory,{id:'108_future',checksum:'e'.repeat(64),sql:''}],before)).toThrow('RECORDS_CANDIDATE_INVENTORY_MISMATCH');
 });
 it('requires fresh source, bridge and rehearsal bindings and unchanged inspected state',()=>{
  const state=inspectInventory(inventory,inventory),receipt=inspectionReceipt(state,binding,now);
  expect(()=>validateInspection(receipt,state,binding,now)).not.toThrow();
  expect(()=>validateInspection(receipt,state,binding,new Date(now.getTime()+900001))).toThrow('RECORDS_INSPECTION_EXPIRED');
  expect(()=>validateInspection(receipt,{...state,pending:true},binding,now)).toThrow('RECORDS_INSPECTION_STATE_CHANGED');
  expect(()=>validateInspection(receipt,state,{...binding,rehearsalSha256:'f'.repeat(64)},now)).toThrow('RECORDS_INSPECTION_BINDING_MISMATCH');
  expect(()=>inspectionReceipt(state,{...binding,rehearsalSha256:undefined},now)).toThrow('RECORDS_QUALIFIED_RELEASE_BINDING_REQUIRED');
 });
});

describe('records migration transaction and historical preservation',()=>{
 let opened:Awaited<ReturnType<typeof openIsolatedTestDatabase>>,directory:string,proofId:string;
 const suffix=randomBytes(8).toString('hex'),runtimeRole=`records_bridge_${suffix}`,broad=`records_default_${suffix}`;
 const options={...binding,runtimeRole,splitSqlStatements,now};
 beforeAll(async()=>{
  opened=await openIsolatedTestDatabase();directory=await mkdtemp(path.join(os.tmpdir(),'records-release-'));
  for(const row of inventory.filter(row=>Number(row.id.slice(0,3))<=95))await writeFile(path.join(directory,row.id+'.sql'),row.sql);
  await migrate(opened.db,directory);
  const db=opened.db,schema=(await db.query<{name:string}>('SELECT current_schema() AS name')).rows[0].name;
  for(const role of [runtimeRole,broad])await db.query(`CREATE ROLE ${role} NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS`);
  await db.query(`GRANT USAGE ON SCHEMA ${schema} TO ${runtimeRole}`);
  await db.query(`GRANT SELECT ON ALL TABLES IN SCHEMA ${schema} TO ${runtimeRole}`);
  await db.query(`GRANT ${broad} TO ${runtimeRole}`);
  await db.query(`ALTER DEFAULT PRIVILEGES IN SCHEMA ${schema} GRANT ALL ON TABLES TO ${broad}`);
  const actor=await insertUser(db,clock);
  proofId=(await createOrGetProof(db,clock,actor,(await createTransaction(db,clock,actor,{itemTitle:'Preserve records upgrade bytes'})).transactionId)).proofId;
  const canonical='{"synthetic":"records-migration"}',hash=createHash('sha256').update(canonical).digest('hex');
  await db.query('INSERT INTO final_manifests(id,proof_id,canonical_json,sha256,created_at) VALUES($1,$2,$3,$4,$5)',['records-upgrade-manifest',proofId,canonical,hash,now.toISOString()]);
 },60000);
 afterAll(async()=>{
  if(opened){for(const role of [runtimeRole,broad]){await opened.db.query(`DROP OWNED BY ${role}`);await opened.db.query(`DROP ROLE ${role}`);}await opened.close();}
  if(directory){if(path.dirname(path.resolve(directory))!==path.resolve(os.tmpdir()))throw Error('Unexpected temporary directory');await rm(directory,{recursive:true,force:true});}
 });
 it('rejects stale baseline grants before creating any records table',async()=>{
  const db=opened.db,before=await inspectState(db,inventory,runtimeRole),receipt=inspectionReceipt(before,binding,now);
  await expect(db.transaction(async tx=>{await tx.query(`GRANT UPDATE ON users TO ${runtimeRole}`);await applyInTransaction(tx,inventory,receipt,options);})).rejects.toThrow('RECORDS_INSPECTION_STATE_CHANGED');
  expect(await inspectState(db,inventory,runtimeRole)).toEqual(before);
 },60000);
 it('rolls back all 12 migrations and receipts when the final migration fails',async()=>{
  const db=opened.db,before=await inspectState(db,inventory,runtimeRole),receipt=inspectionReceipt(before,binding,now);
  let injected=false;
  await expect(db.transaction(tx=>applyInTransaction({...tx,query:async(sql:string,args?:unknown[])=>{
   const result=await tx.query(sql,args);if(sql.includes('CREATE TABLE record_issue_assignments')){injected=true;throw Error('SYNTHETIC_RECORDS_FAILURE');}return result;
  }},inventory,receipt,options))).rejects.toThrow('SYNTHETIC_RECORDS_FAILURE');
  expect(injected).toBe(true);expect(await inspectState(db,inventory,runtimeRole)).toEqual(before);
 },60000);
 it('preserves historical data, code, triggers and grants while applying exactly 096-107 atomically',async()=>{
  const db=opened.db,before=await inspectState(db,inventory,runtimeRole),receipt=inspectionReceipt(before,binding,now);
  const after=await db.transaction(tx=>applyInTransaction(tx,inventory,receipt,options));
  expect(after).toMatchObject({pending:false,appliedCount:106,alreadyApplied:false});
  for(const field of ['baselineDataSha256','baselineCatalogSha256','baselineAuthoritySha256'])expect(after[field]).toBe(before[field]);
  for(const table of ['record_state','record_membership_locations'])expect((await db.query("SELECT has_table_privilege($1,$2,'SELECT') AS read,has_table_privilege($1,$2,'INSERT,UPDATE,DELETE') AS write",[runtimeRole,table])).rows[0]).toEqual({read:true,write:false});
  expect((await db.query("SELECT has_table_privilege($1,'record_entities','SELECT,INSERT,UPDATE,DELETE') AS allowed",[runtimeRole])).rows[0].allowed).toBe(false);
  expect((await db.query('SELECT canonical_json FROM final_manifests WHERE proof_id=$1',[proofId])).rows[0].canonical_json).toBe('{"synthetic":"records-migration"}');
  const next=inspectionReceipt(await inspectState(db,inventory,runtimeRole),binding,now);
  expect((await db.transaction(tx=>applyInTransaction(tx,inventory,next,options))).alreadyApplied).toBe(true);
 },60000);
 it('refuses feature activation or disabled immutability guards on a repeat run',async()=>{
  const db=opened.db;
  await expect(db.transaction(async tx=>{await tx.query('ALTER TABLE record_entities DISABLE TRIGGER record_entities_immutable');await inspectState(tx,inventory,runtimeRole);})).rejects.toThrow('RECORDS_IMMUTABILITY_GUARDS_MISMATCH');
  await expect(db.transaction(async tx=>{await tx.query('DROP TRIGGER record_entities_immutable ON record_entities');await inspectState(tx,inventory,runtimeRole);})).rejects.toThrow('RECORDS_IMMUTABILITY_GUARDS_MISMATCH');
  await expect(db.transaction(async tx=>{await tx.query('CREATE OR REPLACE FUNCTION preserve_record_share_scope() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NEW; END; $$');await inspectState(tx,inventory,runtimeRole);})).rejects.toThrow('RECORDS_FUNCTION_GUARDS_MISMATCH');
  await expect(db.transaction(async tx=>{await tx.query(`GRANT INSERT ON record_entities TO ${broad}`);await inspectState(tx,inventory,runtimeRole);})).rejects.toThrow('RECORDS_INACTIVE_PRIVILEGES_MISMATCH');
 });
});
