import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import type {Database} from '../src/db/database.js';
import {migrate,migrationInventory} from '../src/db/migrate.js';
import { randomBytes } from 'node:crypto';
import { createPgliteDatabase } from '../src/db/pglite.js';
import { createPgDatabase } from '../src/db/postgres.js';

/** An explicit test connection opts into PostgreSQL; application credentials are never consulted. */
export async function openIsolatedTestDatabase() {
  const connection = process.env.PACKPROOF_TEST_DATABASE_URL;
  if (!connection) return createPgliteDatabase();
  const admin = createPgDatabase(connection);
  const schema = `partner_services_${randomBytes(8).toString('hex')}`;
  try { await admin.db.query(`CREATE SCHEMA ${schema}`); }
  catch (error) { await admin.close(); throw error; }
  const url = new URL(connection);
  url.searchParams.set('options', `-c search_path=${schema}`);
  const opened = createPgDatabase(url.toString());
  return { db: opened.db, close: async () => {
    try { await opened.close(); await admin.db.query(`DROP SCHEMA ${schema} CASCADE`); }
    finally { await admin.close(); }
  } };
}

/** Install the exact historical fixture catalog before exercising a pinned role policy. */
export async function migrateTestDatabaseThrough(db:Database, throughMigration:number){
  const directory=await mkdtemp(path.join(tmpdir(),'packproof-test-catalog-'));
  try{
    for(const migration of await migrationInventory()){
      if(Number(migration.id.slice(0,3))<=throughMigration){
        await writeFile(path.join(directory,migration.id+'.sql'),migration.sql);
      }
    }
    await migrate(db,directory);
  }finally{await rm(directory,{recursive:true,force:true});}
}
