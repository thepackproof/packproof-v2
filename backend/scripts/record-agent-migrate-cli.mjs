// Secrets are injected into this one-shot owner task at launch; no secret,
// connection URL, raw database error, or environment dump enters its receipts.
import {pathToFileURL} from 'node:url';
import {agentDigest,agentManifest,agentTaskIdentity,agentInspection,validateAgentReview,validateAgentRehearsal,inspectAgentState,applyAgentInTransaction,planAgentRuntimePrivilegeDelta} from './record-agent-migrate.mjs';
const fail=code=>{throw Error(code);};
const parse=(value,code)=>{try{return JSON.parse(value??'');}catch{fail(code);}};
export function agentOperatorConfiguration(mode,env){
 if(!['--inspect','--rehearse','--apply','--plan-roles','--rehearse-roles','--apply-roles'].includes(mode))fail('AGENT_OPERATOR_MODE_REQUIRED');
 const review=parse(env.PACKPROOF_AGENT_REVIEW_JSON,'AGENT_RELEASE_REVIEW_REQUIRED'),reviewSha256=validateAgentReview(review);
 if(env.PACKPROOF_AGENT_REVIEW_SHA256!==reviewSha256||env.PACKPROOF_RELEASE_SHA!==review.source||env.PACKPROOF_AGENT_CANDIDATE_IMAGE_DIGEST!==review.candidateImage)fail('AGENT_OPERATOR_SOURCE_IMAGE_MISMATCH');
 if(env.PACKPROOF_OPERATOR_PURPOSE!=='record-agent-isolated-staging-preparation'||env.PACKPROOF_ENVIRONMENT!=='staging'||env.PACKPROOF_MIGRATE_ON_START!=='false'||env.PACKPROOF_ORGANIZATIONS_ENABLED!=='false'||env.PACKPROOF_CLAIM_EXPORTS_ENABLED!=='false'||env.DATABASE_URL||env.PACKPROOF_DB_SECRET_ARN||Object.keys(env).some(key=>key.startsWith('PG')&&env[key]))fail('AGENT_ISOLATED_OWNER_CONFIGURATION_REQUIRED');
 const rehearsal=mode==='--rehearse',target=rehearsal?review.restored:review.target;
 if(env.PACKPROOF_DB_HOST!==target.host||env.PACKPROOF_DB_NAME!==target.database||env.PACKPROOF_DB_USER!==review.ownerRole||!env.PACKPROOF_DB_PASSWORD||env.PACKPROOF_DB_PORT&&env.PACKPROOF_DB_PORT!=='5432'||env.PACKPROOF_DB_SSLMODE!=='verify-full')fail('AGENT_OWNER_DATABASE_TARGET_MISMATCH');
 if(mode==='--apply')validateAgentRehearsal(parse(env.PACKPROOF_AGENT_REHEARSAL_JSON,'AGENT_REHEARSAL_REQUIRED'),review);
 return {review,reviewSha256,target};
}
export async function runAgentOperator(mode,env){
 const {review,reviewSha256,target}=agentOperatorConfiguration(mode,env);
 const taskIdentity=await agentTaskIdentity(env,review,review.candidateImage);
 const [{composeDatabaseUrl},{createPgDatabase},{migrationInventory},{splitSqlStatements}]=await Promise.all([import('../dist/config.js'),import('../dist/db/postgres.js'),import('../dist/db/migrate.js'),import('../dist/db/sql.js')]);
 const opened=createPgDatabase(composeDatabaseUrl(env),undefined,env);
 try{
  const inventory=await migrationInventory();
  const identity=async tx=>{
   const row=(await tx.query('SELECT current_user AS role,session_user AS login,current_database() AS database,current_schema() AS schema')).rows[0];
   const tls=(await tx.query('SELECT ssl,version FROM pg_stat_ssl WHERE pid=pg_backend_pid()')).rows[0];
   if(row?.role!==review.ownerRole||row.login!==review.ownerRole||row.database!==target.database||row.schema!=='public'||!tls?.ssl)fail('AGENT_OWNER_IDENTITY_TLS_MISMATCH');
  };
  const before=await opened.db.transaction(async tx=>{await tx.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');await identity(tx);return inspectAgentState(tx,inventory,review);});
  const inspection=agentInspection(before,review);
  if(mode==='--inspect'){console.log(JSON.stringify({event:'record_agent_migration_inspected',inspection}));return inspection;}
  if(mode.endsWith('-roles')){
   if(before.pending)fail('AGENT_SCHEMA_REQUIRED_BEFORE_ROLE_DELTA');
   const plan=await opened.db.transaction(async tx=>{await tx.query('SET TRANSACTION READ ONLY');await identity(tx);return planAgentRuntimePrivilegeDelta(tx,review);});
   if(mode==='--plan-roles'){console.log(JSON.stringify({event:'record_agent_roles_planned',plan}));return plan;}
   if(env.PACKPROOF_AGENT_ROLE_PLAN_SHA256!==plan.statementsSha256)fail('AGENT_REVIEWED_ROLE_PLAN_REQUIRED');
   if(mode==='--apply-roles'){
    const report=parse(env.PACKPROOF_AGENT_ROLE_REHEARSAL_JSON,'AGENT_ROLE_REHEARSAL_REQUIRED'),{sha256,...body}=report;
    const age=Date.now()-Date.parse(body.completedAt);
    if(sha256!==agentDigest(body)||body.schema!=='packproof.record-agent-role-rehearsal/v1'||body.reviewSha256!==reviewSha256||body.statementsSha256!==plan.statementsSha256||body.targetHost!==target.host||body.targetDatabase!==target.database||body.baselineDataSha256!==before.baselineDataSha256||body.baselineCatalogSha256!==before.baselineCatalogSha256||body.baselineAuthoritySha256!==before.baselineAuthoritySha256||!Number.isFinite(age)||age<0||age>900000)fail('AGENT_ROLE_REHEARSAL_BINDING_MISMATCH');
   }
   const rollback=Error('AGENT_ROLE_REHEARSAL_ROLLBACK');
   try{await opened.db.transaction(async tx=>{
    await identity(tx);await tx.query("SET LOCAL lock_timeout='15s'");await tx.query("SET LOCAL statement_timeout='30s'");await tx.query('SELECT pg_advisory_xact_lock(1347438146,1)');
    await tx.query(`LOCK TABLE ${before.tables.map(name=>'\"'+name+'\"').join(',')} IN SHARE ROW EXCLUSIVE MODE`);
    const current=await inspectAgentState(tx,inventory,review);if(agentDigest(current)!==agentDigest(before))fail('AGENT_INSPECTION_STATE_CHANGED');
    const currentPlan=await planAgentRuntimePrivilegeDelta(tx,review);if(currentPlan.statementsSha256!==plan.statementsSha256)fail('AGENT_REVIEWED_ROLE_PLAN_REQUIRED');
    for(const sql of plan.statements)await tx.query(sql);
    const after=await inspectAgentState(tx,inventory,review);
    for(const key of ['baselineDataSha256','baselineCatalogSha256','baselineAuthoritySha256'])if(after[key]!==before[key])fail('AGENT_BASELINE_PRESERVATION_MISMATCH');
    if(mode==='--rehearse-roles')throw rollback;
   });}catch(error){if(error!==rollback)throw error;}
   const body={taskArn:taskIdentity.taskArn,image:taskIdentity.image,schema:mode==='--rehearse-roles'?'packproof.record-agent-role-rehearsal/v1':'packproof.record-agent-role-application/v1',reviewSha256,source:review.source,targetHost:target.host,targetDatabase:target.database,statementsSha256:plan.statementsSha256,completedAt:new Date().toISOString(),baselineDataSha256:before.baselineDataSha256,baselineCatalogSha256:before.baselineCatalogSha256,baselineAuthoritySha256:before.baselineAuthoritySha256,rolesCreated:false,featureActivation:false,actualRuntimeLoginPreflightRequired:true};
   const report={...body,sha256:agentDigest(body)};console.log(JSON.stringify({event:mode==='--rehearse-roles'?'record_agent_role_delta_rehearsed':'record_agent_role_delta_applied',report}));return report;
  }
  let receipt=inspection;
  if(mode==='--apply'){
   receipt=parse(env.PACKPROOF_AGENT_INSPECTION_JSON,'AGENT_INSPECTION_REQUIRED');
   if(receipt.sha256!==env.PACKPROOF_AGENT_INSPECTION_SHA256)fail('AGENT_INSPECTION_BINDING_MISMATCH');
  }
  const after=await opened.db.transaction(async tx=>{await identity(tx);return applyAgentInTransaction(tx,inventory,receipt,review,{splitSqlStatements});});
  const body={taskArn:taskIdentity.taskArn,image:taskIdentity.image,schema:'packproof.record-agent-migration-application/v1',reviewSha256,source:review.source,candidateImage:review.candidateImage,previousSource:review.previousSource,previousImage:review.previousImage,targetHost:target.host,targetDatabase:target.database,completedAt:new Date().toISOString(),inventorySha256:agentManifest.inventorySha256,appliedCount:after.appliedCount,alreadyApplied:after.alreadyApplied,baselinePreserved:true,runtimeAuthorityPreserved:true,baselineDataSha256:after.baselineDataSha256,baselineCatalogSha256:after.baselineCatalogSha256,baselineAuthoritySha256:after.baselineAuthoritySha256,rolesChanged:false,featureActivation:false,rehearsal:mode==='--rehearse'};
  const report={...body,sha256:agentDigest(body)};console.log(JSON.stringify({event:mode==='--rehearse'?'record_agent_restored_migration_applied':'record_agent_migration_applied',report}));return report;
 }finally{await opened.close();}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href)runAgentOperator(process.argv[2],process.env).catch(error=>{
 const reason=/^[A-Z][A-Z0-9_]{2,80}$/.test(error?.message??'')?error.message:'DATABASE_OPERATION_FAILED';
 const sqlState=/^[0-9A-Z]{5}$/.test(error?.code??'')?error.code:undefined;
 console.error(JSON.stringify({event:'record_agent_operator_failed',reason,sqlState}));process.exitCode=1;
});
