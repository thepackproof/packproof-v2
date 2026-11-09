
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
const hash=x=>createHash('sha256').update(JSON.stringify(x)).digest('hex');
const fail=x=>{throw Error(x);};
let opened;const deadline=setTimeout(()=>process.exit(2),90000);deadline.unref();
try{
 const e=process.env;
 if(e.PACKPROOF_OPERATOR_PURPOSE!=='connection-worker-readonly-check'||e.PACKPROOF_RELEASE_SHA!=='e6709d6cfb7634ec295133387d72d4920e5d1c8b'||e.PACKPROOF_PROCESS_ROLE!=='worker'||e.PACKPROOF_MIGRATE_ON_START!=='false'||!/^sha256:[a-f0-9]{64}$/.test(e.EXPECTED_IMAGE_DIGEST??'')||!e.PACKPROOF_RELEASE_IMAGE?.endsWith('@'+e.EXPECTED_IMAGE_DIGEST))fail('CONNECTION_PROBE_BINDING_REQUIRED');
 const {loadConfig}=await import('/app/backend/dist/config.js');
 const {openDatabase}=await import('/app/backend/dist/db/open.js');
 const {assertSchemaCurrent}=await import('/app/backend/dist/db/migrate.js');
 const {recordsMigrationInventory,verifyRecordsRuntimePrivileges}=await import('/app/backend/scripts/records-runtime-privileges.mjs');
 const config=loadConfig(),u=new URL(config.databaseUrl);
 if(u.hostname!=='packproof-v2-staging-db.c8v2esku2zyt.us-east-1.rds.amazonaws.com'||u.pathname!=='/packproof_v2'||decodeURIComponent(u.username)!=='packproof_records_worker_v1'||config.migrateOnStart!==false)fail('CONNECTION_PROBE_TARGET_MISMATCH');
 const metadata=e.ECS_CONTAINER_METADATA_URI_V4;
 if(!/^http:\/\/169\.254\.170\.2\/v4\/[a-zA-Z0-9_/-]+$/.test(metadata??''))fail('CONNECTION_PROBE_METADATA_REQUIRED');
 const c=await fetch(metadata,{signal:AbortSignal.timeout(10000)}).then(r=>r.json());
 if(c.ImageID!==e.EXPECTED_IMAGE_DIGEST)fail('CONNECTION_PROBE_ACTUAL_IMAGE_MISMATCH');
 const code=await readFile('/app/backend/dist/records/connections.js','utf8');
 const sql=code.match(/SELECT j\.\*,a\.provider[\s\S]*?FOR UPDATE OF j,s SKIP LOCKED/)?.[0];
 if(!sql?.includes('JOIN record_connection_state s ON s.connection_id=j.connection_id AND s.organization_id=j.organization_id AND s.environment=j.environment')||sql.includes('FOR UPDATE OF j,a'))fail('CONNECTION_PROBE_SHIPPED_QUERY_REQUIRED');
 const inventory=await recordsMigrationInventory();opened=await openDatabase(config);
 const result=await opened.db.transaction(async tx=>{
  await tx.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
  await tx.query("SET LOCAL statement_timeout='20000'");
  const identity=(await tx.query("SELECT current_user AS role,session_user AS login,current_database() AS database,current_setting('transaction_read_only') AS read_only,has_any_column_privilege(current_user,'public.platform_integration_accounts','UPDATE') AS accounts_any_update,has_any_column_privilege(current_user,'public.record_connection_state','UPDATE') AS state_any_update")).rows[0];
  const tls=(await tx.query('SELECT ssl,version FROM pg_stat_ssl WHERE pid=pg_backend_pid()')).rows[0];
  if(identity.role!=='packproof_records_worker_v1'||identity.login!==identity.role||identity.read_only!=='on'||identity.accounts_any_update||!identity.state_any_update||tls?.ssl!==true)fail('CONNECTION_PROBE_ACTUAL_RESTRICTED_LOGIN_REQUIRED');
  await assertSchemaCurrent(tx);
  const ledger=(await tx.query('SELECT id,checksum FROM schema_migrations ORDER BY id')).rows;
  if(ledger.length!==108||hash(ledger)!=='a873b3f50dc1d4a380067d4a3d1a642472827df2fb2e99634ac3b45aa6260a6d')fail('CONNECTION_PROBE_LEDGER_CHANGED');
  const policy=await verifyRecordsRuntimePrivileges(tx,{runtimeRole:'packproof_records_api_v1',workerRole:'packproof_records_worker_v1',schema:'public',reviewedSourceCommit:e.PACKPROOF_RELEASE_SHA,reviewedMigrationSha256:inventory.migrationSha256});
  await tx.query('EXPLAIN (FORMAT JSON) '+sql,[new Date().toISOString()]);
  const heartbeat=(await tx.query("SELECT worker_name,instance_id,heartbeat_at,last_success_at,state FROM operational_worker_heartbeats WHERE worker_name='record-connections' ORDER BY heartbeat_at DESC LIMIT 1")).rows[0];
  if(e.CONNECTION_CHECK_PHASE==='postdeploy'&&(!heartbeat||heartbeat.state!=='IDLE'||Date.now()-new Date(heartbeat.last_success_at).getTime()>30000))fail('CONNECTION_PROBE_SUCCESSFUL_HEARTBEAT_REQUIRED');
  return {identity,tls,ledgerCount:ledger.length,ledgerSha256:hash(ledger),recordsPolicySha256:policy.policySha256,queryPlanning:'PASSED',heartbeat};
 });
 let accountLockDenied=false;
 try{await opened.db.transaction(async tx=>{await tx.query('SET TRANSACTION READ ONLY');await tx.query('EXPLAIN (FORMAT JSON) '+sql.replace('FOR UPDATE OF j,s','FOR UPDATE OF j,a'),[new Date().toISOString()]);});}catch(error){if(error?.code!=='42501')throw error;accountLockDenied=true;}
 if(!accountLockDenied)fail('CONNECTION_PROBE_ACCOUNT_DENIAL_REQUIRED');
 console.log(JSON.stringify({event:'connection_worker_probe_passed',phase:e.CONNECTION_CHECK_PHASE,status:'PASSED',source:e.PACKPROOF_RELEASE_SHA,image:e.EXPECTED_IMAGE_DIGEST,...result,accountLockDenied:true,analyze:false,jobQueryExecuted:false,dataChanged:false,completedAt:new Date().toISOString()}));
}catch(error){console.error(JSON.stringify({event:'connection_worker_probe_failed',code:/^[A-Z0-9_]{3,90}$/.test(error?.message??'')?error.message:'CONNECTION_WORKER_PROBE_FAILED',sqlState:/^[A-Z0-9]{5}$/.test(error?.code??'')?error.code:undefined}));process.exitCode=1;}
finally{clearTimeout(deadline);await opened?.close();}

