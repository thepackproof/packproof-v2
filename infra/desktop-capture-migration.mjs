/**
 * Reviewed one-shot desktop capture migration runner, candidate container only.
 * --inspect performs database reads only. --apply runs the normal migrator under
 * a separate expiring login that may SET only the existing fixed owner role.
 * This does not create/cut over runtime credentials or verify runtime authority.
 */
import { createHash, createHmac, pbkdf2Sync, randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';

export const OWNER_ROLE = 'packproof';
export const DATABASE_TARGET=Object.freeze({instance:'packproof-v2-staging-db',host:'packproof-v2-staging-db.c8v2esku2zyt.us-east-1.rds.amazonaws.com',port:5432,database:'packproof_v2',region:'us-east-1'});
export const EXPECTED_SOURCE_SHA='d45727b8648ade030642a011c280c10bce525591';
export const BASELINE_COUNT = 74; // Full existing inventory through073, including both027 receipts.
export const BASELINE_INVENTORY_SHA256 = 'bdf67730e4b82223593005cfbe7c1317e04d5654175193bc9bb49bb622531d53';
export const MIGRATIONS=Object.freeze({'074_desktop_capture_registration':'3d598d733ab8aaf375fc793446b2ed732b42c2bcb9c47fc732af57c9eade692a'});
const ROLE_PATTERN = /^pp_desktop_migrate_[0-9a-f]{16}$/;
class ControlledMigrationError extends Error {
  constructor(code) { super(code); this.safeCode = code; }
}
const fail = code => { throw new ControlledMigrationError(code); };
export const digest=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const normalizedDefinition=value=>value.replace(/\s+/g,' ').trim();
const definitionHash=value=>createHash('sha256').update(normalizedDefinition(value)).digest('hex');
export const EXPECTED_DEFINITIONS=Object.freeze({
  capture_sessions_client_check:"CHECK ((client = ANY (ARRAY['WEB_CAMERA'::text, 'NATIVE_CAMERA'::text, 'DESKTOP_CAMERA'::text])))",
  capture_identifier_policy_valid:"CHECK (((identifier_policy IS NULL) OR (((identifier_policy ->> 'version'::text) = '1'::text) AND ((identifier_policy ->> 'surface'::text) = ANY (ARRAY['ANDROID'::text, 'IOS'::text, 'WEB'::text, 'WAREHOUSE'::text, 'DESKTOP'::text])))))",
  desktop_capture_context_valid:"CHECK ((((client = 'DESKTOP_CAMERA'::text) AND (desktop_context IS NOT NULL) AND ((desktop_context ->> 'schemaVersion'::text) = '1'::text) AND ((desktop_context ->> 'platform'::text) = ANY (ARRAY['win32'::text, 'darwin'::text])) AND (policy_version = 'packproof.desktop-client-capture/v1'::text) AND (stage_id IS NULL)) OR ((client <> 'DESKTOP_CAMERA'::text) AND (desktop_context IS NULL))))",
  desktop_capture_context_guard:'CREATE TRIGGER desktop_capture_context_guard BEFORE UPDATE ON public.capture_sessions FOR EACH ROW EXECUTE FUNCTION protect_desktop_capture_context()',
  protect_desktop_capture_context:"CREATE OR REPLACE FUNCTION public.protect_desktop_capture_context() RETURNS trigger LANGUAGE plpgsql AS $function$ BEGIN IF OLD.desktop_context IS DISTINCT FROM NEW.desktop_context THEN RAISE EXCEPTION 'DESKTOP_CAPTURE_CONTEXT_IMMUTABLE'; END IF; RETURN NEW; END; $function$",
});
export const BASELINE_DEFINITIONS=Object.freeze({
  capture_sessions_client_check:"CHECK ((client = ANY (ARRAY['WEB_CAMERA'::text, 'NATIVE_CAMERA'::text])))",
  capture_identifier_policy_valid:"CHECK (((identifier_policy IS NULL) OR (((identifier_policy ->> 'version'::text) = '1'::text) AND ((identifier_policy ->> 'surface'::text) = ANY (ARRAY['ANDROID'::text, 'IOS'::text, 'WEB'::text, 'WAREHOUSE'::text])))))",
});
/** Catalog reads only. No DDL or data writes are reachable from inspect. */
export async function readCaptureSchema(db){
  const owner=(await db.query("SELECT tableowner FROM pg_tables WHERE schemaname='public' AND tablename='capture_sessions'")).rows[0]?.tableowner;
  const columns=(await db.query("SELECT a.attname AS name,format_type(a.atttypid,a.atttypmod) AS type,a.attnotnull AS not_null,a.attacl::text AS acl,pg_get_expr(d.adbin,d.adrelid) AS default_value FROM pg_attribute a LEFT JOIN pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum WHERE a.attrelid='public.capture_sessions'::regclass AND a.attnum>0 AND NOT a.attisdropped ORDER BY a.attnum")).rows;
  const constraints=(await db.query("SELECT conname AS name,contype AS type,convalidated AS validated,pg_get_constraintdef(oid,false) AS definition FROM pg_constraint WHERE conrelid='public.capture_sessions'::regclass ORDER BY conname")).rows;
  const triggers=(await db.query("SELECT t.tgname AS name,t.tgenabled AS enabled,pg_get_triggerdef(t.oid,false) AS definition,pg_get_functiondef(t.tgfoid) AS function_definition,pg_get_userbyid(p.proowner) AS function_owner,p.prosecdef AS security_definer,p.proconfig AS function_config FROM pg_trigger t JOIN pg_proc p ON p.oid=t.tgfoid WHERE t.tgrelid='public.capture_sessions'::regclass AND NOT t.tgisinternal ORDER BY t.tgname")).rows;
  const functions=(await db.query("SELECT p.proname AS name,pg_get_userbyid(p.proowner) AS owner,pg_get_functiondef(p.oid) AS definition,p.prosecdef AS security_definer,p.proconfig AS config,pg_get_function_identity_arguments(p.oid) AS arguments FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname='protect_desktop_capture_context' ORDER BY p.oid")).rows;
  const runtimeColumnPrivileges=columns.some(row=>row.name==='desktop_context')?(await db.query("SELECT has_column_privilege('packproof_runtime','public.capture_sessions','desktop_context','SELECT') AS can_select,has_column_privilege('packproof_runtime','public.capture_sessions','desktop_context','INSERT') AS can_insert,has_column_privilege('packproof_runtime','public.capture_sessions','desktop_context','UPDATE') AS can_update")).rows[0]:null;
  return {owner,columns,constraints,triggers,functions,runtimeColumnPrivileges};
}
export function captureChecksums(schema){
  return Object.fromEntries([...schema.constraints,...schema.triggers,...schema.functions].map(row=>[row.name,definitionHash(row.definition)]));
}
export function validateCaptureSchema(schema,complete){
  if(schema.owner!==OWNER_ROLE)fail('CAPTURE_TABLE_OWNER_MISMATCH');
  const required=complete?EXPECTED_DEFINITIONS:BASELINE_DEFINITIONS;
  const all=[...schema.constraints,...schema.triggers,...schema.functions];
  for(const [name,definition]of Object.entries(required)){
    const rows=all.filter(row=>row.name===name);
    if(rows.length!==1||definitionHash(rows[0].definition)!==definitionHash(definition))fail('CAPTURE_DEFINITION_MISMATCH');
    if(Object.hasOwn(rows[0],'validated')&&(rows[0].validated!==true||rows[0].type!=='c'))fail('CAPTURE_CONSTRAINT_NOT_VALIDATED');
  }
  const desktopColumns=schema.columns.filter(row=>row.name==='desktop_context');
  if(complete){
    if(desktopColumns.length!==1||desktopColumns[0].type!=='jsonb'||desktopColumns[0].not_null!==false||desktopColumns[0].default_value!==null||desktopColumns[0].acl!==null)fail('DESKTOP_CONTEXT_COLUMN_MISMATCH');
    const trigger=schema.triggers.find(row=>row.name==='desktop_capture_context_guard');
    const fn=schema.functions[0];
    if(schema.functions.length!==1||fn.owner!==OWNER_ROLE||fn.security_definer!==false||fn.config!==null||fn.arguments!==''||trigger.enabled!=='O'||trigger.function_owner!==OWNER_ROLE||trigger.security_definer!==false||trigger.function_config!==null||definitionHash(trigger.function_definition)!==definitionHash(EXPECTED_DEFINITIONS.protect_desktop_capture_context))fail('DESKTOP_GUARD_AUTHORITY_MISMATCH');
    if(!schema.runtimeColumnPrivileges||Object.values(schema.runtimeColumnPrivileges).some(value=>value!==true))fail('EXISTING_RUNTIME_COLUMN_PRIVILEGE_MISMATCH');
  }else if(desktopColumns.length||schema.functions.length||all.some(row=>['desktop_capture_context_guard','desktop_capture_context_valid'].includes(row.name)))fail('UNRECEIPTED_DESKTOP_SCHEMA');
}
export function assertRetainedBaseline(before,after){
  const unchanged=schema=>({owner:schema.owner,columns:schema.columns.filter(row=>row.name!=='desktop_context'),constraints:schema.constraints.filter(row=>!Object.hasOwn(EXPECTED_DEFINITIONS,row.name)),triggers:schema.triggers.filter(row=>row.name!=='desktop_capture_context_guard')});
  if(digest(unchanged(before))!==digest(unchanged(after)))fail('EXISTING_CAPTURE_PROTECTION_CHANGED');
}
/** Privilege/RLS boundary snapshot, excluding only the new trigger function. */
export async function readPrivilegeBoundary(db){
  const queries={
    roles:"SELECT rolname,rolsuper,rolinherit,rolcreaterole,rolcreatedb,rolcanlogin,rolreplication,rolbypassrls,rolconnlimit,rolvaliduntil::text,rolconfig FROM pg_roles ORDER BY rolname",
    memberships:"SELECT parent.rolname AS parent,member.rolname AS member,m.admin_option,m.inherit_option,m.set_option FROM pg_auth_members m JOIN pg_roles parent ON parent.oid=m.roleid JOIN pg_roles member ON member.oid=m.member ORDER BY parent.rolname,member.rolname",
    relations:"SELECT c.relname,c.relkind,pg_get_userbyid(c.relowner) AS owner,c.relacl::text,c.relrowsecurity,c.relforcerowsecurity FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' ORDER BY c.relname",
    schemas:"SELECT nspname,pg_get_userbyid(nspowner) AS owner,nspacl::text FROM pg_namespace WHERE nspname='public'",
    defaults:"SELECT pg_get_userbyid(d.defaclrole) AS owner,n.nspname,d.defaclobjtype,d.defaclacl::text FROM pg_default_acl d LEFT JOIN pg_namespace n ON n.oid=d.defaclnamespace ORDER BY owner,n.nspname,d.defaclobjtype",
    functions:"SELECT p.proname,pg_get_function_identity_arguments(p.oid) AS arguments,pg_get_userbyid(p.proowner) AS owner,p.proacl::text,p.prosecdef,p.proconfig FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname<>'protect_desktop_capture_context' ORDER BY p.proname,arguments",
    policies:"SELECT schemaname,tablename,policyname,permissive,roles,cmd,qual,with_check FROM pg_policies WHERE schemaname='public' ORDER BY tablename,policyname",
  };
  const result={};for(const [name,sql]of Object.entries(queries))result[name]=(await db.query(sql)).rows;
  return result;
}
export function validateInspectionEvidence(env,expected,now=new Date()){
  const observed=env.PACKPROOF_DESKTOP_MIGRATION_INSPECTED_AT;
  if(env.PACKPROOF_DESKTOP_MIGRATION_INSPECTION_SHA256!==expected||!/^[a-f0-9]{64}$/.test(expected)||!observed||!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(observed)||!Number.isFinite(Date.parse(observed)))fail('PRIOR_READ_ONLY_INSPECTION_REQUIRED');
  const age=now.getTime()-Date.parse(observed);if(age< -60_000||age>60*60_000)fail('PRIOR_INSPECTION_STALE');
}
export const inventoryDigest = rows => createHash('sha256').update(JSON.stringify(
  rows.map(({id, checksum}) => ({id, checksum})).sort((a,b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
)).digest('hex');

export function validateInventory(inventory, applied) {
  if (!Array.isArray(inventory) || !Array.isArray(applied) || [...inventory,...applied].some(row =>
    !row || typeof row.id !== 'string' || !/^\d{3}_[a-z0-9_]+$/.test(row.id) || !/^[a-f0-9]{64}$/.test(row.checksum ?? ''))) fail('INVALID_MIGRATION_INVENTORY');
  const files = new Map(inventory.map(row => [row.id,row]));
  if (files.size !== inventory.length || new Set(applied.map(row=>row.id)).size !== applied.length) fail('DUPLICATE_MIGRATION_ID');
  if (inventory.length !== BASELINE_COUNT + Object.keys(MIGRATIONS).length) fail('UNEXPECTED_SOURCE_INVENTORY');
  for (const [id, hash] of Object.entries(MIGRATIONS)) if (files.get(id)?.checksum !== hash) fail('DESKTOP_MIGRATION_SOURCE_MISMATCH');
  const baseline = inventory.filter(row => !Object.hasOwn(MIGRATIONS,row.id));
  if (baseline.length !== BASELINE_COUNT || inventoryDigest(baseline) !== BASELINE_INVENTORY_SHA256) fail('SOURCE_BASELINE_MISMATCH');
  for (const row of applied) {
    if (!files.has(row.id) || files.get(row.id).checksum !== row.checksum) fail('MIGRATION_BASELINE_MISMATCH');
    if (Object.hasOwn(MIGRATIONS,row.id) && row.checksum_provenance !== 'EXECUTED_BYTES') fail('DESKTOP_MIGRATION_RECEIPT_MISMATCH');
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
  if (!env.PACKPROOF_DESKTOP_MIGRATION_DATABASE_URL?.trim()) fail('SEPARATE_OPERATOR_DATABASE_REQUIRED');
  const url = ownerUrl(env.PACKPROOF_DESKTOP_MIGRATION_DATABASE_URL);
  const secret = env.PACKPROOF_DESKTOP_MIGRATION_DB_SECRET_ARN?.trim();
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
  for (const key of Object.keys(child)) if (key.startsWith('PACKPROOF_ADMIN_') || key.startsWith('PACKPROOF_DESKTOP_MIGRATION_')) delete child[key];
  for (const key of ['PACKPROOF_DB_PASSWORD','PGPASSWORD','PGUSER','PGHOST','PGPORT','PGDATABASE','PACKPROOF_DB_USER','PGOPTIONS','PGSERVICE','PGSERVICEFILE','NODE_OPTIONS','NODE_PATH']) delete child[key];
  // Empty/false sentinels prevent the normal CLI's loadEnvFile from reviving a
  // master-secret callback or checksum-adoption switch from an image .env file.
  child.PACKPROOF_DB_SECRET_ARN = '';
  child.PACKPROOF_ADOPT_LEGACY_MIGRATION_CHECKSUMS = 'false';
  return child;
}

/** Evidence is operator-attested, not a claim that this module queried RDS. */
export function recoveryEvidence(env, now = new Date()) {
  const timestamp = env.PACKPROOF_DESKTOP_MIGRATION_RECOVERY_POINT;
  const database = env.PACKPROOF_DESKTOP_MIGRATION_RECOVERY_DB_ID;
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
  if(args.length!==2 || !['--inspect','--apply'].includes(args[0]) || args[1]!==EXPECTED_SOURCE_SHA) fail('EXPECTED_MODE_AND_SOURCE_SHA');
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
      const missing=validateInventory(inventory,applied),capture=await readCaptureSchema(db),boundary=await readPrivilegeBoundary(db);
      validateCaptureSchema(capture,missing.length===0);
      const receipt={sourceSha:expectedSource,baselineInventorySha256:BASELINE_INVENTORY_SHA256,missing,capture,boundary,durabilityRequired:policy.durability_required};
      return {...identity,missing,appliedCount:applied.length,durabilityRequired:policy.durability_required,capture,boundary,inspectionSha256:digest(receipt)};
    });
    console.log(JSON.stringify({event:'desktop_capture_migration_preflight',sourceSha:expectedSource,mode,baselineInventorySha256:BASELINE_INVENTORY_SHA256,identity:baseline.identity,tls:baseline.tls,missing:baseline.missing,appliedCount:baseline.appliedCount,durabilityRequired:baseline.durabilityRequired,captureDefinitionChecksums:captureChecksums(baseline.capture),privilegeBoundarySha256:digest(baseline.boundary),inspectionSha256:baseline.inspectionSha256,inspectedAt:new Date().toISOString(),...(recovery?{recovery}:{}),runtimePrivilegeVerification:'REQUIRES_SEPARATE_RUNTIME_LOGIN'}));
    if(mode==='--inspect')return;
    validateInspectionEvidence(env,baseline.inspectionSha256);
    interrupted();
    if(baseline.missing.length){
      phase='temporary_authority';temporaryLogin=`pp_desktop_migrate_${randomBytes(8).toString('hex')}`;
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
            console.log(JSON.stringify({event:'desktop_capture_migration_login_removed'}));
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
      if(applied.length!==Object.keys(MIGRATIONS).length || applied.some(row=>row.checksum!==MIGRATIONS[row.id]||row.checksum_provenance!=='EXECUTED_BYTES'))fail('DESKTOP_MIGRATION_RECEIPT_MISMATCH');
      const capture=await readCaptureSchema(db),boundary=await readPrivilegeBoundary(db);
      validateCaptureSchema(capture,true);assertRetainedBaseline(baseline.capture,capture);
      if(digest(boundary)!==digest(baseline.boundary))fail('PRIVILEGE_BOUNDARY_CHANGED');
      const policy=(await db.query('SELECT durability_required FROM policy_recovery_fence WHERE singleton=1')).rows[0];
      if(policy?.durability_required!==baseline.durabilityRequired || policy.durability_required!==(config.requireDurableReceipts===true))fail('DURABILITY_POLICY_MISMATCH');
      return {...identity,applied,captureDefinitionChecksums:captureChecksums(capture),privilegeBoundarySha256:digest(boundary),migrationCount:inventory.length,durabilityRequired:policy.durability_required};
    });
    console.log(JSON.stringify({event:'desktop_capture_migration_verified',sourceSha:expectedSource,separateLogin:baseline.missing.length>0,...verification,runtimePrivilegeVerification:'REQUIRES_SEPARATE_RUNTIME_LOGIN'}));
  }catch(error){
    if(creationAttempted&&!creationAcknowledged)cleanupRequired=true; // Uncertain commit requires operator inspection; never drop a possibly pre-existing role.
    console.log(JSON.stringify({event:'desktop_capture_migration_failed',phase,code:error instanceof ControlledMigrationError?error.safeCode:'MIGRATION_FAILED',...(cleanupRequired?{cleanupRequired:true,temporaryLogin}:{})}));
    process.exitCode=1;
  }finally{process.removeListener('SIGTERM',stop);process.removeListener('SIGINT',stop);await opened.close();}
}

if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
  main().catch(()=>{console.log(JSON.stringify({event:'desktop_capture_migration_failed',code:'PREFLIGHT_FAILED'}));process.exitCode=1;});
}
