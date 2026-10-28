/**
 * Node 22+, public HTTPS boundary only. No application/database/domain imports.
 * Uses synthetic staging data and an enrolled operator's real supported capture.
 */
import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import {pathToFileURL} from 'node:url';
import {PackProofClient} from './client.mjs';
import {operations} from './operations.mjs';
import {verifyPackage} from './package-check.mjs';
import {verifyEvent} from '../merchant-adapter.mjs';
const operation=(profile,method,path)=>{
 const entry=Object.entries(operations).find(([id,op])=>id.startsWith(profile+'.')&&op.method===method&&op.path===path);
 if(!entry)throw new Error('Required generated operation is missing: '+method+' '+path);return entry[0];
};
async function boundedBytes(response,maximum=230*1024*1024) {
 assert.ok(response.body,'Response body is required');const reader=response.body.getReader(),parts=[];let size=0;
 try{while(true){const {value,done}=await reader.read();if(done)break;size+=value.length;if(size>maximum)throw new Error('Response exceeds acceptance bound');parts.push(Buffer.from(value));}}catch(e){await reader.cancel().catch(()=>{});throw e;}
 return Buffer.concat(parts,size);
}
export async function runAcceptance(env=process.env,{mode='intake',requireReleaseGates=false,transport=globalThis.fetch}={}) {
 const origin=new URL(env.PACKPROOF_API_ORIGIN??'');assert.equal(origin.protocol,'https:');assert.equal(origin.pathname,'/');assert.ok(!origin.username&&!origin.password&&!origin.search&&!origin.hash,'Use one clean HTTPS origin');
 const metaResponse=await transport(new URL('/meta',origin),{redirect:'error',signal:AbortSignal.timeout(15000)});
 assert.equal(metaResponse.status,200,'Public candidate identity must be readable');const meta=JSON.parse((await boundedBytes(metaResponse,65536)).toString('utf8'));
 assert.ok(['staging','sandbox','test','development'].includes(String(meta.environment).toLowerCase()),'Use an isolated nonproduction deployment');
 if(env.PACKPROOF_EXPECTED_SHA)assert.equal(meta.commit,env.PACKPROOF_EXPECTED_SHA,'Public candidate SHA mismatch');
 const profile=env.PACKPROOF_API_PROFILE??'legacy';assert.ok(['legacy','partner'].includes(profile));
 assert.ok(env.PACKPROOF_API_KEY,'Enrolled staging credential is required');
 const clientOptions={apiOrigin:origin.origin,credential:env.PACKPROOF_API_KEY,merchantId:env.PACKPROOF_MERCHANT_ID,delegationId:env.PACKPROOF_DELEGATION_ID,fetch:transport};
 const client=new PackProofClient(clientOptions),base=profile==='partner'?'/v1/partner':'/v1',idParam=profile==='partner'?'proofId':'id';
 const report={schema:'packproof.external-acceptance/v1',mode,profile,candidate:{environment:meta.environment,commit:meta.commit??null},startedAt:new Date().toISOString(),checks:[],pending:[]};
 const check=(name,detail={})=>report.checks.push({name,status:'passed',...detail});
 if(!env.PACKPROOF_EXPECTED_SHA)report.pending.push('An independently approved exact candidate SHA is required.');
 if(mode==='complete'){
  if(env.PACKPROOF_INTAKE_REPORT){const bytes=await readFile(env.PACKPROOF_INTAKE_REPORT);assert.ok(bytes.length<=65536);const intake=JSON.parse(bytes.toString('utf8'));assert.equal(intake.schema,'packproof.external-acceptance/v1');assert.equal(intake.mode,'intake');assert.equal(intake.profile,profile);assert.equal(intake.candidate.commit,meta.commit);assert.equal(intake.proofId,env.PACKPROOF_COMPLETED_PROOF_ID,'Capture must complete the same accepted canonical root');}
  else report.pending.push('The saved intake report is required to link completion to the same tested canonical root and candidate.');
 }
 const denied=async(name,key,merchantId=env.PACKPROOF_MERCHANT_ID,delegationId=env.PACKPROOF_DELEGATION_ID,proofId)=>{
  const headers={...(key?{Authorization:'Bearer '+key}:{}),...(merchantId?{'PackProof-Merchant-Id':merchantId}:{}),...(delegationId?{'PackProof-Delegation-Id':delegationId}:{})};
  const response=await transport(new URL(base+'/proofs/'+encodeURIComponent(proofId),origin),{headers,redirect:'error',signal:AbortSignal.timeout(15000)});
  await response.body?.cancel();assert.ok([401,403,404].includes(response.status),name+' unexpectedly permitted access');check(name,{statusCode:response.status});
 };
 let proofId=env.PACKPROOF_COMPLETED_PROOF_ID;
 if(mode==='intake'){
  assert.equal(env.PACKPROOF_ACCEPTANCE_SYNTHETIC,'1','Explicit synthetic staging intake is required');
  assert.ok(env.PACKPROOF_ORDER_FILE&&env.PACKPROOF_OPERATION_KEY,'Supply a synthetic order file and persist its operation key');
  const bytes=await readFile(env.PACKPROOF_ORDER_FILE);assert.ok(bytes.length<=65536,'Synthetic order exceeds intake bound');const order=JSON.parse(bytes.toString('utf8'));
  const create=operation(profile,'POST',base+'/proofs'),key=env.PACKPROOF_OPERATION_KEY;
  const results=await Promise.all(Array.from({length:10},(_,i)=>client.request(create,{body:order,key:key+'-race-'+i})));
  const ids=results.map(r=>profile==='partner'?r.proofId:r.proof.proofId);assert.equal(new Set(ids).size,1,'Concurrent intake produced duplicate roots');proofId=ids[0];check('ten concurrent creates yield one canonical root',{proofId});
  const replay1=await client.request(create,{body:order,key:key+'-replay'}),replay2=await client.request(create,{body:order,key:key+'-replay'});
  assert.deepEqual(replay2,replay1);check('identical key and payload replay committed result');
  const conflict={...order,transaction:{...order.transaction,itemTitle:'Deliberately conflicting synthetic content'}};
  await assert.rejects(client.request(create,{body:conflict,key:key+'-new-conflict'}),e=>e.status===409&&e.code==='EXTERNAL_ID_CONFLICT');check('changed order content preserves external identity conflict');
  await assert.rejects(client.request(create,{body:conflict,key:key+'-replay'}),e=>e.status===409&&e.code==='IDEMPOTENCY_CONFLICT');check('changed replay payload rejects idempotency conflict');
  report.pending.push('An enrolled operator must open the canonical Proof, record through supported WEB/ANDROID capture, review and deliberately confirm. Repeat with mode complete and independently retained source/manifest SHA-256 pins.');
 }else{
  assert.equal(mode,'complete');assert.ok(proofId,'Supply the same genuinely completed operator Proof');
  const expectedManifestSha256=env.PACKPROOF_EXPECTED_MANIFEST_SHA256,expectedSourceSha256=env.PACKPROOF_EXPECTED_SOURCE_SHA256;
  assert.match(expectedManifestSha256??'',/^[a-f0-9]{64}$/,'Retain manifest digest independently');assert.match(expectedSourceSha256??'',/^[a-f0-9]{64}$/,'Retain source digest independently');
  const envelope=await client.request(operation(profile,'GET',base+'/proofs/{'+idParam+'}'),{path:{[idParam]:proofId}});
  assert.equal(envelope.proof.proofId,proofId);assert.equal(envelope.proof.status,'FINALIZED');assert.equal(envelope.proof.integrity.manifestSha256,expectedManifestSha256);
  assert.ok(envelope.proof.evidence.some(e=>e.validationStatus==='COMMITTED'&&e.sha256===expectedSourceSha256));check('API finalized root and original match independent pins',{proofId});
  const search=await client.request(operation(profile,'GET',base+'/proofs/search'),{query:{q:proofId,state:'READY',limit:50}});
  assert.ok(search.proofs.some(row=>row.proofId===proofId&&row.readiness.state==='READY'&&row.readiness.preserved===true),'Finalized status alone must not count as preserved readiness');check('search requires durable preservation readiness');
  {
   const receipts=await client.request(operation(profile,'GET',base+'/proofs/{'+idParam+'}/recovery'),{path:{[idParam]:proofId}});
   assert.equal(receipts.finalization.status,'PRESERVED');assert.ok(receipts.finalization.receipt);
   assert.ok(receipts.evidence.length>0&&receipts.evidence.every(x=>x.status==='PRESERVED'&&x.receipt));assert.ok(receipts.declarations.length>0&&receipts.declarations.every(x=>x.status==='PRESERVED'&&x.receipt));check('authoritative evidence declaration and finalization receipts');
  }
  if(profile==='partner'){
   const bindings=new Set();let bindingCursor;let bindingsComplete=false;let hasOrder=false;
   for(let page=0;page<20;page++){
    const current=await client.request('partner.listPartnerProofBindings',{path:{proofId},query:{limit:100,...(bindingCursor?{after:bindingCursor}:{})}});
    assert.equal(current.schema,'packproof.external-bindings/v1');assert.equal(current.proofId,proofId);assert.equal(current.consistency,'LIVE_KEYSET_RESTART_ON_CHANGE');
    for(const binding of current.bindings){const key=JSON.stringify([binding.integrationAccountId,binding.resourceType,binding.externalId]);assert.ok(!bindings.has(key),'Current binding listing repeated an identity');bindings.add(key);assert.ok(Number.isFinite(Date.parse(binding.createdAt)));if(binding.resourceType==='ORDER')hasOrder=true;}
    if(!current.hasMore){assert.equal(current.nextCursor,null);bindingsComplete=true;break;}assert.ok(current.nextCursor);bindingCursor=current.nextCursor;
   }
   assert.ok(bindingsComplete&&hasOrder,'Current authorized binding listing did not finish within its explicit bound');check('current paginated order binding resolves same canonical Proof',{bindingCount:bindings.size});
  }
  if(profile==='partner'){
   const snapshot=await client.request('partner.createProofSnapshot',{body:{pageSize:100}});const seen=new Set();let cursor;let foundRoot=false;
   try{
    for(let page=0;page<100;page++){
     const rows=await client.request('partner.getProofSnapshot',{path:{snapshotId:snapshot.snapshotId},query:cursor?{after:cursor}:{}});
     assert.equal(rows.snapshotId,snapshot.snapshotId);assert.equal(rows.eventCursor,snapshot.eventCursor);
     for(const row of rows.proofs){assert.ok(!seen.has(row.proofId),'Snapshot repeated a canonical root');seen.add(row.proofId);if(row.proofId===proofId){assert.equal(row.manifestSha256,expectedManifestSha256);foundRoot=true;}}
     if(!rows.hasMore){assert.equal(seen.size,snapshot.rowCount);break;}assert.ok(rows.nextCursor);cursor=rows.nextCursor;
    }
    assert.ok(foundRoot,'Completed root absent from authorized reconciliation snapshot');
    const changes=await client.request(operation(profile,'GET',base+'/event-stream'),{query:{after:snapshot.eventCursor,limit:100}});
    assert.ok(Array.isArray(changes.events));check('stable materialized snapshot pages join commit-safe feed',{rowCount:seen.size});
   }finally{await client.request('partner.releaseProofSnapshot',{path:{snapshotId:snapshot.snapshotId}});}
  }
  const response=await client.request(operation(profile,'GET',base+'/proofs/{'+idParam+'}/package'),{path:{[idParam]:proofId},stream:true,signal:AbortSignal.timeout(120000)});
  assert.match(response.headers.get('Content-Type')??'',/application\/zip/);
  const bytes=await boundedBytes(response),verified=verifyPackage(bytes,{expectedManifestSha256,expectedProofId:proofId,expectedSourceSha256});
  const tampered=Buffer.from(bytes);assert.ok(verified.tamperRange.end>verified.tamperRange.start);tampered[verified.tamperRange.start]^=1;
  assert.throws(()=>verifyPackage(tampered,{expectedManifestSha256,expectedProofId:proofId,expectedSourceSha256}));check('complete package originals verify and altered source is rejected',{packageSha256:verified.packageSha256,entryCount:verified.entryCount});
  let after=env.PACKPROOF_EVENT_CURSOR,finalizedEvent;
  for(let page=0;page<50;page++){
   const events=await client.request(operation(profile,'GET',base+'/event-stream'),{query:{...(after?{after}:{}),limit:100}});
   finalizedEvent=events.events.find(e=>e.type==='proof.finalized'&&e.data?.proofId===proofId)??finalizedEvent;after=events.nextCursor;if(!events.hasMore)break;
  }
  assert.ok(finalizedEvent,'Finalized event absent from bounded feed catch-up');check('commit-safe feed exposes finalization',{eventId:finalizedEvent.id});
  if(env.PACKPROOF_WEBHOOK_SECRET&&env.PACKPROOF_WEBHOOK_BODY_FILE&&env.PACKPROOF_WEBHOOK_SIGNATURE){
   const raw=await readFile(env.PACKPROOF_WEBHOOK_BODY_FILE);assert.ok(raw.length<=65536);const received=env.PACKPROOF_WEBHOOK_RECEIVED_AT_SECONDS?Number(env.PACKPROOF_WEBHOOK_RECEIVED_AT_SECONDS):Math.floor(Date.now()/1000);assert.ok(Number.isSafeInteger(received));
   assert.ok(verifyEvent(env.PACKPROOF_WEBHOOK_SECRET,env.PACKPROOF_WEBHOOK_SIGNATURE,raw,received),'Receiver signature must authenticate exact original body');
   const event=JSON.parse(raw.toString('utf8'));assert.equal(event.id,finalizedEvent.id);assert.equal(event.data?.proofId,proofId);assert.equal(event.type,'proof.finalized');
   assert.equal(verifyEvent(env.PACKPROOF_WEBHOOK_SECRET,env.PACKPROOF_WEBHOOK_SIGNATURE,Buffer.concat([raw,Buffer.from(' ')]),received),false);
   assert.equal(verifyEvent(env.PACKPROOF_WEBHOOK_SECRET,env.PACKPROOF_WEBHOOK_SIGNATURE,raw,received+601),false);check('received raw webhook matches event and rejects altered/stale signatures',{eventId:event.id});
  }else report.pending.push('Actual receiver raw body, signature, receipt time and trusted secret are required to qualify signed event delivery.');
 }
 await denied('unauthenticated object read',null,undefined,undefined,proofId);
 if(env.PACKPROOF_OTHER_API_KEY)await denied('cross-merchant credential object read',env.PACKPROOF_OTHER_API_KEY,env.PACKPROOF_OTHER_MERCHANT_ID,env.PACKPROOF_OTHER_DELEGATION_ID,proofId);
 else report.pending.push('Separate merchant credential required for cross-merchant denial.');
 if(env.PACKPROOF_REVOKED_API_KEY)await denied('revoked credential object read',env.PACKPROOF_REVOKED_API_KEY,env.PACKPROOF_REVOKED_MERCHANT_ID,env.PACKPROOF_REVOKED_DELEGATION_ID,proofId);
 else report.pending.push('Previously revoked staging credential required for revocation denial.');
 if(profile==='partner'){
  const response=await transport(new URL(base+'/proofs/'+encodeURIComponent(proofId)+'/attestations',origin),{method:'POST',headers:{Authorization:'Bearer '+env.PACKPROOF_API_KEY,'Content-Type':'application/json','PackProof-Merchant-Id':env.PACKPROOF_MERCHANT_ID??'',...(env.PACKPROOF_DELEGATION_ID?{'PackProof-Delegation-Id':env.PACKPROOF_DELEGATION_ID}:{})},body:'{}',redirect:'error',signal:AbortSignal.timeout(15000)});
  await response.body?.cancel();assert.ok([403,404].includes(response.status));check('service credential cannot submit human attestation');
 }
 report.proofId=proofId;report.finishedAt=new Date().toISOString();report.qualified=mode==='complete'&&report.pending.length===0;
 if(requireReleaseGates&&!report.qualified)throw Object.assign(new Error('External qualification has unresolved gates'),{report});
 return report;
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
 let report;
 try{report=await runAcceptance(process.env,{mode:process.argv[2]??'intake',requireReleaseGates:process.argv.includes('--require-release-gates')});}
 catch(error){report=error.report??{schema:'packproof.external-acceptance/v1',qualified:false,error:'Acceptance failed. Inspect configured expected values; credentials and raw payloads are not printed.',errorCode:typeof error.code==='string'?error.code:undefined,statusCode:typeof error.status==='number'?error.status:undefined,requestId:typeof error.requestId==='string'?error.requestId:undefined};process.exitCode=1;}
 if(process.env.PACKPROOF_ACCEPTANCE_REPORT)await writeFile(process.env.PACKPROOF_ACCEPTANCE_REPORT,JSON.stringify(report,null,2)+'\n',{mode:0o600});
 console.log(JSON.stringify(report,null,2));
}
