// Read-only production inventory in the currently deployed image. Run as an
// isolated one-shot task with its existing runtime identity, never owner access.
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {pathToFileURL} from 'node:url';
import path from 'node:path';
const moduleAt=name=>import(pathToFileURL(path.join(process.cwd(),'dist',name)).href);
const digest=value=>createHash('sha256').update(value).digest('hex');
let opened;
try {
 const source='ccd04aba5b9305ce9bb7b2105323e63f6a95d87a';
 assert.equal(process.env.PACKPROOF_RELEASE_SHA,source);
 const {loadConfig}=await moduleAt('config.js'),{openDatabase}=await moduleAt('db/open.js');
 const {migrationInventory}=await moduleAt('db/migrate.js');
 const config=loadConfig(),url=new URL(config.databaseUrl);
 assert.equal(config.migrateOnStart,false);assert.equal(config.release.environment,'production');
 assert.equal(url.hostname,'packproof-v2-staging-db.c8v2esku2zyt.us-east-1.rds.amazonaws.com');
 assert.equal(url.pathname,'/packproof_v2');assert.equal(decodeURIComponent(url.username),'packproof_app_runtime_v1');
 opened=await openDatabase(config);assert.equal(opened.engine,'postgres');
 const inventory=(await migrationInventory()).map(({id,checksum})=>({id,checksum}));
 const result=await opened.db.transaction(async db=>{
  await db.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
  await db.query("SET LOCAL statement_timeout='15000ms'");
  const identity=(await db.query("SELECT current_user AS role,current_database() AS database,current_setting('transaction_read_only') AS read_only")).rows[0];
  const tls=(await db.query('SELECT ssl,version FROM pg_stat_ssl WHERE pid=pg_backend_pid()')).rows[0];
  assert.equal(identity.role,'packproof_app_runtime_v1');assert.equal(identity.database,'packproof_v2');assert.equal(identity.read_only,'on');assert.equal(tls.ssl,true);
  const applied=(await db.query('SELECT id,checksum,checksum_provenance FROM schema_migrations ORDER BY id')).rows;
  assert.equal(applied.length,inventory.length);
  assert.ok(inventory.every(row=>applied.some(a=>a.id===row.id&&a.checksum===row.checksum)));
  const authority=(await db.query("SELECT rolsuper,rolcreatedb,rolcreaterole,rolbypassrls,has_schema_privilege(current_user,'public','CREATE') AS schema_create,has_table_privilege(current_user,'schema_migrations','INSERT,UPDATE,DELETE') AS migration_write FROM pg_roles WHERE rolname=current_user")).rows[0];
  assert.ok(Object.values(authority).every(value=>value===false));
  const manifests=(await db.query('SELECT proof_id,canonical_json,sha256,signature_algorithm,signature_base64,signing_key_id FROM final_manifests ORDER BY proof_id')).rows;
  assert.ok(manifests.every(row=>digest(row.canonical_json)===row.sha256));
  const frozenDigest=digest(JSON.stringify(manifests.map(({canonical_json,...row})=>row)));
  const evidence=(await db.query('SELECT id,proof_id,sha256,byte_size,object_key,object_version_id FROM evidence WHERE committed_at IS NOT NULL ORDER BY id')).rows;
  const policy=(await db.query('SELECT durability_required FROM policy_recovery_fence WHERE singleton=1')).rows;
  const writer=(await db.query('SELECT generation,writes_enabled FROM recovery_writer_fence WHERE singleton=1')).rows;
  return {identity,tls,authority,applied,policy,writer,manifestCount:manifests.length,frozenManifestInventorySha256:frozenDigest,
   committedEvidenceCount:evidence.length,committedEvidenceInventorySha256:digest(JSON.stringify(evidence)),sourceMigrationCount:inventory.length};
 });
 console.log(JSON.stringify({event:'foundation_production_readonly_inventory',source,observedAt:new Date().toISOString(),status:'PASSED',...result}));
}catch(error){console.log(JSON.stringify({event:'foundation_production_readonly_inventory',status:'FAILED',code:error.code??error.name}));process.exitCode=1;}
finally{await opened?.close();}
