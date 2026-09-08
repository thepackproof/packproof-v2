import { readdir,readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Database } from './database.js';
import { splitSqlStatements } from './sql.js';
const migrationsDir=path.join(path.dirname(fileURLToPath(import.meta.url)),'../../migrations');
export async function migrationInventory(sourceDir=migrationsDir){
  const files=(await readdir(sourceDir)).filter(name=>name.endsWith('.sql')).sort();
  return Promise.all(files.map(async file=>{const sql=await readFile(path.join(sourceDir,file),'utf8');return {id:file.replace(/\.sql$/i,''),checksum:createHash('sha256').update(sql).digest('hex'),sql};}));
}
export async function assertSchemaCurrent(db:Database,sourceDir=migrationsDir):Promise<void>{
  const inventory=await migrationInventory(sourceDir);
  const applied=(await db.query<{id:string;checksum:string|null}>('SELECT id,checksum FROM schema_migrations')).rows;
  const expectedIds=new Set(inventory.map(item=>item.id));
  if(applied.some(row=>!expectedIds.has(row.id)))throw new Error('Database contains migrations outside this release compatibility envelope');
  for(const item of inventory){const row=applied.find(entry=>entry.id===item.id);if(!row||row.checksum!==item.checksum)throw new Error(`Migration required or checksum mismatch: ${item.id}`);}
}
export async function migrate(db:Database,sourceDir=migrationsDir,options:{adoptLegacyChecksums?:boolean;expectedRole?:string}={}):Promise<void>{
  const lock=async(tx:Database)=>{await tx.query("SET LOCAL lock_timeout = '15s'");await tx.query('SELECT pg_advisory_xact_lock(1347438146,1)');};
  const role=options.expectedRole??process.env.PACKPROOF_MIGRATION_ROLE;
  const inventory=await migrationInventory(sourceDir);
  await db.transaction(async tx=>{
    await lock(tx);
    if(role){const result=await tx.query<{role:string}>('SELECT current_user AS role');if(result.rows[0].role!==role)throw new Error('Migration connection does not use the configured migration role');}
    await tx.query('CREATE TABLE IF NOT EXISTS schema_migrations(id TEXT PRIMARY KEY,applied_at TIMESTAMPTZ NOT NULL,checksum TEXT,checksum_provenance TEXT)');
    await tx.query('ALTER TABLE schema_migrations ADD COLUMN IF NOT EXISTS checksum TEXT');
    await tx.query('ALTER TABLE schema_migrations ADD COLUMN IF NOT EXISTS checksum_provenance TEXT');
  });
  for(const item of inventory)await db.transaction(async tx=>{
    await lock(tx);
    const previous=(await tx.query<{checksum:string|null}>('SELECT checksum FROM schema_migrations WHERE id=$1',[item.id])).rows[0];
    if(previous){
      if(previous.checksum===item.checksum)return;
      if(previous.checksum!==null)throw new Error(`Applied migration checksum mismatch: ${item.id}`);
      // Adoption is a reviewed one-time baseline operation, never a silent runtime rewrite.
      if(!(options.adoptLegacyChecksums??process.env.PACKPROOF_ADOPT_LEGACY_MIGRATION_CHECKSUMS==='true'))throw new Error(`Legacy migration checksum requires reviewed baseline: ${item.id}`);
      await tx.query("UPDATE schema_migrations SET checksum=$2,checksum_provenance='REVIEWED_LEGACY_BASELINE_NOT_EXECUTION_PROOF' WHERE id=$1 AND checksum IS NULL",[item.id,item.checksum]);return;
    }
    for(const statement of splitSqlStatements(item.sql)){
      if(/CREATE TABLE schema_migrations/i.test(statement))continue;
      await tx.query(statement);
    }
    await tx.query("INSERT INTO schema_migrations(id,applied_at,checksum,checksum_provenance) VALUES($1,$2,$3,'EXECUTED_BYTES')",[item.id,new Date().toISOString(),item.checksum]);
  });
}
