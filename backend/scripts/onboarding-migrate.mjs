// One-shot migration 075. Existing migration receipts, credentials, and policies are preserved.
import pg from 'pg';
import { randomBytes,createHash,createHmac,pbkdf2Sync } from 'node:crypto';
import { loadConfig } from '../dist/config.js';
import { createPgDatabase } from '../dist/db/postgres.js';
import { migrationInventory,migrate,assertSchemaCurrent } from '../dist/db/migrate.js';
const env={...process.env,DATABASE_URL:'',PACKPROOF_DB_SECRET_ARN:''};
const mode=process.argv[2];
if(!['--inspect','--apply'].includes(mode)||env.PACKPROOF_DB_USER!=='packproof'||!env.PACKPROOF_DB_PASSWORD)throw Error('EXPLICIT_OWNER_OPERATOR_REQUIRED');
const config=loadConfig(env),url=new URL(config.databaseUrl);
if(url.hostname!=='packproof-v2-staging-db.c8v2esku2zyt.us-east-1.rds.amazonaws.com'||url.pathname!=='/packproof_v2')throw Error('DATABASE_TARGET_MISMATCH');
const owner=createPgDatabase(config.databaseUrl,undefined,env);
let temporary=null,separate=null;
try {
 const inventory=await migrationInventory();const candidate=inventory.find(row=>row.id==='075_onboarding');
 if(!candidate||candidate.checksum!==env.PACKPROOF_ONBOARDING_MIGRATION_SHA256)throw Error('MIGRATION_BYTES_MISMATCH');
 const identity=(await owner.db.query('SELECT current_user AS role,session_user AS login,current_database() AS database')).rows[0];
 const tls=(await owner.db.query('SELECT ssl FROM pg_stat_ssl WHERE pid=pg_backend_pid()')).rows[0];
 if(identity.role!=='packproof'||identity.login!=='packproof'||!tls?.ssl)throw Error('OWNER_TLS_REQUIRED');
 await assertSchemaCurrent(owner.db,undefined,true);
 const applied=(await owner.db.query('SELECT id,checksum FROM schema_migrations ORDER BY id')).rows;
 const pending=!applied.some(row=>row.id===candidate.id);
 const existing=(await owner.db.query("SELECT to_regclass('public.onboarding_events') AS table_name")).rows[0];
 if(pending&&existing.table_name)throw Error('UNRECEIPTED_ONBOARDING_SCHEMA');
 console.log(JSON.stringify({event:'onboarding_migration_inspected',pending,source:env.PACKPROOF_RELEASE_SHA,migrationSha256:candidate.checksum,baselineCount:applied.length,identity,tls:true}));
 if(mode==='--apply'){
  if(pending){
   const name='pp_onboard_migrate_'+randomBytes(8).toString('hex'),password=randomBytes(32).toString('hex'),salt=randomBytes(24),salted=pbkdf2Sync(password,salt,4096,32,'sha256');
   const stored=createHash('sha256').update(createHmac('sha256',salted).update('Client Key').digest()).digest('base64'),server=createHmac('sha256',salted).update('Server Key').digest('base64');
   const verifier=`SCRAM-SHA-256$4096:${salt.toString('base64')}$${stored}:${server}`;
   await owner.db.transaction(async tx=>{await tx.query(`CREATE ROLE ${pg.escapeIdentifier(name)} LOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS CONNECTION LIMIT 2 PASSWORD ${pg.escapeLiteral(verifier)} VALID UNTIL ${pg.escapeLiteral(new Date(Date.now()+900000).toISOString())}`);await tx.query(`GRANT packproof TO ${pg.escapeIdentifier(name)} WITH ADMIN FALSE, INHERIT FALSE, SET TRUE`);});temporary=name;
   url.username=name;url.password=password;url.searchParams.set('options','-c role=packproof');
   separate=createPgDatabase(url.toString(),undefined,env);
   const id=(await separate.db.query('SELECT current_user AS role,session_user AS login')).rows[0];
   if(id.role!=='packproof'||id.login!==name)throw Error('SEPARATE_MIGRATION_LOGIN_REQUIRED');
   await migrate(separate.db,undefined,{expectedRole:'packproof'});
  }
  // Add only the permissions the new endpoint uses. No runtime memberships change.
  await owner.db.query('GRANT SELECT,INSERT ON public.onboarding_events TO packproof_runtime');
  await assertSchemaCurrent(owner.db);
  const checks=(await owner.db.query("SELECT has_table_privilege('packproof_runtime','public.onboarding_events','SELECT') AS can_read,has_table_privilege('packproof_runtime','public.onboarding_events','INSERT') AS can_append,has_column_privilege('packproof_runtime','public.users','onboarding_completed','UPDATE') AS can_update_state")).rows[0];
  if(!checks.can_read||!checks.can_append||!checks.can_update_state)throw Error('RUNTIME_ONBOARDING_PRIVILEGES_MISSING');
  console.log(JSON.stringify({event:'onboarding_migration_applied',migrationSha256:candidate.checksum,checks}));
 }
}finally{await separate?.close();if(temporary)await owner.db.query(`DROP ROLE ${pg.escapeIdentifier(temporary)}`);await owner.close();}
