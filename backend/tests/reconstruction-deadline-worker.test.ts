import {afterAll,beforeAll,describe,expect,it,vi} from 'vitest';
import {mkdtemp,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {randomBytes} from 'node:crypto';
import {openIsolatedTestDatabase} from './isolated-test-database.js';
import {migrate} from '../src/db/migrate.js';
import {insertUser} from '../src/domain/users.js';
import {authenticatePartner,createIntegrationAccount,createOrganization,createServicePrincipal,issuePartnerCredential,PARTNER_SCOPES,setOrganizationEntitlement,type PartnerActor} from '../src/platform/organizations.js';
import {LocalObjectStore} from '../src/s3/local-object-store.js';
import {sha256Hex} from '../src/hash.js';
import {requireRecordWorkspace} from '../src/records/access.js';
import {actOnSourceSubscription,heartbeatSourceSubscription,proposeSourceSubscription,type SourceSubscriptionConfig} from '../src/records/source-subscriptions.js';
import {commitTypedImport,previewTypedImport,processPendingTypedImports,readTypedImport,type TypedImportDeps} from '../src/records/typed-imports.js';
import {getOperationalCase} from '../src/records/reconstruction.js';
import {processPendingCaseProjections,synchronizeOperationalCaseProjection} from '../src/records/projection-worker.js';
import {listOperationalCaseIssues,processPendingReconstructionIssues,synchronizeOperationalCaseIssues} from '../src/records/reconstruction-issues.js';
import type {SourceRulePolicies} from '../src/records/source-rule-policy.js';
import type {TypedSourceObservation,TypedSourceReference} from '../src/records/source-contracts.js';

describe('first durable finding at a qualified operational deadline',()=>{
 let opened:Awaited<ReturnType<typeof openIsolatedTestDatabase>>,dir:string,deps:TypedImportDeps,owner:string,org:string,member:string,account:string,actor:PartnerActor;
 const createdAt=Date.parse('2026-11-14T10:00:00Z'),deadline=createdAt+60000,site='deadline-fixture-site',namespace='deadline-package-identity';
 let currentTime=deadline-1000;const clock={now:()=>new Date(currentTime)},workspace=()=>requireRecordWorkspace(opened.db,owner,org,'sandbox');
 const identityPolicy:NonNullable<SourceSubscriptionConfig['identityPolicy']>={schema:'packproof.source-identity-policy/v1',eventKey:{kind:'column'},revision:{kind:'column'}};
 type Source={id:string;name:string;config:SourceSubscriptionConfig};
 const ref=(type:TypedSourceReference['type'],externalId:string):TypedSourceReference=>({namespace,type,externalId});
 async function source(name:string,rulePolicies?:SourceRulePolicies,sourceProfile:SourceSubscriptionConfig['sourceProfile']='packproof.operational-observations/v2'):Promise<Source>{
  const config:SourceSubscriptionConfig={batchSchema:'packproof.typed-source-batch/v2',identityPolicy,transport:'partner_api',displayName:`Synthetic ${name}`,sourceProfile,mappingVersion:'deadline-fixture/1',sourceNamespace:namespace,mapping:{},constants:{},wholeFileConsent:true,folderDigest:null,initialFileName:null,initialOriginalSha256:null,expectedHeaders:[],historyFrom:'2026-11-13T00:00:00Z',historyTo:null,unknownTimePolicy:'quarantine',maxBytes:2097152,maxRows:1000,offlineWindowHours:24,expectedIntervalSeconds:3600,completenessPolicy:{kind:'snapshot',scope:'tracking_package',sourceOwnerQualified:true,qualificationReference:'Synthetic source-owner inventory contract'},...(rulePolicies?{rulePolicies}:{})};
  const w=await workspace(),proposed=await opened.db.transaction(tx=>proposeSourceSubscription(tx,clock,w,{connectionId:account,principalId:actor.principalId,installationId:null,operatorMembershipId:member,locationId:site,config},`propose-${name}`));
  await opened.db.transaction(tx=>actOnSourceSubscription(tx,clock,w,proposed.id,{action:'approve',configurationRevision:1,configurationSha256:proposed.configurationSha256,wholeFileConsent:true},`approve-${name}`));return {id:proposed.id,name,config};
 }
 async function check(s:Source){const grant=Number((await opened.db.query<{grant_revision:number}>('SELECT grant_revision FROM record_source_subscriptions WHERE id=$1',[s.id])).rows[0].grant_revision);await heartbeatSourceSubscription(opened.db,clock,actor,s.id,{configurationRevision:1,grantRevision:grant,state:'checked',sourceAsOf:clock.now().toISOString(),checkpoint:`synthetic-inventory-${currentTime}`,errorCode:null,backlog:0,oldestPendingAt:null},`check-${s.name}-${currentTime}`);}
 async function ingest(s:Source,rows:TypedSourceObservation[],key:string){
  const content=JSON.stringify(rows),grant=Number((await opened.db.query<{grant_revision:number}>('SELECT grant_revision FROM record_source_subscriptions WHERE id=$1',[s.id])).rows[0].grant_revision);
  const input={schema:'packproof.typed-source-batch/v2',connectionId:account,locationId:site,sourceProfile:s.config.sourceProfile,mappingVersion:s.config.mappingVersion,sourceNamespace:s.config.sourceNamespace,subscriptionId:s.id,configurationRevision:1,grantRevision:grant,wholeFileConsent:true,identityPolicy,mapping:{},constants:{},original:{name:`${key}.json`,mediaType:'application/json',content,sha256:sha256Hex(content)},completeness:{kind:'snapshot',asOf:clock.now().toISOString(),marker:`synthetic-inventory-${currentTime}`}};
  const preview=await previewTypedImport(deps,actor,input,`preview-${key}`);expect(preview.value.rows.map(r=>r.errors)).toEqual(rows.map(()=>[]));await commitTypedImport(deps,actor,preview.value.id,{previewVersion:preview.value.previewVersion,originalSha256:preview.value.original.sha256,importValidRows:false},`commit-${key}`);await processPendingTypedImports(deps,10);return readTypedImport(deps,actor,preview.value.id);
 }
 async function activate(s:Source,batchId:string){const w=await workspace();await opened.db.transaction(tx=>actOnSourceSubscription(tx,clock,w,s.id,{action:'activate',configurationRevision:1,recurringConsent:true,initialBatchId:batchId},`activate-${s.name}`));await check(s);}
 function status(event:string,order:string):TypedSourceObservation{const subject=ref('order',order);return {sourceEventId:event,sourceRevision:'1',observationKind:'event',occurredAt:clock.now().toISOString(),sourceAsOf:null,timeQuality:'event_time',references:[subject],assertions:[{subjectReference:subject,property:'status',value:'inventory reported',sourceLocator:{row:1,field:'status'},assurance:'source_reported'}],relationships:[],supersedes:null,originSystem:'Synthetic independent inventory',copiedFromSource:null};}
 function order(event:string,root:string):TypedSourceObservation{const subject=ref('order',root),line={...ref('order_line','001'),parentExternalId:root};return {...status(event,root),references:[subject,line],assertions:[{subjectReference:line,property:'orderedQuantity',value:{amount:'10',unit:'each'},sourceLocator:{row:1,field:'orderedQuantity'},assurance:'source_reported'}],relationships:[{from:subject,to:line,type:'has_line',quantity:null}]};}
 function packageEvent(event:string,tracking:string,property:'labelStatus'|'carrierAcceptanceStatus',value:string):TypedSourceObservation{
  const order=ref('order','DEADLINE-ORDER'),shipment=ref('shipment','DEADLINE-SHIPMENT'),subject=ref('tracking',tracking),values=[[property,value],['carrierCode','synthetic-carrier'],['carrierAccountReference','synthetic-account'],['carrierService','ground']];
  return {...status(event,order.externalId),occurredAt:new Date(createdAt).toISOString(),references:[order,shipment,subject],assertions:values.map(([field,text])=>({subjectReference:subject,property:field,value:text,sourceLocator:{row:1,field},assurance:'source_reported'})),relationships:[{from:subject,to:shipment,type:'tracks',quantity:null}]};
 }
 beforeAll(async()=>{
  for(const flag of ['PACKPROOF_ORGANIZATIONS_ENABLED','PACKPROOF_TYPED_INTAKE_ENABLED','PACKPROOF_SOURCE_SUBSCRIPTIONS_ENABLED','PACKPROOF_CASE_RECONSTRUCTION_ENABLED','PACKPROOF_SOURCE_HEALTH_ENABLED','PACKPROOF_RECONSTRUCTION_RULES_ENABLED','PACKPROOF_PAGED_PROJECTIONS_ENABLED','PACKPROOF_SOURCE_IDENTITY_V2_ENABLED','PACKPROOF_SOURCE_RULE_POLICIES_ENABLED'])vi.stubEnv(flag,'true');vi.stubEnv('PACKPROOF_EVENT_CURSOR_KEY',randomBytes(32).toString('base64'));
  opened=await openIsolatedTestDatabase();await migrate(opened.db);dir=await mkdtemp(path.join(os.tmpdir(),'deadline-worker-'));deps={db:opened.db,clock,objectStore:new LocalObjectStore(path.join(dir,'objects'),'http://localhost','synthetic-deadline'),devAuth:true};
  const admin=await insertUser(opened.db,clock);owner=await insertUser(opened.db,clock);await opened.db.query("INSERT INTO user_verified_contacts(user_id,email_normalized,verified_at,source) VALUES($1,'nericollin@gmail.com',$2,'COGNITO')",[admin,clock.now().toISOString()]);org=(await createOrganization(opened.db,clock,admin,{kind:'MERCHANT',name:'Synthetic deadline warehouse',ownerUserId:owner},'deadline')).id;await setOrganizationEntitlement(opened.db,clock,admin,org,{enabled:true},'deadline');member=(await opened.db.query<{id:string}>('SELECT id FROM platform_memberships WHERE organization_id=$1 AND user_id=$2',[org,owner])).rows[0].id;
  const principal=await createServicePrincipal(opened.db,clock,owner,org,{name:'Synthetic deadline source'},'deadline'),credential=await issuePartnerCredential(opened.db,clock,owner,org,principal.id,{scopes:[...PARTNER_SCOPES],expiresAt:'2026-11-15T12:00:00Z'},'deadline');actor=await authenticatePartner(opened.db,clock,`Bearer ${credential.token}`,org,undefined,'deadline');account=(await createIntegrationAccount(opened.db,clock,owner,org,{provider:'synthetic-deadline',externalAccountId:'synthetic'},'deadline')).id;await opened.db.query('INSERT INTO record_locations(id,organization_id,name,created_at) VALUES($1,$2,$3,$4)',[site,org,'Synthetic deadline site',clock.now().toISOString()]);
 },60000);
 afterAll(async()=>{await opened?.close();if(dir)await rm(dir,{recursive:true,force:true});vi.unstubAllEnvs();});
 it('wakes the first issue at the exact label deadline after independent inventories cover it',async()=>{
  const orders=await source('orders',undefined,'packproof.order-lines/v1'),roots=await ingest(orders,[order('target-order','DEADLINE-ORDER'),order('boundary-order','BOUNDARY-ORDER')],'seed-orders');await activate(orders,roots.id);
  const labels=await source('labels'),acceptance=await source('acceptance'),binding=(s:Source)=>({subscriptionId:s.id,configurationRevision:1,sourceNamespace:s.config.sourceNamespace});
  const policy:SourceRulePolicies={schema:'packproof.source-rule-policies/v1',version:'synthetic-deadline/1',sourceOwnerQualified:true,qualificationReference:'Synthetic package/carrier acceptance contract',labelAcceptance:{labelSource:binding(labels),acceptanceSource:binding(acceptance),subjectNamespace:namespace,carrier:{code:'synthetic-carrier',accountReference:'synthetic-account',service:'ground'},windowSeconds:60,graceSeconds:0,labelCreatedValues:['CREATED'],labelVoidedValues:['VOIDED'],acceptedValues:['ACCEPTED']}};
  const host=await source('policy',policy),seed=await ingest(host,[status('policy-context','DEADLINE-ORDER')],'policy-context');await activate(host,seed.id);
  const created=await ingest(labels,[packageEvent('label-created','PACKAGE-A','labelStatus','CREATED')],'label-created');await activate(labels,created.id);
  const other=await ingest(acceptance,[packageEvent('other-package-accepted','PACKAGE-B','carrierAcceptanceStatus','ACCEPTED')],'other-package-accepted');await activate(acceptance,other.id);
  const id=seed.caseIds[0],w=await workspace();for(const root of roots.caseIds){await synchronizeOperationalCaseProjection(opened.db,clock,w,root);await synchronizeOperationalCaseIssues(opened.db,clock,w,root);}
  const before=await getOperationalCase(opened.db,clock,w,id);expect(before.comparisons).toEqual([expect.objectContaining({category:'label_acceptance_gap',outcome:'suppressed',deadlineAt:new Date(deadline).toISOString()})]);expect(before.case.issueCount).toBe(0);expect((await listOperationalCaseIssues(opened.db,clock,w,id)).total).toBe(0);
  const due=(await opened.db.query<{next_check_at:Date|string}>('SELECT next_check_at FROM record_case_projection_state WHERE case_id=$1',[id])).rows[0];expect(new Date(due.next_check_at).getTime()).toBe(deadline);
  currentTime=deadline;
  // New originals advance each independent source inventory through the exact
  // deadline. Their unrelated case cannot change the target case revision.
  const boundary=await ingest(labels,[status('labels-boundary','BOUNDARY-ORDER')],'labels-boundary');await ingest(acceptance,[status('acceptance-boundary','BOUNDARY-ORDER')],'acceptance-boundary');await check(labels);await check(acceptance);
  for(const boundaryId of boundary.caseIds){await synchronizeOperationalCaseProjection(opened.db,clock,w,boundaryId);await synchronizeOperationalCaseIssues(opened.db,clock,w,boundaryId);}
  expect(await processPendingCaseProjections(opened.db,clock,1)).toEqual({processed:1,blocked:0});
  const after=await getOperationalCase(opened.db,clock,w,id);expect(after.case.revision).toBe(before.case.revision);expect(after.projectionVersion).not.toBe(before.projectionVersion);expect(after.comparisons).toEqual([expect.objectContaining({category:'label_acceptance_gap',outcome:'different'})]);
  expect(await processPendingReconstructionIssues(opened.db,clock,1)).toEqual({processed:1,blocked:0});
  expect((await listOperationalCaseIssues(opened.db,clock,w,id)).issues).toEqual([expect.objectContaining({category:'label_acceptance_gap',evaluation:expect.objectContaining({outcome:'different',physicalCondition:'not_established'})})]);
  expect(await processPendingReconstructionIssues(opened.db,clock,1)).toEqual({processed:0,blocked:0});
 },60000);
});
