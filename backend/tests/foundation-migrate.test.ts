import {beforeAll,describe,it,expect} from 'vitest';
import {randomBytes} from 'node:crypto';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {migrationInventory,migrate} from '../src/db/migrate.js';
import {splitSqlStatements} from '../src/db/sql.js';
import {createPgDatabase} from '../src/db/postgres.js';
import {MIGRATIONS,BASELINE_DIGEST,TABLES,digest,inspectInventory,inspectState,inspectionReceipt,validateInspection,applyInTransaction} from '../scripts/foundation-migrate.mjs';
import {run} from '../scripts/foundation-migrate-cli.mjs';

let inventory:Awaited<ReturnType<typeof migrationInventory>>;
beforeAll(async()=>{inventory=(await migrationInventory()).filter(row=>row.id<='092_organization_policy_recovery');});
const source='a'.repeat(40),bridge='sha256:'+'b'.repeat(64),now=new Date('2026-10-22T00:00:00Z');
const baseline=()=>inventory.filter(r=>!MIGRATIONS.some(m=>m.id===r.id));
describe('exact foundation migration boundary',()=>{
 it('refuses owner mode or missing inspection before opening a database connection',async()=>{
  await expect(run('--apply',{})).rejects.toThrow('EXPLICIT_OWNER_OPERATOR_REQUIRED');
  await expect(run('--apply',{PACKPROOF_OPERATOR_PURPOSE:'foundation-production-migration',PACKPROOF_ENVIRONMENT:'production',PACKPROOF_MIGRATE_ON_START:'false',PACKPROOF_DB_USER:'packproof',PACKPROOF_DB_PASSWORD:'synthetic',PACKPROOF_RELEASE_SHA:source,PACKPROOF_COMPATIBILITY_IMAGE_DIGEST:bridge})).rejects.toThrow('INSPECTION_REQUIRED');
 });
 it('accepts the observed 86 unchanged receipts and exactly five pinned additions',()=>{
  expect(digest(baseline().map(({id,checksum})=>({id,checksum})))).toBe(BASELINE_DIGEST);
  expect(inspectInventory(inventory,baseline())).toMatchObject({pending:true,appliedCount:86});
  expect(inspectInventory(inventory,inventory)).toMatchObject({pending:false,appliedCount:91});
 });
 it('refuses changed SQL, partial application, checksum drift and unreviewed future receipts',()=>{
  expect(()=>inspectInventory(inventory.map((r,i)=>i?r:{...r,sql:r.sql+'\n'}),baseline())).toThrow('MIGRATION_BYTES_MISMATCH');
  expect(()=>inspectInventory(inventory,[...baseline(),MIGRATIONS[0]])).toThrow('APPLIED_INVENTORY_MISMATCH');
  expect(()=>inspectInventory(inventory,baseline().map((r,i)=>i?r:{...r,checksum:'f'.repeat(64)}))).toThrow('APPLIED_CHECKSUM_MISMATCH');
  expect(()=>inspectInventory(inventory,[...inventory,{id:'future',checksum:'f'.repeat(64)}])).toThrow('APPLIED_INVENTORY_MISMATCH');
 });
 it('does not expand the already executed production operator to newer source migrations',async()=>{
  const newer=await migrationInventory();
  expect(newer.some(row=>row.id==='093_integrity_envelope_jobs')).toBe(true);
  expect(()=>inspectInventory(newer,inventory)).toThrow('CANDIDATE_INVENTORY_MISMATCH');
 });
 it('requires a fresh intact inspection of the same state, source and compatible image',()=>{
  const state=inspectInventory(inventory,baseline()),receipt=inspectionReceipt(state,source,bridge,now);
  expect(()=>validateInspection(receipt,state,source,bridge,now)).not.toThrow();
  expect(()=>validateInspection({...receipt,source:'c'.repeat(40)},state,source,bridge,now)).toThrow('INSPECTION_BINDING_MISMATCH');
  expect(()=>validateInspection(receipt,{...state,appliedCount:91},source,bridge,now)).toThrow('INSPECTION_STATE_CHANGED');
  expect(()=>validateInspection(receipt,state,source,bridge,new Date(now.getTime()+900001))).toThrow('INSPECTION_EXPIRED');
 });
});

const connection=process.env.PACKPROOF_TEST_DATABASE_URL;
describe.skipIf(!connection)('foundation owner transaction on real PostgreSQL',()=>{
 it('rolls back partial DDL, preserves old runtime grants, and admits only intended new writes',async()=>{
  const admin=createPgDatabase(connection!),suffix=randomBytes(8).toString('hex');
  const schema='foundation_gate_'+suffix,runtime='foundation_runtime_'+suffix;
  const temporary=await mkdtemp(path.join(os.tmpdir(),'packproof-foundation-migrations-'));
  let opened:ReturnType<typeof createPgDatabase>|undefined;
  try {
   await admin.db.query(`CREATE SCHEMA ${schema}`);
   await admin.db.query(`CREATE ROLE ${runtime} NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS`);
   const url=new URL(connection!);url.searchParams.set('options',`-c search_path=${schema}`);opened=createPgDatabase(url.toString());
   for(const row of baseline())await writeFile(path.join(temporary,row.id+'.sql'),row.sql);
   await migrate(opened.db,temporary);
   await admin.db.query(`GRANT USAGE ON SCHEMA ${schema} TO ${runtime}`);
   await opened.db.query(`GRANT SELECT ON ALL TABLES IN SCHEMA ${schema} TO ${runtime}`);
   // Existing selective R&D grants must survive; do not reapply broad runtime-roles.sql.
   await opened.db.query(`GRANT INSERT ON rnd_sources TO ${runtime}`);
   const before=await inspectState(opened.db,inventory,runtime),receipt=inspectionReceipt(before,source,bridge,now);
   let injected=false;
   await expect(opened.db.transaction(tx=>applyInTransaction({...tx,query:async(sql:string,args?:unknown[])=>{
    if(sql.includes('CREATE TABLE platform_organizations')){injected=true;throw Error('injected migration failure');}
    return tx.query(sql,args);
   }},inventory,receipt,{source,compatibleImage:bridge,runtime,splitSqlStatements,now}))).rejects.toThrow('injected migration failure');
   expect(injected).toBe(true);
   expect(await inspectState(opened.db,inventory,runtime)).toEqual(before);
   const after=await opened.db.transaction(tx=>applyInTransaction(tx,inventory,receipt,{source,compatibleImage:bridge,runtime,splitSqlStatements,now}));
   expect(after.appliedCount).toBe(91);expect(after.runtimeAuthorityDigest).toBe(before.runtimeAuthorityDigest);
   expect(after.frozen).toEqual(before.frozen);
   const effective=async(sql:string)=>opened!.db.transaction(async tx=>{await tx.query(`SET LOCAL ROLE ${runtime}`);return tx.query(sql);});
   expect((await effective("SELECT has_column_privilege(current_user,'platform_credentials','revoked_at','UPDATE') AS allowed")).rows[0]).toEqual({allowed:true});
   await expect(effective('DELETE FROM platform_credentials')).rejects.toMatchObject({code:'42501'});
   await expect(effective("UPDATE platform_credentials SET token_hash='forbidden'")).rejects.toMatchObject({code:'42501'});
   await expect(effective('UPDATE schema_migrations SET checksum=checksum')).rejects.toMatchObject({code:'42501'});
   expect(Object.keys(TABLES)).toHaveLength(14);
   const next=inspectionReceipt(await inspectState(opened.db,inventory,runtime),source,bridge,now);
   expect((await opened.db.transaction(tx=>applyInTransaction(tx,inventory,next,{source,compatibleImage:bridge,runtime,splitSqlStatements,now}))).alreadyApplied).toBe(true);
  }finally{
   await opened?.close();
   await admin.db.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
   await admin.db.query(`DROP ROLE IF EXISTS ${runtime}`);await admin.close();
   // mkdtemp returned this test's own directory under the configured temp root.
   if(path.dirname(path.resolve(temporary))!==path.resolve(os.tmpdir()))throw Error('Unexpected temporary directory');
   await rm(temporary,{recursive:true,force:true});
  }
 },60000);
});
