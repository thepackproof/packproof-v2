// Offline staging reset. Never imported by the API or a worker.
// Run inventory first, verify the RDS snapshot independently, then apply its exact fingerprint.
import { createHash } from 'node:crypto';
import { loadConfig } from '../dist/config.js';
import { createPgDatabase } from '../dist/db/postgres.js';

const roots=['transactions','proofs','commerce_order_records','intake_source_observations','api_idempotency','commerce_connection_sync_states','commerce_webhook_inbox'];
const protectedTables=new Set(['users','auth_identities','user_profiles','integration_connections','api_tenants','api_keys','schema_migrations','policy_recovery_tables','policy_recovery_events','policy_recovery_fence']);
const quoted=name=>{if(!/^[a-z_][a-z0-9_]*$/.test(name))throw Error('Unsafe table identifier');return `public."${name}"`;};
const config=loadConfig();
if(config.release.environment!=='staging'||!config.databaseUrl)throw Error('Only configured staging PostgreSQL is supported');
const opened=createPgDatabase(config.databaseUrl,undefined,process.env);
async function inventory(db){
  const names=(await db.query(`WITH RECURSIVE reset_tables AS (
    SELECT c.oid,c.relname FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relname=ANY($1::text[])
    UNION SELECT child.oid,child.relname FROM pg_constraint f JOIN reset_tables r ON f.confrelid=r.oid
      JOIN pg_class child ON child.oid=f.conrelid WHERE f.contype='f'
  ) SELECT DISTINCT relname AS name FROM reset_tables ORDER BY name`,[roots])).rows.map(r=>r.name);
  if(names.some(n=>protectedTables.has(n)))throw Error('Reset graph would affect protected configuration');
  const tables=[];
  for(const name of names)tables.push({name,count:Number((await db.query(`SELECT count(*) AS count FROM ${quoted(name)}`)).rows[0].count)});
  const transactions=(await db.query('SELECT id,updated_at FROM transactions ORDER BY id')).rows;
  const proofs=(await db.query('SELECT id,updated_at FROM proofs ORDER BY id')).rows;
  const database=(await db.query('SELECT current_database() AS name')).rows[0].name;
  if(database!=='packproof_v2')throw Error('Unexpected staging database');
  const plan={database,release:config.release.commit,tables,transactions,proofs};
  return {...plan,fingerprint:createHash('sha256').update(JSON.stringify(plan)).digest('hex')};
}
try{
  const plan=await inventory(opened.db);
  const applyIndex=process.argv.indexOf('--apply');
  if(applyIndex<0)console.log(JSON.stringify({event:'staging_cleanup_inventory',...plan}));
  else {
    const expected=process.argv[applyIndex+1],snapshot=process.argv[process.argv.indexOf('--snapshot')+1];
    if(!/^[a-f0-9]{64}$/.test(expected||'')||!/^arn:aws:rds:us-east-1:784514617543:snapshot:packproof-preclaims-/.test(snapshot||''))throw Error('Exact inventory fingerprint and verified staging snapshot are required');
    const result=await opened.db.transaction(async tx=>{
      await tx.query("SET LOCAL lock_timeout='10s'");
      await tx.query(`LOCK TABLE ${plan.tables.map(t=>quoted(t.name)).join(',')} IN ACCESS EXCLUSIVE MODE`);
      const locked=await inventory(tx);
      if(locked.fingerprint!==expected)throw Error('Inventory changed; no records were removed');
      // The user authorized a full reset of enumerated legacy staging transaction data.
      // TRUNCATE with RESTRICT preserves every unlisted parent/configuration table and every runtime guard.
      await tx.query(`TRUNCATE TABLE ${plan.tables.map(t=>quoted(t.name)).join(',')} RESTRICT`);
      await tx.query('UPDATE integration_connections SET auto_sync_enabled=false WHERE auto_sync_enabled=true');
      return {event:'staging_cleanup_complete',snapshot,fingerprint:expected,removed:plan.tables,remaining:(await inventory(tx)).tables};
    });
    console.log(JSON.stringify(result));
  }
}finally{await opened.close();}
