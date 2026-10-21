// Offline fixture construction plus real HTTPS calls. No in-process domain writes.
import assert from 'node:assert/strict';
import https from 'node:https';
import {randomBytes,createHash} from 'node:crypto';
import {readFile,writeFile} from 'node:fs/promises';
import {setTimeout as delay} from 'node:timers/promises';
import {CORE_VERSION,chainSegment,createManifest,manifestDigest} from '../src/capture/core.ts';
let raw='';for await(const chunk of process.stdin)raw+=chunk;const input=JSON.parse(raw);raw='';
assert.equal(process.env.PACKPROOF_TEST_PURPOSE,'isolated-m1-synthetic');assert.match(input.ip,/^10\.42\./);
const digest=b=>createHash('sha256').update(b).digest('hex');
let phase='start',lastStatus,lastCode;
const once=(method,path,token,body,statuses=[200],extra={})=>new Promise((resolve,reject)=>{
 const bytes=Buffer.isBuffer(body)?body:body===undefined?null:Buffer.from(JSON.stringify(body));
 const req=https.request({host:input.ip,port:3443,servername:'packproof-m1.test',ca:input.ca,rejectUnauthorized:true,method,path,
  headers:{Host:'packproof-m1.test:3443',Authorization:`Bearer ${token}`,'Content-Type':Buffer.isBuffer(body)?'video/mp4':'application/json','Idempotency-Key':randomBytes(16).toString('hex'),...(bytes?{'Content-Length':String(bytes.length)}:{}),...extra}},res=>{
  const chunks=[];res.on('data',b=>chunks.push(b));res.on('end',()=>{
   const data=Buffer.concat(chunks);lastStatus=res.statusCode;
   let value;try{value=JSON.parse(data.toString());}catch{value=data;}
   lastCode=value?.code; if(!statuses.includes(res.statusCode)){reject(new Error('Unexpected HTTP status'));return;}
   resolve(value);
  });res.on('error',reject);
 });req.setTimeout(90000,()=>req.destroy(new Error('HTTP timeout')));req.on('error',reject);req.end(bytes);
});
const call=async(method,path,token,body,statuses=[200],extra={})=>{
 const headers={'Idempotency-Key':randomBytes(16).toString('hex'),...extra};
 for(let attempt=0;attempt<60;attempt++){
  const value=await once(method,path,token,body,[...statuses,503],headers);
  if(lastStatus===503&&value.code==='POLICY_DURABILITY_PENDING'){await delay(1000);continue;}
  assert.ok(statuses.includes(lastStatus),'Unexpected HTTP status');return value;
 }
 throw new Error('Policy publication did not settle');
};
const report={checks:[],proofs:[]};
try{
 const bytes=await readFile(new URL('../tests/fixtures/camera-recording.mp4',import.meta.url));
 for(const [owner,operator,other] of [['ownerA','operatorA','operatorB'],['ownerB','operatorB','operatorA']]){
  const proof=input.proofs[owner],token=input.tokens[operator],headers={'PackProof-Merchant-Id':input.merchants[owner],'PackProof-Delegation-Id':input.grants[owner]};
  phase=owner+':intent';
  const intent=await call('POST',`/v1/partner/proofs/${proof}/capture-intents`,input.tokens.partner,{allowedSurfaces:['WEB']},[201],headers);
  const capabilities={surface:'WEB',cameraSource:'UNKNOWN',timing:'MONOTONIC',barcode:false,itemVisibility:false,durableJournal:true,incrementalMedia:false,audio:false,deviceAuthentication:'UNAVAILABLE',appIntegrity:'UNAVAILABLE',storageReserveBytes:10000000,coreVersion:CORE_VERSION};
  const denied=await call('POST','/capture-sessions/bind',input.tokens[other],{launchToken:intent.launchToken,capabilities},[409]);assert.equal(denied.code,'CAPTURE_INTENT_INVALID');
  phase=owner+':bind';
  const bound=await call('POST','/capture-sessions/bind',token,{launchToken:intent.launchToken,capabilities},[201]);
  const id=bound.session.id,source={sha256:digest(bytes),byteSize:bytes.length,contentType:'video/mp4',durationMs:200};
  const hash=async b=>digest(b),segment=await chainSegment({sequence:0,offsetBytes:0,byteSize:bytes.length,sha256:source.sha256,previous:null,startMs:0,endMs:200,timing:'WHOLE_RECORDING'},hash);
  const observations=[{id:'start',captureId:id,type:'CAPTURE_STARTED',startMs:0,endMs:0,source:'DEVICE',model:null,confidence:null,value:null,timePrecision:'APPROXIMATE'},{id:'end',captureId:id,type:'CAPTURE_ENDED',startMs:200,endMs:200,source:'DEVICE',model:null,confidence:null,value:null,timePrecision:'APPROXIMATE'}];
  const manifest=await createManifest(bound.context,source,[segment],observations,hash);
  phase=owner+':complete';
  await call('POST',`/proofs/${proof}/capture-sessions/${id}/complete`,token,{...source,recordedDurationMs:200,interrupted:owner==='ownerA'});
  await call('GET',`/proofs/${proof}/capture-sessions/${id}`,token);
  await call('POST',`/proofs/${proof}/capture-sessions/${id}/complete`,token,{...source,recordedDurationMs:200});
  await call('POST',`/capture-sessions/${id}/seal`,token,{source,segments:[segment],observations,sha256:await manifestDigest(manifest,hash)});
  phase=owner+':upload';
  const upload=await call('POST',`/proofs/${proof}/evidence/uploads`,token,{contentType:'video/mp4',evidenceType:'FULFILLMENT_CAPTURE',captureSessionId:id,byteSize:bytes.length},[200,201]);
  const url=new URL(upload.upload.url,'https://packproof-m1.test:3443');assert.equal(url.hostname,'packproof-m1.test');
  await call('PUT',url.pathname+url.search,token,bytes,[200,201,204],upload.upload.headers);
  phase=owner+':commit';
  await call('POST',`/proofs/${proof}/evidence/${upload.evidenceId}/commit`,token,{});
  await call('POST',`/proofs/${proof}/attestations`,token,{statement:'PACKED_DESCRIBED_ITEM',relatedEvidenceId:upload.evidenceId},[201]);
  phase=owner+':finalize';
  let final;
  for(let n=0;n<40;n++){
   final=await call('POST',`/proofs/${proof}/finalize`,token,{},[200,202]);
   if(final.proof.status==='FINALIZED')break;await delay(1000);
  }
  assert.equal(final.proof.status,'FINALIZED');assert.ok(final.manifest.sha256);
  phase=owner+':export';
  const pkg=await call('GET',`/v1/partner/proofs/${proof}/package`,input.tokens.partner,undefined,[200],headers);
  assert.ok(Buffer.isBuffer(pkg)&&pkg.subarray(0,2).toString()==='PK');
  await writeFile(`runtime-artifacts/${owner}.pkpr`,pkg);
  await writeFile(`runtime-artifacts/${owner}-manifest.json`,final.manifest.canonicalJson);
  report.proofs.push({proofId:proof,captureId:id,evidenceId:upload.evidenceId,manifestSha256:final.manifest.sha256,packageSha256:digest(pkg),packageBytes:pkg.length});
  report.checks.push(`${owner}_operator_scope_capture_retry_upload_attestation_finalize_export`);
 }
 report.status='PASSED';
}catch(e){report.status='FAILED';report.failure={phase,name:e.name,httpStatus:lastStatus,apiCode:lastCode};process.exitCode=1;}
await writeFile('runtime-artifacts/capture-acceptance.json',JSON.stringify(report,null,2)+'\n');
console.log(JSON.stringify(report));
