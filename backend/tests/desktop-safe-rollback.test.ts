import {afterAll,beforeAll,describe,expect,it} from 'vitest';
import request from 'supertest';
import {auth,createHarness,createUser,type TestHarness} from './helpers.js';
import {registerDesktopCapture} from '../src/domain/capture-sessions.js';

let h:TestHarness,seller:string,other:string;
beforeAll(async()=>{h=await createHarness({now:()=>new Date('2026-09-27T12:00:00Z')});seller=await createUser(h);other=await createUser(h);},30000);
afterAll(async()=>{await h.close();});
async function proof(){const t=await request(h.app).post('/transactions').set(auth(seller)).send({itemTitle:'Rollback fixture'});const p=await request(h.app).post(`/transactions/${t.body.transactionId}/proof`).set(auth(seller)).send({});expect(p.status).toBe(200);return p.body.proofId as string;}
const recording={idempotencyKey:'existing-registration',sha256:'a'.repeat(64),byteSize:1024,contentType:'video/webm',recordedDurationMs:1000,interrupted:false,desktopContext:{schemaVersion:1,installationId:'rollback-fixture',appVersion:'1.0.0',platform:'win32',captureStartedAt:'2026-09-26T12:00:00.000Z',captureEndedAt:'2026-09-26T12:00:01.000Z',offline:true}};

describe('desktop-aware rollback admission boundary',()=>{
  it('advertises paused admission and refuses new registration without sessions or allowance reservations',async()=>{
    const id=await proof();
    const capabilities=await request(h.app).get('/capabilities');
    expect(capabilities.body.desktopCapture).toMatchObject({registrationVersions:[1],registrationEnabled:false,admissionState:'PAUSED',recoveryVersions:[1],timingProvenance:'CLIENT_REPORTED_NOT_INDEPENDENTLY_VERIFIED'});
    const response=await request(h.app).post(`/proofs/${id}/capture-sessions/desktop-registration`).set(auth(seller)).set('Idempotency-Key','new-recording').send(recording);
    expect(response.status).toBe(503);expect(response.body.error.code).toBe('DESKTOP_CAPTURE_ADMISSION_PAUSED');expect(response.headers['retry-after']).toBe('300');
    expect((await h.db.query('SELECT id FROM capture_sessions WHERE proof_id=$1',[id])).rows).toHaveLength(0);
    expect((await h.db.query('SELECT proof_id FROM billing_capture_reservations WHERE proof_id=$1',[id])).rows).toHaveLength(0);
    expect((await request(h.app).get(`/proofs/${id}`).set(auth(seller))).body.status).toBe('READY_FOR_EVIDENCE');
  });
  it('also blocks registration replay but keeps known-session recovery and originating-account boundaries',async()=>{
    const id=await proof();
    // A row that was accepted before rollback; no HTTP admission is enabled.
    const prior=await registerDesktopCapture(h.db,h.clock,seller,id,recording);
    const replay=await request(h.app).post(`/proofs/${id}/capture-sessions/desktop-registration`).set(auth(seller)).set('Idempotency-Key',recording.idempotencyKey).send(recording);
    expect(replay.status).toBe(503);
    const recovery=await request(h.app).post(`/proofs/${id}/capture-sessions/${prior.id}/recover`).set(auth(seller)).send({});
    expect(recovery.status).toBe(200);expect(recovery.body).toMatchObject({id:prior.id,state:'RECORDED',sha256:recording.sha256,byteSize:recording.byteSize,client:'DESKTOP_CAMERA',registrationTiming:'POST_CAPTURE_CLIENT_REPORTED',clientReportedCapture:{desktopContext:recording.desktopContext}});
    expect((await request(h.app).post(`/proofs/${id}/capture-sessions/${prior.id}/recover`).set(auth(other)).send({})).status).toBe(404);
    expect((await h.db.query('SELECT id FROM capture_sessions WHERE proof_id=$1',[id])).rows).toHaveLength(1);
  });
  it('preserves ordinary web/native admission and does not permit a desktop preauthorization bypass',async()=>{
    const id=await proof();
    for(const client of ['WEB_CAMERA','NATIVE_CAMERA']){
      const response=await request(h.app).post(`/proofs/${id}/capture-sessions`).set(auth(seller)).send({client,idempotencyKey:client});
      expect(response.status).toBe(201);expect(response.body).toMatchObject({client,state:'ISSUED',policyVersion:'packproof.direct-capture/v1'});
    }
    const desktop=await request(h.app).post(`/proofs/${id}/capture-sessions`).set(auth(seller)).send({client:'DESKTOP_CAMERA',surface:'DESKTOP',idempotencyKey:'bypass'});
    expect(desktop.status).toBe(400);expect(desktop.body.error.code).toBe('CAPTURE_CLIENT_REQUIRED');
  });
});
