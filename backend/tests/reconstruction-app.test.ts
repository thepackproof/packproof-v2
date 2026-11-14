import {beforeAll,afterAll,describe,it,expect,vi} from 'vitest';
import {randomBytes} from 'node:crypto';
import {mkdtemp,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import request from './in-process-http.js';
import {openIsolatedTestDatabase} from './isolated-test-database.js';
import {migrate} from '../src/db/migrate.js';
import {insertUser} from '../src/domain/users.js';
import {BearerUserAdapter} from '../src/auth/adapter.js';
import {createServerApp} from '../src/server-app.js';
import {DisabledEmailDelivery} from '../src/integrations/email/delivery.js';
import {LocalObjectStore} from '../src/s3/local-object-store.js';
import type {AppDependencies} from '../src/app.js';
import {createOrganization,setOrganizationEntitlement,createServicePrincipal,issuePartnerCredential,createIntegrationAccount,PARTNER_SCOPES} from '../src/platform/organizations.js';
import {processPendingTypedImports} from '../src/records/typed-imports.js';
import {sha256Hex} from '../src/hash.js';
import type {TypedSourceReference} from '../src/records/source-contracts.js';

describe('operational reconstruction through the assembled application',()=>{
 let opened:Awaited<ReturnType<typeof openIsolatedTestDatabase>>,deps:AppDependencies,app:ReturnType<typeof createServerApp>,dir:string;
 let owner:string,outsider:string,org:string,member:string,principal:string,credential:string,account:string,caseId:string,firstAssertion:string;
 const clock={now:()=>new Date('2026-11-14T12:00:00Z')},site='app-operational-site',ns='source-owner-approved-namespace';
 const scope=()=>({organizationId:org,environment:'sandbox'}),human=()=>({Authorization:`Bearer ${owner}`}),service=()=>({Authorization:`Bearer ${credential}`,'PackProof-Merchant-Id':org});
 const ref=(type:TypedSourceReference['type'],externalId:string,order='0010482'):TypedSourceReference=>({namespace:ns,type,externalId,...(type==='order_line'?{parentExternalId:order}:{})});
 const observation=(id:string,property:string,amount:string,order='0010482',shipment:string|null=null)=>{
  const line=ref('order_line','004',order),o=ref('order',order),s=shipment?ref('shipment',shipment):null;
  return {sourceEventId:id,sourceRevision:'1',observationKind:'snapshot',occurredAt:null,sourceAsOf:clock.now().toISOString(),timeQuality:'snapshot_time_only',references:[o,line,...(s?[s]:[])],assertions:[{subjectReference:line,property,value:{amount,unit:'each'}}],relationships:[{from:o,to:line,type:'has_line',quantity:null},...(s?[{from:s,to:line,type:'fulfills',quantity:{amount,unit:'each'}}]:[])],supersedes:null,originSystem:'Synthetic authorized feed',copiedFromSource:null};
 };
 async function source(profile:string,name:string){
  const body={...scope(),connectionId:account,principalId:principal,installationId:null,operatorMembershipId:member,locationId:site,config:{transport:'partner_api',displayName:name,sourceProfile:profile,mappingVersion:'qualified-fixture/1',sourceNamespace:ns,mapping:{},constants:{},wholeFileConsent:true,folderDigest:null,initialFileName:null,initialOriginalSha256:null,expectedHeaders:[],historyFrom:'2026-11-01T00:00:00Z',historyTo:null,maxBytes:2097152,maxRows:1000,offlineWindowHours:24,expectedIntervalSeconds:60,completenessPolicy:{kind:'snapshot',scope:'shipment_line',sourceOwnerQualified:true,qualificationReference:'Synthetic test contract. Not an actual pilot qualification.'}}};
  const proposed=await request(app).post('/me/records/source-subscriptions').query(scope()).set(human()).set('Idempotency-Key',`propose-${name}`).send(body);expect(proposed.status,proposed.text).toBe(200);
  const approved=await request(app).post(`/me/records/source-subscriptions/${proposed.body.id}/actions`).query(scope()).set(human()).set('Idempotency-Key',`approve-${name}`).send({...scope(),action:'approve',configurationRevision:1,configurationSha256:proposed.body.configurationSha256,wholeFileConsent:true});expect(approved.status,approved.text).toBe(200);return approved.body;
 }
 async function ingest(profile:string,name:string,rows:unknown[]){
  const subscription=await source(profile,name),content=JSON.stringify(rows);
  const input={schema:'packproof.typed-source-batch/v1',connectionId:account,locationId:site,sourceProfile:profile,mappingVersion:'qualified-fixture/1',sourceNamespace:ns,subscriptionId:subscription.id,configurationRevision:1,grantRevision:subscription.grantRevision,wholeFileConsent:true,original:{name:`${name}.json`,mediaType:'application/json',content,sha256:sha256Hex(content)},mapping:{},constants:{},completeness:{kind:'snapshot',asOf:clock.now().toISOString(),marker:`qualified-synthetic-${name}`}};
  const preview=await request(app).post('/v1/partner/typed-imports/preview').set(service()).set('Idempotency-Key',`preview-${name}`).send(input);expect(preview.status,preview.text).toBe(201);
  const commit=await request(app).post(`/v1/partner/typed-imports/${preview.body.id}/commit`).set(service()).set('Idempotency-Key',`commit-${name}`).send({previewVersion:preview.body.previewVersion,originalSha256:preview.body.original.sha256,importValidRows:false});expect(commit.status,commit.text).toBe(202);
  await processPendingTypedImports(deps,10);
  const receipt=await request(app).get(`/v1/partner/typed-imports/${preview.body.id}`).set(service());expect(receipt.status,receipt.text).toBe(200);expect(receipt.body.state).toBe('succeeded');
  const activated=await request(app).post(`/me/records/source-subscriptions/${subscription.id}/actions`).query(scope()).set(human()).set('Idempotency-Key',`activate-${name}`).send({...scope(),action:'activate',configurationRevision:1,recurringConsent:true,initialBatchId:receipt.body.id});expect(activated.status,activated.text).toBe(200);
  const check=await request(app).post(`/v1/partner/source-subscriptions/${subscription.id}/heartbeat`).set(service()).set('Idempotency-Key',`check-${name}`).send({configurationRevision:1,grantRevision:activated.body.grantRevision,state:'checked',sourceAsOf:clock.now().toISOString(),checkpoint:`${name}-1`,errorCode:null,backlog:0,oldestPendingAt:null});expect(check.status,check.text).toBe(200);
  return {receipt:receipt.body,subscription:activated.body};
 }
 beforeAll(async()=>{
  for(const key of ['PACKPROOF_ORGANIZATIONS_ENABLED','PACKPROOF_TYPED_INTAKE_ENABLED','PACKPROOF_SOURCE_SUBSCRIPTIONS_ENABLED','PACKPROOF_MULTI_SOURCE_AGENT_ENABLED','PACKPROOF_CASE_RECONSTRUCTION_ENABLED','PACKPROOF_SOURCE_HEALTH_ENABLED','PACKPROOF_RECONSTRUCTION_RULES_ENABLED','PACKPROOF_RECONSTRUCTION_EXPORTS_ENABLED'])vi.stubEnv(key,'true');
  vi.stubEnv('PACKPROOF_EVENT_CURSOR_KEY',randomBytes(32).toString('base64'));
  opened=await openIsolatedTestDatabase();await migrate(opened.db);dir=await mkdtemp(path.join(os.tmpdir(),'reconstruction-app-'));
  const admin=await insertUser(opened.db,clock);owner=await insertUser(opened.db,clock);outsider=await insertUser(opened.db,clock);
  await opened.db.query("INSERT INTO user_verified_contacts(user_id,email_normalized,verified_at,source) VALUES($1,'nericollin@gmail.com',$2,'COGNITO')",[admin,clock.now().toISOString()]);
  org=(await createOrganization(opened.db,clock,admin,{kind:'MERCHANT',name:'Synthetic operational routes',ownerUserId:owner},'setup')).id;await setOrganizationEntitlement(opened.db,clock,admin,org,{enabled:true},'setup');
  member=(await opened.db.query<{id:string}>('SELECT id FROM platform_memberships WHERE organization_id=$1 AND user_id=$2',[org,owner])).rows[0].id;
  principal=(await createServicePrincipal(opened.db,clock,owner,org,{name:'Synthetic three-feed observer'},'setup')).id;
  credential=(await issuePartnerCredential(opened.db,clock,owner,org,principal,{scopes:[...PARTNER_SCOPES],expiresAt:'2026-11-15T12:00:00Z'},'setup')).token;
  account=(await createIntegrationAccount(opened.db,clock,owner,org,{provider:'synthetic-existing-exports',externalAccountId:'qualified-three-feeds'},'setup')).id;
  await opened.db.query('INSERT INTO record_locations(id,organization_id,name,created_at) VALUES($1,$2,$3,$4)',[site,org,'Synthetic site',clock.now().toISOString()]);
  deps={db:opened.db,clock,objectStore:new LocalObjectStore(path.join(dir,'objects'),'http://localhost','synthetic-source-secret'),auth:new BearerUserAdapter(opened.db),devAuth:true,testFixtures:true,publicBaseUrl:'https://api.example.test',corsOrigins:['https://portal.example.test'],webhookConfig:{encryptionKey:randomBytes(32).toString('base64'),allowedHosts:['example.test']}};
  app=createServerApp({...deps,emailDelivery:new DisabledEmailDelivery()});
 },60000);
 afterAll(async()=>{await opened?.close();if(dir)await rm(dir,{recursive:true,force:true});vi.unstubAllEnvs();});
 it('keeps all new capabilities disabled until explicitly activated',async()=>{
  vi.stubEnv('PACKPROOF_CASE_RECONSTRUCTION_ENABLED','false');
  const context=await request(app).get('/me/records/context').set(human());expect(context.status).toBe(200);expect(context.body.capabilities.reconstruction).toBe(false);
  const read=await request(app).get('/me/records/cases').query(scope()).set(human());expect(read.status).toBe(503);expect(read.body.error.code).toBe('RECONSTRUCTION_CAPABILITY_DISABLED');
  vi.stubEnv('PACKPROOF_CASE_RECONSTRUCTION_ENABLED','true');
 });
 it('reconstructs three existing feeds and an exact source-linked two-unit discrepancy',async()=>{
  const orders=await ingest('packproof.order-lines/v1','orders',[observation('order-10482','orderedQuantity','10'),observation('private-order','orderedQuantity','999','SECRET-OTHER-CUSTOMER')]);caseId=orders.receipt.caseIds.find((id:string)=>id)!;
  const primary=(await request(app).get('/me/records/cases').query({...scope(),q:'0010482'}).set(human())).body;expect(primary.total).toBe(1);caseId=primary.cases[0].id;
  await ingest('packproof.shipment-handling-units/v1','allocations',[observation('allocation-S21','allocatedQuantity','10','0010482','S-0021')]);
  await ingest('packproof.operational-observations/v1','loading-delivery',[observation('loading-S21','reportedLoadedQuantity','8','0010482','S-0021'),observation('received-S21','reportedReceivedQuantity','8','0010482','S-0021')]);
  const detail=await request(app).get(`/me/records/cases/${caseId}`).query(scope()).set(human());expect(detail.status,detail.text).toBe(200);expect(detail.body.case.reference).toBe('0010482');expect(detail.body.case.shipmentCount).toBe(1);
  expect(detail.body.comparisons.some((c:{outcome:string;absoluteDifference:{numerator:string;denominator:string}})=>c.outcome==='different'&&c.absoluteDifference.numerator==='2'&&c.absoluteDifference.denominator==='1')).toBe(true);
  expect(detail.body.assertions.every((a:{source:{row:number;field:string;receiptId:string}})=>a.source.row>0&&a.source.field&&a.source.receiptId)).toBe(true);firstAssertion=detail.body.assertions[0].id;
  expect(detail.body.timeline.every((e:{reportedAt:unknown;timeBasis:string})=>e.reportedAt===null&&e.timeBasis==='snapshot_as_of')).toBe(true);
 });
 it('returns only the authorized field extract from a multi-case original',async()=>{
  const source=await request(app).get(`/me/records/cases/${caseId}/assertions/${firstAssertion}/source`).query(scope()).set(human());expect(source.status,source.text).toBe(200);expect(source.body.extraction).toBe('case_scoped');expect(source.body.originalAvailable).toBe(true);expect(JSON.stringify(source.body)).not.toContain('SECRET-OTHER-CUSTOMER');expect(source.body).not.toHaveProperty('originalObjectKey');
  const outsiderRead=await request(app).get(`/me/records/cases/${caseId}/assertions/${firstAssertion}/source`).query(scope()).set('Authorization',`Bearer ${outsider}`);expect(outsiderRead.status).toBe(404);
 });
 it('exports an immutable explicitly scoped investigation profile with omissions and reproducible input values',async()=>{
  const reads=vi.spyOn(deps.objectStore,'get');
  const result=await request(app).get(`/me/records/cases/${caseId}/export`).query(scope()).set(human());expect(result.status,result.text).toBe(200);expect(result.headers['x-content-sha256']).toBe(sha256Hex(result.text));expect(result.headers['content-disposition']).toContain('attachment');
  expect(reads).toHaveBeenCalledTimes(3);reads.mockRestore();
  const data=JSON.parse(result.text);expect(data.schema).toBe('packproof.reconstruction-investigation/v1');expect(data.integrity.signed).toBe(false);expect(data.associationDecisions.length).toBeGreaterThan(0);expect(data.associationDecisions.every((d:{createdAt:unknown})=>typeof d.createdAt==='string'&&Number.isFinite(Date.parse(d.createdAt)))).toBe(true);expect(data.extracts.length).toBe(4);expect(data.omissions.some((o:{kind:string})=>o.kind==='shared_originals')).toBe(true);expect(result.text).not.toContain('SECRET-OTHER-CUSTOMER');expect(result.text).not.toContain('original_object_key');
  await expect(opened.db.query("UPDATE record_reconstruction_exports SET payload_canonical='changed' WHERE payload_sha256=$1",[result.headers['x-content-sha256']])).rejects.toThrow(/immutable/i);
 });
 it('advertises signing only when the actual bound runtime is qualified',async()=>{
  vi.stubEnv('PACKPROOF_SIGNED_CASE_EXPORTS_ENABLED','true');
  const capability=await request(app).get(`/me/records/cases/${caseId}/export-capabilities`).query(scope()).set(human());expect(capability.status).toBe(200);expect(capability.body.signed).toMatchObject({available:false,qualification:null});expect(capability.body.unsigned.available).toBe(true);
  const signed=await request(app).get(`/me/records/cases/${caseId}/export`).query({...scope(),profile:'packproof.reconstruction-investigation/v2'}).set(human());expect(signed.status).toBe(503);expect(signed.body.error.code).toBe('RECONSTRUCTION_SIGNING_UNAVAILABLE');
  const bad=await request(app).get(`/me/records/cases/${caseId}/export`).query({...scope(),profile:'made-up'}).set(human());expect(bad.status).toBe(400);
  const privateRead=await request(app).get(`/me/records/cases/${caseId}/export-capabilities`).query(scope()).set('Authorization',`Bearer ${outsider}`);expect(privateRead.status).toBe(404);
  vi.stubEnv('PACKPROOF_SIGNED_CASE_EXPORTS_ENABLED','false');
 });
 it('does not reveal case search results or counts outside current membership',async()=>{
  const read=await request(app).get('/me/records/cases').query({...scope(),q:'0010482'}).set('Authorization',`Bearer ${outsider}`);expect(read.status).toBe(404);
  const detail=await request(app).get(`/me/records/cases/${caseId}`).query(scope()).set('Authorization',`Bearer ${outsider}`);expect(detail.status).toBe(404);
 });
});
