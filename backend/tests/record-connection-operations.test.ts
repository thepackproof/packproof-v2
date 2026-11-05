import {afterAll,afterEach,beforeAll,beforeEach,describe,expect,it,vi} from 'vitest';
import express from 'express';
import request from './in-process-http.js';
import {createPgliteDatabase} from '../src/db/pglite.js';
import {migrate} from '../src/db/migrate.js';
import {insertUser} from '../src/domain/users.js';
import {DomainError} from '../src/domain/errors.js';
import {newId} from '../src/ids.js';
import {requireRecordWorkspace,type RecordWorkspace} from '../src/records/access.js';
import {actOnRecordConnection,listRecordConnections,readRecordConnectionOperation,processRecordConnectionOperations,type ConnectionCheckResult} from '../src/records/connections.js';
import {createRecordConnectionsRouter} from '../src/records/connections-router.js';
import {createWorkspaceRequestsRouter,requestWorkspace} from '../src/records/workspace-requests.js';
import {BearerUserAdapter} from '../src/auth/adapter.js';
import type {AppDependencies} from '../src/app.js';

describe('durable source operations and pending workspace registration',()=>{
 let opened:Awaited<ReturnType<typeof createPgliteDatabase>>;
 let now:number;
 const clock={now:()=>new Date(now)};
 const body={businessName:'Synthetic warehouse',region:'US',timeZone:'America/New_York',locationName:'Fixture location',environment:'sandbox'};
 const health=():ConnectionCheckResult=>({lastSuccessfulSyncAt:clock.now().toISOString(),watermarkCheckedAt:clock.now().toISOString(),expectedIntervalSeconds:60});
 beforeAll(async()=>{
  vi.stubEnv('PACKPROOF_ORGANIZATIONS_ENABLED','true');
  vi.stubEnv('PACKPROOF_WORKSPACE_SELF_SERVICE_ENABLED','true');
  opened=await createPgliteDatabase();await migrate(opened.db);
 },60000);
 beforeEach(()=>{now=Date.parse('2026-11-04T12:00:00.000Z');});
 afterEach(async()=>{await opened.db.query("UPDATE record_connection_operations SET state='cancelled',lease_token=NULL,lease_expires_at=NULL WHERE state IN ('queued','running')");});
 afterAll(async()=>{await opened?.close();vi.unstubAllEnvs();});

 async function fixture(role:RecordWorkspace['role']='OWNER',locationScoped=false){
  const userId=await insertUser(opened.db,clock),organizationId=newId('org'),tenantId=newId('ten'),membershipId=newId('member'),connectionId=newId('account');
  const at=clock.now().toISOString();
  await opened.db.query('INSERT INTO api_tenants(id,owner_user_id,name,environment,created_at) VALUES($1,$2,$3,\'sandbox\',$4)',[tenantId,userId,organizationId,at]);
  await opened.db.query("INSERT INTO platform_organizations(id,kind,name,owner_user_id,environment,tenant_id,enabled,created_at) VALUES($1,'MERCHANT','Fixture',$2,'sandbox',$3,true,$4)",[organizationId,userId,tenantId,at]);
  await opened.db.query('INSERT INTO platform_memberships(id,organization_id,user_id,role,location_scoped,created_at) VALUES($1,$2,$3,$4,$5,$6)',[membershipId,organizationId,userId,role,locationScoped,at]);
  await opened.db.query("INSERT INTO platform_integration_accounts(id,merchant_id,environment,provider,external_account_id,created_at) VALUES($1,$2,'sandbox','erp-fixture',$3,$4)",[connectionId,organizationId,connectionId,at]);
  const workspace=await requireRecordWorkspace(opened.db,userId,organizationId,'sandbox');
  return {userId,organizationId,tenantId,membershipId,connectionId,workspace};
 }
 async function queue(f:Awaited<ReturnType<typeof fixture>>,key='check'){
  return await actOnRecordConnection(opened.db,clock,f.workspace,f.connectionId,{action:'test'},key) as {operationId:string};
 }
 async function state(id:string){return (await opened.db.query<Record<string,unknown>>('SELECT * FROM record_connection_state WHERE connection_id=$1',[id])).rows[0];}
 async function verifyUser(userId:string,at=clock.now().toISOString()){
  await opened.db.query("INSERT INTO user_verified_contacts(user_id,email_normalized,verified_at,source) VALUES($1,$2,$3,'COGNITO')",[userId,`${userId}@fixture.invalid`,at]);
 }
 function appFor(deps:Partial<AppDependencies>){
  const app=express(),all={db:opened.db,clock,auth:new BearerUserAdapter(opened.db),devAuth:true,testFixtures:true,...deps} as AppDependencies;
  app.use(express.json());app.use('/connections',createRecordConnectionsRouter(all));app.use('/workspaces',createWorkspaceRequestsRouter(all));
  app.use((e:unknown,_r:express.Request,s:express.Response,_n:express.NextFunction)=>{s.status(e instanceof DomainError?e.httpStatus:500).json({code:e instanceof DomainError?e.code:String(e)});});
  return app;
 }

 it('reauthorizes connection IDs and cached commands against the current tenant and environment',async()=>{
  const a=await fixture(),b=await fixture(),job=await queue(a);
  await expect(readRecordConnectionOperation(opened.db,b.workspace,a.connectionId,job.operationId)).rejects.toMatchObject({code:'CONNECTION_NOT_FOUND',httpStatus:404});
  await expect(actOnRecordConnection(opened.db,clock,b.workspace,a.connectionId,{action:'pause'},'cross')).rejects.toMatchObject({code:'CONNECTION_NOT_FOUND'});
  await expect(actOnRecordConnection(opened.db,clock,{...a.workspace,environment:'live'},a.connectionId,{action:'test'},'check')).rejects.toMatchObject({code:'ORGANIZATION_NOT_FOUND'});
  await opened.db.query('UPDATE platform_memberships SET revoked_at=$2 WHERE id=$1',[a.membershipId,clock.now().toISOString()]);
  await expect(queue(a)).rejects.toMatchObject({code:'ORGANIZATION_NOT_FOUND'});
 });

 it('does not grant operators, reviewers or location-scoped administrators organization-wide source control',async()=>{
  for(const role of ['OPERATOR','REVIEWER'] as const){const f=await fixture(role);await expect(queue(f)).rejects.toMatchObject({httpStatus:403});}
  const scoped=await fixture('ADMIN',true);
  await expect(queue(scoped)).rejects.toMatchObject({code:'CONNECTION_SCOPE_UNAVAILABLE'});
  await expect(listRecordConnections(opened.db,clock,scoped.workspace)).rejects.toMatchObject({code:'CONNECTION_SCOPE_UNAVAILABLE'});
  const service=await fixture();
  await opened.db.query('INSERT INTO platform_principals(id,organization_id,actor_user_id,name,created_at) VALUES($1,$2,$3,\'Fixture adapter\',$4)',[newId('principal'),service.organizationId,service.userId,clock.now().toISOString()]);
  await expect(queue(service)).rejects.toMatchObject({code:'HUMAN_AUTHENTICATION_REQUIRED'});
 });

 it('replays one durable operation, rejects changed content and scopes the same key to each source',async()=>{
  const f=await fixture(),first=await queue(f,'stable-key');
  expect(await queue(f,'stable-key')).toEqual(first);
  await expect(actOnRecordConnection(opened.db,clock,f.workspace,f.connectionId,{action:'reconcile'},'stable-key')).rejects.toMatchObject({code:'IDEMPOTENCY_CONFLICT'});
  const otherId=newId('account');
  await opened.db.query("INSERT INTO platform_integration_accounts(id,merchant_id,environment,provider,external_account_id,created_at) VALUES($1,$2,'sandbox','erp-fixture',$1,$3)",[otherId,f.organizationId,clock.now().toISOString()]);
  const other=await actOnRecordConnection(opened.db,clock,f.workspace,otherId,{action:'test'},'stable-key') as {operationId:string};
  expect(other.operationId).not.toBe(first.operationId);
  expect((await opened.db.query('SELECT id FROM record_connection_operations WHERE organization_id=$1',[f.organizationId])).rows).toHaveLength(2);
 });

 it('turns a queued source without an adapter into an actionable terminal result',async()=>{
  const f=await fixture(),job=await queue(f);
  expect(await processRecordConnectionOperations(opened.db,clock,new Map(),1)).toEqual({processed:1});
  expect(await readRecordConnectionOperation(opened.db,f.workspace,f.connectionId,job.operationId)).toMatchObject({state:'failed',attempts:1,errorCode:'CONNECTION_ADAPTER_NOT_CONFIGURED',nextAction:expect.stringContaining('Request help')});
  expect(await state(f.connectionId)).toMatchObject({last_success_at:null,last_error_code:'CONNECTION_ADAPTER_NOT_CONFIGURED'});
  expect((await listRecordConnections(opened.db,clock,f.workspace)).connections[0].state).toBe('action_needed');
 });

 it('counts current source problems across the authorized scope even beyond the bounded list',async()=>{
  const f=await fixture(),other=await fixture(),at=clock.now().toISOString(),past=new Date(now-120000).toISOString(),future=new Date(now+1000).toISOString();
  const source=async(provider:string,settings:{paused?:boolean;error?:string;success?:string;watermark?:string}={})=>{
   const id=newId('account');
   await opened.db.query('INSERT INTO platform_integration_accounts(id,merchant_id,environment,provider,external_account_id,created_at) VALUES($1,$2,\'sandbox\',$3,$1,$4)',[id,f.organizationId,provider,new Date(now-1000).toISOString()]);
   await opened.db.query('INSERT INTO record_connection_state(connection_id,organization_id,environment,paused,last_error_code,last_success_at,watermark_checked_at,expected_interval_seconds,updated_at) VALUES($1,$2,\'sandbox\',$3,$4,$5,$6,60,$7)',[id,f.organizationId,settings.paused??false,settings.error??null,settings.success??null,settings.watermark??null,at]);
  };
  await source('erp-fixture',{error:'PERMISSION_DENIED'});await source('erp-fixture',{success:past,watermark:past});
  await source('erp-fixture',{success:at,watermark:at});await source('csv',{error:'NOT_A_CONTINUOUS_SOURCE'});
  await source('erp-fixture',{paused:true,error:'PERMISSION_DENIED'});await source('erp-fixture',{success:future,watermark:at});
  await queue(other);await processRecordConnectionOperations(opened.db,clock,new Map(),1);
  const complete=await listRecordConnections(opened.db,clock,f.workspace);
  expect(complete).toMatchObject({total:7,currentNeedsAction:2,returnedCount:7,hasMore:false,limit:100,measuredAt:at});
  expect(complete.connections.filter(c=>['action_needed','delayed'].includes(c.state))).toHaveLength(2);
  await opened.db.query("INSERT INTO platform_integration_accounts(id,merchant_id,environment,provider,external_account_id,created_at) SELECT $1||'-page-'||n::text,$1,'sandbox','erp-fixture',$1||'-page-'||n::text,$2 FROM generate_series(1,101) n",[f.organizationId,at]);
  const bounded=await listRecordConnections(opened.db,clock,f.workspace);
  expect(bounded).toMatchObject({total:108,currentNeedsAction:2,returnedCount:100,hasMore:true,limit:100});
  expect(bounded.connections.filter(c=>['action_needed','delayed'].includes(c.state))).toHaveLength(0);
 });

 it('publishes freshness only after valid source and watermark measurements',async()=>{
  const f=await fixture();await queue(f);
  await processRecordConnectionOperations(opened.db,clock,new Map([['erp-fixture',async()=>health()]]),1);
  expect((await listRecordConnections(opened.db,clock,f.workspace)).connections[0].state).toBe('up_to_date');
  const invalid=await fixture();await queue(invalid);
  await processRecordConnectionOperations(opened.db,clock,new Map([['erp-fixture',async()=>({...health(),watermarkCheckedAt:new Date(now+1000).toISOString()})]]),1);
  expect(await state(invalid.connectionId)).toMatchObject({last_success_at:null,last_error_code:'INVALID_SOURCE_HEALTH'});
 });

 it('does not run queued work after pause or reuse an old check after pause and resume',async()=>{
  const f=await fixture(),job=await queue(f),checker=vi.fn(async()=>health());
  await actOnRecordConnection(opened.db,clock,f.workspace,f.connectionId,{action:'pause'},'pause');
  await actOnRecordConnection(opened.db,clock,f.workspace,f.connectionId,{action:'resume'},'resume');
  await processRecordConnectionOperations(opened.db,clock,new Map([['erp-fixture',checker]]),1);
  expect(checker).not.toHaveBeenCalled();
  expect(await readRecordConnectionOperation(opened.db,f.workspace,f.connectionId,job.operationId)).toMatchObject({state:'failed',errorCode:'CONNECTION_CHANGED'});
  expect(await state(f.connectionId)).toMatchObject({last_success_at:null});
 });

 it('discards a completed external check when organization access was disabled during the request',async()=>{
  const f=await fixture('ADMIN'),job=await queue(f);
  await processRecordConnectionOperations(opened.db,clock,new Map([['erp-fixture',async()=>{await opened.db.query('UPDATE platform_organizations SET enabled=false WHERE id=$1',[f.organizationId]);return health();}]]),1);
  expect((await opened.db.query('SELECT state,error_code FROM record_connection_operations WHERE id=$1',[job.operationId])).rows[0]).toMatchObject({state:'failed',error_code:'ORGANIZATION_ACCESS_REVOKED'});
  expect(await state(f.connectionId)).toMatchObject({last_success_at:null});
 });

 it('does not start a second external source check while the same connection has an active lease',async()=>{
  const f=await fixture();await queue(f,'first');const second=await queue(f,'second');
  const checker=vi.fn(async()=>{
   expect(await processRecordConnectionOperations(opened.db,clock,new Map([['erp-fixture',async()=>health()]]),1)).toEqual({processed:0});
   return health();
  });
  await processRecordConnectionOperations(opened.db,clock,new Map([['erp-fixture',checker]]),1);
  expect(checker).toHaveBeenCalledTimes(1);
  expect(await readRecordConnectionOperation(opened.db,f.workspace,f.connectionId,second.operationId)).toMatchObject({state:'queued',attempts:0});
  await processRecordConnectionOperations(opened.db,clock,new Map([['erp-fixture',async()=>health()]]),1);
  expect(await readRecordConnectionOperation(opened.db,f.workspace,f.connectionId,second.operationId)).toMatchObject({state:'succeeded',attempts:1});
 });

 it('bounds retries of transient source failures while preserving the same operation identity',async()=>{
  const f=await fixture(),job=await queue(f),checker=vi.fn(async()=>{throw new Error('Synthetic source outage');});
  for(let attempt=1;attempt<=5;attempt++){
   await processRecordConnectionOperations(opened.db,clock,new Map([['erp-fixture',checker]]),1);
   const operation=await readRecordConnectionOperation(opened.db,f.workspace,f.connectionId,job.operationId);
   expect(operation).toMatchObject({operationId:job.operationId,attempts:attempt,state:attempt<5?'queued':'failed',errorCode:'SOURCE_CHECK_UNAVAILABLE'});
   if(operation.nextAttemptAt)now=Date.parse(operation.nextAttemptAt);
  }
  expect(checker).toHaveBeenCalledTimes(5);
  expect(await processRecordConnectionOperations(opened.db,clock,new Map([['erp-fixture',checker]]),1)).toEqual({processed:0});
 });

 it('discards a completed check after membership revocation and denies the original operation read',async()=>{
  const f=await fixture();await queue(f);
  await processRecordConnectionOperations(opened.db,clock,new Map([['erp-fixture',async()=>{await opened.db.query('UPDATE platform_memberships SET revoked_at=$2 WHERE id=$1',[f.membershipId,clock.now().toISOString()]);return health();}]]),1);
  expect(await state(f.connectionId)).toMatchObject({last_success_at:null,last_error_code:'ORGANIZATION_ACCESS_REVOKED'});
  await expect(listRecordConnections(opened.db,clock,f.workspace)).rejects.toMatchObject({code:'ORGANIZATION_NOT_FOUND'});
 });

 it('discards a completed check when the source was paused during the external request',async()=>{
  const f=await fixture(),job=await queue(f);
  await processRecordConnectionOperations(opened.db,clock,new Map([['erp-fixture',async()=>{await actOnRecordConnection(opened.db,clock,f.workspace,f.connectionId,{action:'pause'},'pause-in-flight');return health();}]]),1);
  expect(await readRecordConnectionOperation(opened.db,f.workspace,f.connectionId,job.operationId)).toMatchObject({state:'failed',errorCode:'CONNECTION_PAUSED'});
  expect(await state(f.connectionId)).toMatchObject({paused:true,last_success_at:null});
 });

 it('fences an expired lease and permits a later worker to reconcile the same durable operation',async()=>{
  const f=await fixture(),job=await queue(f);
  await processRecordConnectionOperations(opened.db,clock,new Map([['erp-fixture',async()=>{now+=120001;return health();}]]),1);
  expect(await readRecordConnectionOperation(opened.db,f.workspace,f.connectionId,job.operationId)).toMatchObject({state:'running',attempts:1});
  expect(await state(f.connectionId)).toMatchObject({last_success_at:null});
  await processRecordConnectionOperations(opened.db,clock,new Map([['erp-fixture',async()=>health()]]),1);
  expect(await readRecordConnectionOperation(opened.db,f.workspace,f.connectionId,job.operationId)).toMatchObject({state:'succeeded',attempts:2});
 });

 it('returns a stable pending workspace receipt without activating the organization or duplicating it',async()=>{
  const user=await insertUser(opened.db,clock);await verifyUser(user);
  const first=await requestWorkspace(opened.db,clock,user,body,'workspace-key');
  expect(first.state).toBe('waiting_for_activation');
  expect(await requestWorkspace(opened.db,clock,user,body,'workspace-key')).toEqual(first);
  await expect(requestWorkspace(opened.db,clock,user,{...body,businessName:'Different'},'workspace-key')).rejects.toMatchObject({code:'IDEMPOTENCY_CONFLICT'});
  await expect(requestWorkspace(opened.db,clock,user,body,'new-key')).rejects.toMatchObject({code:'WORKSPACE_REQUEST_EXISTS'});
  expect((await opened.db.query('SELECT enabled FROM platform_organizations WHERE id=$1',[first.organizationId])).rows).toEqual([{enabled:false}]);
  await expect(requireRecordWorkspace(opened.db,user,first.organizationId,'sandbox')).rejects.toMatchObject({code:'WORKSPACE_PENDING'});
  const live=await requestWorkspace(opened.db,clock,user,{...body,environment:'live'},'workspace-key');
  expect(live.organizationId).not.toBe(first.organizationId);
 });

 it('requires a current verified human account and respects the self-service gate',async()=>{
  const unverified=await insertUser(opened.db,clock);
  await expect(requestWorkspace(opened.db,clock,unverified,body,'unverified')).rejects.toMatchObject({code:'VERIFIED_CONTACT_REQUIRED'});
  await verifyUser(unverified,new Date(now+60000).toISOString());
  await expect(requestWorkspace(opened.db,clock,unverified,body,'future-verification')).rejects.toMatchObject({code:'VERIFIED_CONTACT_REQUIRED'});
  const service=await fixture();await verifyUser(service.userId);
  await opened.db.query('INSERT INTO platform_principals(id,organization_id,actor_user_id,name,created_at) VALUES($1,$2,$3,\'Fixture service\',$4)',[newId('principal'),service.organizationId,service.userId,clock.now().toISOString()]);
  await expect(requestWorkspace(opened.db,clock,service.userId,body,'service')).rejects.toMatchObject({code:'HUMAN_AUTHENTICATION_REQUIRED'});
  expect((await request(appFor({})).get('/workspaces').set('Authorization',`Bearer ${service.userId}`)).status).toBe(403);
  vi.stubEnv('PACKPROOF_WORKSPACE_SELF_SERVICE_ENABLED','false');
  await expect(requestWorkspace(opened.db,clock,unverified,body,'gated')).rejects.toMatchObject({code:'WORKSPACE_PROVISIONING_PENDING'});
  vi.stubEnv('PACKPROOF_WORKSPACE_SELF_SERVICE_ENABLED','true');
 });

 it('enforces recent verified authentication in HTTP registration and rejects nonfinite authentication times',async()=>{
  const user=await insertUser(opened.db,clock);await verifyUser(user);
  for(const authenticatedAt of [undefined,NaN,now/1000-301,now/1000+1]){
   const app=appFor({devAuth:false,testFixtures:false,auth:{authenticate:async()=>({userId:user,authenticatedAt})}});
   const denied=await request(app).post('/workspaces').set('Idempotency-Key','auth').send(body);
   expect(denied.status).toBe(401);expect(denied.body.code).toBe('RECENT_AUTHENTICATION_REQUIRED');
  }
  const app=appFor({devAuth:false,testFixtures:false,auth:{authenticate:async()=>({userId:user,authenticatedAt:now/1000})}});
  const registered=await request(app).post('/workspaces').set('Idempotency-Key','auth').send(body);
  expect(registered.status,registered.text).toBe(201);
  const own=await request(app).get('/workspaces');expect(own.body.requests).toHaveLength(1);expect(own.body.requests[0].state).toBe('waiting_for_activation');
 });

 it('enforces the HTTP connection action and operation-read boundary without relying on client scope',async()=>{
  const f=await fixture(),other=await fixture(),app=appFor({});
  const path=`/connections/${f.connectionId}/actions`;
  const accepted=await request(app).post(path).set('Authorization',`Bearer ${f.userId}`).set('Idempotency-Key','http-key').send({organizationId:f.organizationId,environment:'sandbox',action:'test'});
  expect(accepted.status,accepted.text).toBe(202);expect(accepted.headers['cache-control']).toBe('private, no-store');
  const denied=await request(app).get(`/connections/${f.connectionId}/operations/${accepted.body.operationId}`).set('Authorization',`Bearer ${other.userId}`).query({organizationId:other.organizationId,environment:'sandbox'});
  expect(denied.status).toBe(404);
  const missingKey=await request(app).post(path).set('Authorization',`Bearer ${f.userId}`).send({organizationId:f.organizationId,environment:'sandbox',action:'test'});expect(missingKey.status).toBe(400);
 });

 it('prevents cross-environment and cross-tenant foreign-key associations in the new tables',async()=>{
  const a=await fixture(),b=await fixture();
  await expect(opened.db.query('INSERT INTO record_connection_state(connection_id,organization_id,environment,updated_at) VALUES($1,$2,\'sandbox\',$3)',[a.connectionId,b.organizationId,clock.now().toISOString()])).rejects.toMatchObject({code:'23503'});
  await expect(opened.db.query("INSERT INTO record_workspace_requests(id,actor_user_id,organization_id,environment,business_name,region,time_zone,created_at) VALUES($1,$2,$3,'live','Fixture','US','UTC',$4)",[newId('workspace'),a.userId,a.organizationId,clock.now().toISOString()])).rejects.toMatchObject({code:'23503'});
 });
});
