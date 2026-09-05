import {afterEach,describe,expect,it} from 'vitest';
import request from 'supertest';
import type {Database} from '../src/db/database.js';
import {auth,commitFulfillmentAndAttest,createHarness,login,type TestHarness} from './helpers.js';
import {createProofEmailSubscription,dispatchPendingProofEmails,reconcileProofNotifications} from '../src/domain/proof-notifications.js';
import {setReceiptPreference} from '../src/domain/buyer-receipt.js';
import {createDisclosureGrant,previewDisclosure} from '../src/domain/disclosure.js';
import {recordShipmentEvent} from '../src/domain/shipment-events.js';
let h:TestHarness;
const secret='notification-merge-verification-secret-at-least-32-bytes';
const origin='https://example.test';
afterEach(async()=>{await h?.close();});
async function setup(recipientGrantId?:string){
 h=await createHarness();
 const seller=await login(h.app,'notification-merge-seller'),buyer=await login(h.app,'notification-merge-buyer');
 const tx=await request(h.app).post('/transactions').set(auth(seller)).send({itemTitle:'Private item',shipping:{carrier:'UPS',trackingNumber:'PRIVATE-TRACKING'}});
 const p=await request(h.app).post(`/transactions/${tx.body.transactionId}/proof`).set(auth(seller));
 const proofId=p.body.proofId as string,email='buyer@example.test';
 await h.db.query('INSERT INTO commerce_receivers(proof_id,user_id,invited_by,created_at) VALUES($1,$2,$3,$4)',[proofId,buyer,seller,h.clock.now().toISOString()]);
 await h.db.query("INSERT INTO user_verified_contacts(user_id,email_normalized,verified_at,source) VALUES($1,$2,$3,'COGNITO')",[buyer,email,h.clock.now().toISOString()]);
 await setReceiptPreference(h.db,h.clock,buyer,proofId,true);
 const sub=await createProofEmailSubscription(h.db,h.clock,seller,proofId,{email,publicWebBaseUrl:origin,trackerLinkSecret:secret,recipientGrantId});
 return {seller,buyer,proofId,transactionId:tx.body.transactionId as string,subscriptionId:sub.subscriptionId,email};
}
describe('merged notification protections',()=>{
 it('bridges both worker lease namespaces and consumes the attempt before SMTP',async()=>{
  const {proofId}=await setup();
  await h.db.query("UPDATE proof_notification_outbox SET delivery_token='old-worker',delivery_lease_until=$2 WHERE proof_id=$1",[proofId,new Date(h.clock.now().getTime()+60000).toISOString()]);
  let sent=0;
  const delivery={enabled:true,send:async()=>{sent++;const rows=await h.db.query<{lease_token:string;delivery_token:string;attempt_count:number}>('SELECT lease_token,delivery_token,attempt_count FROM proof_notification_outbox WHERE proof_id=$1',[proofId]);expect(rows.rows[0].attempt_count).toBe(1);expect(rows.rows[0].lease_token).toBe(rows.rows[0].delivery_token);expect(rows.rows[0].lease_token).toBeTruthy();
   const oldClaim=await h.db.query("UPDATE proof_notification_outbox SET delivery_token='competing-old' WHERE proof_id=$1 AND (delivery_lease_until IS NULL OR delivery_lease_until<=$2) RETURNING id",[proofId,h.clock.now().toISOString()]);expect(oldClaim.rows).toHaveLength(0);
  }};
  expect(await dispatchPendingProofEmails(h.db,h.clock,delivery,origin,secret)).toEqual({sent:0,failed:0});
  await h.db.query("UPDATE proof_notification_outbox SET delivery_lease_until='2000-01-01' WHERE proof_id=$1",[proofId]);
  expect(await dispatchPendingProofEmails(h.db,h.clock,delivery,origin,secret)).toEqual({sent:1,failed:0});expect(sent).toBe(1);
  const result=(await h.db.query('SELECT lease_token,lease_until,delivery_token,delivery_lease_until,attempt_count FROM proof_notification_outbox WHERE proof_id=$1',[proofId])).rows[0];expect(result).toEqual({lease_token:null,lease_until:null,delivery_token:null,delivery_lease_until:null,attempt_count:1});
 });
 it('rechecks a preference changed after claim and cancels a now-unwanted milestone',async()=>{
  const {proofId,seller,subscriptionId}=await setup();
  await h.db.query('UPDATE proof_notification_outbox SET sent_at=$2 WHERE subscription_id=$1',[subscriptionId,h.clock.now().toISOString()]);
  await commitFulfillmentAndAttest(h,seller,proofId);await reconcileProofNotifications(h.db,h.clock,proofId);
  const db:Database={transaction:fn=>h.db.transaction(fn),query:async<T>(sql:string,params?:unknown[])=>{const result=await h.db.query<T>(sql,params);if(sql.includes('RETURNING attempt_count'))await h.db.query("UPDATE proof_notification_subscriptions SET preference='FINAL_ONLY' WHERE id=$1",[subscriptionId]);return result;}};
  let count=0;expect(await dispatchPendingProofEmails(db,h.clock,{enabled:true,send:async()=>{count++;}},origin,secret,proofId)).toEqual({sent:0,failed:0});expect(count).toBe(0);
  const event=(await h.db.query<{cancelled_at:unknown,attempt_count:number}>("SELECT cancelled_at,attempt_count FROM proof_notification_outbox WHERE event_key='MILESTONE:PACKING_RECORDED' AND subscription_id=$1",[subscriptionId])).rows[0];expect(event.cancelled_at).toBeTruthy();expect(event.attempt_count).toBe(1);
 });
 it('suppresses an actual carrier milestone excluded by the linked disclosure scope',async()=>{
  const {proofId,seller,transactionId,subscriptionId,email}=await setup();
  const input={purpose:'BUYER_RECEIPT',fields:['status'],media:[],publicWebBaseUrl:origin};
  const preview=await previewDisclosure(h.db,seller,proofId,input);
  const grant=await createDisclosureGrant(h.db,h.clock,seller,proofId,{...input,previewHash:preview.disclosure.viewHash});
  await createProofEmailSubscription(h.db,h.clock,seller,proofId,{email,publicWebBaseUrl:origin,trackerLinkSecret:secret,recipientGrantId:grant.accessLinkId});
  await h.db.query('UPDATE proof_notification_outbox SET sent_at=$2 WHERE subscription_id=$1',[subscriptionId,h.clock.now().toISOString()]);
  await recordShipmentEvent(h.db,h.clock,seller,{transactionId,eventType:'DELIVERED',occurredAt:h.clock.now().toISOString(),source:'SHIPPING_PROVIDER_API',provider:'fixture-carrier',sourceEventId:'delivered-scope-test',authority:'INTEGRATION'});
  await reconcileProofNotifications(h.db,h.clock,proofId);
  let sent=0;await dispatchPendingProofEmails(h.db,h.clock,{enabled:true,send:async()=>{sent++;}},origin,secret,proofId);expect(sent).toBe(0);
  expect((await h.db.query<{cancelled_at:unknown}>("SELECT cancelled_at FROM proof_notification_outbox WHERE event_key='MILESTONE:DELIVERED' AND subscription_id=$1",[subscriptionId])).rows[0].cancelled_at).toBeTruthy();
 });
 it('bounds crashed claims and does not allow the legacy worker to revive exhausted jobs',async()=>{
  const {proofId}=await setup();
  await h.db.query("UPDATE proof_notification_outbox SET attempt_count=5,lease_token='dead',delivery_token='dead',lease_until='2000-01-01',delivery_lease_until='2000-01-01' WHERE proof_id=$1",[proofId]);
  let sent=0;await dispatchPendingProofEmails(h.db,h.clock,{enabled:true,send:async()=>{sent++;}},origin,secret,proofId);expect(sent).toBe(0);
  const row=(await h.db.query<{exhausted_at:unknown,cancelled_at:unknown,attempt_count:number}>('SELECT exhausted_at,cancelled_at,attempt_count FROM proof_notification_outbox WHERE proof_id=$1',[proofId])).rows[0];expect(row.exhausted_at).toBeTruthy();expect(row.cancelled_at).toBeTruthy();expect(row.attempt_count).toBe(5);
  const old=(await h.db.query("UPDATE proof_notification_outbox SET delivery_token='old-retry' WHERE proof_id=$1 AND sent_at IS NULL AND cancelled_at IS NULL AND attempt_count<8 RETURNING id",[proofId])).rows;expect(old).toHaveLength(0);
 });
});
