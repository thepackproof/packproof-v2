// Temporary owner-only setup/close/restore control. Never copied into the image.
import assert from 'node:assert/strict';
import {randomBytes,createPublicKey} from 'node:crypto';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
import {S3Client,PutObjectCommand,GetBucketVersioningCommand,GetObjectLockConfigurationCommand} from '@aws-sdk/client-s3';
import {KMSClient,GetPublicKeyCommand} from '@aws-sdk/client-kms';
import {SecretsManagerClient,PutSecretValueCommand} from '@aws-sdk/client-secrets-manager';
import {createPgDatabase} from '../src/db/postgres.ts';
import {migrate,migrationInventory} from '../src/db/migrate.ts';
import {splitSqlStatements} from '../src/db/sql.ts';
import {insertUser} from '../src/domain/users.ts';
import {createTransaction} from '../src/domain/transactions.ts';
import {createOrGetProof} from '../src/domain/create-proof.ts';
import {commitAttestation} from '../src/domain/attestations.ts';
import {finalizeProof} from '../src/domain/finalize.ts';
import {configurePolicyDurability} from '../src/domain/policy-recovery.ts';
import {initializeManifestSigningRuntime} from '../src/integrity/kms-signing-runtime.ts';
import {AwsS3ObjectStore} from '../src/s3/aws-s3-object-store.ts';
import {canonicalize} from '../src/canonical.ts';
import {sha256Hex} from '../src/hash.ts';

const region='us-east-1',account='784514617543',host='packproof-m1-20261020-db.c8v2esku2zyt.us-east-1.rds.amazonaws.com';
const database='m2_integrity_20261022',restoreDatabase='m2_integrity_restore_20261022',workerRole='m2_envelope_worker',restoreRole='packproof_restore_m2_20261022';
assert.equal(process.env.PACKPROOF_TEST_PURPOSE,'isolated-m2-synthetic');assert.equal(process.env.PACKPROOF_TEST_DB_HOST,host);
assert.match(process.env.CANDIDATE_SHA??'',/^[a-f0-9]{40}$/);
const mode=process.env.M2_CONTROL;assert.ok(['bootstrap','restore-bootstrap','inspect','close'].includes(mode));
const owner=JSON.parse(process.env.ISOLATED_DB_SECRET);delete process.env.ISOLATED_DB_SECRET;assert.equal(owner.username,'packproof');
process.env.PACKPROOF_DB_CA_FILE='/tmp/packproof-rds-ca.pem';
const connect=name=>{const url=new URL(`postgresql://${host}:5432/${name}?sslmode=verify-full`);url.username=owner.username;url.password=owner.password;return createPgDatabase(url.toString());};
const env=name=>{const value=process.env[`M2_${name}`];assert.ok(value,`Missing M2_${name}`);return value;};
const bucket=name=>{const value=env(`${name}_BUCKET`);assert.match(value,/^packproof-m2-20261022-envelope-/);return value;};
const key=name=>{const value=env(`${name}_KEY_ARN`);assert.match(value,/^arn:aws:kms:us-east-1:784514617543:key\/[a-f0-9-]{36}$/);return value;};
const secret=name=>{const value=env(`${name}_DATABASE_SECRET`);assert.ok(value.startsWith(`arn:aws:secretsmanager:${region}:${account}:secret:packproof-m2-20261022-envelope/`));return value;};
const s3=new S3Client({region}),kms=new KMSClient({region}),secrets=new SecretsManagerClient({region});
const admin=connect('packproof_v2');let opened;
const clock={now:()=>new Date()};
const receipt={schema:'packproof.isolated-envelope-control.v1',mode,source:process.env.CANDIDATE_SHA,buildId:process.env.CODEBUILD_BUILD_ID,syntheticOnly:true,productionChanged:false};
async function createFresh(name,role,secretArn,restoring=false){
 assert.equal((await admin.db.query('SELECT 1 FROM pg_database WHERE datname=$1',[name])).rows.length,0,'Refusing to overwrite an existing database');
 assert.equal((await admin.db.query('SELECT 1 FROM pg_roles WHERE rolname=$1',[role])).rows.length,0,'Refusing to replace an existing role');
 const inventory=await migrationInventory();assert.equal(inventory.length,92);assert.equal(inventory.at(-1).id,'093_integrity_envelope_jobs');
 await admin.db.query(`CREATE DATABASE ${name}`);await admin.db.query(`REVOKE CONNECT ON DATABASE ${name} FROM PUBLIC`);
 const db=connect(name);opened=db;await migrate(db.db);
 const password=randomBytes(32).toString('hex');
 await admin.db.query(`CREATE ROLE ${role} LOGIN INHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD '${password}'`);
 await admin.db.query(`GRANT CONNECT ON DATABASE ${name} TO ${role}`);
 if(restoring){
  await db.db.query('REVOKE CREATE ON SCHEMA public FROM PUBLIC');
  await db.db.query(`GRANT USAGE ON SCHEMA public TO ${role}`);
  await db.db.query(`GRANT SELECT,INSERT,UPDATE ON ALL TABLES IN SCHEMA public TO ${role}`);
  await db.db.query(`GRANT USAGE,SELECT,UPDATE ON ALL SEQUENCES IN SCHEMA public TO ${role}`);
  await db.db.query("UPDATE recovery_writer_fence SET writes_enabled=false,generation='m2-restored-20261022'");
 }else{
  for(const statement of splitSqlStatements(await readFile(new URL('../../infra/sql/runtime-roles.sql',import.meta.url),'utf8')))await db.db.query(statement);
  await db.db.query(`GRANT packproof_runtime,packproof_recovery TO ${role}`);
  await db.db.query("UPDATE recovery_writer_fence SET generation='m2-envelope-20261022',writes_enabled=true");
 }
 await secrets.send(new PutSecretValueCommand({SecretId:secretArn,SecretString:password}));
 receipt.database=name;receipt.role=role;receipt.migrations={count:inventory.length,sha256:sha256Hex(JSON.stringify(inventory.map(({id,checksum})=>({id,checksum}))))};
 return db.db;
}
try{
 if(mode==='bootstrap'){
  const upload=bucket('UPLOAD'),committed=bucket('COMMITTED'),journal=bucket('JOURNAL'),artifact=bucket('ARTIFACT');
  const keyIds={manifest:key('MANIFEST'),recovery:key('RECOVERY'),envelope:key('ENVELOPE')};
  assert.equal(new Set(Object.values(keyIds)).size,3);assert.equal(new Set([upload,committed,journal,artifact]).size,4);
  const protection=[];
  for(const Bucket of [committed,journal,artifact]){
   assert.equal((await s3.send(new GetBucketVersioningCommand({Bucket,ExpectedBucketOwner:account}))).Status,'Enabled');
   const lock=(await s3.send(new GetObjectLockConfigurationCommand({Bucket,ExpectedBucketOwner:account}))).ObjectLockConfiguration;
   assert.equal(lock?.ObjectLockEnabled,'Enabled');assert.equal(lock.Rule?.DefaultRetention?.Mode,'COMPLIANCE');assert.ok(lock.Rule.DefaultRetention.Days>=2);
   protection.push({bucket:Bucket,versioning:'Enabled',objectLock:lock});
  }
  const publicKeys={};
  for(const [name,KeyId] of Object.entries(keyIds)){
   const result=await kms.send(new GetPublicKeyCommand({KeyId}));assert.equal(result.KeyId,KeyId);assert.equal(result.KeySpec,'ECC_NIST_P256');assert.equal(result.KeyUsage,'SIGN_VERIFY');
   publicKeys[name]=createPublicKey({key:Buffer.from(result.PublicKey),format:'der',type:'spki'}).export({format:'pem',type:'spki'}).toString();
  }
  // Validate fixture tooling before creating any database or credential.
  const mp4='/tmp/m2-synthetic-original.mp4';
  const generated=spawnSync('ffmpeg',['-hide_banner','-loglevel','error','-f','lavfi','-i','color=c=blue:s=160x120:r=10','-t','1','-an','-c:v','libx264','-pix_fmt','yuv420p','-movflags','+faststart','-y',mp4],{stdio:'ignore'});
  assert.equal(generated.status,0,'Synthetic video generation failed');const bytes=await readFile(mp4);
  const signing=await initializeManifestSigningRuntime(clock,{PACKPROOF_MANIFEST_SIGNING_MODE:'kms',PACKPROOF_MANIFEST_SIGNING_REQUIRED:'true',PACKPROOF_MANIFEST_KMS_KEY_ARN:keyIds.manifest,PACKPROOF_MANIFEST_SIGNING_KEY_ID:keyIds.manifest,PACKPROOF_MANIFEST_SIGNING_ALGORITHM:'ECDSA_SHA_256'});
  const db=await createFresh(database,workerRole,secret('WORKER'));
  const actor=await insertUser(db,clock,'m2_synthetic_operator_20261022'),transaction=await createTransaction(db,clock,actor,{itemTitle:'Synthetic envelope preservation fixture'});
  const proof=await createOrGetProof(db,clock,actor,transaction.transactionId,{participationPolicy:'COUNTERPARTY_OPTIONAL'});
  const evidenceId='evd_m2_synthetic_20261022',store=new AwsS3ObjectStore(upload,{region,committedBucket:committed});
  const staging=`evidence/${proof.proofId}/${evidenceId}/object`;
  await store.put(staging,bytes,'video/mp4');const object=await store.commitUpload(staging,{sha256:sha256Hex(bytes),byteSize:bytes.length,contentType:'video/mp4'});assert.ok(object?.versionId);
  const at=clock.now().toISOString();
  // Explicit owner-seeded LEGACY_UNKNOWN test fixture: this does not assert a
  // real person recorded or attested to a physical event, or test the HTTP path.
  await db.query("INSERT INTO evidence(id,proof_id,submitted_by,object_key,object_version_id,staging_version_id,content_type,byte_size,sha256,created_at,committed_at,validation_status,evidence_type,capture_origin) VALUES($1,$2,$3,$4,$5,$6,'video/mp4',$7,$8,$9,$9,'COMMITTED','FULFILLMENT_CAPTURE','LEGACY_UNKNOWN')",[evidenceId,proof.proofId,actor,object.key,object.versionId,object.stagingVersionId,object.byteSize,object.sha256,at]);
  await commitAttestation(db,clock,actor,proof.proofId,{statement:'PACKED_DESCRIBED_ITEM',relatedEvidenceId:evidenceId});
  const finalized=await finalizeProof(db,clock,actor,proof.proofId,signing.signer);
  await configurePolicyDurability(db,{required:true});
  const publishedAt=clock.now().toISOString(),retainUntil=new Date(clock.now().getTime()+86400000).toISOString();
  const registry={version:1,domain:'PACKPROOF_SIGNING_TRUST_REGISTRY',publishedAt,nextReviewAt:new Date(clock.now().getTime()+12*3600000).toISOString(),keys:[{keyId:keyIds.envelope,algorithm:'ECDSA_SHA_256',publicKeyPem:publicKeys.envelope,validFrom:publishedAt,validUntil:null,status:'ACTIVE',statusEffectiveAt:null,reason:null}]};
  const serialized=canonicalize(registry),signature=await signing.signer.signManifest({proofId:proof.proofId,manifestId:'m2-public-key-history',canonicalJson:serialized,sha256:sha256Hex(serialized)});
  const config={schema:'packproof.isolated-envelope-configuration.v1',source:process.env.CANDIDATE_SHA,database,proofId:proof.proofId,sourceOperationId:`finalize:${proof.proofId}`,frozenManifestSha256:finalized.manifest.sha256,issuer:'https://packproof-m2.test',retainUntil,writerGeneration:'m2-envelope-20261022',keys:keyIds,publicKeys,signedRegistry:{registry,signature},original:{bucket:committed,key:object.key,versionId:object.versionId,sha256:object.sha256,byteSize:object.byteSize},syntheticOnly:true,fixtureMethod:'OWNER_SEEDED_LEGACY_UNKNOWN_DOMAIN_FINALIZATION_NO_DEVICE_OR_HTTP_ASSERTION'};
  const body=Buffer.from(JSON.stringify(config)),Key='acceptance/m2/config/runtime.json';
  const saved=await s3.send(new PutObjectCommand({Bucket:upload,Key,Body:body,ContentType:'application/json',ChecksumAlgorithm:'SHA256',ChecksumSHA256:Buffer.from(sha256Hex(body),'hex').toString('base64'),ExpectedBucketOwner:account}));assert.ok(saved.VersionId);
  receipt.configuration={bucket:upload,key:Key,versionId:saved.VersionId,sha256:sha256Hex(body)};receipt.proofId=proof.proofId;receipt.manifestSha256=config.frozenManifestSha256;receipt.storageConfiguration=protection;receipt.publicKeys=publicKeys;receipt.fixtureMethod=config.fixtureMethod;
 }else if(mode==='restore-bootstrap'){
  const source=connect(database);
  try{assert.equal((await source.db.query('SELECT writes_enabled FROM recovery_writer_fence WHERE singleton=1')).rows[0].writes_enabled,false,'Fence the source database before a restore target is created');assert.equal((await source.db.query('SELECT rolcanlogin FROM pg_roles WHERE rolname=$1',[workerRole])).rows[0].rolcanlogin,false);}finally{await source.close();}
  await createFresh(restoreDatabase,restoreRole,secret('RESTORE'),true);
 }else{
  opened=connect(database);const db=opened.db;
  if(mode==='close'){
   await db.query('UPDATE recovery_writer_fence SET writes_enabled=false WHERE singleton=1');
   for(const role of [workerRole,restoreRole])if((await admin.db.query('SELECT 1 FROM pg_roles WHERE rolname=$1',[role])).rows.length)await admin.db.query(`ALTER ROLE ${role} NOLOGIN`);
   await admin.db.query("SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname IN ($1,$2) AND usename IN ($3,$4) AND pid<>pg_backend_pid()",[database,restoreDatabase,workerRole,restoreRole]);
  }
  receipt.database=database;receipt.writerFence=(await db.query('SELECT * FROM recovery_writer_fence')).rows;
  receipt.roles=(await db.query('SELECT rolname,rolcanlogin,rolsuper,rolcreatedb,rolcreaterole,rolbypassrls FROM pg_roles WHERE rolname IN ($1,$2) ORDER BY rolname',[workerRole,restoreRole])).rows;
  receipt.coreDelivery=(await db.query('SELECT state,COUNT(*) AS count FROM recovery_delivery GROUP BY state')).rows;
  receipt.policyDelivery=(await db.query('SELECT state,COUNT(*) AS count FROM policy_recovery_delivery GROUP BY state')).rows;
  receipt.envelopeDelivery=(await db.query('SELECT state,COUNT(*) AS count FROM integrity_envelope_delivery GROUP BY state')).rows;
  receipt.coreHead=(await db.query("SELECT e.sha256 FROM recovery_events e JOIN recovery_delivery d USING(operation_id) WHERE d.state='DURABLE' ORDER BY e.sequence DESC LIMIT 1")).rows[0]?.sha256??null;
  receipt.policyHead=(await db.query("SELECT event_sha256 FROM policy_recovery_delivery WHERE state='DURABLE' ORDER BY sequence DESC LIMIT 1")).rows[0]?.event_sha256??null;
 }
 receipt.status='PASSED';
}catch(error){receipt.status='FAILED';receipt.error={name:error.name,code:error.code??null};process.exitCode=1;}
finally{await opened?.close();await admin.close();await mkdir('runtime-artifacts',{recursive:true});await writeFile('runtime-artifacts/envelope-control.json',JSON.stringify(receipt,null,2)+'\n');console.log(JSON.stringify(receipt));}
