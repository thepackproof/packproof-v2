// Explicit owner-operated release of the already qualified108/109 delta.
// Historical operators remain frozen. No customer/source activation or app startup.
import {createHash} from 'node:crypto';
import {applicationBaseline} from './zero-touch-runtime-rehearsal.mjs';
export const LIVE_PINS=Object.freeze({
 source:'3bff0173c9d91fc11ae614d72872b877628c327d',
 image:'sha256:3b1c81642b27a14629a5a8c8f4af4b0bf91f09bc0e0b5591e06af10d5bde0557',
 bridge:'sha256:24e8bae0a3b4db24e75d681baa29d3d0b8c96f2d2e8e3d62bbca22e66ea69783',
 host:'packproof-v2-staging-db.c8v2esku2zyt.us-east-1.rds.amazonaws.com',database:'packproof_v2',
 previous:'605ba38f1c9ffcd6dd28a64a7d07d9cc41c3397ee7c10ba26198ad14ec50c2e1',
 current:'a873b3f50dc1d4a380067d4a3d1a642472827df2fb2e99634ac3b45aa6260a6d',
 api:'packproof_records_api_v1',worker:'packproof_records_worker_v1',
});
const fail=code=>{throw Error(code);};
const hash=x=>createHash('sha256').update(JSON.stringify(x)).digest('hex');
const quote=x=>{if(typeof x!=='string'||!/^[a-z][a-z0-9_]{0,62}$/.test(x))fail('LIVE_IDENTIFIER_INVALID');return '"'+x+'"';};
export function validateLiveReview(r,e,now=new Date()){
 const p=LIVE_PINS,mode=e.ZERO_TOUCH_LIVE_MODE;
 if(!['inspect','apply','verify-api','verify-worker'].includes(mode)||r?.schema!=='packproof.zero-touch-live-review/v1'||r.source!==p.source||r.image!==p.image||r.bridge!==p.bridge||r.target?.host!==p.host||r.target.database!==p.database||r.inventorySha256!==p.current||r.qualifiedRuntime!==true||r.qualifiedRollback!==true||!/^[a-f0-9]{64}$/.test(r.qualificationSha256??''))fail('LIVE_EXACT_REVIEW_REQUIRED');
 if(!/^arn:aws:rds:us-east-1:784514617543:snapshot:packproof-zero-touch-live-[0-9]{8}t[0-9]{4}$/.test(r.snapshotArn??'')||r.snapshotVerified!==true)fail('LIVE_RECOVERY_SNAPSHOT_REQUIRED');
 const remaining=Date.parse(r.expiresAt)-now.getTime();if(!Number.isFinite(remaining)||remaining<=0||remaining>7200000)fail('LIVE_REVIEW_EXPIRED');
 const role=mode==='verify-api'?p.api:mode==='verify-worker'?p.worker:'packproof';
 if(e.PACKPROOF_OPERATOR_PURPOSE!=='zero-touch-production-release'||e.PACKPROOF_RELEASE_SHA!==p.source||e.PACKPROOF_ENVIRONMENT!=='production'||e.PACKPROOF_MIGRATE_ON_START!=='false'||e.PACKPROOF_DB_HOST!==p.host||e.PACKPROOF_DB_NAME!==p.database||e.PACKPROOF_DB_USER!==role||e.PACKPROOF_ORGANIZATIONS_ENABLED!=='false'||e.PACKPROOF_CLAIM_EXPORTS_ENABLED!=='false')fail('LIVE_OPERATOR_BINDING_REQUIRED');
 if(e.DATABASE_URL||e.PACKPROOF_DB_SECRET_ARN||Object.keys(e).some(k=>k.startsWith('PG')&&e[k]))fail('LIVE_AMBIENT_DATABASE_FORBIDDEN');
 return hash(r);
}
export function validateLiveInspection(receipt,reviewSha256,now=new Date()){
 const {sha256,...body}=receipt??{};
 if(sha256!==hash(body)||body.schema!=='packproof.zero-touch-live-inspection/v1'||body.reviewSha256!==reviewSha256||body.source!==LIVE_PINS.source||body.targetHost!==LIVE_PINS.host||![LIVE_PINS.previous,LIVE_PINS.current].includes(body.ledgerSha256)||!/^[a-f0-9]{64}$/.test(body.baseline?.sha256??''))fail('LIVE_INSPECTION_BINDING_REQUIRED');
 const age=now.getTime()-Date.parse(body.inspectedAt);if(!Number.isFinite(age)||age<0||age>900000)fail('LIVE_INSPECTION_EXPIRED');
 return body;
}
async function shape(db){return (await db.query("SELECT c.relname,a.attname FROM pg_class c JOIN pg_attribute a ON a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped WHERE c.relnamespace='public'::regnamespace AND c.relkind='r' AND c.relname<>'schema_migrations' ORDER BY c.relname,a.attnum")).rows;}
async function snapshot(db,columns){
 const tables=[];
 for(const name of [...new Set(columns.map(x=>x.relname))]){
  const fields=columns.filter(x=>x.relname===name).map(x=>quote(x.attname)).join(',');
  const rows=(await db.query(`SELECT to_jsonb(t) AS row FROM (SELECT ${fields} FROM public.${quote(name)}) t ORDER BY to_jsonb(t)::text LIMIT 100001`)).rows;
  if(rows.length>100000)fail('LIVE_PRESERVATION_BOUND_EXCEEDED');
  tables.push({name,count:rows.length,sha256:hash(rows)});
 }
 return {tables:tables.length,rows:tables.reduce((n,x)=>n+x.count,0),sha256:hash(tables)};
}
async function checkIdentity(db,role){
 const id=(await db.query('SELECT current_user AS role,session_user AS login,current_database() AS database,current_schema() AS schema')).rows[0],tls=(await db.query('SELECT ssl,version FROM pg_stat_ssl WHERE pid=pg_backend_pid()')).rows[0];
 if(id?.role!==role||id.login!==role||id.database!==LIVE_PINS.database||id.schema!=='public'||tls?.ssl!==true)fail('LIVE_AUTHENTICATED_TLS_REQUIRED');
 return {...id,tls};
}
async function ledger(db){
 const rows=(await db.query('SELECT id,checksum FROM schema_migrations ORDER BY id')).rows,sha256=hash(rows);
 if(!((rows.length===106&&sha256===LIVE_PINS.previous)||(rows.length===108&&sha256===LIVE_PINS.current)))fail('LIVE_HISTORICAL_LEDGER_MISMATCH');
 return {count:rows.length,sha256};
}
export async function runLiveOperator(e=process.env){
 let opened;const mode=e.ZERO_TOUCH_LIVE_MODE;
 const timer=setTimeout(()=>process.exit(2),600000);timer.unref();
 try{
  const review=JSON.parse(e.ZERO_TOUCH_LIVE_REVIEW_JSON??'{}'),reviewSha256=validateLiveReview(review,e);
  if(process.getuid()===0||!e.PACKPROOF_DB_PASSWORD)fail('LIVE_INJECTED_NONROOT_AUTHORITY_REQUIRED');
  const [{createPgDatabase},{migrationInventory,migrate,assertSchemaCurrent},{recordsMigrationInventory,planRecordsRuntimePrivileges,verifyRecordsRuntimePrivileges},{inspectSourceAssociationInventory},{verifyM2RuntimePrivileges}]=await Promise.all([
   import('/app/backend/dist/db/postgres.js'),import('/app/backend/dist/db/migrate.js'),import('/app/backend/scripts/records-runtime-privileges.mjs'),import('/app/backend/scripts/source-association-migration-inventory.mjs'),import('/app/backend/scripts/m2-runtime-privileges.mjs')]);
  const url=new URL(`postgresql://${LIVE_PINS.host}:5432/${LIVE_PINS.database}?sslmode=verify-full`);url.username=e.PACKPROOF_DB_USER;url.password=e.PACKPROOF_DB_PASSWORD;
  opened=createPgDatabase(url.href,undefined,{PACKPROOF_ENVIRONMENT:'production',PACKPROOF_DB_CA_FILE:'/app/backend/certs/rds-us-east-1-bundle.pem'});
  const inventory=await migrationInventory(),records=await recordsMigrationInventory(),managed=Object.keys(records.tableColumns),m2Options={apiRole:LIVE_PINS.api,workerRole:LIVE_PINS.worker};
  inspectSourceAssociationInventory(inventory,inventory,{reviewedSourceCommit:LIVE_PINS.source,reviewedInventorySha256:LIVE_PINS.current});
  const options={runtimeRole:LIVE_PINS.api,workerRole:LIVE_PINS.worker,schema:'public',reviewedSourceCommit:LIVE_PINS.source,reviewedMigrationSha256:records.migrationSha256};
  if(mode.startsWith('verify-')){
   const receipt=await opened.db.transaction(async tx=>{
    await tx.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const actual=await checkIdentity(tx,e.PACKPROOF_DB_USER);await assertSchemaCurrent(tx);
    return {actual,ledger:await ledger(tx),records:await verifyRecordsRuntimePrivileges(tx,options),m2:await verifyM2RuntimePrivileges(tx,m2Options)};
   });
   return {event:'zero_touch_live_runtime_verified',mode,status:'PASSED',source:LIVE_PINS.source,image:LIVE_PINS.image,reviewSha256,receipt,readOnly:true,completedAt:new Date().toISOString()};
  }
  if(mode==='inspect'){
   return await opened.db.transaction(async tx=>{
    await tx.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');await checkIdentity(tx,'packproof');
    const original=await ledger(tx),oids=(await tx.query("SELECT oid FROM pg_proc WHERE pronamespace='public'::regnamespace ORDER BY oid")).rows.map(x=>x.oid);
    const body={schema:'packproof.zero-touch-live-inspection/v1',source:LIVE_PINS.source,targetHost:LIVE_PINS.host,reviewSha256,inspectedAt:new Date().toISOString(),ledgerCount:original.count,ledgerSha256:original.sha256,baseline:await applicationBaseline(tx,managed,oids),m2:await verifyM2RuntimePrivileges(tx,m2Options),readOnly:true};
    return {event:'zero_touch_live_inspection',...body,sha256:hash(body)};
   });
  }
  const input=JSON.parse(e.ZERO_TOUCH_LIVE_INSPECTION_JSON??'{}');delete input.event;
  const inspected=validateLiveInspection(input,reviewSha256);
  const result=await opened.db.transaction(async tx=>{
   await tx.query("SET LOCAL lock_timeout='15s'");await tx.query("SET LOCAL statement_timeout='120s'");await tx.query("SET LOCAL timezone='UTC'");await tx.query('SELECT pg_advisory_xact_lock(1347438146,1)');
   const actual=await checkIdentity(tx,'packproof'),columns=await shape(tx),tables=[...new Set(columns.map(x=>x.relname))];
   await tx.query(`LOCK TABLE public.schema_migrations,${tables.map(x=>'public.'+quote(x)).join(',')} IN SHARE ROW EXCLUSIVE MODE`);
   const previous=await ledger(tx),oids=(await tx.query("SELECT oid FROM pg_proc WHERE pronamespace='public'::regnamespace ORDER BY oid")).rows.map(x=>x.oid);
   const baseline=await applicationBaseline(tx,managed,oids),before=await snapshot(tx,columns),m2=await verifyM2RuntimePrivileges(tx,m2Options);
   if(previous.sha256!==inspected.ledgerSha256||baseline.sha256!==inspected.baseline.sha256||hash(m2)!==hash(inspected.m2))fail('LIVE_INSPECTION_STATE_CHANGED');
   const bodies=(await tx.query('SELECT oid,prosrc,prosecdef,proconfig FROM pg_proc WHERE oid=ANY($1::oid[]) ORDER BY oid',[oids])).rows;
   await migrate(tx,undefined,{expectedRole:'packproof',adoptLegacyChecksums:false});
   const added=managed.filter(name=>!tables.includes(name));
   const inherited=(await tx.query("SELECT DISTINCT c.relname,a.grantee,r.rolname FROM pg_class c CROSS JOIN LATERAL aclexplode(c.relacl) a LEFT JOIN pg_roles r ON r.oid=a.grantee WHERE c.relnamespace='public'::regnamespace AND c.relname=ANY($1::text[]) AND a.grantee<>c.relowner",[added])).rows;
   for(const row of inherited)await tx.query(`REVOKE ALL PRIVILEGES ON TABLE public.${quote(row.relname)} FROM ${Number(row.grantee)===0?'PUBLIC':quote(row.rolname)}`);
   const plan=await planRecordsRuntimePrivileges(tx,options);for(const sql of plan.statements)await tx.query(sql);
   await assertSchemaCurrent(tx);
   const after=await snapshot(tx,columns),baselineAfter=await applicationBaseline(tx,managed,oids),m2After=await verifyM2RuntimePrivileges(tx,m2Options),bodiesAfter=(await tx.query('SELECT oid,prosrc,prosecdef,proconfig FROM pg_proc WHERE oid=ANY($1::oid[]) ORDER BY oid',[oids])).rows;
   if(hash(before)!==hash(after)||hash(baseline)!==hash(baselineAfter)||hash(m2)!==hash(m2After)||hash(bodies)!==hash(bodiesAfter))fail('LIVE_PRESERVATION_FAILED');
   return {actual,before,after,baseline,ledger:await ledger(tx),previousLedger:previous,recordsPolicySha256:plan.policySha256,statementsSha256:plan.statementsSha256,inheritedNewTableGrantsRemoved:inherited.length};
  });
  return {event:'zero_touch_live_migration_applied',schema:'packproof.zero-touch-live-migration/v1',status:'PASSED',source:LIVE_PINS.source,image:LIVE_PINS.image,reviewSha256,inspectionSha256:input.sha256,snapshotArn:review.snapshotArn,...result,customerSourcesActivated:false,completedAt:new Date().toISOString()};
 }finally{clearTimeout(timer);await opened?.close();}
}
