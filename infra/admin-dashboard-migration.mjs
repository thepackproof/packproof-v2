/**
 * Reviewed one-shot admin dashboard migration runner, candidate container only.
 * --inspect performs database reads only. --apply runs the normal migrator under
 * a separate expiring login that may SET only the existing fixed owner role.
 * This does not create/cut over runtime credentials or verify runtime authority.
 */
import { createHash, createHmac, pbkdf2Sync, randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';

export const OWNER_ROLE = 'packproof';
export const DATABASE_TARGET=Object.freeze({instance:'packproof-v2-staging-db',host:'packproof-v2-staging-db.c8v2esku2zyt.us-east-1.rds.amazonaws.com',port:5432,database:'packproof_v2',region:'us-east-1'});
export const BASELINE_COUNT = 69; // Two distinct, already reviewed 027 migrations.
export const BASELINE_INVENTORY_SHA256 = '32fa80605167a89551dc07712849b90d699020d74a620269ff11770be64cf747';
export const MIGRATIONS = Object.freeze({
  '069_system_admin': '95f2eb6a14f703fc1a7d6a69c4c651147c1590424a3978c8256e95bbc9f32cd3',
  '070_public_analytics': '56f2d727ae90a9b19163f43e5b43c1f1973deb0fd0ec96262273dd9094a4c5d8',
  '071_admin_error_triage': '57f74e7ade72ed5f57239d93ae06f6c0b3e1c33984ee8334843f9e558d96a247',
  '072_admin_read_indexes': '43052f95d34060f14bdfd67b9756c6542d3279ac4a5a21f8480b3bd1ed5e01f1',
  '073_client_version_activity': '6a1815b36939790632a73e8650e49b2fc9733e798fc75a620406f751bf75573a',
});
export const NEW_TABLES = Object.freeze([
  'user_system_roles', 'system_admin_audit_events', 'admin_command_receipts',
  'system_feature_flags', 'billing_allowance_adjustments', 'public_analytics_daily',
  'admin_error_triage', 'client_version_activity',
]);
const ROLE_PATTERN = /^pp_admin_migrate_[0-9a-f]{16}$/;
class ControlledMigrationError extends Error {
  constructor(code) { super(code); this.safeCode = code; }
}
const fail = code => { throw new ControlledMigrationError(code); };
export const inventoryDigest = rows => createHash('sha256').update(JSON.stringify(
  rows.map(({id, checksum}) => ({id, checksum})).sort((a,b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
)).digest('hex');

export function validateInventory(inventory, applied) {
  if (!Array.isArray(inventory) || !Array.isArray(applied) || [...inventory,...applied].some(row =>
    !row || typeof row.id !== 'string' || !/^\d{3}_[a-z0-9_]+$/.test(row.id) || !/^[a-f0-9]{64}$/.test(row.checksum ?? ''))) fail('INVALID_MIGRATION_INVENTORY');
  const files = new Map(inventory.map(row => [row.id,row]));
  if (files.size !== inventory.length || new Set(applied.map(row=>row.id)).size !== applied.length) fail('DUPLICATE_MIGRATION_ID');
  if (inventory.length !== BASELINE_COUNT + Object.keys(MIGRATIONS).length) fail('UNEXPECTED_SOURCE_INVENTORY');
  for (const [id, hash] of Object.entries(MIGRATIONS)) if (files.get(id)?.checksum !== hash) fail('ADMIN_MIGRATION_SOURCE_MISMATCH');
  const baseline = inventory.filter(row => !Object.hasOwn(MIGRATIONS,row.id));
  if (baseline.length !== BASELINE_COUNT || inventoryDigest(baseline) !== BASELINE_INVENTORY_SHA256) fail('SOURCE_BASELINE_MISMATCH');
  for (const row of applied) {
    if (!files.has(row.id) || files.get(row.id).checksum !== row.checksum) fail('MIGRATION_BASELINE_MISMATCH');
    if (Object.hasOwn(MIGRATIONS,row.id) && row.checksum_provenance !== 'EXECUTED_BYTES') fail('ADMIN_MIGRATION_RECEIPT_MISMATCH');
  }
  const existing = new Set(applied.map(row=>row.id));
  const missing = inventory.filter(row=>!existing.has(row.id));
  if (missing.some(row=>!Object.hasOwn(MIGRATIONS,row.id))) fail('UNEXPECTED_PENDING_MIGRATION');
  return missing.map(row=>row.id).sort();
}

function ownerUrl(value) {
  let url;
  try { url = new URL(value); } catch { fail('INVALID_OPERATOR_DATABASE_URL'); }
  if (!['postgres:','postgresql:'].includes(url.protocol) || !url.hostname || url.pathname.length < 2 || url.hash) fail('INVALID_OPERATOR_DATABASE_URL');
  const allowedParams=new Set(['sslmode','sslrootcert','application_name','options']);
  const keys=[...url.searchParams.keys()];
  if(keys.some(key=>!allowedParams.has(key))||new Set(keys).size!==keys.length)fail('UNSUPPORTED_DATABASE_URL_PARAMETER');
  let username;
  try { username = decodeURIComponent(url.username); } catch { fail('INVALID_OPERATOR_DATABASE_URL'); }
  if (username !== OWNER_ROLE) fail('DATABASE_OWNER_MISMATCH');
  return url;
}

export function assertDatabaseTarget(value){
  const url=ownerUrl(value);let database;try{database=decodeURIComponent(url.pathname.slice(1));}catch{fail('INVALID_OPERATOR_DATABASE_URL');}
  if(url.hostname!==DATABASE_TARGET.host||Number(url.port||5432)!==DATABASE_TARGET.port||database!==DATABASE_TARGET.database)fail('DATABASE_TARGET_MISMATCH');
  return DATABASE_TARGET;
}

/** Explicit operator selection; an inherited runtime callback can never win. */
export function ownerDatabaseEnvironment(env) {
  if (!env.PACKPROOF_ADMIN_MIGRATION_DATABASE_URL?.trim()) fail('SEPARATE_OPERATOR_DATABASE_REQUIRED');
  const url = ownerUrl(env.PACKPROOF_ADMIN_MIGRATION_DATABASE_URL);
  const secret = env.PACKPROOF_ADMIN_MIGRATION_DB_SECRET_ARN?.trim();
  if (!secret && !url.password) fail('EXPLICIT_OPERATOR_CREDENTIAL_SOURCE_REQUIRED');
  const selected = {...env, DATABASE_URL:url.toString(), PACKPROOF_MIGRATION_ROLE:OWNER_ROLE};
  delete selected.PACKPROOF_DB_SECRET_ARN;
  delete selected.PACKPROOF_MIGRATION_DATABASE_URL;
  delete selected.PGPASSWORD;
  delete selected.PACKPROOF_DB_PASSWORD;
  if (secret) selected.PACKPROOF_DB_SECRET_ARN = secret;
  return selected;
}

/** Leaves verified TLS coordinates/CA and durability unchanged; no master creds in child. */
export function temporaryDatabaseEnvironment(env, databaseUrl, login, password) {
  if (!ROLE_PATTERN.test(login)) fail('INVALID_TEMPORARY_LOGIN');
  if (typeof password !== 'string' || password.length < 32) fail('INVALID_TEMPORARY_PASSWORD');
  const url = ownerUrl(databaseUrl);
  url.username = login; url.password = password;
  url.searchParams.set('options', '-c role=packproof -c search_path=public -c statement_timeout=30000 -c lock_timeout=15000 -c idle_in_transaction_session_timeout=30000');
  const child = {...env, DATABASE_URL:url.toString(), PACKPROOF_MIGRATION_DATABASE_URL:url.toString(), PACKPROOF_MIGRATION_ROLE:OWNER_ROLE};
  for (const key of Object.keys(child)) if (key.startsWith('PACKPROOF_ADMIN_BOOTSTRAP_') || key.startsWith('PACKPROOF_ADMIN_MIGRATION_')) delete child[key];
  for (const key of ['PACKPROOF_DB_PASSWORD','PGPASSWORD','PGUSER','PGHOST','PGPORT','PGDATABASE','PGOPTIONS','PGSERVICE','PGSERVICEFILE','NODE_OPTIONS','NODE_PATH']) delete child[key];
  // Empty/false sentinels prevent the normal CLI's loadEnvFile from reviving a
  // master-secret callback or checksum-adoption switch from an image .env file.
  child.PACKPROOF_DB_SECRET_ARN = '';
  child.PACKPROOF_ADOPT_LEGACY_MIGRATION_CHECKSUMS = 'false';
  return child;
}

/** Evidence is operator-attested, not a claim that this module queried RDS. */
export function recoveryEvidence(env, now = new Date()) {
  const timestamp = env.PACKPROOF_ADMIN_MIGRATION_RECOVERY_POINT;
  const database = env.PACKPROOF_ADMIN_MIGRATION_RECOVERY_DB_ID;
  if (database !== DATABASE_TARGET.instance || typeof timestamp !== 'string' ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(timestamp) || !Number.isFinite(Date.parse(timestamp))) fail('CURRENT_RECOVERY_EVIDENCE_REQUIRED');
  const age = now.getTime() - Date.parse(timestamp);
  if (age < -60_000 || age > 60*60_000) fail('RECOVERY_EVIDENCE_STALE');
  return {database, latestRestorableTime:new Date(timestamp).toISOString(), source:'OPERATOR_ATTESTED_RDS_OBSERVATION'};
}

export async function withTemporaryAuthority({create, grant, run, cleanup}) {
  let created = false;
  try { await create(); created = true; await grant(); return await run(); }
  finally { if (created) await cleanup(); }
}

/** Waits for close, not just error/abort, before allowing the caller to remove the login. */
export function runNormalMigrator(env, signal, {spawnImpl=spawn, timeoutMs=180_000, killAfterMs=5_000}={}) {
  return new Promise((resolve,reject) => {
    if (signal?.aborted) return reject(new ControlledMigrationError('MIGRATION_INTERRUPTED'));
    let failed = false, stopped = false, escalation;
    const child = spawnImpl(process.execPath,['dist/db/migrate-cli.js'],{cwd:'/app',env,stdio:'ignore'});
    const stop = () => { if (stopped) return; stopped=true; failed=true; child.kill('SIGTERM'); escalation=setTimeout(()=>child.kill('SIGKILL'),killAfterMs); };
    const deadline=setTimeout(stop,timeoutMs);
    signal?.addEventListener('abort',stop,{once:true});
    child.once('error',()=>{failed=true;});
    child.once('close',code=>{
      clearTimeout(deadline);clearTimeout(escalation);signal?.removeEventListener('abort',stop);
      if(code===0&&!failed)resolve();else reject(new ControlledMigrationError(stopped?'CONTROLLED_MIGRATOR_INTERRUPTED':'CONTROLLED_MIGRATOR_FAILED'));
    });
  });
}

export async function main(args=process.argv.slice(2)) {
  if(args.length!==2 || !['--inspect','--apply'].includes(args[0]) || !/^[a-f0-9]{40}$/.test(args[1])) fail('EXPECTED_MODE_AND_SOURCE_SHA');
  const [mode,expectedSource]=args;
  const env=ownerDatabaseEnvironment(process.env);
  assertDatabaseTarget(env.DATABASE_URL);
  const [{loadConfig},{openDatabase},{createPgDatabase},{migrationInventory,assertSchemaCurrent},{default:pg}]=await Promise.all([
    import('/app/dist/config.js'),import('/app/dist/db/open.js'),import('/app/dist/db/postgres.js'),import('/app/dist/db/migrate.js'),import('/app/node_modules/pg/lib/index.js'),
  ]);
  const config=loadConfig(env);
  if(config.release.commit!==expectedSource || config.release.environment!=='staging' || config.migrateOnStart || config.awsRegion!==DATABASE_TARGET.region || env.NODE_TLS_REJECT_UNAUTHORIZED==='0') fail('RELEASE_CONTEXT_MISMATCH');
  ownerUrl(config.databaseUrl);
  const recovery=mode==='--apply'?recoveryEvidence(env):null;
  const opened=await openDatabase(config,env),abort=new AbortController();
  const stop=()=>abort.abort();process.once('SIGTERM',stop);process.once('SIGINT',stop);
  let phase='inspect',temporaryLogin=null,cleanupRequired=false,creationAttempted=false,creationAcknowledged=false;
  const transaction=work=>opened.db.transaction(async db=>{
    await db.query("SET LOCAL statement_timeout='30s'");await db.query("SET LOCAL lock_timeout='15s'");return work(db);
  });
  const interrupted=()=>{if(abort.signal.aborted)fail('MIGRATION_INTERRUPTED');};
  const readIdentity=async db=>{
    const identity=(await db.query('SELECT current_user AS role,session_user AS login,current_database() AS database,current_schema() AS schema')).rows[0];
    if(identity?.role!==OWNER_ROLE || identity?.login!==OWNER_ROLE || identity?.schema!=='public') fail('MIGRATION_OWNER_MISMATCH');
    if(identity.database!==DATABASE_TARGET.database)fail('DATABASE_TARGET_MISMATCH');
    const tls=(await db.query('SELECT ssl,version FROM pg_stat_ssl WHERE pid=pg_backend_pid()')).rows[0];
    if(tls?.ssl!==true || !['TLSv1.2','TLSv1.3'].includes(tls.version)) fail('VERIFIED_DATABASE_TLS_REQUIRED');
    return {identity,tls};
  };
  try {
    const inventory=await migrationInventory();
    const baseline=await transaction(async db=>{
      await db.query('SET TRANSACTION READ ONLY');
      const identity=await readIdentity(db);
      const owner=(await db.query("SELECT tableowner FROM pg_tables WHERE schemaname='public' AND tablename='schema_migrations'")).rows[0];
      if(owner?.tableowner!==OWNER_ROLE)fail('MIGRATION_TABLE_OWNER_MISMATCH');
      const policy=(await db.query('SELECT durability_required FROM policy_recovery_fence WHERE singleton=1')).rows[0];
      if(!policy || policy.durability_required!==(config.requireDurableReceipts===true))fail('DURABILITY_POLICY_MISMATCH');
      const applied=(await db.query('SELECT id,checksum,checksum_provenance FROM schema_migrations ORDER BY id')).rows;
      return {...identity,missing:validateInventory(inventory,applied),appliedCount:applied.length,durabilityRequired:policy.durability_required};
    });
    console.log(JSON.stringify({event:'admin_dashboard_migration_preflight',sourceSha:expectedSource,mode,baselineInventorySha256:BASELINE_INVENTORY_SHA256,...baseline,...(recovery?{recovery}:{}),runtimePrivilegeVerification:'REQUIRES_SEPARATE_RUNTIME_LOGIN'}));
    if(mode==='--inspect')return;
    interrupted();
    if(baseline.missing.length){
      phase='temporary_authority';temporaryLogin=`pp_admin_migrate_${randomBytes(8).toString('hex')}`;
      const password=randomBytes(32).toString('hex'),salt=randomBytes(24),salted=pbkdf2Sync(password,salt,4096,32,'sha256');
      const storedKey=createHash('sha256').update(createHmac('sha256',salted).update('Client Key').digest()).digest('base64');
      const serverKey=createHmac('sha256',salted).update('Server Key').digest('base64');
      const verifier=`SCRAM-SHA-256$4096:${salt.toString('base64')}$${storedKey}:${serverKey}`;
      const expires=new Date(Date.now()+15*60_000).toISOString(),role=pg.escapeIdentifier(temporaryLogin);
      await withTemporaryAuthority({
        create:async()=>{interrupted();creationAttempted=true;await transaction(db=>db.query(`CREATE ROLE ${role} LOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS CONNECTION LIMIT 2 PASSWORD ${pg.escapeLiteral(verifier)} VALID UNTIL ${pg.escapeLiteral(expires)}`));creationAcknowledged=true;},
        grant:()=>transaction(async db=>{
          interrupted();
          const reverse=(await db.query('SELECT 1 FROM pg_auth_members m JOIN pg_roles parent ON parent.oid=m.roleid JOIN pg_roles member ON member.oid=m.member WHERE parent.rolname=$1 AND member.rolname=$2',[temporaryLogin,OWNER_ROLE])).rows;
          if(reverse.length)fail('MIGRATION_AUTHORITY_TOPOLOGY_CHANGED');
          await db.query(`GRANT ${pg.escapeIdentifier(OWNER_ROLE)} TO ${role} WITH ADMIN FALSE, INHERIT FALSE, SET TRUE`);
          const bindings=(await db.query('SELECT parent.rolname,m.admin_option,m.inherit_option,m.set_option FROM pg_auth_members m JOIN pg_roles parent ON parent.oid=m.roleid JOIN pg_roles member ON member.oid=m.member WHERE member.rolname=$1',[temporaryLogin])).rows;
          if(bindings.length!==1 || bindings[0].rolname!==OWNER_ROLE || bindings[0].admin_option!==false || bindings[0].inherit_option!==false || bindings[0].set_option!==true)fail('MIGRATION_AUTHORITY_SCOPE_MISMATCH');
        }),
        run:async()=>{
          interrupted();const childEnv=temporaryDatabaseEnvironment(env,config.databaseUrl,temporaryLogin,password);
          const separate=createPgDatabase(childEnv.DATABASE_URL,undefined,childEnv);
          try{
            const identity=(await separate.db.query('SELECT current_user AS role,session_user AS login,current_schema() AS schema,current_database() AS database')).rows[0];
            if(identity?.role!==OWNER_ROLE || identity?.login!==temporaryLogin || identity?.schema!=='public')fail('SEPARATE_LOGIN_VERIFICATION_FAILED');
            if(identity.database!==baseline.identity.database||identity.database!==DATABASE_TARGET.database)fail('DATABASE_TARGET_MISMATCH');
            const tls=(await separate.db.query('SELECT ssl,version FROM pg_stat_ssl WHERE pid=pg_backend_pid()')).rows[0];
            if(tls?.ssl!==true || !['TLSv1.2','TLSv1.3'].includes(tls.version))fail('VERIFIED_DATABASE_TLS_REQUIRED');
          }finally{await separate.close();}
          phase='controlled_migration';await runNormalMigrator(childEnv,abort.signal);
        },
        cleanup:async()=>{
          try{
            // Never DROP OWNED/REASSIGN OWNED or alter any runtime membership.
            await transaction(async db=>{await db.query(`DROP ROLE ${role}`);if((await db.query('SELECT 1 FROM pg_roles WHERE rolname=$1',[temporaryLogin])).rows.length)fail('TEMPORARY_LOGIN_STILL_PRESENT');});
            console.log(JSON.stringify({event:'admin_dashboard_migration_login_removed'}));
          }catch{cleanupRequired=true;fail('TEMPORARY_LOGIN_CLEANUP_REQUIRED');}
        },
      });
    }
    interrupted();phase='verify';await assertSchemaCurrent(opened.db);
    const verification=await transaction(async db=>{
      await db.query('SET TRANSACTION READ ONLY');const identity=await readIdentity(db);
      const allApplied=(await db.query('SELECT id,checksum,checksum_provenance FROM schema_migrations ORDER BY id')).rows;
      if(validateInventory(inventory,allApplied).length)fail('MIGRATION_STILL_PENDING');
      const applied=allApplied.filter(row=>Object.hasOwn(MIGRATIONS,row.id));
      if(applied.length!==Object.keys(MIGRATIONS).length || applied.some(row=>row.checksum!==MIGRATIONS[row.id]||row.checksum_provenance!=='EXECUTED_BYTES'))fail('ADMIN_MIGRATION_RECEIPT_MISMATCH');
      const tables=(await db.query("SELECT tablename,tableowner FROM pg_tables WHERE schemaname='public' AND tablename=ANY($1::text[]) ORDER BY tablename",[NEW_TABLES])).rows;
      if(tables.length!==NEW_TABLES.length || tables.some(row=>row.tableowner!==OWNER_ROLE))fail('NEW_TABLE_OWNER_MISMATCH');
      const policy=(await db.query('SELECT durability_required FROM policy_recovery_fence WHERE singleton=1')).rows[0];
      if(policy?.durability_required!==baseline.durabilityRequired || policy.durability_required!==(config.requireDurableReceipts===true))fail('DURABILITY_POLICY_MISMATCH');
      return {...identity,applied,tables,migrationCount:inventory.length,durabilityRequired:policy.durability_required};
    });
    console.log(JSON.stringify({event:'admin_dashboard_migration_verified',sourceSha:expectedSource,separateLogin:baseline.missing.length>0,...verification,runtimePrivilegeVerification:'REQUIRES_SEPARATE_RUNTIME_LOGIN'}));
  }catch(error){
    if(creationAttempted&&!creationAcknowledged)cleanupRequired=true; // Uncertain commit requires operator inspection; never drop a possibly pre-existing role.
    console.log(JSON.stringify({event:'admin_dashboard_migration_failed',phase,code:error instanceof ControlledMigrationError?error.safeCode:'MIGRATION_FAILED',...(cleanupRequired?{cleanupRequired:true,temporaryLogin}:{})}));
    process.exitCode=1;
  }finally{process.removeListener('SIGTERM',stop);process.removeListener('SIGINT',stop);await opened.close();}
}

if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
  main().catch(()=>{console.log(JSON.stringify({event:'admin_dashboard_migration_failed',code:'PREFLIGHT_FAILED'}));process.exitCode=1;});
}
