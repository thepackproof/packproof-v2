// One-shot candidate-image admission under each EXISTING runtime login. No application main or writes.
import {createHash} from 'node:crypto';
import {readFile} from 'node:fs/promises';
const hash=x=>createHash('sha256').update(JSON.stringify(x)).digest('hex');
const check=(ok,code)=>{if(!ok)throw Error(code);};
let opened;
const deadline=setTimeout(()=>process.exit(2),120000);deadline.unref();
try{
 const r=JSON.parse(process.argv[2]??'{}'),e=process.env;
 check(r.schema==='packproof.connect-runtime-probe-review/v1'&&/^[a-f0-9]{40}$/.test(r.sourceSha??'')&&/^\S+@sha256:[a-f0-9]{64}$/.test(r.image??'')&&['api','worker'].includes(r.kind)&&r.apiRole!==r.workerRole&&[r.apiRole,r.workerRole].every(x=>/^[a-z][a-z0-9_]{0,62}$/.test(x??'')),'CONNECT_PROBE_REVIEW_REQUIRED');
 check(e.PACKPROOF_RELEASE_SHA===r.sourceSha&&e.PACKPROOF_RELEASE_IMAGE===r.image&&e.PACKPROOF_MIGRATE_ON_START==='false'&&e.PACKPROOF_PROCESS_ROLE===r.kind&&e.PACKPROOF_ENVIRONMENT===r.environment,'CONNECT_PROBE_RUNTIME_BINDING_REQUIRED');
 const uri=e.ECS_CONTAINER_METADATA_URI_V4;
 check(/^http:\/\/169\.254\.170\.2\/v4\/[a-zA-Z0-9_/-]+$/.test(uri??''),'CONNECT_PROBE_METADATA_REQUIRED');
 const get=async u=>{const response=await fetch(u,{signal:AbortSignal.timeout(10000)});check(response.ok,'CONNECT_PROBE_METADATA_UNAVAILABLE');return response.json();};
 const [container,task]=await Promise.all([get(uri),get(uri+'/task')]);
 check(/^arn:aws:ecs:us-east-1:784514617543:cluster\/[A-Za-z0-9_-]+$/.test(r.clusterArn??'')&&[r.clusterArn,r.clusterArn.split('/').at(-1)].includes(task.Cluster)&&task.TaskARN?.startsWith(r.clusterArn.replace(':cluster/',':task/')+'/')&&container.ImageID===r.image.split('@')[1],'CONNECT_PROBE_ACTUAL_IMAGE_REQUIRED');
 const [{loadConfig},{openDatabase},{migrationInventory,assertSchemaCurrent},{recordsMigrationInventory,verifyRecordsRuntimePrivileges},{verifyM2RuntimePrivileges}]=await Promise.all([import('/app/backend/dist/config.js'),import('/app/backend/dist/db/open.js'),import('/app/backend/dist/db/migrate.js'),import('/app/backend/scripts/records-runtime-privileges.mjs'),import('/app/backend/scripts/m2-runtime-privileges.mjs')]);
 const config=loadConfig(),url=new URL(config.databaseUrl),role=r.kind==='api'?r.apiRole:r.workerRole;
 check(url.hostname===r.database.host&&decodeURIComponent(url.pathname.slice(1))===r.database.name&&decodeURIComponent(url.username)===role&&config.processRole===r.kind&&config.migrateOnStart===false&&config.release.environment===r.environment,'CONNECT_PROBE_DATABASE_TARGET_REQUIRED');
 const inventory=(await migrationInventory()).map(({id,checksum})=>({id,checksum})),inventorySha256=hash(inventory);
 check(inventory.length===108&&inventorySha256==='a873b3f50dc1d4a380067d4a3d1a642472827df2fb2e99634ac3b45aa6260a6d','CONNECT_PROBE_SOURCE_INVENTORY_REQUIRED');
 check((await readFile('/app/backend/dist/records/agent-restrictions.js','utf8')).includes('packproof.scheduled-csv/v2'),'CONNECT_PROBE_COMPILED_V2_REQUIRED');
 opened=await openDatabase(config);check(opened.engine==='postgres','CONNECT_PROBE_POSTGRES_REQUIRED');
 const receipt=await opened.db.transaction(async db=>{
  await db.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');await db.query("SET LOCAL statement_timeout='20000'");
  const identity=(await db.query("SELECT current_user AS role,session_user AS login,current_database() AS database,current_schema() AS schema,current_setting('transaction_read_only') AS read_only")).rows[0],tls=(await db.query('SELECT ssl,version FROM pg_stat_ssl WHERE pid=pg_backend_pid()')).rows[0];
  check(identity?.role===role&&identity.login===role&&identity.database===r.database.name&&identity.schema==='public'&&identity.read_only==='on'&&tls?.ssl===true,'CONNECT_PROBE_ACTUAL_LOGIN_TLS_REQUIRED');
  await assertSchemaCurrent(db);const applied=(await db.query('SELECT id,checksum FROM schema_migrations ORDER BY id')).rows;
  check(applied.length===108&&hash(applied)===inventorySha256,'CONNECT_PROBE_APPLIED_INVENTORY_REQUIRED');
  const unsafe=(await db.query("SELECT r.rolsuper OR r.rolcreatedb OR r.rolcreaterole OR r.rolreplication OR r.rolbypassrls OR pg_has_role(current_user,'packproof','MEMBER') OR pg_has_role(current_user,'packproof','SET') OR has_schema_privilege(current_user,'public','CREATE') OR has_table_privilege(current_user,'schema_migrations','INSERT,UPDATE,DELETE') OR has_table_privilege(current_user,'user_system_roles','INSERT,UPDATE,DELETE') AS allowed FROM pg_roles r WHERE r.rolname=current_user")).rows[0];
  check(unsafe?.allowed===false,'CONNECT_PROBE_RUNTIME_AUTHORITY_UNSAFE');
  const records=await recordsMigrationInventory();
  await verifyRecordsRuntimePrivileges(db,{runtimeRole:r.apiRole,workerRole:r.workerRole,schema:'public',reviewedSourceCommit:r.sourceSha,reviewedMigrationSha256:records.migrationSha256});
  await verifyM2RuntimePrivileges(db,{apiRole:r.apiRole,workerRole:r.workerRole});
  const fence=(await db.query('SELECT durability_required FROM policy_recovery_fence WHERE singleton=1')).rows[0];
  check(fence&&fence.durability_required===(config.requireDurableReceipts===true),'CONNECT_PROBE_DURABILITY_MISMATCH');
  return {role,readOnly:true,runtimeAuthorityUnchanged:true,durabilityPolicyMatches:true,tls:tls.version};
 });
 console.log(JSON.stringify({event:'connect_runtime_probe',schema:'packproof.connect-runtime-probe/v1',kind:r.kind,sourceSha:r.sourceSha,image:r.image,taskArn:task.TaskARN,clusterArn:r.clusterArn,databaseHost:r.database.host,databaseName:r.database.name,environment:r.environment,inventorySha256,compiledV2Guards:true,...receipt,completedAt:new Date().toISOString()}));
}catch(error){console.error(JSON.stringify({event:'connect_runtime_probe_failed',code:/^[A-Z0-9_]{3,90}$/.test(error?.message??'')?error.message:'CONNECT_PROBE_REVIEW_REQUIRED'}));process.exitCode=1;}
finally{clearTimeout(deadline);await opened?.close();}
