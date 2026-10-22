// Temporary synthetic fixture owner. Never copied into a workload image.
import assert from 'node:assert/strict';
import {randomBytes,createPublicKey} from 'node:crypto';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
import {S3Client,PutObjectCommand,GetObjectCommand,GetBucketVersioningCommand,GetObjectLockConfigurationCommand} from '@aws-sdk/client-s3';
import {KMSClient,GetPublicKeyCommand} from '@aws-sdk/client-kms';
import {SecretsManagerClient,PutSecretValueCommand} from '@aws-sdk/client-secrets-manager';
import {createPgDatabase} from '../src/db/postgres.ts';
import {migrate,migrationInventory} from '../src/db/migrate.ts';
import {insertUser} from '../src/domain/users.ts';
import {commitAttestation} from '../src/domain/attestations.ts';
import {finalizeProof} from '../src/domain/finalize.ts';
import {createSignatureSnapshot,buildSignatureCase} from '../src/domain/signature.ts';
import {createOrganization,setOrganizationEntitlement,addOrganizationMember,createIntegrationAccount,createServicePrincipal,issuePartnerCredential,authenticatePartner,PARTNER_SCOPES,revokeOrganizationMember} from '../src/platform/organizations.ts';
import {importPartnerOrder,addPartnerBinding} from '../src/platform/partner-proofs.ts';
import {configurePolicyDurability} from '../src/domain/policy-recovery.ts';
import {initializeManifestSigningRuntime} from '../src/integrity/kms-signing-runtime.ts';
import {AwsS3ObjectStore} from '../src/s3/aws-s3-object-store.ts';
import {sha256Hex} from '../src/hash.ts';
import {grantIsolatedRecipientRoles} from './isolated-recipient-grants.mjs';

const account='784514617543',region='us-east-1',prefix='packproof-m2r-20261022';
const host='packproof-m1-20261020-db.c8v2esku2zyt.us-east-1.rds.amazonaws.com';
const database='m2_recipient_20261022',restoreDatabase='m2_recipient_restore_20261022';
const apiRole='m2_recipient_api_20261022',workerRole='m2_recipient_worker_20261022',restoreRole='packproof_restore_recipient_20261022';
assert.equal(process.env.PACKPROOF_TEST_PURPOSE,'isolated-m2-synthetic');assert.equal(process.env.PACKPROOF_TEST_DB_HOST,host);
assert.match(process.env.CANDIDATE_SHA??'',/^[a-f0-9]{40}$/);
const mode=process.env.M2_CONTROL;assert.ok(['bootstrap','restore-bootstrap','revoke','inspect','close'].includes(mode));
const owner=JSON.parse(process.env.ISOLATED_DB_SECRET);delete process.env.ISOLATED_DB_SECRET;assert.equal(owner.username,'packproof');
process.env.PACKPROOF_DB_CA_FILE='/tmp/packproof-rds-ca.pem';
process.env.PACKPROOF_ORGANIZATIONS_ENABLED='true';process.env.PACKPROOF_CLAIM_EXPORTS_ENABLED='true';
const connect=name=>{const url=new URL(`postgresql://${host}:5432/${name}?sslmode=verify-full`);url.username=owner.username;url.password=owner.password;return createPgDatabase(url.toString());};
const env=name=>{const value=process.env[`M2_${name}`];assert.ok(value,`Missing M2_${name}`);return value;};
const bucket=name=>{const value=env(`${name}_BUCKET`);assert.ok(value.startsWith(prefix+'-'));return value;};
const key=name=>{const value=env(`${name}_KEY_ARN`);assert.match(value,/^arn:aws:kms:us-east-1:784514617543:key\/[a-f0-9-]{36}$/);return value;};
const secret=name=>{const value=env(`${name}_DATABASE_SECRET`);assert.ok(value.startsWith(`arn:aws:secretsmanager:${region}:${account}:secret:${prefix}/`));return value;};
const s3=new S3Client({region}),kms=new KMSClient({region}),secrets=new SecretsManagerClient({region}),clock={now:()=>new Date()};
const admin=connect('packproof_v2');let opened;
const receipt={schema:'packproof.isolated-recipient-control.v1',mode,source:process.env.CANDIDATE_SHA,buildId:process.env.CODEBUILD_BUILD_ID,syntheticOnly:true,productionChanged:false};
async function fresh(name,roles,restoring=false){
 assert.equal((await admin.db.query('SELECT 1 FROM pg_database WHERE datname=$1',[name])).rows.length,0,'Refusing an existing database');
 for(const role of roles)assert.equal((await admin.db.query('SELECT 1 FROM pg_roles WHERE rolname=$1',[role])).rows.length,0,'Refusing an existing role');
 const inventory=await migrationInventory();assert.equal(inventory.length,94);assert.equal(inventory.at(-1).id,'095_recipient_export_preservation');
 await admin.db.query(`CREATE DATABASE ${name}`);await admin.db.query(`REVOKE CONNECT ON DATABASE ${name} FROM PUBLIC`);
 opened=connect(name);const db=opened.db;await migrate(db);await db.query('REVOKE CREATE ON SCHEMA public FROM PUBLIC');
 for(const role of roles){
  const password=randomBytes(32).toString('hex');
  await admin.db.query(`CREATE ROLE ${role} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD '${password}'`);
  await admin.db.query(`GRANT CONNECT ON DATABASE ${name} TO ${role}`);
  await secrets.send(new PutSecretValueCommand({SecretId:secret(role===apiRole?'API':role===workerRole?'WORKER':'RESTORE'),SecretString:password}));
 }
 if(restoring){
  await db.query(`GRANT USAGE ON SCHEMA public TO ${restoreRole}`);
  await db.query(`GRANT SELECT,INSERT,UPDATE ON ALL TABLES IN SCHEMA public TO ${restoreRole}`);
  await db.query(`GRANT USAGE,SELECT,UPDATE ON ALL SEQUENCES IN SCHEMA public TO ${restoreRole}`);
  await db.query("UPDATE recovery_writer_fence SET writes_enabled=false,generation='m2-recipient-restored-20261022'");
 }else{
  receipt.privileges=await grantIsolatedRecipientRoles(db,{apiRole,workerRole,purpose:'isolated-m2-synthetic'});
  await db.query("UPDATE recovery_writer_fence SET writes_enabled=true,generation='m2-recipient-20261022'");
 }
 receipt.database=name;receipt.migrations={count:inventory.length,sha256:sha256Hex(JSON.stringify(inventory.map(({id,checksum})=>({id,checksum}))))};return db;
}
async function configuration(){
 const result=await s3.send(new GetObjectCommand({Bucket:bucket('UPLOAD'),Key:'acceptance/recipient/config/runtime.json',VersionId:env('CONFIGURATION_VERSION'),ExpectedBucketOwner:account}));
 assert.equal(result.VersionId,env('CONFIGURATION_VERSION'));assert.ok(result.ContentLength<65536);
 const bytes=Buffer.from(await result.Body.transformToByteArray());assert.equal(sha256Hex(bytes),env('CONFIGURATION_DIGEST'));
 const value=JSON.parse(bytes);assert.equal(value.source,process.env.CANDIDATE_SHA);assert.equal(value.database,database);return value;
}
try{
 if(mode==='bootstrap'){
  const upload=bucket('UPLOAD'),committed=bucket('COMMITTED'),journal=bucket('JOURNAL'),recipient=bucket('RECIPIENT');
  const keys={manifest:key('MANIFEST'),recovery:key('RECOVERY')},publicKeys={},protection=[];
  for(const Bucket of [committed,journal,recipient]){
   const versioning=await s3.send(new GetBucketVersioningCommand({Bucket,ExpectedBucketOwner:account}));assert.equal(versioning.Status,'Enabled');
   const lock=(await s3.send(new GetObjectLockConfigurationCommand({Bucket,ExpectedBucketOwner:account}))).ObjectLockConfiguration;
   assert.equal(lock?.ObjectLockEnabled,'Enabled');assert.equal(lock?.Rule?.DefaultRetention?.Mode,'COMPLIANCE');assert.ok(lock.Rule.DefaultRetention.Days>=2);protection.push({bucket:Bucket,lock});
  }
  for(const [name,KeyId] of Object.entries(keys)){
   const value=await kms.send(new GetPublicKeyCommand({KeyId}));assert.equal(value.KeyId,KeyId);assert.equal(value.KeySpec,'ECC_NIST_P256');assert.equal(value.KeyUsage,'SIGN_VERIFY');
   publicKeys[name]=createPublicKey({key:Buffer.from(value.PublicKey),type:'spki',format:'der'}).export({type:'spki',format:'pem'}).toString();
  }
  const media='/tmp/m2-recipient-synthetic.mp4';
  const generated=spawnSync('ffmpeg',['-hide_banner','-loglevel','error','-f','lavfi','-i','testsrc2=size=1280x720:rate=25','-t','0.4','-an','-c:v','libx264','-threads','1','-pix_fmt','yuv420p','-y',media],{stdio:'ignore'});assert.equal(generated.status,0);
  const bytes=await readFile(media),db=await fresh(database,[apiRole,workerRole]);
  const developer=await insertUser(db,clock),merchantOwner=await insertUser(db,clock),operator=await insertUser(db,clock);
  await db.query("INSERT INTO user_verified_contacts(user_id,email_normalized,verified_at,source) VALUES($1,'nericollin@gmail.com',$2,'COGNITO')",[developer,clock.now().toISOString()]);
  const org=await createOrganization(db,clock,developer,{kind:'MERCHANT',name:'Synthetic isolated recipient acceptance',ownerUserId:merchantOwner},'synthetic-setup');
  await setOrganizationEntitlement(db,clock,developer,org.id,{enabled:true},'synthetic-setup');
  const member=await addOrganizationMember(db,clock,merchantOwner,org.id,{userId:operator,role:'OPERATOR'},'synthetic-setup');
  const integration=await createIntegrationAccount(db,clock,merchantOwner,org.id,{provider:'stripe',externalAccountId:'acct_synthetic_recipient_20261022'},'synthetic-setup');
  const principal=await createServicePrincipal(db,clock,merchantOwner,org.id,{name:'Synthetic reference source'},'synthetic-setup');
  const credential=await issuePartnerCredential(db,clock,merchantOwner,org.id,principal.id,{scopes:[...PARTNER_SCOPES],expiresAt:new Date(Date.now()+86400000).toISOString()},'synthetic-setup');
  const service=await authenticatePartner(db,clock,`Bearer ${credential.token}`,org.id,undefined,'synthetic-setup');
  const proof=await importPartnerOrder(db,clock,service,{integrationAccountId:integration.id,externalId:'synthetic-order',operatorMembershipId:member.id,transaction:{itemTitle:'Synthetic recipient fixture',quantity:1}});
  await addPartnerBinding(db,clock,service,proof.proofId,{integrationAccountId:integration.id,resourceType:'PAYMENT',externalId:'ch_synthetic_recipient'});
  const evidenceId='evd_m2_recipient_20261022',store=new AwsS3ObjectStore(upload,{region,committedBucket:committed}),staging=`evidence/${proof.proofId}/${evidenceId}/object`;
  await store.put(staging,bytes,'video/mp4');const object=await store.commitUpload(staging,{sha256:sha256Hex(bytes),byteSize:bytes.length,contentType:'video/mp4'});assert.ok(object?.versionId);
  const at=clock.now().toISOString();
  await db.query("INSERT INTO evidence(id,proof_id,submitted_by,object_key,object_version_id,staging_version_id,content_type,byte_size,sha256,created_at,committed_at,validation_status,evidence_type,capture_origin) VALUES($1,$2,$3,$4,$5,$6,'video/mp4',$7,$8,$9,$9,'COMMITTED','FULFILLMENT_CAPTURE','LEGACY_UNKNOWN')",[evidenceId,proof.proofId,operator,object.key,object.versionId,object.stagingVersionId,object.byteSize,object.sha256,at]);
  await commitAttestation(db,clock,operator,proof.proofId,{statement:'PACKED_DESCRIBED_ITEM',relatedEvidenceId:evidenceId});
  const signing=await initializeManifestSigningRuntime(clock,{PACKPROOF_MANIFEST_SIGNING_MODE:'kms',PACKPROOF_MANIFEST_SIGNING_REQUIRED:'true',PACKPROOF_MANIFEST_KMS_KEY_ARN:keys.manifest,PACKPROOF_MANIFEST_SIGNING_KEY_ID:keys.manifest,PACKPROOF_MANIFEST_SIGNING_ALGORITHM:'ECDSA_SHA_256'});
  const finalized=await finalizeProof(db,clock,operator,proof.proofId,signing.signer);
  const snapshot=await createSignatureSnapshot(db,clock,operator,proof.proofId);
  const packet=await buildSignatureCase(db,clock,operator,proof.proofId,{snapshotId:snapshot.snapshotId,template:'WRONG_ITEM',scope:{fields:['status','order','shipping','evidence','statements'],evidenceIds:[evidenceId]}});
  await configurePolicyDurability(db,{required:true});
  const config={schema:'packproof.isolated-recipient-configuration.v1',source:process.env.CANDIDATE_SHA,database,proofId:proof.proofId,operator,merchantOwner,merchantId:org.id,memberId:String(member.id),integrationAccountId:integration.id,evidenceId,caseId:packet.caseId,keys,publicKeys,writerGeneration:'m2-recipient-20261022',manifestSha256:finalized.manifest.sha256,retainUntil:new Date(Date.now()+86400000).toISOString(),providerDeadline:new Date(Date.now()+3*3600000).toISOString(),original:{bucket:committed,key:object.key,versionId:object.versionId,sha256:object.sha256,byteSize:object.byteSize},syntheticOnly:true,fixtureMethod:'OWNER_SEEDED_LEGACY_UNKNOWN_DOMAIN_FINALIZATION_NO_DEVICE_HTTP_OR_HUMAN_REVIEW_ASSERTION'};
  const body=Buffer.from(JSON.stringify(config)),Key='acceptance/recipient/config/runtime.json';
  const saved=await s3.send(new PutObjectCommand({Bucket:upload,Key,Body:body,ContentType:'application/json',ChecksumAlgorithm:'SHA256',ChecksumSHA256:Buffer.from(sha256Hex(body),'hex').toString('base64'),ExpectedBucketOwner:account}));assert.ok(saved.VersionId);
  receipt.configuration={bucket:upload,key:Key,versionId:saved.VersionId,sha256:sha256Hex(body)};receipt.proofId=proof.proofId;receipt.manifestSha256=config.manifestSha256;receipt.storageProtection=protection;receipt.publicKeys=publicKeys;receipt.fixtureMethod=config.fixtureMethod;
 }else if(mode==='restore-bootstrap'){
  const source=connect(database);
  try{
   assert.equal((await source.db.query('SELECT writes_enabled FROM recovery_writer_fence WHERE singleton=1')).rows[0].writes_enabled,false);
   for(const role of [apiRole,workerRole])assert.equal((await source.db.query('SELECT rolcanlogin FROM pg_roles WHERE rolname=$1',[role])).rows[0].rolcanlogin,false);
  }finally{await source.close();}
  await fresh(restoreDatabase,[restoreRole],true);
 }else{
  opened=connect(database);const db=opened.db;
  if(mode==='revoke'){const config=await configuration();await revokeOrganizationMember(db,clock,config.merchantOwner,config.merchantId,config.memberId,'synthetic-recipient-revocation');receipt.revokedOperator=config.operator;}
  if(mode==='close'){
   await db.query('UPDATE recovery_writer_fence SET writes_enabled=false WHERE singleton=1');
   for(const role of [apiRole,workerRole,restoreRole])if((await admin.db.query('SELECT 1 FROM pg_roles WHERE rolname=$1',[role])).rows.length)await admin.db.query(`ALTER ROLE ${role} NOLOGIN`);
   await admin.db.query('SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname=ANY($1::text[]) AND usename=ANY($2::text[]) AND pid<>pg_backend_pid()',[[database,restoreDatabase],[apiRole,workerRole,restoreRole]]);
  }
  receipt.database=database;receipt.writerFence=(await db.query('SELECT * FROM recovery_writer_fence')).rows;
  receipt.roles=(await db.query('SELECT rolname,rolcanlogin,rolsuper,rolcreatedb,rolcreaterole,rolbypassrls FROM pg_roles WHERE rolname=ANY($1::text[]) ORDER BY rolname',[[apiRole,workerRole,restoreRole]])).rows;
  for(const [name,sql] of Object.entries({coreDelivery:'SELECT state,COUNT(*) AS count FROM recovery_delivery GROUP BY state',policyDelivery:'SELECT state,COUNT(*) AS count FROM policy_recovery_delivery GROUP BY state',coreHead:"SELECT e.sha256 FROM recovery_events e JOIN recovery_delivery d USING(operation_id) WHERE d.state='DURABLE' ORDER BY e.sequence DESC LIMIT 1",policyHead:"SELECT event_sha256 FROM policy_recovery_delivery WHERE state='DURABLE' ORDER BY sequence DESC LIMIT 1"}))receipt[name]=(await db.query(sql)).rows;
 }
 receipt.status='PASSED';
}catch(error){receipt.status='FAILED';receipt.error={name:error.name,code:error.code??null,assertion:error.name==='AssertionError'?String(error.message).slice(0,300):undefined};process.exitCode=1;}
finally{await opened?.close();await admin.close();await mkdir('runtime-artifacts',{recursive:true});await writeFile('runtime-artifacts/recipient-control.json',JSON.stringify(receipt,null,2)+'\n');console.log(JSON.stringify(receipt));}
