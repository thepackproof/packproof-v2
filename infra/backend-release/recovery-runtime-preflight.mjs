// Source-controlled, read-only code embedded into standalone ECS qualification tasks.
// It never starts index.js, a worker loop, migration, grant planner or application command.
import {createHash} from 'node:crypto';

export const recoveryTarget = Object.freeze({
  account:'784514617543',region:'us-east-1',
  clusterArn:'arn:aws:ecs:us-east-1:784514617543:cluster/packproof-v2-staging-cluster',
  repository:'784514617543.dkr.ecr.us-east-1.amazonaws.com/packproof-v2-staging-api',
  host:'packproof-v2-staging-db.c8v2esku2zyt.us-east-1.rds.amazonaws.com',database:'packproof_v2',
  apiRole:'packproof_records_api_v1',workerRole:'packproof_records_worker_v1',ownerRole:'packproof',
});
export const recoveryLedgers = Object.freeze({
  129:{count:128,sha256:'8ab67cf9cc721d6da4c28cef72fdcdaf2b08faaa86196d76acff0a4f95f97fcc',
    backfillBody:'f4eaf8894e9a837be7d0a772894c1a4f81fa319ab89602cff8e826a06853da4f'},
  130:{count:129,sha256:'13f05713808a4c077b9388d5609d99ad1bfa16b9ded82b2e447bc1c076d5896e',
    backfillBody:'e71a436c6ed1cdb3e77a5a7a43a1636cfa0ef3593db12bfa4e7c6c3f2cbbb365'},
});
export const recoveryDigest = value => createHash('sha256').update(typeof value==='string'?value:JSON.stringify(value)).digest('hex');
const canonical = value => Array.isArray(value)?value.map(canonical):value&&typeof value==='object'
  ?Object.fromEntries(Object.keys(value).sort().map(k=>[k,canonical(value[k])])):value;
export const recoveryBindingDigest = value => recoveryDigest(canonical(value));
const check = (ok,code) => {if(!ok)throw Error('CONNECT_RECOVERY_PROBE_'+code);};
export const recoveryImage = image => typeof image==='string' && image.startsWith(recoveryTarget.repository+'@sha256:') &&
  /^[a-f0-9]{64}$/.test(image.slice(recoveryTarget.repository.length+8));
const entries = rows => rows.map(({id,checksum})=>({id,checksum})).sort((a,b)=>a.id.localeCompare(b.id));
const stages=new Set(['LOAD_PROBE','REVIEW','METADATA','LOAD_MODULES','CONFIGURATION','COLLECTOR','AUTOMATION',
  'DATABASE_CONNECT','TRANSACTION','IDENTITY','SOURCE_INVENTORY','SCHEMA_ADMISSION','AUTHORITY','SHIPMENT_GUARD',
  'BACKFILL_GUARD','ORDER_GUARDS','MEMBERSHIP_LOCKS','M2_PRIVILEGES','RECORDS_PRIVILEGES','LEGACY_READ',
  'WORKER_ORDER_AUTHORITY','DURABILITY','RECOVERY_WORK','DATABASE_CLOSE']);
// Do not log driver messages, SQL, connection strings, credentials or stack traces.
export function formatRecoveryProbeFailure(error,stage='LOAD_PROBE') {
  const sqlState=[error?.sqlState,error?.code].find(value=>typeof value==='string'&&/^[0-9A-Z]{5}$/.test(value));
  const known=/^(?:CONNECT_RECOVERY_PROBE|RECORDS|M2|HOSTED_MEMBERSHIP|RECONSTRUCTION|BACKFILL|ORDER_WORKSPACE|AUTOMATION)_[A-Z0-9_]{1,100}$/;
  return {event:'recovery_runtime_probe_failed',schema:'packproof.recovery-runtime-probe-error/v1',
    stage:stages.has(error?.recoveryStage)?error.recoveryStage:stages.has(stage)?stage:'LOAD_PROBE',
    code:known.test(error?.message??'')?error.message:sqlState?'POSTGRES_ERROR':'OPERATION_FAILED',
    ...(sqlState?{sqlState}:{})};
}
function stagedFailure(error,stage) {
  const detail=formatRecoveryProbeFailure(error,stage),safe=new Error(detail.code);
  safe.recoveryStage=detail.stage;if(detail.sqlState)safe.sqlState=detail.sqlState;return safe;
}

export function validateRecoveryProbe(review,env,now=Date.now()) {
  const r=review, t=recoveryTarget;
  check(r?.schema==='packproof.recovery-runtime-probe-review/v1' && ['api','worker'].includes(r.kind) &&
    ['target','peer'].includes(r.side) && ['fallback','candidate','recovery'].includes(r.profile) &&
    /^[a-f0-9]{64}$/.test(r.releaseReviewSha256??'') && /^[a-f0-9]{40}$/.test(r.source??'') &&
    recoveryImage(r.image) && r.clusterArn===t.clusterArn && r.target?.host===t.host &&
    r.target.database===t.database && r.apiRole===t.apiRole && r.workerRole===t.workerRole && r.ownerRole===t.ownerRole &&
    [129,130].includes(r.ledgerThrough) && [129,130].includes(r.sourceThrough) &&
    (r.ledgerThrough===130 || r.sourceThrough===129) && r.fullPrivileges===(r.ledgerThrough===r.sourceThrough), 'REVIEW');
  check(Number.isFinite(Date.parse(r.expiresAt)) && Date.parse(r.expiresAt)>now && Date.parse(r.expiresAt)-now<=7200000,'REVIEW_EXPIRED');
  check(env.PACKPROOF_RELEASE_SHA===r.source && env.PACKPROOF_RELEASE_IMAGE===r.image &&
    env.PACKPROOF_PROCESS_ROLE===r.kind && env.PACKPROOF_ENVIRONMENT==='production' && env.PACKPROOF_MIGRATE_ON_START==='false', 'RUNTIME_BINDING');
  check(Array.isArray(r.environmentNames) && r.environmentNames.length===new Set(r.environmentNames).size &&
    r.environmentNames.every(name=>/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) &&
    recoveryBindingDigest(Object.fromEntries(r.environmentNames.map(name=>[name,env[name]])))===r.environmentSha256,'RUNTIME_CONFIGURATION');
  check(!env.PACKPROOF_GUIDED_FACILITIES && !env.PACKPROOF_SETUP_AI_FACILITIES,'FACILITY_ACTIVATION_SEPARATE');
  return r.kind==='api'?r.apiRole:r.workerRole;
}

export function validateRecoveryTask(review,container,task) {
  const prefix=recoveryTarget.clusterArn.replace(':cluster/',':task/')+'/';
  check(container?.Image===review.image && container.ImageID===review.image.split('@')[1] &&
    [recoveryTarget.clusterArn,recoveryTarget.clusterArn.split('/').at(-1)].includes(task?.Cluster) &&
    task.TaskARN?.startsWith(prefix) && /^[a-f0-9]{32}$/.test(task.TaskARN.slice(prefix.length)), 'TASK_IDENTITY');
  return {taskArn:task.TaskARN,image:container.Image,imageDigest:container.ImageID};
}

export function verifyRecoveryInventories(source,applied,review) {
  const expectedSource=recoveryLedgers[review.sourceThrough], expectedLedger=recoveryLedgers[review.ledgerThrough];
  check(source.length===expectedSource.count && recoveryDigest(entries(source))===expectedSource.sha256 &&
    source.every(row=>typeof row.sql==='string' && recoveryDigest(row.sql)===row.checksum),'SOURCE_INVENTORY');
  check(applied.length===expectedLedger.count && recoveryDigest(entries(applied))===expectedLedger.sha256,'APPLIED_INVENTORY');
  return {sourceCount:source.length,appliedCount:applied.length,sourceSha256:expectedSource.sha256,
    inventorySha256:expectedLedger.sha256,migrationsApplied:false,rolesChanged:false};
}

async function scopeGuard(db,through) {
  const expected=new Map([['record_source_backfill_jobs','record_source_backfill_job_scope'],
    ['record_source_backfill_decisions','record_source_backfill_decision_scope'],
    ['record_source_backfill_receipts','record_source_backfill_receipt_scope']]);
  const rows=(await db.query(`SELECT c.relname,t.tgname,t.tgenabled,t.tgtype,t.tgnargs,
    t.tgqual IS NULL AS unconditional,t.tgattr::text AS columns,p.prosrc,p.prosecdef,
    p.proconfig IS NULL AS default_settings,l.lanname,pg_get_userbyid(p.proowner)=pg_get_userbyid(c.relowner) AS table_owner
    FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_proc p ON p.oid=t.tgfoid JOIN pg_language l ON l.oid=p.prolang
    WHERE c.relnamespace=current_schema()::regnamespace AND p.pronamespace=c.relnamespace
      AND p.proname='record_source_backfill_scope' AND NOT t.tgisinternal AND t.tgname=ANY($1::text[])`,[[...expected.values()]])).rows;
  check(rows.length===3 && rows.every(row=>expected.get(row.relname)===row.tgname && expected.delete(row.relname) &&
    ['O','A'].includes(row.tgenabled) && row.tgtype===7 && row.tgnargs===0 && row.unconditional && row.columns==='' &&
    recoveryDigest(row.prosrc)===recoveryLedgers[through].backfillBody && row.prosecdef===false && row.default_settings &&
    row.lanname==='plpgsql' && row.table_owner),'BACKFILL_SCOPE');
}

// Both target and peer use their own compiled schema reader. On130 the old
// fallback has a129 privilege catalogue; its reader receipt must be paired with
// the candidate's full130 verification under BOTH actual database logins.
export async function verifyRecoveryRuntime(db,r,deps) {
  let stage='TRANSACTION';
  try {
  await db.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
  await db.query("SET LOCAL statement_timeout='30s'");
  stage='IDENTITY';
  const identity=(await db.query(`SELECT current_user AS role,session_user AS login,current_database() AS database,
    current_schema() AS schema,current_setting('transaction_read_only') AS read_only,
    current_setting('server_version_num')::integer AS version`)).rows[0];
  const role=r.kind==='api'?r.apiRole:r.workerRole;
  const tls=(await db.query('SELECT ssl,version FROM pg_stat_ssl WHERE pid=pg_backend_pid()')).rows[0];
  check(identity?.role===role && identity.login===role && identity.database===r.target.database &&
    identity.schema==='public' && identity.read_only==='on' && identity.version>=160000 && identity.version<170000 && tls?.ssl===true,'ACTUAL_LOGIN_TLS');
  stage='SOURCE_INVENTORY';const source=await deps.migrationInventory();
  const applied=(await db.query('SELECT id,checksum FROM schema_migrations ORDER BY id')).rows;
  const inventory=verifyRecoveryInventories(source,applied,r);
  stage='SCHEMA_ADMISSION';await deps.assertSchemaCurrent(db);
  stage='AUTHORITY';
  const unsafe=(await db.query(`SELECT r.rolsuper OR r.rolcreatedb OR r.rolcreaterole OR r.rolreplication OR r.rolbypassrls
    OR pg_has_role(current_user,$1,'MEMBER') OR pg_has_role(current_user,$1,'SET')
    OR has_schema_privilege(current_user,'public','CREATE')
    OR has_table_privilege(current_user,'schema_migrations','INSERT,UPDATE,DELETE,TRUNCATE')
    OR has_table_privilege(current_user,'user_system_roles','INSERT,UPDATE,DELETE,TRUNCATE')
    OR has_table_privilege(current_user,'partner_import_jobs','DELETE,TRUNCATE,TRIGGER')
    OR has_column_privilege(current_user,'partner_import_jobs','shipment_interpretation','UPDATE') AS unsafe
    FROM pg_roles r WHERE r.rolname=current_user`,[r.ownerRole])).rows[0];
  check(unsafe?.unsafe===false,'AUTHORITY');
  stage='SHIPMENT_GUARD';await deps.verifyShipmentInterpretationGuard(db,source.find(row=>row.id==='121_shipment_interpretation_decisions').sql);
  stage='BACKFILL_GUARD';await scopeGuard(db,r.ledgerThrough);
  stage='ORDER_GUARDS';await deps.verifyOrderHistoryGuards(db);
  stage='MEMBERSHIP_LOCKS';const platformLocks=await deps.verifyHostedMembershipLocks(db,{kind:r.kind,apiRole:r.apiRole,workerRole:r.workerRole});
  stage='M2_PRIVILEGES';const m2=await deps.verifyM2RuntimePrivileges(db,{apiRole:r.apiRole,workerRole:r.workerRole});
  let recordsPrivileges=null;
  if(r.fullPrivileges) {
    stage='RECORDS_PRIVILEGES';
    const records=await deps.recordsMigrationInventory(r.ledgerThrough);
    recordsPrivileges=await deps.verifyRecordsRuntimePrivileges(db,{runtimeRole:r.apiRole,workerRole:r.workerRole,schema:'public',
      reviewedSourceCommit:r.source,reviewedMigrationSha256:records.migrationSha256,throughMigration:r.ledgerThrough});
    check(recordsPrivileges.caller===role && recordsPrivileges.sourceCommit===r.source,'FULL_AUTHORITY');
  }
  // Order history is API-owned; the reviewed worker policy deliberately denies
  // SELECT here. Verify that denial and exercise its permitted import readers.
  let workerOrderHistoryDenied=null;
  if(r.kind==='worker') {
    stage='WORKER_ORDER_AUTHORITY';
    const authority=(await db.query(`SELECT has_table_privilege(current_user,'public.record_order_revisions','SELECT')
      OR has_any_column_privilege(current_user,'public.record_order_revisions','SELECT')
      OR has_table_privilege(current_user,'public.record_order_receipts','SELECT')
      OR has_any_column_privilege(current_user,'public.record_order_receipts','SELECT') AS allowed`)).rows[0];
    check(authority?.allowed===false,'WORKER_ORDER_HISTORY_AUTHORITY');workerOrderHistoryDenied=true;
  }
  stage='LEGACY_READ';
  const readable=(await db.query(r.kind==='api'?`SELECT
    (SELECT count(*)::integer FROM (SELECT proof_id,revision,content_digest FROM record_order_revisions LIMIT 1) r) AS first,
    (SELECT count(*)::integer FROM (SELECT id,original_sha256 FROM record_order_receipts LIMIT 1) r) AS second`:`SELECT
    (SELECT count(*)::integer FROM (SELECT id,original_sha256 FROM record_typed_batches LIMIT 1) r) AS first,
    (SELECT count(*)::integer FROM (SELECT id,original_sha256 FROM partner_import_jobs LIMIT 1) r) AS second`)).rows[0];
  check(Number.isInteger(readable?.first) && Number.isInteger(readable?.second),'LEGACY_READ');
  stage='DURABILITY';
  const policy=(await db.query('SELECT durability_required FROM policy_recovery_fence WHERE singleton=1')).rows[0];
  check(policy && policy.durability_required===deps.requireDurableReceipts,'DURABILITY_POLICY');
  let recoveryQuiescence=null;
  if(r.profile==='recovery') {
    stage='RECOVERY_WORK';
    recoveryQuiescence=(await db.query(`WITH unified AS (
      SELECT s.id FROM record_source_subscriptions s JOIN record_agent_installations i ON i.id=s.installation_id WHERE i.version='0.7.1')
      SELECT (SELECT count(*)::integer FROM record_source_subscriptions s JOIN unified u ON u.id=s.id WHERE s.state='active') AS active_sources,
      (SELECT count(*)::integer FROM record_typed_batches b JOIN unified u ON u.id=b.subscription_id
        WHERE b.state IN ('queued','running') OR b.replay_requested) AS pending_batches,
      (SELECT count(*)::integer FROM record_typed_shipment_work w JOIN record_typed_batches b ON b.id=w.batch_id
        JOIN unified u ON u.id=b.subscription_id WHERE w.state='pending') AS pending_projections`)).rows[0];
    check(recoveryQuiescence && ['active_sources','pending_batches','pending_projections'].every(k=>recoveryQuiescence[k]===0),'RECOVERY_WORK_REMAINS');
  }
  return {identity,tls:{ssl:tls.ssl,version:tls.version},inventory,recordsPrivileges,platformLocks,
    m2PrivilegesSha256:recoveryDigest(m2),schemaReaderVerified:true,immutableTriggerVerified:true,
    backfillScopeVerified:true,orderHistoryGuardsVerified:true,legacyReaderVerified:true,
    legacyReaderKind:r.kind==='api'?'order-history':'worker-imports',workerOrderHistoryDenied,
    durabilityPolicyMatches:true,recoveryQuiescence};
  } catch(error) {throw stagedFailure(error,stage);}
}

export async function executeRecoveryProbe(review,env=process.env) {
  let stage='REVIEW';
  try {
  const role=validateRecoveryProbe(review,env);
  stage='METADATA';
  const uri=env.ECS_CONTAINER_METADATA_URI_V4;
  check(/^http:\/\/169\.254\.170\.2\/v4\/[A-Za-z0-9_-]+$/.test(uri),'METADATA_URI');
  const read=async path=>{const response=await fetch(uri+path,{redirect:'error',signal:AbortSignal.timeout(5000)});
    check(response.ok,'METADATA_UNAVAILABLE');return response.json();};
  const [container,task]=await Promise.all([read(''),read('/task')]);
  const taskIdentity=validateRecoveryTask(review,container,task);
  stage='LOAD_MODULES';
  const [{loadConfig},{openDatabase},migration,privileges,m2,locks,guards,shipment,automation,features]=await Promise.all([
    import('file:///app/backend/dist/config.js'),import('file:///app/backend/dist/db/open.js'),
    import('file:///app/backend/dist/db/migrate.js'),import('file:///app/backend/scripts/records-runtime-privileges.mjs'),
    import('file:///app/backend/scripts/m2-runtime-privileges.mjs'),import('file:///release/hosted-membership-locks.mjs'),
    import('file:///release/reconstruction-v11-release-review.mjs'),import('file:///release/reconstruction-v7-runtime-preflight.mjs'),
    import('file:///release/shipment-automation-pair.mjs'),import('file:///app/backend/dist/records/reconstruction-features.js')]);
  stage='CONFIGURATION';const config=loadConfig(),url=new URL(config.databaseUrl);
  check(url.hostname===review.target.host && (!url.port||url.port==='5432') && decodeURIComponent(url.pathname.slice(1))===review.target.database &&
    decodeURIComponent(url.username)===role && config.processRole===review.kind && config.migrateOnStart===false && config.release.environment==='production','DATABASE_TARGET');
  stage='COLLECTOR';const version=review.sourceThrough===130?'0.7.1':'0.7.0';
  check(features.supportsOrderWorkspace(version) && features.supportsSourceBackfills(version) &&
    features.typedCollectorVersionSupported(version,'packproof.typed-source-batch/v2') &&
    features.supportsOrderWorkspace('0.7.1')===(review.sourceThrough===130) &&
    !features.supportsOrderWorkspace('0.7.2') && !features.supportsSourceBackfills('0.7.2') &&
    !features.typedCollectorVersionSupported('0.7.2','packproof.typed-source-batch/v2'),'COMPILED_COLLECTOR');
  if(review.sourceThrough===130) {
    const routes=await import('file:///app/backend/dist/records/setup-assistant-router.js');
    check(typeof routes.setupAssistantRouter==='function','COMPILED_CONNECT_RECOVERY_ROUTER');
  }
  stage='AUTOMATION';const automationPolicy=await automation.readShipmentAutomationPolicy(review.kind,env);
  stage='DATABASE_CONNECT';const opened=await openDatabase(config);
  try {
    check(opened.engine==='postgres','POSTGRES_REQUIRED');
    stage='TRANSACTION';
    const result=await opened.db.transaction(db=>verifyRecoveryRuntime(db,review,{...migration,...privileges,...m2,...locks,...guards,...shipment,
      requireDurableReceipts:config.requireDurableReceipts===true}));
    const report={schema:'packproof.recovery-runtime-probe/v1',reviewSha256:recoveryBindingDigest(review),
      source:review.source,kind:review.kind,side:review.side,profile:review.profile,taskIdentity,
      ledgerThrough:review.ledgerThrough,sourceThrough:review.sourceThrough,fullPrivileges:review.fullPrivileges,
      automationPolicy,environmentSha256:review.environmentSha256,compiledCollectorVerified:true,
      readOnly:true,featureActivation:false,...result,completedAt:new Date().toISOString()};
    console.log(JSON.stringify(report));return report;
  } finally {try{await opened.close();}catch(error){throw stagedFailure(error,'DATABASE_CLOSE');}}
  } catch(error) {throw stagedFailure(error,stage);}
}
