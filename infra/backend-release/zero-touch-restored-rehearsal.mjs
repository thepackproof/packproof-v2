// Bounded synthetic restore rehearsal. Uses the shipped migrator and privilege
// planner; never starts the application or changes the preserved M1 instance.
import assert from 'node:assert/strict';
import {createHash,createHmac,pbkdf2Sync,randomBytes} from 'node:crypto';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
const source='3bff0173c9d91fc11ae614d72872b877628c327d';
const image='sha256:edb5051c4dc1dbd09fee6fd69e00bb16f47645486570f4e76861000812c3df96';
const baseline='4c8fdf8c9a1c08b22c1b13ddd54dc34c7e51cdd3a1dc238edb5485a7a970556e';
const inventoryHash='a873b3f50dc1d4a380067d4a3d1a642472827df2fb2e99634ac3b45aa6260a6d';
const hash=x=>createHash('sha256').update(JSON.stringify(x)).digest('hex');
const fail=code=>{throw Error(code);};
const q=x=>{if(!/^[a-z][a-z0-9_]{0,62}$/.test(x))fail('REHEARSAL_IDENTIFIER_INVALID');return '"'+x+'"';};
export function validateRestoredReview(r,e,now=new Date()){
 if(r?.schema!=='packproof.zero-touch-restored-review/v1'||r.source!==source||r.imageDigest!==image||r.syntheticOnly!==true||r.originalInventorySha256!==baseline||r.inventorySha256!==inventoryHash)fail('REHEARSAL_EXACT_REVIEW_REQUIRED');
 if(!/^[a-f0-9]{64}$/.test(r.originalDataSha256??'')||!/^[a-f0-9]{64}$/.test(r.originalDataReceiptSha256??''))fail('REHEARSAL_SOURCE_DATA_RECEIPT_REQUIRED');
 if(r.snapshotArn!=='arn:aws:rds:us-east-1:784514617543:snapshot:packproof-zero-touch-3bff0173'||r.instanceArn!=='arn:aws:rds:us-east-1:784514617543:db:packproof-zero-touch-3bff0173')fail('REHEARSAL_RESTORED_RESOURCE_REQUIRED');
 if(!/^packproof-zero-touch-3bff0173\.[a-z0-9]+\.us-east-1\.rds\.amazonaws\.com$/.test(r.target?.host??'')||r.target.database!=='m1_service_20261021')fail('REHEARSAL_ISOLATED_HOST_REQUIRED');
 const remaining=Date.parse(r.expiresAt)-now.getTime();if(!Number.isFinite(remaining)||remaining<=0||remaining>3600000)fail('REHEARSAL_REVIEW_EXPIRED');
 if(e.PACKPROOF_ZERO_TOUCH_REHEARSAL_ENTRYPOINT!=='true'||e.PACKPROOF_TEST_PURPOSE!=='isolated-m1-synthetic'||e.PACKPROOF_DB_HOST!==r.target.host||e.PACKPROOF_DB_NAME!==r.target.database||e.PACKPROOF_DB_USER!=='packproof'||e.PACKPROOF_MIGRATE_ON_START!=='false'||e.PACKPROOF_ENVIRONMENT!=='staging'||e.PACKPROOF_RELEASE_SHA!==source)fail('REHEARSAL_RUNTIME_BINDING_REQUIRED');
 return hash(r);
}
async function columns(db,includeLedger=false){return (await db.query("SELECT c.relname,a.attname FROM pg_class c JOIN pg_attribute a ON a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped WHERE c.relnamespace='public'::regnamespace AND c.relkind='r' AND($1::boolean OR c.relname<>'schema_migrations') ORDER BY c.relname,a.attnum",[includeLedger])).rows;}
async function dataSnapshot(db,shape){
 const result=[];
 for(const table of [...new Set(shape.map(x=>x.relname))]){
  const fields=shape.filter(x=>x.relname===table).map(x=>q(x.attname)).join(',');
  const rows=(await db.query(`SELECT to_jsonb(t) AS row FROM (SELECT ${fields} FROM public.${q(table)}) t ORDER BY to_jsonb(t)::text LIMIT 100001`)).rows;
  if(rows.length>100000)fail('REHEARSAL_DATA_BOUND_EXCEEDED');
  result.push({table,count:rows.length,sha256:hash(rows)});
 }
 return {tables:result.length,rows:result.reduce((n,x)=>n+x.count,0),sha256:hash(result)};
}
async function catalogShape(db,tables,functionOids){
 const columns=(await db.query("SELECT c.relname,a.attname,a.atttypid,a.atttypmod,a.attnotnull,a.attacl::text AS acl,pg_get_expr(d.adbin,d.adrelid) AS default_value,c.relowner,c.relacl::text AS table_acl FROM pg_class c JOIN pg_attribute a ON a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped LEFT JOIN pg_attrdef d ON d.adrelid=c.oid AND d.adnum=a.attnum WHERE c.relnamespace='public'::regnamespace AND c.relname=ANY($1::text[]) AND NOT(c.relname='partner_import_jobs' AND a.attname='source_control_revision') ORDER BY c.relname,a.attnum",[tables])).rows;
 const constraints=(await db.query("SELECT c.relname,k.conname,k.convalidated,pg_get_constraintdef(k.oid) AS definition FROM pg_constraint k JOIN pg_class c ON c.oid=k.conrelid WHERE c.relnamespace='public'::regnamespace AND c.relname=ANY($1::text[]) AND NOT(c.relname='partner_import_jobs' AND k.conname='partner_import_jobs_source_control_revision_check') ORDER BY c.relname,k.conname",[tables])).rows;
 const triggers=(await db.query("SELECT c.relname,t.tgname,t.tgenabled,pg_get_triggerdef(t.oid) AS definition FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid WHERE c.relnamespace='public'::regnamespace AND c.relname=ANY($1::text[]) AND NOT t.tgisinternal AND NOT(c.relname='partner_import_jobs' AND t.tgname='partner_import_source_control') ORDER BY c.relname,t.tgname",[tables])).rows;
 const indexes=(await db.query("SELECT c.relname,pg_get_indexdef(i.indexrelid) AS definition FROM pg_index i JOIN pg_class c ON c.oid=i.indrelid WHERE c.relnamespace='public'::regnamespace AND c.relname=ANY($1::text[]) ORDER BY c.relname,i.indexrelid",[tables])).rows;
 const functions=(await db.query('SELECT oid,proname,proowner,prosrc,prosecdef,proconfig,proacl::text AS acl FROM pg_proc WHERE oid=ANY($1::oid[]) ORDER BY oid',[functionOids])).rows;
 const schema=(await db.query("SELECT nspowner,nspacl::text AS acl FROM pg_namespace WHERE nspname='public'")).rows;
 const memberships=(await db.query('SELECT roleid,member,grantor,admin_option,inherit_option,set_option FROM pg_auth_members ORDER BY roleid,member')).rows;
 return hash({columns,constraints,triggers,indexes,functions,schema,memberships});
}
async function controls(db){
 const roles=(await db.query("SELECT rolname,rolcanlogin,rolsuper,rolcreatedb,rolcreaterole,rolinherit,rolreplication,rolbypassrls FROM pg_roles WHERE rolname IN ('m1_service_api','m1_service_worker') ORDER BY rolname")).rows;
 const writer=(await db.query('SELECT writes_enabled FROM recovery_writer_fence WHERE singleton=1')).rows;
 const policy=(await db.query('SELECT durability_required FROM policy_recovery_fence WHERE singleton=1')).rows;
 if(roles.length!==2||roles.some(r=>r.rolcanlogin)||writer.length!==1||writer[0].writes_enabled!==false||policy.length!==1||policy[0].durability_required!==true)fail('REHEARSAL_PRESERVED_CONTROLS_REQUIRED');
 return {roles,writer,policy};
}
function verifier(password){
 const salt=randomBytes(24),salted=pbkdf2Sync(password,salt,4096,32,'sha256');
 const client=createHmac('sha256',salted).update('Client Key').digest();
 return 'SCRAM-SHA-256$4096:'+salt.toString('base64')+'$'+createHash('sha256').update(client).digest('base64')+':'+createHmac('sha256',salted).update('Server Key').digest('base64');
}
export async function runRestoredRehearsal(e=process.env){
 let owner,prefix,stage='review';const sessions=[];
 const timeout=setTimeout(()=>process.exit(2),600000);timeout.unref();
 try{
  const review=JSON.parse(e.ZERO_TOUCH_REHEARSAL_REVIEW_JSON??'{}'),reviewSha256=validateRestoredReview(review,e);
  assert.ok(e.PACKPROOF_DB_PASSWORD&&process.getuid()!==0);
  const [{createPgDatabase},{migrationInventory,migrate,assertSchemaCurrent},{inspectSourceAssociationInventory},{recordsMigrationInventory,planRecordsRuntimePrivileges,verifyRecordsRuntimePrivileges},{default:pg}]=await Promise.all([
   import('/app/backend/dist/db/postgres.js'),import('/app/backend/dist/db/migrate.js'),import('/app/backend/scripts/source-association-migration-inventory.mjs'),import('/app/backend/scripts/records-runtime-privileges.mjs'),import('pg')]);
  const url=new URL('postgresql://'+review.target.host+':5432/'+review.target.database+'?sslmode=verify-full');url.username='packproof';url.password=e.PACKPROOF_DB_PASSWORD;
  owner=createPgDatabase(url.href);stage='source_inventory';
  const inventory=await migrationInventory(),previous=inventory.filter(x=>x.id!=='109_source_associations');
  inspectSourceAssociationInventory(inventory,inventory,{reviewedSourceCommit:source,reviewedInventorySha256:inventoryHash});
  prefix=await mkdtemp('/tmp/zero-touch-prefix-');
  for(const x of previous)await writeFile(prefix+'/'+x.id+'.sql',x.sql);
  stage='restored_migration';
  const migration=await owner.db.transaction(async tx=>{
   await tx.query("SET LOCAL lock_timeout='15s'");await tx.query("SET LOCAL statement_timeout='120s'");
   await tx.query("SET LOCAL timezone='UTC'");
   const identity=(await tx.query('SELECT current_user AS role,session_user AS login,current_database() AS database')).rows[0];
   const tls=(await tx.query('SELECT ssl,version FROM pg_stat_ssl WHERE pid=pg_backend_pid()')).rows[0];
   assert.equal(identity.role,'packproof');assert.equal(identity.login,'packproof');assert.equal(identity.database,review.target.database);assert.equal(tls.ssl,true);
   const original=(await tx.query('SELECT id,checksum FROM schema_migrations ORDER BY id')).rows;
   if(original.length!==91||hash(original)!==baseline)fail('REHEARSAL_ORIGINAL_RECEIPTS_MISMATCH');
   const expected=new Map(inventory.map(x=>[x.id,x.checksum]));if(original.some(x=>expected.get(x.id)!==x.checksum))fail('REHEARSAL_HISTORICAL_BYTES_MISMATCH');
   const controlBefore=await controls(tx);
   const originalData=await dataSnapshot(tx,await columns(tx,true));
   if(originalData.sha256!==review.originalDataSha256)fail('REHEARSAL_RESTORED_DATA_MISMATCH');
   // The existing adapter's nested transactions retain this outer transaction;
   // a failure rolls back the full synthetic 092 -> 109 upgrade.
   await migrate(tx,prefix,{expectedRole:'packproof',adoptLegacyChecksums:false});
   const pre109=(await tx.query('SELECT id,checksum FROM schema_migrations ORDER BY id')).rows;
   if(!inspectSourceAssociationInventory(inventory,pre109,{reviewedSourceCommit:source,reviewedInventorySha256:inventoryHash}).pending)fail('REHEARSAL_PREDECESSOR_REQUIRED');
   const shape=await columns(tx),tables=[...new Set(shape.map(x=>x.relname))];
   await tx.query(`LOCK TABLE ${tables.map(x=>'public.'+q(x)).join(',')} IN SHARE ROW EXCLUSIVE MODE`);
   const before=await dataSnapshot(tx,shape),functionOids=(await tx.query("SELECT oid FROM pg_proc WHERE pronamespace='public'::regnamespace ORDER BY oid")).rows.map(x=>x.oid);
   const catalogBefore=await catalogShape(tx,tables,functionOids);
   await migrate(tx,undefined,{expectedRole:'packproof',adoptLegacyChecksums:false});
   // New authority tables must not inherit permissive legacy defaults.
   const names=['record_source_crosswalks','record_source_pending','record_source_resolution_attempts'];
   const inherited=(await tx.query('SELECT DISTINCT c.relname,a.grantee,r.rolname FROM pg_class c CROSS JOIN LATERAL aclexplode(c.relacl) a LEFT JOIN pg_roles r ON r.oid=a.grantee WHERE c.relnamespace=\'public\'::regnamespace AND c.relname=ANY($1::text[]) AND a.grantee<>c.relowner',[names])).rows;
   for(const g of inherited)await tx.query(`REVOKE ALL PRIVILEGES ON TABLE public.${q(g.relname)} FROM ${Number(g.grantee)===0?'PUBLIC':q(g.rolname)}`);
   await assertSchemaCurrent(tx);
   const applied=(await tx.query('SELECT id,checksum FROM schema_migrations ORDER BY id')).rows;
   assert.equal(inspectSourceAssociationInventory(inventory,applied,{reviewedSourceCommit:source,reviewedInventorySha256:inventoryHash}).pending,false);
   const after=await dataSnapshot(tx,shape),controlAfter=await controls(tx),catalogAfter=await catalogShape(tx,tables,functionOids);
   if(hash(before)!==hash(after)||hash(controlBefore)!==hash(controlAfter)||catalogBefore!==catalogAfter)fail('REHEARSAL_PRESERVATION_MISMATCH');
   return {identity,tls,originalData,originalDataReceiptSha256:review.originalDataReceiptSha256,originalMigrationCount:original.length,predecessorMigrationCount:pre109.length,appliedMigrationCount:applied.length,before109:before,after109:after,catalogBeforeSha256:catalogBefore,catalogAfterSha256:catalogAfter,preservedControlsSha256:hash(controlAfter),legacyDefaultGrantsRemoved:inherited.length};
  });
  console.log(JSON.stringify({event:'zero_touch_restore_migrated',reviewSha256,source,imageDigest:image,...migration}));
  stage='separate_runtime_logins';
  const apiRole='zero_touch_api_3bff0173',workerRole='zero_touch_worker_3bff0173';
  const passwords=new Map([[apiRole,randomBytes(32).toString('hex')],[workerRole,randomBytes(32).toString('hex')]]);
  const records=await recordsMigrationInventory(),options={runtimeRole:apiRole,workerRole,schema:'public',reviewedSourceCommit:source,reviewedMigrationSha256:records.migrationSha256};
  const privilegePlan=await owner.db.transaction(async tx=>{
   for(const [role,password] of passwords){
    await tx.query(`CREATE ROLE ${q(role)} LOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS CONNECTION LIMIT 2 PASSWORD ${pg.escapeLiteral(verifier(password))} VALID UNTIL ${pg.escapeLiteral(new Date(Date.now()+900000).toISOString())}`);
    await tx.query(`GRANT CONNECT ON DATABASE ${q(review.target.database)} TO ${q(role)}`);
    await tx.query(`GRANT USAGE ON SCHEMA public TO ${q(role)}`);
    await tx.query(`GRANT SELECT(id,checksum) ON public.schema_migrations TO ${q(role)}`);
   }
   const plan=await planRecordsRuntimePrivileges(tx,options);for(const sql of plan.statements)await tx.query(sql);return plan;
  });
  const receipts=[];let allowed=0,denied=0;
  for(const [kind,role] of [['api',apiRole],['worker',workerRole]]){
   const u=new URL(url);u.username=role;u.password=passwords.get(role);const login=createPgDatabase(u.href);sessions.push(login);
   const identity=(await login.db.query('SELECT current_user AS role,session_user AS login')).rows[0];assert.equal(identity.role,role);assert.equal(identity.login,role);
   const tls=(await login.db.query('SELECT ssl FROM pg_stat_ssl WHERE pid=pg_backend_pid()')).rows[0];assert.equal(tls.ssl,true);
   receipts.push(await verifyRecordsRuntimePrivileges(login.db,options));
   await login.db.query('SELECT id FROM record_source_pending WHERE false');allowed++;
   if(kind==='api'){await login.db.query('INSERT INTO record_source_crosswalks(id) SELECT id FROM record_source_crosswalks WHERE false');allowed++;}
   else {await login.db.query('UPDATE record_source_pending SET state=state WHERE false');allowed++;}
   const statements=['UPDATE record_source_pending SET payload_canonical=payload_canonical WHERE false','DELETE FROM record_source_pending WHERE false'];
   if(kind==='worker')statements.push('INSERT INTO record_source_crosswalks(id) SELECT id FROM record_source_crosswalks WHERE false','UPDATE record_source_pending SET replay_revision=replay_revision WHERE false');
   else statements.push('INSERT INTO record_source_artifact_results(operation_id) SELECT operation_id FROM record_source_artifact_results WHERE false');
   for(const sql of statements){let rejected=false;try{await login.db.query(sql);}catch(error){if(error?.code!=='42501')throw error;rejected=true;}if(!rejected)fail('REHEARSAL_PERMISSION_DENIAL_MISSING');denied++;}
  }
  await controls(owner.db);
  console.log(JSON.stringify({event:'zero_touch_restored_rehearsal_complete',schema:'packproof.zero-touch-restored-rehearsal/v1',status:'PASSED',completedAt:new Date().toISOString(),reviewSha256,source,imageDigest:image,target:review.target,snapshotArn:review.snapshotArn,migration,privilegePolicySha256:privilegePlan.policySha256,actualLoginReceipts:receipts,allowedSqlChecks:allowed,deniedSqlChecks:denied,fullApplicationBaselineQualified:false,previousImageRehearsal:false,applicationStarted:false,originalInstanceChanged:false,customerQualification:false}));
 }catch(error){console.error(JSON.stringify({event:'zero_touch_restored_rehearsal_failed',stage,code:/^[A-Z0-9_]{2,80}$/.test(error?.code??'')?error.code:/^[A-Z0-9_]{2,80}$/.test(error?.message??'')?error.message:'REHEARSAL_FAILED'}));process.exitCode=1;}
 finally{clearTimeout(timeout);for(const x of sessions)await x.close();await owner?.close();if(prefix)await rm(prefix,{recursive:true,force:true});}
}
if(process.env.PACKPROOF_ZERO_TOUCH_REHEARSAL_ENTRYPOINT==='true')await runRestoredRehearsal();
