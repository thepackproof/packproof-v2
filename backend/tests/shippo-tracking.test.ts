import { afterEach, describe, expect, it } from 'vitest';
import { createHmac } from 'node:crypto';
import request from 'supertest';
import { auth, createHarness, createUser, type TestHarness } from './helpers.js';
import { createShippoShipmentAdapter, parseShippoCredentials, shippoCarrier, verifyShippoSignature } from '../src/integrations/shippo/adapter.js';
import { createShippoTrackingClient, type ShippoHttp } from '../src/integrations/shippo/client.js';
import { normalizeShippoTracking } from '../src/integrations/shippo/normalize.js';
import { createDefaultIntegrationRegistry } from '../src/integrations/registry.js';
import { createCaptureSession } from '../src/domain/capture-sessions.js';
import { bindCaptureShipping, getCaptureShipping } from '../src/domain/capture-shipping.js';
import { createIntegrationConnection, bindTransactionShipmentConnection } from '../src/domain/integration-connections.js';
import { dispatchCaptureShipments } from '../src/workers/capture-shipment-worker.js';

const tracking='1Z999AA10123456784', reference='memory:shippo-fixture';
const credentials={adapterKey:'shippo-tracker',credentialReference:reference,material:{apiKey:'shippo_live_fixture',mode:'production',webhookSecret:'fixture-secret',hmacProvisioned:'true'}};
const detail={status:'TRANSIT',status_date:'2026-09-05T11:00:00Z',status_details:'Departed facility',substatus:{code:'package_departed'},location:{city:'Chicago',state:'IL',country:'US'}};
const fixture=(overrides:Record<string,unknown>={})=>({carrier:'ups',tracking_number:tracking,test:false,tracking_status:{...detail,object_id:'current'},tracking_history:[{...detail,object_id:'history'}],...overrides});
const snapshotInput={trackingNumber:tracking,transactionId:'txn_fixture',externalTransactionId:null,carrier:'UPS',credentials};
const signature=(body:Buffer, timestamp=Math.floor(Date.now()/1000))=>`t=${timestamp},v1=${createHmac('sha256','fixture-secret').update(`${timestamp}.`).update(body).digest('hex')}`;

describe('Shippo tracking contract',()=>{
  it('normalizes history/current duplicates, timestamps, returns, and optional weight without inventing scans',()=>{
    const data=fixture({weight:[{value:'2.2',unit:'LB'},{value:'1',unit:'KG'}]});
    const snapshot=normalizeShippoTracking(data);
    expect(snapshot).toMatchObject({provider:'shippo',carrier:'ups',mode:'production'});
    expect(snapshot.observations).toHaveLength(2);
    expect(snapshot.observations[0]).toMatchObject({eventType:'DEPARTED_FACILITY',location:'Chicago, IL, US',eventData:{test:false}});
    expect(snapshot.observations[1].eventData).toMatchObject({value:2.2,unit:'lb',reportedBy:'carrier'});
    expect(normalizeShippoTracking(fixture({tracking_history:[],tracking_status:{status:'RETURNED',status_date:detail.status_date}})).observations[0].eventType).toBe('RETURN_TO_SENDER');
    expect(normalizeShippoTracking(fixture({tracking_history:[],tracking_status:{status:'DELIVERED'}})).observations).toEqual([]);
    expect(normalizeShippoTracking(fixture({tracking_history:[null,42],tracking_status:null})).observations).toEqual([]);
  });
  it('polls without webhook setup and only registers once a persisted cursor is available',async()=>{
    const calls:Parameters<ShippoHttp['request']>[0][]=[];
    const adapter=createShippoShipmentAdapter(createShippoTrackingClient({async request(input){calls.push(input);return {status:200,json:fixture()};}}));
    expect((await adapter.getTrackingSnapshot(snapshotInput)).providerCursor).toBeNull();
    expect(calls[0]).toMatchObject({method:'GET',path:`/tracks/ups/${tracking}`});
    const registering={...snapshotInput,credentials:{...credentials,material:{...credentials.material,registerWebhooks:'true'}}};
    const first=await adapter.getTrackingSnapshot(registering);
    expect(calls[1]).toMatchObject({method:'POST',body:{carrier:'ups',tracking_number:tracking,include_package_details:true}});
    await adapter.getTrackingSnapshot({...registering,providerCursor:first.providerCursor});
    expect(calls[2].method).toBe('GET');
  });
  it('rejects foreign package, carrier and mode responses before import',async()=>{
    for(const patch of [{tracking_number:'1Z999AA10123456785'},{carrier:'usps'},{test:true},{test:undefined}]) {
      const adapter=createShippoShipmentAdapter({async getTracking(){return fixture(patch);}});
      await expect(adapter.getTrackingSnapshot(snapshotInput)).rejects.toMatchObject({code:'PROVIDER_RESPONSE_INVALID'});
    }
    expect(()=>parseShippoCredentials({...credentials,material:{apiKey:'shippo_test_fixture',mode:'production'}})).toThrow();
    let called=false;
    const adapter=createShippoShipmentAdapter({async getTracking(){called=true;return fixture();}});
    await expect(adapter.getTrackingSnapshot({...snapshotInput,credentials:{...credentials,material:{apiKey:'shippo_test_fixture'}}})).rejects.toMatchObject({code:'SHIPPO_TEST_TRACKING_ONLY'});
    expect(called).toBe(false);
    expect(shippoCarrier(tracking)).toBe('ups');
    expect(shippoCarrier('123456789012','FedEx')).toBe('fedex');
    expect(()=>shippoCarrier('123456789012')).toThrow(/Choose a supported/);
  });
  it.each([[401,'PROVIDER_AUTH_FAILED'],[429,'PROVIDER_RATE_LIMITED'],[503,'PROVIDER_TEMPORARILY_UNAVAILABLE'],[404,'TRACKING_NOT_FOUND']])('maps HTTP %s to a safe error',async(status,code)=>{
    const client=createShippoTrackingClient({async request(){return {status:Number(status),json:{secret:'must not escape'}};}});
    await expect(client.getTracking({carrier:'ups',trackingNumber:tracking,apiKey:'fixture'})).rejects.toMatchObject({code});
  });
  it('authenticates raw webhook bytes and timestamp; rejects tampering, replay and mode confusion',async()=>{
    const body=Buffer.from(JSON.stringify({event:'track_updated',test:false,data:fixture()}));
    const headers={'shippo-auth-signature':signature(body)};
    const adapter=createShippoShipmentAdapter();
    const result=await adapter.verifyWebhook({headers,rawBody:body,credentials});
    expect(result.trackingNumber).toBe(tracking);
    expect(result.observations).toHaveLength(1);
    expect(result.observations[0].sourceEventId).toBe(normalizeShippoTracking(fixture()).observations[0].sourceEventId);
    expect(()=>verifyShippoSignature(headers,Buffer.concat([body,Buffer.from(' ')]),'fixture-secret')).toThrow();
    expect(()=>verifyShippoSignature({'shippo-auth-signature':signature(body,1_700_000_000)},body,'fixture-secret')).toThrow();
    await expect(adapter.verifyWebhook({headers,rawBody:body,credentials:{...credentials,material:{apiKey:'shippo_test_fixture',webhookSecret:'fixture-secret',hmacProvisioned:'true'}}})).rejects.toMatchObject({code:'PROVIDER_RESPONSE_INVALID'});
  });
});

describe('Shippo capture to Proof',()=>{
  let h:TestHarness|undefined;
  afterEach(async()=>{await h?.close();h=undefined;});
  it('selects Shippo, survives an outage, attaches carrier provenance, and dedupes later polls',async()=>{
    let now=new Date('2026-09-05T12:00:00Z'),status=503,calls=0;
    const clock={now:()=>now};
    const integrations=createDefaultIntegrationRegistry(clock,{shippoClient:createShippoTrackingClient({async request(){calls++;return {status,json:fixture()};}})});
    h=await createHarness(clock,{integrations});const seller=await createUser(h);
    const t=await request(h.app).post('/transactions').set(auth(seller)).send({itemTitle:'Shippo scan'});
    const transactionId=t.body.transactionId;
    const p=await request(h.app).post(`/transactions/${transactionId}/proof`).set(auth(seller)).send({});const proofId=p.body.proofId;
    const session=await createCaptureSession(h.db,clock,seller,proofId,{client:'NATIVE_CAMERA',idempotencyKey:'shippo-camera'});
    await bindCaptureShipping(h.db,clock,seller,proofId,session.id,{rawValue:tracking,format:'CODE_128',detectedAtMs:250,idempotencyKey:'shippo-scan',confirmed:true});
    await h.credentialStore.put(credentials);
    const deps={integrations,credentials:h.credentialStore,defaultShippoCredentialReference:reference,defaultEasyPostCredentialReference:'memory:legacy'};
    expect(await dispatchCaptureShipments(h.db,clock,deps)).toEqual({completed:0,failed:1});
    expect((await getCaptureShipping(h.db,proofId))?.registration.state).toBe('RETRY');
    status=200;now=new Date(now.getTime()+120000);
    expect(await dispatchCaptureShipments(h.db,clock,deps)).toEqual({completed:1,failed:0});
    const proof=(await request(h.app).get(`/proofs/${proofId}`).set(auth(seller))).body;
    expect(proof.shipmentSync.provider).toBe('shippo');
    expect(proof.captureShipping.registration).toMatchObject({state:'REGISTERED',mode:'production',carrier:'ups'});
    expect(proof.shipmentObservations.events).toHaveLength(1);
    expect(proof.shipmentObservations.events[0]).toMatchObject({provider:'shippo',source:'SHIPPING_PROVIDER_API'});
    now=new Date(now.getTime()+6*3600000);await dispatchCaptureShipments(h.db,clock,deps);
    expect(calls).toBe(3);
    expect((await request(h.app).get(`/proofs/${proofId}`).set(auth(seller))).body.shipmentObservations.events).toHaveLength(1);
    const body=Buffer.from(JSON.stringify({event:'track_updated',test:false,data:fixture()}));
    const hook=await request(h.app).post('/integrations/webhooks/shippo-tracker').set('Content-Type','application/json').set('shippo-auth-signature',signature(body)).send(body.toString());
    expect(hook.status).toBe(200);
    expect((await request(h.app).get(`/proofs/${proofId}`).set(auth(seller))).body.shipmentObservations.events).toHaveLength(1);
    const foreign=Buffer.from(JSON.stringify({event:'track_updated',test:false,data:fixture({carrier:'usps'})}));
    const rejected=await request(h.app).post('/integrations/webhooks/shippo-tracker').set('Content-Type','application/json').set('shippo-auth-signature',signature(foreign)).send(foreign.toString());
    expect(rejected.status).toBe(200); // Unknown hints do not reveal tracking bindings.
    expect((await request(h.app).get(`/proofs/${proofId}`).set(auth(seller))).body.shipmentObservations.events).toHaveLength(1);
  });
  it.skipIf(!process.env.SHIPPO_SANDBOX_TEST_TOKEN)('imports an actual Shippo sandbox response into a Proof',async()=>{
    h=await createHarness();const seller=await createUser(h);
    await h.credentialStore.put({...credentials,material:{apiKey:process.env.SHIPPO_SANDBOX_TEST_TOKEN!,mode:'test'}});
    const t=await request(h.app).post('/transactions').set(auth(seller)).send({itemTitle:'Shippo sandbox smoke',shipping:{carrier:'shippo',trackingNumber:'SHIPPO_TRANSIT'}});
    const transactionId=t.body.transactionId;
    const p=await request(h.app).post(`/transactions/${transactionId}/proof`).set(auth(seller)).send({});
    const connection=await createIntegrationConnection(h.db,h.clock,seller,{adapterKey:'shippo-tracker',provider:'shippo',credentialReference:reference});
    await bindTransactionShipmentConnection(h.db,h.clock,seller,transactionId,connection.connectionId);
    const sync=await request(h.app).post(`/transactions/${transactionId}/shipment-sync`).set(auth(seller)).send({});
    expect(sync.status).toBe(201);
    const proof=(await request(h.app).get(`/proofs/${p.body.proofId}`).set(auth(seller))).body;
    expect(proof.shipmentObservations.events.length).toBeGreaterThan(0);
    expect(proof.shipmentObservations.events.every((e:any)=>e.provider==='shippo' && e.eventData.test===true)).toBe(true);
  },45_000);
});
