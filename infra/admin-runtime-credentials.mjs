/**
 * One-shot database credential preparation. This does not switch an ECS service.
 * Run only in the pinned candidate container with owner credentials and the NEW
 * password separately injected by ECS. Never fetch a secret, pass one in argv,
 * print a connection string, or reset an existing login's password on retry.
 *
 * node /tmp/admin-runtime-credentials.mjs --inspect|--apply SOURCE_SHA \
 *   SCHEMA_INVENTORY_SHA256 RUNTIME_ROLES_SQL_SHA256 /tmp/runtime-roles.sql
 * Inventory digest: SHA256(JSON.stringify(sorted [{id,checksum}, ...])).
 */
import {createHash,createHmac,pbkdf2Sync,randomBytes} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {pathToFileURL} from 'node:url';

export const OWNER_ROLE='packproof';
export const RUNTIME_ROLE='packproof_app_runtime_v1';
export const DATABASE_TARGET=Object.freeze({host:'packproof-v2-staging-db.c8v2esku2zyt.us-east-1.rds.amazonaws.com',port:5432,database:'packproof_v2',region:'us-east-1',environment:'staging'});
export const GROUP_ROLES=Object.freeze(['packproof_runtime','packproof_recovery','packproof_backup','packproof_maintenance']);
export const APPLICATION_GROUPS=Object.freeze(['packproof_runtime','packproof_recovery']);
class CredentialSetupError extends Error { constructor(code){super(code);this.safeCode=code;} }
const fail=code=>{throw new CredentialSetupError(code);};
const digest=value=>createHash('sha256').update(value).digest('hex');
const quoteIdentifier=value=>'"'+value.replaceAll('"','""')+'"';
const quoteLiteral=value=>"'"+value.replaceAll("'","''")+"'";
export const inventoryDigest=rows=>digest(JSON.stringify(rows.map(({id,checksum})=>({id,checksum})).sort((a,b)=>a.id<b.id?-1:a.id>b.id?1:0)));

export function parseArguments(args){
  if(args.length!==5||!['--inspect','--apply'].includes(args[0])||!/^([a-f0-9]{40})$/.test(args[1])||
    !/^[a-f0-9]{64}$/.test(args[2])||!/^[a-f0-9]{64}$/.test(args[3])||!args[4].startsWith('/')||args[4].includes('\0'))fail('EXPECTED_MODE_AND_REVIEWED_PINS');
  return{mode:args[0],sourceSha:args[1],schemaSha256:args[2],rolesSqlSha256:args[3],rolesSqlPath:args[4]};
}

function databaseUrl(value,username){
  let url;try{url=new URL(value);}catch{fail('INVALID_DATABASE_COORDINATES');}
  if(!['postgres:','postgresql:'].includes(url.protocol)||!url.hostname||url.pathname.length<2||url.hash)fail('INVALID_DATABASE_COORDINATES');
  let actual;try{actual=decodeURIComponent(url.username);}catch{fail('INVALID_DATABASE_COORDINATES');}
  if(actual!==username||!url.password)fail('INJECTED_DATABASE_CREDENTIALS_REQUIRED');
  // A libpq URL query can override its authority coordinates; preserve ordinary
  // settings, but never carry an alternate password/user or role into this run.
  const allowed=new Set(['sslmode','sslrootcert','sslcert','sslkey','application_name','connect_timeout','options']);
  const keys=[...url.searchParams.keys()];
  if(keys.some(key=>!allowed.has(key))||new Set(keys).size!==keys.length)fail('UNREVIEWED_DATABASE_URL_OPTION');
  const options=url.searchParams.get('options')??'';
  if(options&& !/^(?:\s*-c\s+(?:statement_timeout|lock_timeout|idle_in_transaction_session_timeout)=\d+(?:ms|s|min)?\s*)+$/.test(options))fail('UNREVIEWED_DATABASE_SESSION_OPTION');
  return url;
}

export function assertDatabaseTarget(value){
  const url=databaseUrl(value,OWNER_ROLE);let name;
  try{name=decodeURIComponent(url.pathname.slice(1));}catch{fail('INVALID_DATABASE_COORDINATES');}
  if(url.hostname!==DATABASE_TARGET.host||Number(url.port||5432)!==DATABASE_TARGET.port||name!==DATABASE_TARGET.database)fail('DATABASE_TARGET_MISMATCH');
  return DATABASE_TARGET;
}

/** Disables the inherited Secrets Manager callback; uses only injected bytes. */
export function ownerDatabaseEnvironment(env){
  if(Object.entries(env).some(([key,value])=>value&&(key.startsWith('PG')||['NODE_OPTIONS','NODE_PATH'].includes(key))))fail('UNREVIEWED_AMBIENT_DATABASE_CONFIGURATION');
  const selected={...env,PACKPROOF_DB_SECRET_ARN:''};
  // Never allow libpq ambient configuration to inject a different authority.
  for(const key of ['PGUSER','PGPASSWORD','PGHOST','PGPORT','PGDATABASE','PGOPTIONS','PGSERVICE','PGSERVICEFILE'])delete selected[key];
  if(env.NODE_TLS_REJECT_UNAUTHORIZED==='0')fail('VERIFIED_DATABASE_TLS_REQUIRED');
  return selected;
}

export function validateNewCredentials(env){
  if(env.PACKPROOF_NEW_RUNTIME_USERNAME!==RUNTIME_ROLE)fail('FIXED_RUNTIME_USERNAME_REQUIRED');
  const password=env.PACKPROOF_NEW_RUNTIME_PASSWORD;
  // Random printable ASCII avoids SASLprep ambiguity in locally derived SCRAM.
  if(typeof password!=='string'||! /^[\x21-\x7e]{32,256}$/.test(password))fail('INJECTED_RUNTIME_PASSWORD_REQUIRED');
  return password;
}

export function runtimeDatabaseEnvironment(env,ownerUrl){
  const password=validateNewCredentials(env),url=databaseUrl(ownerUrl,OWNER_ROLE);
  url.username=RUNTIME_ROLE;url.password=password;
  const selected={...ownerDatabaseEnvironment(env),DATABASE_URL:url.toString(),PACKPROOF_DB_USER:RUNTIME_ROLE,PACKPROOF_DB_PASSWORD:password};
  for(const key of Object.keys(selected))if(key.startsWith('PACKPROOF_ADMIN_')||key.startsWith('PACKPROOF_MIGRATION_')||key.startsWith('PACKPROOF_NEW_RUNTIME_'))delete selected[key];
  selected.PACKPROOF_ADOPT_LEGACY_MIGRATION_CHECKSUMS='false';
  return selected;
}

export function scramVerifier(password,salt=randomBytes(24)){
  validateNewCredentials({PACKPROOF_NEW_RUNTIME_USERNAME:RUNTIME_ROLE,PACKPROOF_NEW_RUNTIME_PASSWORD:password});
  if(!Buffer.isBuffer(salt)||salt.length<16)fail('INVALID_SCRAM_SALT');
  const salted=pbkdf2Sync(password,salt,4096,32,'sha256');
  const storedKey=createHash('sha256').update(createHmac('sha256',salted).update('Client Key').digest()).digest('base64');
  const serverKey=createHmac('sha256',salted).update('Server Key').digest('base64');
  return`SCRAM-SHA-256$4096:${salt.toString('base64')}$${storedKey}:${serverKey}`;
}

export function validateInventory(inventory,applied,expectedHash){
  for(const rows of [inventory,applied]){
    if(!Array.isArray(rows)||!rows.length||rows.some(row=>!/^\d{3}_[a-z0-9_]+$/.test(row.id??'')||!/^[a-f0-9]{64}$/.test(row.checksum??''))||new Set(rows.map(row=>row.id)).size!==rows.length)fail('INVALID_SCHEMA_INVENTORY');
    if(inventoryDigest(rows)!==expectedHash)fail('PINNED_SCHEMA_MISMATCH');
  }
}

/** No password/verifier/catalog pg_authid reads. Counts and ACLs are safe output. */
export async function inspectAuthority(db,{requireRuntime=false}={}){
  const names=[...GROUP_ROLES,RUNTIME_ROLE];
  const roles=(await db.query(`SELECT rolname,rolsuper,rolinherit,rolcreaterole,rolcreatedb,rolcanlogin,rolreplication,rolbypassrls,rolvaliduntil,rolconfig FROM pg_roles WHERE rolname=ANY($1::text[]) ORDER BY rolname`,[names])).rows;
  for(const role of roles){
    if(role.rolsuper||role.rolcreaterole||role.rolcreatedb||role.rolreplication||role.rolbypassrls||!role.rolinherit||role.rolcanlogin!==(role.rolname===RUNTIME_ROLE)||role.rolvaliduntil!==null||role.rolconfig!==null)fail('UNSAFE_EXISTING_ROLE_ATTRIBUTES');
  }
  const bindings=(await db.query(`SELECT parent.rolname AS parent,member.rolname AS member,m.admin_option,m.inherit_option,m.set_option FROM pg_auth_members m JOIN pg_roles parent ON parent.oid=m.roleid JOIN pg_roles member ON member.oid=m.member WHERE member.rolname=ANY($1::text[]) OR parent.rolname=ANY($1::text[]) ORDER BY member.rolname,parent.rolname`,[names])).rows;
  // Reject all transitive authority at its first edge: groups must have no
  // parents; this login must have exactly the two reviewed terminal groups.
  for(const binding of bindings)if(binding.member!==RUNTIME_ROLE||!APPLICATION_GROUPS.includes(binding.parent)||binding.admin_option!==false||binding.inherit_option!==true||binding.set_option!==true)fail('UNSAFE_ROLE_MEMBERSHIP_GRAPH');
  const runtimeExists=roles.some(role=>role.rolname===RUNTIME_ROLE);
  if((requireRuntime||runtimeExists)&&(roles.length!==names.length||bindings.length!==APPLICATION_GROUPS.length))fail('INCOMPLETE_RUNTIME_AUTHORITY');
  const owned=(await db.query(`SELECT count(*)::int AS count FROM pg_shdepend d JOIN pg_roles r ON r.oid=d.refobjid WHERE d.refclassid='pg_authid'::regclass AND d.deptype='o' AND r.rolname=ANY($1::text[])`,[names])).rows[0];
  if(owned?.count!==0)fail('APPLICATION_ROLE_OWNS_DATABASE_OBJECTS');
  // Database/role-specific SET role, search_path or hook settings are not part
  // of the reviewed baseline and could alter a newly opened connection.
  const settings=(await db.query(`SELECT count(*)::int AS count FROM pg_db_role_setting s JOIN pg_roles r ON r.oid=s.setrole WHERE r.rolname=ANY($1::text[])`,[names])).rows[0];
  if(settings?.count!==0)fail('UNREVIEWED_ROLE_DATABASE_SETTINGS');
  return{runtimeExists,roles:roles.map(({rolname})=>rolname),bindings};
}

export async function inspectObjects(db){
  const objects=(await db.query(`SELECT c.relname,c.relkind,r.rolname AS owner FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace JOIN pg_roles r ON r.oid=c.relowner WHERE n.nspname='public' AND c.relkind IN ('r','p','S','v','m','f') ORDER BY c.relname`)).rows;
  if(!objects.length||objects.some(row=>row.owner!==OWNER_ROLE))fail('PUBLIC_OBJECT_OWNER_MISMATCH');
  const functions=(await db.query(`SELECT p.oid::regprocedure::text AS name,r.rolname AS owner,p.prosecdef AS security_definer,EXISTS(SELECT 1 FROM aclexplode(COALESCE(p.proacl,acldefault('f',p.proowner))) acl WHERE acl.grantee=0 AND acl.privilege_type='EXECUTE') AS public_execute FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace JOIN pg_roles r ON r.oid=p.proowner WHERE n.nspname='public' ORDER BY p.oid::regprocedure::text`)).rows;
  if(functions.some(row=>row.security_definer||row.owner!==OWNER_ROLE))fail('UNREVIEWED_FUNCTION_AUTHORITY');
  return{publicTables:objects.filter(row=>['r','p'].includes(row.relkind)).length,publicSequences:objects.filter(row=>row.relkind==='S').length,publicFunctions:functions.length,securityDefiners:0,publicExecutableInvokerFunctions:functions.filter(row=>row.public_execute).length};
}

const APPEND_ONLY=new Set(['final_manifests','audit_events','recovery_events','proof_supplements','policy_recovery_events','system_admin_audit_events','admin_command_receipts','billing_allowance_adjustments']);
const OPERATOR_ONLY=new Set(['schema_migrations','user_system_roles','recovery_writer_fence','policy_recovery_fence','policy_recovery_overlay','policy_recovery_tables']);
const DELIVERY=new Set(['recovery_delivery','policy_recovery_delivery']);
export function expectedTablePrivileges(table){
  return{SELECT:true,INSERT:!OPERATOR_ONLY.has(table),UPDATE:!OPERATOR_ONLY.has(table)&&!APPEND_ONLY.has(table),DELETE:!OPERATOR_ONLY.has(table)&&!APPEND_ONLY.has(table)&&!DELIVERY.has(table)&&table!=='client_version_activity',TRUNCATE:false,REFERENCES:false,TRIGGER:false};
}

/** Verify effective privileges (including PUBLIC/inheritance), not just grants. */
export async function verifyRuntimePrivileges(db){
  const tables=(await db.query(`SELECT c.relname,privilege,has_table_privilege($1,c.oid,privilege) AS allowed FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace CROSS JOIN unnest(ARRAY['SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER']) privilege WHERE n.nspname='public' AND c.relkind IN ('r','p','v','m','f') ORDER BY c.relname,privilege`,[RUNTIME_ROLE])).rows;
  if(!tables.length||tables.some(row=>row.allowed!==expectedTablePrivileges(row.relname)[row.privilege]))fail('RUNTIME_TABLE_PRIVILEGE_MISMATCH');
  const columns=(await db.query(`SELECT c.relname,a.attname,privilege,has_column_privilege($1,c.oid,a.attnum,privilege) AS allowed FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace JOIN pg_attribute a ON a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped CROSS JOIN unnest(ARRAY['INSERT','UPDATE','REFERENCES']) privilege WHERE n.nspname='public' AND c.relname=ANY($2::text[])`,[RUNTIME_ROLE,[...OPERATOR_ONLY,...APPEND_ONLY]])).rows;
  for(const row of columns){
    const expected=row.privilege==='INSERT'&&!OPERATOR_ONLY.has(row.relname)||row.privilege==='UPDATE'&&(row.relname==='recovery_writer_fence'&&row.attname==='singleton'||row.relname==='policy_recovery_fence'&&['reconciled_sequence','reconciled_head_sha256'].includes(row.attname));
    if(row.allowed!==expected)fail('RUNTIME_COLUMN_PRIVILEGE_MISMATCH');
  }
  const sequences=(await db.query(`SELECT c.relname,privilege,has_sequence_privilege($1,c.oid,privilege) AS allowed FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace CROSS JOIN unnest(ARRAY['SELECT','USAGE','UPDATE']) privilege WHERE n.nspname='public' AND c.relkind='S'`,[RUNTIME_ROLE])).rows;
  if(sequences.some(row=>row.allowed!==(row.privilege!=='UPDATE')))fail('RUNTIME_SEQUENCE_PRIVILEGE_MISMATCH');
  const authority=(await db.query(`SELECT has_schema_privilege($1,'public','USAGE') AS schema_usage,has_schema_privilege($1,'public','CREATE') AS schema_create,has_database_privilege($1,current_database(),'CONNECT') AS database_connect,has_database_privilege($1,current_database(),'CREATE') AS database_create,pg_has_role($1,$2,'MEMBER') AS owner_member,pg_has_role($1,$2,'SET') AS owner_set`,[RUNTIME_ROLE,OWNER_ROLE])).rows[0];
  if(!authority?.schema_usage||authority.schema_create||!authority.database_connect||authority.database_create||authority.owner_member||authority.owner_set)fail('RUNTIME_DATABASE_AUTHORITY_MISMATCH');
  return{tableCount:tables.length/7,columnChecks:columns.length,sequenceCount:sequences.length/3,ownerMembership:false,ownerSetRole:false};
}

/** Each attempted write is rolled back, including an unexpectedly successful one. */
export async function probeDeniedAuthority(db){
  const probes=[
    ['ASSIGN_SYSTEM_ADMIN',"UPDATE public.user_system_roles SET role='SYSTEM_ADMIN' WHERE false"],
    ['ALTER_AUDIT',"UPDATE public.system_admin_audit_events SET reason='permission probe' WHERE false"],
    ['ALTER_SCHEMA_RECEIPT',"UPDATE public.schema_migrations SET checksum='permission probe' WHERE false"],
    ['REOPEN_RECOVERY',"UPDATE public.recovery_writer_fence SET writes_enabled=true WHERE false"],
    ['ALTER_POLICY_MODE',"UPDATE public.policy_recovery_fence SET mode='NORMAL' WHERE false"],
    ['CREATE_TABLE','CREATE TABLE public.packproof_runtime_permission_probe(id integer)'],
    ['DISABLE_TRIGGERS','ALTER TABLE public.users DISABLE TRIGGER ALL'],
    ['TRUNCATE_AUDIT','TRUNCATE TABLE public.system_admin_audit_events'],
    ['GRANT_OWNER',`GRANT ${quoteIdentifier(OWNER_ROLE)} TO ${quoteIdentifier(RUNTIME_ROLE)}`],
    ['SET_OWNER',`SET LOCAL ROLE ${quoteIdentifier(OWNER_ROLE)}`],
  ];
  await db.transaction(async tx=>{
    await tx.query("SET LOCAL lock_timeout='2s'");await tx.query("SET LOCAL statement_timeout='5s'");
    for(const [name,sql] of probes){
      await tx.query('SAVEPOINT permission_probe');let code=null;
      try{await tx.query(sql);}catch(error){code=error?.code;}
      finally{await tx.query('ROLLBACK TO SAVEPOINT permission_probe');await tx.query('RELEASE SAVEPOINT permission_probe');}
      if(code!=='42501')fail(`NEGATIVE_PRIVILEGE_PROBE_FAILED_${name}`);
    }
  });
  return{deniedProbes:probes.map(([name])=>name)};
}

/** Existing logins are authenticated BEFORE any mutation; no ALTER PASSWORD. */
export async function applyRuntimeRoles({db,sql,expectedSqlHash,splitStatements,password,verifyBaseline,verifyExistingLogin}){
  if(digest(sql)!==expectedSqlHash)fail('PINNED_RUNTIME_SQL_MISMATCH');
  validateNewCredentials({PACKPROOF_NEW_RUNTIME_USERNAME:RUNTIME_ROLE,PACKPROOF_NEW_RUNTIME_PASSWORD:password});
  const before=await inspectAuthority(db);
  if(before.runtimeExists)await verifyExistingLogin();
  return db.transaction(async tx=>{
    await tx.query("SET LOCAL lock_timeout='15s'");await tx.query("SET LOCAL statement_timeout='30s'");
    await tx.query('SELECT pg_advisory_xact_lock(1347438146,1)');
    await tx.query('SELECT pg_advisory_xact_lock(1347438146,74)');
    await verifyBaseline(tx);
    const current=await inspectAuthority(tx);
    if(current.runtimeExists!==before.runtimeExists)fail('CONCURRENT_RUNTIME_ROLE_CHANGE');
    for(const statement of splitStatements(sql))await tx.query(statement);
    if(!current.runtimeExists){
      const verifier=scramVerifier(password);
      await tx.query(`CREATE ROLE ${quoteIdentifier(RUNTIME_ROLE)} LOGIN INHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD ${quoteLiteral(verifier)}`);
      await tx.query(`GRANT ${APPLICATION_GROUPS.map(quoteIdentifier).join(',')} TO ${quoteIdentifier(RUNTIME_ROLE)} WITH ADMIN FALSE, INHERIT TRUE, SET TRUE`);
    }
    const authority=await inspectAuthority(tx,{requireRuntime:true});
    const privileges=await verifyRuntimePrivileges(tx);
    return{created:!current.runtimeExists,authority,privileges};
  });
}

export async function main(args=process.argv.slice(2)){
  const pins=parseArguments(args),env=ownerDatabaseEnvironment(process.env);
  const [{loadConfig},{openDatabase},{migrationInventory},{splitSqlStatements}]=await Promise.all([
    import('/app/dist/config.js'),import('/app/dist/db/open.js'),import('/app/dist/db/migrate.js'),import('/app/dist/db/sql.js'),
  ]);
  const config=loadConfig(env);
  if(config.release.commit!==pins.sourceSha||config.release.environment!==DATABASE_TARGET.environment||config.awsRegion!==DATABASE_TARGET.region||config.migrateOnStart)fail('RELEASE_CONTEXT_MISMATCH');
  assertDatabaseTarget(config.databaseUrl);
  const sql=await readFile(pins.rolesSqlPath,'utf8');
  if(digest(sql)!==pins.rolesSqlSha256)fail('PINNED_RUNTIME_SQL_MISMATCH');
  const inventory=await migrationInventory(),scriptSha256=digest(await readFile(new URL(import.meta.url)));
  if(inventoryDigest(inventory)!==pins.schemaSha256)fail('PINNED_SOURCE_SCHEMA_MISMATCH');
  const opened=await openDatabase(config,env);
  let phase='inspect',applyAttempted=false,applyAcknowledged=false;
  const identity=async(db,login)=>{
    const row=(await db.query('SELECT current_user AS role,session_user AS login,current_schema() AS schema,current_database() AS database')).rows[0];
    if(row?.role!==login||row?.login!==login||row?.schema!=='public')fail('DATABASE_IDENTITY_MISMATCH');
    if(row.database!==DATABASE_TARGET.database)fail('DATABASE_TARGET_MISMATCH');
    const tls=(await db.query('SELECT ssl,version FROM pg_stat_ssl WHERE pid=pg_backend_pid()')).rows[0];
    if(tls?.ssl!==true||!['TLSv1.2','TLSv1.3'].includes(tls.version))fail('VERIFIED_DATABASE_TLS_REQUIRED');
    return{identity:row,tls};
  };
  const baseline=async db=>{
    const connection=await identity(db,OWNER_ROLE);
    const applied=(await db.query('SELECT id,checksum FROM public.schema_migrations ORDER BY id')).rows;
    validateInventory(inventory,applied,pins.schemaSha256);
    const objects=await inspectObjects(db);
    const policy=(await db.query('SELECT durability_required FROM public.policy_recovery_fence WHERE singleton=1')).rows[0];
    if(policy?.durability_required!==(config.requireDurableReceipts===true))fail('DURABILITY_POLICY_MISMATCH');
    return{...connection,...objects,migrationCount:applied.length,durabilityRequired:policy.durability_required};
  };
  const verifyLogin=async({probes=false}={})=>{
    const selected=runtimeDatabaseEnvironment(env,config.databaseUrl),runtime=await openDatabase(loadConfig(selected),selected);
    try{
      const verified=await runtime.db.transaction(async db=>{
        await db.query('SET TRANSACTION READ ONLY');
        const connection=await identity(db,RUNTIME_ROLE);
        const applied=(await db.query('SELECT id,checksum FROM public.schema_migrations ORDER BY id')).rows;
        validateInventory(inventory,applied,pins.schemaSha256);
        return{...connection,authority:await inspectAuthority(db,{requireRuntime:true}),privileges:await verifyRuntimePrivileges(db)};
      });
      return{...verified,...(probes?await probeDeniedAuthority(runtime.db):{})};
    }finally{await runtime.close();}
  };
  try{
    const inspected=await opened.db.transaction(async db=>{
      await db.query('SET TRANSACTION READ ONLY');return{...await baseline(db),authority:await inspectAuthority(db)};
    });
    console.log(JSON.stringify({event:'admin_runtime_credentials_preflight',mode:pins.mode,sourceSha:pins.sourceSha,schemaSha256:pins.schemaSha256,rolesSqlSha256:pins.rolesSqlSha256,scriptSha256,...inspected}));
    if(pins.mode==='--inspect'){
      if(inspected.authority.runtimeExists)console.log(JSON.stringify({event:'admin_runtime_existing_login_verified',...await verifyLogin()}));
      return;
    }
    phase='apply';const password=validateNewCredentials(env);applyAttempted=true;
    const applied=await applyRuntimeRoles({db:opened.db,sql,expectedSqlHash:pins.rolesSqlSha256,splitStatements:splitSqlStatements,password,verifyBaseline:baseline,verifyExistingLogin:verifyLogin});
    applyAcknowledged=true;phase='verify_new_login';
    const verified=await verifyLogin({probes:true});
    // Setup success does not claim IAM isolation, old-pool drainage, or cutover.
    console.log(JSON.stringify({event:'admin_runtime_credentials_verified',sourceSha:pins.sourceSha,scriptSha256,rolesSqlSha256:pins.rolesSqlSha256,schemaSha256:pins.schemaSha256,created:applied.created,...verified,serviceCutoverPerformed:false}));
  }catch(error){
    console.log(JSON.stringify({event:'admin_runtime_credentials_failed',phase,code:error instanceof CredentialSetupError?error.safeCode:'CREDENTIAL_SETUP_FAILED',operatorInspectionRequired:applyAttempted,setupTransactionAcknowledged:applyAcknowledged}));
    process.exitCode=1;
  }finally{await opened.close();}
}

if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
  main().catch(()=>{console.log(JSON.stringify({event:'admin_runtime_credentials_failed',code:'PREFLIGHT_FAILED'}));process.exitCode=1;});
}
