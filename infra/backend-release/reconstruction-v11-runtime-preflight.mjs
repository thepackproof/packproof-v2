// Explicit actual-role, read-only candidate admission. Requires an independently
// migrated/approved isolated target; it cannot apply schema, grants or rollout.
import {pathToFileURL} from 'node:url';
import {readShipmentAutomationPolicy} from './shipment-automation-pair.mjs';
import {reconstructionDigest,validateReconstructionReview,validateHostedCollectorReview,inspectReconstructionInventory,validateReconstructionTaskMetadata,verifyBackfillScopeGuard,verifyOrderHistoryGuards,collectorMigration,collectorGrants} from './reconstruction-v11-release-review.mjs';
import {verifyHostedMembershipLocks} from './hosted-membership-locks.mjs';
import {verifyShipmentInterpretationGuard} from './reconstruction-v7-runtime-preflight.mjs';
export function runReconstructionPreflight(kind,env=process.env) {
 return measureCollector(kind,env,'v11',validateReconstructionReview);
}
export function runHostedCollectorPreflight(kind,env=process.env) {
 return measureCollector(kind,env,'v11-hosted',validateHostedCollectorReview);
}
async function measureCollector(kind,env,version,validateReview) {
 if(!['api','worker'].includes(kind))throw Error('RECONSTRUCTION_PROCESS_ROLE_REQUIRED');
 const binding='PACKPROOF_RECONSTRUCTION_'+version.toUpperCase().replace('-','_')+'_REVIEW';
 let review;try{review=JSON.parse(env[binding+'_JSON']??'');}catch{throw Error('RECONSTRUCTION_REVIEW_BINDING_REQUIRED');}
 const reviewSha256=validateReview(review,env[binding+'_SHA256'],env.PACKPROOF_RELEASE_SHA);
 let endpoint;try{endpoint=new URL(env.ECS_CONTAINER_METADATA_URI_V4);}catch{throw Error('RECONSTRUCTION_TASK_METADATA_REQUIRED');}
 if(endpoint.protocol!=='http:'||endpoint.hostname!=='169.254.170.2'||endpoint.port||endpoint.username||endpoint.password||endpoint.search||endpoint.hash||!/^\/v4\/[a-zA-Z0-9_-]+$/.test(endpoint.pathname))throw Error('RECONSTRUCTION_TASK_METADATA_REQUIRED');
 const metadata=async suffix=>{const response=await fetch(endpoint.href+suffix,{signal:AbortSignal.timeout(5000)});if(!response.ok)throw Error('RECONSTRUCTION_TASK_METADATA_UNAVAILABLE');return response.json();};
 const [container,task]=await Promise.all([metadata(''),metadata('/task')]);
 const taskIdentity=validateReconstructionTaskMetadata(container,task,review);
 if(env.PACKPROOF_RELEASE_IMAGE!==taskIdentity.image)throw Error('RECONSTRUCTION_RUNTIME_IMAGE_MISMATCH');
 const automationPolicy=await readShipmentAutomationPolicy(kind,env);
 if(automationPolicy.bundleSha256!==review.automationPolicy.bundleSha256)throw Error('AUTOMATION_BUILT_POLICY_MISMATCH');
 const [{loadConfig},{openDatabase},{migrationInventory,assertSchemaCurrent},{recordsMigrationInventory,verifyRecordsRuntimePrivileges},{verifyM2RuntimePrivileges}]=await Promise.all([import('/app/backend/dist/config.js'),import('/app/backend/dist/db/open.js'),import('/app/backend/dist/db/migrate.js'),import('/app/backend/scripts/records-runtime-privileges.mjs'),import('/app/backend/scripts/m2-runtime-privileges.mjs')]);
 const config=loadConfig(),target=new URL(config.databaseUrl);
 if(target.hostname!==review.target.host||decodeURIComponent(target.pathname.slice(1))!==review.target.database||target.port&&target.port!=='5432'||config.migrateOnStart!==false||config.processRole!==kind)throw Error('RECONSTRUCTION_RUNTIME_TARGET_MISMATCH');
 // This task only measures admission. Feature activation and installed/pilot
 // qualification remain separately owned release gates.
 const {supportsOrderWorkspace,supportsSourceBackfills,typedCollectorVersionSupported,reconstructionFeatureEnabled}=await import('/app/backend/dist/records/reconstruction-features.js');
 const backfillJobsEnabled=reconstructionFeatureEnabled('sourceBackfillJobs');
 const orderWorkspaceEnabled=reconstructionFeatureEnabled('orderWorkspace');
 if(orderWorkspaceEnabled!==review.orderWorkspaceEnabled||!supportsSourceBackfills('0.5.0')||backfillJobsEnabled!==review.backfillJobsEnabled||!supportsSourceBackfills('0.4.0')||!supportsSourceBackfills('0.4.1')||supportsSourceBackfills('0.4.2'))
  throw Error('BACKFILL_BUILT_POLICY_MISMATCH');
 const supported = ['0.5.0', '0.6.0'].every(version => supportsOrderWorkspace(version) && supportsSourceBackfills(version) &&
   typedCollectorVersionSupported(version, 'packproof.typed-source-batch/v1') && typedCollectorVersionSupported(version, 'packproof.typed-source-batch/v2'));
 if (!supported || supportsOrderWorkspace('0.4.1') || supportsOrderWorkspace('0.6.1') || supportsSourceBackfills('0.6.1') ||
     typedCollectorVersionSupported('0.6.1', 'packproof.typed-source-batch/v2')) throw Error('COLLECTOR_BUILT_POLICY_MISMATCH');
 const inventory=await migrationInventory(),records=await recordsMigrationInventory(124);
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
   await verifyShipmentInterpretationGuard(db,inventory.find(row=>row.id==='121_shipment_interpretation_decisions').sql);
   await verifyBackfillScopeGuard(db,inventory.find(row=>row.id===collectorMigration.id).sql);
   await verifyOrderHistoryGuards(db);
   const unsafe=(await db.query(`SELECT pg_has_role(current_user,$1,'MEMBER') OR pg_has_role(current_user,$1,'SET') OR has_table_privilege(current_user,'schema_migrations','INSERT,UPDATE,DELETE') OR has_table_privilege(current_user,'user_system_roles','INSERT,UPDATE,DELETE') AS allowed`,[review.ownerRole])).rows[0];
   if(!unsafe||unsafe.allowed)throw Error('RECONSTRUCTION_RUNTIME_AUTHORITY_UNSAFE');
   const privileges=await verifyRecordsRuntimePrivileges(db,{runtimeRole:review.apiRole,workerRole:review.workerRole,schema:'public',reviewedSourceCommit:review.source,reviewedMigrationSha256:records.migrationSha256,throughMigration:124});
   if (privileges.policySha256 !== collectorGrants) throw Error('RECONSTRUCTION_COLLECTOR_GRANTS_MISMATCH');
   const platformLocks=await verifyHostedMembershipLocks(db,{kind,apiRole:review.apiRole,workerRole:review.workerRole});
   const m2=await verifyM2RuntimePrivileges(db,{apiRole:review.apiRole,workerRole:review.workerRole});
   const policy=(await db.query('SELECT durability_required FROM policy_recovery_fence WHERE singleton=1')).rows[0];
   if(!policy||policy.durability_required!==(config.requireDurableReceipts===true))throw Error('RECONSTRUCTION_DURABILITY_CONFIGURATION_MISMATCH');
   return {schema:'packproof.reconstruction-runtime-preflight/'+version,reviewSha256,source:review.source,kind,taskIdentity,automationPolicy,collectorVersionVerified:true,immutableTriggerVerified:true,backfillScopeVerified:true,orderHistoryGuardsVerified:true,orderWorkspaceEnabled,backfillJobsEnabled,readOnly:true,identity,tls:{ssl:tls.ssl,version:tls.version},sourceInventory,recordsPrivileges:privileges,platformLocks,m2PrivilegesSha256:reconstructionDigest(m2),durabilityPolicyMatches:true,customerReleaseQualified:false,completedAt:new Date().toISOString()};
  });
 }finally{await opened.close();}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href)runReconstructionPreflight(process.argv[2]).then(receipt=>console.log(JSON.stringify(receipt))).catch(error=>{console.error(JSON.stringify({event:'reconstruction_runtime_preflight_failed',code:/^[A-Z][A-Z0-9_]{2,80}$/.test(error?.message??'')?error.message:'RECONSTRUCTION_PREFLIGHT_REVIEW_REQUIRED'}));process.exitCode=1;});
