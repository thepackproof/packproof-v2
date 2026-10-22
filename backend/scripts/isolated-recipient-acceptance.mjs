// One-shot actual-role RDS/S3 acceptance. Synthetic domain workflow only.
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
import {defaultProvider} from '@aws-sdk/credential-provider-node';
import {S3Client,PutObjectCommand,GetObjectCommand,HeadObjectCommand,GetObjectRetentionCommand,DeleteObjectCommand} from '@aws-sdk/client-s3';
import {KMSClient,GetPublicKeyCommand,SignCommand} from '@aws-sdk/client-kms';
import {createPgDatabase} from '../dist/db/postgres.js';
import {initializeManifestSigningRuntime} from '../dist/integrity/kms-signing-runtime.js';
import {AwsS3ObjectStore} from '../dist/s3/aws-s3-object-store.js';
import {createRecipientS3Store} from '../dist/export/recipient-s3-store.js';
import {RECIPIENT_PROTECTION_PROFILE} from '../dist/export/recipient-preservation.js';
import {processRecoveryOutbox} from '../dist/domain/recovery-journal.js';
import {processPolicyRecoveryOutbox} from '../dist/domain/policy-recovery.js';
import {createClaimCase,getClaimCase,reviseClaimCase} from '../dist/domain/claim-cases.js';
import {queueRecipientExport,processRecipientExport,getRecipientExport,approveRecipientExport,downloadRecipientExport} from '../dist/domain/recipient-exports.js';
import {restoreFreshRecoveryDatabase} from '../dist/domain/recovery-restore.js';
import {canonicalize} from '../dist/canonical.js';

const account='784514617543',region='us-east-1',prefix='packproof-m2r-20261022',host='packproof-m1-20261020-db.c8v2esku2zyt.us-east-1.rds.amazonaws.com';
const env=name=>{const value=process.env[`M2_${name}`];assert.ok(value,`Missing M2_${name}`);return value;};
assert.equal(process.env.PACKPROOF_TEST_PURPOSE,'isolated-m2-synthetic');assert.ok(process.env.ECS_CONTAINER_METADATA_URI_V4);
assert.equal(process.env.PACKPROOF_DB_HOST,host);assert.equal(process.env.AWS_ACCESS_KEY_ID,undefined);
const kind=process.env.PACKPROOF_PROCESS_ROLE,mode=env('MODE');
assert.ok(({api:['request','queue','approve','download'],worker:['seed','drain','render','handoff'],restore:['restore']})[kind]?.includes(mode));
const database=kind==='restore'?'m2_recipient_restore_20261022':'m2_recipient_20261022',role=kind==='restore'?'packproof_restore_recipient_20261022':`m2_recipient_${kind}_20261022`;
assert.equal(process.env.PACKPROOF_DB_NAME,database);assert.equal(process.env.PACKPROOF_DB_USER,role);
const upload=env('UPLOAD_BUCKET'),committed=env('COMMITTED_BUCKET'),journal=env('JOURNAL_BUCKET'),recipient=env('RECIPIENT_BUCKET');
for(const bucket of [upload,committed,journal,recipient])assert.ok(bucket.startsWith(prefix+'-'));
const hash=bytes=>createHash('sha256').update(bytes).digest('hex'),clock={now:()=>new Date()},credentials=await defaultProvider()();
const s3=new S3Client({region,credentials,maxAttempts:2}),kms=new KMSClient({region,credentials,maxAttempts:2}),options=()=>({abortSignal:AbortSignal.timeout(30000)});
const metadata=await fetch(process.env.ECS_CONTAINER_METADATA_URI_V4+'/task',{signal:AbortSignal.timeout(5000)}).then(r=>r.json());assert.equal(metadata.Family,`${prefix}-${kind}`);
const run=metadata.TaskARN.split('/').at(-1),source=process.env.PACKPROOF_RELEASE_SHA;
const report={schema:'packproof.isolated-recipient-acceptance.v1',kind,mode,source,image:process.env.PACKPROOF_RELEASE_IMAGE,taskArn:metadata.TaskARN,taskRevision:metadata.Revision,syntheticOnly:true,productionChanged:false,deviceAcceptance:false,humanReviewAcceptance:false,httpAcceptance:false,providerSubmission:false,checks:[],kmsCalls:[],recipientWrites:[]};
const replayTables=['claim_cases','claim_case_revisions','recipient_export_jobs','recipient_export_preservations','recipient_export_approvals','signature_cases','signature_snapshots','final_manifests','evidence'];
const check=name=>report.checks.push(name);
async function readJson(key,versionId,digest){
 assert.ok(versionId&&versionId!=='UNINITIALIZED');assert.match(digest??'',/^[a-f0-9]{64}$/);
 const value=await s3.send(new GetObjectCommand({Bucket:upload,Key:key,VersionId:versionId,ExpectedBucketOwner:account}),options());assert.equal(value.VersionId,versionId);assert.ok(value.ContentLength<4*1024*1024);
 const bytes=Buffer.from(await value.Body.transformToByteArray());assert.equal(hash(bytes),digest);return JSON.parse(bytes);
}
async function save(key,value){
 const body=Buffer.from(JSON.stringify(value));const result=await s3.send(new PutObjectCommand({Bucket:upload,Key:key,Body:body,ContentType:'application/json',ChecksumAlgorithm:'SHA256',ChecksumSHA256:Buffer.from(hash(body),'hex').toString('base64'),ExpectedBucketOwner:account}),options());assert.ok(result.VersionId);
 return {bucket:upload,key,versionId:result.VersionId,sha256:hash(body),byteSize:body.length};
}
const denied=async fn=>{try{await fn();return false;}catch(e){if(['AccessDenied','AccessDeniedException'].includes(e.name))return true;throw e;}};
const failureCode=async(fn,code)=>{await assert.rejects(fn,error=>error.code===code);};
const transport={head:i=>s3.send(new HeadObjectCommand(i),options()),get:i=>s3.send(new GetObjectCommand(i),options()),retention:i=>s3.send(new GetObjectRetentionCommand(i),options()),put:async i=>{const result=await s3.send(new PutObjectCommand(i),options());report.recipientWrites.push({key:i.Key,versionId:result.VersionId,sha256:hash(i.Body)});return result;}};
const signingTransport={getPublicKey:i=>kms.send(new GetPublicKeyCommand(i),options()),sign:async i=>{const result=await kms.send(new SignCommand(i),options());report.kmsCalls.push({keyArn:i.KeyId,messageType:i.MessageType,requestId:result.$metadata?.requestId});return result;}};
let opened;
try{
 const config=await readJson('acceptance/recipient/config/runtime.json',env('CONFIGURATION_VERSION'),env('CONFIGURATION_DIGEST'));
 assert.equal(config.schema,'packproof.isolated-recipient-configuration.v1');assert.equal(config.source,source);assert.equal(config.database,'m2_recipient_20261022');assert.equal(config.syntheticOnly,true);
 assert.equal(config.keys.manifest,env('MANIFEST_KEY_ARN'));assert.equal(config.keys.recovery,env('RECOVERY_KEY_ARN'));assert.equal(config.original.bucket,committed);
 const policy={profile:RECIPIENT_PROTECTION_PROFILE,bucket:recipient,retainUntil:config.retainUntil};
 const recipientStore=createRecipientS3Store({bucket:recipient,expectedBucketOwner:account,clock,transport});
 const protection={policy,writerGeneration:config.writerGeneration,reader:recipientStore,...(kind==='worker'?{writer:recipientStore}:{})};
 const media=new AwsS3ObjectStore(upload,{region,committedBucket:committed}),journalStore=new AwsS3ObjectStore(journal,{region,immutableRecoveryJournal:true});
 const publicKey=async id=>id===config.keys.manifest?config.publicKeys.manifest:id===config.keys.recovery?config.publicKeys.recovery:null;
 const journalVersions=new Map();
 const journalReference=(key,ref)=>{if(kind!=='restore')return ref;const versionId=journalVersions.get(key);assert.ok(versionId,'Restore journal read must be in the pinned handoff');if(ref?.versionId)assert.equal(ref.versionId,versionId);return {versionId};};
 const sourceStore={get:(key,ref)=>key.startsWith('recovery/')?journalStore.get(key,journalReference(key,ref)):media.get(key,ref),head:(key,ref)=>key.startsWith('recovery/')?journalStore.head(key,journalReference(key,ref)):media.head(key,ref),getStream:(key,ref)=>key.startsWith('recovery/')?journalStore.getStream(key,journalReference(key,ref)):media.getStream(key,ref)};
 const url=new URL(`postgresql://${host}:5432/${database}?sslmode=verify-full`);url.username=role;url.password=process.env.PACKPROOF_DB_PASSWORD;
 opened=createPgDatabase(url.toString());const db=opened.db;
 const identity=(await db.query("SELECT current_user AS principal,session_user AS login,current_database() AS database,r.rolsuper,r.rolbypassrls,has_schema_privilege(current_user,'public','CREATE') AS can_create FROM pg_roles r WHERE r.rolname=current_user")).rows[0];
 assert.deepEqual(identity,{principal:role,login:role,database,rolsuper:false,rolbypassrls:false,can_create:false});report.databaseIdentity=identity;check('separate_non_owner_login');
 assert.equal((await db.query('SELECT ssl FROM pg_stat_ssl WHERE pid=pg_backend_pid()')).rows[0].ssl,true);check('verified_tls_database_session');
 const getClaim=async()=>{const rows=(await db.query('SELECT id FROM claim_cases WHERE proof_id=$1',[config.proofId])).rows;assert.equal(rows.length,1);return getClaimCase(db,config.operator,config.proofId,rows[0].id);};
 const getJob=async()=>{const rows=(await db.query('SELECT id FROM recipient_export_jobs WHERE proof_id=$1',[config.proofId])).rows;assert.equal(rows.length,1);return getRecipientExport(db,config.operator,config.proofId,rows[0].id,clock);};
 const facts={reasonCode:'product_unacceptable',network:'MASTERCARD',region:'US',paymentMethod:'CARD',lifecycleStatus:'needs_response',providerDeadline:config.providerDeadline,retrievedAt:new Date(Date.now()-1000).toISOString(),allowedActions:['RESPOND']};
 if(kind==='api'){
  await failureCode(()=>db.query('INSERT INTO recipient_export_preservations SELECT * FROM recipient_export_preservations WHERE false'),'42501');
  await failureCode(()=>db.query('UPDATE recipient_export_jobs SET artifact_json=artifact_json WHERE false'),'42501');check('api_database_result_writes_denied');
  if(mode==='request'){
   assert.ok(await denied(()=>s3.send(new PutObjectCommand({Bucket:recipient,Key:`recipient-exports/v2/rex_probe_${run}/artifact.json`,Body:'synthetic forbidden write',IfNoneMatch:'*',ChecksumAlgorithm:'SHA256',ExpectedBucketOwner:account}),options())));check('api_protected_publication_denied');
   assert.ok(await denied(()=>kms.send(new SignCommand({KeyId:config.keys.recovery,Message:Buffer.alloc(32),MessageType:'DIGEST',SigningAlgorithm:'ECDSA_SHA_256'}),options())));check('api_recovery_signing_denied');
   const claim=await createClaimCase(db,clock,config.operator,config.proofId,{...facts,integrationAccountId:config.integrationAccountId,disputeId:'du_synthetic_recipient',paymentId:'ch_synthetic_recipient',orderLineIds:[],idempotencyKey:'synthetic-claim'});
   assert.equal(claim.preservation.status,'COMMITTED_PENDING_DURABILITY');report.claim={id:claim.claimCaseId,revisionId:claim.revisionId,sha256:claim.snapshotSha256};check('request_waits_for_protected_journal');
  }else if(mode==='queue'){
   const claim=await getClaim();assert.equal(claim.preservation.status,'PRESERVED');
   const job=await queueRecipientExport(db,clock,config.operator,config.proofId,{caseId:config.caseId,profileId:'stripe-dispute-us-mastercard-v2',idempotencyKey:'synthetic-export',claimCaseId:claim.claimCaseId,claimSnapshotSha256:claim.snapshotSha256,destinationDeadline:config.providerDeadline,destinationInstructionsReviewed:true,narrative:'Synthetic acceptance fixture; no physical event or actual review asserted.',frames:[{evidenceId:config.evidenceId,offsetMs:0,label:'Synthetic selected frame'}]},protection);
   assert.equal(job.state,'QUEUED');assert.equal(job.preservation.request.status,'COMMITTED_PENDING_DURABILITY');report.jobId=job.jobId;check('queued_exact_claim_and_request_journal');
  }else if(mode==='approve'){
   const job=await getJob();assert.equal(job.state,'READY');assert.equal(job.claimReview.state,'REVIEW_REQUIRED');
   const approval={artifactSha256:job.artifactSha256,claimSnapshotSha256:job.claimSnapshotSha256,action:'EXPORT_FOR_MERCHANT_REVIEW',legibilityConfirmed:true};
   await failureCode(()=>approveRecipientExport(db,clock,media,config.operator,config.proofId,job.jobId,{...approval,action:'AUTHORIZE_PROVIDER_SUBMISSION'},protection),'CLAIM_APPROVAL_ACTION_REQUIRED');check('provider_submission_action_denied');
   const result=await approveRecipientExport(db,clock,media,config.operator,config.proofId,job.jobId,approval,protection);assert.equal(result.claimReview.state,'APPROVAL_PRESERVING');
   await failureCode(()=>downloadRecipientExport(db,media,config.operator,config.proofId,job.jobId,clock,protection),'PRESERVATION_PENDING');report.artifactSha256=job.artifactSha256;check('exact_approval_waits_for_journal');
  }else{
   const job=await getJob();assert.equal(job.claimReview.state,'APPROVED');const zip=await downloadRecipientExport(db,media,config.operator,config.proofId,job.jobId,clock,protection);assert.equal(zip.subarray(0,2).toString(),'PK');report.download={sha256:hash(zip),byteSize:zip.length};check('durable_approved_exact_version_download');
   const claim=await getClaim();await reviseClaimCase(db,clock,config.operator,config.proofId,claim.claimCaseId,{...facts,expectedSnapshotSha256:claim.snapshotSha256,idempotencyKey:'synthetic-revision',retrievedAt:clock.now().toISOString(),lifecycleStatus:'under_review',allowedActions:[]});
   await failureCode(()=>downloadRecipientExport(db,media,config.operator,config.proofId,job.jobId,clock,protection),'CLAIM_REVISION_CHANGED');check('stale_download_denied_after_revision');
  }
  assert.equal(report.recipientWrites.length,0);assert.equal(report.kmsCalls.length,0);
 }else if(kind==='worker'){
  await failureCode(()=>db.query('INSERT INTO recipient_export_approvals SELECT * FROM recipient_export_approvals WHERE false'),'42501');
  await failureCode(()=>db.query('UPDATE recovery_writer_fence SET writes_enabled=true'),'42501');check('worker_cannot_approve_or_reopen_database_fence');
  if(mode==='seed'){
   assert.ok(await denied(()=>kms.send(new SignCommand({KeyId:config.keys.manifest,Message:Buffer.alloc(32),MessageType:'DIGEST',SigningAlgorithm:'ECDSA_SHA_256'}),options())));check('worker_root_signing_denied');
   assert.ok(await denied(()=>s3.send(new DeleteObjectCommand({Bucket:committed,Key:config.original.key,VersionId:config.original.versionId,ExpectedBucketOwner:account}),options())));check('worker_original_deletion_denied');
   const probe={Bucket:journal,Key:`recovery/acceptance/${run}.json`,Body:'synthetic conditional creation probe',ChecksumAlgorithm:'SHA256',ExpectedBucketOwner:account};
   assert.ok(await denied(()=>s3.send(new PutObjectCommand(probe),options())));check('unconditional_journal_publication_denied');
   const created=await s3.send(new PutObjectCommand({...probe,IfNoneMatch:'*'}),options());assert.ok(created.VersionId);
   await assert.rejects(()=>s3.send(new PutObjectCommand({...probe,IfNoneMatch:'*'}),options()),e=>e.name==='PreconditionFailed');check('journal_conditional_creation_prevents_replacement');
   assert.ok(await denied(()=>s3.send(new DeleteObjectCommand({Bucket:journal,Key:probe.Key,VersionId:created.VersionId,ExpectedBucketOwner:account}),options())));check('worker_journal_deletion_denied');
   const probeRetention=await s3.send(new GetObjectRetentionCommand({Bucket:journal,Key:probe.Key,VersionId:created.VersionId,ExpectedBucketOwner:account}),options());assert.equal(probeRetention.Retention.Mode,'COMPLIANCE');assert.ok(probeRetention.Retention.RetainUntilDate.getTime()>=Date.parse(config.retainUntil));check('journal_version_retained_in_compliance_mode');
   const original=await media.get(config.original.key,{versionId:config.original.versionId});assert.ok(original);assert.equal(hash(original.body),config.original.sha256);assert.equal(original.body.length,config.original.byteSize);
   const locked=await s3.send(new GetObjectRetentionCommand({Bucket:committed,Key:config.original.key,VersionId:config.original.versionId,ExpectedBucketOwner:account}),options());assert.equal(locked.Retention.Mode,'COMPLIANCE');assert.ok(locked.Retention.RetainUntilDate.getTime()>=Date.parse(config.retainUntil));check('exact_original_bytes_and_retention');
  }
  const signing=await initializeManifestSigningRuntime(clock,{PACKPROOF_MANIFEST_SIGNING_MODE:'kms',PACKPROOF_MANIFEST_SIGNING_REQUIRED:'true',PACKPROOF_MANIFEST_KMS_KEY_ARN:config.keys.recovery,PACKPROOF_MANIFEST_SIGNING_KEY_ID:config.keys.recovery,PACKPROOF_MANIFEST_SIGNING_ALGORITHM:'ECDSA_SHA_256'},signingTransport);
  const publisher={store:journalStore,signer:signing.signer,trustedPublicKey:publicKey,writerGeneration:config.writerGeneration,protectedStoreVerified:true};
  async function drain(){for(const process of [processPolicyRecoveryOutbox,processRecoveryOutbox]){let ended=false;for(let n=0;n<1000;n++){const value=await process(db,clock,publisher);if(!value.processed){ended=true;break;}assert.equal(value.state,'DURABLE');}assert.ok(ended);}}
  if(mode==='render'){
   assert.deepEqual(await processRecipientExport(db,clock,media,protection),{processed:0,failed:0});check('render_waits_for_request_publication');
   await drain();let first;
   const fault={...protection,writer:{...recipientStore,preserveArtifact:async(...args)=>{const saved=await recipientStore.preserveArtifact(...args);if(!first){first=saved;throw Error('Injected loss after real protected artifact publication');}return saved;}}};
   assert.deepEqual(await processRecipientExport(db,clock,media,fault),{processed:0,failed:1});assert.ok(first);assert.equal((await db.query('SELECT 1 FROM recipient_export_preservations')).rows.length,0);check('lost_response_has_no_false_acceptance');
   const writes=report.recipientWrites.length;await delay(32000);
   assert.deepEqual(await processRecipientExport(db,clock,media,protection),{processed:1,failed:0});assert.equal(report.recipientWrites.length,writes);
   const accepted=(await db.query('SELECT artifact_json FROM recipient_export_jobs')).rows[0];assert.equal(accepted.artifact_json,first.bytes.toString());report.artifactReceipt=first.receipt;check('retry_reuses_first_exact_artifact_without_render_or_put');
   const preserving=await getJob();assert.equal(preserving.state,'PRESERVING');check('accepted_result_waits_for_protected_journal');await drain();assert.equal((await getJob()).state,'READY');
  }else await drain();
  for(const table of ['recovery_delivery','policy_recovery_delivery'])assert.equal((await db.query(`SELECT COUNT(*)::int AS count FROM ${table} WHERE state<>'DURABLE'`)).rows[0].count,0);check('core_and_policy_journals_drained');
  if(mode==='handoff'){
   const claim=(await db.query('SELECT id FROM claim_cases')).rows[0];await failureCode(()=>getClaimCase(db,config.operator,config.proofId,claim.id),'ORGANIZATION_ACCESS_REVOKED');check('revoked_operator_denied_before_restore');
   const core=(await db.query("SELECT e.operation_id,e.sequence,e.sha256,d.receipt_json FROM recovery_events e JOIN recovery_delivery d USING(operation_id) WHERE d.state='DURABLE' ORDER BY e.sequence")).rows;
   const policyRows=(await db.query("SELECT e.sequence,d.event_sha256 AS sha256,d.receipt_json FROM policy_recovery_events e JOIN policy_recovery_delivery d USING(sequence) WHERE d.state='DURABLE' ORDER BY e.sequence")).rows;assert.ok(core.length&&policyRows.length);
   const rows={};for(const table of replayTables)rows[table]=(await db.query(`SELECT to_jsonb(t) AS row FROM ${table} t ORDER BY to_jsonb(t)::text`)).rows;
   const handoff={schema:'packproof.isolated-recipient-replay-input.v1',source,proofId:config.proofId,operator:config.operator,claimId:claim.id,manifestSha256:config.manifestSha256,core,policy:policyRows,coreHead:core.at(-1).sha256,policyHead:policyRows.at(-1).sha256,rows};
   report.replayInput=await save('acceptance/recipient/worker/replay-input.json',handoff);report.heads={core:handoff.coreHead,policy:handoff.policyHead};
   await save(`acceptance/recipient/worker/${run}-ready.json`,report);console.log(JSON.stringify({event:'recipient_handoff_ready',...report}));
   let marker;
   for(let n=0;n<200;n++){try{const value=await s3.send(new GetObjectCommand({Bucket:upload,Key:'acceptance/recipient/config/fence.json',ExpectedBucketOwner:account}),options());marker=JSON.parse(await value.Body.transformToString());if(marker.source===source&&marker.taskArn===metadata.TaskARN)break;}catch(e){if(!['NoSuchKey','AccessDenied'].includes(e.name))throw e;}await delay(3000);}
   assert.equal(marker?.taskArn,metadata.TaskARN);assert.equal(marker?.source,source);
   let fenced=false;for(let n=0;n<50;n++){
    const storage=await denied(()=>s3.send(new PutObjectCommand({Bucket:recipient,Key:`recipient-exports/v2/rex_fence_${run}/artifact-${n}.json`,Body:'synthetic fence probe',IfNoneMatch:'*',ChecksumAlgorithm:'SHA256',ExpectedBucketOwner:account}),options()));
    const signing=await denied(()=>kms.send(new SignCommand({KeyId:config.keys.recovery,Message:Buffer.alloc(32),MessageType:'DIGEST',SigningAlgorithm:'ECDSA_SHA_256'}),options()));if(storage&&signing){fenced=true;break;}await delay(3000);
   }assert.ok(fenced);check('external_iam_fence_denies_cached_credentials');
   await failureCode(()=>db.query('SELECT 1'),'DATABASE_UNAVAILABLE');check('source_database_login_and_sessions_closed');
  }
 }else{
  const handoff=await readJson('acceptance/recipient/worker/replay-input.json',env('HANDOFF_VERSION'),env('HANDOFF_DIGEST'));
  const closed=await readJson('acceptance/recipient/config/source-closed.json',env('SOURCE_CLOSED_VERSION'),env('SOURCE_CLOSED_DIGEST'));
  assert.equal(handoff.source,source);assert.equal(handoff.proofId,config.proofId);assert.equal(closed.source,source);assert.equal(closed.status,'PASSED');assert.equal(closed.writesEnabled,false);assert.equal(closed.apiLoginEnabled,false);assert.equal(closed.workerLoginEnabled,false);assert.equal(closed.iamWriterFence,'CLOSED');assert.equal(closed.cachedCredentialFenceVerified,true);assert.equal(closed.coreHead,handoff.coreHead);assert.equal(closed.policyHead,handoff.policyHead);assert.ok(closed.externalFenceReference);
  async function load(rows){const values=[];for(const row of rows){const receipt=row.receipt_json;assert.ok(receipt.objectVersionId);const value=await journalStore.get(receipt.objectKey,{versionId:receipt.objectVersionId});assert.ok(value);assert.equal(hash(value.body),receipt.envelopeSha256);const lock=await s3.send(new GetObjectRetentionCommand({Bucket:journal,Key:receipt.objectKey,VersionId:receipt.objectVersionId,ExpectedBucketOwner:account}),options());assert.equal(lock.Retention.Mode,'COMPLIANCE');assert.ok(lock.Retention.RetainUntilDate.getTime()>=Date.parse(config.retainUntil));values.push(value.body);}return values;}
  for(const row of [...handoff.core,...handoff.policy]){const receipt=row.receipt_json;assert.ok(receipt.objectVersionId);assert.ok(!journalVersions.has(receipt.objectKey));journalVersions.set(receipt.objectKey,receipt.objectVersionId);}
  const core=await load(handoff.core),policies=await load(handoff.policy);
  const restored=await restoreFreshRecoveryDatabase(db,{expectedDatabase:database,restoreRole:role,isolatedTargetReference:metadata.TaskARN,oldWriterFenceReference:closed.externalFenceReference,targetWriterGeneration:'m2-recipient-restored-20261022',core:{envelopes:core,expectedWatermark:core.at(-1)},policy:{envelopes:policies,expectedWatermark:policies.at(-1)},trustedPublicKey:publicKey,sourceStore,recipients:recipientStore});
  assert.equal(restored.writersEnabled,false);assert.equal(restored.trafficMayOpen,false);assert.equal(restored.counts.recipient_export_preservations,1);assert.equal(restored.counts.recipient_export_approvals,1);
  assert.deepEqual(Object.keys(handoff.rows).sort(),[...replayTables].sort());
  for(const table of replayTables)assert.equal(canonicalize((await db.query(`SELECT to_jsonb(t) AS row FROM ${table} t ORDER BY to_jsonb(t)::text`)).rows),canonicalize(handoff.rows[table]),`Restored rows differ: ${table}`);
  check('fresh_database_reconstructs_exact_claim_result_approval_and_original_references');
  await failureCode(()=>getClaimCase(db,config.operator,config.proofId,handoff.claimId),'ORGANIZATION_ACCESS_REVOKED');check('revoked_operator_denied_after_restore');
  assert.equal(report.recipientWrites.length,0);assert.equal(report.kmsCalls.length,0);check('restore_does_not_render_resign_or_publish');report.restore=restored;report.databaseRestoreVerified=true;
 }
 report.status='PASSED';
}catch(error){report.status='FAILED';report.failure={name:error.name,code:error.code??null,status:error.$metadata?.httpStatusCode??null,assertion:error.name==='AssertionError'?String(error.message).slice(0,500):undefined};process.exitCode=1;}
finally{await opened?.close();const reference=await save(`acceptance/recipient/${kind}/${run}.json`,report);console.log(JSON.stringify({event:'recipient_acceptance_complete',...report,reportObject:reference}));}
