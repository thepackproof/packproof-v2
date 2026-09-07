import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { readFile } from 'node:fs/promises';
import { auth, createHarness, createUser, type TestHarness } from './helpers.js';
import { bindCaptureShipping, getCaptureShipping, shippingBarcode } from '../src/domain/capture-shipping.js';
import { createCaptureSession, completeCaptureSession, cancelCaptureSession } from '../src/domain/capture-sessions.js';
import { dispatchCaptureShipments } from '../src/workers/capture-shipment-worker.js';
import { createDefaultIntegrationRegistry } from '../src/integrations/registry.js';
import { createEasyPostTrackerClient } from '../src/integrations/easypost/client.js';
import { trackerFixture, trackingDetail } from './fixtures/easypost.js';
import { initializeEvidenceUpload, commitEvidence } from '../src/domain/evidence.js';
import { commitAttestation } from '../src/domain/attestations.js';
import { finalizeProof } from '../src/domain/finalize.js';
import { sha256Hex } from '../src/hash.js';

const tracking = '1Z999AA10123456784';
const scan = {rawValue:tracking,format:'CODE_128',detectedAtMs:100,idempotencyKey:'scan-1',confirmed:true};
describe('capture shipping identity and durable carrier registration',()=>{
  let h:TestHarness,seller:string,other:string,proofId:string,transactionId:string,sessionId:string;
  let now:Date,createCalls:number,getCalls:number,responseStatus:number,responseCode:string;
  const clock = {now:()=>new Date(now)};
  let integrations:ReturnType<typeof createDefaultIntegrationRegistry>;
  beforeEach(async()=>{
    now=new Date('2026-09-05T12:00:00Z');createCalls=0;getCalls=0;responseStatus=201;responseCode=tracking;
    integrations=createDefaultIntegrationRegistry(clock,{easypostClient:createEasyPostTrackerClient({async request(input){
      if(input.method==='POST')createCalls++;else getCalls++;
      return {status:responseStatus,json:trackerFixture({trackingCode:responseCode,status:'in_transit',weight:16,details:[trackingDetail({status:'in_transit',datetime:'2026-09-05T11:00:00Z'})]})};
    }})});
    h=await createHarness(clock,{integrations});seller=await createUser(h);other=await createUser(h);
    const t=await request(h.app).post('/transactions').set(auth(seller)).send({itemTitle:'Packed camera'});transactionId=t.body.transactionId;
    const p=await request(h.app).post(`/transactions/${transactionId}/proof`).set(auth(seller)).send({});proofId=p.body.proofId;
    sessionId=(await createCaptureSession(h.db,clock,seller,proofId,{client:'NATIVE_CAMERA',idempotencyKey:'camera'})).id;
  });
  afterEach(async()=>{await h.close();});
  const bind=(patch={})=>bindCaptureShipping(h.db,clock,seller,proofId,sessionId,{...scan,...patch});
  function deps(){return {integrations,credentials:h.credentialStore,defaultEasyPostCredentialReference:'memory:camera-easypost'};}
  function credentials(){h.credentialStore.put({adapterKey:'easypost-tracker',credentialReference:'memory:camera-easypost',material:{apiKey:'EZTK_fixture',mode:'test'}});}

  it('binds once, preserves provenance, and prevents all shipping edit paths from replacing identity',async()=>{
    const first=await bind();expect(first.status).toBe('BOUND');expect(await bind()).toEqual(first);
    await expect(bind({detectedAtMs:101})).rejects.toMatchObject({code:'SHIPPING_SCAN_CONFLICT'});
    await expect(bind({rawValue:'1Z999AA10123456785',idempotencyKey:'other'})).rejects.toMatchObject({code:'SHIPPING_LABEL_CONFLICT'});
    const edit=await request(h.app).patch(`/transactions/${transactionId}/shipping`).set(auth(seller)).send({trackingNumber:'replacement'});
    expect(edit.status).toBe(409);
    await expect(h.db.query('UPDATE transaction_shipping SET tracking_number=$2 WHERE transaction_id=$1',[transactionId,'other'])).rejects.toThrow('CAPTURE_SHIPPING_IMMUTABLE');
    await expect(h.db.query('DELETE FROM capture_shipping_labels WHERE proof_id=$1',[proofId])).rejects.toThrow('CAPTURE_SHIPPING_IMMUTABLE');
    expect((await getCaptureShipping(h.db,proofId))?.observations).toHaveLength(1);
    expect(createCalls).toBe(0); // Recording path never waits on EasyPost.
    expect((await request(h.app).get(`/proofs/${proofId}`).set(auth(seller))).body.captureShipping.source).toBe('PACKPROOF_CAPTURE');
  });
  it('authorizes actor, Proof, native session and recovery window before binding',async()=>{
    await expect(bindCaptureShipping(h.db,clock,other,proofId,sessionId,scan)).rejects.toMatchObject({code:'PARTICIPANT_NOT_AUTHORIZED'});
    await expect(bindCaptureShipping(h.db,clock,seller,proofId,'cap_unknown',scan)).rejects.toMatchObject({code:'CAPTURE_SESSION_NOT_FOUND'});
    const web=(await createCaptureSession(h.db,clock,seller,proofId,{client:'WEB_CAMERA',idempotencyKey:'web'})).id;
    await expect(bindCaptureShipping(h.db,clock,seller,proofId,web,scan)).rejects.toMatchObject({code:'SHIPPING_SCAN_SESSION_INVALID'});
    await cancelCaptureSession(h.db,clock,seller,proofId,sessionId);
    await expect(bind()).rejects.toMatchObject({code:'SHIPPING_SCAN_SESSION_INVALID'});
    const s=await createCaptureSession(h.db,clock,seller,proofId,{client:'NATIVE_CAMERA',idempotencyKey:'later'});
    now=new Date(now.getTime()+8*86400000);
    await expect(bindCaptureShipping(h.db,clock,seller,proofId,s.id,scan)).rejects.toMatchObject({code:'SHIPPING_SCAN_SESSION_EXPIRED'});
  });
  it('requires confirmation for ambiguous identifiers and strips supported USPS routing prefixes',async()=>{
    expect(shippingBarcode('420902109400100000000000000000')).toMatchObject({trackingNumber:'9400100000000000000000',carrierHint:'USPS'});
    expect(shippingBarcode('https://example.com/address')).toBeNull();
    expect(shippingBarcode('9612345678901234567890123456789012')).toBeNull();
    expect((await bind({rawValue:'123456789012',confirmed:false})).status).toBe('NEEDS_CONFIRMATION');
    expect(await getCaptureShipping(h.db,proofId)).toBeNull();
    expect((await bind({rawValue:'123456789012',confirmed:true})).status).toBe('BOUND');
    expect((await getCaptureShipping(h.db,proofId))?.observations[0].participantConfirmed).toBe(true);
  });
  it('retries provider outages durably, reuses the tracker, and appends carrier events and weight',async()=>{
    credentials();await bind();responseStatus=503;
    expect(await dispatchCaptureShipments(h.db,clock,deps())).toEqual({completed:0,failed:1});
    expect((await getCaptureShipping(h.db,proofId))?.registration.state).toBe('RETRY');
    responseStatus=201;now=new Date(now.getTime()+120000);
    expect(await dispatchCaptureShipments(h.db,clock,deps())).toEqual({completed:1,failed:0});
    expect(createCalls).toBe(2);
    const first=await request(h.app).get(`/proofs/${proofId}`).set(auth(seller));
    expect(first.body.captureShipping.registration).toMatchObject({state:'REGISTERED',carrier:'UPS',mode:'test'});
    expect(first.body.shipmentObservations.events.some((e:any)=>e.eventType==='WEIGHT_RECORDED' && e.source==='SHIPPING_PROVIDER_API')).toBe(true);
    const count=first.body.shipmentObservations.events.length;
    now=new Date(now.getTime()+6*3600000);
    await dispatchCaptureShipments(h.db,clock,deps());expect(getCalls).toBe(1);
    expect((await request(h.app).get(`/proofs/${proofId}`).set(auth(seller))).body.shipmentObservations.events).toHaveLength(count);
  });
  it('retains identity with missing credentials and rejects a provider response for another package',async()=>{
    await bind();await dispatchCaptureShipments(h.db,clock,deps());
    expect((await getCaptureShipping(h.db,proofId))?.registration.state).toBe('WAITING_FOR_CONNECTION');
    expect(createCalls).toBe(0);
    credentials();responseCode='1Z999AA10123456785';now=new Date(now.getTime()+3600000);
    await dispatchCaptureShipments(h.db,clock,deps());
    expect((await getCaptureShipping(h.db,proofId))?.registration).toMatchObject({state:'FAILED',errorCode:'PROVIDER_RESPONSE_INVALID'});
    expect((await h.db.query('SELECT id FROM shipment_events WHERE transaction_id=$1',[transactionId])).rows).toHaveLength(0);
  });
  it('links the observation to committed video and keeps the frozen manifest unchanged when tracking arrives',async()=>{
    const first=await bind();
    const media=await readFile(new URL('./fixtures/camera-recording.mp4',import.meta.url));
    await expect(completeCaptureSession(h.db,clock,seller,proofId,sessionId,{sha256:sha256Hex(media),byteSize:media.length,contentType:'video/mp4',recordedDurationMs:10})).rejects.toMatchObject({code:'CAPTURE_CONTEXT_CONFLICT'});
    await completeCaptureSession(h.db,clock,seller,proofId,sessionId,{sha256:sha256Hex(media),byteSize:media.length,contentType:'video/mp4',recordedDurationMs:200});
    const upload=await initializeEvidenceUpload(h.db,clock,h.objectStore,seller,proofId,{contentType:'video/mp4',evidenceType:'FULFILLMENT_CAPTURE',captureSessionId:sessionId,idempotencyKey:'video'});
    await h.objectStore.put(upload.objectKey,media,'video/mp4');await commitEvidence(h.db,clock,h.objectStore,seller,proofId,upload.evidenceId);
    await commitAttestation(h.db,clock,seller,proofId,{statement:'PACKED_DESCRIBED_ITEM'});
    const frozen=await finalizeProof(h.db,clock,seller,proofId);
    credentials();await dispatchCaptureShipments(h.db,clock,deps());
    expect((await finalizeProof(h.db,clock,seller,proofId)).manifest.sha256).toBe(frozen.manifest.sha256);
    expect((await getCaptureShipping(h.db,proofId))?.observations[0].evidenceId).toBe(upload.evidenceId);
    expect(await bind()).toEqual(first);
    await expect(bind({idempotencyKey:'new-after-finalize'})).rejects.toMatchObject({code:'PROOF_ALREADY_FINALIZED'});
  });
});
