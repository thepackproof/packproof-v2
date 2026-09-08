/**
 * Synthetic HTTP acceptance check. Does not use a real shipment or contact a recipient.
 * Local: node --import tsx scripts/pilot-http-smoke.ts --local
 * Deployed: PACKPROOF_SMOKE_API_URL=https://... PACKPROOF_SMOKE_TOKEN_FILE=/secure/token
 *   node --import tsx scripts/pilot-http-smoke.ts --synthetic-deployed-check
 * The deployed mode creates an explicitly labeled test Proof and revokes its guest link.
 * Tokens and bearer URLs are never printed. This does not exercise device camera/biometrics.
 * Browser resumable transport is the default; PACKPROOF_SMOKE_UPLOAD_MODE=gateway
 * tests the native whole-file upload contract instead.
 */
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

const mode=process.argv[2];
assert(['--local','--synthetic-deployed-check'].includes(mode),'Choose --local or --synthetic-deployed-check');
const directory=await mkdtemp(path.join(tmpdir(),'packproof-http-smoke-'));
let cleanup=async()=>{};
let baseUrl=process.env.PACKPROOF_SMOKE_API_URL?.replace(/\/$/,'')??'';
let token='';
let proofId:string|undefined;
let sharedLinkId:string|undefined;
const checks:string[]=[];
const uploadMode=process.env.PACKPROOF_SMOKE_UPLOAD_MODE??'resumable';
assert(['resumable','gateway'].includes(uploadMode),'Choose resumable or gateway upload mode');
const digest=(bytes:Uint8Array|string)=>createHash('sha256').update(bytes).digest('hex');

async function api(label:string,pathname:string,options:{method?:string;body?:unknown;public?:boolean;binary?:boolean;headers?:Record<string,string>}={}) {
  const response=await fetch(`${baseUrl}${pathname}`,{method:options.method??'GET',
    headers:{...(!options.public?{Authorization:`Bearer ${token}`}:{}) ,...(options.body!==undefined?{'Content-Type':'application/json'}:{}),...options.headers},
    body:options.body===undefined?undefined:JSON.stringify(options.body),signal:AbortSignal.timeout(60000)});
  if(!response.ok){let code='HTTP_ERROR';try{code=(await response.json() as any).error?.code??code;}catch{}throw Object.assign(new Error(`${label}: ${response.status} ${code}`),{code});}
  if(response.status===204)return null;
  return options.binary?Buffer.from(await response.arrayBuffer()):await response.json();
}
async function poll(label:string,run:()=>Promise<any>,ready:(value:any)=>boolean){
  const until=Date.now()+60000;
  while(Date.now()<until){try{const value=await run();if(ready(value))return value;if(value.state==='FAILED')throw new Error(`${label}: ${value.failureCode}`);}catch(error){if((error as {code?:string}).code!=='PRESERVATION_PENDING')throw error;}await new Promise(resolve=>setTimeout(resolve,1000));}
  throw new Error(`${label}: timed out after 60 seconds`);
}
try {
  if(mode==='--local'){
    const {createHarness,createUser}=await import('../tests/helpers.js');
    const {startOperationsWorkers}=await import('../src/operations/runtime-jobs.js');
    const {loadConfig}=await import('../src/config.js');
    const h=await createHarness();
    const server=h.app.listen(0,'127.0.0.1');
    await new Promise<void>((resolve,reject)=>{server.once('listening',resolve);server.once('error',reject);});
    const address=server.address();assert(address&&typeof address!=='string');
    baseUrl=`http://127.0.0.1:${address.port}`;
    // Runtime adapter returns this origin in upload contracts; use the actual ephemeral listener.
    (h.objectStore as {gatewayBaseUrl:string}).gatewayBaseUrl=baseUrl;
    token=await createUser(h);
    const config=loadConfig({PACKPROOF_AUTH_MODE:'dev',PACKPROOF_DEV_AUTH:'true',PACKPROOF_OBJECT_STORE:'local'});
    const stopWorkers=startOperationsWorkers(h.db,h.clock,h.objectStore,config,undefined,{});
    cleanup=async()=>{await stopWorkers();await new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve()));await h.close();};
  } else {
    assert(baseUrl.startsWith('https://'),'Deployed API must use HTTPS');
    assert(process.env.PACKPROOF_SMOKE_TOKEN_FILE,'A protected token file is required');
    token=(await readFile(process.env.PACKPROOF_SMOKE_TOKEN_FILE,'utf8')).trim();
    assert(token.length>0,'Token file is empty');
  }
  const mediaFile=path.join(directory,'synthetic-not-a-shipment.mp4');
  await promisify(execFile)('ffmpeg',['-nostdin','-v','error','-f','lavfi','-i','color=c=white:s=1280x720:r=25',
    '-vf',"drawtext=text='SYNTHETIC PACKPROOF TEST - NOT A SHIPMENT':fontsize=34:fontcolor=black:x=60:y=330",'-t','1',
    '-c:v','libx264','-threads','1','-pix_fmt','yuv420p',mediaFile],{timeout:20000});
  const bytes=await readFile(mediaFile),sha256=digest(bytes),key=`synthetic-${randomUUID()}`;
  await api('readiness','/ready',{public:true});checks.push('readiness');
  const capabilities=await api('capabilities','/capabilities',{public:true});
  assert(capabilities.sellerAttestation.challengeVersions.includes(1));checks.push('attestation-protocol-advertised');
  const transaction=await api('create synthetic transaction','/transactions',{method:'POST',body:{
    itemTitle:'SYNTHETIC SMOKE TEST - NOT A SHIPMENT',externalReference:key,quantity:1}});
  const proof=await api('create Proof',`/transactions/${transaction.transactionId}/proof`,{method:'POST',body:{}});
  proofId=proof.proofId;assert(proofId);const root=`/proofs/${proofId}`;
  assert.equal(proof.participationPolicy??proof.proof?.participationPolicy??'COUNTERPARTY_OPTIONAL','COUNTERPARTY_OPTIONAL');
  const capture=await api('authorize web capture',`${root}/capture-sessions`,{method:'POST',body:{client:'WEB_CAMERA',idempotencyKey:key}});
  await api('register original recording',`${root}/capture-sessions/${capture.id}/complete`,{method:'POST',body:{sha256,byteSize:bytes.length,contentType:'video/mp4',recordedDurationMs:1000,interrupted:false}});
  const upload=await api('reserve original upload',`${root}/evidence/uploads`,{method:'POST',body:{contentType:'video/mp4',evidenceType:'FULFILLMENT_CAPTURE',captureSessionId:capture.id,byteSize:bytes.length,idempotencyKey:key}});
  if(uploadMode==='gateway'){
    const uploadUrl=new URL(upload.upload.url);assert(['http:','https:'].includes(uploadUrl.protocol));
    const uploaded=await fetch(uploadUrl,{method:'PUT',headers:upload.upload.headers,body:bytes,signal:AbortSignal.timeout(60000)});
    assert(uploaded.ok,`Original upload returned ${uploaded.status}`);
  }else{
    const partsPath=`${root}/evidence/${upload.evidenceId}/parts`;
    const state=await api('resumable upload status',partsPath);
    assert(Number.isSafeInteger(state.partSize)&&state.partSize>0);
    for(let offset=0,part=1;offset<bytes.length;offset+=state.partSize,part++){
      const uploaded=await fetch(`${baseUrl}${partsPath}/${part}`,{method:'PUT',headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/octet-stream'},body:bytes.subarray(offset,offset+state.partSize),signal:AbortSignal.timeout(60000)});
      assert(uploaded.ok,`Resumable part ${part} returned ${uploaded.status}`);
    }
    const recovered=await api('resumable recovered part hashes',partsPath);
    assert.equal(recovered.parts.length,Math.ceil(bytes.length/state.partSize));
    await api('assemble resumable original',`${partsPath}/complete`,{method:'POST',body:{totalBytes:bytes.length}});
  }
  await api('commit original',`${root}/evidence/${upload.evidenceId}/commit`,{method:'POST',body:{sha256}});
  const playback=await api('original playback',`${root}/evidence/${upload.evidenceId}`,{binary:true});
  assert.equal(digest(playback),sha256);checks.push('authorized-web-capture-upload-commit-playback');
  await api('web shipping declaration',`${root}/attestations`,{method:'POST',body:{statement:'PACKED_DESCRIBED_ITEM',relatedEvidenceId:upload.evidenceId}});
  const final=await poll('final preservation',()=>api('finalize',`${root}/finalize`,{method:'POST',body:{}}),value=>value.proof.status==='FINALIZED');
  const retry=await api('finalization retry',`${root}/finalize`,{method:'POST',body:{}});assert.equal(retry.manifest.sha256,final.manifest.sha256);
  const manifest=await api('frozen manifest',`${root}/manifest`);assert.equal(digest(manifest.canonicalJson),manifest.sha256);
  checks.push('seller-only-finalization-and-idempotent-manifest');
  const shareInput={purpose:'SHARED_PROOF'};
  const preview=await api('shared Proof preview',`${root}/disclosure/preview`,{method:'POST',body:shareInput});
  const grant=await api('create synthetic guest link',`${root}/disclosure/grants`,{method:'POST',body:{...shareInput,originalsReviewed:true,previewHash:preview.disclosure.viewHash}});
  sharedLinkId=grant.accessLinkId;assert(grant.token);
  const publicProof=await api('guest Proof',`/public/proofs/${grant.token}`,{public:true});
  assert(publicProof.evidence.some((item:any)=>item.evidenceId===upload.evidenceId));
  assert.equal(digest(await api('guest original playback',`/public/proofs/${grant.token}/evidence/${upload.evidenceId}`,{public:true,binary:true})),sha256);
  const archive=await api('owner evidence package',`${root}/package`,{binary:true});assert.equal(archive.subarray(0,2).toString(),'PK');checks.push('shared-proof-original-and-export-package');
  const signature=await api('case snapshot',`${root}/signature`);
  const packet=await api('synthetic case',`${root}/signature/cases`,{method:'POST',body:{snapshotId:signature.snapshot.snapshotId,template:'WRONG_ITEM',scope:{fields:['status','order','shipping','evidence','statements'],evidenceIds:[upload.evidenceId]}}});
  const profiles=await api('recipient profiles',`${root}/recipient-exports/profiles`);
  const profile=profiles.profiles.find((item:any)=>item.destination==='STRIPE_DISPUTE'&&!item.reviewRequired);assert(profile,'A current recipient test profile is required');
  const job=await api('queue synthetic recipient render',`${root}/recipient-exports`,{method:'POST',body:{caseId:packet.caseId,profileId:profile.id,idempotencyKey:key,
    destinationInstructionsReviewed:true,destinationDeadline:new Date(Date.now()+86400000).toISOString(),
    narrative:'SYNTHETIC SYSTEM CHECK. This is not a shipment, dispute, or claim. Do not submit this test packet to a recipient.',
    frames:[{evidenceId:upload.evidenceId,offsetMs:50,label:'Synthetic system check - not shipment evidence'}]}});
  const ready=await poll('recipient export worker',()=>api('render status',`${root}/recipient-exports/${job.jobId}`),value=>value.state==='READY');
  const rendered=await api('exact recipient preview',`${root}/recipient-exports/${job.jobId}/files/0?preview=true`,{binary:true});
  assert.equal(rendered.subarray(0,5).toString(),'%PDF-');assert.equal(digest(rendered),ready.artifact.files[0].sha256);
  // Synthetic fixed text/720p card has no customer content; approval tests the API boundary only.
  await api('approve synthetic packet',`${root}/recipient-exports/${job.jobId}/approve`,{method:'POST',body:{artifactSha256:ready.artifactSha256,legibilityConfirmed:true}});
  assert.equal(digest(await api('approved recipient PDF',`${root}/recipient-exports/${job.jobId}/files/0`,{binary:true})),digest(rendered));
  assert.equal((await api('recipient packet ZIP',`${root}/recipient-exports/${job.jobId}/download`,{binary:true})).subarray(0,2).toString(),'PK');
  checks.push('recipient-worker-render-preview-approval-and-exact-download');
  await api('revoke synthetic share',`${root}/access-links/${sharedLinkId}`,{method:'DELETE'});sharedLinkId=undefined;
  const revoked=await fetch(`${baseUrl}/public/proofs/${grant.token}`,{signal:AbortSignal.timeout(10000)});assert.equal(revoked.status,404);checks.push('guest-revocation');
  console.log(JSON.stringify({status:'PASS',mode,uploadMode,proofId,checks,limitations:['Synthetic HTTP check; physical camera, Android biometric prompt, Cognito login UI, live carriers and real recipient portals require separate verification.']},null,2));
} catch(error) {
  console.error(JSON.stringify({status:'FAIL',mode,proofId,completedChecks:checks,error:error instanceof Error?error.message:'Unknown failure'},null,2));
  process.exitCode=1;
} finally {
  if(proofId&&sharedLinkId)try{await api('revoke synthetic share',`/proofs/${proofId}/access-links/${sharedLinkId}`,{method:'DELETE'});}catch{console.error('Synthetic guest link cleanup failed; revoke the test Proof link before sharing the account.');}
  await cleanup();await rm(directory,{recursive:true,force:true});
}
