import {beforeAll,afterAll,it,expect,vi} from 'vitest';
import express from 'express';
import {rateLimit} from 'express-rate-limit';
import {randomBytes} from 'node:crypto';
import request from './in-process-http.js';
import {openIsolatedTestDatabase} from './isolated-test-database.js';
import {migrate} from '../src/db/migrate.js';
import {insertUser} from '../src/domain/users.js';
import {DomainError} from '../src/domain/errors.js';
import {createOrganization,setOrganizationEntitlement,createServicePrincipal,issuePartnerCredential,createIntegrationAccount,addOrganizationMember,
 authenticatePartner,createDelegation,revokeDelegation,revokePartnerCredential,auditOrganization,PARTNER_SCOPES,type PartnerActor} from '../src/platform/organizations.js';
import {requirePartnerFeature,createPartnerRouter} from '../src/platform/partner-router.js';
import {importPartnerOrder,requestOperatorCapture} from '../src/platform/partner-proofs.js';
import {createWebhook,revokeWebhook,dispatchWebhooks,verifyWebhook} from '../src/platform/webhooks.js';
import {createRecordIssue} from '../src/records/service.js';
import {createPartnerOperationsRouter} from '../src/records/partner-operations-router.js';
import {acceptSourceIngestion,processSourceIngestions} from '../src/records/ingestions.js';
import {MemoryObjectStore} from './memory-object-store.js';
import {authorizeProofAccess} from '../src/domain/proof-access.js';
import {requireCaptureOrganizationAuthorization} from '../src/platform/organization-access.js';
import type {AppDependencies} from '../src/app.js';

let opened:Awaited<ReturnType<typeof openIsolatedTestDatabase>>,app:express.Express;
let clockMs=Date.now();const clock={now:()=>new Date(clockMs)},expires=()=>new Date(clockMs+86400000).toISOString();
const config={encryptionKey:randomBytes(32).toString('base64'),allowedHosts:['example.com']};
let admin:string,owner:string,other:string,org:string,otherOrg:string,partnerOrg:string,account:string,otherAccount:string,csvAccount:string;
let full:string,readOnly:string,otherFull:string,peer:string,partnerToken:string,grantA:string,grantB:string,fullId:string;
let actorA:PartnerActor,actorB:PartnerActor,proof:string,proofB:string,issueA:string,issueA2:string,issueB:string;
let webhook:string,secret:string,delivery:string,eventId:string,peerDelivery:string;
const headers=(token=full,merchant=org,grant?:string)=>({Authorization:`Bearer ${token}`,'PackProof-Merchant-Id':merchant,...(grant?{'PackProof-Delegation-Id':grant}:{})});
async function credential(user:string,organization:string,scopes:readonly string[],name:string) {
  const principal=await createServicePrincipal(opened.db,clock,user,organization,{name},'setup');
  return issuePartnerCredential(opened.db,clock,user,organization,principal.id,{scopes:[...scopes],expiresAt:expires()},'setup');
}
async function actor(token:string,merchant:string,grant?:string){return authenticatePartner(opened.db,clock,`Bearer ${token}`,merchant,grant,'test-request');}
async function bindHook(token:string,merchant:string,grant?:string) {
  const a=await actor(token,merchant,grant),hook=await createWebhook(opened.db,clock,a.tenantId,{url:'https://example.com/events',eventTypes:['proof.created']},config);
  await opened.db.query('INSERT INTO platform_webhook_authorizations(webhook_id,merchant_id,credential_id,delegation_id) VALUES($1,$2,$3,$4)',[hook.id,merchant,a.credentialId,a.delegationGrantId]);return hook;
}
async function deadDelivery(hookId:string,event:string,id=`${hookId}:${event}`) {
  await opened.db.query("INSERT INTO api_webhook_deliveries(id,webhook_id,event_id,state,attempts,next_attempt_at,last_status) VALUES($1,$2,$3,'dead',10,$4,503)",[id,hookId,event,clock.now().toISOString()]);return id;
}
beforeAll(async()=>{
  vi.stubEnv('PACKPROOF_ORGANIZATIONS_ENABLED','true');vi.stubEnv('PACKPROOF_EVENT_CURSOR_KEY',randomBytes(32).toString('base64'));
  opened=await openIsolatedTestDatabase();await migrate(opened.db);
  [admin,owner,other]=await Promise.all(Array.from({length:3},()=>insertUser(opened.db,clock)));
  await opened.db.query("INSERT INTO user_verified_contacts(user_id,email_normalized,verified_at,source) VALUES($1,'nericollin@gmail.com',$2,'COGNITO')",[admin,clock.now().toISOString()]);
  org=(await createOrganization(opened.db,clock,admin,{kind:'MERCHANT',name:'Operations A',ownerUserId:owner},'setup')).id;
  otherOrg=(await createOrganization(opened.db,clock,admin,{kind:'MERCHANT',name:'Operations B',ownerUserId:other},'setup')).id;
  partnerOrg=(await createOrganization(opened.db,clock,admin,{kind:'PARTNER',name:'Operations partner'},'setup')).id;
  for(const id of [org,otherOrg,partnerOrg])await setOrganizationEntitlement(opened.db,clock,admin,id,{enabled:true},'setup');
  const issued=await credential(owner,org,PARTNER_SCOPES,'Main service');full=issued.token;fullId=issued.id;
  readOnly=(await credential(owner,org,['proofs:read'],'Read-only service')).token;
  peer=(await credential(owner,org,['proofs:read','webhooks:manage'],'Another webhook owner')).token;
  otherFull=(await credential(other,otherOrg,PARTNER_SCOPES,'Other merchant service')).token;
  partnerToken=(await credential(admin,partnerOrg,PARTNER_SCOPES,'Partner service')).token;
  grantA=(await createDelegation(opened.db,clock,owner,org,{partnerOrganizationId:partnerOrg,scopes:[...PARTNER_SCOPES],operatorUserIds:[owner],expiresAt:expires()},'setup')).id;
  grantB=(await createDelegation(opened.db,clock,other,otherOrg,{partnerOrganizationId:partnerOrg,scopes:[...PARTNER_SCOPES],operatorUserIds:[other],expiresAt:expires()},'setup')).id;
  actorA=await actor(full,org);actorB=await actor(otherFull,otherOrg);
  account=(await createIntegrationAccount(opened.db,clock,owner,org,{provider:'reference',externalAccountId:'PRIVATE-SOURCE-REFERENCE-A'},'setup')).id;
  csvAccount=(await createIntegrationAccount(opened.db,clock,owner,org,{provider:'csv',externalAccountId:'warehouse-file'},'setup')).id;
  otherAccount=(await createIntegrationAccount(opened.db,clock,other,otherOrg,{provider:'reference',externalAccountId:'PRIVATE-SOURCE-REFERENCE-B'},'setup')).id;
  const hook=await bindHook(full,org);webhook=hook.id;secret=hook.secret;const peerHook=await bindHook(peer,org);
  const memberA=(await opened.db.query<{id:string}>('SELECT id FROM platform_memberships WHERE organization_id=$1 AND user_id=$2',[org,owner])).rows[0].id;
  const memberB=(await opened.db.query<{id:string}>('SELECT id FROM platform_memberships WHERE organization_id=$1 AND user_id=$2',[otherOrg,other])).rows[0].id;
  proof=(await importPartnerOrder(opened.db,clock,actorA,{integrationAccountId:account,externalId:'ORDER-A',operatorMembershipId:memberA,transaction:{itemTitle:'Merchant A shipment'}})).proofId;
  proofB=(await importPartnerOrder(opened.db,clock,actorB,{integrationAccountId:otherAccount,externalId:'ORDER-B',operatorMembershipId:memberB,transaction:{itemTitle:'Private merchant B shipment'}})).proofId;
  const issue=(title:string)=>({category:'quantity_mismatch',severity:'warning' as const,title,subjectId:proof,ruleVersion:'quantity/v1',comparedSources:{expected:{source:'Pick list',value:4},observed:{source:'Loading',value:3}}});
  issueA=await createRecordIssue(opened.db,clock,proof,issue('Shipment quantity differs'));issueA2=await createRecordIssue(opened.db,clock,proof,issue('Another discrepancy'));
  issueB=await createRecordIssue(opened.db,clock,proofB,{...issue('PRIVATE-ISSUE-B'),subjectId:proofB});
  eventId=(await opened.db.query<{id:string}>("SELECT id FROM proof_outbox WHERE proof_id=$1 AND event_type='proof.created'",[proof])).rows[0].id;
  delivery=await deadDelivery(webhook,eventId);peerDelivery=await deadDelivery(peerHook.id,eventId);
  await auditOrganization(opened.db,clock,{actor:actorB,requestId:'private',operation:'PRIVATE_ADMIN_MARKER_B',resourceId:proofB});
  await auditOrganization(opened.db,clock,{actor:await actor(partnerToken,org,grantA),requestId:'delegated',operation:'DELEGATED_OPERATION_A',resourceId:proof});
  const deps={db:opened.db,clock,webhookConfig:config} as AppDependencies;
  app=express();app.use(express.json());
  // Keep the fixture's credential boundary bounded just like the production adapter.
  app.use(rateLimit({windowMs:60_000,limit:1000,keyGenerator:()=> 'operations-fixture'}));
  app.use('/v1/partner',(r,s,n)=>{try{requirePartnerFeature();}catch(e){n(e);return;}
    void authenticatePartner(opened.db,clock,r.header('Authorization'),r.header('PackProof-Merchant-Id'),r.header('PackProof-Delegation-Id'),'request-test').then(a=>{(r as any).partnerActor=a;n();}).catch(n);});
  app.use('/v1/partner',createPartnerOperationsRouter(deps));
  app.use((e:unknown,_r:express.Request,s:express.Response,_n:express.NextFunction)=>{if(e instanceof DomainError)s.status(e.httpStatus).json({code:e.code});else s.status(500).json({error:String(e)});});
},90000);
afterAll(async()=>{await opened?.close();vi.unstubAllEnvs();});

it('reports current effective scopes and tested limits without granting privileged actions',async()=>{
  const fullResult=await request(app).get('/v1/partner/limits').set(headers());expect(fullResult.status,fullResult.text).toBe(200);
  expect(fullResult.body).toMatchObject({merchantId:org,environment:'sandbox',limits:{recordPageSize:100,activeWebhookEndpoints:10,csv:{rows:1000,access:'organization_credential'}},capabilities:{auditRead:true,connectionAdministration:false}});
  const read=await request(app).get('/v1/partner/limits').set(headers(readOnly));expect(read.body.effectiveScopes).toEqual(['proofs:read']);expect(read.body.capabilities.auditRead).toBe(false);
  expect(JSON.stringify(fullResult.body)).not.toContain(full);
  expect((await request(app).get('/v1/partner/limits')).status).toBe(401);
});
it('scopes issue data and signed cursors by merchant, credential, query and resource',async()=>{
  const first=await request(app).get('/v1/partner/issues').query({limit:'1'}).set(headers(readOnly));expect(first.status,first.text).toBe(200);expect(first.body.issues).toHaveLength(1);expect(first.body.nextCursor).toBeTruthy();
  const next=await request(app).get('/v1/partner/issues').query({limit:'1',cursor:first.body.nextCursor}).set(headers(readOnly));expect(next.status).toBe(200);expect(next.body.issues[0].id).not.toBe(first.body.issues[0].id);
  expect(JSON.stringify(first.body)).not.toContain('PRIVATE-ISSUE-B');
  expect((await request(app).get('/v1/partner/issues').query({limit:'1',cursor:first.body.nextCursor}).set(headers(otherFull,otherOrg))).status).toBe(400);
  expect((await request(app).get('/v1/partner/issues').query({limit:'1',cursor:first.body.nextCursor}).set(headers())).status).toBe(400);
  expect((await request(app).get('/v1/partner/issues').query({proofId:proofB}).set(headers())).status).toBe(404);
});
it('requires a scoped writer, expected revision, stable key and reason for issue review',async()=>{
  const path=`/v1/partner/issues/${issueA}/actions`,body={action:'resolve',reason:'Reviewed the source discrepancy'};
  expect((await request(app).post(path).set(headers(readOnly)).set('If-Match','"1"').set('Idempotency-Key','denied').send(body)).status).toBe(403);
  expect((await request(app).post(path).set(headers()).set('Idempotency-Key','missing-revision').send(body)).status).toBe(428);
  expect((await request(app).post(`/v1/partner/issues/${issueB}/actions`).set(headers()).set('If-Match','"1"').set('Idempotency-Key','crossed').send(body)).status).toBe(404);
  const sent=await request(app).post(path).set(headers()).set('If-Match','"1"').set('Idempotency-Key','review-one').send(body);expect(sent.status,sent.text).toBe(200);expect(sent.body.revision).toBe(2);
  const again=await request(app).post(path).set(headers()).set('If-Match','"1"').set('Idempotency-Key','review-one').send(body);expect(again.body).toEqual(sent.body);expect(again.headers['idempotency-replayed']).toBe('true');
  expect((await request(app).post(path).set(headers()).set('If-Match','"1"').set('Idempotency-Key','review-one').send({...body,reason:'Different'})).status).toBe(409);
  expect((await request(app).post(path).set(headers()).set('If-Match','"1"').set('Idempotency-Key','review-stale').send(body)).status).toBe(412);
});
it('shows truthful source health and never reveals source references or admin controls',async()=>{
  const result=await request(app).get('/v1/partner/connections').set(headers(readOnly));expect(result.status,result.text).toBe(200);
  expect(result.body.connections.find((c:any)=>c.id===account)).toMatchObject({state:'freshness_unknown',capabilities:{automaticSync:false,manage:false}});
  expect(result.body.connections.find((c:any)=>c.id===csvAccount)).toMatchObject({state:'not_applicable',capability:'one_time_import'});
  expect(JSON.stringify(result.body)).not.toContain('PRIVATE-SOURCE-REFERENCE');expect(JSON.stringify(result.body)).not.toContain(otherAccount);
});
it('requires explicit audit:read and keeps delegated audits within the current grant and principal',async()=>{
  expect((await request(app).get('/v1/partner/audit-events').set(headers(readOnly))).status).toBe(403);
  const result=await request(app).get('/v1/partner/audit-events').set(headers());expect(result.status,result.text).toBe(200);expect(result.body.events.length).toBeGreaterThan(0);expect(JSON.stringify(result.body)).not.toContain('PRIVATE_ADMIN_MARKER_B');
  const delegated=await request(app).get('/v1/partner/audit-events').set(headers(partnerToken,org,grantA));expect(delegated.status,delegated.text).toBe(200);
  expect(delegated.body.events.map((e:any)=>e.operation)).toEqual(['DELEGATED_OPERATION_A']);
  expect(JSON.stringify(result.body)).not.toContain(secret);expect(JSON.stringify(result.body)).not.toContain(full);
});
it('exposes only deliveries owned by the current credential and delegation, without secrets or endpoint URLs',async()=>{
  const result=await request(app).get('/v1/partner/webhook-deliveries').set(headers());expect(result.status,result.text).toBe(200);
  expect(result.body.deliveries.map((d:any)=>d.id)).toEqual([delivery]);expect(result.body.deliveries[0]).toMatchObject({eventId,state:'dead',attempts:10,lastStatus:503});
  expect(JSON.stringify(result.body)).not.toContain(secret);expect(JSON.stringify(result.body)).not.toContain('example.com');expect(JSON.stringify(result.body)).not.toContain(peerDelivery);
  const denied=await request(app).post(`/v1/partner/webhook-deliveries/${encodeURIComponent(peerDelivery)}/replay`).set(headers()).set('Idempotency-Key','not-owner').send({reason:'Retry'});expect(denied.status).toBe(404);
  expect((await request(app).get('/v1/partner/webhook-deliveries').set(headers(readOnly))).status).toBe(403);
});
it('replays a failed delivery once, preserves its event identity and audits the prior attempt count',async()=>{
  const path=`/v1/partner/webhook-deliveries/${encodeURIComponent(delivery)}/replay`,body={reason:'The destination is available again'};
  const result=await request(app).post(path).set(headers()).set('Idempotency-Key','replay-one').send(body);expect(result.status,result.text).toBe(202);expect(result.body).toMatchObject({deliveryId:delivery,eventId,priorAttemptCount:10,state:'pending',reason:body.reason,signatureTimestamp:'generated_at_dispatch'});
  const same=await request(app).post(path).set(headers()).set('Idempotency-Key','replay-one').send(body);expect(same.body).toEqual(result.body);expect(same.headers['idempotency-replayed']).toBe('true');
  expect((await request(app).post(path).set(headers()).set('Idempotency-Key','replay-one').send({reason:'Changed input'})).status).toBe(409);
  expect((await opened.db.query("SELECT id FROM audit_events WHERE proof_id=$1 AND event_type='WEBHOOK_DELIVERY_REPLAY_REQUESTED'",[proof])).rows).toHaveLength(1);
  const diagnostics=await request(app).get('/v1/partner/webhook-deliveries').set(headers());expect(diagnostics.body.deliveries[0].replays).toEqual([expect.objectContaining({id:result.body.replayId,priorAttemptCount:10,reason:body.reason})]);
});
it('dispatches the original body with a fresh delivery signature timestamp after manual replay',async()=>{
  const originalTimestamp=clockMs;clockMs+=60000;const sent:Array<{body:string;headers:Record<string,string>}>=[];
  await dispatchWebhooks(opened.db,clock,config,async(_url,body,headers)=>{sent.push({body,headers});return 204;},100);
  const delivered=sent.find(row=>row.headers['PackProof-Event-Id']===eventId&&verifyWebhook(secret,row.headers['PackProof-Signature'],row.body,Math.floor(clockMs/1000)));
  expect(delivered).toBeTruthy();expect(JSON.parse(delivered!.body)).toMatchObject({id:eventId,data:{proofId:proof}});expect(delivered!.headers['PackProof-Signature']).toContain(`t=${Math.floor(clockMs/1000)},`);
  expect(delivered!.headers['PackProof-Signature']).not.toContain(`t=${Math.floor(originalTimestamp/1000)},`);
  expect((await opened.db.query('SELECT event_id,state FROM api_webhook_deliveries WHERE id=$1',[delivery])).rows[0]).toEqual({event_id:eventId,state:'delivered'});
});
it('rechecks webhook and credential revocation before returning cached replay acceptance',async()=>{
  const issued=await credential(owner,org,['webhooks:manage'],'Revocation test'),hook=await bindHook(issued.token,org),id=await deadDelivery(hook.id,eventId);
  const path=`/v1/partner/webhook-deliveries/${encodeURIComponent(id)}/replay`,h=headers(issued.token),body={reason:'Retry destination'};
  expect((await request(app).post(path).set(h).set('Idempotency-Key','revoke-replay').send(body)).status).toBe(202);
  await revokeWebhook(opened.db,clock,actorA.tenantId,hook.id);
  expect((await request(app).post(path).set(h).set('Idempotency-Key','revoke-replay').send(body)).status).toBe(404);
  await revokePartnerCredential(opened.db,clock,owner,org,issued.id,'revoke');
  expect((await request(app).post(path).set(h).set('Idempotency-Key','revoke-replay').send(body)).status).toBe(401);
});
it('resolves delegated audit resources and correlations, rejects unknown kinds and hides every located operation member',async()=>{
  const delegated=await actor(partnerToken,org,grantA),member=(await opened.db.query<{operator_membership_id:string}>('SELECT operator_membership_id FROM platform_proof_ownership WHERE proof_id=$1',[proof])).rows[0].operator_membership_id;
  const second=(await importPartnerOrder(opened.db,clock,actorA,{integrationAccountId:account,externalId:'AUDIT-SECOND-RECORD',operatorMembershipId:member,transaction:{itemTitle:'A second accessible shipment'}})).proofId;
  const accepted=await acceptSourceIngestion(opened.db,clock,delegated,{connectionId:account,events:[
    {sourceEventId:'audit-source-one',proofId:proof,eventType:'IN_TRANSIT',reportedAt:clock.now().toISOString(),data:{status:'moving'}},
    {sourceEventId:'audit-source-two',proofId:second,eventType:'IN_TRANSIT',reportedAt:clock.now().toISOString(),data:{status:'moving'}},
  ]},'audit-mixed-ingestion');
  await processSourceIngestions(opened.db,clock,2);
  const receipt=(await opened.db.query<{id:string;canonical_event_id:string;state:string}>('SELECT id,canonical_event_id,state FROM record_source_receipts WHERE operation_id=$1 AND proof_id=$2',[accepted.operationId,proof])).rows[0];
  expect(receipt.state).toBe('imported');expect(receipt.canonical_event_id).toBeTruthy();
  for(const resource of [issueA,delivery,receipt.id,'unresolved-private-resource'])await auditOrganization(opened.db,clock,{actor:delegated,requestId:'audit-resource-fixture',operation:'RESOURCE_MAPPING_CHECK',resourceId:resource});
  const before=await request(app).get('/v1/partner/audit-events').set(headers(partnerToken,org,grantA));expect(before.status,before.text).toBe(200);
  const resources=before.body.events.map((row:any)=>row.resourceId);expect(resources).toContain(receipt.canonical_event_id);expect(resources).toContain(accepted.operationId);expect(resources).toContain(issueA);expect(resources).toContain(delivery);expect(resources).not.toContain('unresolved-private-resource');
  await opened.db.query('INSERT INTO record_locations(id,organization_id,name,created_at) VALUES($1,$2,$3,$4)',['site_audit',org,'Restricted audit site',clock.now().toISOString()]);
  await opened.db.query('UPDATE record_state SET location_id=$2 WHERE proof_id=$1',[proof,'site_audit']);
  const after=await request(app).get('/v1/partner/audit-events').set(headers(partnerToken,org,grantA));expect(after.status,after.text).toBe(200);
  const encoded=JSON.stringify(after.body);for(const hidden of [proof,receipt.canonical_event_id,accepted.operationId,issueA,delivery,receipt.id,'unresolved-private-resource'])expect(encoded).not.toContain(hidden);
  const direct=await request(app).get('/v1/partner/audit-events').set(headers());expect(direct.status).toBe(200);expect(direct.body.events.some((row:any)=>row.resourceId===accepted.operationId)).toBe(true);
  await opened.db.query('UPDATE record_state SET location_id=NULL WHERE proof_id=$1',[proof]);
});
it('blocks located records across legacy delegated routes and tenant-position aggregates while retaining direct ownership',async()=>{
  const legacy=express();legacy.use(express.json());legacy.use('/v1/partner',createPartnerRouter({db:opened.db,clock,webhookConfig:config,objectStore:new MemoryObjectStore(),publicBaseUrl:'https://example.com'} as AppDependencies));
  legacy.use((e:unknown,_r:express.Request,s:express.Response,_n:express.NextFunction)=>{if(e instanceof DomainError)s.status(e.httpStatus).json({code:e.code});else s.status(500).json({error:String(e)});});
  const cursor=await request(legacy).get('/v1/partner/event-stream').set(headers(partnerToken,org,grantA));expect(cursor.status,cursor.text).toBe(200);
  const listing=await request(legacy).get('/v1/partner/proofs').set(headers(partnerToken,org,grantA));expect(listing.status).toBe(200);
  await opened.db.query('UPDATE record_state SET location_id=$2 WHERE proof_id=$1',[proof,'site_audit']);
  for(const path of [`/proofs/${proof}`,`/proofs/${proof}/review`,`/proofs/${proof}/package`,`/proofs/${proof}/integrity-envelopes/not-an-operation/package`]){
    const denied=await request(legacy).get(`/v1/partner${path}`).set(headers(partnerToken,org,grantA));expect(denied.status,denied.text).toBe(404);expect(denied.body.code).toBe('PROOF_NOT_FOUND');
  }
  for(const [path,query]of [['/event-stream',{after:cursor.body.nextCursor}],['/proofs',{after:listing.body.nextCursor}]] as const){
    const denied=await request(legacy).get(`/v1/partner${path}`).query(query).set(headers(partnerToken,org,grantA));expect(denied.status,denied.text).toBe(409);expect(denied.body.code).toBe('LOCATION_SCOPED_AGGREGATE_UNAVAILABLE');expect(denied.body.events).toBeUndefined();expect(denied.body.nextCursor).toBeUndefined();
  }
  expect((await request(legacy).get(`/v1/partner/proofs/${proofB}`).set(headers(partnerToken,org,grantA))).status).toBe(404);
  expect((await request(legacy).get(`/v1/partner/proofs/${proof}`).set(headers())).status).toBe(200);
  expect((await request(legacy).get('/v1/partner/event-stream').set(headers())).status).toBe(200);
  expect((await request(legacy).get('/v1/partner/proofs').set(headers())).status).toBe(200);
  await opened.db.query('UPDATE record_state SET location_id=NULL WHERE proof_id=$1',[proof]);
});
it('withdraws prior delegated capture launches and partner-employee participant authority when a record becomes located',async()=>{
  const employee=await insertUser(opened.db,clock),membership=String((await addOrganizationMember(opened.db,clock,admin,partnerOrg,{userId:employee,role:'OPERATOR'},'setup')).id);
  const grant=(await createDelegation(opened.db,clock,owner,org,{partnerOrganizationId:partnerOrg,scopes:[...PARTNER_SCOPES],operatorUserIds:[employee],expiresAt:expires()},'setup')).id;
  const a=await actor(partnerToken,org,grant),imported=await importPartnerOrder(opened.db,clock,a,{integrationAccountId:account,externalId:'PARTNER-EMPLOYEE-CAPTURE',operatorMembershipId:membership,transaction:{itemTitle:'Assigned partner capture'}});
  const intent=await requestOperatorCapture(opened.db,clock,a,imported.proofId,{allowedSurfaces:['WEB']});
  await expect(requireCaptureOrganizationAuthorization(opened.db,intent.intentId)).resolves.toBeUndefined();await expect(authorizeProofAccess(opened.db,imported.proofId,employee,'SELLER')).resolves.toMatchObject({user_id:employee});
  await opened.db.query('INSERT INTO record_state(proof_id,organization_id,environment,location_id,updated_at) VALUES($1,$2,$3,$4,$5)',[imported.proofId,org,'sandbox','site_audit',clock.now().toISOString()]);
  await expect(requireCaptureOrganizationAuthorization(opened.db,intent.intentId)).rejects.toMatchObject({code:'LOCATION_GRANT_REQUIRED'});
  await expect(authorizeProofAccess(opened.db,imported.proofId,employee,'SELLER')).rejects.toMatchObject({code:'ORGANIZATION_ACCESS_REVOKED'});
  await opened.db.query('UPDATE record_state SET location_id=NULL WHERE proof_id=$1',[imported.proofId]);
});
it('keeps delegated replay identity and revocation tied to the selected merchant grant',async()=>{
  const hook=await bindHook(partnerToken,org,grantA),id=await deadDelivery(hook.id,eventId),path=`/v1/partner/webhook-deliveries/${encodeURIComponent(id)}/replay`,body={reason:'Partner replay'};
  expect((await request(app).post(path).set(headers(partnerToken,otherOrg,grantB)).set('Idempotency-Key','cross-grant').send(body)).status).toBe(404);
  const sent=await request(app).post(path).set(headers(partnerToken,org,grantA)).set('Idempotency-Key','delegated-replay').send(body);expect(sent.status,sent.text).toBe(202);
  await revokeDelegation(opened.db,clock,owner,org,grantA,'revoke');
  expect((await request(app).post(path).set(headers(partnerToken,org,grantA)).set('Idempotency-Key','delegated-replay').send(body)).status).toBe(404);
});
