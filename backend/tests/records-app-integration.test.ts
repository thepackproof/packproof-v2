import { beforeAll, afterAll, describe, it, expect, vi } from 'vitest';
import { randomBytes } from 'node:crypto';
import request from './in-process-http.js';
import { openIsolatedTestDatabase } from './isolated-test-database.js';
import { migrate } from '../src/db/migrate.js';
import { insertUser } from '../src/domain/users.js';
import { BearerUserAdapter } from '../src/auth/adapter.js';
import { createServerApp } from '../src/server-app.js';
import type { AppDependencies } from '../src/app.js';
import { DisabledEmailDelivery } from '../src/integrations/email/delivery.js';
import { MemoryObjectStore } from './memory-object-store.js';
import { createOrganization, setOrganizationEntitlement, createServicePrincipal, issuePartnerCredential, createIntegrationAccount, PARTNER_SCOPES } from '../src/platform/organizations.js';
import { processPendingRecordImports } from '../src/records/imports.js';

/** Exercise production-facing adapters together: fixed routes, JSON parsing,
 * human auth, canonical ingestion and additive service-credential routes. */
describe('records through the assembled server application',()=>{
 let opened:Awaited<ReturnType<typeof openIsolatedTestDatabase>>,deps:AppDependencies,app:ReturnType<typeof createServerApp>;
 let admin:string,owner:string,outsider:string,org:string,member:string,credential:string,account:string,importedId:string;
 const clock={now:()=>new Date()};
 const scope=()=>({organizationId:org,environment:'sandbox'});
 const authorization=()=>({Authorization:`Bearer ${owner}`});
 const csvBody=(csv:string)=>({...scope(),csv,timeZone:'America/New_York',sourceName:'Assembled warehouse export'});
 beforeAll(async()=>{
  vi.stubEnv('PACKPROOF_ORGANIZATIONS_ENABLED','true');
  vi.stubEnv('PACKPROOF_EVENT_CURSOR_KEY',randomBytes(32).toString('base64'));
  opened=await openIsolatedTestDatabase();await migrate(opened.db);
  [admin,owner,outsider]=await Promise.all(Array.from({length:3},()=>insertUser(opened.db,clock)));
  await opened.db.query("INSERT INTO user_verified_contacts(user_id,email_normalized,verified_at,source) VALUES($1,'nericollin@gmail.com',$2,'COGNITO')",[admin,clock.now().toISOString()]);
  org=(await createOrganization(opened.db,clock,admin,{kind:'MERCHANT',name:'Assembled route fixture',ownerUserId:owner},'setup')).id;
  await setOrganizationEntitlement(opened.db,clock,admin,org,{enabled:true},'setup');
  member=(await opened.db.query<{id:string}>('SELECT id FROM platform_memberships WHERE organization_id=$1 AND user_id=$2',[org,owner])).rows[0].id;
  const principal=await createServicePrincipal(opened.db,clock,owner,org,{name:'Assembled API client'},'setup');
  credential=(await issuePartnerCredential(opened.db,clock,owner,org,principal.id,{scopes:[...PARTNER_SCOPES],expiresAt:new Date(Date.now()+86400000).toISOString()},'setup')).token;
  account=(await createIntegrationAccount(opened.db,clock,owner,org,{provider:'assembled-fixture',externalAccountId:'synthetic-source'},'setup')).id;
  deps={db:opened.db,clock,objectStore:new MemoryObjectStore(),auth:new BearerUserAdapter(opened.db),devAuth:true,testFixtures:true,publicBaseUrl:'https://api.example.test',corsOrigins:['https://portal.example.test'],webhookConfig:{encryptionKey:randomBytes(32).toString('base64'),allowedHosts:['example.test']}};
  app=createServerApp({...deps,emailDelivery:new DisabledEmailDelivery()});
 },60000);
 afterAll(async()=>{await opened?.close();vi.unstubAllEnvs();});

 it('mounts fixed resources ahead of record IDs and retains human authentication',async()=>{
  for(const path of ['/me/records/context','/me/records/workspace-requests','/me/records/imports/template.csv','/me/records/connections']){
   const unauthenticated=await request(app).get(path);expect(unauthenticated.status,`${path}: ${unauthenticated.text}`).toBe(401);
  }
  const context=await request(app).get('/me/records/context').set(authorization());expect(context.status,context.text).toBe(200);expect(context.body.selectedOrganizationId).toBe(org);
  const registration=await request(app).get('/me/records/workspace-requests').set(authorization());expect(registration.status,registration.text).toBe(200);expect(registration.body.requests).toEqual([]);
  const template=await request(app).get('/me/records/imports/template.csv').set(authorization());expect(template.status,template.text).toBe(200);expect(template.text).toContain('Shipment reference');
  const connections=await request(app).get('/me/records/connections').query(scope()).set(authorization());expect(connections.status,connections.text).toBe(200);expect(connections.body.connections.some((value:{id:string})=>value.id===account)).toBe(true);
  const action=await request(app).post('/me/records/connections/missing/actions').set(authorization()).set('Idempotency-Key','missing-connection').send({...scope(),action:'test'});expect(action.status,action.text).toBe(404);expect(action.body.error.code).toBe('CONNECTION_NOT_FOUND');
  const unknown=await request(app).get('/me/records/not-a-real-record/deeper-resource').query(scope()).set(authorization());expect(unknown.status).toBe(404);
 });

 it('creates a durable import then opens its canonical record through the actual mounted routes',async()=>{
  const preview=await request(app).post('/me/records/imports/preview').set(authorization()).send(csvBody('Shipment reference,Description,Tracking number\r\nMOUNT-0001,Assembled workflow parcel,0000456\r\n'));
  expect(preview.status,preview.text).toBe(201);expect(preview.body.state).toBe('previewed');
  const commit=await request(app).post(`/me/records/imports/${preview.body.id}/commit`).set(authorization()).send({previewVersion:preview.body.previewVersion,importValidRows:false});
  expect(commit.status,commit.text).toBe(202);expect(commit.headers.location).toBe(`/me/records/imports/${preview.body.id}`);
  expect(await processPendingRecordImports(deps)).toEqual({processed:1,failed:0});
  const receipt=await request(app).get(String(commit.headers.location)).set(authorization());expect(receipt.status,receipt.text).toBe(200);expect(receipt.body.state).toBe('succeeded');importedId=receipt.body.recordIds[0];
  const collection=await request(app).get('/me/records').query({...scope(),q:'MOUNT-0001'}).set(authorization());expect(collection.status,collection.text).toBe(200);expect(collection.body.records.map((value:{id:string})=>value.id)).toContain(importedId);
  const detail=await request(app).get(`/me/records/${importedId}`).query(scope()).set(authorization());expect(detail.status,detail.text).toBe(200);expect(detail.body.record.reference).toBe('MOUNT-0001');expect(detail.body.record.trackingNumber).toBe('0000456');expect(detail.headers.etag).toBe('"1"');
  const timeline=await request(app).get(`/me/records/${importedId}/timeline`).query(scope()).set(authorization());expect(timeline.status,timeline.text).toBe(200);expect(JSON.stringify(timeline.body)).toContain('CSV_SHIPMENT_IMPORTED');
  const packageUnavailable=await request(app).get(`/me/records/${importedId}/package`).query(scope()).set(authorization());expect(packageUnavailable.status,packageUnavailable.text).toBe(409);expect(packageUnavailable.body.error.code).toBe('SNAPSHOT_NOT_AVAILABLE');
  const unknownEvidence=await request(app).get(`/me/records/${importedId}/evidence/missing/blob`).query(scope()).set(authorization());expect(unknownEvidence.status,unknownEvidence.text).toBe(404);
  const privateMedia=await request(app).get(`/me/records/${importedId}/package`).query(scope()).set('Authorization',`Bearer ${outsider}`);expect(privateMedia.status).toBe(404);
  expect((await opened.db.query('SELECT proof_id FROM platform_proof_ownership WHERE proof_id=$1',[importedId])).rows).toHaveLength(1);
 });

 it('applies the import-specific JSON envelope without relaxing the 2 MiB CSV source limit',async()=>{
  // Quoted CSV cells make JSON transport larger than the 2 MiB general API
  // envelope while the original CSV remains below its independent 2 MiB cap.
  const escapedCell='"'.repeat(6000).replace(/"/g,'""');
  const csv='Reference,Notes\n'+Array.from({length:100},(_,index)=>`ENVELOPE-${index},"${escapedCell}"`).join('\n');
  const body=csvBody(csv);expect(Buffer.byteLength(JSON.stringify(body))).toBeGreaterThan(2*1024*1024);expect(Buffer.byteLength(csv)).toBeLessThan(2*1024*1024);
  const accepted=await request(app).post('/me/records/imports/preview').set(authorization()).send(body);expect(accepted.status,accepted.text.slice(0,1000)).toBe(201);expect(accepted.body.counts.valid).toBe(100);
  const oversized=await request(app).post('/me/records/imports/preview').set(authorization()).send(csvBody(`Reference,Notes\nTOO-LARGE,${'A'.repeat(2*1024*1024)}`));
  expect(oversized.status).toBe(413);expect(oversized.body.code).toBe('CSV_TOO_LARGE');
 });

 it('retains the existing partner create route and adds record reads within the same credential boundary',async()=>{
  const serviceHeaders={Authorization:`Bearer ${credential}`,'PackProof-Merchant-Id':org};
  const created=await request(app).post('/v1/partner/proofs').set(serviceHeaders).set('Idempotency-Key','assembled-partner-create').send({integrationAccountId:account,externalId:'SERVICE-MOUNT-1',operatorMembershipId:member,transaction:{itemTitle:'Partner assembled fixture',quantity:1}});
  expect(created.status,created.text).toBe(201);const id=created.body.proofId;
  const oldRead=await request(app).get(`/v1/partner/proofs/${id}`).set(serviceHeaders);expect(oldRead.status,oldRead.text).toBe(200);expect(oldRead.body.proof.proofId).toBe(id);
  const additive=await request(app).get(`/v1/partner/proofs/${id}/record`).set(serviceHeaders);expect(additive.status,additive.text).toBe(200);expect(additive.body.record.id).toBe(id);
  const timeline=await request(app).get(`/v1/partner/proofs/${id}/timeline`).set(serviceHeaders);expect(timeline.status,timeline.text).toBe(200);
  const unsupported=await request(app).post(`/v1/partner/proofs/${id}/attestations`).set(serviceHeaders).set('Idempotency-Key','must-not-elevate').send({statement:'PACKED_DESCRIBED_ITEM'});expect(unsupported.status).toBe(404);expect(unsupported.body.code).toBe('PARTNER_OPERATION_UNSUPPORTED');
  const humanSurface=await request(app).get('/me/records/context').set(serviceHeaders);expect(humanSurface.status).toBe(401);
 });
});
