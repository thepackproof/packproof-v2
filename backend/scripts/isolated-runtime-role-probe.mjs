// Runs only as an ECS task, using a cached copy of that task's original credentials.
import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
import {S3Client,PutObjectCommand,GetObjectCommand,DeleteObjectCommand,GetObjectRetentionCommand} from '@aws-sdk/client-s3';
import {KMSClient,SignCommand} from '@aws-sdk/client-kms';
assert.equal(process.env.PACKPROOF_TEST_PURPOSE,'isolated-m1-synthetic');
assert.ok(process.env.ECS_CONTAINER_METADATA_URI_V4);
const kind=process.env.PACKPROOF_PROCESS_ROLE;assert.ok(['api','worker'].includes(kind));
const upload='packproof-m1-20261020-uploadbucket-8o4ikwomdg8h',journal='packproof-m1-20261020-recoverybucket-aripohrxorbp';
const region='us-east-1',original=new S3Client({region}),credentials=await original.config.credentials();
const s3=new S3Client({region,credentials,maxAttempts:1}),kms=new KMSClient({region,credentials,maxAttempts:1});
const run=randomBytes(8).toString('hex'),key=`acceptance/runtime/probes/${kind}/${run}.json`;
const metadata=await fetch(process.env.ECS_CONTAINER_METADATA_URI_V4+'/task').then(r=>r.json());
const report={schema:'packproof.runtime-role-probe.v1',kind,run,taskArn:metadata.TaskARN,checks:[],source:process.env.PACKPROOF_RELEASE_SHA};
const check=name=>report.checks.push(name);
const denied=async(fn)=>{try{await fn();return false;}catch(e){if(['AccessDenied','AccessDeniedException'].includes(e.name))return true;throw e;}};
const sign=keyId=>kms.send(new SignCommand({KeyId:keyId,Message:Buffer.alloc(32),MessageType:'DIGEST',SigningAlgorithm:'ECDSA_SHA_256'}));
const probeBucket=kind==='api'?upload:journal,probeKey=kind==='api'?`evidence/runtime-probe/${run}`:`acceptance/runtime/probe/${run}`;
const put=()=>s3.send(new PutObjectCommand({Bucket:probeBucket,Key:probeKey,Body:'SYNTHETIC ECS ROLE PROBE',IfNoneMatch:'*'}));
try{
 const version=await put();assert.ok(version.VersionId);check('own_storage_write');
 try{await put();assert.fail('Duplicate conditional object creation succeeded');}catch(e){assert.equal(e.$metadata?.httpStatusCode,412);}check('conditional_creation');
 const ownKey=process.env[kind==='api'?'PACKPROOF_MANIFEST_KMS_KEY_ARN':'PACKPROOF_RECOVERY_KMS_KEY_ARN'];
 const otherKey=process.env[kind==='api'?'PACKPROOF_RECOVERY_KMS_KEY_ARN':'PACKPROOF_MANIFEST_KMS_KEY_ARN'];
 await sign(ownKey);check('own_signing');assert.ok(await denied(()=>sign(otherKey)));check('other_signing_denied');
 if(kind==='api'){assert.ok(await denied(()=>s3.send(new PutObjectCommand({Bucket:journal,Key:`acceptance/runtime/forbidden/${run}`,Body:'denied'}))));check('api_journal_write_denied');}
 else{assert.ok(await denied(()=>s3.send(new DeleteObjectCommand({Bucket:journal,Key:probeKey,VersionId:version.VersionId}))));check('worker_version_delete_denied');}
 report.initialPassed=true;console.log(JSON.stringify({event:'runtime_role_probe_ready',...report}));
 await s3.send(new PutObjectCommand({Bucket:upload,Key:key,Body:JSON.stringify(report),ContentType:'application/json'}));
 let closed=false;
 for(let n=0;n<180;n++){
  try{const marker=await s3.send(new GetObjectCommand({Bucket:upload,Key:'acceptance/runtime/config/fence-now.json'}));const value=JSON.parse(await marker.Body.transformToString());if(value.source===report.source){closed=true;break;}}
  catch(e){if(!['NoSuchKey','AccessDenied'].includes(e.name))throw e;}
  await delay(3000);
 }
 assert.ok(closed,'External fence marker timed out');
 let fenced=false;
 for(let n=0;n<40;n++){
  const writeDenied=await denied(()=>s3.send(new PutObjectCommand({Bucket:probeBucket,Key:probeKey+'-fenced',Body:'SYNTHETIC FENCE PROBE'})));
  const signDenied=await denied(()=>sign(ownKey));
  if(writeDenied&&signDenied){fenced=true;break;}await delay(3000);
 }
 assert.ok(fenced,'External fence did not deny existing task credentials');check('external_fence_denies_existing_task_credentials');report.status='PASSED';
}catch(e){report.status='FAILED';report.failure={name:e.name,code:e.$metadata?.httpStatusCode};process.exitCode=1;}
await s3.send(new PutObjectCommand({Bucket:upload,Key:key,Body:JSON.stringify(report),ContentType:'application/json'}));
console.log(JSON.stringify({event:'runtime_role_probe_complete',...report}));
