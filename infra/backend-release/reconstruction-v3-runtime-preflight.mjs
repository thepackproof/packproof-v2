// Explicit actual-role, read-only candidate admission. Requires an independently
// migrated/approved isolated target; it cannot apply schema, grants or rollout.
import {pathToFileURL} from 'node:url';
import {reconstructionDigest,validateReconstructionReview,inspectReconstructionInventory,validateReconstructionTaskMetadata,inspectReconstructionPlatformLocks} from './reconstruction-v3-release-review.mjs';
export async function runReconstructionPreflight(kind,env=process.env) {
 if(!['api','worker'].includes(kind))throw Error('RECONSTRUCTION_PROCESS_ROLE_REQUIRED');
 let review;try{review=JSON.parse(env.PACKPROOF_RECONSTRUCTION_V3_REVIEW_JSON??'');}catch{throw Error('RECONSTRUCTION_REVIEW_BINDING_REQUIRED');}
 const reviewSha256=validateReconstructionReview(review,env.PACKPROOF_RECONSTRUCTION_V3_REVIEW_SHA256,env.PACKPROOF_RELEASE_SHA);
 let endpoint;try{endpoint=new URL(env.ECS_CONTAINER_METADATA_URI_V4);}catch{throw Error('RECONSTRUCTION_TASK_METADATA_REQUIRED');}
 if(endpoint.protocol!=='http:'||endpoint.hostname!=='169.254.170.2'||endpoint.port||endpoint.username||endpoint.password||endpoint.search||endpoint.hash||!/^\/v4\/[a-zA-Z0-9_-]+$/.test(endpoint.pathname))throw Error('RECONSTRUCTION_TASK_METADATA_REQUIRED');
 const metadata=async suffix=>{const response=await fetch(endpoint.href+suffix,{signal:AbortSignal.timeout(5000)});if(!response.ok)throw Error('RECONSTRUCTION_TASK_METADATA_UNAVAILABLE');return response.json();};
 const [container,task]=await Promise.all([metadata(''),metadata('/task')]);
 const taskIdentity=validateReconstructionTaskMetadata(container,task,review);
 const [{loadConfig},{openDatabase},{migrationInventory,assertSchemaCurrent},{recordsMigrationInventory,verifyRecordsRuntimePrivileges},{verifyM2RuntimePrivileges}]=await Promise.all([import('/app/backend/dist/config.js'),import('/app/backend/dist/db/open.js'),import('/app/backend/dist/db/migrate.js'),import('/app/backend/scripts/records-runtime-privileges.mjs'),import('/app/backend/scripts/m2-runtime-privileges.mjs')]);
 const config=loadConfig(),target=new URL(config.databaseUrl);
 if(target.hostname!==review.target.host||decodeURIComponent(target.pathname.slice(1))!==review.target.database||target.port&&target.port!=='5432'||config.migrateOnStart!==false||config.processRole!==kind)throw Error('RECONSTRUCTION_RUNTIME_TARGET_MISMATCH');
 // This task only measures admission. Feature activation and installed/pilot
 // qualification remain separately owned release gates.
 const inventory=await migrationInventory(),records=await recordsMigrationInventory(117);
 if(records.migrationSha256!==review.recordsMigrationSha256)throw Error('RECONSTRUCTION_RECORDS_SOURCE_MISMATCH');
 const opened=await openDatabase(config);
 try{
  if(opened.engine!=='postgres')throw Error('RECONSTRUCTION_POSTGRES_REQUIRED');
  return await opened.db.transaction(async db=>{
   await db.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');await db.query("SET LOCAL statement_timeout='30s'");
   const identity=(await db.query("SELECT current_user AS role,session_user AS login,current_database() AS database,current_schema() AS schema,current_setting('transaction_read_only') AS read_only")).rows[0];
   const tls=(await db.query('SELECT ssl,version FROM pg_stat_ssl WHERE pid=pg_backend_pid()')).rows[0],expected=kind==='api'?review.apiRole:review.workerRole;
   if(identity?.role!==expected||identity.login!==expected||identity.database!==review.target.database||identity.schema!=='public'||identity.read_only!=='on'||!tls?.ssl)throw Error('RECONSTRUCTION_RUNTIME_IDENTITY_TLS_MISMATCH');
   await assertSchemaCurrent(db);
   const applied=(await db.query('SELECT id,checksum FROM schema_migrations ORDER BY id')).rows;
   const sourceInventory=inspectReconstructionInventory(inventory,applied,review);
   const unsafe=(await db.query(`SELECT pg_has_role(current_user,$1,'MEMBER') OR pg_has_role(current_user,$1,'SET') OR has_table_privilege(current_user,'schema_migrations','INSERT,UPDATE,DELETE') OR has_table_privilege(current_user,'user_system_roles','INSERT,UPDATE,DELETE') AS allowed`,[review.ownerRole])).rows[0];
   if(!unsafe||unsafe.allowed)throw Error('RECONSTRUCTION_RUNTIME_AUTHORITY_UNSAFE');
   const privileges=await verifyRecordsRuntimePrivileges(db,{runtimeRole:review.apiRole,workerRole:review.workerRole,schema:'public',reviewedSourceCommit:review.source,reviewedMigrationSha256:records.migrationSha256,throughMigration:117});
   const platformLockRows=(await db.query(`SELECT role,table_name AS table,has_column_privilege(role,format('%I.%I',current_schema(),table_name),'id','UPDATE') AS allowed,has_column_privilege(role,format('%I.%I',current_schema(),table_name),'id','UPDATE WITH GRANT OPTION') AS grantable FROM unnest($1::text[]) roles(role) CROSS JOIN (VALUES ('platform_memberships'),('proofs')) locks(table_name) ORDER BY role,table_name`,[[review.apiRole,review.workerRole]])).rows;
   const platformLocks=inspectReconstructionPlatformLocks(platformLockRows,review);
   const m2=await verifyM2RuntimePrivileges(db,{apiRole:review.apiRole,workerRole:review.workerRole});
   const policy=(await db.query('SELECT durability_required FROM policy_recovery_fence WHERE singleton=1')).rows[0];
   if(!policy||policy.durability_required!==(config.requireDurableReceipts===true))throw Error('RECONSTRUCTION_DURABILITY_CONFIGURATION_MISMATCH');
   return {schema:'packproof.reconstruction-runtime-preflight/v3',reviewSha256,source:review.source,kind,taskIdentity,readOnly:true,identity,tls:{ssl:tls.ssl,version:tls.version},sourceInventory,recordsPrivileges:privileges,platformLocks,m2PrivilegesSha256:reconstructionDigest(m2),durabilityPolicyMatches:true,customerReleaseQualified:false,completedAt:new Date().toISOString()};
  });
 }finally{await opened.close();}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href)runReconstructionPreflight(process.argv[2]).then(receipt=>console.log(JSON.stringify(receipt))).catch(error=>{console.error(JSON.stringify({event:'reconstruction_runtime_preflight_failed',code:/^[A-Z][A-Z0-9_]{2,80}$/.test(error?.message??'')?error.message:'RECONSTRUCTION_PREFLIGHT_REVIEW_REQUIRED'}));process.exitCode=1;});
