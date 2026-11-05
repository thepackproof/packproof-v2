// One-shot DCL only. Existing combined-role/bootstrap SQL remains retired for 106.
// Passwords are generated inside a rollback-only probe or injected by ECS.
import {createHash,createHmac,pbkdf2Sync,randomBytes} from 'node:crypto';
import {pathToFileURL} from 'node:url';
export const SOURCE='65700aac0d8d3d0640b13469a2d508d86efcc318';
export const ROLES=Object.freeze({api:'packproof_records_api_v1',worker:'packproof_records_worker_v1'});
export const M2_TABLES=Object.freeze(['integrity_envelope_jobs','integrity_envelope_delivery','integrity_envelope_results','claim_cases','claim_case_revisions','recipient_export_jobs','recipient_export_approvals','recipient_export_preservations','recovery_writer_fence']);
const fail=code=>{throw Error(code);};
const digest=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const quote=value=>{if(typeof value!=='string'||!/^[a-z][a-z0-9_]{0,62}$/.test(value)||value.startsWith('pg_'))fail('RECORDS_ROLE_IDENTIFIER_INVALID');return '"'+value+'"';};
export function scramVerifier(password,salt=randomBytes(24)){
 if(typeof password!=='string'||password.length<32||password.length>128)fail('RECORDS_INJECTED_PASSWORD_REQUIRED');
 const salted=pbkdf2Sync(password,salt,4096,32,'sha256');
 const stored=createHash('sha256').update(createHmac('sha256',salted).update('Client Key').digest()).digest('base64');
 const server=createHmac('sha256',salted).update('Server Key').digest('base64');
 return `SCRAM-SHA-256$4096:${salt.toString('base64')}$${stored}:${server}`;
}
export function baselineStatements(state,managedTables){
 const excluded=new Set([...managedTables,...M2_TABLES]),statements=[];
 if(!managedTables.length||new Set(managedTables).size!==37)fail('RECORDS_MANAGED_TABLE_INVENTORY_REQUIRED');
 const targets=Object.values(ROLES);targets.forEach(quote);
 for(const role of targets)statements.push(`GRANT USAGE ON SCHEMA public TO ${quote(role)}`);
 for(const row of state.tables){
  quote(row.name);if(excluded.has(row.name))fail('RECORDS_BASELINE_MANAGED_TABLE_LEAK');
  if(row.grantable||row.allowed&&!['SELECT','INSERT','UPDATE','DELETE'].includes(row.privilege))fail('RECORDS_BASELINE_AUTHORITY_UNSAFE');
  if(row.allowed&&['schema_migrations','user_system_roles'].includes(row.name)&&row.privilege!=='SELECT')fail('RECORDS_BASELINE_CONTROL_WRITE_FORBIDDEN');
  if(row.allowed)for(const role of targets)statements.push(`GRANT ${row.privilege} ON TABLE public.${quote(row.name)} TO ${quote(role)}`);
 }
 for(const row of state.columns){
  quote(row.name);quote(row.column_name);if(excluded.has(row.name))fail('RECORDS_BASELINE_MANAGED_TABLE_LEAK');
  if(row.grantable||row.allowed&&!['SELECT','INSERT','UPDATE'].includes(row.privilege))fail('RECORDS_BASELINE_AUTHORITY_UNSAFE');
  if(row.allowed&&['schema_migrations','user_system_roles'].includes(row.name)&&row.privilege!=='SELECT')fail('RECORDS_BASELINE_CONTROL_WRITE_FORBIDDEN');
  if(row.allowed&&!row.table_allowed)for(const role of targets)statements.push(`GRANT ${row.privilege}(${quote(row.column_name)}) ON TABLE public.${quote(row.name)} TO ${quote(role)}`);
 }
 for(const row of state.sequences){
  quote(row.name);if(row.name==='record_issue_actions_sequence_seq')fail('RECORDS_BASELINE_MANAGED_SEQUENCE_LEAK');
  if(row.grantable||row.allowed&&!['USAGE','SELECT'].includes(row.privilege))fail('RECORDS_BASELINE_SEQUENCE_AUTHORITY_UNSAFE');
  if(row.allowed)for(const role of targets)statements.push(`GRANT ${row.privilege} ON SEQUENCE public.${quote(row.name)} TO ${quote(role)}`);
 }
 for(const row of state.functions){
  quote(row.name);if(row.name==='lock_operational_snapshot_authority'||row.grantable||!/^[a-z0-9_., "\[\]]*$/.test(row.arguments))fail('RECORDS_BASELINE_FUNCTION_AUTHORITY_UNSAFE');
  for(const role of targets)statements.push(`GRANT EXECUTE ON FUNCTION public.${quote(row.name)}(${row.arguments}) TO ${quote(role)}`);
 }
 return statements;
}
async function baselineState(db,managed,role='packproof_app_runtime_v1'){
 const params=[role,[...managed,...M2_TABLES]];
 const tables=(await db.query(`SELECT c.relname AS name,p.privilege,has_table_privilege($1,c.oid,p.privilege) AS allowed,has_table_privilege($1,c.oid,p.privilege||' WITH GRANT OPTION') AS grantable
 FROM pg_class c CROSS JOIN unnest(ARRAY['SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER']) p(privilege)
 WHERE c.relnamespace='public'::regnamespace AND c.relkind='r' AND NOT c.relname=ANY($2::text[]) ORDER BY c.relname,p.privilege`,params)).rows;
 const columns=(await db.query(`SELECT c.relname AS name,a.attname AS column_name,p.privilege,has_column_privilege($1,c.oid,a.attnum,p.privilege) AS allowed,has_table_privilege($1,c.oid,p.privilege) AS table_allowed,has_column_privilege($1,c.oid,a.attnum,p.privilege||' WITH GRANT OPTION') AS grantable
 FROM pg_class c JOIN pg_attribute a ON a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped CROSS JOIN unnest(ARRAY['SELECT','INSERT','UPDATE','REFERENCES']) p(privilege)
 WHERE c.relnamespace='public'::regnamespace AND c.relkind='r' AND NOT c.relname=ANY($2::text[]) ORDER BY c.relname,a.attnum,p.privilege`,params)).rows;
 const sequences=(await db.query(`SELECT c.relname AS name,p.privilege,has_sequence_privilege($1,c.oid,p.privilege) AS allowed,has_sequence_privilege($1,c.oid,p.privilege||' WITH GRANT OPTION') AS grantable
 FROM pg_class c CROSS JOIN unnest(ARRAY['USAGE','SELECT','UPDATE']) p(privilege) WHERE c.relnamespace='public'::regnamespace AND c.relkind='S' AND c.relname<>'record_issue_actions_sequence_seq' ORDER BY c.relname,p.privilege`,[params[0]])).rows;
 const functions=(await db.query(`SELECT p.proname AS name,pg_get_function_identity_arguments(p.oid) AS arguments,has_function_privilege($1,p.oid,'EXECUTE WITH GRANT OPTION') AS grantable FROM pg_proc p
 WHERE p.pronamespace='public'::regnamespace AND p.proname<>'lock_operational_snapshot_authority' AND has_function_privilege($1,p.oid,'EXECUTE') AND NOT EXISTS(SELECT 1 FROM aclexplode(COALESCE(p.proacl,acldefault('f',p.proowner))) a WHERE a.grantee=0 AND a.privilege_type='EXECUTE') ORDER BY p.oid`,[params[0]])).rows;
 return {tables,columns,sequences,functions};
}
async function existingAuthority(db){
 const exclude=Object.values(ROLES);
 const relations=(await db.query(`SELECT c.relname,c.relkind,c.relowner,a.grantee,a.privilege_type,a.is_grantable FROM pg_class c CROSS JOIN LATERAL aclexplode(COALESCE(c.relacl,acldefault(CASE WHEN c.relkind='S' THEN 's'::"char" ELSE 'r'::"char" END,c.relowner))) a
 WHERE c.relnamespace='public'::regnamespace AND c.relkind IN ('r','S') AND a.grantee NOT IN (SELECT oid FROM pg_roles WHERE rolname=ANY($1::text[])) ORDER BY c.oid,a.grantee,a.privilege_type`,[exclude])).rows;
 const columns=(await db.query(`SELECT c.relname,a.attname,p.grantee,p.privilege_type,p.is_grantable FROM pg_class c JOIN pg_attribute a ON a.attrelid=c.oid CROSS JOIN LATERAL aclexplode(a.attacl) p WHERE c.relnamespace='public'::regnamespace AND p.grantee NOT IN(SELECT oid FROM pg_roles WHERE rolname=ANY($1::text[])) ORDER BY c.oid,a.attnum,p.grantee,p.privilege_type`,[exclude])).rows;
 const functions=(await db.query(`SELECT p.oid,p.proname,p.prosrc,p.proowner,p.prosecdef,a.grantee,a.privilege_type,a.is_grantable FROM pg_proc p CROSS JOIN LATERAL aclexplode(COALESCE(p.proacl,acldefault('f',p.proowner))) a WHERE p.pronamespace='public'::regnamespace AND a.grantee NOT IN(SELECT oid FROM pg_roles WHERE rolname=ANY($1::text[])) ORDER BY p.oid,a.grantee,a.privilege_type`,[exclude])).rows;
 const schema=(await db.query(`SELECT n.oid,n.nspowner,a.grantee,a.privilege_type,a.is_grantable FROM pg_namespace n CROSS JOIN LATERAL aclexplode(COALESCE(n.nspacl,acldefault('n',n.nspowner))) a WHERE n.nspname='public' AND a.grantee NOT IN(SELECT oid FROM pg_roles WHERE rolname=ANY($1::text[])) ORDER BY a.grantee,a.privilege_type`,[exclude])).rows;
 const runtime=(await db.query("SELECT rolname,rolsuper,rolcreatedb,rolcreaterole,rolinherit,rolreplication,rolbypassrls,rolcanlogin FROM pg_roles WHERE rolname='packproof_app_runtime_v1'")).rows;
 return digest({relations,columns,functions,schema,runtime});
}
async function separationChecks(db){
 const rows=(await db.query(`SELECT
 has_table_privilege($1,'integrity_envelope_results','INSERT') AS api_m2_result,
 has_table_privilege($2,'integrity_envelope_results','INSERT') AS worker_m2_result,
 has_column_privilege($1,'record_source_artifact_results','operation_id','INSERT') AS api_source_result,
 has_column_privilege($2,'record_source_artifact_results','operation_id','INSERT') AS worker_source_result,
 has_sequence_privilege($1,'record_issue_actions_sequence_seq','USAGE') AS api_sequence,
 has_sequence_privilege($2,'record_issue_actions_sequence_seq','USAGE') AS worker_sequence`,[ROLES.api,ROLES.worker])).rows[0];
 if(rows.api_m2_result||!rows.worker_m2_result||rows.api_source_result||!rows.worker_source_result||!rows.api_sequence||rows.worker_sequence)fail('RECORDS_RUNTIME_SEPARATION_FAILED');
 await db.query('SAVEPOINT records_denial_probe');
 let denied=false;
 try{await db.query(`SET LOCAL ROLE ${quote(ROLES.api)}`);if((await db.query('SELECT current_user AS role')).rows[0].role!==ROLES.api)fail('RECORDS_DENIAL_ROLE_MISMATCH');try{await db.query('INSERT INTO record_source_artifact_results DEFAULT VALUES');}catch(error){if(error.code==='42501')denied=true;else throw error;}}
 finally{await db.query('ROLLBACK TO SAVEPOINT records_denial_probe');await db.query('RELEASE SAVEPOINT records_denial_probe');}
 if(!denied)fail('RECORDS_API_WORKER_WRITE_DENIAL_MISSING');
 return {workerResultWritesSeparated:true,issueSequenceSeparated:true,actualApiWorkerWriteDenied:true};
}
export async function runRuntimeRoles(mode,env=process.env){
 if(!['--rehearse','--apply'].includes(mode)||env.PACKPROOF_RELEASE_SHA!==SOURCE||env.PACKPROOF_DB_USER!=='packproof'||!env.PACKPROOF_DB_PASSWORD||env.PACKPROOF_OPERATOR_PURPOSE!=='records-runtime-role-preparation')fail('RECORDS_EXPLICIT_ROLE_OPERATOR_REQUIRED');
 if(env.PACKPROOF_ENVIRONMENT!=='production'||env.PACKPROOF_MIGRATE_ON_START!=='false'||env.PACKPROOF_ORGANIZATIONS_ENABLED!=='false'||env.PACKPROOF_CLAIM_EXPORTS_ENABLED!=='false'||Object.keys(env).some(k=>k.startsWith('PG')&&env[k]))fail('RECORDS_ROLE_OPERATOR_CONFIGURATION_REQUIRED');
 if(mode==='--apply')validateApplicationQualification(env);
 const [{loadConfig},{createPgDatabase},{migrationInventory,assertSchemaCurrent},{recordsMigrationInventory,planRecordsRuntimePrivileges},{applyM2RuntimePrivileges}]=await Promise.all([import('/app/backend/dist/config.js'),import('/app/backend/dist/db/postgres.js'),import('/app/backend/dist/db/migrate.js'),import('/app/backend/scripts/records-runtime-privileges.mjs'),import('/app/backend/scripts/m2-runtime-privileges.mjs')]);
 const cfg=loadConfig({...env,DATABASE_URL:'',PACKPROOF_DB_SECRET_ARN:''}),url=new URL(cfg.databaseUrl);
 if(url.hostname!=='packproof-v2-staging-db.c8v2esku2zyt.us-east-1.rds.amazonaws.com'||url.pathname!=='/packproof_v2'||decodeURIComponent(url.username)!=='packproof')fail('RECORDS_ROLE_DATABASE_TARGET_MISMATCH');
 const passwords=mode==='--rehearse'?{api:randomBytes(32).toString('hex'),worker:randomBytes(32).toString('hex')}:{api:env.PACKPROOF_RECORDS_API_PASSWORD,worker:env.PACKPROOF_RECORDS_WORKER_PASSWORD};
 const verifiers=Object.fromEntries(Object.entries(passwords).map(([kind,password])=>[kind,scramVerifier(password)]));
 const opened=createPgDatabase(url.toString(),undefined,env),rollback=Symbol('intentional role rehearsal rollback');let receipt;
 try{
  try{await opened.db.transaction(async db=>{
   await db.query("SET LOCAL lock_timeout='5s'");await db.query("SET LOCAL statement_timeout='30s'");await db.query('SELECT pg_advisory_xact_lock(1347438146,1)');
   const id=(await db.query('SELECT current_user AS role,session_user AS login,current_database() AS database,current_schema() AS schema')).rows[0];
   const tls=(await db.query('SELECT ssl FROM pg_stat_ssl WHERE pid=pg_backend_pid()')).rows[0];
   if(id.role!=='packproof'||id.login!==id.role||id.database!=='packproof_v2'||id.schema!=='public'||!tls?.ssl)fail('RECORDS_ROLE_OWNER_IDENTITY_TLS_REQUIRED');
   await assertSchemaCurrent(db);const inventory=await migrationInventory(),ledger=(await db.query('SELECT id,checksum FROM schema_migrations ORDER BY id')).rows;
   if(inventory.length!==106||ledger.length!==106||digest(ledger)!=='605ba38f1c9ffcd6dd28a64a7d07d9cc41c3397ee7c10ba26198ad14ec50c2e1')fail('RECORDS_ROLE_FROZEN_SCHEMA_REQUIRED');
   if((await db.query('SELECT 1 FROM platform_organizations LIMIT 1')).rows.length)fail('RECORDS_ROLE_ACTIVATION_ALREADY_PRESENT');
   if((await db.query('SELECT rolname FROM pg_roles WHERE rolname=ANY($1::text[])',[Object.values(ROLES)])).rows.length)fail('RECORDS_RUNTIME_LOGIN_ALREADY_EXISTS');
   const prior=await existingAuthority(db),source=await recordsMigrationInventory(),managed=Object.keys(source.tableColumns),baseline=await baselineState(db,managed),statements=baselineStatements(baseline,managed);
   for(const [kind,role] of Object.entries(ROLES))await db.query(`CREATE ROLE ${quote(role)} NOLOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS CONNECTION LIMIT 60 PASSWORD '${verifiers[kind]}'`);
   for(const sql of statements)await db.query(sql);
   await applyM2RuntimePrivileges(db,{apiRole:ROLES.api,workerRole:ROLES.worker});
   const plan=await planRecordsRuntimePrivileges(db,{runtimeRole:ROLES.api,workerRole:ROLES.worker,schema:'public',reviewedSourceCommit:SOURCE,reviewedMigrationSha256:source.migrationSha256});
   for(const sql of plan.statements)await db.query(sql);
   const checks=await separationChecks(db);
   for(const role of Object.values(ROLES))if(digest(await baselineState(db,managed,role))!==digest(baseline))fail('RECORDS_BASELINE_EFFECTIVE_PRIVILEGES_MISMATCH');
   if(await existingAuthority(db)!==prior)fail('RECORDS_EXISTING_AUTHORITY_CHANGED');
   receipt={event:'records_runtime_roles_prepared',source:SOURCE,mode,apiRole:ROLES.api,workerRole:ROLES.worker,baselineStatements:statements.length,baselinePolicySha256:digest(statements),recordsPolicySha256:plan.policySha256,recordsStatementsSha256:plan.statementsSha256,baselineEffectivePrivilegesVerified:true,existingAuthorityPreserved:true,featureActivation:false,...checks};
   if(mode==='--rehearse')throw rollback;
   for(const role of Object.values(ROLES))await db.query(`ALTER ROLE ${quote(role)} LOGIN`);
  });}catch(error){if(error!==rollback)throw error;}
  if(mode==='--rehearse'&&(await opened.db.query('SELECT rolname FROM pg_roles WHERE rolname=ANY($1::text[])',[Object.values(ROLES)])).rows.length)fail('RECORDS_ROLE_REHEARSAL_CLEANUP_FAILED');
  return {...receipt,transactionCommitted:mode==='--apply',transactionRolledBack:mode==='--rehearse'};
 }finally{await opened.close();}
}
export function validateApplicationQualification(env,now=new Date()){
 let report;try{report=JSON.parse(env.PACKPROOF_RECORDS_APPLICATION_QUALIFIED_JSON??'');}catch{fail('RECORDS_CURRENT_APPLICATION_QUALIFICATION_REQUIRED');}
 const {sha256,...body}=report??{},expected='784514617543.dkr.ecr.us-east-1.amazonaws.com/packproof-v2-staging-api@sha256:6a396f672e62636a6fb603b7e922afadeed0070183d319e3ef335e9ac4274d6f';
 if(sha256!==digest(body)||sha256!==env.PACKPROOF_RECORDS_APPLICATION_QUALIFIED_SHA256||body.schema!=='packproof.records-inactive-app-live/v1'||body.source!==SOURCE||body.image!==expected||body.nativeStatus!=='SUCCESSFUL'||body.featureActivation!==false||body.desired!==1||body.running!==1||body.pending!==0||body.productionTraffic!==100||!/^arn:aws:ecs:us-east-1:784514617543:task-definition\/packproof-v2-staging-cluster-packproof-v2-staging-api:[0-9]+$/.test(body.taskDefinition??''))fail('RECORDS_APPLICATION_QUALIFICATION_BINDING_MISMATCH');
 const age=now.getTime()-Date.parse(body.completedAt);if(!Number.isFinite(age)||age<0||age>86400000)fail('RECORDS_APPLICATION_QUALIFICATION_EXPIRED');
 const routes=[['/meta',200],['/health',200],['/ready',200],['/me/capabilities',401]];
 if(body.checks?.length!==4||routes.some(([route,status])=>body.checks.filter(x=>x.route===route&&x.status===status&&x.cors==='https://thepackproof.com').length!==1))fail('RECORDS_APPLICATION_HTTP_QUALIFICATION_REQUIRED');
 return sha256;
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href)runRuntimeRoles(process.argv[2]).then(r=>console.log(JSON.stringify(r))).catch(error=>{console.error(JSON.stringify({event:'records_runtime_roles_failed',code:/^[A-Z][A-Z0-9_]{2,80}$/.test(error?.message??'')?error.message:'DATABASE_OPERATION_FAILED',sqlState:/^[0-9A-Z]{5}$/.test(error?.code??'')?error.code:undefined}));process.exitCode=1;});
