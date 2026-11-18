import {pathToFileURL} from 'node:url';
import {applyRestoredDelta} from './order-workspace-restored-rehearsal.mjs';
import {backfillMigrationInventorySha256} from './reconstruction-v8-release-review.mjs';
import {workspaceInventory,workspaceMigration} from './reconstruction-v10-release-review.mjs';
import {collectorInventory,collectorMigration,hostedCollectorTarget as target,inspectReconstructionInventory,
  reconstructionDigest as digest,validateReconstructionTaskMetadata,verifyBackfillScopeGuard} from './reconstruction-v11-release-review.mjs';

const ledgers = new Map([[backfillMigrationInventorySha256,122],[workspaceInventory,123],[collectorInventory,124]]);
const check = (condition,reason) => { if (!condition) throw Error('HOSTED_COLLECTOR_'+reason); };
const rows = async db => (await db.query('SELECT id,checksum FROM schema_migrations ORDER BY id')).rows;
const entries = list => list.map(({id,checksum}) => ({id,checksum}));
const imagePattern = /^784514617543\.dkr\.ecr\.us-east-1\.amazonaws\.com\/packproof-v2-staging-api@sha256:[0-9a-f]{64}$/;
export function validateOwnerReview(review, hash, mode, env, now=new Date()) {
  check(['inspect','rehearse','apply'].includes(mode) && review?.schema==='packproof.hosted-collector-migration/v1' &&
    digest(review)===hash && /^[a-f0-9]{40}$/.test(review.source) && env.PACKPROOF_RELEASE_SHA===review.source &&
    imagePattern.test(review.candidateImage) && env.PACKPROOF_RELEASE_IMAGE===review.candidateImage &&
    review.clusterArn===target.clusterArn && review.target?.host===target.host && review.target.database===target.database &&
    review.inventorySha256===collectorInventory && env.PACKPROOF_MIGRATE_ON_START==='false' &&
    env.PACKPROOF_ORDER_WORKSPACE_ENABLED!=='true','REVIEW_OR_TARGET');
  check(review.apiRole==='packproof_records_api_v1' && review.workerRole==='packproof_records_worker_v1' &&
    /^[a-z][a-z0-9_]{0,62}$/.test(review.ownerRole) && !review.ownerRole.startsWith('pg_') &&
    ![review.apiRole,review.workerRole].includes(review.ownerRole),'ROLES');
  const until=Date.parse(review.expiresAt)-now.getTime();
  check(until>0 && until<=2*3600000,'REVIEW_EXPIRED');
  if(mode!=='inspect') {
    check(ledgers.has(review.expectedLedger) && imagePattern.test(review.bridgeImage) &&
      review.bridgeImage!==review.candidateImage, 'PREDECESSOR_REVIEW');
  }
  if(mode==='apply') {
    const rehearsal=JSON.parse(env.PACKPROOF_HOSTED_MIGRATION_REHEARSAL_JSON||'null');
    check(rehearsal?.schema==='packproof.hosted-collector-owner-receipt/v1' && rehearsal.mode==='rehearse' &&
      rehearsal.reviewSha256===hash && rehearsal.source===review.source && rehearsal.initialLedger===review.expectedLedger &&
      rehearsal.finalLedger===collectorInventory && rehearsal.rolledBack===true && rehearsal.image===review.candidateImage &&
      rehearsal.targetHost===target.host && rehearsal.actualTask?.startsWith(target.clusterArn.replace(':cluster/',':task/')+'/') &&
      Date.parse(rehearsal.completedAt)<=now.getTime() && Date.parse(rehearsal.completedAt)>=now.getTime()-2*3600000, 'REHEARSAL_REQUIRED');
  }
}

// Caller owns the transaction. The rehearsal runs the same changes then rolls the transaction back.
export async function runOwnerTransaction(db, review, mode, deps, schema='public') {
  check(['inspect','rehearse','apply'].includes(mode),'MODE');
  const source=await deps.migrationInventory();
  inspectReconstructionInventory(source,entries(source),review);
  if(mode==='inspect'){
    await db.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
    await db.query("SET LOCAL statement_timeout='20s'");
  }
  else {
    await db.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ');
    await db.query("SET LOCAL lock_timeout='10s'");
    await db.query("SET LOCAL statement_timeout='120s'");
    await db.query('SELECT pg_advisory_xact_lock(1347438146,1)');
  }
  const who=(await db.query(`SELECT current_database() AS db,current_schema() AS schema,current_user AS role,session_user AS login,
    current_setting('server_version_num')::int AS version`)).rows[0];
  check(who?.role===review.ownerRole && who.login===who.role && who.schema===schema && who.db===review.target.database &&
    who.version>=160000 && who.version<170000,'POSTGRES_OWNER');
  const before=entries(await rows(db)),initialLedger=digest(before),through=ledgers.get(initialLedger);
  check(through && (mode==='inspect'||initialLedger===review.expectedLedger||initialLedger===collectorInventory),'PREDECESSOR_CHANGED');
  const sql = id => source.find(item=>item.id===id).sql;
  const guardId=through===124?collectorMigration.id:through===123?workspaceMigration.id:'122_backfill_collector_041';
  await verifyBackfillScopeGuard(db,sql(guardId));
  const applied=[], receipt={initialLedger,through,applied,grantStatementCount:0};
  if(mode==='inspect')return {...receipt,finalLedger:initialLedger};
  if(through===122) {
    const prefix=source.filter(row=>row.id!==collectorMigration.id);
    const migration=await applyRestoredDelta(db,{source:review.source,apiRole:review.apiRole,workerRole:review.workerRole,
      ownerRole:review.ownerRole,database:review.target.database,schema}, {...deps,migrationInventory:async()=>prefix});
    receipt.grantStatementCount=migration.grantStatementCount;
    receipt.grantStatementsSha256=migration.grantStatementsSha256;
    applied.push(workspaceMigration.id);
  }
  if(through!==124) {
    await verifyBackfillScopeGuard(db,sql(workspaceMigration.id));
    for(const statement of deps.splitSqlStatements(sql(collectorMigration.id)))await db.query(statement);
    await db.query(`INSERT INTO schema_migrations(id,applied_at,checksum,checksum_provenance)
      VALUES($1,now(),$2,'EXECUTED_BYTES')`,[collectorMigration.id,collectorMigration.checksum]);
    applied.push(collectorMigration.id);
  }
  const after=entries(await rows(db));
  inspectReconstructionInventory(source,after,review);
  await verifyBackfillScopeGuard(db,sql(collectorMigration.id));
  check(digest(after.slice(0,before.length))===initialLedger,'HISTORICAL_RECEIPTS_CHANGED');
  return {...receipt,finalLedger:digest(after)};
}

async function main() {
  const env=process.env, mode=process.argv[2];
  const review=JSON.parse(env.PACKPROOF_HOSTED_MIGRATION_REVIEW_JSON||'null');
  const hash=env.PACKPROOF_HOSTED_MIGRATION_REVIEW_SHA256;
  validateOwnerReview(review,hash,mode,env);
  const uri=env.ECS_CONTAINER_METADATA_URI_V4;
  check(/^http:\/\/169\.254\.170\.2\/v4\/[A-Za-z0-9_-]+$/.test(uri),'METADATA_URI');
  const metadata=async path=>{
    const res=await fetch(uri+path,{redirect:'error',signal:AbortSignal.timeout(5000)});
    check(res.ok,'METADATA'); return res.json();
  };
  const [container,task]=await Promise.all([metadata(''),metadata('/task')]);
  const identity=validateReconstructionTaskMetadata(container,task,review);
  const [{createPgDatabase},{migrationInventory},{splitSqlStatements},{planRecordsRuntimePrivileges}]=await Promise.all([
    import('/app/backend/dist/db/postgres.js'),import('/app/backend/dist/db/migrate.js'),
    import('/app/backend/dist/db/sql.js'),import('/app/backend/scripts/records-runtime-privileges.mjs')]);
  check(env.PACKPROOF_DB_PASSWORD && env.PACKPROOF_DB_CA_FILE==='/app/backend/certs/rds-us-east-1-bundle.pem','INJECTED_OWNER_CONNECTION_REQUIRED');
  const url=new URL('postgresql://'+target.host+':5432/'+target.database);
  url.username=review.ownerRole;url.searchParams.set('sslmode','verify-full');
  const opened=createPgDatabase(url.href,()=>Promise.resolve(env.PACKPROOF_DB_PASSWORD));
  const rollback=new Error('rollback rehearsal');
  let result;
  try {
    await opened.db.transaction(async tx=>{
      result=await runOwnerTransaction(tx,review,mode,{migrationInventory,splitSqlStatements,planRecordsRuntimePrivileges});
      check((await tx.query('SELECT ssl FROM pg_stat_ssl WHERE pid=pg_backend_pid()')).rows[0]?.ssl===true,'VERIFIED_TLS');
      if(mode==='rehearse')throw rollback;
    });
  }catch(error){if(error!==rollback)throw error;}
  finally{await opened.close();}
  console.log(JSON.stringify({schema:'packproof.hosted-collector-owner-receipt/v1',mode,source:review.source,reviewSha256:hash,
    image:identity.image,actualTask:identity.taskArn,targetHost:target.host,...result,rolledBack:mode==='rehearse',completedAt:new Date().toISOString()}));
}

if(process.argv[1] && import.meta.url===pathToFileURL(process.argv[1]).href)main().catch(error=>{
  console.error(/^[A-Z0-9_]+$/.test(error?.message) ? error.message : 'HOSTED_COLLECTOR_OWNER_OPERATION_FAILED');process.exitCode=1;
});
