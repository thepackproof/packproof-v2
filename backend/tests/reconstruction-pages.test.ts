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
import type {Database} from '../src/db/database.js';
import {synchronizeOperationalCaseProjection,processPendingCaseProjections} from '../src/records/projection-worker.js';
import {readProjectionSourceCounter} from '../src/records/projection-store.js';
import {getOperationalCase,listOperationalCases,loadOperationalCaseProjection} from '../src/records/reconstruction.js';
import {synchronizeOperationalCaseIssues,processPendingReconstructionIssues,listOperationalCaseIssues,actOnOperationalCaseIssue,loadOperationalCaseIssueHistory,pageOperationalCaseIssueHistory} from '../src/records/reconstruction-issues.js';
import {sha256Hex} from '../src/hash.js';
import type {TypedSourceObservation,TypedSourceBatch} from '../src/records/source-contracts.js';

describe('bounded operational projection pages and complete worker findings',()=>{
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
  for(const flag of ['PACKPROOF_ORGANIZATIONS_ENABLED','PACKPROOF_TYPED_INTAKE_ENABLED','PACKPROOF_SOURCE_SUBSCRIPTIONS_ENABLED','PACKPROOF_CASE_RECONSTRUCTION_ENABLED','PACKPROOF_SOURCE_HEALTH_ENABLED','PACKPROOF_RECONSTRUCTION_RULES_ENABLED','PACKPROOF_PAGED_PROJECTIONS_ENABLED'])vi.stubEnv(flag,'true');
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
  const ordered=await ingest(fixture('order-and-explicit-shipment-allocation'),'orders','seed-order');caseId=ordered.caseIds[0];await activate('orders',ordered.id);
  const loaded=await ingest(fixture('loading-eight-revision-two'),'loading','seed-loading');await activate('loading',loaded.id);
  const delivered=await ingest(fixture('delivery-eight'),'delivery','seed-delivery');await activate('delivery',delivered.id);
  const base=JSON.parse((fixture('order-and-explicit-shipment-allocation').original as {content:string}).content)[0] as TypedSourceObservation;
  const rows=Array.from({length:602},(_,i):TypedSourceObservation=>({...structuredClone(base),sourceEventId:`bounded-history-${i}`,assertions:[{...base.assertions[0],property:'status',value:`reported-${i}`}]}));
  await ingest(envelope(rows,'loading','packproof.operational-observations/v1'),'loading','retained-history');
 },120000);
 afterAll(async()=>{await opened?.close();if(dir)await rm(dir,{recursive:true,force:true});vi.unstubAllEnvs();});

 it('returns bounded SQL pages beyond 500 while findings remain explicitly pending',async()=>{
  const observed:number[]=[];
  const db:Database={query:async(sql,params)=>{const result=await opened.db.query(sql,params);observed.push(result.rows.length);return result as never;},transaction:fn=>opened.db.transaction(fn)};
  const w=await workspace(),first=await getOperationalCase(db,clock,w,caseId,{limit:100});
  expect(first.projectionStatus.state).toBe('pending');expect(first.case.issueCount).toBeNull();expect(first.totals.comparisons).toBeNull();expect(first.rulesStatus.available).toBe(false);
  expect(first.sources.every(source=>(source as typeof source&{accountingAvailable:boolean}).accountingAvailable===false)).toBe(true);
  let cursor:string|null=null;const seen=new Set<string>();let total=0;
  do{const page=await getOperationalCase(db,clock,w,caseId,{section:'assertions',limit:100,...(cursor?{cursor}:{})});total=Number(page.pagination.total);for(const value of page.assertions)seen.add(value.id);cursor=page.pagination.nextCursor;}while(cursor);
  expect(total).toBeGreaterThan(600);expect(seen.size).toBe(total);expect(Math.max(...observed)).toBeLessThanOrEqual(101);
 },60000);
 it('evaluates all active assertions once in the worker and serves the complete summary on every page',async()=>{
  const result=await synchronizeOperationalCaseProjection(opened.db,clock,await workspace(),caseId);expect(result.comparisonCount).toBe(2);
  const counter=await readProjectionSourceCounter(opened.db,subscriptions.get('loading')!);expect(counter.ready).toBe(true);expect(counter.counts.received).toBe(603);expect(counter.counts.acceptedLinked).toBe(603);
  const first=await getOperationalCase(opened.db,clock,await workspace(),caseId,{limit:100});expect(first.projectionStatus.state).toBe('ready');expect(first.case.issueCount).toBe(1);expect(first.comparisons.map(c=>c.outcome).sort()).toEqual(['different','within_tolerance']);
  const next=await getOperationalCase(opened.db,clock,await workspace(),caseId,{limit:100,cursor:first.pagination.nextCursor});expect(next.case.issueCount).toBe(1);expect(next.assertions).toHaveLength(100);
 },60000);
 it('rechecks cached comparison inputs against current allocation after an association repair',async()=>{
  const w=await workspace(),before=await getOperationalCase(opened.db,clock,w,caseId),input=before.comparisons.flatMap(c=>c.inputs).find(a=>a.property==='reportedLoadedQuantity')!;
  const rollback=new Error('Rollback simulated association repair');
  await expect(opened.db.transaction(async tx=>{
   const other='cache-reassociation-fixture';await tx.query("INSERT INTO record_cases(id,organization_id,environment,location_id,location_key,operator_membership_id,root_namespace,root_type,root_external_id,created_at,updated_at) VALUES($1,$2,'sandbox',$3,$3,$4,'cache-fixture','order','REASSOCIATED',$5,$5)",[other,org,site,member,clock.now().toISOString()]);
   await tx.query('UPDATE record_typed_rows SET case_id=$2 WHERE id=$1',[input.source.observationId,other]);
   const repaired=await getOperationalCase(tx,clock,w,caseId);expect(repaired.case.revision).toBe(before.case.revision);expect(repaired.projectionStatus.state).toBe('stale');expect(repaired.comparisons).toEqual([]);expect(repaired.case.issueCount).toBeNull();expect(JSON.stringify(repaired)).not.toContain(input.id);throw rollback;
  })).rejects.toBe(rollback);
 });
 it('suppresses expired derived findings and invalidates a cursor when qualification changes',async()=>{
  const first=await getOperationalCase(opened.db,clock,await workspace(),caseId,{limit:100});currentTime+=61000;await opened.db.query('UPDATE record_case_projection_state SET valid_until=$2 WHERE case_id=$1',[caseId,clock.now().toISOString()]);
  const stale=await getOperationalCase(opened.db,clock,await workspace(),caseId,{limit:100});expect(stale.projectionStatus.state).toBe('stale');expect(stale.case.issueCount).toBeNull();expect(stale.comparisons).toEqual([]);expect(stale.totals.comparisons).toBeNull();
  await expect(getOperationalCase(opened.db,clock,await workspace(),caseId,{limit:100,cursor:first.pagination.nextCursor})).rejects.toMatchObject({code:'CASE_PROJECTION_CHANGED'});
  expect(await processPendingCaseProjections(opened.db,clock,10)).toMatchObject({processed:1,blocked:0});
 },60000);
 it('omits reassociated graph edges and exposes only an opaque restricted alias indicator',async()=>{
  vi.stubEnv('PACKPROOF_CROSS_CASE_ENABLED','true');
  const other=await insertUser(opened.db,clock),otherMember='projection-other-reviewer',neighbor='zz-projection-hidden-neighbor',otherSite='projection-hidden-site';
  await opened.db.query("INSERT INTO platform_memberships(id,organization_id,user_id,role,location_scoped,created_at) VALUES($1,$2,$3,'REVIEWER',true,$4)",[otherMember,org,other,clock.now().toISOString()]);
  await opened.db.query("INSERT INTO record_cases(id,organization_id,environment,location_id,location_key,operator_membership_id,root_namespace,root_type,root_external_id,created_at,updated_at) VALUES($1,$2,'sandbox',$3,$3,$4,'hidden-source','order','HIDDEN-ORDER',$5,$5)",[neighbor,org,site,member,clock.now().toISOString()]);
  const source=(await opened.db.query<{id:string}>('SELECT id FROM record_typed_rows WHERE case_id=$1 ORDER BY id LIMIT 1',[caseId])).rows[0].id;
  for(const id of [caseId,neighbor])await opened.db.query(`INSERT INTO record_case_row_projections(id,observation_id,case_id,organization_id,environment,location_id,operator_membership_id,state,normalized,assertion_indexes,relationship_indexes,assertion_ids,relationship_ids,basis,created_at) SELECT 'projection-scope-'||$1,r.id,$1,$2,'sandbox',$3,$4,'linked',r.normalized,'[]'::jsonb,'[]'::jsonb,COALESCE((SELECT jsonb_agg(a.id) FROM record_case_assertions a WHERE a.observation_id=r.id AND a.case_id=$5),'[]'::jsonb),COALESCE((SELECT jsonb_agg(rel.id) FROM record_case_relations rel WHERE rel.assertion_row_id=r.id AND rel.case_id=$5),'[]'::jsonb),'{}'::jsonb,$6 FROM record_typed_rows r WHERE r.id=$7`,[id,org,site,member,caseId,clock.now().toISOString(),source]);
  const [left,right]=[caseId,neighbor].sort();
  await opened.db.query("INSERT INTO record_case_links(id,organization_id,environment,location_id,left_case_id,right_case_id,shared_reference,observation_id,relation_type,state,basis,created_at) VALUES('hidden-link',$1,'sandbox',$2,$3,$4,$5::jsonb,$6,'shared_load','linked','{}'::jsonb,$7)",[org,site,left,right,JSON.stringify({namespace:'hidden-source',type:'load',externalId:'HIDDEN-LOAD'}),source,clock.now().toISOString()]);
  await opened.db.query("INSERT INTO record_case_entity_aliases(id,organization_id,environment,location_id,left_case_id,right_case_id,left_reference,right_reference,cardinality,rule_version,reason,approved_by,created_at) VALUES('hidden-alias',$1,'sandbox',$2,$3,$4,$5::jsonb,$6::jsonb,'one_to_one','alias-test/v1','HIDDEN-REASON',$7,$8)",[org,site,caseId,neighbor,JSON.stringify({namespace:'pilot-export',type:'order_line',externalId:'004',parentExternalId:'0010482'}),JSON.stringify({namespace:'hidden-source',type:'order_line',externalId:'HIDDEN-LINE',parentExternalId:'HIDDEN-ORDER'}),owner,clock.now().toISOString()]);
  await opened.db.query('INSERT INTO record_membership_locations(organization_id,membership_id,location_id) VALUES($1,$2,$3)',[org,otherMember,site]);
  await opened.db.query('INSERT INTO record_locations(id,organization_id,name,created_at) VALUES($1,$2,$3,$4)',[otherSite,org,'Hidden site',clock.now().toISOString()]);
  const visible=await getOperationalCase(opened.db,clock,await workspace(),caseId,{section:'caseLinks'});expect(visible.caseLinks).toHaveLength(1);expect(visible.aliases).toHaveLength(1);
  // The immutable graph predates a current authority change. Its foreign IDs
  // cannot become a route around the current operator predicate.
  await opened.db.query('UPDATE record_cases SET location_id=$2,location_key=$2 WHERE id=$1',[neighbor,otherSite]);
  try{const scoped=await getOperationalCase(opened.db,clock,await requireRecordWorkspace(opened.db,other,org,'sandbox'),caseId,{section:'caseLinks'});expect(scoped.caseLinks).toEqual([]);expect(scoped.aliases).toEqual([]);expect(scoped.totals.caseLinks).toBe(0);expect(scoped.totals.aliases).toBe(0);expect(scoped.restrictedCaseLinks).toBe(false);expect(scoped.restrictedAliases).toBe(true);expect(JSON.stringify(scoped)).not.toMatch(/HIDDEN|hidden-link|hidden-alias|zz-projection-hidden-neighbor/);}
  finally{await opened.db.query('UPDATE record_cases SET location_id=$2,location_key=$2 WHERE id=$1',[neighbor,site]);vi.stubEnv('PACKPROOF_CROSS_CASE_ENABLED','false');}
 },60000);
 it('paginates more than 100 authorized Proof memberships without calling truncation restricted',async()=>{
  const w=await workspace(),before=await getOperationalCase(opened.db,clock,w,caseId,{limit:40}),existing=before.case.proofCount;
  const source=(await opened.db.query<{id:string}>(`SELECT r.id FROM record_typed_rows r JOIN record_case_assertions a ON a.observation_id=r.id WHERE a.case_id=$1 AND a.property='allocatedQuantity' ORDER BY r.id LIMIT 1`,[caseId])).rows[0].id;
  let movedProof='';
  for(let index=0;index<106;index++){
   const proof=await importPartnerOrder(opened.db,clock,actor,{integrationAccountId:account,externalId:`PROOF-PAGE-${index}`,operatorMembershipId:member,transaction:{itemTitle:'Explicit synthetic case membership',quantity:1}});
   await opened.db.query("INSERT INTO record_state(proof_id,organization_id,environment,location_id,updated_at) VALUES($1,$2,'sandbox',$3,$4)",[proof.proofId,org,site,clock.now().toISOString()]);
   await opened.db.query("INSERT INTO record_case_members(case_id,proof_id,organization_id,environment,source_row_id,created_at) VALUES($1,$2,$3,'sandbox',$4,$5)",[caseId,proof.proofId,org,source,clock.now().toISOString()]);if(index===105)movedProof=proof.proofId;
  }
  const foreignSite='proof-membership-other-site';await opened.db.query('INSERT INTO record_locations(id,organization_id,name,created_at) VALUES($1,$2,$3,$4)',[foreignSite,org,'Other Proof site',clock.now().toISOString()]);const beforeMove=await getOperationalCase(opened.db,clock,w,caseId,{limit:40});await opened.db.query('UPDATE record_state SET location_id=$2 WHERE proof_id=$1',[movedProof,foreignSite]);await expect(getOperationalCase(opened.db,clock,w,caseId,{section:'proofs',limit:40,cursor:beforeMove.proofPagination.nextCursor})).rejects.toMatchObject({code:'CASE_PROJECTION_CHANGED'});
  const first=await getOperationalCase(opened.db,clock,w,caseId,{limit:40}),seen=new Set(first.case.proofIds);expect(first.case.proofIds).toHaveLength(40);expect(first.case.restrictedMembers).toBe(false);expect(first.proofPagination.hasMore).toBe(true);expect(first.proofPagination.total).toBe(existing+105);
  let cursor=first.proofPagination.nextCursor;
  while(cursor){const page=await getOperationalCase(opened.db,clock,w,caseId,{section:'proofs',limit:40,cursor});expect(page.case.proofIds.length).toBeLessThanOrEqual(40);expect(page.case.restrictedMembers).toBe(false);expect(page.pagination.section).toBe('proofs');for(const id of page.case.proofIds)seen.add(id);cursor=page.proofPagination.nextCursor;}
  expect(seen.size).toBe(existing+105);expect(seen.has(movedProof)).toBe(false);
  const received=await getOperationalCase(opened.db,clock,w,caseId,{limit:40,timelineOrder:'received'}),receivedNext=await getOperationalCase(opened.db,clock,w,caseId,{section:'proofs',limit:40,timelineOrder:'received',cursor:received.proofPagination.nextCursor});expect(receivedNext.case.proofIds).toHaveLength(40);
  await expect(getOperationalCase(opened.db,clock,w,caseId,{section:'assertions',limit:40,cursor:first.proofPagination.nextCursor})).rejects.toMatchObject({code:'INVALID_CURSOR'});
 },60000);
 it('reports an empty permitted Proof membership page explicitly',async()=>{
  const id='empty-proof-membership-case';await opened.db.query("INSERT INTO record_cases(id,organization_id,environment,location_id,location_key,operator_membership_id,root_namespace,root_type,root_external_id,created_at,updated_at) VALUES($1,$2,'sandbox',$3,$3,$4,'empty-proof-fixture','order','EMPTY-PROOFS',$5,$5)",[id,org,site,member,clock.now().toISOString()]);
  const page=await getOperationalCase(opened.db,clock,await workspace(),id,{section:'proofs',limit:25});expect(page.case.proofIds).toEqual([]);expect(page.proofs).toEqual([]);expect(page.case.proofCount).toBe(0);expect(page.case.restrictedMembers).toBe(false);expect(page.proofPagination).toMatchObject({total:0,returnedCount:0,hasMore:false,nextCursor:null});expect(page.pagination.total).toBe(0);
 });
 it('retries measured pending work before cold-case maintenance and keeps offline checks at sixty seconds',async()=>{
  const baseTime=currentTime,w=await workspace(),roots=['RECOVERY-COLD-A','RECOVERY-COLD-B','RECOVERY-AFFECTED'];
  const adapt=(n:TypedSourceObservation,root:string,index:number):TypedSourceObservation=>{const change=(r:TypedSourceObservation['references'][number])=>({...r,...(r.type==='order'?{externalId:root}:r.type==='order_line'?{parentExternalId:root}:['shipment','load'].includes(r.type)?{externalId:`${root}-${r.type}`}:{})});return {...structuredClone(n),sourceEventId:`${root}-${index}`,references:n.references.map(change),assertions:n.assertions.map(a=>({...a,subjectReference:change(a.subjectReference)})),relationships:n.relationships.map(r=>({...r,from:change(r.from),to:change(r.to)}))};};
  const orders=JSON.parse((fixture('order-and-explicit-shipment-allocation').original as {content:string}).content) as TypedSourceObservation[],loading=JSON.parse((fixture('loading-eight-revision-two').original as {content:string}).content) as TypedSourceObservation[];
  const orderRows=roots.flatMap(root=>orders.map((n,i)=>adapt(n,root,i))),loadRows=roots.flatMap(root=>loading.map((n,i)=>adapt(n,root,i+orders.length)));
  const created=await ingest(envelope(orderRows,'orders','packproof.order-lines/v1'),'orders','recovery-orders');await ingest(envelope(loadRows,'loading','packproof.operational-observations/v1'),'loading','recovery-loading');
  const all=(await opened.db.query<{id:string}>('SELECT id FROM record_cases WHERE organization_id=$1 ORDER BY id',[org])).rows.map(r=>r.id);
  for(const id of all){await synchronizeOperationalCaseProjection(opened.db,clock,w,id);await synchronizeOperationalCaseIssues(opened.db,clock,w,id);}
  const affected=(await opened.db.query<{id:string}>("SELECT id FROM record_cases WHERE organization_id=$1 AND root_external_id='RECOVERY-AFFECTED'",[org])).rows[0].id;
  const cold=created.caseIds.filter(id=>id!==affected);expect(cold).toHaveLength(2);
  currentTime+=5000;
  const corrected=adapt(loading[0],'RECOVERY-AFFECTED',orders.length);corrected.sourceRevision='3';corrected.supersedes={sourceEventId:corrected.sourceEventId,sourceRevision:loading[0].sourceRevision};
  await ingest(envelope([corrected],'loading','packproof.operational-observations/v1'),'loading','recovery-affected-correction');
  const pending={...loading[0],sourceEventId:'recovery-pending-other-case',assertions:loading[0].assertions.map(a=>({...a,property:'status',value:'synthetic pending'}))};
  const input={...envelope([pending],'loading','packproof.operational-observations/v1'),grantRevision:Number((await opened.db.query<{grant_revision:number}>('SELECT grant_revision FROM record_source_subscriptions WHERE id=$1',[subscriptions.get('loading')])).rows[0].grant_revision)},preview=await previewTypedImport(deps,actor,input,'recovery-pending-preview');
  await commitTypedImport(deps,actor,preview.value.id,{previewVersion:preview.value.previewVersion,originalSha256:preview.value.original.sha256,importValidRows:false},'recovery-pending-commit');
  await synchronizeOperationalCaseProjection(opened.db,clock,w,affected);await synchronizeOperationalCaseIssues(opened.db,clock,w,affected);
  const pendingState=(await opened.db.query<{source_snapshot:Array<{accounting:{processing:number}}>;summary:{issueCount:number};next_check_at:Date|string}>('SELECT source_snapshot,summary,next_check_at FROM record_case_projection_state WHERE case_id=$1',[affected])).rows[0];
  expect(pendingState.source_snapshot.some(s=>s.accounting.processing>0)).toBe(true);expect(pendingState.summary.issueCount).toBe(0);expect(new Date(pendingState.next_check_at).getTime()-currentTime).toBe(1000);
  expect(new Date((await opened.db.query<{next_check_at:Date|string}>('SELECT next_check_at FROM record_case_rule_state WHERE case_id=$1',[affected])).rows[0].next_check_at).getTime()-currentTime).toBe(1000);
  await processPendingTypedImports(deps,10);await synchronizeOperationalCaseProjection(opened.db,clock,w,caseId);await synchronizeOperationalCaseIssues(opened.db,clock,w,caseId);
  const keep=[...cold,affected],future=new Date(currentTime+86400000).toISOString();await opened.db.query('UPDATE record_case_projection_state SET next_check_at=$2 WHERE NOT(case_id=ANY($1::text[]))',[keep,future]);await opened.db.query('UPDATE record_case_rule_state SET next_check_at=$2 WHERE NOT(case_id=ANY($1::text[]))',[keep,future]);
  currentTime=baseTime+6000;
  for(const worker of [processPendingCaseProjections,processPendingReconstructionIssues]){
   expect(await worker(opened.db,clock,1)).toMatchObject({processed:1,blocked:0});
   const table=worker===processPendingCaseProjections?'record_case_projection_state':'record_case_rule_state',field=worker===processPendingCaseProjections?'created_at':'checked_at';
   const refreshed=(await opened.db.query<{case_id:string}>(`SELECT case_id FROM ${table} WHERE case_id=ANY($1::text[]) AND ${field}=$2`,[keep,clock.now().toISOString()])).rows.map(r=>r.case_id);
   expect(refreshed).toEqual([affected]);
  }
  expect((await getOperationalCase(opened.db,clock,w,affected)).case.issueCount).toBe(1);
  const issues=await listOperationalCaseIssues(opened.db,clock,w,affected);expect(issues.issues.filter(i=>i.category==='quantity_disagreement').map(i=>i.evaluation?.outcome)).toEqual(['different']);
  await check('loading','source_unreadable');await synchronizeOperationalCaseProjection(opened.db,clock,w,affected);await synchronizeOperationalCaseIssues(opened.db,clock,w,affected);
  const offline=(await opened.db.query<{source_snapshot:Array<{state:string;accounting:{processing:number}}>;next_check_at:Date|string}>('SELECT source_snapshot,next_check_at FROM record_case_projection_state WHERE case_id=$1',[affected])).rows[0];expect(offline.source_snapshot.some(s=>s.state==='offline'&&s.accounting.processing===0)).toBe(true);expect(new Date(offline.next_check_at).getTime()-currentTime).toBe(60000);
  expect(new Date((await opened.db.query<{next_check_at:Date|string}>('SELECT next_check_at FROM record_case_rule_state WHERE case_id=$1',[affected])).rows[0].next_check_at).getTime()-currentTime).toBe(60000);await check('loading');
  for(const id of all){await synchronizeOperationalCaseProjection(opened.db,clock,w,id);await synchronizeOperationalCaseIssues(opened.db,clock,w,id);}
 },60000);
 it('retries a first issue pass after source counters become available without requiring an existing issue',async()=>{
  const w=await workspace();for(const row of (await opened.db.query<{id:string}>('SELECT id FROM record_cases WHERE organization_id=$1',[org])).rows){await synchronizeOperationalCaseProjection(opened.db,clock,w,row.id);await synchronizeOperationalCaseIssues(opened.db,clock,w,row.id);}
  await source('counter-orders','packproof.order-lines/v1');await source('counter-loading','packproof.operational-observations/v1');
  const adapt=(name:string)=>{const rows=JSON.parse((fixture(name).original as {content:string}).content.replaceAll('0010482','RECOVERY-COUNTER').replaceAll('S-0021','RECOVERY-COUNTER-SHIP')) as TypedSourceObservation[];return rows.map(n=>({...n,sourceEventId:`counter-${n.sourceEventId}`}));};
  const orders=await ingest(envelope(adapt('order-and-explicit-shipment-allocation'),'counter-orders','packproof.order-lines/v1'),'counter-orders','counter-orders');await activate('counter-orders',orders.id);
  const loaded=await ingest(envelope(adapt('loading-eight-revision-two'),'counter-loading','packproof.operational-observations/v1'),'counter-loading','counter-loading');await activate('counter-loading',loaded.id);
  const id=orders.caseIds[0];expect((await readProjectionSourceCounter(opened.db,subscriptions.get('counter-loading')!)).ready).toBe(false);
  await synchronizeOperationalCaseIssues(opened.db,clock,w,id);expect((await listOperationalCaseIssues(opened.db,clock,w,id)).total).toBe(0);
  await synchronizeOperationalCaseProjection(opened.db,clock,w,id);expect((await getOperationalCase(opened.db,clock,w,id)).case.issueCount).toBe(1);currentTime+=1000;
  expect(await processPendingReconstructionIssues(opened.db,clock,1)).toEqual({processed:1,blocked:0});
  expect((await listOperationalCaseIssues(opened.db,clock,w,id)).issues.filter(i=>i.category==='quantity_disagreement').map(i=>i.evaluation?.outcome)).toEqual(['different']);
 },60000);
 it.each([true,false])('evaluates newly qualified inputs without a case revision or existing issue (paged=%s)',async(paged)=>{
  vi.stubEnv('PACKPROOF_PAGED_PROJECTIONS_ENABLED',String(paged));
  try{
  const w=await workspace();for(const row of (await opened.db.query<{id:string}>('SELECT id FROM record_cases WHERE organization_id=$1',[org])).rows){await synchronizeOperationalCaseProjection(opened.db,clock,w,row.id);await synchronizeOperationalCaseIssues(opened.db,clock,w,row.id);}
  const kind=paged?'paged':'legacy',orderSource=`qualification-orders-${kind}`,loadingSource=`qualification-loading-${kind}`,root=`QUALIFICATION-${kind.toUpperCase()}-FIRST-ISSUE`;
  await source(orderSource,'packproof.order-lines/v1');await source(loadingSource,'packproof.operational-observations/v1');
  const adapt=(name:string)=>{const rows=JSON.parse((fixture(name).original as {content:string}).content.replaceAll('0010482',root).replaceAll('S-0021',`${root}-SHIP`)) as TypedSourceObservation[];return rows.map(n=>({...n,sourceEventId:`qualification-${kind}-${n.sourceEventId}`}));};
  const orders=await ingest(envelope(adapt('order-and-explicit-shipment-allocation'),orderSource,'packproof.order-lines/v1'),orderSource,orderSource),loaded=await ingest(envelope(adapt('loading-eight-revision-two'),loadingSource,'packproof.operational-observations/v1'),loadingSource,loadingSource);
  // Recurring collection is approved, but no checked source boundary has been
  // reported yet. Neither a quantity finding nor a coverage warning is qualified.
  for(const [name,batchId] of [[orderSource,orders.id],[loadingSource,loaded.id]])await opened.db.transaction(tx=>actOnSourceSubscription(tx,clock,w,subscriptions.get(name)!,{action:'activate',configurationRevision:1,recurringConsent:true,initialBatchId:batchId},`activate-unchecked-${name}`));
  const id=orders.caseIds[0];await synchronizeOperationalCaseProjection(opened.db,clock,w,id);await synchronizeOperationalCaseIssues(opened.db,clock,w,id);
  const before=await getOperationalCase(opened.db,clock,w,id);expect(before.case.issueCount).toBe(0);expect(before.sources.every(s=>s.coverage==='unknown')).toBe(true);expect((await listOperationalCaseIssues(opened.db,clock,w,id)).total).toBe(0);
  const prior=(await opened.db.query<{case_revision:number|string;projection_version:string;next_check_at:Date|string;checked_at:Date|string}>('SELECT case_revision,projection_version,next_check_at,checked_at FROM record_case_rule_state WHERE case_id=$1',[id])).rows[0];expect(new Date(prior.next_check_at).getTime()-new Date(prior.checked_at).getTime()).toBe(60000);
  currentTime+=paged?1000:60000;await check(orderSource);await check(loadingSource);await synchronizeOperationalCaseProjection(opened.db,clock,w,id);
  const qualified=await getOperationalCase(opened.db,clock,w,id);expect(qualified.case.revision).toBe(before.case.revision);expect(qualified.projectionVersion).not.toBe(before.projectionVersion);expect(qualified.case.issueCount).toBe(1);expect(qualified.comparisons.map(c=>c.outcome)).toEqual(['different']);expect((await listOperationalCaseIssues(opened.db,clock,w,id)).total).toBe(0);
  await opened.db.query('UPDATE record_case_rule_state SET next_check_at=$2 WHERE case_id<>$1',[id,new Date(currentTime+86400000).toISOString()]);
  expect(await processPendingReconstructionIssues(opened.db,clock,1)).toEqual({processed:1,blocked:0});
  expect((await listOperationalCaseIssues(opened.db,clock,w,id)).issues.filter(i=>i.category==='quantity_disagreement').map(i=>i.evaluation?.outcome)).toEqual(['different']);
  }finally{vi.stubEnv('PACKPROOF_PAGED_PROJECTIONS_ENABLED','true');}
 },60000);
 it('rebuilds retained source records under current operator authority after ingestion credentials expire',async()=>{
  await opened.db.query('UPDATE platform_credentials SET revoked_at=$2 WHERE id=$1',[actor.credentialId,clock.now().toISOString()]);currentTime+=61000;
  const rebuilt=await processPendingCaseProjections(opened.db,clock,10);expect(rebuilt.processed).toBeGreaterThanOrEqual(1);expect(rebuilt.blocked).toBe(0);
  const detail=await getOperationalCase(opened.db,clock,await workspace(),caseId,{limit:100});expect(detail.projectionStatus.state).toBe('ready');expect(detail.sources.every(s=>s.state==='offline'||s.state==='paused')).toBe(true);expect(detail.comparisons.every(c=>c.outcome==='not_comparable'||c.outcome==='suppressed')).toBe(true);
  const w=await workspace();await opened.db.query('UPDATE platform_memberships SET revoked_at=$2 WHERE id=$1',[member,clock.now().toISOString()]);await expect(getOperationalCase(opened.db,clock,w,caseId)).rejects.toMatchObject({httpStatus:404});
 },60000);
});
