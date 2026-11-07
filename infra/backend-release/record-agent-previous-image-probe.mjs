// Run unchanged inside the reviewed previous image on the isolated restored DB.
// The previous image's real schema guard and app must succeed; no bridge patch,
// migration, role grant, worker, feature activation, or write is performed here.
import {createHash} from 'node:crypto';
import {loadConfig} from '/app/backend/dist/config.js';
import {openDatabase} from '/app/backend/dist/db/open.js';
import {assertSchemaCurrent} from '/app/backend/dist/db/migrate.js';
import {intakeConfigFromEnv} from '/app/backend/dist/intake/runtime-config.js';
const digest=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const fail=code=>{throw Error(code);};
const imageDigest=value=>typeof value==='string'?value.match(/(?:^|@)(sha256:[a-f0-9]{64})$/)?.[1]:undefined;
let opened,phase='binding';
const deadline=setTimeout(()=>{console.error(JSON.stringify({event:'record_agent_previous_image_probe_failed',phase,code:'BOUNDED_STARTUP_TIMEOUT'}));process.exit(1);},120000);deadline.unref();
try{
 const review=JSON.parse(process.env.PACKPROOF_AGENT_REVIEW_JSON??'{}'),reviewSha256=digest(review),cluster=review.clusterArn?.match(/^arn:aws:ecs:([a-z0-9-]+):([0-9]{12}):cluster\/([a-zA-Z0-9_-]+)$/);
 if(review.schema!=='packproof.record-agent-staging-review/v1'||review.environment!=='staging'||review.approvedNonproduction!==true||reviewSha256!==process.env.PACKPROOF_AGENT_REVIEW_SHA256||!cluster||!/^[a-f0-9]{40}$/.test(review.previousSource??'')||!/^sha256:[a-f0-9]{64}$/.test(review.previousImage??'')||!/^[a-f0-9]{64}$/.test(review.inventorySha256??'')||!/^[a-z][a-z0-9_]{0,62}$/.test(review.apiRole??''))fail('AGENT_PREVIOUS_IMAGE_REVIEW_REQUIRED');
 if(process.env.PACKPROOF_RELEASE_SHA!==review.previousSource||imageDigest(process.env.PACKPROOF_RELEASE_IMAGE)!==review.previousImage||process.env.PACKPROOF_PROCESS_ROLE!=='api'||process.env.PACKPROOF_ENVIRONMENT!=='staging'||process.env.PACKPROOF_MIGRATE_ON_START!=='false'||process.env.PACKPROOF_ORGANIZATIONS_ENABLED!=='false'||process.env.PACKPROOF_CLAIM_EXPORTS_ENABLED!=='false'||intakeConfigFromEnv().actorIds.length)fail('AGENT_PREVIOUS_IMAGE_INACTIVE_CONFIGURATION_REQUIRED');
 const config=loadConfig(),url=new URL(config.databaseUrl);
 if(!review.restored?.host||review.restored.host===review.target?.host||review.restored.host==='packproof-v2-staging-db.c8v2esku2zyt.us-east-1.rds.amazonaws.com'||!review.restored.host.endsWith('.rds.amazonaws.com')||url.hostname!==review.restored.host||decodeURIComponent(url.pathname.slice(1))!==review.restored.database||url.port&&url.port!=='5432'||decodeURIComponent(url.username)!==review.apiRole||config.processRole!=='api'||config.migrateOnStart!==false)fail('AGENT_PREVIOUS_IMAGE_RESTORED_TARGET_REQUIRED');
 phase='task-metadata';const uri=process.env.ECS_CONTAINER_METADATA_URI_V4;
 if(typeof uri!=='string'||!/^http:\/\/169\.254\.170\.2\/v4\/[a-zA-Z0-9_/-]+$/.test(uri))fail('AGENT_ACTUAL_ECS_METADATA_REQUIRED');
 const fetchJson=async target=>{const response=await fetch(target,{signal:AbortSignal.timeout(10000)});if(!response.ok)fail('AGENT_ECS_METADATA_UNAVAILABLE');return response.json();};
 const [container,task]=await Promise.all([fetchJson(uri),fetchJson(uri+'/task')]),taskPrefix=`arn:aws:ecs:${cluster[1]}:${cluster[2]}:task/${cluster[3]}/`;
 if(typeof task.TaskARN!=='string'||!task.TaskARN.startsWith(taskPrefix)||!/^[a-f0-9]{32}$/.test(task.TaskARN.slice(taskPrefix.length))||![review.clusterArn,cluster[3]].includes(task.Cluster)||imageDigest(container.ImageID)!==review.previousImage)fail('AGENT_PREVIOUS_IMAGE_ACTUAL_TASK_MISMATCH');
 // Force every pool, including the application's, to read-only in PostgreSQL.
 process.env.PGOPTIONS='-c default_transaction_read_only=on';url.searchParams.set('options','-c default_transaction_read_only=on');process.env.DATABASE_URL=url.toString();config.databaseUrl=url.toString();
 phase='database';opened=await openDatabase(config);if(opened.engine!=='postgres')fail('AGENT_PREVIOUS_IMAGE_POSTGRES_REQUIRED');
 const receipt=await opened.db.transaction(async db=>{
  await db.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
  const identity=(await db.query("SELECT current_user AS role,session_user AS login,current_database() AS database,current_schema() AS schema,current_setting('default_transaction_read_only') AS default_read_only")).rows[0],tls=(await db.query('SELECT ssl,version FROM pg_stat_ssl WHERE pid=pg_backend_pid()')).rows[0];
  if(identity?.role!==review.apiRole||identity.login!==review.apiRole||identity.database!==review.restored.database||identity.schema!=='public'||identity.default_read_only!=='on'||!tls?.ssl)fail('AGENT_PREVIOUS_IMAGE_ACTUAL_READONLY_RUNTIME_REQUIRED');
  const ledger=(await db.query('SELECT id,checksum FROM schema_migrations ORDER BY id')).rows;
  if(ledger.length!==107||digest(ledger)!==review.inventorySha256)fail('AGENT_PREVIOUS_IMAGE_CURRENT108_LEDGER_REQUIRED');
  // Unbridged107 images reject108 here. Report that blocker, never bypass it.
  try{await assertSchemaCurrent(db);}catch{fail('AGENT_PREVIOUS_IMAGE_SCHEMA108_NOT_ADMITTED');}
  const unsafe=(await db.query("SELECT has_schema_privilege(current_user,'public','CREATE') OR has_table_privilege(current_user,'schema_migrations','INSERT,UPDATE,DELETE') OR has_table_privilege(current_user,'user_system_roles','INSERT,UPDATE,DELETE') OR pg_has_role(current_user,$1,'MEMBER') OR pg_has_role(current_user,$1,'SET') AS allowed",[review.ownerRole])).rows[0];
  if(!unsafe||unsafe.allowed)fail('AGENT_PREVIOUS_IMAGE_RUNTIME_AUTHORITY_UNSAFE');
  return {identity,tls:{ssl:true,version:tls.version},migrationCount:ledger.length,inventorySha256:digest(ledger)};
 });
 await opened.close();opened=undefined;phase='application-startup';await import('/app/backend/dist/index.js');
 phase='http';const checks=[];let metaCommit,metaImage;
 for(const route of ['/meta','/health','/ready']){
  let response;
  for(let attempt=0;attempt<20;attempt++){try{response=await fetch(`http://127.0.0.1:${config.port}${route}`,{signal:AbortSignal.timeout(10000)});break;}catch(error){if(attempt===19)throw error;await new Promise(resolve=>setTimeout(resolve,250));}}
  if(response.status!==200)fail('AGENT_PREVIOUS_IMAGE_HTTP_READINESS_FAILED');const result=await response.json();
  if(route==='/meta'){metaCommit=result.commit;metaImage=imageDigest(result.image);if(metaCommit!==review.previousSource||metaImage!==review.previousImage)fail('AGENT_PREVIOUS_IMAGE_PUBLIC_IDENTITY_MISMATCH');}checks.push({route,status:response.status});
 }
 const body={schema:'packproof.record-agent-previous-image-probe/v1',reviewSha256,source:review.previousSource,image:review.previousImage,targetHost:review.restored.host,targetDatabase:review.restored.database,clusterArn:review.clusterArn,taskArn:task.TaskARN,completedAt:new Date().toISOString(),processRole:'api',databaseReadOnly:true,workersStarted:false,featuresActivated:false,schemaCurrent:true,...receipt,metaCommit,metaImage,checks};
 console.log(JSON.stringify({event:'record_agent_previous_image_probe',report:{...body,sha256:digest(body)}}));phase='shutdown';process.kill(process.pid,'SIGTERM');
}catch(error){
 const code=/^[A-Z][A-Z0-9_]{2,80}$/.test(error?.message??'')?error.message:'AGENT_PREVIOUS_IMAGE_PROBE_FAILED';console.error(JSON.stringify({event:'record_agent_previous_image_probe_failed',phase,code}));try{await opened?.close();}finally{process.exit(1);}
}
