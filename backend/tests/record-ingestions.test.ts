import { beforeAll,afterAll,describe,it,expect,vi } from 'vitest';
import {randomBytes} from 'node:crypto';
import {openIsolatedTestDatabase} from './isolated-test-database.js';
import {migrate} from '../src/db/migrate.js';
import {insertUser} from '../src/domain/users.js';
import {createOrganization,setOrganizationEntitlement,createServicePrincipal,issuePartnerCredential,createIntegrationAccount,createDelegation,revokeDelegation,authenticatePartner,PARTNER_SCOPES,type PartnerActor} from '../src/platform/organizations.js';
import {importPartnerOrder} from '../src/platform/partner-proofs.js';
import {acceptSourceIngestion,readSourceOperation,processSourceIngestions,parseSourceIngestion} from '../src/records/ingestions.js';
import {actOnRecordConnection} from '../src/records/connections.js';
import {requireRecordWorkspace} from '../src/records/access.js';
import {createServerApp} from '../src/server-app.js';
import {BearerUserAdapter} from '../src/auth/adapter.js';
import {MemoryObjectStore} from './memory-object-store.js';
import {DisabledEmailDelivery} from '../src/integrations/email/delivery.js';
import {canonicalize} from '../src/canonical.js';
import {sha256Hex} from '../src/hash.js';
import type {Database} from '../src/db/database.js';
import request from './in-process-http.js';

describe('durable normalized partner source ingestion',()=>{
 let opened:Awaited<ReturnType<typeof openIsolatedTestDatabase>>,admin:string,owner:string,otherOwner:string,org:string,otherOrg:string,member:string,account:string,otherAccount:string,proof:string,otherProof:string,actor:PartnerActor,otherActor:PartnerActor,token:string;
 let offset=0;const clock={now:()=>new Date(Date.now()+offset)};
 const expires=()=>new Date(Date.now()+86400000).toISOString();
 const body=(sourceEventId:string,extra:Record<string,unknown>={})=>({connectionId:account,events:[{sourceEventId,proofId:proof,eventType:'IN_TRANSIT',reportedAt:'2026-11-03T12:00:00-05:00',data:{note:'Private operational description'},...extra}]});
 beforeAll(async()=>{
  vi.stubEnv('PACKPROOF_ORGANIZATIONS_ENABLED','true');vi.stubEnv('PACKPROOF_EVENT_CURSOR_KEY',randomBytes(32).toString('base64'));
  opened=await openIsolatedTestDatabase();await migrate(opened.db);
  [admin,owner,otherOwner]=await Promise.all(Array.from({length:3},()=>insertUser(opened.db,clock)));
  await opened.db.query("INSERT INTO user_verified_contacts(user_id,email_normalized,verified_at,source) VALUES($1,'nericollin@gmail.com',$2,'COGNITO')",[admin,clock.now().toISOString()]);
  org=(await createOrganization(opened.db,clock,admin,{kind:'MERCHANT',name:'Source warehouse',ownerUserId:owner},'setup')).id;
  otherOrg=(await createOrganization(opened.db,clock,admin,{kind:'MERCHANT',name:'Other source warehouse',ownerUserId:otherOwner},'setup')).id;
  for(const id of [org,otherOrg])await setOrganizationEntitlement(opened.db,clock,admin,id,{enabled:true},'setup');
  member=(await opened.db.query<{id:string}>('SELECT id FROM platform_memberships WHERE organization_id=$1 AND user_id=$2',[org,owner])).rows[0].id;
  const otherMember=(await opened.db.query<{id:string}>('SELECT id FROM platform_memberships WHERE organization_id=$1 AND user_id=$2',[otherOrg,otherOwner])).rows[0].id;
  const principal=await createServicePrincipal(opened.db,clock,owner,org,{name:'Source publisher'},'setup');
  token=(await issuePartnerCredential(opened.db,clock,owner,org,principal.id,{scopes:[...PARTNER_SCOPES],expiresAt:expires()},'setup')).token;
  actor=await authenticatePartner(opened.db,clock,`Bearer ${token}`,org,undefined,'source-test');
  const otherPrincipal=await createServicePrincipal(opened.db,clock,otherOwner,otherOrg,{name:'Other source publisher'},'setup');
  const otherToken=(await issuePartnerCredential(opened.db,clock,otherOwner,otherOrg,otherPrincipal.id,{scopes:[...PARTNER_SCOPES],expiresAt:expires()},'setup')).token;
  otherActor=await authenticatePartner(opened.db,clock,`Bearer ${otherToken}`,otherOrg,undefined,'source-test');
  account=(await createIntegrationAccount(opened.db,clock,owner,org,{provider:'source-fixture',externalAccountId:'source-primary'},'setup')).id;
  otherAccount=(await createIntegrationAccount(opened.db,clock,otherOwner,otherOrg,{provider:'source-fixture',externalAccountId:'source-other'},'setup')).id;
  proof=(await importPartnerOrder(opened.db,clock,actor,{integrationAccountId:account,externalId:'SOURCE-1',operatorMembershipId:member,transaction:{itemTitle:'Source evidence fixture'}})).proofId;
  otherProof=(await importPartnerOrder(opened.db,clock,otherActor,{integrationAccountId:otherAccount,externalId:'SOURCE-1',operatorMembershipId:otherMember,transaction:{itemTitle:'Other source evidence fixture'}})).proofId;
 },60000);
 afterAll(async()=>{await opened?.close();vi.unstubAllEnvs();});
 it('acknowledges only a durable receipt and preserves original logical JSON before normalization',async()=>{
  const input=body('  EVENT-0001  '),accepted=await acceptSourceIngestion(opened.db,clock,actor,input,'event-first');
  expect(accepted.state).toBe('queued');
  expect((await opened.db.query('SELECT 1 FROM shipment_events WHERE proof_id=$1',[proof])).rows).toHaveLength(0);
  const receipt=(await opened.db.query<{payload_canonical:string;payload_sha256:string;normalized:{sourceEventId:string}}>('SELECT payload_canonical,payload_sha256,normalized FROM record_source_receipts WHERE operation_id=$1',[accepted.operationId])).rows[0];
  expect(receipt.payload_canonical).toBe(canonicalize(input.events[0]));expect(receipt.payload_sha256).toBe(sha256Hex(receipt.payload_canonical));expect(receipt.normalized.sourceEventId).toBe('EVENT-0001');
  await processSourceIngestions(opened.db,clock);const done=await readSourceOperation(opened.db,clock,actor,accepted.operationId);
  expect(done.state).toBe('succeeded');expect(done.items[0].status).toBe('imported');expect(done.items[0].reportedAt).toBe('2026-11-03T17:00:00.000Z');expect(done.items[0].receivedAt).not.toBe(done.items[0].reportedAt);
  expect(JSON.stringify(done)).not.toContain('Private operational description');expect(JSON.stringify(done)).not.toContain('payload_canonical');
  const event=(await opened.db.query<{source:string;event_data:Record<string,unknown>}>('SELECT source,event_data FROM shipment_events WHERE id=$1',[done.items[0].eventId])).rows[0];expect(event.source).toBe('PARTICIPANT_SUPPLIED');expect(event.event_data._packproofSource).toMatchObject({type:'organization_submitted',connectionId:account});
  expect((await opened.db.query('SELECT revision FROM record_state WHERE proof_id=$1',[proof])).rows).toEqual([{revision:2}]);
  expect((await opened.db.query('SELECT 1 FROM attestations WHERE proof_id=$1',[proof])).rows).toHaveLength(0);
 });
 it('replays request receipts and deduplicates repeated source IDs permanently',async()=>{
  const input=body('REPLAY-1'),one=await acceptSourceIngestion(opened.db,clock,actor,input,'same-request');
  const replay=await acceptSourceIngestion(opened.db,clock,{...actor,requestId:'later-request'},input,'same-request');expect(replay.operationId).toBe(one.operationId);expect(replay.replayed).toBe(true);
  await processSourceIngestions(opened.db,clock);
  const repeated=await acceptSourceIngestion(opened.db,clock,actor,input,'different-command');await processSourceIngestions(opened.db,clock);
  const second=await readSourceOperation(opened.db,clock,actor,repeated.operationId);expect(second.items[0].status).toBe('duplicate');
  expect((await opened.db.query("SELECT 1 FROM shipment_events WHERE source_event_id='REPLAY-1' AND proof_id=$1",[proof])).rows).toHaveLength(1);
  await expect(acceptSourceIngestion(opened.db,clock,actor,body('REPLAY-1',{eventType:'DELIVERED'}),'same-request')).rejects.toMatchObject({code:'IDEMPOTENCY_CONFLICT'});
 });
 it('retains both changed receipts and exposes a traceable source conflict without overwriting the event',async()=>{
  const first=await acceptSourceIngestion(opened.db,clock,actor,body('CONFLICT-1'),'conflict-first');await processSourceIngestions(opened.db,clock);
  const changed=await acceptSourceIngestion(opened.db,clock,actor,body('CONFLICT-1',{eventType:'DELIVERED'}),'conflict-second');expect(changed.state).toBe('failed');
  const result=await readSourceOperation(opened.db,clock,actor,changed.operationId);expect(result.items[0]).toMatchObject({status:'conflict',errorCode:'SOURCE_EVENT_CONFLICT'});
  expect((await opened.db.query('SELECT payload_sha256 FROM record_source_receipts WHERE operation_id IN ($1,$2)',[first.operationId,changed.operationId])).rows).toHaveLength(2);
  expect((await opened.db.query("SELECT event_type FROM shipment_events WHERE proof_id=$1 AND source_event_id='CONFLICT-1'",[proof])).rows).toEqual([{event_type:'IN_TRANSIT'}]);
  expect((await opened.db.query("SELECT 1 FROM record_issues WHERE proof_id=$1 AND category='source_conflict'",[proof])).rows).toHaveLength(1);
  expect((await opened.db.query("SELECT 1 FROM proof_outbox o JOIN audit_events a ON a.id=o.audit_id WHERE o.proof_id=$1 AND o.event_type='issue.updated' AND a.event_type='SOURCE_EVENT_CONFLICT'",[proof])).rows).toHaveLength(1);
 });
 it('scopes source identity, proof binding, operation reads and credentials independently',async()=>{
  const accepted=await acceptSourceIngestion(opened.db,clock,actor,body('SCOPED-1'),'scope-a');
  await expect(readSourceOperation(opened.db,clock,otherActor,accepted.operationId)).rejects.toMatchObject({code:'OPERATION_NOT_FOUND'});
  await expect(acceptSourceIngestion(opened.db,clock,actor,{connectionId:account,events:[{...body('SCOPED-2').events[0],proofId:otherProof}]},'cross-proof')).rejects.toMatchObject({code:'PROOF_NOT_FOUND'});
  await expect(acceptSourceIngestion(opened.db,clock,actor,{...body('SCOPED-3'),connectionId:otherAccount},'cross-account')).rejects.toMatchObject({code:'CONNECTION_NOT_FOUND'});
  const rotated=(await issuePartnerCredential(opened.db,clock,owner,org,actor.principalId,{scopes:[...PARTNER_SCOPES],expiresAt:expires()},'rotate')).token;
  const rotatedActor=await authenticatePartner(opened.db,clock,`Bearer ${rotated}`,org,undefined,'rotate');await expect(readSourceOperation(opened.db,clock,rotatedActor,accepted.operationId)).rejects.toMatchObject({code:'OPERATION_NOT_FOUND'});
  const independent=await acceptSourceIngestion(opened.db,clock,otherActor,{connectionId:otherAccount,events:[{...body('SCOPED-1').events[0],proofId:otherProof}]},'scope-b');await processSourceIngestions(opened.db,clock,10);expect((await readSourceOperation(opened.db,clock,otherActor,independent.operationId)).items[0].status).toBe('imported');
 });
 it('denies secret-bearing payloads and unsupported authority before storing receipts',()=>{
  expect(()=>parseSourceIngestion(body('SECRET-1',{data:{nested:{authorization:'Bearer sensitive'}}}))).toThrow(/credentials/);
  expect(()=>parseSourceIngestion(body('SECRET-2',{data:{note:'https://example.test/file?X-Amz-Signature=private'}}))).toThrow(/signed access/);
  expect(()=>parseSourceIngestion(body('SECRET-3',{source:'SHIPPING_PROVIDER_API'}))).toThrow(/documented/);
  expect(()=>parseSourceIngestion(body('DATE-1',{reportedAt:'11/03/2026'}))).toThrow(/UTC offset/);
 });
 it('honors pause and rejects previously queued work after a pause/resume control revision',async()=>{
  const w=await requireRecordWorkspace(opened.db,owner,org,'sandbox',true),queued=await acceptSourceIngestion(opened.db,clock,actor,body('PAUSED-1'),'before-pause');
  await actOnRecordConnection(opened.db,clock,w,account,{action:'pause'},'pause-source');
  await expect(acceptSourceIngestion(opened.db,clock,actor,body('PAUSED-2'),'while-paused')).rejects.toMatchObject({code:'CONNECTION_PAUSED'});
  await actOnRecordConnection(opened.db,clock,w,account,{action:'resume'},'resume-source');await processSourceIngestions(opened.db,clock,10);
  const result=await readSourceOperation(opened.db,clock,actor,queued.operationId);expect(result.items[0]).toMatchObject({status:'failed',errorCode:'CONNECTION_CHANGED'});
  expect((await opened.db.query("SELECT 1 FROM shipment_events WHERE source_event_id='PAUSED-1'",[])).rows).toHaveLength(0);
 });
 it('rechecks delegated location and grant access on acceptance, processing and operation reads',async()=>{
  const partner=(await createOrganization(opened.db,clock,admin,{kind:'PARTNER',name:'Ingestion partner'},'partner')).id;await setOrganizationEntitlement(opened.db,clock,admin,partner,{enabled:true},'partner');
  const principal=await createServicePrincipal(opened.db,clock,admin,partner,{name:'Delegated source'},'partner');
  const partnerToken=(await issuePartnerCredential(opened.db,clock,admin,partner,principal.id,{scopes:[...PARTNER_SCOPES],expiresAt:expires()},'partner')).token;
  const delegation=await createDelegation(opened.db,clock,owner,org,{partnerOrganizationId:partner,scopes:[...PARTNER_SCOPES],operatorUserIds:[owner],expiresAt:expires()},'partner');
  const delegated=await authenticatePartner(opened.db,clock,`Bearer ${partnerToken}`,org,delegation.id,'partner');
  const accepted=await acceptSourceIngestion(opened.db,clock,delegated,body('LOCATED-1'),'before-location');
  await opened.db.query('INSERT INTO record_locations(id,organization_id,name,created_at) VALUES($1,$2,$3,$4)',['source-location',org,'Scoped source location',clock.now().toISOString()]);
  await opened.db.query('UPDATE record_state SET location_id=$2 WHERE proof_id=$1',[proof,'source-location']);
  // The common partner boundary hides inaccessible records consistently across
  // both new ingestions and legacy reads instead of revealing site membership.
  await expect(readSourceOperation(opened.db,clock,delegated,accepted.operationId)).rejects.toMatchObject({code:'PROOF_NOT_FOUND',httpStatus:404});
  await expect(acceptSourceIngestion(opened.db,clock,delegated,body('LOCATED-1'),'before-location')).rejects.toMatchObject({code:'PROOF_NOT_FOUND',httpStatus:404});
  await expect(acceptSourceIngestion(opened.db,clock,delegated,body('LOCATED-2'),'after-location')).rejects.toMatchObject({code:'PROOF_NOT_FOUND',httpStatus:404});
  await processSourceIngestions(opened.db,clock,10);expect((await readSourceOperation(opened.db,clock,actor,accepted.operationId).catch(()=>null))).toBeNull();
  expect((await opened.db.query<{error_code:string}>('SELECT error_code FROM record_source_receipts WHERE operation_id=$1',[accepted.operationId])).rows[0].error_code).toBe('PROOF_NOT_FOUND');
  await opened.db.query('UPDATE record_state SET location_id=NULL WHERE proof_id=$1',[proof]);
  const revocable=await acceptSourceIngestion(opened.db,clock,delegated,body('REVOKED-1'),'before-revoke');await revokeDelegation(opened.db,clock,owner,org,delegation.id,'revoke');await processSourceIngestions(opened.db,clock,10);
  await expect(acceptSourceIngestion(opened.db,clock,delegated,body('REVOKED-1'),'before-revoke')).rejects.toMatchObject({code:'INSUFFICIENT_SCOPE'});
  expect((await opened.db.query<{state:string}>('SELECT state FROM record_source_receipts WHERE operation_id=$1',[revocable.operationId])).rows[0].state).toBe('failed');
 });
 it('rolls back a canonical event if the lease expires during processing and recovers it once',async()=>{
  const accepted=await acceptSourceIngestion(opened.db,clock,actor,body('EXPIRED-LEASE-1'),'lease-source');let delay=true;
  const wrap=(base:Database):Database=>({query:async<T=Record<string,unknown>>(sql:string,params?:unknown[])=>{const result=await base.query<T>(sql,params);if(delay&&/^\s*INSERT INTO shipment_events/.test(sql)){delay=false;offset+=121000;}return result;},transaction:fn=>base.transaction(tx=>fn(wrap(tx)))});
  await processSourceIngestions(wrap(opened.db),clock,1);
  expect((await opened.db.query("SELECT 1 FROM shipment_events WHERE source_event_id='EXPIRED-LEASE-1'",[])).rows).toHaveLength(0);
  await processSourceIngestions(opened.db,clock);expect((await readSourceOperation(opened.db,clock,actor,accepted.operationId)).items[0].status).toBe('imported');
  expect((await opened.db.query("SELECT 1 FROM shipment_events WHERE source_event_id='EXPIRED-LEASE-1'",[])).rows).toHaveLength(1);offset=0;
 });
 it('does not disclose a restricted original receipt when an identity is reused against another record',async()=>{
  const newProof=(await importPartnerOrder(opened.db,clock,actor,{integrationAccountId:account,externalId:'SOURCE-SECOND',operatorMembershipId:member,transaction:{itemTitle:'Second source fixture'}})).proofId;
  const original=(await opened.db.query<{receipt_id:string;payload_sha256:string}>("SELECT receipt_id,payload_sha256 FROM record_source_identities WHERE organization_id=$1 AND connection_id=$2 AND source_event_id='EVENT-0001'",[org,account])).rows[0];
  const partner=(await opened.db.query<{id:string}>("SELECT id FROM platform_organizations WHERE kind='PARTNER' ORDER BY id LIMIT 1")).rows[0].id;
  const principal=(await opened.db.query<{id:string}>('SELECT id FROM platform_principals WHERE organization_id=$1',[partner])).rows[0].id;
  const delegatedToken=(await issuePartnerCredential(opened.db,clock,admin,partner,principal,{scopes:[...PARTNER_SCOPES],expiresAt:expires()},'new-credential')).token;
  const grant=await createDelegation(opened.db,clock,owner,org,{partnerOrganizationId:partner,scopes:[...PARTNER_SCOPES],operatorUserIds:[owner],expiresAt:expires()},'new-grant');
  const delegated=await authenticatePartner(opened.db,clock,`Bearer ${delegatedToken}`,org,grant.id,'cross-record-conflict');
  await opened.db.query('UPDATE record_state SET location_id=$2 WHERE proof_id=$1',[proof,'source-location']);
  const accepted=await acceptSourceIngestion(opened.db,clock,delegated,body('EVENT-0001',{proofId:newProof}),'cross-record-conflict');
  expect((await readSourceOperation(opened.db,clock,delegated,accepted.operationId)).items[0].status).toBe('conflict');
  const issue=(await opened.db.query<{compared_sources:unknown}>('SELECT compared_sources FROM record_issues WHERE proof_id=$1',[newProof])).rows[0];
  expect(JSON.stringify(issue)).toContain('restricted_to_original_record');expect(JSON.stringify(issue)).not.toContain(original.receipt_id);expect(JSON.stringify(issue)).not.toContain(original.payload_sha256);
  const audit=(await opened.db.query<{event_data:unknown}>("SELECT event_data FROM audit_events WHERE proof_id=$1 AND event_type='SOURCE_EVENT_CONFLICT'",[newProof])).rows[0];expect(JSON.stringify(audit)).not.toContain(original.payload_sha256);
  await opened.db.query('UPDATE record_state SET location_id=NULL WHERE proof_id=$1',[proof]);
 });
 it('preserves immutable receipts and exposes durable operations through the assembled partner router',async()=>{
  const app=createServerApp({db:opened.db,clock,objectStore:new MemoryObjectStore(),auth:new BearerUserAdapter(opened.db),devAuth:true,testFixtures:true,publicBaseUrl:'https://api.example.test',emailDelivery:new DisabledEmailDelivery(),webhookConfig:{encryptionKey:randomBytes(32).toString('base64'),allowedHosts:['example.test']}});
  const headers={Authorization:`Bearer ${token}`,'PackProof-Merchant-Id':org};
  const response=await request(app).post('/v1/partner/ingestions').set(headers).set('Idempotency-Key','http-source').send(body('HTTP-SOURCE-1'));expect(response.status,response.text).toBe(202);expect(response.headers.location).toBe(response.body.links.self);
  const read=await request(app).get(response.body.links.self).set(headers);expect(read.status,read.text).toBe(200);expect(read.body.items[0].status).toBe('queued');
  await expect(opened.db.query("UPDATE record_source_receipts SET payload_canonical='{}' WHERE operation_id=$1",[response.body.operationId])).rejects.toThrow(/immutable/);
 });
});
