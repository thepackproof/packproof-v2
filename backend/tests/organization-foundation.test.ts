import {beforeAll,afterAll,describe,expect,it,vi} from 'vitest';
import express from 'express';
import request from './in-process-http.js';
import {randomBytes} from 'node:crypto';
import {createPgliteDatabase} from '../src/db/pglite.js';
import {openIsolatedTestDatabase} from './isolated-test-database.js';
import {migrate} from '../src/db/migrate.js';
import {insertUser} from '../src/domain/users.js';
import {authorizeProofAccess} from '../src/domain/proof-access.js';
import {commitAttestation} from '../src/domain/attestations.js';
import {bindIntent} from '../src/capture/service.js';
import {CORE_VERSION} from '../src/capture/core.js';
import {createOrganization,setOrganizationEntitlement,addOrganizationMember,createServicePrincipal,issuePartnerCredential,
 createDelegation,createIntegrationAccount,revokeDelegation,revokeOrganizationMember,authenticatePartner,reauthorizePartner,PARTNER_SCOPES} from '../src/platform/organizations.js';
import {createPartnerRouter} from '../src/platform/partner-router.js';
import {createOrganizationRouter} from '../src/platform/organization-router.js';
import {DomainError} from '../src/domain/errors.js';
import {BearerUserAdapter} from '../src/auth/adapter.js';
import type {AppDependencies} from '../src/app.js';
import {dispatchWebhooks} from '../src/platform/webhooks.js';
import {readFile} from 'node:fs/promises';
import {MemoryObjectStore} from './memory-object-store.js';
import {chainSegment,createManifest,manifestDigest,type Observation} from '../src/capture/core.js';
import {sealCapture} from '../src/capture/service.js';
import {completeCaptureSession} from '../src/domain/capture-sessions.js';
import {initializeEvidenceUpload,commitEvidence} from '../src/domain/evidence.js';
import {finalizeProof} from '../src/domain/finalize.js';
import {exportEvidencePackage} from '../src/domain/evidence-review.js';
import {withPartnerReadGrant} from '../src/platform/proof-read-grant.js';
import {listMyProofs,queryMyProofs} from '../src/domain/proof-collection.js';
import {sha256Hex} from '../src/hash.js';

describe('organization foundation through shared backend services',()=>{
 let opened:Awaited<ReturnType<typeof createPgliteDatabase>>,app:ReturnType<typeof express>;
 let store:MemoryObjectStore;
 const caps={surface:'WEB' as const,cameraSource:'UNKNOWN' as const,timing:'MONOTONIC' as const,barcode:false,itemVisibility:false,durableJournal:true,incrementalMedia:false,audio:false,deviceAuthentication:'UNAVAILABLE' as const,appIntegrity:'UNAVAILABLE' as const,storageReserveBytes:10000000,coreVersion:CORE_VERSION};
 const clock={now:()=>new Date()},expires=()=>new Date(Date.now()+86400000).toISOString();
 const webhookConfig={encryptionKey:randomBytes(32).toString('base64'),allowedHosts:['example.com']};
 let admin:string,ownerA:string,ownerB:string,opA:string,opB:string,opP:string;
 let merchantA:string,merchantB:string,partner:string,memberA:string,memberB:string,memberP:string,accountA:string,accountB:string,grantA:string,grantB:string,credential:string,principalId:string,proofA:string,proofB:string;
 const headers=(merchant=merchantA,grant=grantA)=>({Authorization:`Bearer ${credential}`,'PackProof-Merchant-Id':merchant,'PackProof-Delegation-Id':grant});
 const importBody=(account=accountA,member=memberA)=>({integrationAccountId:account,externalId:'ORDER-1001',operatorMembershipId:member,transaction:{itemTitle:'Synthetic shipment',quantity:1,amount:{minorUnits:'100',currency:'JPY'}}});
 beforeAll(async()=>{
  vi.stubEnv('PACKPROOF_ORGANIZATIONS_ENABLED','true');vi.stubEnv('PACKPROOF_EVENT_CURSOR_KEY',randomBytes(32).toString('base64'));
  opened=await openIsolatedTestDatabase();await migrate(opened.db);
  store=new MemoryObjectStore();
  [admin,ownerA,ownerB,opA,opB,opP]=await Promise.all(Array.from({length:6},()=>insertUser(opened.db,clock)));
  await opened.db.query("INSERT INTO user_verified_contacts(user_id,email_normalized,verified_at,source) VALUES($1,'nericollin@gmail.com',$2,'COGNITO')",[admin,clock.now().toISOString()]);
  merchantA=(await createOrganization(opened.db,clock,admin,{kind:'MERCHANT',name:'Merchant A',ownerUserId:ownerA},'setup')).id;
  merchantB=(await createOrganization(opened.db,clock,admin,{kind:'MERCHANT',name:'Merchant B',ownerUserId:ownerB},'setup')).id;
  partner=(await createOrganization(opened.db,clock,admin,{kind:'PARTNER',name:'Partner'},'setup')).id;
  for(const id of [merchantA,merchantB,partner])await setOrganizationEntitlement(opened.db,clock,admin,id,{enabled:true},'setup');
  memberA=String((await addOrganizationMember(opened.db,clock,ownerA,merchantA,{userId:opA,role:'OPERATOR'},'setup')).id);
  memberB=String((await addOrganizationMember(opened.db,clock,ownerB,merchantB,{userId:opB,role:'OPERATOR'},'setup')).id);
  memberP=String((await addOrganizationMember(opened.db,clock,admin,partner,{userId:opP,role:'OPERATOR'},'setup')).id);
  principalId=(await createServicePrincipal(opened.db,clock,admin,partner,{name:'Reference merchant adapter'},'setup')).id;
  credential=(await issuePartnerCredential(opened.db,clock,admin,partner,principalId,{scopes:[...PARTNER_SCOPES],expiresAt:expires()},'setup')).token;
  grantA=(await createDelegation(opened.db,clock,ownerA,merchantA,{partnerOrganizationId:partner,scopes:[...PARTNER_SCOPES],operatorUserIds:[opA,opP],expiresAt:expires()},'setup')).id;
  grantB=(await createDelegation(opened.db,clock,ownerB,merchantB,{partnerOrganizationId:partner,scopes:[...PARTNER_SCOPES],operatorUserIds:[opB],expiresAt:expires()},'setup')).id;
  accountA=(await createIntegrationAccount(opened.db,clock,ownerA,merchantA,{provider:'reference',externalAccountId:'merchant-a'},'setup')).id;
  accountB=(await createIntegrationAccount(opened.db,clock,ownerB,merchantB,{provider:'reference',externalAccountId:'merchant-b'},'setup')).id;
  const deps={db:opened.db,clock,auth:new BearerUserAdapter(opened.db),devAuth:true,testFixtures:true,webhookConfig,publicBaseUrl:'https://example.com'} as AppDependencies;
  app=express();app.use(express.json({limit:'1mb'}));app.use('/v1/partner',createPartnerRouter(deps));app.use('/me/organizations',createOrganizationRouter(deps));
  app.use((e:unknown,_r:express.Request,s:express.Response,_n:express.NextFunction)=>{if(e instanceof DomainError)s.status(e.httpStatus).json({code:e.code});else s.status(500).json({error:String(e)});});
 },60000);
 afterAll(async()=>{await opened?.close();vi.unstubAllEnvs();});
 it('rejects duplicate integration namespaces without changing their merchant ownership',async()=>{
  for(const [owner,merchant] of [[ownerA,merchantA],[ownerB,merchantB]]){
   const denied=await request(app).post(`/me/organizations/${merchant}/integration-accounts`).set('Authorization',`Bearer ${owner}`).set('Idempotency-Key',`namespace-conflict-${merchant}`).send({provider:'reference',externalAccountId:'merchant-a'});
   expect(denied.status,denied.text).toBe(409);expect(denied.body.code).toBe('INTEGRATION_ACCOUNT_CONFLICT');
  }
  expect((await opened.db.query("SELECT id,merchant_id FROM platform_integration_accounts WHERE environment='sandbox' AND provider='reference' AND external_account_id='merchant-a'")).rows).toEqual([{id:accountA,merchant_id:merchantA}]);
 });
 it('T01 creates one canonical Proof per scoped order and preserves actual service and operator identities',async()=>{
  const a=await request(app).post('/v1/partner/proofs').set(headers()).set('Idempotency-Key','import-a').send(importBody());
  expect(a.status,a.text).toBe(201);proofA=a.body.proofId;
  const retry=await request(app).post('/v1/partner/proofs').set(headers()).set('Idempotency-Key','import-a').send(importBody());expect(retry.body).toEqual(a.body);
  const otherKey=await request(app).post('/v1/partner/proofs').set(headers()).set('Idempotency-Key','import-a-new-key').send(importBody());expect(otherKey.body.proofId).toBe(proofA);
  const b=await request(app).post('/v1/partner/proofs').set(headers(merchantB,grantB)).set('Idempotency-Key','import-b').send(importBody(accountB,memberB));expect(b.status,b.text).toBe(201);proofB=b.body.proofId;expect(proofB).not.toBe(proofA);
  const changed=await request(app).post('/v1/partner/proofs').set(headers()).set('Idempotency-Key','import-a').send({...importBody(),transaction:{itemTitle:'Changed'}});expect(changed.status).toBe(409);
  const rows=await opened.db.query<{created_by:string;user_id:string;actor_user_id:string}>(`SELECT t.created_by,p.user_id,s.actor_user_id FROM proofs f JOIN transactions t ON t.id=f.transaction_id JOIN proof_participants p ON p.proof_id=f.id AND p.role='SELLER' JOIN platform_principals s ON s.id=$2 WHERE f.id=$1`,[proofA,principalId]);
  expect(rows.rows[0].created_by).toBe(rows.rows[0].actor_user_id);expect(rows.rows[0].user_id).toBe(opA);expect(rows.rows[0].created_by).not.toBe(ownerA);
  await expect(commitAttestation(opened.db,clock,rows.rows[0].actor_user_id,proofA,{statement:'PACKED_DESCRIBED_ITEM'})).rejects.toMatchObject({code:'HUMAN_AUTHENTICATION_REQUIRED'});
 });
 it('T02 denies crossed resources, namespaces, actors, lists and forged privilege fields',async()=>{
  expect((await request(app).get(`/v1/partner/proofs/${proofA}`).set(headers(merchantB,grantB))).status).toBe(404);
  expect((await request(app).get('/v1/partner/proofs/resolve').query({integrationAccountId:accountA,externalId:'ORDER-1001'}).set(headers(merchantB,grantB))).status).toBe(404);
  const list=await request(app).get('/v1/partner/proofs').set(headers(merchantB,grantB));expect(list.body.proofIds).toEqual([proofB]);
  expect((await request(app).get('/v1/partner/proofs').query({after:list.body.nextCursor}).set(headers())).status).toBe(400);
  expect((await request(app).post(`/v1/partner/proofs/${proofA}/capture-intents`).set(headers(merchantB,grantB)).set('Idempotency-Key','cross-capture').send({})).status).toBe(404);
  expect((await request(app).get(`/v1/partner/proofs/${proofA}/package`).set(headers(merchantB,grantB))).status).toBe(404);
  const forged=await request(app).post('/v1/partner/proofs').set(headers()).set('Idempotency-Key','forged').send({...importBody(),actorId:opB});expect(forged.status).toBe(400);
  await expect(authorizeProofAccess(opened.db,proofA,opB)).rejects.toMatchObject({code:'PARTICIPANT_NOT_AUTHORIZED'});
  const stream=await request(app).get('/v1/partner/event-stream').set(headers());expect(stream.status,stream.text).toBe(200);expect(stream.body.events.every((e:{data:{proofId:string}})=>e.data.proofId===proofA)).toBe(true);
  expect((await request(app).get('/v1/partner/event-stream').query({after:stream.body.nextCursor}).set(headers(merchantB,grantB))).status).toBe(400);
 });
 it('preserves all partner item rows and binds every field to immutable order identity',async()=>{
  const items=[
   {externalItemId:'line-a',title:'Blue widget',description:'Blue finish',sku:'BLUE',quantity:2,unitValue:12.5,currency:'USD'},
   {externalItemId:'line-b',title:'Green widget',sku:'GREEN',quantity:1,unitValue:3.25,currency:'USD'}
  ];
  const body={...importBody(),externalId:'MULTI-1001',transaction:{items,amount:{minorUnits:'2825',currency:'USD'}}};
  const result=await request(app).post('/v1/partner/proofs').set(headers()).set('Idempotency-Key','multi-first').send(body);
  expect(result.status,result.text).toBe(201);
  const id=result.body.proofId;
  const view=await request(app).get(`/v1/partner/proofs/${id}`).set(headers());
  expect(view.status,view.text).toBe(200);
  expect(view.body.proof.transaction.quantity).toBe(3);
  expect(view.body.proof.transaction.items).toHaveLength(2);
  expect(view.body.proof.transaction.items.map(({itemId,...item}:any)=>item)).toEqual([
   {externalItemId:'line-a',position:1,title:'Blue widget',description:'Blue finish',sku:'BLUE',quantity:2,unitValue:12.5,currency:'USD'},
   {externalItemId:'line-b',position:2,title:'Green widget',description:null,sku:'GREEN',quantity:1,unitValue:3.25,currency:'USD'}
  ]);
  expect(view.body.proof.transaction.metadata.orderSnapshot).toEqual(body.transaction);
  const replay=await request(app).post('/v1/partner/proofs').set(headers()).set('Idempotency-Key','multi-other-key').send(body);
  expect(replay.status,replay.text).toBe(201);expect(replay.body.proofId).toBe(id);expect(replay.body.created).toBe(false);
  const changed=await request(app).post('/v1/partner/proofs').set(headers()).set('Idempotency-Key','multi-changed').send({...body,transaction:{...body.transaction,items:[items[0],{...items[1],sku:'ALTERED'}]}});
  expect(changed.status,changed.text).toBe(409);expect(changed.body.code).toBe('EXTERNAL_ID_CONFLICT');
  const mismatched=await request(app).post('/v1/partner/proofs').set(headers()).set('Idempotency-Key','multi-bad-summary').send({...body,externalId:'INVALID-SUMMARY',transaction:{...body.transaction,quantity:1}});
  expect(mismatched.status,mismatched.text).toBe(400);
  expect((await opened.db.query("SELECT proof_id FROM platform_external_bindings WHERE merchant_id=$1 AND external_id='INVALID-SUMMARY'",[merchantA])).rows).toHaveLength(0);
  const counts=await opened.db.query<{roots:string;items:string}>(`SELECT (SELECT count(*) FROM proofs WHERE id=$1)::text AS roots,
    (SELECT count(*) FROM transaction_items WHERE transaction_id=(SELECT transaction_id FROM proofs WHERE id=$1))::text AS items`,[id]);
  expect(counts.rows[0]).toEqual({roots:'1',items:'2'});
 });
 it('supports a third operator without granting partner authority to another merchant',async()=>{
  const third=await request(app).post('/v1/partner/proofs').set(headers()).set('Idempotency-Key','third').send({...importBody(accountA,memberP),externalId:'PARTNER-OPERATOR'});expect(third.status,third.text).toBe(201);
  await expect(authorizeProofAccess(opened.db,third.body.proofId,opP,'SELLER')).resolves.toMatchObject({user_id:opP});
  const denied=await request(app).post('/v1/partner/proofs').set(headers(merchantB,grantB)).set('Idempotency-Key','third-denied').send({...importBody(accountB,memberP),externalId:'PARTNER-OPERATOR'});expect(denied.status).toBe(403);
 });
 it('uses the shared capture, human attestation, finalization and delegated package services',async()=>{
  const imported=await request(app).post('/v1/partner/proofs').set(headers()).set('Idempotency-Key','complete-proof').send({...importBody(),externalId:'COMPLETE'});
  const id=imported.body.proofId;
  const intent=await request(app).post(`/v1/partner/proofs/${id}/capture-intents`).set(headers()).set('Idempotency-Key','complete-intent').send({allowedSurfaces:['WEB']});expect(intent.status,intent.text).toBe(201);
  const bound=await bindIntent(opened.db,clock,opA,{launchToken:intent.body.launchToken,capabilities:caps});
  const bytes=await readFile(new URL('./fixtures/camera-recording.mp4',import.meta.url));
  const source={sha256:sha256Hex(bytes),byteSize:bytes.length,contentType:'video/mp4',durationMs:200},hash=async(value:string)=>sha256Hex(value);
  const segment=await chainSegment({sequence:0,offsetBytes:0,byteSize:bytes.length,sha256:source.sha256,previous:null,startMs:0,endMs:200,timing:'WHOLE_RECORDING'},hash);
  const observations:Observation[]=[{id:'start',captureId:bound.session.id,type:'CAPTURE_STARTED',startMs:0,endMs:0,source:'DEVICE',model:null,confidence:null,value:null,timePrecision:'APPROXIMATE'},{id:'end',captureId:bound.session.id,type:'CAPTURE_ENDED',startMs:200,endMs:200,source:'DEVICE',model:null,confidence:null,value:null,timePrecision:'APPROXIMATE'}];
  const manifest=await createManifest(bound.context,source,[segment],observations,hash),digest=await manifestDigest(manifest,hash);
  await completeCaptureSession(opened.db,clock,opA,id,bound.session.id,{...source,recordedDurationMs:200});
  await sealCapture(opened.db,clock,opA,bound.session.id,{source,segments:[segment],observations,sha256:digest});
  const upload=await initializeEvidenceUpload(opened.db,clock,store,opA,id,{contentType:'video/mp4',evidenceType:'FULFILLMENT_CAPTURE',captureSessionId:bound.session.id,idempotencyKey:'source'});
  await store.put(upload.objectKey,bytes,'video/mp4');await commitEvidence(opened.db,clock,store,opA,id,upload.evidenceId);
  await commitAttestation(opened.db,clock,opA,id,{statement:'PACKED_DESCRIBED_ITEM',relatedEvidenceId:upload.evidenceId});
  const final=await finalizeProof(opened.db,clock,opA,id);expect(final.proof.transaction.sellerUserId).toBe(opA);
  const actor=await authenticatePartner(opened.db,clock,`Bearer ${credential}`,merchantA,grantA,'export');
  const zip=await exportEvidencePackage(withPartnerReadGrant(opened.db,clock,actor,id,'exports:read'),clock,store,actor.actorUserId,id);
  expect(zip.subarray(0,2).toString()).toBe('PK');
  expect((await finalizeProof(opened.db,clock,opA,id)).manifest.canonicalJson).toBe(final.manifest.canonicalJson);
  expect((await opened.db.query('SELECT DISTINCT attested_by FROM attestations WHERE proof_id=$1',[id])).rows).toEqual([{attested_by:opA}]);
  const boundary=await request(app).get('/v1/partner/event-stream').set(headers());
  expect(boundary.status,boundary.text).toBe(200);
  const bindingBody={integrationAccountId:accountA,resourceType:'SHIPMENT',externalId:'SHIPMENT-AFTER-FINALIZATION'};
  const binding=await request(app).post(`/v1/partner/proofs/${id}/external-bindings`).set(headers()).set('Idempotency-Key','binding-after-finalization').send(bindingBody);
  expect(binding.status,binding.text).toBe(201);expect(binding.body.created).toBe(true);
  const changed=await request(app).get('/v1/partner/event-stream').query({after:boundary.body.highWaterMark}).set(headers());
  expect(changed.status,changed.text).toBe(200);
  expect(changed.body.events).toHaveLength(1);
  expect(changed.body.events[0]).toMatchObject({type:'proof.external_binding_added',data:{proofId:id}});
  const eventId=changed.body.events[0].id;
  const bindingReplay=await request(app).post(`/v1/partner/proofs/${id}/external-bindings`).set(headers()).set('Idempotency-Key','binding-other-key').send(bindingBody);
  expect(bindingReplay.status,bindingReplay.text).toBe(201);expect(bindingReplay.body.created).toBe(false);
  const unchanged=await request(app).get('/v1/partner/event-stream').query({after:changed.body.highWaterMark}).set(headers());
  expect(unchanged.status,unchanged.text).toBe(200);expect(unchanged.body.events).toEqual([]);
  expect((await opened.db.query('SELECT id FROM proof_outbox WHERE id=$1',[eventId])).rows).toHaveLength(1);
  expect((await opened.db.query("SELECT event_data->>'provenance' AS provenance FROM audit_events WHERE proof_id=$1 AND event_type='EXTERNAL_BINDING_ADDED'",[id])).rows).toEqual([{provenance:'INTEGRATION_ASSERTION'}]);
  expect((await finalizeProof(opened.db,clock,opA,id)).manifest.canonicalJson).toBe(final.manifest.canonicalJson);
 });
 it('T03 binds capture to the authenticated assigned operator and revokes pending work and replays',async()=>{
  const intent=await request(app).post(`/v1/partner/proofs/${proofA}/capture-intents`).set(headers()).set('Idempotency-Key','capture').send({allowedSurfaces:['WEB']});expect(intent.status,intent.text).toBe(201);
  await expect(bindIntent(opened.db,clock,opB,{launchToken:intent.body.launchToken,capabilities:caps})).rejects.toMatchObject({code:'CAPTURE_INTENT_INVALID'});
  const wh=await request(app).post('/v1/partner/webhooks').set(headers()).set('Idempotency-Key','webhook').send({url:'https://example.com/events',eventTypes:['proof.created']});expect(wh.status,wh.text).toBe(201);
  expect((await request(app).post('/v1/partner/proofs').set(headers()).set('Idempotency-Key','queued-webhook').send({...importBody(),externalId:'AFTER-SUBSCRIPTION'})).status).toBe(201);
  const actor=await authenticatePartner(opened.db,clock,`Bearer ${credential}`,merchantA,grantA,'actor-check');
  await revokeDelegation(opened.db,clock,ownerA,merchantA,grantA,'revoke');
  await expect(reauthorizePartner(opened.db,clock,actor,'proofs:read')).rejects.toMatchObject({code:'INSUFFICIENT_SCOPE'});
  await expect(bindIntent(opened.db,clock,opA,{launchToken:intent.body.launchToken,capabilities:caps})).rejects.toMatchObject({code:'ORGANIZATION_ACCESS_REVOKED'});
  expect((await request(app).post(`/v1/partner/proofs/${proofA}/capture-intents`).set(headers()).set('Idempotency-Key','capture').send({allowedSurfaces:['WEB']})).status).toBe(404);
  let sent=0;await dispatchWebhooks(opened.db,clock,webhookConfig,async()=>{sent++;return 200;});expect(sent).toBe(0);
  expect((await opened.db.query('SELECT id FROM api_webhook_deliveries WHERE webhook_id=$1',[wh.body.id])).rows.length).toBeGreaterThan(0);
  await revokeOrganizationMember(opened.db,clock,ownerB,merchantB,memberB,'revoke-operator');
  await expect(authorizeProofAccess(opened.db,proofB,opB)).rejects.toMatchObject({code:'ORGANIZATION_ACCESS_REVOKED'});
  expect((await opened.db.query('SELECT 1 FROM proof_participants WHERE proof_id=$1 AND user_id=$2',[proofB,opB])).rows).toHaveLength(1);
  expect(await listMyProofs(opened.db,opB)).toEqual([]);
  expect((await queryMyProofs(opened.db,opB,{view:'all',q:'',limit:100,offset:0},clock.now())).total).toBe(0);
  expect((await opened.db.query("SELECT 1 FROM policy_recovery_events WHERE table_name='platform_delegations' AND operation='UPDATE' AND after_json->>'revoked_at' IS NOT NULL")).rows.length).toBeGreaterThan(0);
 });
 it('management derives authority from the current person and rejects cross-organization administration',async()=>{
  const denied=await request(app).post(`/me/organizations/${merchantA}/memberships`).set('Authorization',`Bearer ${ownerB}`).set('Idempotency-Key','admin-cross').send({userId:opB,role:'ADMIN'});expect(denied.status).toBe(404);
  const selfEnable=await request(app).post(`/me/organizations/${merchantA}/entitlement`).set('Authorization',`Bearer ${ownerA}`).set('Idempotency-Key','enable').send({enabled:true});expect(selfEnable.status).toBe(403);
  const adminView=await request(app).get(`/me/organizations/${partner}/administration`).set('Authorization',`Bearer ${admin}`);expect(adminView.status).toBe(200);expect(JSON.stringify(adminView.body)).not.toContain(credential);
 });
});
