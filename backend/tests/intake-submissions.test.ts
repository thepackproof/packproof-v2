import {randomUUID} from 'node:crypto';
import {afterEach,beforeEach,describe,expect,it} from 'vitest';
import request from 'supertest';
import {createHarness,createUser,auth,type TestHarness} from './helpers.js';
import {createServerApp} from '../src/server-app.js';
import {BearerUserAdapter} from '../src/auth/adapter.js';
import {createTransaction} from '../src/domain/transactions.js';
import {createOrGetProof} from '../src/domain/create-proof.js';
import {createIntegrationConnection} from '../src/domain/integration-connections.js';
import {submitIntakeObservation} from '../src/intake/context.js';
import {reconcileIntakeSubmissions} from '../src/intake/submissions.js';
import {classifySubmission,parseSubmissionEnvelope} from '../src/intake/submissions-contract.js';
import {createDefaultIntegrationRegistry} from '../src/integrations/registry.js';
import {IntegrationAdapterRegistry} from '../src/integrations/registry.js';
import {providerRateLimited} from '../src/domain/integration-errors.js';
import type {NormalizedFulfillmentOrder} from '../src/domain/normalized-fulfillment-order.js';
import type {IntakeRuntimeConfig} from '../src/intake/runtime-config.js';

describe('bounded durable mobile intake',()=>{
 let h:TestHarness,seller:string,other:string,app:ReturnType<typeof createServerApp>,config:IntakeRuntimeConfig,now:Date;
 const envelope=(text='Order: test-order',overrides:Record<string,unknown>={})=>({schemaVersion:1,clientSubmissionId:randomUUID(),surface:'ANDROID_SHARE',requestedAction:'QUEUE',payload:{kind:'TEXT',text},...overrides});
 async function existingOrder(owner=seller,reference='test-order'){
  const txn=await createTransaction(h.db,h.clock,owner,{externalReference:reference,itemTitle:'Comic collection',quantity:2,metadata:{intakeDeclaration:{physicalFulfillment:true,paid:true,fulfillmentScope:'FULL_ORDER'}}});
  const proof=await createOrGetProof(h.db,h.clock,owner,txn.transactionId);return {transactionId:txn.transactionId,proofId:proof.proofId};
 }
 beforeEach(async()=>{
  now=new Date('2026-09-15T12:00:00.000Z');h=await createHarness({now:()=>now});seller=await createUser(h);other=await createUser(h);
  config={enabled:true,actorIds:[seller,other],handoffEnabled:false,browserEnabled:false,emailEnabled:false,shippoEnabled:false,mailDomain:null};
  app=createServerApp({db:h.db,clock:h.clock,objectStore:h.objectStore,auth:new BearerUserAdapter(h.db),publicBaseUrl:'http://localhost',devAuth:true,intake:config});
 });
 afterEach(async()=>{await h.close();});
 it('converges on one existing Proof; retries preserve actor/client identity and survive paused admission',async()=>{
  const canonical=await existingOrder();const body=envelope();
  const first=await request(app).post('/me/intake/submissions').set(auth(seller)).send(body);
  expect(first.status).toBe(201);expect(first.body).toMatchObject({...canonical,state:'READY',nextAction:'RECORD_PACKING'});
  expect((await h.db.query('SELECT raw_text FROM intake_submissions WHERE id=$1',[first.body.submissionId])).rows[0].raw_text).toBeNull();
  config.enabled=false;
  const replay=await request(app).post('/me/intake/submissions').set(auth(seller)).send(body);expect(replay.status).toBe(200);expect(replay.body).toEqual(first.body);
  const changed=await request(app).post('/me/intake/submissions').set(auth(seller)).send({...body,payload:{kind:'TEXT',text:'Order: changed'}});
  expect(changed.status).toBe(409);expect(changed.body.error.code).toBe('IDEMPOTENCY_CONFLICT');
  expect((await request(app).post('/me/intake/submissions').set(auth(seller)).send(envelope())).body.error.code).toBe('INTAKE_PAUSED');
  expect((await request(app).get(`/me/intake/submissions/${first.body.submissionId}`).set(auth(other))).status).toBe(404);
  expect((await h.db.query('SELECT id FROM proofs')).rows).toHaveLength(1);
 });
 it('does not confuse product listings with sales and reauthorizes server-issued candidate selection',async()=>{
  const canonical=await existingOrder();await existingOrder(other,'other-order');
  const first=await request(app).post('/me/intake/submissions').set(auth(seller)).send(envelope('Item: Comic collection'));
  expect(first.body.state).toBe('NEEDS_SELECTION');expect(first.body.proofId).toBeNull();expect(first.body.candidates).toHaveLength(1);
  const route=`/me/intake/submissions/${first.body.submissionId}/resolve`;
  expect((await request(app).post(route).set(auth(other)).send({candidateId:first.body.candidates[0].candidateId})).status).toBe(404);
  expect((await request(app).post(route).set(auth(seller)).send({candidateId:'other-candidate'})).status).toBe(404);
  const resolved=await request(app).post(route).set(auth(seller)).send({candidateId:first.body.candidates[0].candidateId});expect(resolved.body).toMatchObject({...canonical,state:'READY'});
  expect((await request(app).post(route).set(auth(seller)).send({candidateId:first.body.candidates[0].candidateId})).body).toEqual(resolved.body);
  expect((await request(app).post(route).set(auth(seller)).send({candidateId:'other'})).status).toBe(409);
  const listing=classifySubmission(parseSubmissionEnvelope(envelope('https://www.ebay.com/itm/123456?orderid=test-order',{payload:{kind:'URL',text:'https://www.ebay.com/itm/123456?orderid=test-order'}})));
  expect(listing).toMatchObject({listing:true,reference:null,provider:'ebay'});
 });
 it('keeps same order IDs in different stores ambiguous and candidates actor scoped',async()=>{
  for(const store of ['shop-a','shop-b'])await submitIntakeObservation(h.db,h.clock,seller,{receiptId:store,sourceKind:'API_OBSERVED',adapterKey:'fixture',adapterVersion:'1',externalOrderId:'same-id',orderReference:'same-id',items:[{title:'Comic',quantity:1}],physicalFulfillment:true,paid:true,cancelled:false,fulfillmentScope:'FULL_ORDER'},{provider:'ebay',externalAccountReference:store,namespaceSource:'MARKETPLACE_API',connectionId:store,verified:true});
  const result=await request(app).post('/me/intake/submissions').set(auth(seller)).send(envelope('Order: same-id',{hints:{provider:'ebay'}}));
  expect(result.status).toBe(201);expect(result.body.state).toBe('NEEDS_SELECTION');expect(result.body.candidates).toHaveLength(2);expect(result.body.proofId).toBeNull();
  const connection=await createIntegrationConnection(h.db,h.clock,other,{adapterKey:'ebay',provider:'ebay',externalAccountReference:'other-store',credentialReference:'fixture'});
  const forbidden=await request(app).post('/me/intake/submissions').set(auth(seller)).send(envelope('Order: same-id',{hints:{provider:'ebay',connectionId:connection.connectionId}}));
  expect(forbidden.status).toBe(404);expect(forbidden.body.error.code).toBe('INTAKE_CONNECTION_NOT_FOUND');
 });
 it('accepts owned links only after authorization, never exposing another seller Proof',async()=>{
  const canonical=await existingOrder(other,'private-order');
  const result=await request(app).post('/me/intake/submissions').set(auth(seller)).send(envelope(`https://thepackproof.com/app/proofs/${canonical.proofId}`));
  expect(result.body.state).toBe('INVALID');expect(result.body.proofId).toBeNull();expect(result.body.candidates).toEqual([]);
 });
 it.each([
  [{ownerId:'forged'},'INVALID_INTAKE'],
  [{payload:{kind:'TEXT',text:'x'.repeat(20001)}},'INPUT_TOO_LARGE'],
  [{payload:{kind:'TEXT',text:'😀'.repeat(10000)+'x'}},'INPUT_TOO_LARGE'],
  [{payload:{kind:'URL',text:'javascript:alert(1)'}},'INVALID_INTAKE_URL'],
  [{payload:{kind:'URL',text:'https://secret@example.com/order'}},'INVALID_INTAKE_URL'],
  [{payload:{kind:'IMAGE',text:'unsupported'}},'INVALID_INTAKE'],
  [{hints:{provider:'ebay',provenance:'MARKETPLACE_API'}},'INVALID_INTAKE'],
  [{surface:['ANDROID_SHARE']},'INVALID_INTAKE'],
  [{payload:{kind:['TEXT'],text:'order'}},'INVALID_INTAKE'],
  [{hints:{provider:['ebay']}},'INVALID_INTAKE'],
 ])('rejects malformed/forged intake before persistence (case %#)',async(overrides,code)=>{
  const result=await request(app).post('/me/intake/submissions').set(auth(seller)).send(envelope('Order: test-order',overrides));
  expect(result.body.error.code).toBe(code);expect((await h.db.query('SELECT id FROM intake_submissions')).rows).toHaveLength(0);
 });
 it('enforces the byte boundary independently of the text character boundary',async()=>{
  const body=envelope('x');const serialized=JSON.stringify(body)+' '.repeat(65536);
  const result=await request(app).post('/me/intake/submissions').set(auth(seller)).set('Content-Type','application/json').send(serialized);
  expect(result.status).toBe(413);expect(result.body.error.code).toBe('INPUT_TOO_LARGE');
  const binary=await request(app).post('/me/intake/submissions').set(auth(seller)).set('Content-Type','application/octet-stream').send(Buffer.alloc(65537));
  expect(binary.status).toBe(415);expect(binary.body.error.code).toBe('UNSUPPORTED_INTAKE_CONTENT_TYPE');
 });
 it('creates participant-declared manual intake exactly once, without marking evidence or attestation',async()=>{
  const saved=await request(app).post('/me/intake/submissions').set(auth(seller)).send(envelope('Unknown source'));
  const body={confirmed:true,details:{itemTitle:'A comic',quantity:1,physicalFulfillment:true,paid:true,fulfillmentScope:'FULL_ORDER'}};
  const first=await request(app).post(`/me/intake/submissions/${saved.body.submissionId}/resolve`).set(auth(seller)).send(body);
  expect(first.status).toBe(200);expect(first.body.state).toBe('READY');
  const replay=await request(app).post(`/me/intake/submissions/${saved.body.submissionId}/resolve`).set(auth(seller)).send(body);expect(replay.body).toEqual(first.body);
  expect((await h.db.query('SELECT id FROM transactions')).rows).toHaveLength(1);expect((await h.db.query('SELECT id FROM evidence')).rows).toHaveLength(0);
  expect((await h.db.query('SELECT source FROM transaction_integration_identities')).rows[0].source).toBe('PARTICIPANT_SUPPLIED');
  expect((await request(app).post(`/me/intake/submissions/${saved.body.submissionId}/resolve`).set(auth(seller)).send({})).body).toMatchObject({state:'READY',proofId:first.body.proofId});
 });
 it('retains local-to-server recovery receipts and cleanup does not touch evidence or canonical records',async()=>{
  const saved=await request(app).post('/me/intake/submissions').set(auth(seller)).send(envelope('Unrecognized order text'));
  expect(saved.body.state).toBe('NEEDS_SELECTION');expect((await request(app).get('/me/intake/submissions').set(auth(seller))).body.submissions[0].submissionId).toBe(saved.body.submissionId);
  now=new Date(now.getTime()+8*86400000);config.enabled=false;
  await reconcileIntakeSubmissions(h.db,h.clock,{integrations:createDefaultIntegrationRegistry(h.clock),credentials:h.credentialStore},config);
  expect((await h.db.query('SELECT raw_text FROM intake_submissions')).rows[0].raw_text).toBeNull();
  expect((await request(app).post(`/me/intake/submissions/${saved.body.submissionId}/dismiss`).set(auth(seller)).send({})).body.state).toBe('DISMISSED');
  expect((await request(app).get('/me/intake/submissions').set(auth(seller))).body.submissions).toEqual([]);
 });
 it('recovers persisted provider work, backoff and abandoned leases with one canonical Proof',async()=>{
  let fail=true,calls=0;
  const order:NormalizedFulfillmentOrder={provider:'ebay',externalAccountReference:'worker-store',externalOrderId:'worker-order',externalReference:'worker-order',orderedAt:now.toISOString(),paymentState:'CONFIRMED',fulfillmentState:'AWAITING_FULFILLMENT',requiresPhysicalFulfillment:true,cancelled:false,items:[{externalItemId:'one',position:1,title:'Comic',description:null,sku:null,quantity:1,unitValue:20,currency:'USD'}],transactionValue:20,currency:'USD',buyer:null,shipping:null,providerUpdatedAt:now.toISOString(),provenance:{source:'MARKETPLACE_API',sourceRecordId:'worker-order'}};
  const integrations=new IntegrationAdapterRegistry();
  integrations.registerCommerce({adapterKey:'worker-ebay',provider:'ebay',displayName:'Fixture',kind:'trusted',listFulfillmentOrders:async()=>({orders:[],cursor:null}),fetchFulfillmentOrder:async()=>{calls++;if(fail)throw Object.assign(providerRateLimited(),{retryAfterSeconds:3600});return order;}});
  const connection=await createIntegrationConnection(h.db,h.clock,seller,{adapterKey:'worker-ebay',provider:'ebay',externalAccountReference:'worker-store',credentialReference:'fixture'});
  const commerce={integrations,credentials:{getCredentials:async()=>({adapterKey:'worker-ebay',credentialReference:'fixture',material:{accessToken:'not-a-real-token'}})}};
  const saved=await request(app).post('/me/intake/submissions').set(auth(seller)).send(envelope('Order: worker-order',{hints:{provider:'ebay',connectionId:connection.connectionId}}));
  expect(saved.status).toBe(202);expect(calls).toBe(0);
  await reconcileIntakeSubmissions(h.db,h.clock,commerce,config);
  expect((await request(app).get(`/me/intake/submissions/${saved.body.submissionId}`).set(auth(seller))).body).toMatchObject({state:'RETRYABLE_FAILED',retryable:true});
  expect(new Date((await h.db.query<{next_attempt_at:string}>('SELECT next_attempt_at FROM intake_submissions WHERE id=$1',[saved.body.submissionId])).rows[0].next_attempt_at).getTime()).toBe(now.getTime()+3600000);
  await reconcileIntakeSubmissions(h.db,h.clock,commerce,config);expect(calls).toBe(1);
  fail=false;now=new Date(now.getTime()+3600000);
  // Simulate a process dying after a lease was persisted. Another worker can reclaim only after expiry.
  await h.db.query("UPDATE intake_submissions SET state='RESOLVING',lease_token='abandoned',lease_expires_at=$2 WHERE id=$1",[saved.body.submissionId,new Date(now.getTime()-1).toISOString()]);
  await reconcileIntakeSubmissions(h.db,h.clock,commerce,config);
  const ready=await request(app).get(`/me/intake/submissions/${saved.body.submissionId}`).set(auth(seller));expect(ready.body.state).toBe('READY');expect(calls).toBe(2);
  const second=await request(app).post('/me/intake/submissions').set(auth(seller)).send(envelope('Order: worker-order',{surface:'IOS_SHARE',hints:{provider:'ebay'}}));
  expect(second.body.proofId).toBe(ready.body.proofId);expect((await h.db.query('SELECT id FROM proofs')).rows).toHaveLength(1);
  const abandoned=await request(app).post('/me/intake/submissions').set(auth(seller)).send(envelope('Another unknown input'));
  await h.db.query("UPDATE intake_submissions SET state='RESOLVING',attempt_count=6,lease_token='last-abandoned',lease_expires_at=$2 WHERE id=$1",[abandoned.body.submissionId,new Date(now.getTime()-1).toISOString()]);
  await reconcileIntakeSubmissions(h.db,h.clock,commerce,config);
  expect((await request(app).get(`/me/intake/submissions/${abandoned.body.submissionId}`).set(auth(seller))).body).toMatchObject({state:'NEEDS_SELECTION',errorCode:'INTAKE_RETRY_EXHAUSTED',retryable:false});
  let allowProvider!:()=>void,providerStarted!:()=>void;
  const deferred=new Promise<void>(resolve=>{allowProvider=resolve;});const started=new Promise<void>(resolve=>{providerStarted=resolve;});
  integrations.getCommerce('worker-ebay').fetchFulfillmentOrder=async({externalOrderId})=>{providerStarted();await deferred;return {...order,externalOrderId,externalReference:externalOrderId};};
  const willDismiss=await request(app).post('/me/intake/submissions').set(auth(seller)).send(envelope('Order: do-not-import',{hints:{provider:'ebay',connectionId:connection.connectionId}}));
  const inFlight=reconcileIntakeSubmissions(h.db,h.clock,commerce,config);await started;
  expect((await request(app).post(`/me/intake/submissions/${willDismiss.body.submissionId}/dismiss`).set(auth(seller)).send({})).body.state).toBe('DISMISSED');
  allowProvider();await inFlight;
  expect((await h.db.query('SELECT id FROM proofs')).rows).toHaveLength(1);
 });
 it('restricts iOS scoped sessions to their own create/read receipts, with expiry, revocation and account disable',async()=>{
  await existingOrder();
  const issued=await request(app).post('/me/intake/sessions').set(auth(seller)).send({});expect(issued.status).toBe(201);expect(issued.body.actorId).toBe(seller);
  const token=issued.body.token,headers={Authorization:`Bearer ${token}`};
  expect((await h.db.query('SELECT token_hash FROM intake_scoped_sessions')).rows[0].token_hash).not.toBe(token);
  const saved=await request(app).post('/me/intake/submissions').set(headers).send(envelope('Shared from iPhone',{surface:'IOS_SHARE'}));expect(saved.status).toBe(201);
  expect(saved.body.candidates).toEqual([]);
  expect((await request(app).get(`/me/intake/submissions/${saved.body.submissionId}`).set(headers)).body.candidates).toEqual([]);
  expect((await request(app).get(`/me/intake/submissions/${saved.body.submissionId}`).set(auth(seller))).body.candidates).toHaveLength(1);
  expect((await request(app).get(`/me/intake/submissions/${saved.body.submissionId}`).set(headers)).status).toBe(200);
  for(const path of ['/me/proofs','/me/intake/submissions','/me/intake/capabilities','/me/intake/sessions'])expect((await request(app).get(path).set(headers)).status).toBe(403);
  expect((await request(app).post(`/me/intake/submissions/${saved.body.submissionId}/resolve`).set(headers).send({})).status).toBe(403);
  const second=await request(app).post('/me/intake/sessions').set(auth(seller)).send({});
  expect((await request(app).get(`/me/intake/submissions/${saved.body.submissionId}`).set({Authorization:`Bearer ${second.body.token}`})).status).toBe(404);
  expect((await request(app).post(`/me/intake/sessions/${second.body.sessionId}/revoke`).set(headers).send({})).status).toBe(403);
  expect((await request(app).post(`/me/intake/sessions/${issued.body.sessionId}/revoke`).set(auth(other)).send({})).status).toBe(404);
  expect((await request(app).post(`/me/intake/sessions/${issued.body.sessionId}/revoke`).set(auth(seller)).send({})).body.revoked).toBe(true);
  expect((await request(app).get(`/me/intake/submissions/${saved.body.submissionId}`).set(headers)).status).toBe(401);
  const third=await request(app).post('/me/intake/sessions').set(auth(seller)).send({});
  expect((await request(app).post(`/me/intake/sessions/${third.body.sessionId}/revoke`).set({Authorization:`Bearer ${third.body.token}`}).send({})).body.revoked).toBe(true);
  now=new Date(now.getTime()+13*3600000);
  expect((await request(app).post('/me/intake/submissions').set({Authorization:`Bearer ${second.body.token}`}).send(envelope())).status).toBe(401);
  const fourth=await request(app).post('/me/intake/sessions').set(auth(seller)).send({});
  await h.db.query("UPDATE users SET status='DISABLED' WHERE id=$1",[seller]);
  expect((await request(app).post('/me/intake/submissions').set({Authorization:`Bearer ${fourth.body.token}`}).send(envelope())).status).toBe(401);
 });
});
