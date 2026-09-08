import {afterAll,beforeAll,describe,expect,it} from 'vitest';
import {createHarness,createUser,type TestHarness} from './helpers.js';
import {createIntegrationConnection} from '../src/domain/integration-connections.js';
import {dispatchShippoIntake,type ShippoIntakeRuntimeDeps} from '../src/intake/shippo-runtime.js';
import {submitIntakeObservation,type IntakeScope} from '../src/intake/context.js';
import {upsertCommerceOrderRecord,bindCommerceOrderTransaction} from '../src/domain/commerce-order-records.js';
import {tenantKeyForImport} from '../src/domain/provenance.js';
import {newId} from '../src/ids.js';

describe('Shippo persisted intake runtime',()=>{
 let h:TestHarness,now=new Date('2026-09-08T14:00:00Z');
 beforeAll(async()=>{h=await createHarness({now:()=>now});});
 afterAll(async()=>{await h.close();});
 const page=(results:unknown[])=>new Response(JSON.stringify({next:null,results}),{status:200});
 const order=(lines:unknown[]=[{title:'Trading card',quantity:2}])=>({object_id:'shippo-object',order_number:'#same-display',order_status:'PAID',to_address:{country:'US'},line_items:lines,transactions:[]});
 async function setup(){
  const actor=await createUser(h),merchant=newId('merchant');
  const c=await createIntegrationConnection(h.db,h.clock,actor,{adapterKey:'shippo-orders',provider:'shippo',externalAccountReference:merchant,credentialReference:`memory:${merchant}`});
  await h.db.query('UPDATE integration_connections SET auto_sync_enabled=true WHERE id=$1',[c.connectionId]);
  const credentials={adapterKey:'shippo-orders',credentialReference:`memory:${merchant}`,material:{tenantId:actor,connectionId:c.connectionId,merchantAccountId:merchant,ordersAuthorized:'true',accessToken:'oauth.synthetic-runtime'}};
  await h.credentialStore.put(credentials);return {actor,merchant,c,credentials};
 }
 const deps=(actor:string,fetchImpl:typeof fetch):ShippoIntakeRuntimeDeps=>({credentialStore:h.credentialStore,config:()=>({enabled:true,shippoEnabled:true,actorIds:[actor]}),fetchImpl});
 async function due(id:string){now=new Date(now.getTime()+360000);await h.db.query('UPDATE commerce_connection_sync_states SET next_run_at=$2 WHERE connection_id=$1',[id,now.toISOString()]);}
 it('honors flags/allowlist and rejects foreign credential scope before any request',async()=>{
  const s=await setup();let calls=0;const d=deps(s.actor,async()=>{calls++;return page([]);});
  for(const flags of [{enabled:false,shippoEnabled:true,actorIds:[s.actor]},{enabled:true,shippoEnabled:false,actorIds:[s.actor]},{enabled:true,shippoEnabled:true,actorIds:['foreign']}])expect(await dispatchShippoIntake(h.db,h.clock,{...d,config:()=>flags})).toEqual({completed:0,failed:0});
  await h.credentialStore.put({...s.credentials,material:{...s.credentials.material,tenantId:'foreign'}});
  expect(await dispatchShippoIntake(h.db,h.clock,d)).toEqual({completed:0,failed:1});expect(calls).toBe(0);
  expect((await h.db.query('SELECT run_status,last_error_code,provider_cursor FROM commerce_connection_sync_states WHERE connection_id=$1',[s.c.connectionId])).rows[0]).toMatchObject({run_status:'FAILED',last_error_code:'MERCHANT_AUTHORIZATION_REQUIRED',provider_cursor:null});
 });
 it('persists retry/auth health and creates no Proof for empty or insufficient orders',async()=>{
  const s=await setup();let status=429;const d=deps(s.actor,async()=>status===200?page([order([])]):new Response('{}',{status,headers:{'retry-after':'90'}}));
  expect(await dispatchShippoIntake(h.db,h.clock,d)).toEqual({completed:0,failed:1});
  const retry=(await h.db.query('SELECT run_status,provider_cursor,next_run_at FROM commerce_connection_sync_states WHERE connection_id=$1',[s.c.connectionId])).rows[0];
  expect(retry).toMatchObject({run_status:'RETRYING',provider_cursor:null});expect(new Date(retry.next_run_at as string).getTime()).toBe(now.getTime()+90000);
  status=200;await due(s.c.connectionId);expect(await dispatchShippoIntake(h.db,h.clock,d)).toEqual({completed:1,failed:0});
  expect((await h.db.query('SELECT id FROM transactions WHERE created_by=$1',[s.actor])).rows).toHaveLength(0);
  expect((await h.db.query('SELECT readiness FROM intake_delivery_receipts WHERE actor_user_id=$1',[s.actor])).rows).toEqual([{readiness:'NEEDS_INFORMATION'}]);
  status=401;await due(s.c.connectionId);expect(await dispatchShippoIntake(h.db,h.clock,d)).toEqual({completed:0,failed:1});
  expect((await h.db.query('SELECT status FROM integration_connections WHERE id=$1',[s.c.connectionId])).rows[0].status).toBe('NEEDS_REAUTH');
  const empty=await setup();expect(await dispatchShippoIntake(h.db,h.clock,deps(empty.actor,async()=>page([])))).toEqual({completed:1,failed:0});
  expect((await h.db.query('SELECT id FROM intake_source_observations WHERE actor_user_id=$1',[empty.actor])).rows).toHaveLength(0);
 });
 it('replays exact established aliases into one Proof and preserves immutable private source bytes',async()=>{
  const s=await setup();const c=await createIntegrationConnection(h.db,h.clock,s.actor,{adapterKey:'ebay-marketplace',provider:'ebay',externalAccountReference:`store-${s.merchant}`,credentialReference:'memory:unused'});
  const scope:IntakeScope={provider:'ebay',externalAccountReference:c.externalAccountReference!,namespaceSource:'MARKETPLACE_API',connectionId:c.connectionId,verified:true};
  const prepared=await submitIntakeObservation(h.db,h.clock,s.actor,{receiptId:'canonical-sale',sourceKind:'API_OBSERVED',adapterKey:'ebay-marketplace',adapterVersion:'1',externalOrderId:'canonical-order',orderReference:'#same-display',items:[{title:'Trading card',quantity:2}],physicalFulfillment:true,paid:true,cancelled:false,fulfillmentScope:'FULL_ORDER'},scope);
  await h.db.query(`INSERT INTO transaction_integration_identities(id,transaction_id,tenant_key,external_transaction_id,adapter_key,source,created_at) VALUES($1,$2,$3,'shippo-object','shippo-orders','SHIPPING_PROVIDER_API',$4)`,[newId('alias'),prepared.transactionId,tenantKeyForImport('shippo','SHIPPING_PROVIDER_API',s.merchant),now.toISOString()]);
  const record=await upsertCommerceOrderRecord(h.db,h.clock,{connectionId:c.connectionId,commerceTenantKey:tenantKeyForImport('ebay','MARKETPLACE_API',scope.externalAccountReference),externalOrderId:'canonical-order',externalReference:'#same-display',orderedAt:null,paymentState:'CONFIRMED',fulfillmentState:'AWAITING_FULFILLMENT',requiresPhysicalFulfillment:true,cancelled:false,eligibility:'FULFILLMENT_ELIGIBLE',providerUpdatedAt:null,fingerprint:'fixture'});
  await bindCommerceOrderTransaction(h.db,record.id,prepared.transactionId!);
  let calls=0;const d=deps(s.actor,async(url,request)=>{calls++;expect(request?.method).toBe('GET');expect(request?.body).toBeUndefined();expect(new Headers(request?.headers).get('authorization')).toBe('Bearer oauth.synthetic-runtime');return String(url).endsWith('/orders/shippo-object')?new Response(JSON.stringify(order()),{status:200}):page([order()]);});
  for(let i=0;i<3;i++){if(i)await due(s.c.connectionId);expect(await dispatchShippoIntake(h.db,h.clock,d)).toEqual({completed:1,failed:0});}
  expect(calls).toBe(5);expect((await h.db.query('SELECT p.id FROM proofs p JOIN transactions t ON t.id=p.transaction_id WHERE t.created_by=$1',[s.actor])).rows).toEqual([{id:prepared.proofId}]);
  const observations=(await h.db.query('SELECT context FROM intake_source_observations WHERE connection_id=$1',[s.c.connectionId])).rows;
  expect(observations).toHaveLength(2);expect(observations.every(row=>(row.context as any).externalOrderId==='canonical-order')).toBe(true);
  const raw=(await h.db.query('SELECT id,source_bytes FROM intake_provider_raw_sources WHERE connection_id=$1',[s.c.connectionId])).rows;
  expect(raw).toHaveLength(2);expect(Buffer.from(raw[0].source_bytes as Uint8Array).length).toBeGreaterThan(0);
  await expect(h.db.query('UPDATE intake_provider_raw_sources SET source_bytes=$2 WHERE id=$1',[raw[0].id,Buffer.from('changed')])).rejects.toThrow('INTAKE_CONTEXT_IMMUTABLE');
  await expect(h.db.query('DELETE FROM intake_provider_raw_sources WHERE id=$1',[raw[0].id])).rejects.toThrow('INTAKE_CONTEXT_IMMUTABLE');
  expect((await h.db.query('SELECT eligibility,payment_state,fulfillment_state FROM commerce_order_records WHERE connection_id=$1',[s.c.connectionId])).rows[0]).toMatchObject({eligibility:'FULFILLMENT_ELIGIBLE',payment_state:'CONFIRMED',fulfillment_state:'AWAITING_FULFILLMENT'});
 });
 it('respects another worker lease without fetching or advancing its cursor',async()=>{
  const s=await setup();let calls=0;
  await h.db.query(`INSERT INTO commerce_connection_sync_states(connection_id,updated_at,run_status,lease_token,lease_expires_at,provider_cursor) VALUES($1,$2,'RUNNING','other-worker',$3,'not-owned')`,[s.c.connectionId,now.toISOString(),new Date(now.getTime()+300000).toISOString()]);
  expect(await dispatchShippoIntake(h.db,h.clock,deps(s.actor,async()=>{calls++;return page([]);}))).toEqual({completed:0,failed:0});expect(calls).toBe(0);
  expect((await h.db.query('SELECT provider_cursor FROM commerce_connection_sync_states WHERE connection_id=$1',[s.c.connectionId])).rows[0].provider_cursor).toBe('not-owned');
 });
});
