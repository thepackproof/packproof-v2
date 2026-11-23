import {pathToFileURL} from 'node:url';
import {executeHostedOwner} from './connect-hosted-migration.mjs';
import {hostedCollectorTarget as target,
  reconstructionDigest as digest,verifyBackfillScopeGuard} from './reconstruction-v11-release-review.mjs';

const collectorInventory='8ab67cf9cc721d6da4c28cef72fdcdaf2b08faaa86196d76acff0a4f95f97fcc';
export const recoveryInventory='13f05713808a4c077b9388d5609d99ad1bfa16b9ded82b2e447bc1c076d5896e';
export const recoveryReviewSchema='packproof.hosted-recovery-migration/v1';
export const recoveryReceiptSchema='packproof.hosted-recovery-owner-receipt/v1';
const imagePrefix=target.repository+'@sha256:';
const allowedImage=value=>typeof value==='string' && value.startsWith(imagePrefix) && /^[a-f0-9]{64}$/.test(value.slice(imagePrefix.length));
const knownLedger=hash=>hash===collectorInventory || hash===recoveryInventory;
const taskPrefix=target.clusterArn.replace(':cluster/',':task/')+'/';
const check=(ok,code)=>{if(!ok)throw Error('CONNECT_RECOVERY_OWNER_'+code);};
const entries=rows=>rows.map(({id,checksum})=>({id,checksum}));
const ledger=async tx=>(await tx.query('SELECT id,checksum,applied_at::text,checksum_provenance FROM schema_migrations ORDER BY id')).rows;
const changedTables=['partner_import_jobs','record_agent_installations','record_locations'];

export function validateRecoveryOwnerReview(review,hash,mode,env,now=new Date()){
  check(['inspect','rehearse','apply'].includes(mode) && review?.schema===recoveryReviewSchema &&
    digest(review)===hash && /^[a-f0-9]{40}$/.test(review.source) && review.source===env.PACKPROOF_RELEASE_SHA &&
    allowedImage(review.candidateImage) && env.PACKPROOF_RELEASE_IMAGE===review.candidateImage &&
    allowedImage(review.bridgeImage) && review.bridgeImage!==review.candidateImage &&
    review.clusterArn===target.clusterArn && review.target?.host===target.host && review.target.database===target.database &&
    review.inventorySha256===recoveryInventory && env.PACKPROOF_MIGRATE_ON_START==='false' &&
    env.PACKPROOF_ORDER_WORKSPACE_ENABLED==='false','REVIEW_BINDING');
  check(review.ownerRole==='packproof' && review.apiRole==='packproof_records_api_v1' &&
    review.workerRole==='packproof_records_worker_v1','ROLES');
  const remaining=Date.parse(review.expiresAt)-now.getTime();
  check(remaining>0 && remaining<=2*3600000,'REVIEW_EXPIRED');
  if(mode==='inspect')return;
  check(knownLedger(review.expectedLedger),'PREDECESSOR_REVIEW');
  if(mode==='apply'){
    const r=JSON.parse(env.PACKPROOF_HOSTED_MIGRATION_REHEARSAL_JSON||'null');
    const age=now.getTime()-Date.parse(r?.completedAt);
    check(r?.schema===recoveryReceiptSchema && r.mode==='rehearse' && r.reviewSha256===hash &&
      r.source===review.source && r.image===review.candidateImage && r.targetHost===target.host &&
      typeof r.actualTask==='string' && r.actualTask.startsWith(taskPrefix) && /^[a-f0-9]{32}$/.test(r.actualTask.slice(taskPrefix.length)) &&
      r.initialLedger===review.expectedLedger && r.finalLedger===recoveryInventory && r.rolledBack===true &&
      age>=0 && age<=2*3600000,'REHEARSAL_REQUIRED');
  }
}

function policyFor(through,source,review,schema){
  const subset=source.filter(row=>Number(row.id.slice(0,3))>=96 && Number(row.id.slice(0,3))<=through);
  return {runtimeRole:review.apiRole,workerRole:review.workerRole,schema,throughMigration:through,
    reviewedSourceCommit:review.source,reviewedMigrationSha256:digest(Object.fromEntries(subset.map(row=>[row.id,row.checksum])))};
}

export async function runRecoveryOwnerTransaction(tx,review,mode,deps,schema='public'){
  check(['inspect','rehearse','apply'].includes(mode) && review.inventorySha256===recoveryInventory,'MODE_OR_CATALOGUE');
  const source=await deps.migrationInventory();
  check(source.length===129 && digest(entries(source))===recoveryInventory &&
    digest(entries(source.slice(0,128)))===collectorInventory && source.every(row=>typeof row.sql==='string' && digest(row.sql)===row.checksum),
    'SOURCE_INVENTORY');
  await tx.query(mode==='inspect'?'SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY':'SET TRANSACTION ISOLATION LEVEL REPEATABLE READ');
  await tx.query("SET LOCAL statement_timeout='120s'");
  if(mode!=='inspect'){
    await tx.query("SET LOCAL lock_timeout='10s'");
    await tx.query('SELECT pg_advisory_xact_lock(1347438146,1)');
  }
  const identity=(await tx.query(`SELECT current_user AS role,session_user AS login,current_schema() AS schema,
    current_database() AS database,current_setting('server_version_num')::int AS version`)).rows[0];
  check(identity?.role===review.ownerRole && identity.login===identity.role && identity.schema===schema &&
    identity.database===review.target.database && identity.version>=160000 && identity.version<170000,'POSTGRES_OWNER');
  const before=await ledger(tx), initialLedger=digest(entries(before));
  check(knownLedger(initialLedger) && (mode==='inspect'||initialLedger===review.expectedLedger||initialLedger===recoveryInventory && review.expectedLedger===collectorInventory),
    'PREDECESSOR_CHANGED');
  const through=initialLedger===collectorInventory?129:130;
  const applied=[], final=source.at(-1);
  await verifyBackfillScopeGuard(tx,through===129?source.find(row=>row.id==='129_unified_collector_version').sql:final.sql);
  const initialPolicy=await deps.verifyPlannedRecordsPrivileges(tx,policyFor(through,source,review,schema));
  const receipt={initialLedger,through,applied,grantStatementCount:0,policySha256:initialPolicy.policySha256,finalLedger:initialLedger};
  if(mode==='inspect'||through===130)return receipt;

  for(const migration of source.slice(128)){
    for(const statement of deps.splitSqlStatements(migration.sql))await tx.query(statement);
    await tx.query("INSERT INTO schema_migrations(id,applied_at,checksum,checksum_provenance) VALUES($1,now(),$2,'EXECUTED_BYTES')",[migration.id,migration.checksum]);
    applied.push(migration.id);
  }
  const newRelations=changedTables;
  const publicOrForeign=await tx.query(`SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    CROSS JOIN LATERAL aclexplode(c.relacl) a LEFT JOIN pg_roles r ON r.oid=a.grantee
    WHERE n.nspname=$1 AND c.relname=ANY($2::text[]) AND a.grantee<>c.relowner AND
      (r.rolname IS NULL OR NOT(r.rolname=ANY($3::text[]))) LIMIT 1`,[schema,newRelations,[review.apiRole,review.workerRole]]);
  check(publicOrForeign.rows.length===0,'UNREVIEWED_DEFAULT_GRANTS');
  const selected=policyFor(130,source,review,schema);
  const plan=await deps.planRecordsRuntimePrivileges(tx,selected);
  const touched=new Set();
  const grants=plan.statements.filter(sql=>{
    const relation=sql.match(/ ON TABLE "([a-z0-9_]+)"\."([a-z0-9_]+)" (?:FROM|TO) /);
    if(!relation||relation[1]!==schema||!changedTables.includes(relation[2]))return false;
    touched.add(relation[2]);return true;
  });
  check(touched.size===changedTables.length,'ACL_DELTA_INCOMPLETE');
  for(const statement of grants)await tx.query(statement);
  const after=await ledger(tx);
  check(digest(entries(after))===recoveryInventory && digest(after.slice(0,before.length))===digest(before) &&
    after.slice(before.length).every(r=>r.checksum_provenance==='EXECUTED_BYTES'),'HISTORICAL_RECEIPTS_CHANGED');
  await verifyBackfillScopeGuard(tx,final.sql);
  const verified=await deps.verifyPlannedRecordsPrivileges(tx,selected);
  return {...receipt,finalLedger:recoveryInventory,grantStatementCount:grants.length,
    grantStatementsSha256:digest(grants),policySha256:verified.policySha256};
}

if(process.argv[1] && import.meta.url===pathToFileURL(process.argv[1]).href){
  executeHostedOwner({validateReview:validateRecoveryOwnerReview,transaction:runRecoveryOwnerTransaction,receiptSchema:recoveryReceiptSchema})
    .catch(error=>{console.error(/^[A-Z0-9_]+$/.test(error?.message)?error.message:'CONNECT_RECOVERY_OWNER_OPERATION_FAILED');process.exitCode=1;});
}
