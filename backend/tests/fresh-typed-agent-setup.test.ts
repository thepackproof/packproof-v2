import {beforeAll,afterAll,describe,it,expect,vi} from 'vitest';
import {randomBytes} from 'node:crypto';
import {mkdtemp,rm,cp,mkdir} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import request from './in-process-http.js';
import {createPgliteDatabase} from '../src/db/pglite.js';
import {openIsolatedTestDatabase} from './isolated-test-database.js';
import {migrate} from '../src/db/migrate.js';
import {insertUser} from '../src/domain/users.js';
import {BearerUserAdapter} from '../src/auth/adapter.js';
import {createServerApp} from '../src/server-app.js';
import {DisabledEmailDelivery} from '../src/integrations/email/delivery.js';
import {LocalObjectStore} from '../src/s3/local-object-store.js';
import type {AppDependencies} from '../src/app.js';
import {createOrganization,setOrganizationEntitlement,createIntegrationAccount,addOrganizationMember,createServicePrincipal,issuePartnerCredential} from '../src/platform/organizations.js';
import {requireRecordWorkspace} from '../src/records/access.js';
import {actOnAgent,loadInstallation} from '../src/records/agent-enrollments.js';
import {processPendingTypedImports} from '../src/records/typed-imports.js';
import {sha256Hex} from '../src/hash.js';

const typedFlags=['PACKPROOF_TYPED_INTAKE_ENABLED','PACKPROOF_SOURCE_SUBSCRIPTIONS_ENABLED','PACKPROOF_MULTI_SOURCE_AGENT_ENABLED'];
describe('fresh typed source setup through the assembled application',()=>{
 let opened:Awaited<ReturnType<typeof openIsolatedTestDatabase>>,deps:AppDependencies,app:ReturnType<typeof createServerApp>,dir:string,admin:string,sequence=0;
 const clock={now:()=>new Date('2026-11-14T12:00:00Z')};
 const human=(user:string)=>({Authorization:`Bearer ${user}`});
 async function workspace(){const user=await insertUser(opened.db,clock),n=++sequence,org=(await createOrganization(opened.db,clock,admin,{kind:'MERCHANT',name:`Fresh typed fixture ${n}`,ownerUserId:user},`fresh-${n}`)).id;await setOrganizationEntitlement(opened.db,clock,admin,org,{enabled:true},`fresh-${n}`);const member=(await opened.db.query<{id:string}>('SELECT id FROM platform_memberships WHERE organization_id=$1 AND user_id=$2',[org,user])).rows[0].id,site=`fresh-typed-site-${n}`;await opened.db.query('INSERT INTO record_locations(id,organization_id,name,created_at) VALUES($1,$2,$3,$4)',[site,org,`Site ${n}`,clock.now().toISOString()]);return {user,org,member,site,scope:{organizationId:org,environment:'sandbox'}};}
 type Workspace=Awaited<ReturnType<typeof workspace>>;
 async function start(w:Workspace,version='0.3.0'){const result=await request(app).post('/connect/enrollments').send({deviceName:`Fresh warehouse PC ${++sequence}`,version});expect(result.status,result.text).toBe(201);const detail=await request(app).get(`/me/records/agent-enrollments/${result.body.id}`).query(w.scope).set(human(w.user));expect(detail.status,detail.text).toBe(200);return {start:result.body,detail:detail.body,version};}
 type Enrollment=Awaited<ReturnType<typeof start>>;
 async function approve(w:Workspace,e:Enrollment,extra:Record<string,unknown>,key:string,operator=w.member){return request(app).post(`/me/records/agent-enrollments/${e.start.id}/decision`).query(w.scope).set(human(w.user)).set('Idempotency-Key',key).send({...w.scope,decision:'approve',comparisonCode:e.start.comparisonCode,operatorMembershipId:operator,locationId:w.site,sourceName:'Existing order export files',...extra});}
 async function redeem(w:Workspace,e:Enrollment){const response=await request(app).post(`/connect/enrollments/${e.start.id}/redeem`).send({redeemSecret:e.start.redeemSecret});expect(response.status,response.text).toBe(200);expect(response.body.state).toBe('credential');const service={Authorization:`Bearer ${response.body.token}`,'PackProof-Merchant-Id':w.org};return {credentials:response.body,service};}
 async function acknowledge(e:Enrollment,service:Record<string,string>){const result=await request(app).post('/v1/partner/agent/heartbeat').set(service).send({version:e.version,queueCount:0,enrollmentAcknowledged:true});expect(result.status,result.text).toBe(200);return result.body;}
 const csv='Order,Line,Property,Amount,Unit,AsOf\n0010482,004,orderedQuantity,10,each,2026-11-12T19:00:00Z\n';
 const mapping={orderId:'Order',orderLineId:'Line',property:'Property',amount:'Amount',unit:'Unit',sourceAsOf:'AsOf'},constants={observationKind:'snapshot',timeQuality:'snapshot_time_only'},identityPolicy={schema:'packproof.source-identity-policy/v1',eventKey:{kind:'composite',fields:['orderId','orderLineId','property']},revision:{kind:'source_as_of'}};
 const sourceConfig=()=>({batchSchema:'packproof.typed-source-batch/v2',identityPolicy,transport:'local_ntfs',displayName:'First existing order export',sourceProfile:'packproof.order-lines/v1',mappingVersion:'fresh-order-lines/1',sourceNamespace:'fresh-order-erp',mapping,constants,wholeFileConsent:true,folderDigest:'a'.repeat(64),initialFileName:'orders-first.csv',initialOriginalSha256:sha256Hex(csv),expectedHeaders:['Order','Line','Property','Amount','Unit','AsOf'],historyFrom:'2026-11-01T00:00:00Z',historyTo:null,unknownTimePolicy:'quarantine',maxBytes:2097152,maxRows:1000,offlineWindowHours:24,expectedIntervalSeconds:60,completenessPolicy:{kind:'unknown',scope:'shipment_line',sourceOwnerQualified:false,qualificationReference:null}});
 const batch=(w:Workspace,account:string,subscriptionId='no-source-approved',grantRevision=1)=>({schema:'packproof.typed-source-batch/v2',identityPolicy,connectionId:account,locationId:w.site,sourceProfile:'packproof.order-lines/v1',mappingVersion:'fresh-order-lines/1',sourceNamespace:'fresh-order-erp',subscriptionId,configurationRevision:1,grantRevision,wholeFileConsent:true,original:{name:'orders-first.csv',mediaType:'text/csv',content:csv,sha256:sha256Hex(csv)},mapping,constants,completeness:{kind:'unknown',asOf:null,marker:null}});
 beforeAll(async()=>{for(const flag of ['PACKPROOF_ORGANIZATIONS_ENABLED',...typedFlags,'PACKPROOF_SOURCE_IDENTITY_V2_ENABLED','PACKPROOF_CASE_RECONSTRUCTION_ENABLED'])vi.stubEnv(flag,'true');vi.stubEnv('PACKPROOF_EVENT_CURSOR_KEY',randomBytes(32).toString('base64'));dir=await mkdtemp(path.join(os.tmpdir(),'fresh-typed-setup-'));opened=process.env.PACKPROOF_ORDER_RECOVERY_PROBE==='1'?await createPgliteDatabase(path.join(dir,'db')):await openIsolatedTestDatabase();await migrate(opened.db);admin=await insertUser(opened.db,clock);await opened.db.query("INSERT INTO user_verified_contacts(user_id,email_normalized,verified_at,source) VALUES($1,'nericollin@gmail.com',$2,'COGNITO')",[admin,clock.now().toISOString()]);deps={db:opened.db,clock,objectStore:new LocalObjectStore(path.join(dir,'objects'),'http://localhost','fresh-fixture-secret'),auth:new BearerUserAdapter(opened.db),devAuth:true,testFixtures:true,publicBaseUrl:'https://api.example.test',corsOrigins:['https://portal.example.test'],webhookConfig:{encryptionKey:randomBytes(32).toString('base64'),allowedHosts:['example.test']}};app=createServerApp({...deps,emailDelivery:new DisabledEmailDelivery()});},60000);
 afterAll(async()=>{await opened?.close();if(dir)await rm(dir,{recursive:true,force:true});vi.unstubAllEnvs();});
 it('starts from an empty account list and reaches an order-only recurring source without a legacy CSV setup',async()=>{
  const w=await workspace(),e=await start(w);expect(e.detail.choices.integrationAccounts).toEqual([]);expect(e.detail.capabilities.createLocalSource).toBe(true);
  const approved=await approve(w,e,{integrationAccountId:null,createLocalSource:true},'fresh-create-local');expect(approved.status,approved.text).toBe(200);const i=await loadInstallation(opened.db,approved.body.installationId);expect(i.status).toBe('ready');expect(i.approved_config).toBeNull();expect(i.config_revision).toBe(0);expect(i.test_import_id).toBeNull();expect(i.verified_import_id).toBeNull();
  const account=(await opened.db.query<{id:string;provider:string;external_account_id:string}>('SELECT id,provider,external_account_id FROM platform_integration_accounts WHERE merchant_id=$1',[w.org])).rows;expect(account).toEqual([{id:i.integration_account_id,provider:'packproof-connect-files',external_account_id:`enrollment:${e.start.id}`}]);
  const {service}=await redeem(w,e),early=await request(app).post('/v1/partner/source-subscriptions/proposals').set(service).set('Idempotency-Key','before-protected-ack').send({config:sourceConfig()});expect(early.status).toBe(403);
  const acknowledged=await acknowledge(e,service);expect(acknowledged.state).toBe('ready');expect(acknowledged.config).toBeNull();
  const noGrant=await request(app).post('/v1/partner/typed-imports/preview').set(service).set('Idempotency-Key','ready-is-not-source-grant').send(batch(w,i.integration_account_id));expect(noGrant.status).toBe(403);expect((noGrant.body.error?.code??noGrant.body.code)).toMatch(/AGENT_AUTHORIZATION_REQUIRED|AGENT_OPERATION_DENIED|SOURCE_AUTHORIZATION_REQUIRED/);expect((await opened.db.query('SELECT 1 FROM record_typed_batches WHERE principal_id=$1',[i.principal_id])).rows).toEqual([]);
  const noLegacy=await request(app).post('/v1/partner/imports/preview').set(service).set('Idempotency-Key','no-legacy-config').send({integrationAccountId:i.integration_account_id,operatorMembershipId:w.member,sourceName:'Existing order export files',csv:'Reference,Description,Quantity\nUNAPPROVED,Parcel,1\n',mapping:{shipmentReference:'Reference',itemTitle:'Description',quantity:'Quantity'},timeZone:'UTC'});expect(noLegacy.status,noLegacy.text).toBe(403);const noGeneralCase=await request(app).get('/v1/partner/cases').set(service);expect(noGeneralCase.status,noGeneralCase.text).toBe(403);
  const proposed=await request(app).post('/v1/partner/source-subscriptions/proposals').set(service).set('Idempotency-Key','propose-first-order-export').send({config:sourceConfig()});expect(proposed.status,proposed.text).toBe(202);expect(proposed.body.state).toBe('proposed');
  const subId=proposed.body.subscriptionId,unapproved=await request(app).post('/v1/partner/typed-imports/preview').set(service).set('Idempotency-Key','proposal-not-approval').send(batch(w,i.integration_account_id,subId,1));expect(unapproved.status,unapproved.text).toBe(403);const detail=await request(app).get(`/me/records/source-subscriptions/${subId}`).query(w.scope).set(human(w.user));expect(detail.status,detail.text).toBe(200);
  const sourceApproval=await request(app).post(`/me/records/source-subscriptions/${subId}/actions`).query(w.scope).set(human(w.user)).set('Idempotency-Key','approve-first-order-export').send({action:'approve',configurationRevision:detail.body.configurationRevision,configurationSha256:detail.body.configurationSha256,wholeFileConsent:true});expect(sourceApproval.status,sourceApproval.text).toBe(200);
  const p=await request(app).post('/v1/partner/typed-imports/preview').set(service).set('Idempotency-Key','preview-first-order-export').send(batch(w,i.integration_account_id,subId,sourceApproval.body.grantRevision));expect(p.status,p.text).toBe(201);expect(p.body.counts.processing).toBe(1);
  const commit=await request(app).post(`/v1/partner/typed-imports/${p.body.id}/commit`).set(service).set('Idempotency-Key','commit-first-order-export').send({previewVersion:p.body.previewVersion,originalSha256:p.body.original.sha256,importValidRows:false});expect(commit.status,commit.text).toBe(202);await processPendingTypedImports(deps,10);
  const done=await request(app).get(`/v1/partner/typed-imports/${p.body.id}`).set(service);expect(done.status,done.text).toBe(200);expect(done.body).toMatchObject({state:'succeeded',counts:{acceptedLinked:1,processing:0}});expect(done.body.caseIds).toHaveLength(1);
  const record=await request(app).get(`/v1/partner/typed-imports/${p.body.id}/record`).set(service);expect(record.status,record.text).toBe(200);expect(record.body.rows[0]).toMatchObject({rootReference:{namespace:'fresh-order-erp',type:'order',externalId:'0010482'}});expect(record.body.rows[0].assertions[0]).toMatchObject({property:'orderedQuantity',value:{amount:'10',unit:'each'}});
  const caseDetail=await request(app).get(`/me/records/cases/${done.body.caseIds[0]}`).query(w.scope).set(human(w.user));expect(caseDetail.status,caseDetail.text).toBe(200);expect(caseDetail.body.case).toMatchObject({reference:'0010482',shipmentCount:0,proofIds:[]});
  const recurring=await request(app).post(`/me/records/source-subscriptions/${subId}/actions`).query(w.scope).set(human(w.user)).set('Idempotency-Key','activate-first-order-export').send({action:'activate',configurationRevision:1,recurringConsent:true,initialBatchId:p.body.id});expect(recurring.status,recurring.text).toBe(200);expect(recurring.body.state).toBe('active');
  expect((await opened.db.query('SELECT 1 FROM partner_import_jobs WHERE principal_id=$1',[i.principal_id])).rows).toEqual([]);const final=await loadInstallation(opened.db,i.id);expect(final.approved_config).toBeNull();expect(final.test_import_id).toBeNull();expect(final.verified_import_id).toBeNull();expect(final.status).toBe('ready');expect((await opened.db.query('SELECT 1 FROM platform_proof_ownership WHERE merchant_id=$1',[w.org])).rows).toEqual([]);
 });
 for(const missing of ['old-version',...typedFlags])it(`denies implicit local-source creation for ${missing} and preserves legacy setup`,async()=>{
  const w=await workspace();if(missing!=='old-version')vi.stubEnv(missing,'false');try{const e=await start(w,missing==='old-version'?'0.1.0':'0.3.0');expect(e.detail.capabilities.createLocalSource).toBe(false);const denied=await approve(w,e,{integrationAccountId:null,createLocalSource:true},`denied-${missing}`);expect(denied.status,denied.text).toBe(409);expect((denied.body.error?.code??denied.body.code)).toBe('LOCAL_SOURCE_SETUP_UNAVAILABLE');expect((await opened.db.query('SELECT 1 FROM platform_integration_accounts WHERE merchant_id=$1',[w.org])).rows).toEqual([]);const existing=(await createIntegrationAccount(opened.db,clock,w.user,w.org,{provider:'legacy-csv',externalAccountId:`legacy-${sequence}`},'legacy-source')).id,approved=await approve(w,e,{integrationAccountId:existing},`legacy-approval-${missing}`);expect(approved.status,approved.text).toBe(200);const i=await loadInstallation(opened.db,approved.body.installationId);expect(i.status).toBe('setup');expect(i.approved_config).toBeNull();}finally{if(missing!=='old-version')vi.stubEnv(missing,'true');}
 });
 it('requires an explicit exact human action to upgrade an older approved setup and rechecks current administrators',async()=>{
  const w=await workspace();vi.stubEnv('PACKPROOF_MULTI_SOURCE_AGENT_ENABLED','false');const existing=(await createIntegrationAccount(opened.db,clock,w.user,w.org,{provider:'legacy-csv',externalAccountId:'upgrade-existing'},'upgrade-account')).id,e=await start(w),approved=await approve(w,e,{integrationAccountId:existing},'approve-before-typed-enable');expect(approved.status,approved.text).toBe(200);const {service}=await redeem(w,e);await acknowledge(e,service);vi.stubEnv('PACKPROOF_MULTI_SOURCE_AGENT_ENABLED','true');const i=await loadInstallation(opened.db,approved.body.installationId);expect(i.status).toBe('setup');
  const detail=await request(app).get(`/me/records/agent-installations/${i.id}`).query(w.scope).set(human(w.user));expect(detail.status,detail.text).toBe(200);expect(detail.body.capabilities.sourceSetupApproval).toBe(true);
  const stale=await request(app).post(`/me/records/agent-installations/${i.id}/actions`).query(w.scope).set(human(w.user)).set('Idempotency-Key','stale-upgrade').send({action:'approve_source_setup',configRevision:i.config_revision+1,configSha256:i.config_sha256});expect(stale.status).toBe(409);expect((stale.body.error?.code??stale.body.code)).toBe('CONFIGURATION_CHANGED');
  const reviewer=await insertUser(opened.db,clock),membership=await addOrganizationMember(opened.db,clock,w.user,w.org,{userId:reviewer,role:'ADMIN'},'upgrade-reviewer'),cached=await requireRecordWorkspace(opened.db,reviewer,w.org,'sandbox',true);await opened.db.query('UPDATE platform_memberships SET revoked_at=$2 WHERE id=$1',[membership.id,clock.now().toISOString()]);await expect(opened.db.transaction(tx=>actOnAgent(deps,tx,cached,i.id,{action:'approve_source_setup',configRevision:i.config_revision,configSha256:i.config_sha256},'revoked-admin-upgrade'))).rejects.toMatchObject({code:'ORGANIZATION_NOT_FOUND'});expect((await loadInstallation(opened.db,i.id)).status).toBe('setup');
  const upgraded=await request(app).post(`/me/records/agent-installations/${i.id}/actions`).query(w.scope).set(human(w.user)).set('Idempotency-Key','explicit-source-setup').send({action:'approve_source_setup',configRevision:i.config_revision,configSha256:i.config_sha256});expect(upgraded.status,upgraded.text).toBe(200);expect(upgraded.body.state).toBe('ready');expect(upgraded.body.config).toBeNull();expect((await opened.db.query('SELECT 1 FROM record_source_subscriptions WHERE installation_id=$1',[i.id])).rows).toEqual([]);const noGrant=await request(app).post('/v1/partner/typed-imports/preview').set(service).set('Idempotency-Key','upgraded-without-grant').send(batch(w,existing));expect(noGrant.status).toBe(403);
 });
 it('refuses source setup approval when its responsible operator was revoked after enrollment',async()=>{
  const w=await workspace(),operator=await insertUser(opened.db,clock),membership=await addOrganizationMember(opened.db,clock,w.user,w.org,{userId:operator,role:'OPERATOR'},'upgrade-operator'),existing=(await createIntegrationAccount(opened.db,clock,w.user,w.org,{provider:'legacy-csv',externalAccountId:'operator-upgrade'},'operator-upgrade-account')).id;vi.stubEnv('PACKPROOF_MULTI_SOURCE_AGENT_ENABLED','false');
  let installationId:string;try{const e=await start(w),approved=await approve(w,e,{integrationAccountId:existing},'operator-before-enable',membership.id);expect(approved.status,approved.text).toBe(200);installationId=approved.body.installationId;const {service}=await redeem(w,e);await acknowledge(e,service);}finally{vi.stubEnv('PACKPROOF_MULTI_SOURCE_AGENT_ENABLED','true');}
  const i=await loadInstallation(opened.db,installationId!);await opened.db.query('UPDATE platform_memberships SET revoked_at=$2 WHERE id=$1',[membership.id,clock.now().toISOString()]);const denied=await request(app).post(`/me/records/agent-installations/${i.id}/actions`).query(w.scope).set(human(w.user)).set('Idempotency-Key','revoked-operator-upgrade').send({action:'approve_source_setup',configRevision:i.config_revision,configSha256:i.config_sha256});expect(denied.status,denied.text).toBe(403);expect(denied.body.error?.code??denied.body.code).toBe('OPERATOR_NOT_AUTHORIZED');expect((await loadInstallation(opened.db,i.id)).status).toBe('setup');expect((await opened.db.query('SELECT 1 FROM record_source_subscriptions WHERE installation_id=$1',[i.id])).rows).toEqual([]);
 });

it('approves an exact multi-source scope, links late evidence, and streams immutable revisions',async()=>{
  vi.stubEnv('PACKPROOF_ORDER_WORKSPACE_ENABLED','true');
  const w=await workspace(),e=await start(w,'0.6.0'),approval=await approve(w,e,{integrationAccountId:null,createLocalSource:true},'multi-order-test');
  expect(approval.status,approval.text).toBe(200);
  const {service}=await redeem(w,e);await acknowledge(e,service);
  const post=(p:string,b:unknown)=>request(app).post('/v1/partner/agent/'+p).set(service).send(b);
  const fileSources=['order','packing','delivery'].map((role,index)=>({id:role,generation:1,folderDigest:String(index+1).repeat(64),roles:[role],profileVersion:'fixture/v1'}));
  const sources=[...fileSources,{id:'api',generation:1,folderDigest:'a'.repeat(64),roles:['order'],profileVersion:'packproof.partner-order/v1',transport:'api',sourceNamespace:'ERP_REMOTE'}];
  const session=await post('order-workspace/proposals',{sources,history:'existing_and_future',outputDigest:'f'.repeat(64),outputName:'Proofs'});
  expect(session.status,session.text).toBe(200);const scopeDigest=session.body.scopeDigest;
  const decision='/me/records/agent-installations/'+approval.body.installationId+'/order-workspace/'+session.body.id+'/decision';
  const foreign=await workspace();
  expect((await request(app).post(decision).set(human(foreign.user)).send({...foreign.scope,scopeDigest,decision:'approve'})).status).toBe(404);
  const approved=await request(app).post(decision).set(human(w.user)).send({...w.scope,scopeDigest,decision:'approve'});
  expect(approved.status,approved.text).toBe(200);expect(approved.body.state).toBe('active');
  const order={namespace:'ERP_A',type:'order',id:'SO10482'},pkg={namespace:'PACK',type:'package',id:'PKG92'};
  const item=(id:string,kind:string,entity:typeof order,references:(typeof order)[],lines:unknown[]=[],version='1')=>({eventId:id,kind,entity,references,fields:{},lines,version,locator:'$.record',occurredAt:'2026-11-17T12:00:00Z'});
  const send=(sourceId:string,record:ReturnType<typeof item>,observationId=record.eventId+record.version)=>{
    const bytes=Buffer.from(JSON.stringify(record));
    return post('order-workspace/observations',{sourceId,generation:1,scopeDigest,profileVersion:'fixture/v1',observationId,fileName:sourceId+'.json',mediaType:'application/json',originalSha256:sha256Hex(bytes),originalBase64:bytes.toString('base64'),records:[record]});
  };
  const early=await send('delivery',item('terminal','delivery',{namespace:'POD',type:'event',id:'P1'},[pkg]));
  expect(early.status,early.text).toBe(200);expect(early.body.state).toBe('pending');
  const waiting=await request(app).get('/me/records/order-attention').query(w.scope).set(human(w.user));expect(waiting.status,waiting.text).toBe(200);expect(waiting.body.items[0].entity.id).toBe('P1');
  const sourceOrder=item('order-created','order',order,[],[{lineId:'20',sku:'A100',orderedQuantity:'2'},{lineId:'30',sku:'A100',orderedQuantity:'1'}]);
  const deniedFacility=await send('order',{...sourceOrder,facilityId:foreign.site} as typeof sourceOrder,'forbidden-facility');expect(deniedFacility.status,deniedFacility.text).toBe(403);
  const first=await send('order',sourceOrder);expect(first.status,first.text).toBe(200);
  const id=first.body.proofs[0].proofId;expect(first.body.proofs[0].revision).toBe(1);
  const packed=await send('packing',item('packed','packing',pkg,[order],[{lineId:'20',shippedQuantity:'2'}]));
  expect(packed.status,packed.text).toBe(200);expect(packed.body.proofs).toEqual([{proofId:id,revision:2}]);
  const revision=await send('order',{...sourceOrder,version:'2',lines:[{lineId:'20',orderedQuantity:'3'}]});
  expect(revision.status,revision.text).toBe(200);expect(revision.body.proofs[0].revision).toBe(3);
  expect((await send('order',sourceOrder)).body.proofs[0].revision).toBe(3);
  const detail=await request(app).get('/v1/partner/agent/order-proofs/'+id+'/revisions/3').set(service);
  expect(detail.status,detail.text).toBe(200);expect(detail.body.events).toHaveLength(3);
  expect(detail.body.lines).toEqual([{lineId:'20',sku:'A100',orderedQuantity:'3',shippedQuantity:'2'},{lineId:'30',sku:'A100',orderedQuantity:'1'}]);
  const observationKey=detail.body.evidence.find((v:{eventId:string;version:string})=>v.eventId==='order-created' && v.version==='1').eventKey;
  const inspect=(proof:string,revision:number,key:string)=>request(app).get('/v1/partner/agent/order-proofs/'+proof+'/revisions/'+revision+'/sources/'+key).set(service);
  const source=await inspect(id,3,observationKey);
  expect(source.status,source.text).toBe(200);
  expect(source.body).toMatchObject({kind:'original',eventKey:observationKey,receiptId:first.body.receiptId,originalText:JSON.stringify(sourceOrder)});
  expect((await inspect(id,1,waiting.body.items[0].eventKey)).status).toBe(404);
  const humanRead=await request(app).get('/me/records/order-proofs/'+id).query(w.scope).set(human(w.user));
  expect(humanRead.body).toEqual(detail.body);
  const other=await request(app).get('/me/records/order-proofs/'+id).query(foreign.scope).set(human(foreign.user));
  expect(other.status).toBe(404);
  expect((await request(app).get('/v1/partner/agent/order-proofs/'+id+'/revisions/1').set(service)).body.events).toHaveLength(1);
  const feed=await post('order-changes',{after:0,limit:10});expect(feed.status,feed.text).toBe(200);
  expect(feed.body.changes.map((v:{revision:number})=>v.revision)).toEqual([1,2,3]);
  const list=await request(app).get('/me/records/order-proofs').query(w.scope).set(human(w.user));expect(list.status,list.text).toBe(200);
  expect(list.body.orders[0].proofId).toBe(id);expect(list.body.cursor).toBe(feed.body.nextCursor);
  expect((await post('order-changes',{after:list.body.cursor,limit:10})).body.changes).toEqual([]);
  const pc=await loadInstallation(opened.db,approval.body.installationId);
  const principal=await createServicePrincipal(opened.db,clock,w.user,w.org,{name:'ERP cloud'},'erp');
  const credential=await issuePartnerCredential(opened.db,clock,w.user,w.org,principal.id,{scopes:['proofs:write','proofs:read'],expiresAt:'2026-11-20T12:00:00Z'},'issue');
  const cloudBody={integrationAccountId:pc.integration_account_id,operatorMembershipId:w.member,externalId:'SO-REMOTE',transaction:{itemTitle:'Remote warehouse order'},orderLines:[{lineId:'4',orderedQuantity:'2',sku:'A100'}],connectOperation:{installationId:pc.id,scopeDigest,sourceId:'api',generation:1}};
  const cloud=await request(app).post('/v1/partner/proofs').set('Authorization','Bearer '+credential.token).set('PackProof-Merchant-Id',w.org).set('Idempotency-Key','cloud-origin').send(cloudBody);
  expect(cloud.status,cloud.text).toBe(201);expect(cloud.body.connectedOrder).toBe(true);
  const cloudId=cloud.body.proofId,cloudRef={namespace:'ERP_REMOTE',type:'order',id:'SO-REMOTE'};
  const local=await send('packing',item('warehouse-remote','packing',{namespace:'PACK',type:'package',id:'PKG-REMOTE'},[cloudRef],[{lineId:'4',packedQuantity:'2'}]));
  expect(local.body.proofs).toEqual([{proofId:cloudId,revision:2}]);
  const copied=await request(app).get('/v1/partner/agent/order-proofs/'+cloudId+'/revisions/2').set(service);
  expect(copied.status,copied.text).toBe(200);expect(copied.body.lines).toEqual([{lineId:'4',sku:'A100',orderedQuantity:'2',packedQuantity:'2'}]);
  const change=await post('order-changes',{after:list.body.cursor,limit:10});expect(change.body.changes.map((c:{proofId:string})=>c.proofId)).toEqual([cloudId,cloudId]);
  const moved=await request(app).post('/me/records/order-proofs/'+cloudId+'/associations').set(human(w.user)).set('Idempotency-Key','manual-correction').send({...w.scope,eventKey:waiting.body.items[0].eventKey,action:'link',reason:'Verified against the warehouse dispatch ticket',expectedRevision:2});
  expect(moved.status,moved.text).toBe(200);expect(moved.body.proofs).toEqual(expect.arrayContaining([{proofId:id,revision:4},{proofId:cloudId,revision:3}]));
  const prior=await request(app).get('/v1/partner/agent/order-proofs/'+id+'/revisions/3').set(service);
  expect(prior.body.events).toHaveLength(3);
  const movedSource=await inspect(id,3,waiting.body.items[0].eventKey);
  expect(movedSource.body).toMatchObject({kind:'derived_excerpt',reason:'shared_or_reassigned_record',fields:{}});
  expect(movedSource.body.originalText).toBeUndefined();
  expect((await inspect(cloudId,3,observationKey)).status).toBe(404);
  const submitApi=(version:string,qty:string,key:string)=>{
   const record=item(cloud.body.connectedEventId,'order',cloudRef,[],[{lineId:'4',orderedQuantity:qty}],version);
   const raw=Buffer.from(JSON.stringify(record));
   return request(app).post('/v1/partner/order-workspace/events').set('PackProof-Merchant-Id',w.org).set('Authorization','Bearer '+credential.token).set('Idempotency-Key',key)
    .send({operatorMembershipId:w.member,integrationAccountId:pc.integration_account_id,connectOperation:cloudBody.connectOperation,
     observation:{observationId:'event-'+version,fileName:'change.json',originalSha256:sha256Hex(raw),originalBase64:raw.toString('base64'),records:[record],mediaType:'application/json'}});
  };
  const concurrent=await Promise.all([submitApi('3','5','event-r3'),submitApi('2','4','event-r2'),submitApi('3','5','event-r3')]);
  for(const response of concurrent)expect(response.status,response.text).toBe(202);
  expect(concurrent[0].body.receiptId).toBe(concurrent[2].body.receiptId);
  const afterRace=await request(app).get('/me/records/order-proofs/'+cloudId).query(w.scope).set(human(w.user));
  expect(afterRace.body.lines[0]).toMatchObject({lineId:'4',orderedQuantity:'5',packedQuantity:'2'});
  const unauthorizedOriginal=await request(app).get('/v1/partner/agent/order-proofs/'+id+'/revisions/1/artifacts/'+first.body.receiptId).set(service);
  expect(unauthorizedOriginal.status).toBe(404);
  const conflict=await send('order',{...sourceOrder,lines:[{lineId:'20',orderedQuantity:'300'}]},'distinct-observation-with-conflict');
  expect(conflict.status,conflict.text).toBe(200);expect(conflict.body).toMatchObject({state:'pending',code:'REVISION_CONFLICT'});
  const current=await request(app).get('/me/records/order-proofs/'+id).query(w.scope).set(human(w.user));
  expect(current.body.lines[0].orderedQuantity).toBe('3');
  if(process.env.PACKPROOF_ORDER_RECOVERY_PROBE==='1'){
   const tables=['record_order_roots','record_order_sessions','record_order_receipts','record_order_events','record_order_event_refs','record_order_revisions','record_order_decisions','record_order_link_state','record_order_api_progress'];
   const fingerprint=async(database:typeof opened.db)=>{const counts:Record<string,unknown>={};for(const name of tables)counts[name]=(await database.query(`SELECT COUNT(*)::integer n FROM ${name}`)).rows[0].n;return counts;};
   const expected=await fingerprint(opened.db);
   const stored=(await opened.db.query<{object_key:string;original_sha256:string}>('SELECT object_key,original_sha256 FROM record_order_receipts WHERE id=$1',[first.body.receiptId])).rows[0];
   const base=path.join(dir,'recovery');await mkdir(base,{recursive:true});
   const started=performance.now();await opened.close();
   await cp(path.join(dir,'db'),path.join(base,'db'),{recursive:true});
   await cp(path.join(dir,'objects'),path.join(base,'objects'),{recursive:true});
   opened=await createPgliteDatabase(path.join(base,'db'));await migrate(opened.db);
   expect(await fingerprint(opened.db)).toEqual(expected);
   const restored=new LocalObjectStore(path.join(base,'objects'),'http://localhost','fresh-fixture-secret');
   expect((await restored.digest(stored.object_key))?.sha256).toBe(stored.original_sha256);
   const current=(await opened.db.query<{view: {revision:number;events:unknown[]}}>('SELECT view FROM record_order_revisions WHERE proof_id=$1 AND revision=3',[id])).rows[0].view;
   expect(current).toEqual(prior.body);
   process.stdout.write('Offline backup and restore fixture '+JSON.stringify({milliseconds:Math.round(performance.now()-started),lostCommittedRevisions:0,rows:expected})+'\n');
  }
 },90000);
it('bridges two permitted facilities from an operation-wide installation and rejects foreign locations',async()=>{
  vi.stubEnv('PACKPROOF_ORDER_WORKSPACE_ENABLED','true');
  const w=await workspace(),outside=await workspace(),second=w.site+'-second',e=await start(w,'0.5.0');
  await opened.db.query('INSERT INTO record_locations(id,organization_id,name,created_at) VALUES($1,$2,$3,$4)',[second,w.org,'Receiving dock',clock.now().toISOString()]);
  const approval=await approve(w,e,{integrationAccountId:null,createLocalSource:true,locationId:null},'multi-facility');
  expect(approval.status,approval.text).toBe(200);const {service}=await redeem(w,e);await acknowledge(e,service);
  const agent=(path:string,body:unknown)=>request(app).post('/v1/partner/agent/'+path).set(service).send(body);
  const session=await agent('order-workspace/proposals',{sources:[{id:'erp',generation:1,folderDigest:'a'.repeat(64),roles:['order'],profileVersion:'v1'},{id:'dock',generation:1,folderDigest:'b'.repeat(64),roles:['handoff'],profileVersion:'v1'}],outputDigest:'c'.repeat(64),history:'existing_and_future'});
  const decision=await request(app).post('/me/records/agent-installations/'+approval.body.installationId+'/order-workspace/'+session.body.id+'/decision').set(human(w.user)).send({...w.scope,scopeDigest:session.body.scopeDigest,decision:'approve'});
  expect(decision.status,decision.text).toBe(200);
  const order={namespace:'SALES',type:'order',id:'X-100'},dock={namespace:'FREIGHT',type:'shipment',id:'S-100'};
  const send=(sourceId:string,facilityId:string,ref:boolean,obs:string)=>{
   const record={kind:sourceId==='erp'?'order':'handoff',eventId:obs,version:'1',facilityId,entity:sourceId==='erp'?order:dock,references:ref?[order]:[],fields:{},locator:'$.record'};
   const bytes=Buffer.from(JSON.stringify(record));return agent('order-workspace/observations',{scopeDigest:session.body.scopeDigest,sourceId,generation:1,profileVersion:'v1',observationId:obs,fileName:'record.json',mediaType:'application/json',originalBase64:bytes.toString('base64'),originalSha256:sha256Hex(bytes),records:[record]});
  };
  const first=await send('erp',w.site,false,'created');expect(first.status,first.text).toBe(200);
  const wrong=await send('dock',outside.site,true,'foreign');expect(wrong.status,wrong.text).toBe(403);
  const withoutBridge=await send('dock',second,false,'dock-linked-later');expect(withoutBridge.body.state).toBe('pending');
  const withBridge=await send('dock',second,true,'dispatch');expect(withBridge.status,withBridge.text).toBe(200);expect(withBridge.body.proofs).toEqual([{proofId:first.body.proofs[0].proofId,revision:2}]);
  const detail=await request(app).get('/me/records/order-proofs/'+first.body.proofs[0].proofId).query(w.scope).set(human(w.user));
  expect(detail.body.facilities).toEqual([w.site,second].sort());expect(detail.body.events.map((event:any)=>event.facilityId)).toEqual(expect.arrayContaining([w.site,second]));
  const outsider=await request(app).get('/me/records/order-proofs/'+first.body.proofs[0].proofId).query(outside.scope).set(human(outside.user));expect(outsider.status).toBe(404);
 },90000);
});
