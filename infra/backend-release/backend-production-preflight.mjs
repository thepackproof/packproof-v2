// One-shot verifier: pinned candidate image; cloned current runtime credentials,
// execution/task roles and network; no owner credential or API/worker entrypoint.
// openDatabase retains the existing rotation provider where configured. Secret
// values stay inside that runtime process and are never emitted in the receipt.
import { createHash } from 'node:crypto';
import { loadConfig } from '/app/backend/dist/config.js';
import { openDatabase } from '/app/backend/dist/db/open.js';
import { migrationInventory, assertSchemaCurrent } from '/app/backend/dist/db/migrate.js';
import { rndConfigFromEnv } from '/app/backend/dist/rnd/config.js';
import { assertResearchRuntimeIsolation } from '/app/backend/dist/rnd/runtime-isolation.js';
import { assertProductionRuntime } from '/app/backend/dist/operations/production-runtime.js';
const digest = rows => createHash('sha256').update(JSON.stringify(rows.map(({id,checksum})=>({id,checksum})).sort((a,b)=>a.id<b.id?-1:a.id>b.id?1:0))).digest('hex');
let opened;
try {
  const [sourceSha, expectedInventorySha256] = process.argv.slice(2);
  if(process.argv.length!==4 || !/^[a-f0-9]{40}$/.test(sourceSha??'') || !/^[a-f0-9]{64}$/.test(expectedInventorySha256??'') || process.env.PACKPROOF_RELEASE_SHA!==sourceSha)throw Error('SOURCE_PIN_REQUIRED');
  const config=loadConfig();
  assertProductionRuntime(config);
  if(process.env.PACKPROOF_RND_PROFILE!=='capture-receipts-v1'||process.env.PACKPROOF_RND_ENABLED!=='1'||process.env.PACKPROOF_RND_KILL_SWITCH!=='0')throw Error('RECEIPT_PROFILE_REQUIRED');
  const rnd=rndConfigFromEnv();
  try{assertResearchRuntimeIsolation(config,rnd);}catch{throw Error('RECEIPT_RUNTIME_ISOLATION_REQUIRED');}
  if(config.migrateOnStart!==false || config.release.environment!=='production' || config.credentialNamespace!=='staging' || !config.databaseUrl)throw Error('PRESERVED_RUNTIME_REQUIRED');
  const url=new URL(config.databaseUrl);
  if(url.hostname!=='packproof-v2-staging-db.c8v2esku2zyt.us-east-1.rds.amazonaws.com'||url.pathname!=='/packproof_v2'||decodeURIComponent(url.username)!=='packproof_app_runtime_v1')throw Error('RUNTIME_DATABASE_TARGET_MISMATCH');
  const inventory=await migrationInventory();
  if(inventory.length!==86 || digest(inventory)!==expectedInventorySha256)throw Error('SOURCE_INVENTORY_MISMATCH');
  opened=await openDatabase(config);
  if(opened.engine!=='postgres')throw Error('POSTGRES_REQUIRED');
  const receipt=await opened.db.transaction(async db=>{
    await db.query('SET TRANSACTION READ ONLY');
    await db.query("SET LOCAL statement_timeout='15000ms'");
    const identity=(await db.query("SELECT current_user AS role,session_user AS login,current_database() AS database,current_setting('transaction_read_only') AS read_only")).rows[0];
    const tls=(await db.query('SELECT ssl,version FROM pg_stat_ssl WHERE pid=pg_backend_pid()')).rows[0];
    if(identity.role!=='packproof_app_runtime_v1'||identity.login!==identity.role||identity.database!=='packproof_v2'||identity.read_only!=='on'||!tls?.ssl)throw Error('READ_ONLY_RUNTIME_TLS_REQUIRED');
    await assertSchemaCurrent(db,undefined,true);
    const applied=(await db.query('SELECT id,checksum FROM schema_migrations ORDER BY id')).rows;
    if(new Set(applied.map(x=>x.id)).size!==applied.length || applied.some(x=>typeof x.checksum!=='string'||!/^[a-f0-9]{64}$/.test(x.checksum)))throw Error('INVALID_MIGRATION_RECEIPTS');
    const pending=inventory.filter(x=>!applied.some(row=>row.id===x.id)).map(x=>x.id);
    if(pending.length===1&&pending[0]==='075_onboarding')throw Error('ONBOARDING_MIGRATION_REQUIRED');
    if(pending.length)throw Error('UNEXPECTED_PENDING_MIGRATION');
    const authority=(await db.query("SELECT r.rolsuper,r.rolcreaterole,r.rolcreatedb,r.rolreplication,r.rolbypassrls,pg_has_role(current_user,'packproof','MEMBER') AS owner_member,pg_has_role(current_user,'packproof','SET') AS owner_set,has_schema_privilege(current_user,'public','CREATE') AS schema_create,has_table_privilege(current_user,'public.schema_migrations','INSERT,UPDATE,DELETE') AS schema_write,has_table_privilege(current_user,'public.user_system_roles','INSERT,UPDATE,DELETE') AS admin_role_write FROM pg_roles r WHERE r.rolname=current_user")).rows[0];
    if(!authority||Object.values(authority).some(Boolean))throw Error('RUNTIME_AUTHORITY_WIDENED');
    const policy=(await db.query('SELECT durability_required FROM policy_recovery_fence WHERE singleton=1')).rows[0];
    if(!policy||policy.durability_required!==(config.requireDurableReceipts===true))throw Error('DURABILITY_CONFIGURATION_MISMATCH');
    const verifiedForwardCompatibleMigrations=applied.filter(row=>!inventory.some(item=>item.id===row.id));
    return {sourceSha,readOnly:true,identity,tls,environment:config.release.environment,credentialNamespace:config.credentialNamespace,productionConfigurationVerified:true,sourceInventorySha256:digest(inventory),appliedInventorySha256:digest(applied),sourceMigrationCount:inventory.length,appliedMigrationCount:applied.length,pendingMigrations:pending,verifiedForwardCompatibleMigrations,runtimeAuthorityUnchanged:true,durabilityPolicyMatches:true,productionReceiptProfileVerified:true,profile:rnd.profile};
  });
  console.log(JSON.stringify({event:'security_release_database_preflight',...receipt}));
}catch(error){
  // Do not emit exception strings, connection details, credentials, or SQL params.
  const known=new Set(['SOURCE_PIN_REQUIRED','PRESERVED_RUNTIME_REQUIRED','RUNTIME_DATABASE_TARGET_MISMATCH','SOURCE_INVENTORY_MISMATCH','POSTGRES_REQUIRED','READ_ONLY_RUNTIME_TLS_REQUIRED','INVALID_MIGRATION_RECEIPTS','ONBOARDING_MIGRATION_REQUIRED','UNEXPECTED_PENDING_MIGRATION','RUNTIME_AUTHORITY_WIDENED','DURABILITY_CONFIGURATION_MISMATCH','RECEIPT_PROFILE_REQUIRED','RECEIPT_RUNTIME_ISOLATION_REQUIRED']);
  console.log(JSON.stringify({event:'security_release_database_preflight_failed',code:known.has(error?.message)?error.message:'REVIEW_REQUIRED'}));
  process.exitCode=1;
}finally{await opened?.close();}
