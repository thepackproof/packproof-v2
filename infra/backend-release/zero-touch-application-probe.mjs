// Run inside the exact candidate or immutable rollback image. All PostgreSQL
// sessions are read-only; no worker or customer integration is activated.
import {createHash} from 'node:crypto';
import {loadConfig} from '/app/backend/dist/config.js';
import {openDatabase} from '/app/backend/dist/db/open.js';
import {assertSchemaCurrent} from '/app/backend/dist/db/migrate.js';
import {intakeConfigFromEnv} from '/app/backend/dist/intake/runtime-config.js';
const hash=x=>createHash('sha256').update(JSON.stringify(x)).digest('hex');
const fail=code=>{throw Error(code);};
const host='packproof-zero-touch-runtime-20261108.c8v2esku2zyt.us-east-1.rds.amazonaws.com';
const modes={
 candidate:{source:'3bff0173c9d91fc11ae614d72872b877628c327d',image:'sha256:3b1c81642b27a14629a5a8c8f4af4b0bf91f09bc0e0b5591e06af10d5bde0557'},
 rollback:{source:'e346452ade2744820fb2f429d7aeb94fef376419',image:'sha256:24e8bae0a3b4db24e75d681baa29d3d0b8c96f2d2e8e3d62bbca22e66ea69783'},
};
let opened,phase='binding';
const deadline=setTimeout(()=>process.exit(2),180000);deadline.unref();
try{
 const e=process.env,pin=modes[e.ZERO_TOUCH_PROBE_MODE],expires=Date.parse(e.ZERO_TOUCH_PROBE_EXPIRES_AT)-Date.now();
 if(!pin||!Number.isFinite(expires)||expires<=0||expires>3600000||e.PACKPROOF_TEST_PURPOSE!=='isolated-production-restore'||e.PACKPROOF_DB_HOST!==host||e.PACKPROOF_DB_NAME!=='packproof_v2'||e.PACKPROOF_DB_USER!=='packproof_records_api_v1'||e.PACKPROOF_PROCESS_ROLE!=='api'||e.PACKPROOF_MIGRATE_ON_START!=='false'||e.PACKPROOF_ORGANIZATIONS_ENABLED!=='false'||e.PACKPROOF_CLAIM_EXPORTS_ENABLED!=='false'||e.PACKPROOF_RELEASE_SHA!==pin.source||!e.PACKPROOF_RELEASE_IMAGE?.endsWith('@'+pin.image)||e.DATABASE_URL||e.PACKPROOF_DB_SECRET_ARN||Object.keys(e).some(k=>k.startsWith('PG')&&e[k])||intakeConfigFromEnv().actorIds.length)fail('ZERO_TOUCH_PROBE_BINDING_REQUIRED');
 const metadata=e.ECS_CONTAINER_METADATA_URI_V4;
 if(!/^http:\/\/169\.254\.170\.2\/v4\/[a-zA-Z0-9_/-]+$/.test(metadata??''))fail('ZERO_TOUCH_PROBE_ECS_METADATA_REQUIRED');
 const get=async url=>{const r=await fetch(url,{signal:AbortSignal.timeout(10000)});if(!r.ok)fail('ZERO_TOUCH_PROBE_METADATA_FAILED');return r.json();};
 const [container,task]=await Promise.all([get(metadata),get(metadata+'/task')]);
 if(container.ImageID!==pin.image||!/^arn:aws:ecs:us-east-1:784514617543:task\/packproof-m1-20261021-runtime\/[a-f0-9]{32}$/.test(task.TaskARN??''))fail('ZERO_TOUCH_PROBE_ACTUAL_IMAGE_MISMATCH');
 e.PGOPTIONS='-c default_transaction_read_only=on';
 const config=loadConfig(),url=new URL(config.databaseUrl);
 if(url.hostname!==host||url.pathname!=='/packproof_v2'||decodeURIComponent(url.username)!=='packproof_records_api_v1'||config.processRole!=='api'||config.migrateOnStart!==false||config.authMode!=='cognito'||config.objectStore!=='s3')fail('ZERO_TOUCH_PROBE_CONFIGURATION_MISMATCH');
 url.searchParams.set('options','-c default_transaction_read_only=on');e.DATABASE_URL=url.href;config.databaseUrl=url.href;
 phase='database';opened=await openDatabase(config);
 const database=await opened.db.transaction(async db=>{
  await db.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
  const actual=(await db.query("SELECT current_user AS role,session_user AS login,current_database() AS database,current_setting('default_transaction_read_only') AS read_only")).rows[0];
  const tls=(await db.query('SELECT ssl,version FROM pg_stat_ssl WHERE pid=pg_backend_pid()')).rows[0];
  if(actual?.role!=='packproof_records_api_v1'||actual.login!==actual.role||actual.database!=='packproof_v2'||actual.read_only!=='on'||tls?.ssl!==true)fail('ZERO_TOUCH_PROBE_ACTUAL_LOGIN_REQUIRED');
  const ledger=(await db.query('SELECT id,checksum FROM schema_migrations ORDER BY id')).rows;
  if(ledger.length!==108||hash(ledger)!=='a873b3f50dc1d4a380067d4a3d1a642472827df2fb2e99634ac3b45aa6260a6d')fail('ZERO_TOUCH_PROBE_LEDGER_REQUIRED');
  await assertSchemaCurrent(db);
  return {actual,tls,migrationCount:ledger.length,inventorySha256:hash(ledger)};
 });
 await opened.close();opened=undefined;
 phase='application';await import('/app/backend/dist/index.js');
 const checks=[];
 for(const [route,status] of [['/meta',200],['/health',200],['/ready',200],['/me/capabilities',401]]){
  let response;
  for(let attempt=0;attempt<20;attempt++){
   try{response=await fetch(`http://127.0.0.1:${config.port}${route}`,{headers:{Origin:'https://thepackproof.com'},signal:AbortSignal.timeout(10000)});break;}
   catch(error){if(attempt===19)throw error;await new Promise(resolve=>setTimeout(resolve,250));}
  }
  const body=await response.json(),cors=response.headers.get('access-control-allow-origin');
  if(response.status!==status||cors!=='https://thepackproof.com')fail('ZERO_TOUCH_PROBE_HTTP_FAILED');
  if(route==='/meta'&&(body.commit!==pin.source||body.image!==e.PACKPROOF_RELEASE_IMAGE))fail('ZERO_TOUCH_PROBE_PUBLIC_IDENTITY_MISMATCH');
  checks.push({route,status:response.status,cors});
 }
 console.log(JSON.stringify({event:'zero_touch_application_probe',schema:'packproof.zero-touch-application-probe/v1',status:'PASSED',mode:e.ZERO_TOUCH_PROBE_MODE,applicationSource:pin.source,imageDigest:pin.image,taskArn:task.TaskARN,targetHost:host,completedAt:new Date().toISOString(),database,checks,databaseReadOnly:true,workersStarted:false,featuresActivated:false,productionChanged:false,customerQualification:false}));
 clearTimeout(deadline);process.kill(process.pid,'SIGTERM');
}catch(error){
 console.error(JSON.stringify({event:'zero_touch_application_probe_failed',phase,code:/^[A-Z0-9_]{3,90}$/.test(error?.message??'')?error.message:'ZERO_TOUCH_PROBE_FAILED',sqlState:/^[0-9A-Z]{5}$/.test(error?.code??'')?error.code:undefined}));
 clearTimeout(deadline);await opened?.close();process.exit(1);
}
