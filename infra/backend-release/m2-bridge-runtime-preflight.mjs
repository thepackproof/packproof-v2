// Exact inactive M2 bridge verification. Read-only production connection; no application/worker startup.
// Existing injected runtime credentials remain in the task; output is aggregate only.
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {pathToFileURL} from 'node:url';
import path from 'node:path';
const at=name=>import(pathToFileURL(path.join(process.cwd(),'dist',name)).href);
const hash=value=>createHash('sha256').update(value).digest('hex');
const inventoryHash=rows=>hash(JSON.stringify(rows.map(({id,checksum})=>({id,checksum})).sort((a,b)=>a.id.localeCompare(b.id))));
const baseline='4c8fdf8c9a1c08b22c1b13ddd54dc34c7e51cdd3a1dc238edb5485a7a970556e';
const sources={'99bb2dfe0eb16d8d513617fdd4b9608d7baac3f9':'sha256:bfe92a04ea17de5b44bf3e7c7d34929669b40ef903d14f81d3be33cfef6362a2','399f306a2fdac37511c8659c73d5a059dd759b7a':'sha256:434f5cd40bf365a6bdf585fa6302f786ea4571dda892fd761c3dbd85d6b5aa54'};
let opened,phase='configuration';
try {
 const source=process.env.PACKPROOF_RELEASE_SHA,count=91;
 assert.ok(sources[source]);assert.equal(process.env.PACKPROOF_RELEASE_IMAGE,'784514617543.dkr.ecr.us-east-1.amazonaws.com/packproof-v2-staging-api@'+sources[source]);
 assert.notEqual(process.env.PACKPROOF_CLAIM_EXPORTS_ENABLED,'true');
 assert.ok(count);assert.notEqual(process.env.PACKPROOF_ORGANIZATIONS_ENABLED,'true');
 const {loadConfig}=await at('config.js'),{openDatabase}=await at('db/open.js');
 const {migrationInventory,assertSchemaCurrent}=await at('db/migrate.js');
 const config=loadConfig(),url=new URL(config.databaseUrl);
 assert.equal(config.migrateOnStart,false);assert.equal(config.release.environment,'production');
 assert.equal(config.awsS3Bucket,'packproof-v2-evidence-staging-20260829-a7f3');
 assert.equal(process.env.PACKPROOF_COMMITTED_S3_BUCKET??config.awsS3Bucket,config.awsS3Bucket);
 assert.equal(url.hostname,'packproof-v2-staging-db.c8v2esku2zyt.us-east-1.rds.amazonaws.com');
 assert.equal(url.pathname,'/packproof_v2');assert.equal(decodeURIComponent(url.username),'packproof_app_runtime_v1');
 const inventory=await migrationInventory();assert.equal(inventory.length,count);
 assert.equal(inventoryHash(inventory),baseline);
 opened=await openDatabase(config);assert.equal(opened.engine,'postgres');phase='database';
 const snapshot=await opened.db.transaction(async db=>{
  await db.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
  await db.query("SET LOCAL statement_timeout='15s'");
  const identity=(await db.query("SELECT current_user AS role,session_user AS login,current_database() AS database,current_setting('transaction_read_only') AS read_only")).rows[0];
  const tls=(await db.query('SELECT ssl,version FROM pg_stat_ssl WHERE pid=pg_backend_pid()')).rows[0];
  assert.equal(identity.role,'packproof_app_runtime_v1');assert.equal(identity.login,identity.role);
  assert.equal(identity.database,'packproof_v2');assert.equal(identity.read_only,'on');assert.equal(tls.ssl,true);
  await assertSchemaCurrent(db);
  const applied=(await db.query('SELECT id,checksum FROM schema_migrations ORDER BY id')).rows;
  assert.ok([91,94].includes(applied.length));assert.equal(inventoryHash(applied.filter(r=>!/^09[345]_/.test(r.id))),baseline);
  assert.equal((await db.query('SELECT COUNT(*) AS count FROM platform_organizations')).rows[0].count,'0');
  assert.equal((await db.query("SELECT COUNT(*) AS count FROM recipient_export_jobs WHERE state NOT IN ('READY','FAILED')")).rows[0].count,'0');
  const authority=(await db.query("SELECT rolsuper,rolcreatedb,rolcreaterole,rolreplication,rolbypassrls,pg_has_role(current_user,'packproof','MEMBER') AS owner_member,pg_has_role(current_user,'packproof','SET') AS owner_set,has_schema_privilege(current_user,'public','CREATE') AS schema_create,has_table_privilege(current_user,'schema_migrations','INSERT,UPDATE,DELETE') AS migration_write FROM pg_roles WHERE rolname=current_user")).rows[0];
  assert.ok(Object.values(authority).every(value=>value===false));
  const policy=(await db.query('SELECT durability_required FROM policy_recovery_fence WHERE singleton=1')).rows[0];
  assert.equal(policy.durability_required,config.requireDurableReceipts===true);
  const manifests=(await db.query('SELECT proof_id,canonical_json,sha256,signature_algorithm,signature_base64,signing_key_id FROM final_manifests ORDER BY proof_id')).rows;
  assert.ok(manifests.every(row=>hash(row.canonical_json)===row.sha256));
  const evidence=(await db.query('SELECT id,proof_id,sha256,byte_size,object_key,object_version_id FROM evidence WHERE committed_at IS NOT NULL ORDER BY id')).rows;
  return {identity,tls,applied,manifests,evidence,authority};
 });
 // Release the database snapshot before potentially slow object reads.
 await opened.close();opened=undefined;phase='original_versions';
 const {AwsS3ObjectStore}=await at('s3/aws-s3-object-store.js');
 const store=new AwsS3ObjectStore(config.awsS3Bucket,{region:config.awsRegion});
 let verifiedBytes=0;
 for(const row of snapshot.evidence){
  assert.ok(row.object_version_id&&row.object_version_id!=='null');
  const result=await store.digest(row.object_key,{versionId:row.object_version_id});
  assert.ok(result);assert.equal(result.versionId,row.object_version_id);
  assert.equal(result.sha256,row.sha256);assert.equal(result.byteSize,Number(row.byte_size));verifiedBytes+=result.byteSize;
 }
 phase='manifest_signatures';
 const {initializeManifestSigningRuntime}=await at('integrity/kms-signing-runtime.js');
 const {verifyManifestIntegrity}=await at('domain/manifest-signing.js');
 const trust=await initializeManifestSigningRuntime({now:()=>new Date()});
 let signed=0,unsigned=0;
 for(const row of snapshot.manifests){
  if(!row.signature_base64){assert.equal(row.signature_algorithm,null);unsigned++;continue;}
  const key=trust.trustList?.keys.find(key=>key.keyId===row.signing_key_id);assert.ok(key);
  const result=verifyManifestIntegrity({canonicalJson:row.canonical_json,expectedSha256:row.sha256,publicKeyPem:key.publicKeyPem,
   signature:{algorithm:row.signature_algorithm,keyId:row.signing_key_id,signatureBase64:row.signature_base64,signedAt:''}});
  assert.equal(result.signatureValid,true);signed++;
 }
 const {manifests,evidence,...rest}=snapshot;
 console.log(JSON.stringify({event:'m2_bridge_runtime_preflight',status:'PASSED',source,image:process.env.PACKPROOF_RELEASE_IMAGE,observedAt:new Date().toISOString(),
  ...rest,sourceMigrationCount:count,manifestCount:manifests.length,signedVerified:signed,legacyUnsigned:unsigned,
  frozenManifestInventorySha256:hash(JSON.stringify(manifests.map(({canonical_json,...row})=>row))),
  committedEvidenceCount:evidence.length,committedEvidenceInventorySha256:hash(JSON.stringify(evidence)),exactVersionsVerified:evidence.length,verifiedBytes,
  runtimeAuthoritySafe:true,organizationCount:0,inFlightRecipientJobs:0,durabilityPolicyMatches:true}));
}catch(error){console.log(JSON.stringify({event:'m2_bridge_runtime_preflight',status:'FAILED',phase,code:error.code??error.name}));process.exitCode=1;}
finally{await opened?.close();}
