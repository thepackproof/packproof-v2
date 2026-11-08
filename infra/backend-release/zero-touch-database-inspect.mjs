// One bounded, read-only inspection of the existing synthetic M1 database.
// The ECS execution role injects its existing password; never log secret values.
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
let opened,stage='environment';
const timeout=setTimeout(()=>process.exit(2),120000);timeout.unref();
try{
 const e=process.env;
 assert.equal(e.PACKPROOF_TEST_PURPOSE,'isolated-m1-synthetic');
 assert.equal(e.PACKPROOF_DB_HOST,'packproof-m1-20261020-db.c8v2esku2zyt.us-east-1.rds.amazonaws.com');
 assert.equal(e.PACKPROOF_DB_NAME,'m1_service_20261021');
 const ownerReadOnly=e.PACKPROOF_INSPECTION_AUTHORITY==='synthetic-owner-readonly';
 assert.ok(ownerReadOnly||e.PACKPROOF_INSPECTION_AUTHORITY===undefined);
 assert.equal(e.PACKPROOF_DB_USER,ownerReadOnly?'packproof':'m1_service_api');
 assert.equal(e.PACKPROOF_MIGRATE_ON_START,'false');
 assert.equal(e.PACKPROOF_ENVIRONMENT,'staging');
 assert.ok(e.PACKPROOF_DB_PASSWORD&&process.getuid()!==0);
 stage='load_database_module';
 const {createPgDatabase}=await import('/app/backend/dist/db/postgres.js');
 const url=new URL('postgresql://'+e.PACKPROOF_DB_HOST+':5432/'+e.PACKPROOF_DB_NAME+'?sslmode=verify-full');
 url.username=e.PACKPROOF_DB_USER;url.password=e.PACKPROOF_DB_PASSWORD;
 stage='database_tls_configuration';opened=createPgDatabase(url.href);
 stage='connect_readonly_transaction';
 const receipt=await opened.db.transaction(async db=>{
  await db.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
  await db.query("SET LOCAL statement_timeout='30s'");
  await db.query("SET LOCAL timezone='UTC'");
  stage='identity';
  const identity=(await db.query("SELECT current_user AS role,session_user AS login,current_database() AS database,current_schema() AS schema,current_setting('transaction_read_only') AS read_only")).rows[0];
  const tls=(await db.query('SELECT ssl,version FROM pg_stat_ssl WHERE pid=pg_backend_pid()')).rows[0];
  assert.equal(identity.role,e.PACKPROOF_DB_USER);assert.equal(identity.login,e.PACKPROOF_DB_USER);
  assert.equal(identity.database,e.PACKPROOF_DB_NAME);assert.equal(identity.read_only,'on');assert.equal(tls.ssl,true);
  stage='migration_receipts';
  const migrations=(await db.query('SELECT id,checksum FROM schema_migrations ORDER BY id')).rows;
  stage='runtime_roles';
  const roles=(await db.query("SELECT rolname,rolsuper,rolcreatedb,rolcreaterole,rolinherit,rolreplication,rolbypassrls,rolcanlogin,rolvaliduntil FROM pg_roles WHERE rolname LIKE 'm1_%' OR rolname LIKE 'packproof%' ORDER BY rolname")).rows;
  stage='catalog';
  const tables=(await db.query("SELECT c.relname FROM pg_class c WHERE c.relnamespace='public'::regnamespace AND c.relkind='r' ORDER BY c.relname")).rows;
  const databases=(await db.query("SELECT datname FROM pg_database WHERE datallowconn AND NOT datistemplate ORDER BY datname")).rows;
  const shape=(await db.query("SELECT c.relname,a.attname FROM pg_class c JOIN pg_attribute a ON a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped WHERE c.relnamespace='public'::regnamespace AND c.relkind='r' ORDER BY c.relname,a.attnum")).rows;
  const digest=x=>createHash('sha256').update(JSON.stringify(x)).digest('hex');
  const quote=x=>{assert.match(x,/^[a-z][a-z0-9_]{0,62}$/);return '"'+x+'"';};
  const snapshot=[];
  for(const table of [...new Set(shape.map(x=>x.relname))]){
   const fields=shape.filter(x=>x.relname===table).map(x=>quote(x.attname)).join(',');
   const rows=(await db.query(`SELECT to_jsonb(t) AS row FROM (SELECT ${fields} FROM public.${quote(table)}) t ORDER BY to_jsonb(t)::text LIMIT 100001`)).rows;
   assert.ok(rows.length<=100000);snapshot.push({table,count:rows.length,sha256:digest(rows)});
  }
  const dataSnapshot={tables:snapshot.length,rows:snapshot.reduce((n,x)=>n+x.count,0),sha256:digest(snapshot)};
  const writerFence=(await db.query('SELECT writes_enabled FROM recovery_writer_fence WHERE singleton=1')).rows;
  const policyFence=(await db.query('SELECT durability_required FROM policy_recovery_fence WHERE singleton=1')).rows;
  return {identity,tls,migrations,migrationCount:migrations.length,inventorySha256:createHash('sha256').update(JSON.stringify(migrations)).digest('hex'),roles,tables,databases,writerFence,policyFence,dataSnapshot};
 });
 console.log(JSON.stringify({event:'zero_touch_baseline_readonly_inspection',schema:'packproof.zero-touch-baseline-inspection/v1',completedAt:new Date().toISOString(),authority:ownerReadOnly?'owner_readonly':'api_login',apiLoginAuthenticated:!ownerReadOnly,runtimeLoginQualified:false,readOnly:true,applicationStarted:false,migrationsApplied:false,rolesChanged:false,...receipt}));
}catch(error){
 const code=error?.message==='Configured PostgreSQL CA bundle is unavailable'?'CA_BUNDLE_UNAVAILABLE':/^[A-Z0-9_]{2,80}$/.test(error?.code??'')?error.code:'READONLY_INSPECTION_FAILED';
 console.error(JSON.stringify({event:'zero_touch_baseline_inspection_failed',stage,code}));process.exitCode=1;
}finally{clearTimeout(timeout);await opened?.close();}
