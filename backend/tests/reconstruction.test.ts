import {beforeAll,afterAll,describe,it,expect,vi} from 'vitest';
import {mkdtemp,rm,readFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {randomBytes} from 'node:crypto';
import {openIsolatedTestDatabase} from './isolated-test-database.js';
import {migrate} from '../src/db/migrate.js';
import {insertUser} from '../src/domain/users.js';
import {createOrganization,setOrganizationEntitlement,createServicePrincipal,issuePartnerCredential,createIntegrationAccount,authenticatePartner,PARTNER_SCOPES,type PartnerActor} from '../src/platform/organizations.js';
import {importPartnerOrder} from '../src/platform/partner-proofs.js';
import {LocalObjectStore} from '../src/s3/local-object-store.js';
import {requireRecordWorkspace} from '../src/records/access.js';
import {proposeSourceSubscription,actOnSourceSubscription,heartbeatSourceSubscription} from '../src/records/source-subscriptions.js';
import {previewTypedImport,commitTypedImport,readTypedImport,processPendingTypedImports,type TypedImportDeps} from '../src/records/typed-imports.js';
import {getOperationalCase,listOperationalCases,loadOperationalCaseProjection} from '../src/records/reconstruction.js';
import {synchronizeOperationalCaseIssues,processPendingReconstructionIssues,listOperationalCaseIssues,actOnOperationalCaseIssue,loadOperationalCaseIssueHistory,pageOperationalCaseIssueHistory} from '../src/records/reconstruction-issues.js';
import {sha256Hex} from '../src/hash.js';
import type {TypedSourceObservation,TypedSourceBatch} from '../src/records/source-contracts.js';

describe('source receipts to scoped operational reconstruction and issue history',()=>{
 let opened:Awaited<ReturnType<typeof openIsolatedTestDatabase>>,dir:string,deps:TypedImportDeps,owner:string,org:string,member:string,account:string,actor:PartnerActor,caseId:string;
 let corpus:Array<{name:string;input:Record<string,unknown>}>;
 let currentTime=Date.parse('2026-11-12T19:03:00Z');const clock={now:()=>new Date(currentTime)};
 const site='reconstruction-site';
 const subscriptions=new Map<string,string>();
 const workspace=()=>requireRecordWorkspace(opened.db,owner,org,'sandbox');
 const fixture=(name:string)=>structuredClone(corpus.find(value=>value.name===name)!.input);
 async function source(name:string,profile:string){
  const w=await workspace(),proposed=await opened.db.transaction(tx=>proposeSourceSubscription(tx,clock,w,{connectionId:account,principalId:actor.principalId,operatorMembershipId:member,locationId:site,installationId:null,config:{transport:'partner_api',displayName:name,sourceProfile:profile,mappingVersion:'synthetic-mapping/1',sourceNamespace:'pilot-export',mapping:{},constants:{},wholeFileConsent:true,folderDigest:null,initialFileName:null,initialOriginalSha256:null,expectedHeaders:[],historyFrom:'2026-11-01T00:00:00Z',historyTo:null,maxBytes:2097152,maxRows:1000,offlineWindowHours:24,expectedIntervalSeconds:86400,completenessPolicy:{kind:'snapshot',scope:'shipment_line',sourceOwnerQualified:true,qualificationReference:'synthetic-owner-acceptance/v1'}}},name));
  await opened.db.transaction(tx=>actOnSourceSubscription(tx,clock,w,proposed.id,{action:'approve',configurationRevision:1,configurationSha256:proposed.configurationSha256,wholeFileConsent:true},`approve-${name}`));subscriptions.set(name,proposed.id);return proposed.id;
 }
 function envelope(rows:TypedSourceObservation[],name:string,profile:string){const content=JSON.stringify(rows);return {schema:'packproof.typed-source-batch/v1',connectionId:account,locationId:site,sourceProfile:profile,mappingVersion:'synthetic-mapping/1',sourceNamespace:'pilot-export',subscriptionId:subscriptions.get(name),configurationRevision:1,wholeFileConsent:true,original:{name:'synthetic.json',mediaType:'application/json',content,sha256:sha256Hex(content)},mapping:{},constants:{},completeness:{kind:'snapshot',asOf:'2026-11-12T19:00:00Z',marker:'synthetic-source-inventory-1'}};}
 async function ingest(input:Record<string,unknown>,name:string,key:string){
  const grant=(await opened.db.query<{grant_revision:number}>('SELECT grant_revision FROM record_source_subscriptions WHERE id=$1',[subscriptions.get(name)])).rows[0].grant_revision;
  const adapted={...input,grantRevision:Number(grant),connectionId:account,locationId:site,subscriptionId:subscriptions.get(name),configurationRevision:1,mappingVersion:'synthetic-mapping/1'};
  const p=await previewTypedImport(deps,actor,adapted,`p-${key}`);await commitTypedImport(deps,actor,p.value.id,{previewVersion:p.value.previewVersion,originalSha256:p.value.original.sha256,importValidRows:false},`c-${key}`);await processPendingTypedImports(deps,10);return readTypedImport(deps,actor,p.value.id);
 }
 async function activate(name:string,batchId:string){const w=await workspace(),id=subscriptions.get(name)!;await opened.db.transaction(tx=>actOnSourceSubscription(tx,clock,w,id,{action:'activate',configurationRevision:1,recurringConsent:true,initialBatchId:batchId},`activate-${name}`));await check(name);}
 async function check(name:string,state='checked',errorCode:string|null=null){const grant=(await opened.db.query<{grant_revision:number}>('SELECT grant_revision FROM record_source_subscriptions WHERE id=$1',[subscriptions.get(name)])).rows[0].grant_revision;return heartbeatSourceSubscription(opened.db,clock,actor,subscriptions.get(name)!,{configurationRevision:1,grantRevision:Number(grant),state,sourceAsOf:'2026-11-12T19:00:00Z',checkpoint:'synthetic-source-inventory-1',errorCode,backlog:0,oldestPendingAt:null},`heartbeat-${name}-${state}-${currentTime}`);}
 beforeAll(async()=>{
  for(const flag of ['PACKPROOF_ORGANIZATIONS_ENABLED','PACKPROOF_TYPED_INTAKE_ENABLED','PACKPROOF_SOURCE_SUBSCRIPTIONS_ENABLED','PACKPROOF_CASE_RECONSTRUCTION_ENABLED','PACKPROOF_SOURCE_HEALTH_ENABLED','PACKPROOF_RECONSTRUCTION_RULES_ENABLED'])vi.stubEnv(flag,'true');
  vi.stubEnv('PACKPROOF_EVENT_CURSOR_KEY',randomBytes(32).toString('base64'));
  opened=await openIsolatedTestDatabase();await migrate(opened.db);dir=await mkdtemp(path.join(os.tmpdir(),'reconstruction-'));
  deps={db:opened.db,clock,objectStore:new LocalObjectStore(path.join(dir,'objects'),'http://localhost','reconstruction-test'),devAuth:true};
  const admin=await insertUser(opened.db,clock);owner=await insertUser(opened.db,clock);
  await opened.db.query("INSERT INTO user_verified_contacts(user_id,email_normalized,verified_at,source) VALUES($1,'nericollin@gmail.com',$2,'COGNITO')",[admin,clock.now().toISOString()]);
  org=(await createOrganization(opened.db,clock,admin,{kind:'MERCHANT',name:'Synthetic reconstruction warehouse',ownerUserId:owner},'fixture')).id;await setOrganizationEntitlement(opened.db,clock,admin,org,{enabled:true},'fixture');
  member=(await opened.db.query<{id:string}>('SELECT id FROM platform_memberships WHERE organization_id=$1 AND user_id=$2',[org,owner])).rows[0].id;
  const principal=await createServicePrincipal(opened.db,clock,owner,org,{name:'Authorized synthetic source'},'fixture'),credential=await issuePartnerCredential(opened.db,clock,owner,org,principal.id,{scopes:[...PARTNER_SCOPES],expiresAt:'2026-11-30T12:00:00Z'},'fixture');actor=await authenticatePartner(opened.db,clock,`Bearer ${credential.token}`,org,undefined,'fixture');
  account=(await createIntegrationAccount(opened.db,clock,owner,org,{provider:'synthetic-reconstruction',externalAccountId:'synthetic-only'},'fixture')).id;
  await opened.db.query('INSERT INTO record_locations(id,organization_id,name,created_at) VALUES($1,$2,$3,$4)',[site,org,'Synthetic site',clock.now().toISOString()]);
  corpus=JSON.parse(await readFile(new URL('./fixtures/reconstruction/source-contract-corpus.json',import.meta.url),'utf8')).cases;
  await source('orders','packproof.order-lines/v1');await source('loading','packproof.operational-observations/v1');await source('delivery','packproof.operational-observations/v1');
 },60000);
 afterAll(async()=>{await opened?.close();if(dir)await rm(dir,{recursive:true,force:true});vi.unstubAllEnvs();});
 it('replays a loading feed arriving first, then reconstructs the three approved sources into the 10/8/8 case',async()=>{
  const early=await ingest(fixture('loading-eight-revision-two'),'loading','early-load');expect(early.counts.acceptedUnlinked).toBe(1);
  const ordered=await ingest(fixture('order-and-explicit-shipment-allocation'),'orders','order');caseId=ordered.caseIds[0];await activate('orders',ordered.id);
  const loaded=await readTypedImport(deps,actor,early.id);expect(loaded.counts.acceptedLinked).toBe(1);await activate('loading',early.id);
  const delivered=await ingest(fixture('delivery-eight'),'delivery','delivery');await activate('delivery',delivered.id);
  const result=await loadOperationalCaseProjection(opened.db,clock,await workspace(),caseId);
  expect(result.case).toMatchObject({reference:'0010482',shipmentCount:1,state:'reconstructed'});
  expect(result.assertions.some(value=>value.subject.externalId==='004'&&value.subject.parentExternalId==='0010482')).toBe(true);
  expect(result.comparisons).toHaveLength(2);expect(result.comparisons.map(value=>value.outcome).sort()).toEqual(['different','within_tolerance']);
  expect(result.comparisons.find(value=>value.outcome==='different')).toMatchObject({absoluteDifference:{numerator:'2',denominator:'1'},physicalCondition:'not_established'});
  expect(result.sources).toHaveLength(3);expect(result.sources.every(value=>value.coverage==='qualified')).toBe(true);
  expect(result.timeline.every(value=>value.reportedAt===null&&value.timeBasis==='snapshot_as_of')).toBe(true);
  expect(result.assertions.every(value=>!!value.source.originalSha256&&!!value.source.locator.jsonPointer)).toBe(true);
 });
 it('creates one durable finding, keeps replay harmless and preserves human action history',async()=>{
  expect(await processPendingReconstructionIssues(opened.db,clock,10)).toMatchObject({processed:1,blocked:0});
  const w=await workspace(),first=await listOperationalCaseIssues(opened.db,clock,w,caseId);expect(first.issues).toHaveLength(1);expect(first.issues[0]).toMatchObject({status:'open',category:'quantity_disagreement'});
  const id=first.issues[0].id,before=await loadOperationalCaseIssueHistory(opened.db,clock,w,caseId);await synchronizeOperationalCaseIssues(opened.db,clock,w,caseId);const after=await loadOperationalCaseIssueHistory(opened.db,clock,w,caseId);expect(after.evaluations).toHaveLength(before.evaluations.length);
  const input={action:'acknowledge',reason:'Reviewed both reported rows'};await actOnOperationalCaseIssue(opened.db,clock,w,caseId,id,input,'acknowledge-once');expect((await actOnOperationalCaseIssue(opened.db,clock,w,caseId,id,input,'acknowledge-once')).replayed).toBe(true);
  expect((await listOperationalCaseIssues(opened.db,clock,w,caseId)).issues[0].status).toBe('acknowledged');
  expect((await pageOperationalCaseIssueHistory(opened.db,clock,w,caseId,id,{section:'actions'})).entries).toHaveLength(1);
 });
 it('applies a late loading correction append-only and resolves only the comparison supported by the correction',async()=>{
  const before=await loadOperationalCaseProjection(opened.db,clock,await workspace(),caseId),oldId=before.comparisons.find(value=>value.outcome==='different')!.issueKey;
  currentTime+=1000;await ingest(fixture('loading-correction-to-ten'),'loading','load-correction');await check('loading');
  const result=await loadOperationalCaseProjection(opened.db,clock,await workspace(),caseId);expect(result.assertions.filter(value=>value.property==='reportedLoadedQuantity')).toHaveLength(2);expect(result.assertions.filter(value=>value.property==='reportedLoadedQuantity'&&value.active)[0].value).toEqual({amount:'10',unit:'each'});
  expect(result.comparisons.find(value=>value.issueKey===oldId)).toMatchObject({outcome:'within_tolerance'});
  await synchronizeOperationalCaseIssues(opened.db,clock,await workspace(),caseId);
  const issues=await listOperationalCaseIssues(opened.db,clock,await workspace(),caseId);expect(issues.issues.find(value=>value.id===oldId)?.status).toBe('resolved');expect(issues.issues.some(value=>value.status==='open')).toBe(true);
  const history=await loadOperationalCaseIssueHistory(opened.db,clock,await workspace(),caseId);expect(history.actions.some(value=>value.action==='system_resolve'&&value.actor_user_id===null)).toBe(true);expect(history.evaluations.length).toBeGreaterThan(1);
 });
 it('reopens the same finding on a later disagreement and retains tombstone history without treating absent data as resolution',async()=>{
  const before=await loadOperationalCaseProjection(opened.db,clock,await workspace(),caseId),oldKey=before.comparisons.find(value=>value.inputs.some(input=>input.property==='allocatedQuantity'))!.issueKey;
  const corrected=JSON.parse((fixture('loading-correction-to-ten').original as {content:string}).content)[0] as TypedSourceObservation;
  const next={...corrected,sourceRevision:'4',supersedes:{sourceEventId:corrected.sourceEventId,sourceRevision:'3'},assertions:[{...corrected.assertions[0],value:{amount:'8',unit:'each'}}]};
  currentTime+=1000;await ingest(envelope([next],'loading','packproof.operational-observations/v1'),'loading','reopen');await check('loading');await synchronizeOperationalCaseIssues(opened.db,clock,await workspace(),caseId);
  const reopened=await listOperationalCaseIssues(opened.db,clock,await workspace(),caseId);expect(reopened.issues).toHaveLength(2);expect(reopened.issues.find(value=>value.id===oldKey)?.status).toBe('open');
  const tombstone:TypedSourceObservation={...next,sourceRevision:'5',observationKind:'tombstone',supersedes:{sourceEventId:next.sourceEventId,sourceRevision:'4'},assertions:[],relationships:[]};
  currentTime+=1000;await ingest(envelope([tombstone],'loading','packproof.operational-observations/v1'),'loading','tombstone');await check('loading');await synchronizeOperationalCaseIssues(opened.db,clock,await workspace(),caseId);
  const removed=await loadOperationalCaseProjection(opened.db,clock,await workspace(),caseId);expect(removed.timeline.some(value=>value.observationKind==='tombstone'&&value.active)).toBe(true);expect(removed.assertions.some(value=>value.property==='reportedLoadedQuantity'&&value.active)).toBe(false);
  expect((await listOperationalCaseIssues(opened.db,clock,await workspace(),caseId)).issues.find(value=>value.id===oldKey)?.status).toBe('suppressed');
  const restored={...next,sourceRevision:'6',supersedes:{sourceEventId:next.sourceEventId,sourceRevision:'5'}};
  currentTime+=1000;await ingest(envelope([restored],'loading','packproof.operational-observations/v1'),'loading','restore');await check('loading');
  const history=await loadOperationalCaseIssueHistory(opened.db,clock,await workspace(),caseId);expect(history.actions.some(value=>value.action==='system_reopen'&&value.actor_user_id===null)).toBe(true);
  await expect(opened.db.query("UPDATE record_case_issue_evaluations SET outcome='within_tolerance' WHERE issue_id=$1",[oldKey])).rejects.toThrow(/immutable/i);
  await expect(opened.db.query("INSERT INTO record_case_issue_actions(id,issue_id,case_id,sequence,action,reason,actor_user_id,created_at) VALUES('forged-system-action',$1,$2,999,'system_resolve','Forged human attribution',$3,$4)",[oldKey,caseId,owner,clock.now().toISOString()])).rejects.toThrow(/check constraint/);
 });
 it('suppresses delivery comparisons when that source fails while preserving loading/order information',async()=>{
  currentTime+=1000;await check('delivery','source_unreadable','SOURCE_UNREACHABLE');
  const result=await loadOperationalCaseProjection(opened.db,clock,await workspace(),caseId);expect(result.sources.find(value=>value.subscriptionId===subscriptions.get('delivery'))).toMatchObject({state:'offline'});
  expect(result.comparisons.find(value=>value.inputs.some(input=>input.property==='reportedReceivedQuantity'))).toMatchObject({outcome:'suppressed'});expect(result.assertions.filter(value=>value.active)).toHaveLength(4);
  currentTime+=1000;await check('delivery');
 });
 it('honors source-health and rule switches independently without displaying unmeasured success',async()=>{
  vi.stubEnv('PACKPROOF_SOURCE_HEALTH_ENABLED','false');const unavailable=await getOperationalCase(opened.db,clock,await workspace(),caseId);expect(unavailable.sourceHealthStatus.available).toBe(false);expect(unavailable.sources).toEqual([]);expect(unavailable.comparisons).toEqual([]);expect(unavailable.case.issueCount).toBeNull();
  vi.stubEnv('PACKPROOF_SOURCE_HEALTH_ENABLED','true');vi.stubEnv('PACKPROOF_RECONSTRUCTION_RULES_ENABLED','false');const shadow=await getOperationalCase(opened.db,clock,await workspace(),caseId);expect(shadow.sources).toHaveLength(3);expect(shadow.rulesStatus.available).toBe(false);expect(shadow.comparisons).toEqual([]);vi.stubEnv('PACKPROOF_RECONSTRUCTION_RULES_ENABLED','true');
 });
 it('paginates more than 500 assertions without a hidden cap and rejects an outdated revision cursor',async()=>{
  const base=JSON.parse((fixture('order-and-explicit-shipment-allocation').original as {content:string}).content)[0] as TypedSourceObservation;
  const rows=Array.from({length:510},(_,i):TypedSourceObservation=>({...structuredClone(base),sourceEventId:`history-${i}`,assertions:[structuredClone(base.assertions[0]),{...base.assertions[0],property:'description',value:`reported-${i}`}]}));
  await ingest(envelope(rows,'orders','packproof.order-lines/v1'),'orders','large-case');
  let cursor:string|null=null;const seen=new Set<string>();let total=0;
  do{const page=await getOperationalCase(opened.db,clock,await workspace(),caseId,{section:'assertions',limit:100,...(cursor?{cursor}:{})});total=page.pagination.total;for(const value of page.assertions as Array<{id:string}>)seen.add(value.id);cursor=page.pagination.nextCursor;}while(cursor);
  expect(seen.size).toBe(total);expect(total).toBeGreaterThan(500);
  const first=await getOperationalCase(opened.db,clock,await workspace(),caseId,{limit:100});
  await ingest(envelope([{...base,sourceEventId:'cursor-new-revision'}],'orders','packproof.order-lines/v1'),'orders','cursor-change');
  await expect(getOperationalCase(opened.db,clock,await workspace(),caseId,{limit:100,cursor:first.pagination.nextCursor})).rejects.toMatchObject({code:'CASE_PROJECTION_CHANGED'});
 },60000);
 it('preserves exact search identities and filters before counts',async()=>{
  expect((await listOperationalCases(opened.db,clock,await workspace(),{q:'0010482'})).total).toBe(1);
  expect((await listOperationalCases(opened.db,clock,await workspace(),{q:'10482'})).total).toBe(0);
  const w=await workspace();await expect(getOperationalCase(opened.db,clock,{...w,organizationId:'unrelated-organization'},caseId)).rejects.toMatchObject({code:'ORGANIZATION_NOT_FOUND'});
  expect((await listOperationalCases(opened.db,clock,w,{locationId:'unrelated-site'})).total).toBe(0);
 });
 it('hides stale Proof memberships and historical issue inputs after their source observation moves to another case',async()=>{
  const w=await workspace(),current=await loadOperationalCaseProjection(opened.db,clock,w,caseId),allocation=current.assertions.find(value=>value.property==='allocatedQuantity'&&value.active)!;
  // An explicitly reported shipment may have a source assertion without a
  // relationship row. All list and detail views must count that same entity.
  const removedReference='SHIPMENT-ASSOCIATION-CORRECTED',shipment={namespace:'pilot-export',type:'shipment' as const,externalId:removedReference};
  const sourceRow:TypedSourceObservation={sourceEventId:'assertion-only-shipment',sourceRevision:'1',observationKind:'snapshot',occurredAt:null,sourceAsOf:'2026-11-12T19:00:00Z',timeQuality:'snapshot_time_only',references:[{namespace:'pilot-export',type:'order',externalId:'0010482'},shipment],assertions:[{subjectReference:shipment,property:'status',value:'source-reported',sourceLocator:{row:1,field:'status'},assurance:'source_reported'}],relationships:[],supersedes:null,originSystem:'synthetic fixture',copiedFromSource:null};
  const reported=await ingest(envelope([sourceRow],'loading','packproof.operational-observations/v1'),'loading','assertion-only-shipment');
  const withShipment=await loadOperationalCaseProjection(opened.db,clock,w,caseId),listedBefore=await listOperationalCases(opened.db,clock,w,{q:removedReference});
  expect(withShipment.case.shipmentCount).toBe(current.case.shipmentCount+1);
  expect(listedBefore).toMatchObject({total:1,cases:[{id:caseId,shipmentCount:withShipment.case.shipmentCount}]});
  const proof=await importPartnerOrder(opened.db,clock,actor,{integrationAccountId:account,externalId:'MEMBERSHIP-REGRESSION',operatorMembershipId:member,transaction:{itemTitle:'Explicit source membership fixture',quantity:1}});
  await opened.db.query('INSERT INTO record_state(proof_id,organization_id,environment,location_id,updated_at) VALUES($1,$2,$3,$4,$5)',[proof.proofId,org,'sandbox',site,clock.now().toISOString()]);
  await opened.db.query('INSERT INTO record_case_members(case_id,proof_id,organization_id,environment,source_row_id,created_at) VALUES($1,$2,$3,$4,$5,$6)',[caseId,proof.proofId,org,'sandbox',allocation.source.observationId,clock.now().toISOString()]);
  expect((await loadOperationalCaseProjection(opened.db,clock,w,caseId)).case.proofIds).toContain(proof.proofId);
  // Simulate the mutable current-row result of an authorized association
  // correction. The historical assertion, issue and member ledger stay intact.
  const corrected='case-corrected-fixture';
  await opened.db.query("INSERT INTO record_cases(id,organization_id,environment,location_id,location_key,operator_membership_id,root_namespace,root_type,root_external_id,created_at,updated_at) VALUES($1,$2,'sandbox',$3,$3,$4,'pilot-export','order','CORRECTED',$5,$5)",[corrected,org,site,member,clock.now().toISOString()]);
  await opened.db.query('UPDATE record_typed_rows SET case_id=$2 WHERE id=ANY($1::text[])',[[allocation.source.observationId,reported.rows[0].id],corrected]);
  const old=await loadOperationalCaseProjection(opened.db,clock,w,caseId);expect(old.case.proofIds).not.toContain(proof.proofId);expect(old.assertions.some(value=>value.id===allocation.id)).toBe(false);
  const listedAfter=(await listOperationalCases(opened.db,clock,w,{q:'0010482'})).cases[0];
  expect(listedAfter.proofCount).toBe(0);expect(listedAfter.shipmentCount).toBe(old.case.shipmentCount);expect(old.case.shipmentCount).toBe(current.case.shipmentCount);
  expect(await listOperationalCases(opened.db,clock,w,{q:removedReference})).toMatchObject({total:0,cases:[]});
  expect(old.assertions.some(value=>value.subject.externalId===removedReference)).toBe(false);
  expect((await opened.db.query('SELECT 1 FROM record_case_entities WHERE case_id=$1 AND external_id=$2',[caseId,removedReference])).rows).toHaveLength(1);
  const history=await loadOperationalCaseIssueHistory(opened.db,clock,w,caseId);expect(history.evaluations.some(value=>(value.evaluation as {historyVisibility?:string}).historyVisibility==='restricted')).toBe(true);
  expect((await opened.db.query('SELECT 1 FROM record_case_members WHERE case_id=$1 AND proof_id=$2',[caseId,proof.proofId])).rows).toHaveLength(1);
 });
 it('rebuilds accepted history under current case access after the original ingestion credential is revoked',async()=>{
  await opened.db.query('UPDATE platform_credentials SET revoked_at=$2 WHERE id=$1',[actor.credentialId,clock.now().toISOString()]);
  currentTime+=61000;
  const result=await processPendingReconstructionIssues(opened.db,clock,10);expect(result.processed).toBeGreaterThan(0);expect(result.blocked).toBe(0);
  const detail=await loadOperationalCaseProjection(opened.db,clock,await workspace(),caseId);expect(detail.assertions.length).toBeGreaterThan(500);expect(detail.sources.every(source=>source.state==='offline'||source.state==='paused')).toBe(true);expect(detail.comparisons.every(value=>value.outcome==='not_comparable'||value.outcome==='suppressed')).toBe(true);
 });
});
