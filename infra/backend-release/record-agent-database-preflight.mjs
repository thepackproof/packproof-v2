// One-shot actual-role admission. Launch separately with API and worker secret
// references. This file performs no DDL, grants, role changes or application work.
import {createHash} from 'node:crypto';
import {readFile} from 'node:fs/promises';
const hash=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
let opened;
try{
 const [kind]=process.argv.slice(2);
 const review=JSON.parse(process.env.PACKPROOF_AGENT_REVIEW_JSON??'{}');
 const {source,apiRole,workerRole}=review;
 if(process.argv.length!==3||!/^[a-f0-9]{40}$/.test(source??'')||!['api','worker'].includes(kind)||![apiRole,workerRole].every(role=>/^[a-z][a-z0-9_]{0,62}$/.test(role??''))||apiRole===workerRole||process.env.PACKPROOF_RELEASE_SHA!==source)throw Error('RECORDS_PREFLIGHT_BINDING_REQUIRED');
 const [{loadConfig},{openDatabase},{migrationInventory,assertSchemaCurrent},{inspectAgentMigrationInventory},{validateAgentReview,agentDigest,agentTaskIdentity},{recordsMigrationInventory,verifyRecordsRuntimePrivileges},{verifyM2RuntimePrivileges},{verifyRecordAgentSchemaCatalog}]=await Promise.all([
  import('/app/backend/dist/config.js'),import('/app/backend/dist/db/open.js'),import('/app/backend/dist/db/migrate.js'),import('/app/backend/scripts/record-agent-migration-inventory.mjs'),import('/app/backend/scripts/record-agent-migrate.mjs'),import('/app/backend/scripts/records-runtime-privileges.mjs'),import('/app/backend/scripts/m2-runtime-privileges.mjs'),import('/app/backend/scripts/record-agent-schema.mjs')]);
 if(validateAgentReview(review)!==process.env.PACKPROOF_AGENT_REVIEW_SHA256)throw Error('AGENT_REVIEWED_TARGET_REQUIRED');
 const taskIdentity=await agentTaskIdentity(process.env,review,review.candidateImage);
 const config=loadConfig(),target=new URL(config.databaseUrl);
 if(target.hostname!==review.target.host||decodeURIComponent(target.pathname.slice(1))!==review.target.database||target.port&&target.port!=='5432')throw Error('AGENT_PREFLIGHT_TARGET_MISMATCH');
 if(config.migrateOnStart!==false||config.release.environment!=='staging'||config.processRole!==kind)throw Error('RECORDS_PREFLIGHT_RUNTIME_REQUIRED');
 const inventory=await migrationInventory(),sourceInventory=inspectAgentMigrationInventory(inventory,inventory,{reviewedSourceCommit:source,reviewedInventorySha256:review.inventorySha256}),records=await recordsMigrationInventory();
 await readFile('/app/backend/certs/rds-us-east-1-bundle.pem');
 opened=await openDatabase(config);if(opened.engine!=='postgres')throw Error('RECORDS_POSTGRES_REQUIRED');
 const receipt=await opened.db.transaction(async db=>{
  await db.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');await db.query("SET LOCAL statement_timeout='30s'");
  const identity=(await db.query("SELECT current_user AS role,session_user AS login,current_database() AS database,current_schema() AS schema,current_setting('transaction_read_only') AS read_only")).rows[0];
  const tls=(await db.query('SELECT ssl,version FROM pg_stat_ssl WHERE pid=pg_backend_pid()')).rows[0],expected=kind==='api'?apiRole:workerRole;
  if(identity?.role!==expected||identity.login!==expected||identity.database!==review.target.database||identity.schema!=='public'||identity.read_only!=='on'||!tls?.ssl)throw Error('RECORDS_RUNTIME_IDENTITY_TLS_MISMATCH');
  await assertSchemaCurrent(db);
  const agentSchemaSha256=await verifyRecordAgentSchemaCatalog(db);
  const applied=(await db.query('SELECT id,checksum FROM schema_migrations ORDER BY id')).rows;
  if(inspectAgentMigrationInventory(inventory,applied,{reviewedSourceCommit:source,reviewedInventorySha256:review.inventorySha256}).pending)throw Error('RECORDS_MIGRATIONS_REQUIRED');
  const unsafe=(await db.query(`SELECT r.rolsuper OR r.rolcreatedb OR r.rolcreaterole OR r.rolreplication OR r.rolbypassrls OR
   pg_has_role(current_user,$1,'MEMBER') OR pg_has_role(current_user,$1,'SET') OR has_schema_privilege(current_user,'public','CREATE') OR
   has_table_privilege(current_user,'schema_migrations','INSERT,UPDATE,DELETE') OR has_table_privilege(current_user,'user_system_roles','INSERT,UPDATE,DELETE') AS allowed
   FROM pg_roles r WHERE r.rolname=current_user`,[review.ownerRole])).rows[0];
  if(!unsafe||unsafe.allowed)throw Error('RECORDS_RUNTIME_AUTHORITY_UNSAFE');
  const privileges=await verifyRecordsRuntimePrivileges(db,{runtimeRole:apiRole,workerRole,schema:'public',reviewedSourceCommit:source,reviewedMigrationSha256:records.migrationSha256});
  const m2=await verifyM2RuntimePrivileges(db,{apiRole,workerRole});
  const policy=(await db.query('SELECT durability_required FROM policy_recovery_fence WHERE singleton=1')).rows[0];
  if(!policy||policy.durability_required!==(config.requireDurableReceipts===true))throw Error('RECORDS_DURABILITY_CONFIGURATION_MISMATCH');
  return {schema:'packproof.record-agent-runtime-preflight/v1',reviewSha256:agentDigest(review),source,kind,taskIdentity,agentSchemaSha256,readOnly:true,identity,tls:{ssl:tls.ssl,version:tls.version},sourceMigrationCount:inventory.length,appliedMigrationCount:applied.length,sourceInventorySha256:sourceInventory.inventorySha256,recordsPrivileges:privileges,m2PrivilegesSha256:hash(m2),durabilityPolicyMatches:true};
 });
 console.log(JSON.stringify({event:'record_agent_runtime_preflight',...receipt}));
}catch(error){
 const code=/^[A-Z][A-Z0-9_]{2,80}$/.test(error?.message??'')?error.message:'RECORDS_PREFLIGHT_REVIEW_REQUIRED';
 console.error(JSON.stringify({event:'record_agent_runtime_preflight_failed',code}));process.exitCode=1;
}finally{await opened?.close();}
