import { beforeAll,afterAll,describe,it,expect } from 'vitest';
import { generateKeyPairSync,sign } from 'node:crypto';
import { readFile,writeFile,mkdtemp,rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHarness,createUser,commitFulfillmentAndAttest,commitProofEvidence,type TestHarness } from './helpers.js';
import { createTransaction } from '../src/domain/transactions.js';
import { createOrGetProof } from '../src/domain/create-proof.js';
import { finalizeProof } from '../src/domain/finalize.js';
import { createCaptureSession,completeCaptureSession } from '../src/domain/capture-sessions.js';
import { initializeEvidenceUpload,commitEvidence } from '../src/domain/evidence.js';
import { sha256Hex } from '../src/hash.js';
import { enabledResearchConfig,rndConfigFromEnv } from '../src/rnd/config.js';
import { recordConsent,issueIntent,startIntent,closeIntent,issueLiveChallenge } from '../src/rnd/capture.js';
import { requestAnalysis,leaseAnalysis,completeAnalysis,failAnalysis,getAnalysis,runRndWorkerOnce } from '../src/rnd/analyses.js';
import { researchBundle,reviewDerivative,exportDerivativeZip,artifactFor } from '../src/rnd/exports.js';
import { collectSmallZip } from '../src/export/zip-stream.js';
import { recordParticipantShipmentEvent } from '../src/domain/shipment-events.js';
import { executeVision,shipmentObservations } from '../src/rnd/worker.js';
import { addAnnotation,listAnnotations } from '../src/rnd/annotations.js';
import { rndMetrics,retryResearchAnalysis } from '../src/rnd/operations.js';
import type { RndDeps } from '../src/rnd/types.js';
import type { ManifestSigningRuntime } from '../src/integrity/signing-runtime.js';

describe('research evidence boundary',()=>{
 let h:TestHarness,deps:RndDeps,seller:string,outsider:string;let now=Date.parse('2026-10-02T10:00:00Z');
 const {privateKey,publicKey}=generateKeyPairSync('ec',{namedCurve:'prime256v1'});
 const signing:ManifestSigningRuntime={publicStatus:{mode:'SIGNED',algorithm:'ECDSA_SHA_256',keyId:'research-test-key',required:true,trustListSha256:null},trustList:{schema:'packproof.trust-list.v1',generatedAt:'2026-01-01T00:00:00Z',expiresAt:'2027-01-01T00:00:00Z',keys:[{keyId:'research-test-key',algorithm:'ECDSA_SHA_256',status:'ACTIVE',publicKeyPem:publicKey.export({type:'spki',format:'pem'}).toString()}]},signer:{async signManifest(i){return {algorithm:'ECDSA_SHA_256',keyId:'research-test-key',signedAt:new Date(now).toISOString(),signatureBase64:sign('sha256',Buffer.from(i.canonicalJson),privateKey).toString('base64')};}}};
 beforeAll(async()=>{h=await createHarness({now:()=>new Date(now)},{manifestSigning:signing});seller=await createUser(h);outsider=await createUser(h);deps={...h,rnd:enabledResearchConfig(),manifestSigning:signing};},30000);
 afterAll(async()=>h?.close());
 async function proof(finalize=true){const txn=await createTransaction(h.db,h.clock,seller,{itemTitle:'R&D synthetic fixture'});const p=await createOrGetProof(h.db,h.clock,seller,txn.transactionId);await recordConsent(deps,seller,p.proofId,'consent',{purpose:'EXPERIMENTAL_ANALYSIS',version:'packproof.research-consent.v1',granted:true});if(!finalize)return {id:p.proofId,evidenceId:''};const e=await commitFulfillmentAndAttest(h,seller,p.proofId);await finalizeProof(h.db,h.clock,seller,p.proofId,signing.signer);return {id:p.proofId,evidenceId:e.evidenceId};}
 it('defaults every feature off and prohibits customer qualification by flag',()=>{
  expect(rndConfigFromEnv({}).enabled).toBe(false);expect(rndConfigFromEnv({}).killSwitch).toBe(true);
  expect(()=>rndConfigFromEnv({PACKPROOF_ENV:'research',PACKPROOF_RND_ENABLED:'1',PACKPROOF_RND_KILL_SWITCH:'0',PACKPROOF_RND_PROOFPRINT_CUSTOMER_DISPLAY:'1'})).toThrow(/qualification/);
 });
 it('rejects cross-proof sources, forged outcomes, conflicting idempotency and wrong actor',async()=>{
  const a=await proof(),b=await proof();
  const input={feature:'proofpilot',evidenceIds:[a.evidenceId]};
  const first=await requestAnalysis(deps,seller,a.id,'analysis',input);
  expect(await requestAnalysis(deps,seller,a.id,'analysis',input)).toEqual(first);
  await expect(requestAnalysis(deps,seller,a.id,'analysis',{...input,scope:'changed'})).rejects.toMatchObject({code:'RND_IDEMPOTENCY_CONFLICT'});
  await expect(requestAnalysis(deps,seller,a.id,'wrong-source',{...input,evidenceIds:[b.evidenceId]})).rejects.toMatchObject({code:'RND_SOURCE_FORBIDDEN'});
  await expect(requestAnalysis(deps,outsider,a.id,'attacker',input)).rejects.toMatchObject({code:'PARTICIPANT_NOT_AUTHORIZED'});
  await expect(requestAnalysis(deps,seller,a.id,'verdict',{...input,findingState:'CONSISTENT'})).rejects.toMatchObject({code:'RND_INVALID_INPUT'});
  await expect(getAnalysis(deps,outsider,first.analysisId)).rejects.toMatchObject({code:'PARTICIPANT_NOT_AUTHORIZED'});
  // Clear the queued fixture without manufacturing any finding.
  const leased=await leaseAnalysis(deps);expect(leased).not.toBeNull();
  await completeAnalysis(deps,leased!,{findingState:'NOT_CHECKED',observations:[],coverage:{},limitations:['Fixture only']},'a'.repeat(64));
 });
 it('preserves signed root and serializes append-only extension chains under duplicate delivery',async()=>{
  const p=await proof();const before=(await h.db.query<{sha256:string}>('SELECT sha256 FROM final_manifests WHERE proof_id=$1',[p.id])).rows[0].sha256;
  await requestAnalysis(deps,seller,p.id,'one',{feature:'verifiedcapture',evidenceIds:[p.evidenceId]});
  await requestAnalysis(deps,seller,p.id,'two',{feature:'proofpilot',evidenceIds:[p.evidenceId]});
  const first=await leaseAnalysis(deps),second=await leaseAnalysis(deps);
  const result={findingState:'NOT_CHECKED' as const,observations:[],coverage:{},limitations:['No observations']};
  await Promise.all([completeAnalysis(deps,first!,result,'a'.repeat(64)),completeAnalysis(deps,second!,result,'b'.repeat(64))]);
  const rows=(await h.db.query<{sequence:number;digest:string;previous_digest:string|null}>('SELECT * FROM rnd_extensions WHERE proof_id=$1 ORDER BY sequence',[p.id])).rows;
  expect(rows.map(r=>r.sequence)).toEqual([1,2]);expect(rows[1].previous_digest).toBe(rows[0].digest);
  await expect(completeAnalysis(deps,first!,result,'a'.repeat(64))).rejects.toMatchObject({code:'RND_LEASE_LOST'});
  await expect(h.db.query("UPDATE rnd_extensions SET digest=$2 WHERE proof_id=$1",[p.id,'c'.repeat(64)])).rejects.toThrow(/IMMUTABLE/);
  expect((await h.db.query<{sha256:string}>('SELECT sha256 FROM final_manifests WHERE proof_id=$1',[p.id])).rows[0].sha256).toBe(before);
  expect((await researchBundle(deps,seller,p.id)).extensions).toHaveLength(2);
 });
 it('leases recover after worker loss and exhausted processing is failed without a difference finding',async()=>{
  const p=await proof();await requestAnalysis(deps,seller,p.id,'lease',{feature:'proofpilot',evidenceIds:[p.evidenceId]});
  const first=await leaseAnalysis(deps);now+=91_000;const second=await leaseAnalysis(deps);expect(second?.lease_token).not.toBe(first?.lease_token);
  await expect(completeAnalysis(deps,first!,{findingState:'RECORDED',observations:[],coverage:{},limitations:[]},'a'.repeat(64))).rejects.toMatchObject({code:'RND_LEASE_LOST'});
  now+=91_000;const third=await leaseAnalysis(deps);await failAnalysis(deps,third!,'RND_WORKER_TIMEOUT');
  const result=await getAnalysis(deps,seller,third!.id);expect(result.operationalState).toBe('FAILED');expect(result.findingState).toBe('NOT_CHECKED');
 });
 it('keeps attributed corrections immutable and exports exact signed statements',async()=>{
  const p=await proof(),job=await requestAnalysis(deps,seller,p.id,'annotated',{feature:'proofpilot',evidenceIds:[p.evidenceId]});
  await runRndWorkerOnce(deps,async()=>({findingState:'NOT_CHECKED',observations:[],coverage:{},limitations:['Fixture only']}));
  const input={analysisId:job.analysisId,sourceId:p.evidenceId,text:'I observed the seam remaining closed.',interval:{startMs:0,endMs:100}};
  const first=await addAnnotation(deps,seller,p.id,'note',input);expect(first.annotation.attribution).toBe('PARTICIPANT_STATEMENT');
  expect(await addAnnotation(deps,seller,p.id,'note',input)).toEqual(first);
  await expect(addAnnotation(deps,outsider,p.id,'unauthorized',input)).rejects.toMatchObject({code:'PARTICIPANT_NOT_AUTHORIZED'});
  await expect(addAnnotation(deps,seller,p.id,'wrong-source',{...input,sourceId:'unrelated'})).rejects.toMatchObject({code:'RND_ANNOTATION_SOURCE'});
  await addAnnotation(deps,seller,p.id,'corrected',{...input,text:'The seam is partially occluded.',supersedesId:first.annotation.annotationId});
  await expect(h.db.query('DELETE FROM rnd_annotations WHERE proof_id=$1',[p.id])).rejects.toThrow(/IMMUTABLE/);
  const exported=await researchBundle(deps,seller,p.id);expect(exported.annotations).toHaveLength(2);expect((await listAnnotations(deps,seller,p.id)).annotations).toHaveLength(2);
 });
 it('requires admin for retry and metrics and retains the failed historical result',async()=>{
  const p=await proof(),job=await requestAnalysis(deps,seller,p.id,'deadletter',{feature:'proofpilot',evidenceIds:[p.evidenceId]});
  const leased=await leaseAnalysis(deps);await failAnalysis(deps,{...leased!,attempts:3},'RND_WORKER_TIMEOUT');
  await expect(rndMetrics(deps,seller)).rejects.toThrow();
  await h.db.query("INSERT INTO user_system_roles(user_id,role,granted_at,granted_by) VALUES($1,'SYSTEM_ADMIN',$2,$1)",[outsider,h.clock.now().toISOString()]);
  const retried=await retryResearchAnalysis(deps,outsider,job.analysisId,'retry',{reason:'Configured isolated worker restored'});
  expect(retried.analysisId).not.toBe(job.analysisId);expect(await retryResearchAnalysis(deps,outsider,job.analysisId,'retry',{reason:'Configured isolated worker restored'})).toEqual(retried);
  expect((await getAnalysis(deps,seller,job.analysisId)).operationalState).toBe('FAILED');expect((await rndMetrics(deps,outsider)).rows.length).toBeGreaterThan(0);
  await runRndWorkerOnce(deps,async()=>({findingState:'NOT_CHECKED',observations:[],coverage:{},limitations:[]}));
 });
 it('adapts immutable participant mass and tracking reports only to explicitly bound sources',async()=>{
  const p=await proof(false),evidence=await commitFulfillmentAndAttest(h,seller,p.id);p.evidenceId=evidence.evidenceId;
  const transactionId=(await h.db.query<{transaction_id:string}>('SELECT transaction_id FROM proofs WHERE id=$1',[p.id])).rows[0].transaction_id;
  for(const [sourceEventId,eventData] of Object.entries({bound:{evidenceId:p.evidenceId,weight:{value:1.25,unit:'kg'},trackingNumber:'LOCAL-TEST-123'},unbound:{weight:{value:9,unit:'kg'},trackingNumber:'UNBOUND'}}))await recordParticipantShipmentEvent(h.db,h.clock,seller,transactionId,{eventType:'WEIGHT_RECORDED',occurredAt:h.clock.now().toISOString(),sourceEventId,eventData});
  await finalizeProof(h.db,h.clock,seller,p.id,signing.signer);const job=await requestAnalysis(deps,seller,p.id,'report-adapter',{feature:'verifiedcapture',evidenceIds:[p.evidenceId]});
  const row=(await h.db.query<any>('SELECT * FROM rnd_analyses WHERE id=$1',[job.analysisId])).rows[0],adapted=await shipmentObservations(deps,row);
  expect(adapted).toHaveLength(2);expect(adapted.find(o=>o.channel==='weight')).toMatchObject({attribution:'PARTICIPANT_STATEMENT',value:{grams:1250,measurementAssurance:'UNVERIFIED_REPORT'}});
  expect(JSON.stringify(adapted)).not.toContain('UNBOUND');await runRndWorkerOnce(deps);
 });
 it('binds fresh intent once and verifies committed bytes without upgrading offline or absent attestation',async()=>{
  const p=await proof(false);
  const issued=await issueIntent(deps,seller,p.id,'intent',{legId:'OUTBOUND',acquisitionMode:'ONLINE',profileId:'test'});
  const cap=await createCaptureSession(h.db,h.clock,seller,p.id,{client:'NATIVE_CAMERA',idempotencyKey:'cap'});
  const start={nonce:issued.intent.nonce,captureSessionId:cap.id};
  await startIntent(deps,seller,p.id,issued.intent.id,'start',start);
  expect(await startIntent(deps,seller,p.id,issued.intent.id,'retry',start)).toMatchObject({state:'STARTED'});
  await expect(startIntent(deps,seller,p.id,issued.intent.id,'bad',{...start,nonce:'bad'})).rejects.toMatchObject({code:'RND_INTENT_FORBIDDEN'});
  await expect(issueLiveChallenge(deps,seller,p.id,'unsafe',{intentId:issued.intent.id,mode:'TORCH'})).rejects.toMatchObject({code:'RND_SAFETY_PROFILE_UNQUALIFIED'});
  const bytes=await readFile(new URL('./fixtures/camera-recording.mp4',import.meta.url));
  await completeCaptureSession(h.db,h.clock,seller,p.id,cap.id,{sha256:sha256Hex(bytes),byteSize:bytes.length,contentType:'video/mp4'});
  const upload=await initializeEvidenceUpload(h.db,h.clock,h.objectStore,seller,p.id,{contentType:'video/mp4',evidenceType:'FULFILLMENT_CAPTURE',captureSessionId:cap.id,idempotencyKey:'upload'});
  await h.objectStore.put(upload.objectKey,bytes,'video/mp4');const e=await commitEvidence(h.db,h.clock,h.objectStore,seller,p.id,upload.evidenceId,sha256Hex(bytes));
  const closed=await closeIntent(deps,seller,p.id,issued.intent.id,'close',{evidenceIds:[e.evidenceId]});
  expect(closed.receipt.assurance).toMatchObject({chainCoverage:'FINAL_FILE_ONLY',appAttestation:'UNSUPPORTED'});
  const expired=await issueIntent(deps,seller,p.id,'expire',{legId:'OUTBOUND',acquisitionMode:'ONLINE',profileId:'test'});
  now+=301_000;
  await expect(startIntent(deps,seller,p.id,expired.intent.id,'expired',{nonce:expired.intent.nonce,captureSessionId:cap.id})).rejects.toMatchObject({code:'RND_INTENT_EXPIRED'});
 });
 it('executes actual Python analysis against committed bytes and persists source-linked output',async()=>{
  const p=await proof();deps.rnd!.worker={python:process.env.PACKPROOF_RND_TEST_VISION_PYTHON??'/tmp/packproof-vision-venv/bin/python',script:new URL('../../research/vision/worker.py',import.meta.url).pathname,timeoutMs:60000,maxInputBytes:128*1024*1024};
  const job=await requestAnalysis(deps,seller,p.id,'python',{feature:'proofpilot',evidenceIds:[p.evidenceId]});
  expect(await runRndWorkerOnce(deps)).toEqual({state:'SUCCEEDED',analysisId:job.analysisId});
  const result=await getAnalysis(deps,seller,job.analysisId);expect(result.operationalState).toBe('SUCCEEDED');expect(result.result).toMatchObject({schemaVersion:'packproof.analysis.v1',feature:'proofpilot'});
  const details=result.result?.details as {observations:{sourceRefs:unknown[]}[]};expect(details.observations.length).toBeGreaterThan(0);expect(details.observations[0].sourceRefs.length).toBeGreaterThan(0);
 },90000);
 it('creates actual opaque derivative, rejects altered approval, and omits originals from reviewed export',async()=>{
  const p=await proof(false),png=await readFile(new URL('./fixtures/rnd-mask-source.png',import.meta.url));
  const image=await commitProofEvidence(h,seller,p.id,{contentType:'image/png',bytes:png,idempotencyKey:'privacy-image'});
  await commitFulfillmentAndAttest(h,seller,p.id);await finalizeProof(h.db,h.clock,seller,p.id,signing.signer);
  deps.rnd!.worker={python:process.env.PACKPROOF_RND_TEST_PRIVACY_PYTHON??'/tmp/packproof-privacy-venv/bin/python',script:new URL('../../research/vision/worker.py',import.meta.url).pathname,timeoutMs:60000,maxInputBytes:128*1024*1024};
  const job=await requestAnalysis(deps,seller,p.id,'redact',{feature:'proofshield',evidenceIds:[image.evidenceId],parameters:{kind:'still',masks:[{x:0,y:0,width:12,height:12}]}});
  expect(await runRndWorkerOnce(deps)).toMatchObject({state:'SUCCEEDED'});
  const artifact=await artifactFor(deps,seller,p.id,job.analysisId,0);
  expect(artifact.bytes.body.equals(png)).toBe(false);
  await expect(exportDerivativeZip(deps,seller,p.id,job.analysisId)).rejects.toMatchObject({code:'RND_PRIVACY_REVIEW_REQUIRED'});
  const details=artifact.row.result_json!.details as {observations:{record:{derivativeSha256:string;recipeSha256:string}}[]};const record=details.observations[0].record;
  await expect(reviewDerivative(deps,seller,p.id,job.analysisId,'wrong-review',{approved:true,artifactSha256:'a'.repeat(64),recipeSha256:record.recipeSha256})).rejects.toMatchObject({code:'RND_REVIEW_BINDING'});
  await reviewDerivative(deps,seller,p.id,job.analysisId,'review',{approved:true,artifactSha256:record.derivativeSha256,recipeSha256:record.recipeSha256});
  const zip=await collectSmallZip(await exportDerivativeZip(deps,seller,p.id,job.analysisId));
  expect(zip.includes(Buffer.from('redacted.png'))).toBe(true);expect(zip.includes(png)).toBe(false);expect(zip.includes(Buffer.from('originals/'))).toBe(false);
  deps.rnd!.features.proofshield.internalDisplay=false;
  await expect(researchBundle(deps,seller,p.id)).rejects.toMatchObject({code:'RND_DISABLED'});deps.rnd!.features.proofshield.internalDisplay=true;
 },90000);
 it('appends actual private log inclusion with durable retry binding and no invented independent witnesses',async()=>{
  const directory=await mkdtemp(path.join(tmpdir(),'rnd-witness-test-'));
  try{
   const key=generateKeyPairSync('ed25519'),publicPem=key.publicKey.export({format:'pem',type:'spki'}).toString();
   const raw=key.publicKey.export({format:'der',type:'spki'}).subarray(-32),keyId=sha256Hex(raw);
   const keyFile=path.join(directory,'log.pem'),policyFile=path.join(directory,'policy.json');
   await writeFile(keyFile,key.privateKey.export({format:'pem',type:'pkcs8'}),{mode:0o600});
   await writeFile(policyFile,JSON.stringify({schemaVersion:'packproof.witness-trust.v1',policyId:'private-log-test-v1',logId:'private-test-log',testOnly:true,requiredOperators:[],logKeys:{[keyId]:{keyId,publicKeyPem:publicPem,revoked:false}},witnessKeys:{}}));
   deps.rnd!.witness={python:process.env.PACKPROOF_RND_TEST_PRIVACY_PYTHON??'/tmp/packproof-privacy-venv/bin/python',script:new URL('../../research/witness/witness.py',import.meta.url).pathname,logDb:path.join(directory,'log.sqlite'),logKey:keyFile,logId:'private-test-log',trustPolicyFile:policyFile};
   const p=await proof(),job=await requestAnalysis(deps,seller,p.id,'witness',{feature:'proofwitness',evidenceIds:[p.evidenceId]});
   const outcome=await runRndWorkerOnce(deps);expect(outcome).toEqual({state:'SUCCEEDED',analysisId:job.analysisId});
   const result=await getAnalysis(deps,seller,job.analysisId),details=result.result!.details as {observations:{verification:Record<string,unknown>}[]};
   expect(details.observations[0].verification).toMatchObject({valid:true,publicationState:'INCLUDED',independentOperatorCount:0});
   const witnessKeys:Record<string,unknown>={},operators:{operatorId:string;keyFile:string;stateDb:string}[]=[];
   for(const operatorId of ['controlled-a','controlled-b']){
    const pair=generateKeyPairSync('ed25519'),keyId=sha256Hex(pair.publicKey.export({format:'der',type:'spki'}).subarray(-32));
    const file=path.join(directory,`${operatorId}.pem`);await writeFile(file,pair.privateKey.export({format:'pem',type:'pkcs8'}),{mode:0o600});
    witnessKeys[keyId]={keyId,publicKeyPem:pair.publicKey.export({format:'pem',type:'spki'}).toString(),operatorId,testOnly:true,independent:false,revoked:false};operators.push({operatorId,keyFile:file,stateDb:path.join(directory,`${operatorId}.sqlite`)});
   }
   await writeFile(policyFile,JSON.stringify({schemaVersion:'packproof.witness-trust.v1',policyId:'controlled-witness-test-v1',logId:'private-test-log',testOnly:true,requiredOperators:operators.map(o=>o.operatorId),logKeys:{[keyId]:{keyId,publicKeyPem:publicPem,revoked:false}},witnessKeys}));deps.rnd!.witness.operators=operators;
   for(const scope of ['controlled-first','controlled-second']){
    const next=await requestAnalysis(deps,seller,p.id,scope,{feature:'proofwitness',scope,evidenceIds:[p.evidenceId]});
    expect(await runRndWorkerOnce(deps)).toMatchObject({state:'SUCCEEDED',analysisId:next.analysisId});
    const done=await getAnalysis(deps,seller,next.analysisId),observations=(done.result!.details as any).observations;
    expect(observations[0].verification).toMatchObject({valid:true,assurance:'TEST_WITNESSED',independentOperatorCount:0});expect(observations[0].receipt.witnessSignatures).toHaveLength(2);
    if(scope==='controlled-second')expect(observations[0].receipt.consistencyLinks).toHaveLength(2);
    const stored=(await deps.db.query<any>('SELECT * FROM rnd_analyses WHERE id=$1',[next.analysisId])).rows[0];
    const repeat=await executeVision(deps,stored);expect((repeat.observations[0].receipt as any).leafIndex).toBe(observations[0].receipt.leafIndex);
   }
   const metrics=await rndMetrics(deps,outsider);
   expect(metrics.witness.latestCheckpoints).toEqual(expect.arrayContaining([expect.objectContaining({policyId:'controlled-witness-test-v1',controlledSignatureCount:2,independentOperatorCount:0,assurance:'TEST_WITNESSED',checkpointAgeMs:expect.any(Number)})]));
   expect(JSON.stringify(metrics.witness)).not.toContain('blind');expect(JSON.stringify(metrics.witness)).not.toContain(directory);
   await requestAnalysis(deps,seller,p.id,'operator-outage',{feature:'proofwitness',scope:'operator-outage',evidenceIds:[p.evidenceId]});
   const failed=await leaseAnalysis(deps);deps.rnd!.witness.operators![0].keyFile=path.join(directory,'unavailable-operator.pem');
   await expect(executeVision(deps,failed!)).rejects.toMatchObject({code:'RND_WITNESS_OPERATOR_FAILED'});
   await failAnalysis(deps,{...failed!,attempts:failed!.max_attempts},'RND_WITNESS_OPERATOR_FAILED');
   expect((await rndMetrics(deps,outsider)).witness).toMatchObject({health:'NEEDS_ATTENTION',attentionErrorsLast24Hours:[{code:'RND_WITNESS_OPERATOR_FAILED',jobs:1,stage:'OPERATOR'}]});
  } finally {await rm(directory,{recursive:true,force:true});}
 },90000);
 it('serializes per-tenant admission across proofs while original idempotent requests remain readable',async()=>{
  const a=await proof(),b=await proof();let first:any;
  for(let n=0;n<31;n++){const created=await requestAnalysis(deps,seller,a.id,`budget-${n}`,{feature:'verifiedcapture',scope:`budget-${n}`,evidenceIds:[a.evidenceId]});if(n===0)first=created;}
  const outcomes=await Promise.allSettled([requestAnalysis(deps,seller,a.id,'last-a',{feature:'verifiedcapture',scope:'last-a',evidenceIds:[a.evidenceId]}),requestAnalysis(deps,seller,b.id,'last-b',{feature:'verifiedcapture',scope:'last-b',evidenceIds:[b.evidenceId]})]);
  expect(outcomes.filter(o=>o.status==='fulfilled')).toHaveLength(1);expect((outcomes.find(o=>o.status==='rejected') as PromiseRejectedResult).reason).toMatchObject({code:'RND_ADMISSION_LIMIT'});
  expect(await requestAnalysis(deps,seller,a.id,'budget-0',{feature:'verifiedcapture',scope:'budget-0',evidenceIds:[a.evidenceId]})).toEqual(first);
 });

});
