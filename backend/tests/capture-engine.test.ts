import {beforeAll,afterAll,describe,it,expect} from 'vitest';
import request from 'supertest';
import {readFile} from 'node:fs/promises';
import {createHarness,createUser,auth,type TestHarness} from './helpers.js';
import {sha256Hex} from '../src/hash.js';
import {issueIntent,bindIntent,sealCapture,verifySegmentStream,receiveBatch,recoverIntentContext} from '../src/capture/service.js';
import {CAPTURE_SCHEMA,CORE_VERSION,POLICY,canonical,createManifest,manifestDigest,chainSegment,transition,guidance,evaluate,type CaptureContext,type Observation,type CapabilitySnapshot} from '../src/capture/core.js';
import {completeCaptureSession} from '../src/domain/capture-sessions.js';
import {initializeEvidenceUpload,commitEvidence} from '../src/domain/evidence.js';
import {commitAttestation} from '../src/domain/attestations.js';
import {finalizeProof} from '../src/domain/finalize.js';
const hash=async(s:string)=>sha256Hex(s);
const capabilities:CapabilitySnapshot={surface:'WEB',cameraSource:'UNKNOWN',timing:'MONOTONIC',barcode:false,itemVisibility:false,durableJournal:true,incrementalMedia:true,audio:false,deviceAuthentication:'UNAVAILABLE',appIntegrity:'UNAVAILABLE',storageReserveBytes:100000000,coreVersion:CORE_VERSION};
const context:CaptureContext={schema:CAPTURE_SCHEMA,captureId:'capture',intentId:'intent',proofId:'proof',transactionId:'transaction',transactionDigest:'a'.repeat(64),actorId:'seller',policy:{...POLICY},expected:[],capabilities};
const observations=(captureId:string):Observation[]=>[{id:'start',captureId,type:'CAPTURE_STARTED',startMs:0,endMs:0,source:'DEVICE',model:null,confidence:null,value:null,timePrecision:'APPROXIMATE'},{id:'end',captureId,type:'CAPTURE_ENDED',startMs:200,endMs:200,source:'DEVICE',model:null,confidence:null,value:null,timePrecision:'APPROXIMATE'}];
async function manifest(c:CaptureContext,bytes:Buffer){const segment=await chainSegment({sequence:0,offsetBytes:0,byteSize:bytes.length,sha256:sha256Hex(bytes),previous:null,startMs:0,endMs:200,timing:'WHOLE_RECORDING'},hash);return createManifest(c,{sha256:sha256Hex(bytes),byteSize:bytes.length,contentType:'video/mp4',durationMs:200},[segment],observations(c.captureId),hash);}
it('canonical ordering, state transitions and domain-separated hash vectors are deterministic',async()=>{
 const fixture=JSON.parse(await readFile(new URL('../../docs/capture-platform-2026-09-08/conformance-v1.json',import.meta.url),'utf8'));const {commitment,...input}=fixture.segment;expect(canonical(input)).toBe(fixture.canonicalSegment);expect(await chainSegment(input,hash)).toEqual(fixture.segment);expect(sha256Hex(fixture.sourceUtf8)).toBe(input.sha256);
 expect(canonical({b:2,a:[true,null,'x']})).toBe('{"a":[true,null,"x"],"b":2}');expect(()=>canonical({x:NaN})).toThrow();expect(transition('CAPTURING','INTERRUPTED')).toBe('INTERRUPTED');expect(()=>transition('BOUND','FINALIZED')).toThrow();
 const m=await manifest(context,Buffer.from('source'));expect(await manifestDigest(m,hash)).toBe(await manifestDigest(await manifest(JSON.parse(JSON.stringify(context)),Buffer.from('source')),hash));
});
it('rejects event reassignment, duplicates, time forgery and raw detector payloads',async()=>{
 const m=await manifest(context,Buffer.from('source'));
 for(const obs of [[...m.observations,{...m.observations[0],captureId:'other'}],[m.observations[0],m.observations[0],m.observations[1]],[m.observations[0],{...m.observations[1],endMs:201}],[{...m.observations[0],rawFingerprint:'forbidden'},m.observations[1]]])await expect(createManifest(context,m.source,m.segments,obs,hash)).rejects.toThrow();
});
it('distinguishes missing capabilities and ambiguous labels without claiming verification',()=>{
 const c={...context,capabilities:{...capabilities,barcode:true},expected:[{kind:'TRACKING' as const,value:'9400111899223344556677',source:'API',version:'1'}],policy:{...POLICY,requireItemVisibility:true}};
 const label=(id:string,value:string):Observation=>({id,captureId:'capture',type:'LABEL',startMs:10,endMs:10,source:'LIVE_ANALYSIS',model:{id:'mlkit-barcode',version:'17.2.0',configuration:'tracking',calibration:'NOT_CALIBRATED'},confidence:null,value,timePrecision:'APPROXIMATE'});
 const result=evaluate(c,[label('one','9400111899223344556677'),label('two','9400111899223344556688')]);expect(result[0].state).toBe('CONFLICT');expect(result[1].state).toBe('UNAVAILABLE');expect(guidance(result)).toContain('More than one label');
});
it('checks received bytes across arbitrary network chunk boundaries',async()=>{
 const bytes=Buffer.from('abcdef');const m=await manifest(context,bytes);
 await verifySegmentStream(m,(async function*(){yield bytes.subarray(0,1);yield bytes.subarray(1,4);yield bytes.subarray(4);})());
 await expect(verifySegmentStream(m,(async function*(){yield Buffer.from('abcdeg');})())).rejects.toMatchObject({code:'CAPTURE_SEGMENT_MISMATCH'});
 await expect(verifySegmentStream(m,(async function*(){yield bytes.subarray(1);})())).rejects.toThrow();
});
describe('server-bound capture',()=>{
 let h:TestHarness,actor:string,other:string;let now=new Date('2026-09-09T00:00:00Z');const clock={now:()=>new Date(now)};
 beforeAll(async()=>{h=await createHarness(clock);actor=await createUser(h);other=await createUser(h);});afterAll(async()=>h.close());
 async function proof(){const t=await request(h.app).post('/transactions').set(auth(actor)).send({itemTitle:'Camera lens'});const p=await request(h.app).post(`/transactions/${t.body.transactionId}/proof`).set(auth(actor)).send({});return p.body.proofId as string;}
 it('enforces one-time authenticated intent redemption, expiry and database binding',async()=>{
  const p=await proof();const intent=await issueIntent(h.db,clock,actor,p,['WEB']);
  await expect(bindIntent(h.db,clock,other,{launchToken:intent.launchToken,capabilities})).rejects.toMatchObject({code:'CAPTURE_INTENT_INVALID'});
  const bound=await bindIntent(h.db,clock,actor,{launchToken:intent.launchToken,capabilities});expect(bound.context.proofId).toBe(p);
  expect((await recoverIntentContext(h.db,clock,actor,intent.intentId)).session.id).toBe(bound.session.id);
  await expect(recoverIntentContext(h.db,clock,other,intent.intentId)).rejects.toMatchObject({code:'CAPTURE_INTENT_NOT_BOUND'});
  await expect(bindIntent(h.db,clock,actor,{launchToken:intent.launchToken,capabilities})).rejects.toMatchObject({code:'CAPTURE_INTENT_USED'});
  await expect(h.db.query("UPDATE capture_engine_sessions SET proof_id='another' WHERE session_id=$1",[bound.session.id])).rejects.toThrow();
  const stale=await issueIntent(h.db,clock,actor,await proof());now=new Date(now.getTime()+600001);await expect(bindIntent(h.db,clock,actor,{launchToken:stale.launchToken,capabilities})).rejects.toMatchObject({code:'CAPTURE_INTENT_EXPIRED'});
 });
 it('seals, independently verifies source, finalizes and retains the capsule in the signed manifest input',async()=>{
  const p=await proof();const intent=await issueIntent(h.db,clock,actor,p);const b=await bindIntent(h.db,clock,actor,{launchToken:intent.launchToken,capabilities});
  const bytes=await readFile(new URL('./fixtures/camera-recording.mp4',import.meta.url));const m=await manifest(b.context,bytes);const digest=await manifestDigest(m,hash);
  await completeCaptureSession(h.db,clock,actor,p,b.session.id,{...m.source,recordedDurationMs:200});
  const batch={sequence:0,observations:m.observations,segments:m.segments};await receiveBatch(h.db,clock,actor,b.session.id,batch);await receiveBatch(h.db,clock,actor,b.session.id,batch);
  await expect(receiveBatch(h.db,clock,actor,b.session.id,{...batch,observations:[]})).rejects.toMatchObject({code:'CAPTURE_BATCH_CONFLICT'});
  await sealCapture(h.db,clock,actor,b.session.id,{source:m.source,segments:m.segments,observations:m.observations,sha256:digest});
  const upload=await initializeEvidenceUpload(h.db,clock,h.objectStore,actor,p,{contentType:'video/mp4',evidenceType:'FULFILLMENT_CAPTURE',captureSessionId:b.session.id,idempotencyKey:'source'});await h.objectStore.put(upload.objectKey,bytes,'video/mp4');
  await commitEvidence(h.db,clock,h.objectStore,actor,p,upload.evidenceId);
  await expect(recoverIntentContext(h.db,clock,actor,intent.intentId)).rejects.toMatchObject({code:'CAPTURE_ALREADY_STARTED'});
  await commitAttestation(h.db,clock,actor,p,{statement:'PACKED_DESCRIBED_ITEM',relatedEvidenceId:upload.evidenceId});const result=await finalizeProof(h.db,clock,actor,p);
  expect((result.manifest.manifest as any).captureManifests[0].sha256).toBe(digest);expect((await finalizeProof(h.db,clock,actor,p)).manifest.sha256).toBe(result.manifest.sha256);
  const response=await request(h.app).get(`/proofs/${p}/capture-capsule`).set(auth(actor));expect(response.status).toBe(200);expect(response.body.captures[0].events[0].startMs).toBe(0);
 });
});
