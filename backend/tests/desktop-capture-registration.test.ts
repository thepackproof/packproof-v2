import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { readFile } from 'node:fs/promises';
import { auth, createHarness, createUser, type TestHarness } from './helpers.js';
import { registerDesktopCapture, createCaptureSession, recoverCaptureSession, type DesktopCaptureContext } from '../src/domain/capture-sessions.js';
import { initializeEvidenceUpload, commitEvidence } from '../src/domain/evidence.js';
import { commitAttestation } from '../src/domain/attestations.js';
import { finalizeProof } from '../src/domain/finalize.js';
import { bindCaptureShipping } from '../src/domain/capture-shipping.js';
import { registerOfferVersion, scheduleApprovedOfferPeriod, type OfferDefinition } from '../src/billing/usage-ledger.js';
import { syntheticPublication } from './program-metrics-publication-fixture.js';
import { sha256Hex } from '../src/hash.js';
import { validateCapturedMediaStream } from '../src/domain/capture-media.js';
import { Readable } from 'node:stream';

const now=new Date('2026-09-27T12:00:00Z'),clock={now:()=>new Date(now)};
const context:DesktopCaptureContext={schemaVersion:1,installationId:'install_test',appVersion:'1.0.0',platform:'win32',captureStartedAt:'2026-09-26T12:00:00.000Z',captureEndedAt:'2026-09-26T12:00:01.000Z',cameraLabel:'USB camera',offline:true};
let h:TestHarness,media:Buffer,seller:string,other:string;
beforeAll(async()=>{h=await createHarness(clock);seller=await createUser(h);other=await createUser(h);media=await readFile(new URL('./fixtures/camera-recording.mp4',import.meta.url));},30000);
afterAll(async()=>{await h.close();});
async function proof(user=seller){const t=await request(h.app).post('/transactions').set(auth(user)).send({itemTitle:'Desktop capture fixture'});const p=await request(h.app).post(`/transactions/${t.body.transactionId}/proof`).set(auth(user)).send({});expect(p.status).toBe(200);return p.body.proofId as string;}
function input(key='desktop'){return {idempotencyKey:key,sha256:sha256Hex(media),byteSize:media.length,contentType:'video/mp4',recordedDurationMs:1000,interrupted:false,desktopContext:context};}
async function upload(proofId:string,sessionId:string){const u=await initializeEvidenceUpload(h.db,clock,h.objectStore,seller,proofId,{contentType:'video/mp4',captureSessionId:sessionId,evidenceType:'FULFILLMENT_CAPTURE',idempotencyKey:'upload'});await h.objectStore.put(u.objectKey,media,'video/mp4');return commitEvidence(h.db,clock,h.objectStore,seller,proofId,u.evidenceId);}

describe('post-capture desktop registration',()=>{
  it('advertises explicit provenance and never accepts desktop on the preauthorization route',async()=>{
    expect((await request(h.app).get('/capabilities')).body.desktopCapture).toMatchObject({registrationVersions:[1],client:'DESKTOP_CAMERA',registrationTiming:'POST_CAPTURE_CLIENT_REPORTED',maxBytes:250000000,maxDurationSeconds:300});
    await expect(createCaptureSession(h.db,clock,seller,await proof(),{client:'DESKTOP_CAMERA',idempotencyKey:'false-start'})).rejects.toMatchObject({code:'CAPTURE_CLIENT_REQUIRED'});
  });
  it('registers an earlier offline capture without inventing a server recording start, commits original bytes and freezes honest provenance',async()=>{
    const id=await proof();
    const response=await request(h.app).post(`/proofs/${id}/capture-sessions/desktop-registration`).set(auth(seller)).set('Idempotency-Key','offline-http').send(input());
    expect(response.status).toBe(201);
    const s=response.body;
    expect(s).toMatchObject({state:'RECORDED',client:'DESKTOP_CAMERA',policyVersion:'packproof.desktop-client-capture/v1',registrationTiming:'POST_CAPTURE_CLIENT_REPORTED',recordedAt:now.toISOString(),clientReportedCapture:{provenance:'CLIENT_REPORTED_NOT_INDEPENDENTLY_VERIFIED',desktopContext:context}});
    const saved=await upload(id,s.id);
    expect(saved.sha256).toBe(sha256Hex(media));
    expect(saved.proof.evidence[0]).toMatchObject({captureOrigin:'CLIENT_REPORTED_DESKTOP_CAPTURE',captureRegistrationTiming:'POST_CAPTURE_CLIENT_REPORTED',capturedDurationMs:200});
    expect(saved.proof.evidence[0].captureAssurance).toContain('after capture');
    await expect(finalizeProof(h.db,clock,seller,id)).rejects.toMatchObject({code:'PROOF_NOT_READY_FOR_FINALIZATION',message:'Seller packing attestation is required'});
    await commitAttestation(h.db,clock,seller,id,{statement:'PACKED_DESCRIBED_ITEM',relatedEvidenceId:saved.evidenceId});
    const frozen=await finalizeProof(h.db,clock,seller,id),capture=(frozen.manifest.manifest as any).evidence[0].capture;
    expect(capture).toMatchObject({origin:'CLIENT_REPORTED_DESKTOP_CAPTURE',registrationTiming:'POST_CAPTURE_CLIENT_REPORTED',registeredAt:now.toISOString(),clientReportedCapture:{desktopContext:context}});
    expect(capture.assurance).toContain('not to the earlier recording');
    expect((await finalizeProof(h.db,clock,seller,id)).manifest.sha256).toBe(frozen.manifest.sha256);
    expect((await recoverCaptureSession(h.db,clock,seller,id,s.id)).state).toBe('COMMITTED');
  });
  it('binds the immutable retry identity to bytes, Proof, account, and desktop context',async()=>{
    const id=await proof(),s=await registerDesktopCapture(h.db,clock,seller,id,input());
    expect((await registerDesktopCapture(h.db,clock,seller,id,input())).id).toBe(s.id);
    await expect(registerDesktopCapture(h.db,clock,seller,id,{...input(),sha256:'a'.repeat(64)})).rejects.toMatchObject({code:'CAPTURE_RECORDING_CONFLICT'});
    await expect(registerDesktopCapture(h.db,clock,seller,id,{...input(),desktopContext:{...context,offline:false}})).rejects.toMatchObject({code:'CAPTURE_SESSION_CONFLICT'});
    await expect(registerDesktopCapture(h.db,clock,other,id,input('foreign'))).rejects.toMatchObject({code:'PARTICIPANT_NOT_AUTHORIZED'});
    await expect(h.db.query("UPDATE capture_sessions SET desktop_context=desktop_context || '{\"offline\":false}'::jsonb WHERE id=$1",[s.id])).rejects.toThrow('DESKTOP_CAPTURE_CONTEXT_IMMUTABLE');
    expect((await h.db.query('SELECT id FROM capture_sessions WHERE proof_id=$1',[id])).rows).toHaveLength(1);
  });
  it('commits original streaming WebM without a duration header using bounded encoded packet timing',async()=>{
    // Generated with ffmpeg color source, VP8, 128x128, 5 fps, 1s, -live 1.
    const bytes=await readFile(new URL('./fixtures/desktop-streaming.webm',import.meta.url)),id=await proof();
    const s=await registerDesktopCapture(h.db,clock,seller,id,{...input(),byteSize:bytes.length,sha256:sha256Hex(bytes),contentType:'video/webm'});
    const u=await initializeEvidenceUpload(h.db,clock,h.objectStore,seller,id,{contentType:'video/webm',evidenceType:'FULFILLMENT_CAPTURE',captureSessionId:s.id,idempotencyKey:'streaming'});
    await h.objectStore.put(u.objectKey,bytes,'video/webm');
    const saved=await commitEvidence(h.db,clock,h.objectStore,seller,id,u.evidenceId);
    expect(saved.sha256).toBe(sha256Hex(bytes));expect(saved.byteSize).toBe(bytes.length);
    expect(saved.proof.evidence[0].capturedDurationMs).toBe(1000);
    await expect(validateCapturedMediaStream(Readable.from([bytes]),'video/webm',{byteSize:bytes.length,sha256:sha256Hex(bytes),maxDurationMs:500})).rejects.toMatchObject({code:'INVALID_CAPTURE_MEDIA'});
    const truncated=bytes.subarray(0,bytes.length-10);
    await expect(validateCapturedMediaStream(Readable.from([truncated]),'video/webm',{byteSize:truncated.length})).rejects.toMatchObject({code:'INVALID_CAPTURE_MEDIA'});
  });
  it('rejects invalid context and over-limit recordings with no partial session',async()=>{
    const id=await proof();
    for(const patch of [{byteSize:250000001},{recordedDurationMs:300001},{desktopContext:{...context,platform:'linux'}},{desktopContext:{...context,captureStartedAt:'tomorrow'}},{desktopContext:{...context,captureEndedAt:'2026-09-25T00:00:00Z'}}]){
      await expect(registerDesktopCapture(h.db,clock,seller,id,{...input(),...patch})).rejects.toBeDefined();
    }
    expect((await h.db.query('SELECT id FROM capture_sessions WHERE proof_id=$1',[id])).rows).toHaveLength(0);
  });
  it('preserves server billing limits and rolls back a denied registration and its allowance reservation',async()=>{
    const user=await createUser(h),id=await proof(user),second=await proof(user);
    const offer:OfferDefinition={schemaVersion:'packproof.billing.v1',version:'desktop-test-offer',status:'approved',currency:'USD',priceMinor:2900,interval:'monthly',includedFinalizedProofs:1,maxRecordingBytes:10000,maxRecordingSeconds:30,retentionPolicyVersion:'test-retention-v1',preservationStandard:'canonical-original-v1',supplements:'included_within_published_allowance',overage:'block_new_capture',approvedTermsReference:'synthetic-terms'};
    const approval={publication:syntheticPublication(offer,now)};
    await registerOfferVersion(h.db,clock,offer,approval);
    await scheduleApprovedOfferPeriod(h.db,clock,{id:'desktop-period',userId:user,offerVersion:offer.version,start:now.toISOString(),end:'2026-10-27T12:00:00.000Z',consentReceiptReference:'synthetic-consent'},approval);
    await expect(registerDesktopCapture(h.db,clock,user,id,{...input(),recordedDurationMs:31000})).rejects.toMatchObject({code:'CAPTURE_RECORDING_LIMIT'});
    expect((await h.db.query('SELECT 1 FROM billing_capture_reservations WHERE proof_id=$1',[id])).rows).toHaveLength(0);
    expect((await h.db.query('SELECT id FROM capture_sessions WHERE proof_id=$1',[id])).rows).toHaveLength(0);
    await registerDesktopCapture(h.db,clock,user,id,{...input(),byteSize:1000});
    await expect(registerDesktopCapture(h.db,clock,user,second,input())).rejects.toMatchObject({code:'BILLING_CAPTURE_ALLOWANCE_EXHAUSTED'});
    expect((await h.db.query('SELECT id FROM capture_sessions WHERE proof_id=$1',[second])).rows).toHaveLength(0);
  });
  it('accepts in-video labels but preserves mismatch review and rejects offsets outside the declared video',async()=>{
    const id=await proof(),s=await registerDesktopCapture(h.db,clock,seller,id,input());
    const scan={rawValue:'1Z999AA10123456784',format:'CODE_128',detectedAtMs:100,idempotencyKey:'scan',confirmed:true};
    expect(await bindCaptureShipping(h.db,clock,seller,id,s.id,scan)).toMatchObject({status:'BOUND'});
    expect(await bindCaptureShipping(h.db,clock,seller,id,s.id,{...scan,rawValue:'1Z999AA10123456785',idempotencyKey:'mismatch'})).toMatchObject({status:'CONFLICT'});
    await expect(bindCaptureShipping(h.db,clock,seller,id,s.id,{...scan,detectedAtMs:1001,idempotencyKey:'outside'})).rejects.toMatchObject({code:'INVALID_SHIPPING_SCAN'});
    const saved=await upload(id,s.id);
    await commitAttestation(h.db,clock,seller,id,{statement:'PACKED_DESCRIBED_ITEM',relatedEvidenceId:saved.evidenceId});
    await expect(finalizeProof(h.db,clock,seller,id)).rejects.toMatchObject({code:'LABEL_REVIEW_REQUIRED'});
  });
});
