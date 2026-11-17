// Standalone command embedded in the reviewed predecessor image.
import {createHash} from 'node:crypto';
import {pathToFileURL} from 'node:url';

const inventory='3a0d0f641856846529659e12eb7ba166f8542753b663b4d5ab903862ee905de5';
const guardBody='0c2c9ed1e2d7ee9c5dc5b1c0a758be67953cbe92585902912370db225f1f7011';
const digest=s=>createHash('sha256').update(s).digest('hex');
function requireValue(ok,code){if(!ok)throw Error('ROLLBACK_READER_'+code);}

export function validateReaderReview(r,e) {
  requireValue(r && ['api','worker'].includes(r.kind) && /^[a-f0-9]{40}$/.test(r.sourceSha) &&
    /^[a-f0-9]{64}$/.test(r.reviewSha256) && r.inventorySha256===inventory &&
    /^\d{12}\.dkr\.ecr\.[a-z0-9-]+\.amazonaws\.com\/[a-z0-9_./-]+@sha256:[a-f0-9]{64}$/.test(r.image) &&
    /^arn:aws:ecs:[a-z0-9-]+:\d{12}:cluster\/[a-zA-Z0-9_-]+$/.test(r.clusterArn) &&
    /^[a-zA-Z0-9.-]+\.[a-zA-Z0-9-]+$/.test(r.database?.host) && /^[a-zA-Z0-9_]{1,63}$/.test(r.database?.name) &&
    [r.apiRole,r.workerRole].every(role=>typeof role==='string' && /^[a-z][a-z0-9_]{0,62}$/.test(role) && !role.startsWith('pg_')) &&
    r.apiRole!==r.workerRole && !!r.environment,'REVIEW_INVALID');
  requireValue(e.PACKPROOF_RELEASE_SHA===r.sourceSha && e.PACKPROOF_RELEASE_IMAGE===r.image &&
    e.PACKPROOF_PROCESS_ROLE===r.kind && e.PACKPROOF_ENVIRONMENT===r.environment &&
    e.PACKPROOF_MIGRATE_ON_START==='false','RUNTIME_BINDING');
  return r.kind==='api'?r.apiRole:r.workerRole;
}

export function validateReaderTask(r,container,task) {
  const prefix=r.clusterArn.replace(':cluster/',':task/')+'/';
  requireValue(container?.Image===r.image && container.ImageID===r.image.split('@')[1] &&
    [r.clusterArn,r.clusterArn.split('/').at(-1)].includes(task?.Cluster) &&
    task.TaskARN?.startsWith(prefix) && /^[a-f0-9]{32}$/.test(task.TaskARN.slice(prefix.length)),'ACTUAL_TASK');
}

export async function verifyReaderDatabase(db,r,role,assertSchemaCurrent) {
  await db.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
  await db.query("SET LOCAL statement_timeout='20s'");
  const id=(await db.query(`SELECT current_user AS role,session_user AS login,current_database() AS database,
    current_schema() AS schema,current_setting('transaction_read_only') AS ro,
    (SELECT ssl FROM pg_stat_ssl WHERE pid=pg_backend_pid()) AS tls`)).rows[0];
  requireValue(id?.role===role && id.login===role && id.database===r.database.name && id.schema==='public' &&
    id.ro==='on' && id.tls===true,'ACTUAL_LOGIN');
  const rows=(await db.query('SELECT id,checksum FROM public.schema_migrations ORDER BY id')).rows;
  requireValue(rows.length===120 && digest(JSON.stringify(rows.map(({id,checksum})=>({id,checksum}))))===inventory,'APPLIED_INVENTORY');
  // Invoke the predecessor application's actual startup guard, including its own forward-compatibility rules.
  try { await assertSchemaCurrent(db); } catch { throw Error('ROLLBACK_READER_SCHEMA_NOT_ADMITTED'); }
  const authority=(await db.query(`SELECT rolsuper OR rolcreaterole OR rolcreatedb OR rolreplication OR rolbypassrls
    OR has_schema_privilege(current_user,'public','CREATE')
    OR has_table_privilege(current_user,'public.schema_migrations','INSERT,UPDATE,DELETE,TRUNCATE')
    OR has_table_privilege(current_user,'public.partner_import_jobs','DELETE,TRUNCATE,TRIGGER')
    OR has_column_privilege(current_user,'public.partner_import_jobs','shipment_interpretation','UPDATE')
    OR pg_has_role(current_user, (SELECT relowner FROM pg_class WHERE oid='public.partner_import_jobs'::regclass), 'MEMBER')
    AS unsafe FROM pg_roles WHERE rolname=current_user`)).rows[0];
  requireValue(authority?.unsafe===false,'UNSAFE_AUTHORITY');
  const guard=(await db.query(`SELECT p.prosrc FROM pg_trigger t JOIN pg_proc p ON p.oid=t.tgfoid
    WHERE t.tgrelid='public.partner_import_jobs'::regclass AND t.tgname='partner_import_shipment_interpretation_immutable'
    AND t.tgenabled IN ('O','A') AND t.tgtype=19 AND NOT t.tgisinternal AND t.tgqual IS NULL
    AND t.tgattr::text=(SELECT attnum::text FROM pg_attribute WHERE attrelid=t.tgrelid AND attname='shipment_interpretation' AND NOT attisdropped)
    AND p.pronamespace='public'::regnamespace AND p.proname='protect_shipment_interpretation' AND NOT p.prosecdef`)).rows;
  requireValue(guard.length===1 && digest(guard[0].prosrc)===guardBody,'IMMUTABILITY_GUARD');
  const receipt=(await db.query(`WITH sample AS MATERIALIZED (
    SELECT id,organization_id,integration_account_id,operator_membership_id,original_sha256,
      original_byte_size,original_version_id,preview_version,shipment_interpretation
    FROM public.partner_import_jobs ORDER BY id LIMIT 32)
    SELECT j.organization_id IS NOT NULL AND j.integration_account_id IS NOT NULL
    AND j.operator_membership_id IS NOT NULL AND j.original_sha256 ~ '^[0-9a-f]{64}$'
    AND j.original_byte_size>0 AND j.original_version_id IS NOT NULL AND j.preview_version IS NOT NULL
    AND EXISTS(SELECT 1 FROM public.partner_import_rows row WHERE row.import_id=j.id AND row.row_number>=2 AND row.status IS NOT NULL)
    AS readable FROM sample j
    WHERE j.shipment_interpretation IS NULL LIMIT 1`)).rows;
  requireValue(receipt.length===0 || receipt[0].readable===true,'LEGACY_RECEIPT');
  return {legacyReceiptObserved:receipt.length===1};
}

async function main() {
  const r=JSON.parse(process.argv[2]),e=process.env,role=validateReaderReview(r,e);
  const uri=e.ECS_CONTAINER_METADATA_URI_V4;
  requireValue(/^http:\/\/169\.254\.170\.2\/v4\/[A-Za-z0-9_-]+$/.test(uri),'METADATA_URI');
  const metadata=async path=>{const response=await fetch(uri+path,{redirect:'error',signal:AbortSignal.timeout(5000)});requireValue(response.ok,'METADATA_UNAVAILABLE');return response.json();};
  const [container,task]=await Promise.all([metadata(''),metadata('/task')]);
  validateReaderTask(r,container,task);
  const [{loadConfig},{openDatabase},{assertSchemaCurrent}]=await Promise.all([
    import('file:///app/backend/dist/config.js'),import('file:///app/backend/dist/db/open.js'),import('file:///app/backend/dist/db/migrate.js')]);
  const config=loadConfig(),url=new URL(config.databaseUrl);
  requireValue(url.hostname===r.database.host && (!url.port||url.port==='5432') && decodeURIComponent(url.pathname.slice(1))===r.database.name &&
    decodeURIComponent(url.username)===role && config.processRole===r.kind && config.migrateOnStart===false &&
    config.release.environment===r.environment,'DATABASE_TARGET');
  const opened=await openDatabase(config);
  try {
    requireValue(opened.engine==='postgres','POSTGRES_REQUIRED');
    const sample=await opened.db.transaction(db=>verifyReaderDatabase(db,r,role,assertSchemaCurrent));
    console.log(JSON.stringify({event:'shipment_rollback_reader',schema:'packproof.shipment-rollback-reader/v1',kind:r.kind,sourceSha:r.sourceSha,image:r.image,
      environment:r.environment,inventorySha256:inventory,reviewSha256:r.reviewSha256,role,databaseHost:r.database.host,
      databaseName:r.database.name,taskArn:task.TaskARN,clusterArn:r.clusterArn,readOnly:true,compatibleReader:true,...sample,completedAt:new Date().toISOString()}));
  } finally { await opened.close(); }
}

export async function runRollbackReaderProbe() {
  const timer=setTimeout(()=>process.exit(2),90000);timer.unref();
  try { await main(); } catch(error) {
    console.error(JSON.stringify({event:'shipment_rollback_reader_failed',code:/^ROLLBACK_READER_[A-Z_]+$/.test(error?.message)?error.message:'ROLLBACK_READER_FAILED'}));process.exitCode=1;
  } finally { clearTimeout(timer); }
}
if (import.meta.url.endsWith('/[eval1]') || (process.argv[1] && import.meta.url===pathToFileURL(process.argv[1]).href)) await runRollbackReaderProbe();
