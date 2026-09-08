import {afterEach,beforeEach,describe,expect,it} from 'vitest';
import request from 'supertest';
import {createHarness,createUser,auth,type TestHarness} from './helpers.js';
import {createServerApp} from '../src/server-app.js';
import {BearerUserAdapter} from '../src/auth/adapter.js';
import {submitIntakeObservation,type IntakeObservationInput} from '../src/intake/context.js';
import {createTransaction} from '../src/domain/transactions.js';
import {createOrGetProof} from '../src/domain/create-proof.js';
import {enrollConfiguredIntakeCohort,type IntakeRuntimeConfig} from '../src/intake/runtime-config.js';
import {createIntakeMailJobs} from '../src/intake/mail-runtime.js';

describe('intake HTTP boundary and compatible admission',()=>{
 let h:TestHarness;let seller:string;let other:string;let app:ReturnType<typeof createServerApp>;let config:IntakeRuntimeConfig;
 const scope={provider:'ebay',externalAccountReference:'boundary-store',namespaceSource:'MARKETPLACE_API' as const,connectionId:'boundary-connection',verified:true as const};
 const source=(id:string,complete=true):IntakeObservationInput=>({receiptId:`receipt-${id}`,sourceKind:'API_OBSERVED',adapterKey:'fixture-orders',adapterVersion:'1',externalOrderId:id,orderReference:id,items:[{title:'Camera lens',quantity:complete?1:null}],physicalFulfillment:true,paid:true,cancelled:false,fulfillmentScope:'FULL_ORDER'});
 beforeEach(async()=>{
  h=await createHarness();seller=await createUser(h);other=await createUser(h);
  config={enabled:true,actorIds:[seller],handoffEnabled:true,browserEnabled:true,emailEnabled:false,shippoEnabled:false,mailDomain:null};
  app=createServerApp({db:h.db,objectStore:h.objectStore,clock:h.clock,auth:new BearerUserAdapter(h.db),publicBaseUrl:'http://127.0.0.1',devAuth:true,intake:config});
 });
 afterEach(async()=>{await h.close();});
 it('pairs a device and exposes the client wire shape; claims replay safely after flag-off and revocation works through mobile POST',async()=>{
  expect((await request(app).get('/me/intake/devices')).status).toBe(401);
  const registered=await request(app).post('/me/intake/devices').set(auth(seller)).send({name:'Recording phone'});
  expect(registered.status).toBe(201);expect(registered.body.device.id).toBeTruthy();expect(registered.body.deviceToken).toBeTruthy();
  const id=registered.body.device.id,token=registered.body.deviceToken;
  const listed=await request(app).get('/me/intake/devices').set(auth(seller));
  expect(listed.status).toBe(200);expect(Array.isArray(listed.body.devices)).toBe(true);expect(listed.body.devices[0].id).toBe(id);expect(JSON.stringify(listed.body)).not.toContain(token);
  config.actorIds=[seller,other]; // Exercise ownership after the cohort admission gate.
  expect((await request(app).post(`/me/intake/devices/${id}/approve`).set(auth(other)).send({pairingCode:registered.body.pairingCode})).status).toBe(404);
  expect((await request(app).post(`/me/intake/devices/${id}/approve`).set(auth(seller)).send({pairingCode:registered.body.pairingCode})).body.device.approved).toBe(true);
  const order=await submitIntakeObservation(h.db,h.clock,seller,source('handoff'),scope);
  const prepared=await request(app).post('/me/intake/orders/prepare').set(auth(seller)).send({transactionId:order.transactionId});
  expect(prepared.status).toBe(200);expect(prepared.body.snapshot.id).toBe(order.snapshot!.id);
  const sent=await request(app).post('/me/intake/handoffs').set(auth(seller)).send({snapshotId:order.snapshot!.id,targetDeviceId:id,idempotencyKey:'send'});
  expect(sent.status).toBe(201);expect(sent.body.handoff.orderSnapshot.id).toBe(order.snapshot!.id);
  const pending=await request(app).get(`/me/intake/handoffs?deviceId=${id}`).set(auth(seller)).set('x-intake-device-token',token);
  expect(pending.body.handoffs[0].id).toBe(sent.body.handoff.id);
  const claim=()=>request(app).post(`/me/intake/handoffs/${sent.body.handoff.id}/claim`).set(auth(seller)).set('x-intake-device-token',token).send({deviceId:id,idempotencyKey:'accept',client:'NATIVE_CAMERA'});
  const accepted=await claim();expect(accepted.status).toBe(200);expect(accepted.body.session.proofId).toBe(order.proofId);expect(accepted.body.session.orderSnapshotId).toBe(order.snapshot!.id);expect(accepted.body.orderSnapshot.id).toBe(order.snapshot!.id);
  config.enabled=false;
  expect((await claim()).body).toEqual(accepted.body);
  const recovered=await request(app).get(`/me/intake/handoffs?deviceId=${id}`).set(auth(seller)).set('x-intake-device-token',token);
  expect(recovered.body.handoffs).toEqual([]);expect(recovered.body.activeCapture.session.id).toBe(accepted.body.session.id);
  expect((await request(app).post(`/me/intake/devices/${id}/revoke`).set(auth(seller)).send({})).body.revoked).toBe(true);
  expect((await claim()).status).toBe(403);
 });
 it('returns pinned direct-capture context, permits accepted retries and blocks unbound resolution admission while paused',async()=>{
  const order=await submitIntakeObservation(h.db,h.clock,seller,source('direct'),scope);
  const incomplete=await submitIntakeObservation(h.db,h.clock,seller,source('incomplete',false),scope);
  const accepted=await request(app).post(`/me/intake/orders/${order.snapshot!.id}/capture`).set(auth(seller)).send({idempotencyKey:'record',client:'WEB_CAMERA'});
  expect(accepted.status).toBe(200);expect(accepted.body).toMatchObject({proofId:order.proofId,transactionId:order.transactionId,orderSnapshot:{id:order.snapshot!.id},session:{orderSnapshotId:order.snapshot!.id,client:'WEB_CAMERA'}});
  config.enabled=false;
  const retried=await request(app).post(`/me/intake/orders/${order.snapshot!.id}/capture`).set(auth(seller)).send({idempotencyKey:'record',client:'WEB_CAMERA'});
  expect(retried.status).toBe(200);expect(retried.body.session.id).toBe(accepted.body.session.id);
  const resolved=await request(app).post(`/me/intake/observations/${incomplete.observationId}/resolve`).set(auth(seller)).send({receiptId:'resolve-paused',items:[{title:'Camera lens',quantity:1}],reason:'Verified the purchased quantity'});
  expect(resolved.status).toBe(409);expect(resolved.body.error.code).toBe('INTAKE_PAUSED');
  expect((await h.db.query('SELECT proof_id FROM intake_delivery_receipts WHERE observation_id=$1',[incomplete.observationId])).rows[0].proof_id).toBeNull();
 });
 it('negotiates only new merchant Proofs and preserves two-step peer creation and existing Proof retrieval',async()=>{
  const oldTransaction=await createTransaction(h.db,h.clock,seller,{itemTitle:'Existing order'});
  const oldProof=await createOrGetProof(h.db,h.clock,seller,oldTransaction.transactionId);
  await enrollConfiguredIntakeCohort(h.db,config);
  const blocked=await request(app).post('/proofs').set(auth(seller)).send({transaction:{itemTitle:'New merchant order'}});
  expect(blocked.status).toBe(409);expect(blocked.body.error.code).toBe('INTAKE_CLIENT_UPDATE_REQUIRED');
  const capable=await request(app).post('/proofs').set(auth(seller)).set('X-PackProof-Intake-Version','1').send({transaction:{itemTitle:'Capable merchant order'}});
  expect(capable.status).toBe(201);expect((await h.db.query('SELECT contract_version FROM proof_order_contexts WHERE proof_id=$1',[capable.body.proofId])).rows[0].contract_version).toBe(1);
  const peerTransaction=await request(app).post('/transactions').set(auth(seller)).send({itemTitle:'Peer exchange'});
  expect(peerTransaction.status).toBe(201);
  const peer=await request(app).post(`/transactions/${peerTransaction.body.transactionId}/proof`).set(auth(seller)).send({participationPolicy:'COUNTERPARTY_REQUIRED'});
  expect(peer.status).toBe(200);expect((await h.db.query('SELECT proof_id FROM proof_order_contexts WHERE proof_id=$1',[peer.body.proofId])).rows).toEqual([]);
  const old=await request(app).post(`/transactions/${oldTransaction.transactionId}/proof`).set(auth(seller)).send({});
  expect(old.status).toBe(200);expect(old.body.proofId).toBe(oldProof.proofId);
  expect((await h.db.query('SELECT proof_id FROM proof_order_contexts WHERE proof_id=$1',[oldProof.proofId])).rows).toEqual([]);
 });
 it('does not start mail processing for global flag-off or an empty cohort',()=>{
  expect(createIntakeMailJobs(h.db,h.clock,{PACKPROOF_INTAKE_EMAIL:'true',PACKPROOF_INTAKE_ENABLED:'false',PACKPROOF_INTAKE_ACTOR_IDS:seller})).toEqual([]);
  expect(createIntakeMailJobs(h.db,h.clock,{PACKPROOF_INTAKE_EMAIL:'true',PACKPROOF_INTAKE_ENABLED:'true'})).toEqual([]);
 });
});
