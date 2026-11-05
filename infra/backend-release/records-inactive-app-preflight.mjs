// Source-bound read-only startup probe for the inactive application transition.
// This does not qualify records activation, runtime grants, or protected exports.
import {createHash} from 'node:crypto';
import {loadConfig} from '/app/backend/dist/config.js';
import {openDatabase} from '/app/backend/dist/db/open.js';
import {assertSchemaCurrent} from '/app/backend/dist/db/migrate.js';
import {intakeConfigFromEnv} from '/app/backend/dist/intake/runtime-config.js';
let opened,phase='binding';
const deadline=setTimeout(()=>{console.error(JSON.stringify({event:'records_inactive_app_preflight_failed',phase,code:'BOUNDED_STARTUP_TIMEOUT'}));process.exit(1);},120000);
deadline.unref();
try{
 const source='65700aac0d8d3d0640b13469a2d508d86efcc318';
 const image='784514617543.dkr.ecr.us-east-1.amazonaws.com/packproof-v2-staging-api@sha256:6a396f672e62636a6fb603b7e922afadeed0070183d319e3ef335e9ac4274d6f';
 if(process.env.PACKPROOF_RELEASE_SHA!==source||process.env.PACKPROOF_RELEASE_IMAGE!==image||process.env.PACKPROOF_PROCESS_ROLE!=='api'||process.env.PACKPROOF_MIGRATE_ON_START!=='false')throw Error('INACTIVE_APP_BINDING_REQUIRED');
 for(const key of ['PACKPROOF_ORGANIZATIONS_ENABLED','PACKPROOF_CLAIM_EXPORTS_ENABLED'])if(process.env[key]!==undefined&&process.env[key]!=='false')throw Error('INACTIVE_APP_FEATURE_ACTIVATION_FORBIDDEN');
 if(intakeConfigFromEnv().actorIds.length)throw Error('INACTIVE_APP_STARTUP_ENROLLMENT_FORBIDDEN');
 process.env.PGOPTIONS='-c default_transaction_read_only=on';
 const config=loadConfig();
 if(config.release.environment!=='production'||config.migrateOnStart!==false||config.requireDurableReceipts!==false||config.processRole!=='api')throw Error('INACTIVE_APP_CONFIGURATION_REQUIRED');
 phase='database';opened=await openDatabase(config);
 if(opened.engine!=='postgres')throw Error('POSTGRES_REQUIRED');
 const receipt=await opened.db.transaction(async db=>{
  await db.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
  await db.query("SET LOCAL statement_timeout='30s'");
  const identity=(await db.query("SELECT current_user AS role,session_user AS login,current_database() AS database,current_schema() AS schema,current_setting('default_transaction_read_only') AS default_read_only")).rows[0];
  const tls=(await db.query('SELECT ssl,version FROM pg_stat_ssl WHERE pid=pg_backend_pid()')).rows[0];
  if(identity.role!=='packproof_app_runtime_v1'||identity.login!==identity.role||identity.database!=='packproof_v2'||identity.schema!=='public'||identity.default_read_only!=='on'||!tls?.ssl)throw Error('ACTUAL_READONLY_RUNTIME_REQUIRED');
  await assertSchemaCurrent(db);
  const ledger=(await db.query('SELECT id,checksum FROM schema_migrations ORDER BY id')).rows;
  const sha256=createHash('sha256').update(JSON.stringify(ledger)).digest('hex');
  if(ledger.length!==106||sha256!=='605ba38f1c9ffcd6dd28a64a7d07d9cc41c3397ee7c10ba26198ad14ec50c2e1')throw Error('INACTIVE_APP_LEDGER_MISMATCH');
  if((await db.query('SELECT 1 FROM platform_organizations LIMIT 1')).rows.length)throw Error('INACTIVE_APP_ORGANIZATION_ACTIVATION_PRESENT');
  const unsafe=(await db.query("SELECT has_schema_privilege(current_user,'public','CREATE') OR has_table_privilege(current_user,'schema_migrations','INSERT,UPDATE,DELETE') OR has_table_privilege(current_user,'user_system_roles','INSERT,UPDATE,DELETE') OR pg_has_role(current_user,'packproof','MEMBER') OR pg_has_role(current_user,'packproof','SET') AS allowed")).rows[0];
  if(unsafe.allowed)throw Error('INACTIVE_APP_RUNTIME_AUTHORITY_UNSAFE');
  return {identity,tls:{ssl:true,version:tls.version},migrationCount:ledger.length,migrationSha256:sha256};
 });
 await opened.close();opened=undefined;
 phase='application-startup';await import('/app/backend/dist/index.js');
 phase='http';const checks=[];
 for(const route of ['/meta','/health','/ready']){
  let response;
  for(let attempt=0;attempt<20;attempt++){
   try{response=await fetch('http://127.0.0.1:3000'+route,{headers:{Origin:'https://thepackproof.com'},signal:AbortSignal.timeout(10000)});break;}
   catch(error){if(attempt===19)throw error;await new Promise(resolve=>setTimeout(resolve,250));}
  }
  const body=await response.json(),cors=response.headers.get('access-control-allow-origin');
  if(response.status!==200||cors!=='https://thepackproof.com')throw Error('INACTIVE_APP_HTTP_READINESS_FAILED');
  if(route==='/meta'&&(body.commit!==source||body.image!==image))throw Error('INACTIVE_APP_PUBLIC_IDENTITY_MISMATCH');
  checks.push({route,status:response.status,cors});
 }
 console.log(JSON.stringify({event:'records_inactive_app_preflight',source,image,processRole:'api',databaseReadOnly:true,workersStarted:false,featuresActivated:false,...receipt,checks}));
 phase='shutdown';process.kill(process.pid,'SIGTERM');
}catch(error){
 const code=/^[A-Z][A-Z0-9_]{2,80}$/.test(error?.message??'')?error.message:'INACTIVE_APP_STARTUP_FAILED';
 const sdkCode=/^[A-Za-z0-9_]{3,80}$/.test(error?.name??'')?error.name:undefined;
 const locations=String(error?.stack??'').split('\n').slice(1,4).map(line=>line.match(/file:\/\/\/app\/backend\/[^\s)]+/g)?.[0]).filter(Boolean);
 console.error(JSON.stringify({event:'records_inactive_app_preflight_failed',phase,code,sdkCode,locations}));
 try{await opened?.close();}finally{process.exit(1);}
}
