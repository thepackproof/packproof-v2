// One-shot qualification on an isolated restore of the deployed database.
// No production connection, service update, credential creation or app startup.
import {createHash} from 'node:crypto';
import {pathToFileURL} from 'node:url';

export const RUNTIME_PINS=Object.freeze({
 source:'3bff0173c9d91fc11ae614d72872b877628c327d',
 image:'sha256:3b1c81642b27a14629a5a8c8f4af4b0bf91f09bc0e0b5591e06af10d5bde0557',
 predecessorInventory:'605ba38f1c9ffcd6dd28a64a7d07d9cc41c3397ee7c10ba26198ad14ec50c2e1',
 inventory:'a873b3f50dc1d4a380067d4a3d1a642472827df2fb2e99634ac3b45aa6260a6d',
 instance:'packproof-zero-touch-runtime-20261108',
 snapshot:'arn:aws:rds:us-east-1:784514617543:snapshot:packproof-zero-touch-runtime-20261108',
 apiRole:'packproof_records_api_v1',workerRole:'packproof_records_worker_v1',
});
const hash=x=>createHash('sha256').update(JSON.stringify(x)).digest('hex');
const fail=code=>{throw Error(code);};
const quote=x=>{if(typeof x!=='string'||!/^[a-z][a-z0-9_]{0,62}$/.test(x))fail('RUNTIME_REHEARSAL_IDENTIFIER_INVALID');return '"'+x+'"';};

export function validateRuntimeReview(r,e,now=new Date()){
 const p=RUNTIME_PINS;
 if(r?.schema!=='packproof.zero-touch-runtime-review/v1'||r.source!==p.source||r.imageDigest!==p.image||r.snapshotArn!==p.snapshot||r.sourceInstance!=='packproof-v2-staging-db'||r.instanceArn!==`arn:aws:rds:us-east-1:784514617543:db:${p.instance}`||r.privateRestore!==true||r.inventorySha256!==p.inventory)fail('RUNTIME_REHEARSAL_EXACT_REVIEW_REQUIRED');
 if(r.target?.host!==`${p.instance}.c8v2esku2zyt.us-east-1.rds.amazonaws.com`||r.target.database!=='packproof_v2')fail('RUNTIME_REHEARSAL_ISOLATED_TARGET_REQUIRED');
 const remaining=Date.parse(r.expiresAt)-now.getTime();
 if(!Number.isFinite(remaining)||remaining<=0||remaining>3600000)fail('RUNTIME_REHEARSAL_REVIEW_EXPIRED');
 if(e.PACKPROOF_TEST_PURPOSE!=='isolated-production-restore'||e.PACKPROOF_DB_HOST!==r.target.host||e.PACKPROOF_DB_NAME!==r.target.database||e.PACKPROOF_DB_USER!=='packproof'||e.PACKPROOF_MIGRATE_ON_START!=='false'||e.PACKPROOF_ENVIRONMENT!=='staging'||e.PACKPROOF_RELEASE_SHA!==p.source||e.PACKPROOF_ORGANIZATIONS_ENABLED!=='false'||e.PACKPROOF_CLAIM_EXPORTS_ENABLED!=='false')fail('RUNTIME_REHEARSAL_ENVIRONMENT_REQUIRED');
 if(e.DATABASE_URL||e.PACKPROOF_DB_SECRET_ARN||Object.keys(e).some(k=>k.startsWith('PG')&&e[k]))fail('RUNTIME_REHEARSAL_AMBIENT_DATABASE_FORBIDDEN');
 return hash(r);
}

async function dataShape(db){
 return (await db.query("SELECT c.relname,a.attname FROM pg_class c JOIN pg_attribute a ON a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped WHERE c.relnamespace='public'::regnamespace AND c.relkind='r' AND c.relname<>'schema_migrations' ORDER BY c.relname,a.attnum")).rows;
}
async function dataSnapshot(db,shape){
 const inventory=[];
 for(const table of [...new Set(shape.map(x=>x.relname))]){
  const fields=shape.filter(x=>x.relname===table).map(x=>quote(x.attname)).join(',');
  const rows=(await db.query(`SELECT to_jsonb(t) AS row FROM (SELECT ${fields} FROM public.${quote(table)}) t ORDER BY to_jsonb(t)::text LIMIT 100001`)).rows;
  if(rows.length>100000)fail('RUNTIME_REHEARSAL_DATA_BOUND_EXCEEDED');
  inventory.push({table,count:rows.length,sha256:hash(rows)});
 }
 return {tables:inventory.length,rows:inventory.reduce((n,x)=>n+x.count,0),sha256:hash(inventory)};
}

// Compare all existing application rights outside the independently verified
// records policy, including effective PUBLIC/inherited and column permissions.
export async function applicationBaseline(db,managed){
 const roles=[RUNTIME_PINS.apiRole,RUNTIME_PINS.workerRole];
 const tables=(await db.query(`SELECT r.role,c.relname,p.privilege,
 has_table_privilege(r.role,c.oid,p.privilege) AS allowed,
 has_table_privilege(r.role,c.oid,p.privilege||' WITH GRANT OPTION') AS grantable
 FROM pg_class c CROSS JOIN unnest($1::text[]) r(role)
 CROSS JOIN unnest(ARRAY['SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER']) p(privilege)
 WHERE c.relnamespace='public'::regnamespace AND c.relkind='r' AND NOT c.relname=ANY($2::text[])
 ORDER BY r.role,c.relname,p.privilege`,[roles,managed])).rows;
 const columns=(await db.query(`SELECT r.role,c.relname,a.attname,p.privilege,
 has_column_privilege(r.role,c.oid,a.attnum,p.privilege) AS allowed,
 has_column_privilege(r.role,c.oid,a.attnum,p.privilege||' WITH GRANT OPTION') AS grantable
 FROM pg_class c JOIN pg_attribute a ON a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped
 CROSS JOIN unnest($1::text[]) r(role) CROSS JOIN unnest(ARRAY['SELECT','INSERT','UPDATE','REFERENCES']) p(privilege)
 WHERE c.relnamespace='public'::regnamespace AND c.relkind='r' AND NOT c.relname=ANY($2::text[])
 ORDER BY r.role,c.relname,a.attnum,p.privilege`,[roles,managed])).rows;
 const sequences=(await db.query(`SELECT r.role,c.relname,p.privilege,
 has_sequence_privilege(r.role,c.oid,p.privilege) AS allowed,
 has_sequence_privilege(r.role,c.oid,p.privilege||' WITH GRANT OPTION') AS grantable
 FROM pg_class c CROSS JOIN unnest($1::text[]) r(role)
 CROSS JOIN unnest(ARRAY['USAGE','SELECT','UPDATE']) p(privilege)
 WHERE c.relnamespace='public'::regnamespace AND c.relkind='S' AND c.relname<>'record_issue_actions_sequence_seq'
 ORDER BY r.role,c.relname,p.privilege`,[roles])).rows;
 const functions=(await db.query(`SELECT r.role,p.oid,p.proname,pg_get_function_identity_arguments(p.oid) AS arguments,
 has_function_privilege(r.role,p.oid,'EXECUTE') AS allowed,
 has_function_privilege(r.role,p.oid,'EXECUTE WITH GRANT OPTION') AS grantable
 FROM pg_proc p CROSS JOIN unnest($1::text[]) r(role)
 WHERE p.pronamespace='public'::regnamespace AND p.proname<>'lock_operational_snapshot_authority'
 ORDER BY r.role,p.oid`,[roles])).rows;
 if([...tables,...columns,...sequences,...functions].some(x=>x.grantable))fail('RUNTIME_REHEARSAL_DELEGABLE_BASELINE_UNSAFE');
 const controls=(await db.query(`SELECT r.rolname,r.rolcanlogin,r.rolsuper,r.rolcreatedb,r.rolcreaterole,r.rolinherit,r.rolreplication,r.rolbypassrls,
 has_schema_privilege(r.rolname,'public','CREATE') AS schema_create,
 pg_has_role(r.rolname,'packproof','MEMBER') AS owner_member,
 pg_has_role(r.rolname,'packproof','SET') AS owner_set
 FROM pg_roles r WHERE r.rolname=ANY($1::text[]) ORDER BY r.rolname`,[roles])).rows;
 if(controls.length!==2||controls.some(x=>!x.rolcanlogin||['rolsuper','rolcreatedb','rolcreaterole','rolreplication','rolbypassrls','schema_create','owner_member','owner_set'].some(k=>x[k])))fail('RUNTIME_REHEARSAL_BASELINE_AUTHORITY_UNSAFE');
 for(const row of [...tables,...columns])if(['schema_migrations','user_system_roles'].includes(row.relname)&&row.allowed&&row.privilege!=='SELECT')fail('RUNTIME_REHEARSAL_CONTROL_WRITE_UNSAFE');
 const memberships=(await db.query('SELECT roleid,member,grantor,admin_option,inherit_option,set_option FROM pg_auth_members ORDER BY roleid,member')).rows;
 return {sha256:hash({tables,columns,sequences,functions,controls,memberships}),tableChecks:tables.length,columnChecks:columns.length,sequenceChecks:sequences.length,functionChecks:functions.length};
}

async function identity(db,role,database){
 const actual=(await db.query('SELECT current_user AS role,session_user AS login,current_database() AS database,current_schema() AS schema')).rows[0];
 const tls=(await db.query('SELECT ssl,version FROM pg_stat_ssl WHERE pid=pg_backend_pid()')).rows[0];
 if(actual?.role!==role||actual.login!==role||actual.database!==database||actual.schema!=='public'||tls?.ssl!==true)fail('RUNTIME_REHEARSAL_AUTHENTICATED_TLS_REQUIRED');
 return {...actual,tls};
}
async function permissionChecks(db,kind){
 const allowed=['SELECT id FROM record_source_pending WHERE false',kind==='api'?'INSERT INTO record_source_crosswalks(id) SELECT id FROM record_source_crosswalks WHERE false':'UPDATE record_source_pending SET state=state WHERE false'];
 for(const sql of allowed)await db.query(sql);
 const denied=['UPDATE record_source_pending SET payload_canonical=payload_canonical WHERE false','DELETE FROM record_source_pending WHERE false','UPDATE schema_migrations SET checksum=checksum WHERE false','DELETE FROM user_system_roles WHERE false'];
 if(kind==='worker')denied.push('INSERT INTO record_source_crosswalks(id) SELECT id FROM record_source_crosswalks WHERE false','UPDATE record_source_pending SET replay_revision=replay_revision WHERE false');
 else denied.push('INSERT INTO record_source_artifact_results(operation_id) SELECT operation_id FROM record_source_artifact_results WHERE false');
 for(const sql of denied){
  let rejected=false;
  try{await db.query(sql);}catch(error){if(error?.code!=='42501')throw error;rejected=true;}
  if(!rejected)fail('RUNTIME_REHEARSAL_PERMISSION_DENIAL_MISSING');
 }
 return {allowed:allowed.length,denied:denied.length};
}

export async function runRuntimeRehearsal(e=process.env){
 let owner,phase='review';const sessions=[];
 const deadline=setTimeout(()=>process.exit(2),600000);deadline.unref();
 try{
  const review=JSON.parse(e.ZERO_TOUCH_RUNTIME_REVIEW_JSON??'{}'),reviewSha256=validateRuntimeReview(review,e);
  if(process.getuid()===0||!e.PACKPROOF_DB_PASSWORD||!e.REHEARSAL_API_PASSWORD||!e.REHEARSAL_WORKER_PASSWORD)fail('RUNTIME_REHEARSAL_SECRET_INJECTION_REQUIRED');
  const [{createPgDatabase},{migrationInventory,migrate,assertSchemaCurrent},{inspectSourceAssociationInventory},{recordsMigrationInventory,planRecordsRuntimePrivileges,verifyRecordsRuntimePrivileges},{verifyM2RuntimePrivileges}]=await Promise.all([
   import('/app/backend/dist/db/postgres.js'),import('/app/backend/dist/db/migrate.js'),import('/app/backend/scripts/source-association-migration-inventory.mjs'),import('/app/backend/scripts/records-runtime-privileges.mjs'),import('/app/backend/scripts/m2-runtime-privileges.mjs')]);
  const connect=(role,password)=>{
   const url=new URL(`postgresql://${review.target.host}:5432/${review.target.database}?sslmode=verify-full`);url.username=role;url.password=password;
   return createPgDatabase(url.href,undefined,{PACKPROOF_ENVIRONMENT:'staging',PACKPROOF_DB_CA_FILE:'/app/backend/certs/rds-us-east-1-bundle.pem'});
  };
  owner=connect('packproof',e.PACKPROOF_DB_PASSWORD);phase='restored_migration_and_policy';
  const inventory=await migrationInventory(),records=await recordsMigrationInventory(),managed=Object.keys(records.tableColumns);
  inspectSourceAssociationInventory(inventory,inventory,{reviewedSourceCommit:RUNTIME_PINS.source,reviewedInventorySha256:RUNTIME_PINS.inventory});
  const options={runtimeRole:RUNTIME_PINS.apiRole,workerRole:RUNTIME_PINS.workerRole,schema:'public',reviewedSourceCommit:RUNTIME_PINS.source,reviewedMigrationSha256:records.migrationSha256};
  const result=await owner.db.transaction(async tx=>{
   await tx.query("SET LOCAL lock_timeout='15s'");await tx.query("SET LOCAL statement_timeout='120s'");await tx.query("SET LOCAL timezone='UTC'");
   const actual=await identity(tx,'packproof',review.target.database);
   const previous=(await tx.query('SELECT id,checksum FROM schema_migrations ORDER BY id')).rows;
   if(previous.length!==106||hash(previous)!==RUNTIME_PINS.predecessorInventory)fail('RUNTIME_REHEARSAL_DEPLOYED_LEDGER_REQUIRED');
   const shape=await dataShape(tx),before=await dataSnapshot(tx,shape),baseline=await applicationBaseline(tx,managed);
   const m2=await verifyM2RuntimePrivileges(tx,{apiRole:RUNTIME_PINS.apiRole,workerRole:RUNTIME_PINS.workerRole});
   await migrate(tx,undefined,{expectedRole:'packproof',adoptLegacyChecksums:false});
   // Remove only inherited default grants on newly introduced tables. Existing
   // grants, role membership, original credentials and default ACLs stay intact.
   const newTables=managed.filter(name=>!shape.some(x=>x.relname===name));
   const inherited=(await tx.query("SELECT DISTINCT c.relname,a.grantee,r.rolname FROM pg_class c CROSS JOIN LATERAL aclexplode(c.relacl) a LEFT JOIN pg_roles r ON r.oid=a.grantee WHERE c.relnamespace='public'::regnamespace AND c.relname=ANY($1::text[]) AND a.grantee<>c.relowner",[newTables])).rows;
   for(const grant of inherited)await tx.query(`REVOKE ALL PRIVILEGES ON TABLE public.${quote(grant.relname)} FROM ${Number(grant.grantee)===0?'PUBLIC':quote(grant.rolname)}`);
   const plan=await planRecordsRuntimePrivileges(tx,options);
   for(const sql of plan.statements)await tx.query(sql);
   await assertSchemaCurrent(tx);
   const applied=(await tx.query('SELECT id,checksum FROM schema_migrations ORDER BY id')).rows;
   inspectSourceAssociationInventory(inventory,applied,{reviewedSourceCommit:RUNTIME_PINS.source,reviewedInventorySha256:RUNTIME_PINS.inventory});
   const after=await dataSnapshot(tx,shape),baselineAfter=await applicationBaseline(tx,managed);
   const m2After=await verifyM2RuntimePrivileges(tx,{apiRole:RUNTIME_PINS.apiRole,workerRole:RUNTIME_PINS.workerRole});
   if(hash(before)!==hash(after)||hash(baseline)!==hash(baselineAfter)||hash(m2)!==hash(m2After))fail('RUNTIME_REHEARSAL_PRESERVATION_FAILED');
   return {actual,previousMigrationCount:previous.length,migrationCount:applied.length,before,after,baseline,recordsPolicySha256:plan.policySha256,recordsStatementsSha256:plan.statementsSha256,m2PolicySha256:m2.policySha256,legacyNewTableGrantsRemoved:inherited.length};
  });
  phase='actual_runtime_logins';const runtimeReceipts=[];
  for(const [kind,role,password] of [['api',RUNTIME_PINS.apiRole,e.REHEARSAL_API_PASSWORD],['worker',RUNTIME_PINS.workerRole,e.REHEARSAL_WORKER_PASSWORD]]){
   const session=connect(role,password);sessions.push(session);
   const actual=await identity(session.db,role,review.target.database);
   await assertSchemaCurrent(session.db);
   const recordsReceipt=await verifyRecordsRuntimePrivileges(session.db,options);
   const m2Receipt=await verifyM2RuntimePrivileges(session.db,{apiRole:RUNTIME_PINS.apiRole,workerRole:RUNTIME_PINS.workerRole});
   const permissions=await permissionChecks(session.db,kind);
   runtimeReceipts.push({kind,actual,recordsReceipt,m2Receipt,permissions});
  }
  return {event:'zero_touch_runtime_rehearsal_complete',schema:'packproof.zero-touch-runtime-rehearsal/v1',status:'PASSED',completedAt:new Date().toISOString(),reviewSha256,source:RUNTIME_PINS.source,imageDigest:RUNTIME_PINS.image,snapshotArn:review.snapshotArn,target:review.target,...result,runtimeReceipts,baselinePrivilegesPreserved:true,actualRuntimeLoginsQualified:true,applicationStarted:false,previousImageRehearsal:false,productionChanged:false,customerQualification:false};
 }finally{clearTimeout(deadline);for(const session of sessions)await session.close();await owner?.close();}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href)runRuntimeRehearsal().then(r=>console.log(JSON.stringify(r))).catch(error=>{
 console.error(JSON.stringify({event:'zero_touch_runtime_rehearsal_failed',code:/^[A-Z0-9_]{3,90}$/.test(error?.message??'')?error.message:'RUNTIME_REHEARSAL_FAILED',sqlState:/^[0-9A-Z]{5}$/.test(error?.code??'')?error.code:undefined}));process.exitCode=1;
});
