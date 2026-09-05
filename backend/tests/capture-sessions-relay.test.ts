import { inviteCommerceReceiver, acceptCommerceReceiver, createCommerceStage, initializeStageEvidence, commitStageEvidence, finalizeCommerceStage } from "../src/domain/commerce-lifecycle.js";
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import request from 'supertest';
import { createHarness, createUser, commitFulfillmentAndAttest, auth, type TestHarness } from './helpers.js';
import { createCaptureSession, completeCaptureSession, recoverCaptureSession, cancelCaptureSession } from '../src/domain/capture-sessions.js';
import { initializeEvidenceUpload, commitEvidence } from '../src/domain/evidence.js';
import { sha256Hex } from '../src/hash.js';
import { createRelayStation, pairRelayCamera, sendRelayCommand, acknowledgeRelayCommand, getRelayStation } from '../src/domain/packing-relay.js';
import { finalizeProof } from '../src/domain/finalize.js';
import { commitAttestation } from '../src/domain/attestations.js';

describe('authorized packing capture and relay',()=>{
 let h:TestHarness;let seller:string;let other:string;let proofId:string;let another:string;
 let now=new Date('2026-09-05T12:00:00Z');
 const clock={now:()=>new Date(now)};
 let media:Buffer;
 async function proof(actor:string){const t=await request(h.app).post('/transactions').set(auth(actor)).send({itemTitle:'Camera lens'}); const p=await request(h.app).post(`/transactions/${t.body.transactionId}/proof`).set(auth(actor)).send({});expect(p.status).toBe(200);return p.body.proofId as string;}
 beforeEach(async()=>{now=new Date('2026-09-05T12:00:00Z');h=await createHarness(clock);seller=await createUser(h);other=await createUser(h);proofId=await proof(seller);another=await proof(seller);media=await readFile(new URL('./fixtures/camera-recording.mp4',import.meta.url));});
 afterEach(async()=>{await h.close();});
 async function record(id=proofId,key='capture') {const s=await createCaptureSession(h.db,clock,seller,id,{client:'NATIVE_CAMERA',idempotencyKey:key});await completeCaptureSession(h.db,clock,seller,id,s.id,{sha256:sha256Hex(media),byteSize:media.length,contentType:'video/mp4'});return s;}
 async function upload(sessionId:string,id=proofId,key='upload') {return initializeEvidenceUpload(h.db,clock,h.objectStore,seller,id,{contentType:'video/mp4',evidenceType:'FULFILLMENT_CAPTURE',captureSessionId:sessionId,idempotencyKey:key});}
 async function pendingRelayStart() {
  const station=await createRelayStation(h.db,clock,seller);
  const camera=await pairRelayCamera(h.db,clock,seller,station.id,station.pairingToken);
  await sendRelayCommand(h.db,clock,seller,station.id,station.controllerToken,{sequence:1,type:'SELECT_ORDER',proofId,idempotencyKey:'select'});
  await acknowledgeRelayCommand(h.db,clock,seller,station.id,camera.cameraToken,{sequence:1});
  await sendRelayCommand(h.db,clock,seller,station.id,station.controllerToken,{sequence:2,type:'START',idempotencyKey:'start'});
  return {station,camera};
 }
 it('rejects missing sessions, wrong participants, wrong Proofs, forged origin and changed recording intent',async()=>{
  await expect(initializeEvidenceUpload(h.db,clock,h.objectStore,seller,proofId,{contentType:'video/mp4',evidenceType:'FULFILLMENT_CAPTURE',idempotencyKey:'gallery'})).rejects.toMatchObject({code:'CAPTURE_SESSION_REQUIRED'});
  const s=await record();
  await expect(completeCaptureSession(h.db,clock,other,proofId,s.id,{sha256:sha256Hex(media),byteSize:media.length,contentType:'video/mp4'})).rejects.toMatchObject({code:"CAPTURE_SESSION_NOT_FOUND"});
  await expect(upload(s.id,another)).rejects.toMatchObject({code:'CAPTURE_SESSION_NOT_FOUND'});
  await expect(completeCaptureSession(h.db,clock,seller,proofId,s.id,{sha256:'0'.repeat(64),byteSize:media.length,contentType:'video/mp4'})).rejects.toMatchObject({code:'CAPTURE_RECORDING_CONFLICT'});
  const u=await upload(s.id);
  await expect(upload(s.id,proofId,'other-upload')).rejects.toMatchObject({code:'CAPTURE_SESSION_ALREADY_USED'});
  await expect(initializeEvidenceUpload(h.db,clock,h.objectStore,seller,proofId,{contentType:'video/mp4',evidenceType:'SELLER_EVIDENCE',idempotencyKey:'upload'})).rejects.toMatchObject({code:'EVIDENCE_UPLOAD_CONFLICT'});
  await h.objectStore.put(u.objectKey,Buffer.from('gallery-text-spoofed-as-video'),'video/mp4');
  await expect(commitEvidence(h.db,clock,h.objectStore,seller,proofId,u.evidenceId)).rejects.toMatchObject({code:'CAPTURE_RECORDING_MISMATCH'});
 });
 it('persists registration and renews transport after restart/auth renewal without changing identity, final hash or original',async()=>{
  const s=await record();const first=await upload(s.id);
  now=new Date(now.getTime()+2*24*60*60*1000);
  expect((await recoverCaptureSession(h.db,clock,seller,proofId,s.id)).state).toBe('UPLOADING');
  const retry=await upload(s.id);expect(retry.evidenceId).toBe(first.evidenceId);
  await h.objectStore.put(retry.objectKey,media,'video/mp4');
  const saved=await commitEvidence(h.db,clock,h.objectStore,seller,proofId,retry.evidenceId);
  expect(saved.sha256).toBe(sha256Hex(media));expect(saved.byteSize).toBe(media.length);
  expect((await commitEvidence(h.db,clock,h.objectStore,seller,proofId,retry.evidenceId)).sha256).toBe(saved.sha256);
  await commitAttestation(h.db,clock,seller,proofId,{statement:'PACKED_DESCRIBED_ITEM',relatedEvidenceId:saved.evidenceId});
  const final=await finalizeProof(h.db,clock,seller,proofId);
  expect((await finalizeProof(h.db,clock,seller,proofId)).manifest.sha256).toBe(final.manifest.sha256);
  expect((await recoverCaptureSession(h.db,clock,seller,proofId,s.id)).state).toBe('COMMITTED');
  await expect(cancelCaptureSession(h.db,clock,seller,proofId,s.id)).rejects.toMatchObject({code:'PROOF_ALREADY_FINALIZED'});
 });
 it('preserves preauthorized offline recording recovery and rejects expired transport or structurally truncated media',async()=>{
  const s=await createCaptureSession(h.db,clock,seller,proofId,{client:'WEB_CAMERA',idempotencyKey:'offline'});
  now=new Date(now.getTime()+3600*1000);
  const truncated=media.subarray(0,64);
  await completeCaptureSession(h.db,clock,seller,proofId,s.id,{sha256:sha256Hex(truncated),byteSize:truncated.length,contentType:'video/mp4'});
  const u=await upload(s.id);await h.objectStore.put(u.objectKey,truncated,'video/mp4');
  await expect(commitEvidence(h.db,clock,h.objectStore,seller,proofId,u.evidenceId)).rejects.toMatchObject({code:'INVALID_CAPTURE_MEDIA'});
  now=new Date(now.getTime()+8*24*3600*1000);
  await expect(recoverCaptureSession(h.db,clock,seller,proofId,s.id)).rejects.toMatchObject({code:'CAPTURE_RECOVERY_EXPIRED'});
  expect((await h.db.query('SELECT validation_status FROM evidence WHERE id=$1',[u.evidenceId])).rows[0]).toMatchObject({validation_status:'PENDING'});
 });
 it('requires pairing credentials and acknowledgements; rejects 100 reorders/rebindings while preserving pending original',async()=>{
  const station=await createRelayStation(h.db,clock,seller);
  await expect(pairRelayCamera(h.db,clock,other,station.id,station.pairingToken)).rejects.toMatchObject({code:'RELAY_PAIRING_INVALID'});
  const camera=await pairRelayCamera(h.db,clock,seller,station.id,station.pairingToken);
  await expect(pairRelayCamera(h.db,clock,seller,station.id,station.pairingToken)).rejects.toMatchObject({code:'RELAY_ALREADY_PAIRED'});
  const select={sequence:1,type:'SELECT_ORDER',proofId,idempotencyKey:'select'};
  await sendRelayCommand(h.db,clock,seller,station.id,station.controllerToken,select);
  await acknowledgeRelayCommand(h.db,clock,seller,station.id,camera.cameraToken,{sequence:1});
  await sendRelayCommand(h.db,clock,seller,station.id,station.controllerToken,{sequence:2,type:'START',idempotencyKey:'start'});
  const s=await createCaptureSession(h.db,clock,seller,proofId,{client:'NATIVE_CAMERA',idempotencyKey:'relay-capture'});
  await acknowledgeRelayCommand(h.db,clock,seller,station.id,camera.cameraToken,{sequence:2,captureSessionId:s.id});
  for(let i=0;i<100;i++){
    expect((await sendRelayCommand(h.db,clock,seller,station.id,station.controllerToken,select)).replayed).toBe(true);
    await expect(sendRelayCommand(h.db,clock,seller,station.id,station.controllerToken,{sequence:i+4,type:'NEXT',proofId:another,idempotencyKey:`out-of-order-${i}`})).rejects.toMatchObject({code:'RELAY_SEQUENCE_CONFLICT'});
  }
  await expect(sendRelayCommand(h.db,clock,seller,station.id,station.controllerToken,{sequence:3,type:'NEXT',proofId:another,idempotencyKey:'wrong-next'})).rejects.toMatchObject({code:'RELAY_SAVE_REQUIRED'});
  await sendRelayCommand(h.db,clock,seller,station.id,station.controllerToken,{sequence:3,type:'FINISH',idempotencyKey:'finish'});
  await completeCaptureSession(h.db,clock,seller,proofId,s.id,{sha256:sha256Hex(media),byteSize:media.length,contentType:'video/mp4'});
  await acknowledgeRelayCommand(h.db,clock,seller,station.id,camera.cameraToken,{sequence:3});
  const pending=await getRelayStation(h.db,clock,seller,station.id,camera.cameraToken);expect(pending.captureSessionId).toBe(s.id);expect(pending.state).toBe('SAVING');
  await expect(sendRelayCommand(h.db,clock,seller,station.id,station.controllerToken,{sequence:4,type:'NEXT',proofId:another,idempotencyKey:'next'})).rejects.toMatchObject({code:'RELAY_SAVE_REQUIRED'});
  const u=await upload(s.id);await h.objectStore.put(u.objectKey,media,'video/mp4');await commitEvidence(h.db,clock,h.objectStore,seller,proofId,u.evidenceId);
  await sendRelayCommand(h.db,clock,seller,station.id,station.controllerToken,{sequence:4,type:'NEXT',proofId:another,idempotencyKey:'next'});
  expect((await getRelayStation(h.db,clock,seller,station.id,camera.cameraToken)).proofId).toBe(another);
  expect((await recoverCaptureSession(h.db,clock,seller,proofId,s.id)).evidenceId).toBe(u.evidenceId);
 });
 it('authorizes receipt/return stages by actor and stage, preserves delayed recovery and never changes the sealed root',async()=>{
  await commitFulfillmentAndAttest(h,seller,proofId);
  const root=await finalizeProof(h.db,clock,seller,proofId);
  await inviteCommerceReceiver(h.db,clock,seller,proofId,other);
  await acceptCommerceReceiver(h.db,clock,other,proofId);
  const stage=await createCommerceStage(h.db,clock,other,proofId,'RECEIPT');
  await expect(createCaptureSession(h.db,clock,seller,proofId,{client:'WEB_CAMERA',idempotencyKey:'wrong-role',stageId:stage.stageId})).rejects.toMatchObject({code:'CAPTURE_STAGE_NOT_AUTHORIZED'});
  await expect(initializeStageEvidence(h.db,clock,h.objectStore,other,proofId,stage.stageId,{contentType:'video/mp4',idempotencyKey:'gallery'})).rejects.toMatchObject({code:'CAPTURE_SESSION_REQUIRED'});
  const supporting=await initializeStageEvidence(h.db,clock,h.objectStore,other,proofId,stage.stageId,{contentType:'image/jpeg',idempotencyKey:'support'});
  await h.objectStore.putUpload(new URL(supporting.upload.url).pathname.split('/').at(-1)!,Buffer.from('supporting image'),'image/jpeg');
  await commitStageEvidence(h.db,clock,h.objectStore,other,proofId,stage.stageId,supporting.evidenceId,undefined);
  await expect(finalizeCommerceStage(h.db,clock,other,proofId,stage.stageId,'I_RECORDED_RECEIPT')).rejects.toMatchObject({code:'STAGE_CAPTURE_REQUIRED'});
  const session=await createCaptureSession(h.db,clock,other,proofId,{client:'NATIVE_CAMERA',idempotencyKey:'receipt-camera',stageId:stage.stageId});
  await expect(completeCaptureSession(h.db,clock,seller,proofId,session.id,{sha256:sha256Hex(media),byteSize:media.length,contentType:'video/mp4'})).rejects.toMatchObject({code:'CAPTURE_SESSION_NOT_FOUND'});
  now=new Date(now.getTime()+24*3600*1000);
  const registered=await completeCaptureSession(h.db,clock,other,proofId,session.id,{sha256:sha256Hex(media),byteSize:media.length,contentType:'video/mp4',interrupted:true,recordedDurationMs:200});
  expect(registered.registrationTiming).toBe('DELAYED_NOT_INDEPENDENTLY_ATTESTED');
  const u=await initializeStageEvidence(h.db,clock,h.objectStore,other,proofId,stage.stageId,{contentType:'video/mp4',captureSessionId:session.id,idempotencyKey:'receipt-upload'});
  await h.objectStore.putUpload(new URL(u.upload.url).pathname.split('/').at(-1)!,media,'video/mp4');
  await commitStageEvidence(h.db,clock,h.objectStore,other,proofId,stage.stageId,u.evidenceId,sha256Hex(media));
  const frozen=await finalizeCommerceStage(h.db,clock,other,proofId,stage.stageId,'I_RECORDED_RECEIPT');
  expect((await finalizeCommerceStage(h.db,clock,other,proofId,stage.stageId,'I_RECORDED_RECEIPT')).sha256).toBe(frozen.sha256);
  expect((await recoverCaptureSession(h.db,clock,other,proofId,session.id)).stageId).toBe(stage.stageId);
  expect((frozen.manifest as any).evidence.find((e:any)=>e.evidenceId===u.evidenceId).capture.clientReportedCapture.interrupted).toBe(true);
  expect((await finalizeProof(h.db,clock,seller,proofId)).manifest.sha256).toBe(root.manifest.sha256);
  await expect(createCaptureSession(h.db,clock,other,proofId,{client:'NATIVE_CAMERA',idempotencyKey:'after-seal',stageId:stage.stageId})).rejects.toMatchObject({code:'COMMERCE_STAGE_IMMUTABLE'});
 });

 it.each(['RECORDED','UPLOADING','COMMITTED'] as const)('recovers an unacknowledged START after camera restart with a %s original',async state=>{
  const {station,camera}=await pendingRelayStart();
  const capture=await record();
  if(state!=='RECORDED') {
   const u=await upload(capture.id);
   if(state==='COMMITTED') {await h.objectStore.put(u.objectKey,media,'video/mp4');await commitEvidence(h.db,clock,h.objectStore,seller,proofId,u.evidenceId);}
  }
  // The acquisition window elapsed while the app was disconnected; the original is registered and remains bound.
  now=new Date(now.getTime()+3600*1000);
  const restored=await acknowledgeRelayCommand(h.db,clock,seller,station.id,camera.cameraToken,{sequence:2,captureSessionId:capture.id});
  expect(restored.state).toBe(state==='COMMITTED'?'SAVED':'SAVING');
  expect(restored.captureSessionId).toBe(capture.id);
  expect((await recoverCaptureSession(h.db,clock,seller,proofId,capture.id)).sha256).toBe(sha256Hex(media));
  expect((await acknowledgeRelayCommand(h.db,clock,seller,station.id,camera.cameraToken,{sequence:2,captureSessionId:capture.id})).replayed).toBe(true);
  if(state!=='COMMITTED') await expect(sendRelayCommand(h.db,clock,seller,station.id,station.controllerToken,{sequence:3,type:'NEXT',proofId:another,idempotencyKey:'next'})).rejects.toMatchObject({code:'RELAY_SAVE_REQUIRED'});
 });

 it('rejects an old session and preserves its first START binding after a station advances',async()=>{
  const old=await createCaptureSession(h.db,clock,seller,proofId,{client:'WEB_CAMERA',idempotencyKey:'before-start'});
  now=new Date(now.getTime()+1000);
  const first=await pendingRelayStart();
  await expect(acknowledgeRelayCommand(h.db,clock,seller,first.station.id,first.camera.cameraToken,{sequence:2,captureSessionId:old.id})).rejects.toMatchObject({code:'CAPTURE_SESSION_CONFLICT'});
  // Two pending commands can predate the same session. Only the first acknowledged command may ever own it.
  const second=await pendingRelayStart();
  const capture=await record();const u=await upload(capture.id);
  await h.objectStore.put(u.objectKey,media,'video/mp4');await commitEvidence(h.db,clock,h.objectStore,seller,proofId,u.evidenceId);
  await acknowledgeRelayCommand(h.db,clock,seller,first.station.id,first.camera.cameraToken,{sequence:2,captureSessionId:capture.id});
  await sendRelayCommand(h.db,clock,seller,first.station.id,first.station.controllerToken,{sequence:3,type:'NEXT',proofId:another,idempotencyKey:'next'});
  expect((await acknowledgeRelayCommand(h.db,clock,seller,first.station.id,first.camera.cameraToken,{sequence:2,captureSessionId:capture.id})).replayed).toBe(true);
  await expect(acknowledgeRelayCommand(h.db,clock,seller,second.station.id,second.camera.cameraToken,{sequence:2,captureSessionId:capture.id})).rejects.toMatchObject({code:'CAPTURE_SESSION_ALREADY_USED'});
  expect((await recoverCaptureSession(h.db,clock,seller,proofId,capture.id)).evidenceId).toBe(u.evidenceId);
 });

 it('retains interrupted client context on retries and freezes it separately from server media duration',async()=>{
  const session=await createCaptureSession(h.db,clock,seller,proofId,{client:'NATIVE_CAMERA',idempotencyKey:'interrupted-camera'});
  const intent={sha256:sha256Hex(media),byteSize:media.length,contentType:'video/mp4'};
  const first=await completeCaptureSession(h.db,clock,seller,proofId,session.id,{...intent,interrupted:true,recordedDurationMs:125});
  expect(first.clientReportedCapture).toEqual({interrupted:true,recordedDurationMs:125,provenance:'CLIENT_REPORTED_NOT_INDEPENDENTLY_VERIFIED'});
  await completeCaptureSession(h.db,clock,seller,proofId,session.id,{...intent,interrupted:false});
  expect((await completeCaptureSession(h.db,clock,seller,proofId,session.id,intent)).clientReportedCapture?.interrupted).toBe(true);
  await expect(completeCaptureSession(h.db,clock,seller,proofId,session.id,{...intent,recordedDurationMs:126})).rejects.toMatchObject({code:'CAPTURE_CONTEXT_CONFLICT'});
  await expect(completeCaptureSession(h.db,clock,seller,proofId,session.id,{...intent,recordedDurationMs:NaN})).rejects.toMatchObject({code:'INVALID_CAPTURE_CONTEXT'});
  const u=await upload(session.id);await h.objectStore.put(u.objectKey,media,'video/mp4');
  const committed=await commitEvidence(h.db,clock,h.objectStore,seller,proofId,u.evidenceId);
  expect(committed.proof.evidence[0].clientReportedCapture?.interrupted).toBe(true);
  expect(committed.proof.evidence[0].capturedDurationMs).toBe(200);
  await commitAttestation(h.db,clock,seller,proofId,{statement:'PACKED_DESCRIBED_ITEM',relatedEvidenceId:u.evidenceId});
  const final=await finalizeProof(h.db,clock,seller,proofId);
  expect((final.manifest.manifest as any).evidence[0].capture.clientReportedCapture).toEqual(first.clientReportedCapture);
  await expect(h.db.query('UPDATE capture_session_reports SET interrupted=false WHERE session_id=$1',[session.id])).rejects.toThrow('CAPTURE_REPORT_IMMUTABLE');
  expect((await finalizeProof(h.db,clock,seller,proofId)).manifest.sha256).toBe(final.manifest.sha256);
 });

});
