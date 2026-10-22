// One-shot ECS workload. Synthetic byte/storage/worker acceptance, not a device pilot.
import assert from 'node:assert/strict';
import {createHash,createPublicKey} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
import {S3Client,PutObjectCommand,GetObjectCommand,DeleteObjectCommand,GetObjectRetentionCommand,PutObjectRetentionCommand} from '@aws-sdk/client-s3';
import {KMSClient,GetPublicKeyCommand,SignCommand} from '@aws-sdk/client-kms';
import {SecretsManagerClient,GetSecretValueCommand} from '@aws-sdk/client-secrets-manager';
import {createPgDatabase} from '../dist/db/postgres.js';
import {initializeManifestSigningRuntime} from '../dist/integrity/kms-signing-runtime.js';
import {createEnvelopeTrust,createTrustedEnvelopeSigner} from '../dist/integrity/envelope-trust.js';
import {createEnvelopeS3Store,envelopeS3Transport} from '../dist/integrity/envelope-s3-store.js';
import {enqueueEnvelopeFromRecovery,processEnvelopeJob,envelopeJobStatus} from '../dist/integrity/envelope-jobs.js';
import {streamEnvelopePackage} from '../dist/integrity/envelope-package.js';
import {processRecoveryOutbox} from '../dist/domain/recovery-journal.js';
import {processPolicyRecoveryOutbox} from '../dist/domain/policy-recovery.js';
import {restoreFreshRecoveryDatabase} from '../dist/domain/recovery-restore.js';
import {AwsS3ObjectStore} from '../dist/s3/aws-s3-object-store.js';

const account='784514617543',region='us-east-1',purpose='isolated-m2-synthetic',prefix='packproof-m2-20261022-envelope';
assert.equal(process.env.PACKPROOF_TEST_PURPOSE,purpose);assert.ok(process.env.ECS_CONTAINER_METADATA_URI_V4);
assert.equal(process.env.PACKPROOF_DB_HOST,'packproof-m1-20261020-db.c8v2esku2zyt.us-east-1.rds.amazonaws.com');
const mode=process.env.M2_MODE;assert.ok(['probe','work','restore'].includes(mode));
const kind=process.env.PACKPROOF_PROCESS_ROLE;assert.equal(kind,mode==='restore'?'restore':'worker');
const expectedDatabase=kind==='worker'?'m2_integrity_20261022':'m2_integrity_restore_20261022',expectedRole=kind==='worker'?'m2_envelope_worker':'packproof_restore_m2_20261022';
assert.equal(process.env.PACKPROOF_DB_NAME,expectedDatabase);assert.equal(process.env.PACKPROOF_DB_USER,expectedRole);
const env=name=>{const value=process.env[`M2_${name}`];assert.ok(value,`Missing M2_${name}`);return value;};
const upload=env('UPLOAD_BUCKET'),committed=env('COMMITTED_BUCKET'),journal=env('JOURNAL_BUCKET'),artifacts=env('ARTIFACT_BUCKET');
for(const bucket of [upload,committed,journal,artifacts])assert.ok(bucket.startsWith(prefix+'-'));
const hash=bytes=>createHash('sha256').update(bytes).digest('hex'),clock={now:()=>new Date()};
const original=new S3Client({region}),credentials=await original.config.credentials();
// Probe clients deliberately retain the original task credential session.
const s3=new S3Client({region,credentials,maxAttempts:2}),kms=new KMSClient({region,credentials,maxAttempts:2});
const metadata=await fetch(process.env.ECS_CONTAINER_METADATA_URI_V4+'/task',{signal:AbortSignal.timeout(5000)}).then(r=>r.json());
assert.ok(metadata.Family.startsWith(prefix+'-'));
const run=metadata.TaskARN.split('/').at(-1),source=process.env.PACKPROOF_RELEASE_SHA;
const report={schema:'packproof.isolated-envelope-acceptance.v1',mode,run,taskArn:metadata.TaskARN,family:metadata.Family,revision:metadata.Revision,source,expectedImage:process.env.PACKPROOF_RELEASE_IMAGE,syntheticOnly:true,productionChanged:false,checks:[],kmsCalls:[]};
const check=name=>report.checks.push(name);
const options=()=>({abortSignal:AbortSignal.timeout(30000)});
async function readJson(key,versionId,expectedSha){
 assert.ok(versionId&&versionId!=='UNINITIALIZED');assert.match(expectedSha??'',/^[a-f0-9]{64}$/);
 const result=await s3.send(new GetObjectCommand({Bucket:upload,Key:key,VersionId:versionId,ExpectedBucketOwner:account}),options());
 assert.equal(result.VersionId,versionId);assert.ok(result.ContentLength<=2*1024*1024);
 const bytes=Buffer.from(await result.Body.transformToByteArray());assert.equal(hash(bytes),expectedSha);return JSON.parse(bytes.toString());
}
async function putReport(key,value){
 const body=Buffer.isBuffer(value)?value:Buffer.from(JSON.stringify(value));
 const saved=await s3.send(new PutObjectCommand({Bucket:upload,Key:key,Body:body,ContentType:Buffer.isBuffer(value)?'application/octet-stream':'application/json',ChecksumAlgorithm:'SHA256',ChecksumSHA256:Buffer.from(hash(body),'hex').toString('base64'),ExpectedBucketOwner:account}),options());
 assert.ok(saved.VersionId);return {bucket:upload,key,versionId:saved.VersionId,sha256:hash(body),byteSize:body.length};
}
const denied=async fn=>{try{await fn();return false;}catch(error){if(['AccessDenied','AccessDeniedException'].includes(error.name))return true;throw error;}};
const signTransport={getPublicKey:input=>kms.send(new GetPublicKeyCommand(input),options()),sign:async input=>{
 const result=await kms.send(new SignCommand(input),options());report.kmsCalls.push({keyArn:input.KeyId,messageType:input.MessageType,digest:Buffer.from(input.Message).toString('hex'),requestId:result.$metadata?.requestId});return result;
}};
let opened;
try{
 const config=await readJson('acceptance/m2/config/runtime.json',env('CONFIGURATION_VERSION'),env('CONFIGURATION_DIGEST'));
 assert.equal(config.schema,'packproof.isolated-envelope-configuration.v1');assert.equal(config.source,source);assert.equal(config.database,'m2_integrity_20261022');assert.equal(config.syntheticOnly,true);
 assert.equal(config.keys.manifest,env('MANIFEST_KEY_ARN'));assert.equal(config.keys.recovery,env('RECOVERY_KEY_ARN'));assert.equal(config.keys.envelope,env('ENVELOPE_KEY_ARN'));
 assert.equal(config.issuer,'https://packproof-m2.test');assert.equal(config.original.bucket,committed);assert.ok(Date.parse(config.retainUntil)>Date.now());
 const trust=createEnvelopeTrust({issuer:config.issuer,clock,readRegistry:()=>Buffer.from(JSON.stringify(config.signedRegistry)),readAuthorityPins:()=>({[config.keys.manifest]:config.publicKeys.manifest})});
 const store=createEnvelopeS3Store({artifactBucket:artifacts,evidenceBuckets:[committed],expectedBucketOwner:account,clock,transport:envelopeS3Transport(region)});
 const publicKey=async id=>id===config.keys.manifest?config.publicKeys.manifest:id===config.keys.recovery?config.publicKeys.recovery:null;
 const mediaStore=new AwsS3ObjectStore(upload,{region,committedBucket:committed}),journalStore=new AwsS3ObjectStore(journal,{region,immutableRecoveryJournal:true});
 const sourceStore={get:(key,ref)=>key.startsWith('recovery/')?journalStore.get(key,ref):mediaStore.get(key,ref),head:(key,ref)=>key.startsWith('recovery/')?journalStore.head(key,ref):mediaStore.head(key,ref),getStream:(key,ref)=>key.startsWith('recovery/')?journalStore.getStream(key,ref):mediaStore.getStream(key,ref)};
 if(mode==='probe'){
  const originalReceipt=await store.verify({storage:{bucket:committed,key:config.original.key,versionId:config.original.versionId},sha256:config.original.sha256,byteSize:config.original.byteSize},config.retainUntil);
  assert.equal(originalReceipt.mode,'COMPLIANCE');report.originalProtection=originalReceipt;check('original_exact_version_bytes_and_compliance_retention');
  const probeKey=`recovery/probes/${run}.json`,bytes=Buffer.from('SYNTHETIC M2 WORKER PROTECTION PROBE');
  const write=key=>s3.send(new PutObjectCommand({Bucket:journal,Key:key,Body:bytes,IfNoneMatch:'*',ChecksumAlgorithm:'SHA256',ChecksumSHA256:Buffer.from(hash(bytes),'hex').toString('base64'),ExpectedBucketOwner:account}),options());
  const saved=await write(probeKey);assert.ok(saved.VersionId);check('journal_conditional_creation');
  try{await write(probeKey);assert.fail('Conditional duplicate was accepted');}catch(error){assert.equal(error.$metadata?.httpStatusCode,412);}check('journal_duplicate_refused');
  const retention=await s3.send(new GetObjectRetentionCommand({Bucket:journal,Key:probeKey,VersionId:saved.VersionId,ExpectedBucketOwner:account}),options());assert.equal(retention.Retention.Mode,'COMPLIANCE');check('journal_actual_compliance_retention');
  for(const KeyId of [config.keys.recovery,config.keys.envelope])await signTransport.sign({KeyId,Message:Buffer.alloc(32),MessageType:'DIGEST',SigningAlgorithm:'ECDSA_SHA_256'});
  check('worker_keys_sign_digest');
  assert.ok(await denied(()=>signTransport.sign({KeyId:config.keys.manifest,Message:Buffer.alloc(32),MessageType:'DIGEST',SigningAlgorithm:'ECDSA_SHA_256'})));check('root_signing_denied');
  assert.ok(await denied(()=>kms.send(new SignCommand({KeyId:config.keys.envelope,Message:Buffer.alloc(32),MessageType:'RAW',SigningAlgorithm:'ECDSA_SHA_256'}),options())));check('raw_envelope_signing_denied');
  assert.ok(await denied(()=>s3.send(new DeleteObjectCommand({Bucket:journal,Key:probeKey,VersionId:saved.VersionId,ExpectedBucketOwner:account}),options())));check('protected_version_deletion_denied');
  // A past deadline is rejected as malformed before permission evaluation. Use
  // a valid future deadline shorter than the actual two-day retained version.
  assert.ok(await denied(()=>s3.send(new PutObjectRetentionCommand({Bucket:journal,Key:probeKey,VersionId:saved.VersionId,Retention:{Mode:'COMPLIANCE',RetainUntilDate:new Date(Date.now()+3600000)},ExpectedBucketOwner:account}),options())));check('retention_shortening_denied');
  assert.ok(await denied(()=>s3.send(new PutObjectCommand({Bucket:committed,Key:`forbidden-worker/${run}`,Body:bytes,ChecksumAlgorithm:'SHA256'}),options())));check('original_writes_denied');
  const secrets=new SecretsManagerClient({region,credentials,maxAttempts:1});
  assert.ok(await denied(()=>secrets.send(new GetSecretValueCommand({SecretId:env('DATABASE_SECRET_ARN')}),options())));check('direct_secret_read_denied');
  report.initialPassed=true;await putReport(`acceptance/m2/worker/${run}-ready.json`,report);console.log(JSON.stringify({event:'m2_probe_ready',...report}));
  let marker;
  for(let n=0;n<200;n++){
   try{const value=await s3.send(new GetObjectCommand({Bucket:upload,Key:'acceptance/m2/config/fence.json',ExpectedBucketOwner:account}),options());marker=JSON.parse(await value.Body.transformToString());if(marker.source===source&&marker.probeTaskArn===metadata.TaskARN)break;}catch(error){if(!['NoSuchKey','AccessDenied'].includes(error.name))throw error;}
   await delay(3000);
  }
  assert.equal(marker?.probeTaskArn,metadata.TaskARN);assert.equal(marker?.source,source);
  let fenced=false;
  for(let n=0;n<50;n++){
   const storageDenied=await denied(()=>write(probeKey+'-fenced-'+n));
   const signingDenied=await denied(()=>signTransport.sign({KeyId:config.keys.envelope,Message:Buffer.alloc(32),MessageType:'DIGEST',SigningAlgorithm:'ECDSA_SHA_256'}));
   if(storageDenied&&signingDenied){fenced=true;break;}await delay(3000);
  }
  assert.ok(fenced,'Existing task credentials were not fenced');check('external_fence_denies_cached_credentials');
 }else{
  const protection=await readJson('acceptance/m2/config/protection.json',env('PROTECTION_VERSION'),env('PROTECTION_DIGEST'));
  assert.equal(protection.schema,'packproof.isolated-envelope-protection.v1');assert.equal(protection.source,source);assert.equal(protection.image,process.env.PACKPROOF_RELEASE_IMAGE);assert.ok(Date.parse(protection.expiresAt)>Date.now());assert.equal(protection.status,'PASSED');
  assert.equal(protection.workerRoleArn,`arn:aws:iam::${account}:role/${prefix}-worker`);assert.ok(protection.probeTaskArn&&protection.reviewedBy);
  for(const name of ['exactVersionRetentionVerified','workerRootSigningDenied','workerOriginalWritesDenied','workerDeletionDenied','workerSecretReadDenied','existingCredentialFenceVerified'])assert.equal(protection[name],true);
  const dbUrl=new URL(`postgresql://${process.env.PACKPROOF_DB_HOST}:5432/${expectedDatabase}?sslmode=verify-full`);dbUrl.username=expectedRole;dbUrl.password=process.env.PACKPROOF_DB_PASSWORD;
  opened=createPgDatabase(dbUrl.toString());const db=opened.db;
  const identity=(await db.query("SELECT current_user AS login,current_database() AS database,r.rolsuper,r.rolbypassrls,has_schema_privilege(current_user,'public','CREATE') AS can_create FROM pg_roles r WHERE r.rolname=current_user")).rows[0];
  assert.equal(identity.login,expectedRole);assert.equal(identity.database,expectedDatabase);assert.equal(identity.rolsuper,false);assert.equal(identity.rolbypassrls,false);assert.equal(identity.can_create,false);report.databaseIdentity=identity;check('separate_non_owner_database_login');
  if(mode==='work'){
   assert.equal((await db.query("SELECT has_column_privilege(current_user,'recovery_writer_fence','generation','UPDATE') AS allowed")).rows[0].allowed,false);check('database_writer_fence_control_denied');
   const signing=await initializeManifestSigningRuntime(clock,{PACKPROOF_MANIFEST_SIGNING_MODE:'kms',PACKPROOF_MANIFEST_SIGNING_REQUIRED:'true',PACKPROOF_MANIFEST_KMS_KEY_ARN:config.keys.recovery,PACKPROOF_MANIFEST_SIGNING_KEY_ID:config.keys.recovery,PACKPROOF_MANIFEST_SIGNING_ALGORITHM:'ECDSA_SHA_256'},signTransport);
   assert.equal(createPublicKey(signing.trustList.keys[0].publicKeyPem).export({type:'spki',format:'der'}).toString('hex'),createPublicKey(config.publicKeys.recovery).export({type:'spki',format:'der'}).toString('hex'));
   const publisher={store:journalStore,signer:signing.signer,trustedPublicKey:publicKey,writerGeneration:config.writerGeneration,protectedStoreVerified:true};
   async function drain(){
    for(const process of [processPolicyRecoveryOutbox,processRecoveryOutbox]){let ended=false;for(let n=0;n<1000;n++){const value=await process(db,clock,publisher);if(!value.processed){ended=true;break;}assert.equal(value.state,'DURABLE');}assert.ok(ended,'Journal drain exceeded its bound');}
   }
   await drain();check('frozen_source_and_policies_durable');
   const requested=await enqueueEnvelopeFromRecovery(db,clock,{sourceOperationId:config.sourceOperationId,evidenceBucket:committed,artifactBucket:artifacts,issuer:config.issuer,keyId:config.keys.envelope,retainUntil:config.retainUntil,writerGeneration:config.writerGeneration});
   assert.equal(requested.replayed,false,'Use a fresh reviewed fixture for repeat acceptance');report.operationId=requested.operationId;
   const sign=await createTrustedEnvelopeSigner({keyArn:config.keys.envelope,keyId:config.keys.envelope,transport:signTransport,trust,clock});
   let lost=false;
   const faultStore={...store,preserve:async(...args)=>{const result=await store.preserve(...args);if(!lost&&args[1].includes('/envelopes/')){lost=true;throw Error('Injected response loss after real S3 preservation');}return result;}};
   const worker={writerGeneration:config.writerGeneration,store:faultStore,sourceJournal:publisher,trustedPublicKey:trust.trustedPublicKey,sign};
   assert.deepEqual(await processEnvelopeJob(db,clock,worker),{processed:0});check('request_journal_precedes_signing');
   await drain();const before=report.kmsCalls.filter(c=>c.keyArn===config.keys.envelope).length;
   assert.equal((await processEnvelopeJob(db,clock,worker)).state,'PENDING');assert.equal(lost,true);
   assert.equal((await db.query('SELECT COUNT(*)::int AS count FROM integrity_envelope_results')).rows[0].count,0);check('lost_storage_response_has_no_false_database_receipt');
   await delay(2200);
   assert.equal((await processEnvelopeJob(db,clock,worker)).state,'SIGNED_PENDING_DURABILITY');
   assert.deepEqual(await envelopeJobStatus(db,requested.operationId),{state:'SIGNED_PENDING_DURABILITY'});check('stored_signature_waits_for_result_journal');
   assert.equal(report.kmsCalls.filter(c=>c.keyArn===config.keys.envelope).length-before,1);check('lost_response_reuses_first_kms_signature');
   await drain();assert.deepEqual(await envelopeJobStatus(db,requested.operationId),{state:'READY'});check('ready_only_after_protected_result_publication');
   const result=(await db.query('SELECT bundle_json,bundle_sha256,receipt_json FROM integrity_envelope_results WHERE operation_id=$1',[requested.operationId])).rows[0],bundle=JSON.parse(result.bundle_json);
   const originalManifest=(await db.query('SELECT canonical_json,sha256 FROM final_manifests WHERE proof_id=$1',[config.proofId])).rows[0];assert.equal(originalManifest.sha256,config.frozenManifestSha256);assert.equal(hash(originalManifest.canonical_json),config.frozenManifestSha256);check('original_manifest_unchanged');
   const stream=await streamEnvelopePackage({jws:bundle.jws,coverage:bundle.coverage,trustedKeyId:config.keys.envelope,trustedPublicKeyPem:config.publicKeys.envelope,assertCurrentAccess:async()=>{},openExactObject:async object=>{
    const value=await s3.send(new GetObjectCommand({Bucket:object.bucket,Key:object.key,VersionId:object.versionId,ExpectedBucketOwner:account}),options());return {versionId:value.VersionId,body:value.Body};
   }});
   const parts=[];let count=0;for await(const chunk of stream){count+=chunk.length;assert.ok(count<32*1024*1024);parts.push(Buffer.from(chunk));}
   report.package=await putReport(`acceptance/m2/worker/${run}/evidence.pkpr`,Buffer.concat(parts));
   report.verifierTrust=await putReport(`acceptance/m2/worker/${run}/envelope-trust.json`,trust.snapshot());
   const core=(await db.query("SELECT e.operation_id,e.sequence,e.sha256,d.receipt_json FROM recovery_events e JOIN recovery_delivery d USING(operation_id) WHERE d.state='DURABLE' ORDER BY e.sequence")).rows;
   const policy=(await db.query("SELECT e.sequence,d.event_sha256 AS sha256,d.receipt_json FROM policy_recovery_events e JOIN policy_recovery_delivery d USING(sequence) WHERE d.state='DURABLE' ORDER BY e.sequence")).rows;
   assert.ok(core.length&&policy.length);assert.equal((await db.query("SELECT COUNT(*)::int AS count FROM recovery_delivery WHERE state<>'DURABLE'")).rows[0].count,0);assert.equal((await db.query("SELECT COUNT(*)::int AS count FROM policy_recovery_delivery WHERE state<>'DURABLE'")).rows[0].count,0);
   const handoff={schema:'packproof.isolated-envelope-replay-input.v1',source,proofId:config.proofId,operationId:requested.operationId,manifestSha256:config.frozenManifestSha256,bundleSha256:result.bundle_sha256,core,policy,coreHead:core.at(-1).sha256,policyHead:policy.at(-1).sha256};
   report.replayInput=await putReport('acceptance/m2/worker/replay-input.json',handoff);report.heads={core:handoff.coreHead,policy:handoff.policyHead};report.bundleSha256=handoff.bundleSha256;report.proofId=config.proofId;report.manifestSha256=config.frozenManifestSha256;check('bounded_exact_version_package_and_replay_handoff');
  }else{
   const handoff=await readJson('acceptance/m2/worker/replay-input.json',env('HANDOFF_VERSION'),env('HANDOFF_DIGEST'));
   const closed=await readJson('acceptance/m2/config/source-closed.json',env('SOURCE_CLOSED_VERSION'),env('SOURCE_CLOSED_DIGEST'));
   assert.equal(handoff.source,source);assert.equal(handoff.proofId,config.proofId);assert.equal(closed.source,source);assert.equal(closed.status,'PASSED');assert.equal(closed.writerFence.writes_enabled,false);assert.equal(closed.workerLoginEnabled,false);assert.equal(closed.iamWriterFence,'CLOSED');assert.equal(closed.coreHead,handoff.coreHead);assert.equal(closed.policyHead,handoff.policyHead);assert.ok(closed.externalFenceReference);
   async function load(rows){const values=[];for(const row of rows){const receipt=row.receipt_json;assert.ok(receipt.objectVersionId);const value=await journalStore.get(receipt.objectKey,{versionId:receipt.objectVersionId});assert.ok(value);assert.equal(hash(value.body),receipt.envelopeSha256);
    const locked=await s3.send(new GetObjectRetentionCommand({Bucket:journal,Key:receipt.objectKey,VersionId:receipt.objectVersionId,ExpectedBucketOwner:account}),options());assert.equal(locked.Retention?.Mode,'COMPLIANCE');assert.ok(locked.Retention.RetainUntilDate.getTime()>=Date.parse(config.retainUntil));
    values.push(value.body);}return values;}
   const core=await load(handoff.core),policy=await load(handoff.policy);
   const restored=await restoreFreshRecoveryDatabase(db,{expectedDatabase,restoreRole:expectedRole,isolatedTargetReference:metadata.TaskARN,oldWriterFenceReference:closed.externalFenceReference,targetWriterGeneration:'m2-restored-20261022',core:{envelopes:core,expectedWatermark:core.at(-1)},policy:{envelopes:policy,expectedWatermark:policy.at(-1)},trustedPublicKey:publicKey,sourceStore,envelopes:{store,trustedPublicKey:trust.trustedPublicKey}});
   assert.equal(restored.trafficMayOpen,false);assert.equal(restored.writersEnabled,false);assert.equal(restored.counts.integrity_envelope_results,1);check('fresh_reconstruction_verifies_source_envelope_and_protection');
   const accepted=(await db.query('SELECT bundle_sha256 FROM integrity_envelope_results WHERE operation_id=$1',[handoff.operationId])).rows[0];assert.equal(accepted.bundle_sha256,handoff.bundleSha256);
   assert.equal((await db.query('SELECT sha256 FROM final_manifests WHERE proof_id=$1',[config.proofId])).rows[0].sha256,config.frozenManifestSha256);assert.equal((await db.query('SELECT writes_enabled FROM recovery_writer_fence')).rows[0].writes_enabled,false);check('exact_result_restored_without_signing_or_opening_writers');
   report.restore=restored;report.bundleSha256=accepted.bundle_sha256;assert.equal(report.kmsCalls.length,0);report.proofId=config.proofId;
  }
 }
 report.status='PASSED';
}catch(error){report.status='FAILED';report.failure={name:error.name,code:error.code??null,status:error.$metadata?.httpStatusCode??null,message:error.name==='AssertionError'?String(error.message).slice(0,300):undefined};process.exitCode=1;}
finally{await opened?.close();const saved=await putReport(`acceptance/m2/${kind}/${run}.json`,report);console.log(JSON.stringify({event:'m2_acceptance_complete',...report,reportObject:saved}));}
