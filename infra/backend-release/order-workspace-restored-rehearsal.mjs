// This one-shot owner operation is restricted to the dedicated restored rehearsal.
// It may also be embedded unchanged as an ECS container command on a pinned image.
import {createHash,createHmac,pbkdf2Sync,randomBytes} from 'node:crypto';
import {pathToFileURL} from 'node:url';

const digest = value => createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex');
const prior = 'ea1b7bd281d155919935362bd904a7cce80711c267c64090be84023d6dbbc804';
const current = 'ce2f00a3cee6b8139fc6323830e787e781dab7780da93c8d4b23deaa742c1b4d';
const records = 'fc90a9edbe22cc22fa5f553096d9d7b9da8a3bde62ad3784ef117abdb6147001';
const addition = '123_order_workspace';
const sqlDigest = '941c88e20122caaaab739ee28f791d5b65157a6bb4acd347c4ff7e2e3801c1bd';
const relations = ['sessions','receipts','events','event_refs','roots','revisions','decisions','link_state','api_progress','revisions_sequence_seq'].map(name => 'record_order_'+name);
const check = (condition, code) => {if (!condition) throw Error('ORDER_REHEARSAL_'+code);};
const ids = rows => rows.map(({id,checksum}) => ({id,checksum})).sort((a,b)=>a.id.localeCompare(b.id));
const validName = name => typeof name === 'string' && /^[a-z][a-z0-9_]{0,62}$/.test(name) && !name.startsWith('pg_');
const ledger = async db => (await db.query('SELECT id,checksum FROM schema_migrations ORDER BY id')).rows;
const cloneIdentifier = 'packproof-order-workspace-rehearsal-20261117';
const clusterArn = 'arn:aws:ecs:us-east-1:784514617543:cluster/'+cloneIdentifier;
const host = cloneIdentifier+'.c8v2esku2zyt.us-east-1.rds.amazonaws.com';

export function validateRestoredLaunch(env,review,metadata) {
  check(review?.schema==='packproof.restored-order-workspace/v1' && review.targetHost===host &&
    review.database==='packproof_v2' && review.clusterArn===clusterArn && review.migrationSha256===sqlDigest,'TARGET');
  check([review.apiRole,review.workerRole,review.ownerRole].every(validName) && new Set([review.apiRole,review.workerRole,review.ownerRole]).size===3,'ROLES');
  check(review.source===env.PACKPROOF_RELEASE_SHA && /^[a-f0-9]{40}$/.test(review.source) &&
    review.image===env.PACKPROOF_RELEASE_IMAGE && /^784514617543\.dkr\.ecr\.us-east-1\.amazonaws\.com\/packproof-v2-staging-api@sha256:[a-f0-9]{64}$/.test(review.image) &&
    digest(review)===env.PACKPROOF_RESTORED_REVIEW_SHA256,'REVIEW');
  const remaining=Date.parse(review.expiresAt)-Date.now();
  check(remaining>0 && remaining<=86400000,'EXPIRY');
  const taskPrefix=clusterArn.replace(':cluster/',':task/')+'/';
  check(metadata.container?.Image===review.image && metadata.container.ImageID===review.image.split('@')[1] &&
    metadata.task?.TaskARN?.startsWith(taskPrefix) && /^[a-f0-9]{32}$/.test(metadata.task.TaskARN.slice(taskPrefix.length)),'IMAGE');
  check(env.PACKPROOF_DB_HOST===host && env.PACKPROOF_DB_NAME===review.database &&
    env.PACKPROOF_DB_USER===review.ownerRole && env.PACKPROOF_DB_PORT==='5432' && env.PACKPROOF_DB_SSLMODE==='verify-full' &&
    env.PACKPROOF_DB_CA_FILE==='/app/certs/rds-us-east-1-bundle.pem' && !!env.PACKPROOF_DB_PASSWORD &&
    env.PACKPROOF_MIGRATE_ON_START==='false' && env.PACKPROOF_ORDER_WORKSPACE_ENABLED==='false' &&
    !env.DATABASE_URL && !env.PACKPROOF_DB_SECRET_ARN && !Object.keys(env).some(key=>key.startsWith('PG')),'CONNECTION');
}

async function legacyState(db, schema) {
  const oldLedger=(await db.query('SELECT id,checksum,applied_at::text,checksum_provenance FROM schema_migrations WHERE id<>$1 ORDER BY id',[addition])).rows;
  const acl=(await db.query(`SELECT c.relname,c.relkind,c.relowner::text,c.relacl::text,a.attnum,a.attacl::text
    FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    LEFT JOIN pg_attribute a ON a.attrelid=c.oid AND a.attnum>0 AND a.attacl IS NOT NULL
    WHERE n.nspname=$1 AND c.relkind IN ('r','S') AND NOT (c.relname=ANY($2::text[]))
    ORDER BY c.relname,a.attnum`,[schema,relations])).rows;
  const samples = {};
  for (const name of ['proofs','final_manifests','partner_import_jobs','record_agent_installations','record_source_backfill_jobs','record_cases']) {
    // Hash original values inside PostgreSQL. Only bounded first/last samples and totals reach the receipt.
    const row=(await db.query(`WITH samples AS (
      (SELECT id,encode(sha256(convert_to(to_jsonb(t)::text,'UTF8')),'hex') AS h FROM ${name} t ORDER BY id LIMIT 16)
      UNION
      (SELECT id,encode(sha256(convert_to(to_jsonb(t)::text,'UTF8')),'hex') AS h FROM ${name} t ORDER BY id DESC LIMIT 16))
      SELECT (SELECT COUNT(*)::text FROM ${name}) AS count,COALESCE(string_agg(h,'' ORDER BY id),'') AS hashes FROM samples`)).rows[0];
    samples[name]={count:row.count,digest:digest(row.hashes)};
  }
  return {ledgerAndAcl:digest({oldLedger,acl}),sampledData:digest(samples)};
}

/** The caller supplies a dedicated connection and transaction. Throws on any drift. */
export async function applyRestoredDelta(db, options, deps) {
  const {source,apiRole,workerRole,ownerRole,schema}=options;
  check([apiRole,workerRole,ownerRole,schema].every(validName) && new Set([apiRole,workerRole,ownerRole]).size===3,'ROLES');
  check(/^[a-f0-9]{40}$/.test(source),'SOURCE');
  const inventory=await deps.migrationInventory();
  check(digest(ids(inventory))===current && inventory.every(m=>digest(m.sql)===m.checksum),'SOURCE_INVENTORY');
  const migration=inventory.find(m=>m.id===addition);
  check(migration?.checksum===sqlDigest,'SQL');
  await db.query("SET LOCAL lock_timeout='10s'");
  await db.query("SET LOCAL statement_timeout='120s'");
  await db.query('SELECT pg_advisory_xact_lock(1347438146,1)');
  const identity=(await db.query(`SELECT current_user AS role,session_user AS login,current_schema() AS schema,
    current_database() AS database, current_setting('server_version_num')::int AS version`)).rows[0];
  check(identity?.role===ownerRole && identity.login===ownerRole && identity.schema===schema &&
    identity.database===options.database && identity.version>=160000 && identity.version<170000,'DATABASE_IDENTITY');
  const before=await ledger(db);
  check(before.length===121 && digest(ids(before))===prior,'PREDECESSOR');
  const original=await legacyState(db,schema);
  for (const statement of deps.splitSqlStatements(migration.sql)) await db.query(statement);
  await db.query("INSERT INTO schema_migrations(id,applied_at,checksum,checksum_provenance) VALUES($1,now(),$2,'EXECUTED_BYTES')",[addition,sqlDigest]);
  const foreign=(await db.query(`SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    CROSS JOIN LATERAL aclexplode(c.relacl) a LEFT JOIN pg_roles r ON r.oid=a.grantee
    WHERE n.nspname=$1 AND c.relname=ANY($2::text[]) AND a.grantee<>c.relowner
    AND (r.rolname IS NULL OR NOT (r.rolname=ANY($3::text[]))) LIMIT 1`,[schema,relations,[apiRole,workerRole]])).rows;
  check(!foreign.length,'UNREVIEWED_DEFAULT_GRANTS');
  const policy=await deps.planRecordsRuntimePrivileges(db,{runtimeRole:apiRole,workerRole,schema,reviewedSourceCommit:source,
    reviewedMigrationSha256:records,throughMigration:123});
  const touched=new Set();
  const delta=policy.statements.filter(statement=>{
    const target=statement.match(/ ON (?:TABLE|SEQUENCE) "([a-z0-9_]+)"\."([a-z0-9_]+)" (?:FROM|TO) /);
    if (!target || target[1]!==schema || !relations.includes(target[2])) return false;
    touched.add(target[2]);return true;
  });
  check(touched.size===relations.length,'ACL_DELTA');
  for (const statement of delta) await db.query(statement);
  const after=await ledger(db);
  check(after.length===122 && digest(ids(after))===current && digest(await legacyState(db,schema))===digest(original),'PRESERVATION');
  return {schema:'packproof.restored-order-workspace-migration/v1',source,sqlDigest,predecessorInventory:prior,
    inventory:current,priorReceiptCount:before.length,receiptCount:after.length,legacyLedgerAndAclSha256:original.ledgerAndAcl,legacySampledDataSha256:original.sampledData,
    grantStatementCount:delta.length,grantStatementsSha256:digest(delta),postgresVersionNumber:identity.version};
}

// Derive the SCRAM verifier in the disposable task. The plaintext password never enters SQL.
function scram(password) {
  check(typeof password==='string' && /^[a-zA-Z0-9]{40}$/.test(password),'CLONE_SECRET');
  const salt=randomBytes(16), iterations=32768;
  const key=pbkdf2Sync(password,salt,iterations,32,'sha256');
  const client=createHmac('sha256',key).update('Client Key').digest();
  const stored=createHash('sha256').update(client).digest('base64');
  const server=createHmac('sha256',key).update('Server Key').digest('base64');
  return 'SCRAM-SHA-256$'+iterations+':'+salt.toString('base64')+'$'+stored+':'+server;
}

async function prepareCloneLogins(tx,review,env) {
  const who=(await tx.query('SELECT current_user AS role,session_user AS login,current_database() AS database,current_schema() AS schema')).rows[0];
  check(who.role===review.ownerRole && who.login===who.role && who.database===review.database && who.schema==='public','DATABASE_IDENTITY');
  check(digest(ids(await ledger(tx)))===prior,'PREDECESSOR');
  const names=[review.apiRole,review.workerRole];
  const logins=(await tx.query('SELECT rolname,rolcanlogin,rolsuper,rolcreaterole,rolcreatedb,rolbypassrls,rolreplication FROM pg_roles WHERE rolname=ANY($1::text[])',[names])).rows;
  check(logins.length===2 && logins.every(r=>r.rolcanlogin && !r.rolsuper && !r.rolcreaterole && !r.rolcreatedb && !r.rolbypassrls && !r.rolreplication),'RESTORED_LOGINS');
  for(const [role,value] of [[names[0],env.REHEARSAL_API_PASSWORD],[names[1],env.REHEARSAL_WORKER_PASSWORD]]) {
    const verifier=scram(value);
    await tx.query(`ALTER ROLE "${role}" PASSWORD '${verifier}'`);
  }
  const {readShipmentAutomationPolicy}=await import('/release/shipment-automation-pair.mjs');
  const capabilities=await readShipmentAutomationPolicy('api',env);
  const fence=(await tx.query('SELECT durability_required FROM policy_recovery_fence WHERE singleton=1')).rows[0];
  check(typeof fence?.durability_required==='boolean','FENCE');
  return {schema:'packproof.restored-order-logins/v1',predecessorReceiptCount:121,priorInventory:prior,
    resetRoleCount:2,capabilities,durabilityRequired:fence.durability_required};
}

async function main() {
  const env=process.env;
  const mode=process.argv.at(-1);
  check(['--rehearse','--rehearse-rollback','--reset-restored-logins'].includes(mode),'MODE');
  const review=JSON.parse(env.PACKPROOF_RESTORED_REVIEW_JSON ?? '');
  const uri=env.ECS_CONTAINER_METADATA_URI_V4;
  check(/^http:\/\/169\.254\.170\.2\/v4\/[A-Za-z0-9_-]+$/.test(uri),'METADATA_URI');
  const fetchMetadata=async suffix=>{
    const response=await fetch(uri+suffix,{redirect:'error',signal:AbortSignal.timeout(5000)});
    check(response.ok,'METADATA');return response.json();
  };
  const [container,task]=await Promise.all([fetchMetadata(''),fetchMetadata('/task')]);
  validateRestoredLaunch(env,review,{container,task});
  const [{createPgDatabase},{migrationInventory},{splitSqlStatements},{planRecordsRuntimePrivileges}]=await Promise.all([
    import('/app/backend/dist/db/postgres.js'),import('/app/backend/dist/db/migrate.js'),
    import('/app/backend/dist/db/sql.js'),import('/app/backend/scripts/records-runtime-privileges.mjs')]);
  const url=new URL('postgresql://'+host+':5432/'+review.database);
  url.username=review.ownerRole;url.searchParams.set('sslmode','verify-full');
  const opened=createPgDatabase(url.toString(),()=>Promise.resolve(env.PACKPROOF_DB_PASSWORD));
  let receipt;
  const rollback=new Error('rehearsal-complete');
  try {
    await opened.db.transaction(async tx=>{
      check((await tx.query('SELECT ssl FROM pg_stat_ssl WHERE pid=pg_backend_pid()')).rows[0]?.ssl===true,'TLS');
      receipt=mode==='--reset-restored-logins' ? await prepareCloneLogins(tx,review,env) : await applyRestoredDelta(tx,{...review,schema:'public'},{migrationInventory,splitSqlStatements,planRecordsRuntimePrivileges});
      if(mode==='--rehearse-rollback') throw rollback;
    });
  } catch(error){if(error!==rollback) throw error;}
  finally{await opened.close();}
  console.log(JSON.stringify({...receipt,rolledBack:mode==='--rehearse-rollback',actualTask:task.TaskARN,image:container.ImageID,
    reviewSha256:digest(review),targetHost:host,featureActivation:false,completedAt:new Date().toISOString()}));
}

if ((process.argv[1] && import.meta.url===pathToFileURL(process.argv[1]).href) ||
    (process.argv[1]==='restored-order-workspace' && import.meta.url.startsWith('file:') && import.meta.url.includes('[eval'))) {
  main().catch(error=>{
    const safeReason=/^(ORDER_REHEARSAL|RECORDS|AUTOMATION)_[A-Z_]+$/.test(error?.message) ? error.message :
      /^[A-Z0-9]{5}$/.test(error?.code) ? 'POSTGRES_'+error.code : 'DATABASE_REVIEW_REQUIRED';
    console.error(JSON.stringify({event:'order_workspace_rehearsal_failed',code:safeReason}));
    process.exitCode=1;
  });
}
