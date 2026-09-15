import {beforeAll,afterAll,it,expect} from 'vitest';
import request from 'supertest';
import {createHarness,createUser,auth,prepareCameraCapture,commitProofEvidence,type TestHarness} from './helpers.js';
import {initializeEvidenceUpload} from '../src/domain/evidence.js';
import {cancelCaptureSession} from '../src/domain/capture-sessions.js';
let h:TestHarness,seller:string,other:string;
beforeAll(async()=>{h=await createHarness();seller=await createUser(h);other=await createUser(h);});
afterAll(async()=>{await h.close();});
async function proof(){const t=await request(h.app).post('/transactions').set(auth(seller)).send({itemTitle:'Recovery fixture'});const p=await request(h.app).post(`/transactions/${t.body.transactionId}/proof`).set(auth(seller)).send({});expect(p.status).toBe(200);return p.body.proofId as string;}
it('discard by evidence identity closes only its original pending session and is replayable',async()=>{
  const id=await proof(),otherProof=await proof();const c=await prepareCameraCapture(h,seller,id,'discard-capture');
  const input={contentType:'video/mp4',evidenceType:'FULFILLMENT_CAPTURE',captureSessionId:c.captureSessionId,idempotencyKey:'discard-upload'};
  const upload=await initializeEvidenceUpload(h.db,h.clock,h.objectStore,seller,id,input);
  const discard=(actor=seller,target=id)=>request(h.app).post(`/proofs/${target}/evidence/discard`).set(auth(actor)).send({evidenceId:upload.evidenceId});
  expect((await discard(other)).status).toBe(403);expect((await discard(seller,otherProof)).status).toBe(404);
  expect((await discard()).status).toBe(200);expect((await discard()).status).toBe(200);
  expect((await h.db.query('SELECT validation_status FROM evidence WHERE id=$1',[upload.evidenceId])).rows[0]).toMatchObject({validation_status:'REJECTED'});
  expect((await h.db.query('SELECT state FROM capture_sessions WHERE id=$1',[c.captureSessionId])).rows[0]).toMatchObject({state:'CANCELLED'});
  expect((await h.db.query('SELECT state FROM evidence_upload_admissions WHERE evidence_id=$1',[upload.evidenceId])).rows[0]).toMatchObject({state:'DISCARDED'});
  await expect(initializeEvidenceUpload(h.db,h.clock,h.objectStore,seller,id,input)).rejects.toBeDefined();
});
it('discard and session cancellation cannot change committed evidence or reopen its session',async()=>{
  const id=await proof();const committed=await commitProofEvidence(h,seller,id,{evidenceType:'FULFILLMENT_CAPTURE',idempotencyKey:'keep-committed'});
  const res=await request(h.app).post(`/proofs/${id}/evidence/discard`).set(auth(seller)).send({evidenceId:committed.evidenceId});
  expect(res.status).toBe(409);expect(res.body.error.code).toBe('EVIDENCE_ALREADY_COMMITTED');
  const session=(await h.db.query<{id:string}>('SELECT id FROM capture_sessions WHERE evidence_id=$1',[committed.evidenceId])).rows[0];
  await expect(h.db.query("UPDATE capture_sessions SET state='UPLOADING' WHERE id=$1",[session.id])).rejects.toThrow('CAPTURE_SESSION_IMMUTABLE');
  await expect(cancelCaptureSession(h.db,h.clock,seller,id,session.id)).rejects.toMatchObject({code:'EVIDENCE_ALREADY_COMMITTED'});
  expect((await h.db.query('SELECT validation_status FROM evidence WHERE id=$1',[committed.evidenceId])).rows[0]).toMatchObject({validation_status:'COMMITTED'});
});
