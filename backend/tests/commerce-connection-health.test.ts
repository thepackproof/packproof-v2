import {afterEach,describe,expect,it} from 'vitest';
import request from './in-process-http.js';
import {auth,createHarness,login,type TestHarness} from './helpers.js';
import {createDefaultIntegrationRegistry} from '../src/integrations/registry.js';
import {getCommerceConnectionHealth} from '../src/domain/commerce-connection-health.js';
import {DEMO_STOREFRONT_CREDENTIAL_REFERENCE} from '../src/integrations/demo-storefront.js';
import {upsertCommerceOrderRecord} from '../src/domain/commerce-order-records.js';

describe('owner-scoped connection health and discovered-order coverage',()=>{
 let harness:TestHarness;
 afterEach(async()=>{await harness?.close();});
 it('accounts for all discovered work and exposes actual freshness without leaking cursor or credentials',async()=>{
  let current=new Date('2026-10-28T12:00:00.000Z');
  const clock={now:()=>new Date(current)};
  const registry=createDefaultIntegrationRegistry(clock,{testFixtures:true});
  harness=await createHarness(clock,{integrations:registry});
  const user=await login(harness.app,'connection-health-owner');
  const connected=await request(harness.app).post('/dev/integrations/demo-storefront/connect').set(auth(user)).send({});
  expect(connected.status,connected.text).toBe(201);
  const id=connected.body.connection.connectionId;
  const initial=await getCommerceConnectionHealth(harness.db,clock,user,id,registry);
  expect(initial.sync.sourceWatermarkAt).toBeNull();
  expect(initial.sync.stale).toBeNull();
  expect(initial.coverage.discovered).toBe(0);
  expect(initial.capabilities.incrementalListSupported).toBe(true);
  const imported=await request(harness.app).post(`/me/commerce-connections/${id}/sync`).set(auth(user)).send({});
  expect(imported.status,imported.text).toBe(200);
  const health=await getCommerceConnectionHealth(harness.db,clock,user,id,registry);
  expect(health.coverage).toMatchObject({basis:'DISCOVERED_SOURCE_RECORDS',discovered:10,eligible:6,excluded:4,
   eligibleWithoutProof:0,awaitingCapture:6,inProgress:0,finalized:0,otherEligible:0});
  expect(health.coverage).not.toHaveProperty('ready');
  expect(health.sync.sourceAgeSeconds).toBe(0);
  expect(health.sync.stale).toBe(false);
  expect(health.nextAction).toBe('ENABLE_AUTOMATION');
  await harness.db.query("UPDATE commerce_connection_sync_states SET provider_cursor='private-provider-cursor' WHERE connection_id=$1",[id]);
  current=new Date(current.getTime()+3600000);
  const later=await getCommerceConnectionHealth(harness.db,clock,user,id,registry);
  expect(later.sync.pageResumePending).toBe(true);expect(later.sync.stale).toBe(true);
  expect(later.sync.sourceAgeSeconds).toBe(3600);
  expect(JSON.stringify(later)).not.toContain('private-provider-cursor');
  expect(JSON.stringify(later)).not.toContain(DEMO_STOREFRONT_CREDENTIAL_REFERENCE);
  const outsider=await login(harness.app,'connection-health-outsider');
  await expect(getCommerceConnectionHealth(harness.db,clock,outsider,id,registry)).rejects.toMatchObject({code:'INTEGRATION_NOT_FOUND'});
  expect((await harness.db.query('SELECT id FROM proofs')).rows).toHaveLength(6);
 });
 it('keeps missing canonical work visible and treats expired worker leases as a platform exception',async()=>{
  const clock={now:()=>new Date('2026-10-28T12:00:00.000Z')};
  const registry=createDefaultIntegrationRegistry(clock,{testFixtures:true});
  harness=await createHarness(clock,{integrations:registry});
  const user=await login(harness.app,'coverage-unbound-owner');
  const connected=await request(harness.app).post('/dev/integrations/demo-storefront/connect').set(auth(user)).send({});
  const id=connected.body.connection.connectionId;
  await upsertCommerceOrderRecord(harness.db,clock,{
   connectionId:id,commerceTenantKey:'storefront:demo-storefront:coverage-test',
   externalOrderId:'not-yet-bound',externalReference:null,orderedAt:clock.now().toISOString(),
   paymentState:'CONFIRMED',fulfillmentState:'AWAITING_FULFILLMENT',
   requiresPhysicalFulfillment:true,cancelled:false,eligibility:'FULFILLMENT_ELIGIBLE',
   providerUpdatedAt:clock.now().toISOString(),fingerprint:'a'.repeat(64)
  });
  await harness.db.query("UPDATE integration_connections SET auto_sync_enabled=true WHERE id=$1",[id]);
  await harness.db.query(`INSERT INTO commerce_connection_sync_states(connection_id,updated_at,run_status,lease_expires_at)
   VALUES($1,$2,'RUNNING',$3) ON CONFLICT(connection_id) DO UPDATE SET run_status='RUNNING',lease_expires_at=$3`,
   [id,clock.now().toISOString(),'2026-10-28T11:00:00.000Z']);
  const health=await getCommerceConnectionHealth(harness.db,clock,user,id,registry);
  expect(health.coverage).toMatchObject({discovered:1,eligible:1,eligibleWithoutProof:1,excluded:0,finalized:0});
  expect(health.sync.expiredLease).toBe(true);expect(health.nextAction).toBe('CONTACT_SUPPORT');
  await harness.db.query("UPDATE integration_connections SET status='NEEDS_REAUTH' WHERE id=$1",[id]);
  expect((await getCommerceConnectionHealth(harness.db,clock,user,id,registry)).nextAction).toBe('RECONNECT');
 });
});
