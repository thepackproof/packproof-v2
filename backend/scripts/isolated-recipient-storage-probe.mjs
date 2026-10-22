// One-shot synthetic storage acceptance. No database, merchant or provider action.
// Executed inline by its reviewed task definition against an exact application image.
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
import {defaultProvider} from '@aws-sdk/credential-provider-node';
import {S3Client,PutObjectCommand,HeadObjectCommand,GetObjectCommand,GetObjectRetentionCommand,DeleteObjectCommand,PutObjectRetentionCommand} from '@aws-sdk/client-s3';
import {createRecipientS3Store} from './dist/export/recipient-s3-store.js';

const env=name=>{const value=process.env['M2_'+name];assert.ok(value,`Missing M2_${name}`);return value;};
assert.equal(env('PURPOSE'),'isolated-recipient-storage');
assert.equal(env('ACCOUNT'),'784514617543');assert.equal(env('REGION'),'us-east-1');
const account=env('ACCOUNT'),kind=env('ROLE'),stack=env('STACK'),source=env('SOURCE'),harness=env('HARNESS'),image=env('IMAGE');
assert.ok(['worker','api','restore'].includes(kind));assert.match(stack,/^packproof-m2-recipient-[a-z0-9-]+$/);
assert.match(source,/^[a-f0-9]{40}$/);assert.match(harness,/^[a-f0-9]{40}$/);
assert.match(image,/^784514617543\.dkr\.ecr\.us-east-1\.amazonaws\.com\/packproof-m1-20261021-runtime@sha256:[a-f0-9]{64}$/);
assert.ok(process.env.ECS_CONTAINER_METADATA_URI_V4);assert.ok(process.env.AWS_CONTAINER_CREDENTIALS_RELATIVE_URI);
assert.equal(process.env.AWS_ACCESS_KEY_ID,undefined);
const metadata=await fetch(process.env.ECS_CONTAINER_METADATA_URI_V4+'/task',{signal:AbortSignal.timeout(5000)}).then(r=>r.json());
assert.equal(metadata.Family,`${stack}-${kind}`);
const run=metadata.TaskARN.split('/').at(-1),hash=bytes=>createHash('sha256').update(bytes).digest('hex');
// Freeze this task session so the fence test includes already-issued credentials.
const credentials=await defaultProvider()();
const s3=new S3Client({region:env('REGION'),credentials,maxAttempts:2});
const bucket=env('BUCKET'),reports=env('REPORTS'),canary=env('CANARY');
assert.equal(new Set([bucket,reports,canary]).size,3);
const policy={profile:'packproof.recipient-protection.v1',bucket,retainUntil:env('RETAIN_UNTIL')};
assert.ok(Date.parse(policy.retainUntil)>Date.now());assert.ok(Date.parse(policy.retainUntil)<=Date.now()+86400000);
const report={schema:'packproof.recipient-storage-probe.v1',source,harness,image,kind,stack,taskArn:metadata.TaskARN,taskRevision:metadata.Revision,
 syntheticOnly:true,productionChanged:false,databaseRestoreVerified:false,checks:[],startedAt:new Date().toISOString()};
const check=name=>report.checks.push(name),options=()=>({abortSignal:AbortSignal.timeout(30000)});
const send=command=>s3.send(command,options());
const denied=async fn=>{try{const value=await fn();value?.Body?.destroy?.();return false;}catch(error){if(['AccessDenied','AccessDeniedException'].includes(error.name))return true;throw error;}};
const reference=receipt=>({Bucket:bucket,Key:receipt.object.key,VersionId:receipt.object.versionId,ExpectedBucketOwner:account});
async function readReport(Key,VersionId,digest){
 assert.ok(VersionId&&VersionId!=='null');assert.match(digest??'',/^[a-f0-9]{64}$/);
 const value=await send(new GetObjectCommand({Bucket:reports,Key,VersionId,ExpectedBucketOwner:account}));
 try{
  assert.equal(value.VersionId,VersionId);assert.ok(value.ContentLength>0&&value.ContentLength<256000);
  const bytes=Buffer.from(await value.Body.transformToByteArray());assert.equal(bytes.length,value.ContentLength);assert.equal(hash(bytes),digest);return JSON.parse(bytes.toString());
 }finally{value.Body?.destroy?.();}
}
async function saveReport(suffix){
 const Body=Buffer.from(JSON.stringify(report)),Key=`acceptance/${kind}/${run}${suffix}.json`;
 const value=await send(new PutObjectCommand({Bucket:reports,Key,Body,ContentType:'application/json',ChecksumAlgorithm:'SHA256',ChecksumSHA256:createHash('sha256').update(Body).digest('base64'),ExpectedBucketOwner:account}));
 assert.ok(value.VersionId);return {bucket:reports,key:Key,versionId:value.VersionId,sha256:hash(Body)};
}
let lost=false,successfulPuts=0;
const transport={head:input=>send(new HeadObjectCommand(input)),get:input=>send(new GetObjectCommand(input)),retention:input=>send(new GetObjectRetentionCommand(input)),put:async input=>{
 const result=await send(new PutObjectCommand(input));successfulPuts++;
 if(kind==='worker'&&!lost&&input.Key.endsWith('/artifact.json')){lost=true;throw Error('SYNTHETIC_LOST_PUBLICATION_RESPONSE');}
 return result;
}};
const store=createRecipientS3Store({bucket,expectedBucketOwner:account,clock:{now:()=>new Date()},transport});
try{
 let jobId,file,artifact,bytes;
 if(kind==='worker'){
  jobId=`rex_cloud_${run}`;
  // A one-pixel synthetic PNG tests storage bytes, not useful claim evidence.
  bytes=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jG1sAAAAASUVORK5CYII=','base64');
  file=await store.preserveFile(jobId,bytes,'image/png',policy);
  assert.deepEqual(await store.read(jobId,file,policy),bytes);check('worker_exact_version_bytes_and_compliance_retention');
  const body=Buffer.from(JSON.stringify({schema:'packproof.synthetic-storage-artifact.v1',jobId,source,file}));
  await assert.rejects(store.preserveArtifact(jobId,body,policy),/SYNTHETIC_LOST_PUBLICATION_RESPONSE/);
  const puts=successfulPuts;artifact=await store.findArtifact(jobId,policy);assert.ok(artifact);assert.deepEqual(artifact.bytes,body);assert.equal(successfulPuts,puts);check('lost_response_reconciles_first_exact_artifact_without_new_write');
  const duplicate=await store.preserveArtifact(jobId,Buffer.from('different contender'),policy);
  assert.equal(duplicate.receipt.object.versionId,artifact.receipt.object.versionId);assert.deepEqual(duplicate.bytes,body);assert.equal(successfulPuts,puts);check('conditional_duplicate_preserves_first_version');
  assert.ok(await denied(()=>send(new PutObjectCommand({Bucket:bucket,Key:`recipient-exports/v2/${jobId}/unconditional`,Body:bytes,ExpectedBucketOwner:account}))));check('unconditional_creation_denied_by_bucket_policy');
 }else{
  const previous=await readReport(env('WORKER_REPORT_KEY'),env('WORKER_REPORT_VERSION'),env('WORKER_REPORT_SHA256'));
  assert.equal(previous.status,'PASSED');assert.equal(previous.kind,'worker');assert.equal(previous.source,source);assert.equal(previous.harness,harness);assert.equal(previous.image,image);assert.equal(previous.stack,stack);
  ({jobId,file}=previous);artifact={receipt:previous.artifact};
  bytes=await store.read(jobId,file,policy);assert.equal(hash(bytes),file.sha256);
  const value=await store.read(jobId,artifact.receipt,policy);assert.equal(hash(value),artifact.receipt.sha256);
  check('separate_role_reads_only_exact_protected_versions');
  assert.ok(await denied(()=>send(new GetObjectCommand({Bucket:bucket,Key:file.object.key,ExpectedBucketOwner:account}))));check('latest_version_read_denied');
  assert.ok(await denied(()=>send(new PutObjectCommand({Bucket:bucket,Key:`recipient-exports/v2/rex_forbidden_${run}/artifact.json`,Body:Buffer.from('synthetic denied write'),IfNoneMatch:'*',ExpectedBucketOwner:account}))));check('protected_writes_denied');
 }
 report.jobId=jobId;report.file=file;report.artifact=artifact.receipt;
 await assert.rejects(store.read(jobId,{...file,sha256:'0'.repeat(64)},policy));check('altered_digest_rejected');
 assert.ok(await denied(()=>send(new DeleteObjectCommand(reference(file)))));check('exact_version_deletion_denied');
 assert.ok(await denied(()=>send(new PutObjectRetentionCommand({...reference(file),Retention:{Mode:'COMPLIANCE',RetainUntilDate:new Date(Date.now()+3600000)}}))));check('retention_shortening_denied');
 assert.ok(await denied(()=>send(new GetObjectCommand({Bucket:canary,Key:'scope-canary.txt',ExpectedBucketOwner:account}))));check('other_bucket_read_denied');
 assert.ok(await denied(()=>send(new PutObjectCommand({Bucket:canary,Key:`forbidden-${run}`,Body:Buffer.from('synthetic denied write'),ExpectedBucketOwner:account}))));check('other_bucket_write_denied');
 if(kind==='worker'){
  const ready=await saveReport('-ready');console.log(JSON.stringify({event:'recipient_storage_probe_ready',taskArn:metadata.TaskARN,report:ready}));
  let fenced=false;
  for(let n=0;n<200;n++){
   try{
    const value=await send(new GetObjectCommand({Bucket:reports,Key:'configuration/fence.json',ExpectedBucketOwner:account}));
    try{
     assert.ok(value.ContentLength>0&&value.ContentLength<16000);const marker=JSON.parse(await value.Body.transformToString());
     fenced=marker.source===source&&marker.harness===harness&&marker.taskArn===metadata.TaskARN&&marker.writerFence==='CLOSED'&&Boolean(marker.changeSetArn);
    }finally{value.Body?.destroy?.();}
   }catch(error){if(!['NoSuchKey','AccessDenied'].includes(error.name))throw error;}
   if(fenced)break;await delay(3000);
  }
  assert.ok(fenced,'Current task-specific operator fence marker missing');
  let stopped=false;
  for(let n=0;n<60;n++){
   stopped=await denied(()=>send(new PutObjectCommand({Bucket:bucket,Key:`recipient-exports/v2/${jobId}/fence-${n}`,Body:Buffer.from('synthetic fence probe'),IfNoneMatch:'*',ExpectedBucketOwner:account})));
   if(stopped)break;await delay(1000);
  }
  assert.ok(stopped,'Cached worker session still publishes after fence');check('cached_task_credentials_obey_external_writer_fence');
 }
 report.status='PASSED';
}catch(error){report.status='FAILED';report.failure={name:error.name,code:error.code??null,httpStatus:error.$metadata?.httpStatusCode??null,message:error.name==='AssertionError'?String(error.message).slice(0,250):undefined};process.exitCode=1;}
finally{report.completedAt=new Date().toISOString();const saved=await saveReport('');console.log(JSON.stringify({event:'recipient_storage_probe_complete',...report,report:saved}));}
