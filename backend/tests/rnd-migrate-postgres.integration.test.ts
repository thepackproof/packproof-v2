import { afterAll,beforeAll,describe,expect,it } from 'vitest';
import pg from 'pg';
import { randomBytes } from 'node:crypto';
import { mkdtemp,writeFile,rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { createPgDatabase } from '../src/db/postgres.js';
import { migrate,migrationInventory } from '../src/db/migrate.js';
import { splitSqlStatements } from '../src/db/sql.js';
import { MIGRATIONS,RECEIPT_TABLES,inspectState,inspectionReceipt,applyInTransaction,assertMinimalPrivileges } from '../scripts/rnd-migrate.mjs';
import type { Database } from '../src/db/database.js';

const databaseUrl=process.env.PACKPROOF_RELEASE_TEST_DATABASE_URL;
if(process.env.PACKPROOF_REQUIRE_POSTGRES_RELEASE_GATES==='1'&&!databaseUrl)throw Error('POSTGRES_RELEASE_DATABASE_REQUIRED');
// This test creates and drops only its random database/roles on the disposable CI service.
if(databaseUrl&&!['127.0.0.1','localhost','::1','[::1]'].includes(new URL(databaseUrl).hostname))throw Error('DISPOSABLE_LOCAL_POSTGRES_REQUIRED');
describe.skipIf(!databaseUrl)('receipt migration transaction and authority on real PostgreSQL',()=>{
 const suffix=randomBytes(8).toString('hex'),database='rnd_migrate_'+suffix,owner='rnd_owner_'+suffix,runtime='rnd_runtime_'+suffix;
 const source='a'.repeat(40),compatibleImage='sha256:'+'b'.repeat(64);
 let admin:pg.Client,opened:ReturnType<typeof createPgDatabase>,runtimeOpened:ReturnType<typeof createPgDatabase>,directory:string;
 let inventory:Awaited<ReturnType<typeof migrationInventory>>;
 beforeAll(async()=>{
  admin=new pg.Client({connectionString:databaseUrl});await admin.connect();
  expect((await admin.query('SELECT rolsuper FROM pg_roles WHERE rolname=current_user')).rows[0].rolsuper).toBe(true);
  await admin.query(`CREATE ROLE ${owner} NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS`);
  await admin.query(`CREATE ROLE ${runtime} NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS`);
  await admin.query(`CREATE DATABASE ${database} OWNER ${owner}`);
  const url=new URL(databaseUrl!);url.pathname='/'+database;url.searchParams.set('options',`-c role=${owner}`);
  opened=createPgDatabase(url.toString());directory=await mkdtemp(path.join(tmpdir(),'rnd-baseline-'));
  inventory=await migrationInventory();
  for(const row of inventory.filter(row=>!MIGRATIONS.some(pin=>pin.id===row.id)))await writeFile(path.join(directory,row.id+'.sql'),row.sql);
  await migrate(opened.db,directory);
  await opened.db.query('REVOKE CREATE ON SCHEMA public FROM PUBLIC');
  await opened.db.query(`GRANT USAGE ON SCHEMA public TO ${runtime}`);
  await opened.db.query(`GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA public TO ${runtime}`);
  // Existing broad defaults must not leak any privileges onto the advanced tables.
  await opened.db.query(`ALTER DEFAULT PRIVILEGES GRANT ALL ON TABLES TO ${runtime}`);
  url.searchParams.set('options',`-c role=${runtime}`);runtimeOpened=createPgDatabase(url.toString());
 },90_000);
 afterAll(async()=>{
  await Promise.all([opened?.close(),runtimeOpened?.close()]);
  if(admin){await admin.query(`DROP DATABASE IF EXISTS ${database} WITH (FORCE)`);await admin.query(`DROP ROLE IF EXISTS ${runtime}`);await admin.query(`DROP ROLE IF EXISTS ${owner}`);await admin.end();}
  if(directory)await rm(directory,{recursive:true,force:true});
 });
 it('rolls back every DDL/receipt/grant on failure, then applies all nine with only seven append/read grants',async()=>{
  const before=await inspectState(opened.db,inventory,runtime),receipt=inspectionReceipt(before,source,compatibleImage);
  let injected=false;
  await expect(opened.db.transaction(async tx=>{
   const guarded:Database={...tx,query:async(sql,params)=>{if(sql.includes('CREATE TABLE rnd_enrollments')){injected=true;throw Error('SYNTHETIC_MIGRATION_FAILURE');}return tx.query(sql,params);}};
   return applyInTransaction(guarded,inventory,receipt,{source,compatibleImage,runtime,splitSqlStatements});
  })).rejects.toThrow('SYNTHETIC_MIGRATION_FAILURE');
  expect(injected).toBe(true);expect(await inspectState(opened.db,inventory,runtime)).toEqual(before);
  const after=await opened.db.transaction(tx=>applyInTransaction(tx,inventory,receipt,{source,compatibleImage,runtime,splitSqlStatements}));
  expect(after).toMatchObject({pending:false,appliedCount:86,runtimeAuthorityDigest:before.runtimeAuthorityDigest,alreadyApplied:false});assertMinimalPrivileges(after);
  expect(after.rndPrivileges.filter(row=>row.allowed)).toHaveLength(14);
  for(const table of RECEIPT_TABLES)expect(await runtimeOpened.db.query(`SELECT count(*) FROM public.${table}`)).toBeDefined();
  await expect(runtimeOpened.db.query('SELECT * FROM public.rnd_analyses')).rejects.toMatchObject({code:'42501'});
  await expect(runtimeOpened.db.query('UPDATE public.rnd_consents SET granted=false')).rejects.toMatchObject({code:'42501'});
  await expect(runtimeOpened.db.query('DELETE FROM public.rnd_sources')).rejects.toMatchObject({code:'42501'});
  await expect(runtimeOpened.db.query('ALTER TABLE public.rnd_sources ADD COLUMN forbidden integer')).rejects.toMatchObject({code:'42501'});
  const reinspection=inspectionReceipt(await inspectState(opened.db,inventory,runtime),source,compatibleImage);
  expect(await opened.db.transaction(tx=>applyInTransaction(tx,inventory,reinspection,{source,compatibleImage,runtime,splitSqlStatements}))).toMatchObject({alreadyApplied:true,appliedCount:86});
 },60_000);
 it('rejects drift after inspection without resetting existing data or changing authority',async()=>{
  const state=await inspectState(opened.db,inventory,runtime),receipt=inspectionReceipt(state,source,compatibleImage);
  await opened.db.query(`GRANT SELECT ON public.rnd_analyses TO ${runtime}`);
  await expect(opened.db.transaction(tx=>applyInTransaction(tx,inventory,receipt,{source,compatibleImage,runtime,splitSqlStatements}))).rejects.toThrow('INSPECTION_STATE_CHANGED');
  await opened.db.query(`REVOKE SELECT ON public.rnd_analyses FROM ${runtime}`);
  expect(await inspectState(opened.db,inventory,runtime)).toEqual(state);
 });
});
