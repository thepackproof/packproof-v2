import {afterAll,beforeAll,describe,expect,it,vi} from 'vitest';
import {mkdtemp,rm} from 'node:fs/promises';
import {randomBytes} from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import {openIsolatedTestDatabase} from './isolated-test-database.js';
import {migrate} from '../src/db/migrate.js';
import type {Database} from '../src/db/database.js';
import {insertUser} from '../src/domain/users.js';
import {createOrganization,setOrganizationEntitlement,createServicePrincipal,issuePartnerCredential,createIntegrationAccount,authenticatePartner,PARTNER_SCOPES,type PartnerActor} from '../src/platform/organizations.js';
import {LocalObjectStore} from '../src/s3/local-object-store.js';
import {requireRecordWorkspace} from '../src/records/access.js';
import {proposeSourceSubscription,actOnSourceSubscription} from '../src/records/source-subscriptions.js';
import {previewTypedImport,commitTypedImport,processPendingTypedImports,readTypedImport,type TypedImportDeps} from '../src/records/typed-imports.js';
import {getOperationalCase} from '../src/records/reconstruction.js';
import type {TypedSourceObservation} from '../src/records/source-contracts.js';
import {sha256Hex} from '../src/hash.js';

type Order='operational'|'received';
type Spec={label:string;occurredAt:string|null;sourceAsOf?:string|null;received?:number;sourceEventId?:string;sourceRevision?:string;supersedes?:TypedSourceObservation['supersedes']};
type Receipt={id:string;label:string;normalized:TypedSourceObservation;receivedAt:string};
const stamp=(hour:number)=>`2026-11-12T${String(hour).padStart(2,'0')}:00:00Z`;
const millis=(value:string|null)=>value===null?null:Date.parse(value);
const operationalTime=(n:TypedSourceObservation)=>millis(n.occurredAt??n.sourceAsOf);
const compareId=(a:string,b:string)=>a<b?-1:a>b?1:0;

describe('paged timeline baseline with admitted source receipts',()=>{
 let opened:Awaited<ReturnType<typeof openIsolatedTestDatabase>>,dir:string,deps:TypedImportDeps,actor:PartnerActor;
 let readerWorkspace:Awaited<ReturnType<typeof requireRecordWorkspace>>;
 let owner:string,org:string,member:string,account:string,subscription:string,active=false,sequence=0;
 let currentTime=Date.parse('2026-11-14T12:00:00Z');
 const clock={now:()=>new Date(currentTime)},site='timeline-page-site',namespace='timeline-page-source';
 const workspace=()=>requireRecordWorkspace(opened.db,owner,org,'sandbox');
 const page=(db:Database,id:string,order:Order,limit=100,cursor?:string)=>getOperationalCase(db,clock,readerWorkspace,id,{section:'timeline',timelineOrder:order,limit,...(cursor?{cursor}:{})});

 beforeAll(async()=>{
  for(const flag of ['PACKPROOF_ORGANIZATIONS_ENABLED','PACKPROOF_TYPED_INTAKE_ENABLED','PACKPROOF_SOURCE_SUBSCRIPTIONS_ENABLED','PACKPROOF_CASE_RECONSTRUCTION_ENABLED','PACKPROOF_PAGED_PROJECTIONS_ENABLED'])vi.stubEnv(flag,'true');
  // This suite concerns authoritative history pages, not worker findings or feed readiness.
  for(const flag of ['PACKPROOF_SOURCE_HEALTH_ENABLED','PACKPROOF_RECONSTRUCTION_RULES_ENABLED','PACKPROOF_CROSS_CASE_ENABLED'])vi.stubEnv(flag,'false');
  vi.stubEnv('PACKPROOF_EVENT_CURSOR_KEY',randomBytes(32).toString('base64'));
  opened=await openIsolatedTestDatabase();await migrate(opened.db);
  dir=await mkdtemp(path.join(os.tmpdir(),'timeline-pages-'));
  deps={db:opened.db,clock,objectStore:new LocalObjectStore(path.join(dir,'objects'),'http://localhost','timeline-pages-test'),devAuth:true};
  const admin=await insertUser(opened.db,clock);owner=await insertUser(opened.db,clock);
  await opened.db.query("INSERT INTO user_verified_contacts(user_id,email_normalized,verified_at,source) VALUES($1,'nericollin@gmail.com',$2,'COGNITO')",[admin,clock.now().toISOString()]);
  org=(await createOrganization(opened.db,clock,admin,{kind:'MERCHANT',name:'Synthetic timeline warehouse',ownerUserId:owner},'timeline-fixture')).id;
  await setOrganizationEntitlement(opened.db,clock,admin,org,{enabled:true},'timeline-fixture');
  member=(await opened.db.query<{id:string}>('SELECT id FROM platform_memberships WHERE organization_id=$1 AND user_id=$2',[org,owner])).rows[0].id;
  const principal=await createServicePrincipal(opened.db,clock,owner,org,{name:'Timeline source'},'timeline-fixture');
  const credential=await issuePartnerCredential(opened.db,clock,owner,org,principal.id,{scopes:[...PARTNER_SCOPES],expiresAt:'2026-11-30T12:00:00Z'},'timeline-fixture');
  actor=await authenticatePartner(opened.db,clock,`Bearer ${credential.token}`,org,undefined,'timeline-fixture');
  account=(await createIntegrationAccount(opened.db,clock,owner,org,{provider:'synthetic-timeline',externalAccountId:'timeline-only'},'timeline-fixture')).id;
  await opened.db.query('INSERT INTO record_locations(id,organization_id,name,created_at) VALUES($1,$2,$3,$4)',[site,org,'Synthetic timeline site',clock.now().toISOString()]);
  const w=await workspace();readerWorkspace=w;
  const proposed=await opened.db.transaction(tx=>proposeSourceSubscription(tx,clock,w,{connectionId:account,principalId:actor.principalId,operatorMembershipId:member,locationId:site,installationId:null,config:{transport:'partner_api',displayName:'Synthetic timeline order export',sourceProfile:'packproof.order-lines/v1',mappingVersion:'timeline-fixture/1',sourceNamespace:namespace,mapping:{},constants:{},wholeFileConsent:true,folderDigest:null,initialFileName:null,initialOriginalSha256:null,expectedHeaders:[],historyFrom:'2026-11-01T00:00:00Z',historyTo:null,unknownTimePolicy:'retain_unknown',maxBytes:2097152,maxRows:1000,offlineWindowHours:24,expectedIntervalSeconds:null,completenessPolicy:{kind:'unknown',scope:'shipment_line',sourceOwnerQualified:false,qualificationReference:null}}},'timeline-source'));
  subscription=proposed.id;
  await opened.db.transaction(tx=>actOnSourceSubscription(tx,clock,w,subscription,{action:'approve',configurationRevision:1,configurationSha256:proposed.configurationSha256,wholeFileConsent:true},'approve-timeline-source'));
 },60000);
 afterAll(async()=>{await opened?.close();if(dir)await rm(dir,{recursive:true,force:true});vi.unstubAllEnvs();});

 async function makeCase(name:string,specs:Spec[]){
  const orderId=`TIMELINE-${name}-${++sequence}`,order={namespace,type:'order' as const,externalId:orderId},line={namespace,type:'order_line' as const,externalId:'004',parentExternalId:orderId};
  const receipts:Receipt[]=[];let caseId='';
  for(const received of [...new Set(specs.map(s=>s.received??0))].sort((a,b)=>a-b)){
   currentTime+=1000;
   const group=specs.filter(s=>(s.received??0)===received),rows:TypedSourceObservation[]=group.map(s=>({sourceEventId:s.sourceEventId??`${orderId}-${s.label}`,sourceRevision:s.sourceRevision??'1',observationKind:s.supersedes?'correction':'snapshot',occurredAt:s.occurredAt,sourceAsOf:s.sourceAsOf??null,timeQuality:s.occurredAt?'event_time':s.sourceAsOf?'snapshot_time_only':'unknown',references:[order,line],assertions:[{subjectReference:line,property:'orderedQuantity',value:{amount:'10',unit:'each'},sourceLocator:{row:1,field:'quantity'},assurance:'source_reported'},{subjectReference:line,property:'description',value:s.label,sourceLocator:{row:1,field:'description'},assurance:'source_reported'},{subjectReference:line,property:'status',value:'reported',sourceLocator:{row:1,field:'status'},assurance:'source_reported'}],relationships:[{from:order,to:line,type:'has_line',quantity:null}],supersedes:s.supersedes??null,originSystem:'Synthetic timeline fixture',copiedFromSource:null}));
   const content=JSON.stringify(rows),grant=(await opened.db.query<{grant_revision:number}>('SELECT grant_revision FROM record_source_subscriptions WHERE id=$1',[subscription])).rows[0].grant_revision;
   const input={schema:'packproof.typed-source-batch/v1',connectionId:account,locationId:site,subscriptionId:subscription,configurationRevision:1,grantRevision:Number(grant),sourceProfile:'packproof.order-lines/v1',mappingVersion:'timeline-fixture/1',sourceNamespace:namespace,wholeFileConsent:true,original:{name:'synthetic-timeline.json',mediaType:'application/json',content,sha256:sha256Hex(content)},mapping:{},constants:{},completeness:{kind:'unknown',asOf:null,marker:null}};
   const key=`timeline-${sequence}-${received}`,preview=await previewTypedImport(deps,actor,input,`preview-${key}`);
   expect(preview.value.rows.map(r=>r.errors)).toEqual(group.map(()=>[]));
   await commitTypedImport(deps,actor,preview.value.id,{previewVersion:preview.value.previewVersion,originalSha256:preview.value.original.sha256,importValidRows:false},`commit-${key}`);
   expect((await processPendingTypedImports(deps,10)).blocked).toBe(0);
   const done=await readTypedImport(deps,actor,preview.value.id);expect(done.counts.acceptedLinked).toBe(group.length);expect(done.caseIds).toHaveLength(1);caseId=done.caseIds[0];
   for(const row of (await opened.db.query<{id:string;row_number:number;normalized:TypedSourceObservation;received_at:Date|string}>('SELECT id,row_number,normalized,received_at FROM record_typed_rows WHERE batch_id=$1 ORDER BY row_number',[done.id])).rows)receipts.push({id:row.id,label:group[row.row_number-1].label,normalized:row.normalized,receivedAt:new Date(row.received_at).toISOString()});
   if(!active){await opened.db.transaction(tx=>actOnSourceSubscription(tx,clock,readerWorkspace,subscription,{action:'activate',configurationRevision:1,recurringConsent:true,initialBatchId:done.id},'activate-timeline-source'));active=true;}
  }
  return {caseId,receipts,byLabel:Object.fromEntries(receipts.map(r=>[r.label,r]))};
 }

 async function retained(work:(tx:Database)=>Promise<void>){
  // Administrative retained-state fixtures are confined to a rollback in this
  // suite's isolated migrated database. They are not source-admission examples.
  const rollback=new Error('rollback retained timeline fixture');
  await expect(opened.db.transaction(async tx=>{await work(tx);throw rollback;})).rejects.toBe(rollback);
 }
 async function project(tx:Database,caseId:string,row:Receipt,change:Partial<TypedSourceObservation>={},options:{state?:'linked'|'removed';assertionIds?:string[]}={}){
  const prior=(await tx.query<{id:string}>('SELECT p.id FROM record_case_row_projections p WHERE p.observation_id=$1 AND p.case_id=$2 AND NOT EXISTS(SELECT 1 FROM record_case_row_projections s WHERE s.supersedes_id=p.id)',[row.id,caseId])).rows[0];
  const assertions=(await tx.query<{id:string}>('SELECT id FROM record_case_assertions WHERE observation_id=$1 AND case_id=$2 ORDER BY id',[row.id,caseId])).rows.map(r=>r.id);
  const relationships=(await tx.query<{id:string}>('SELECT id FROM record_case_relations WHERE assertion_row_id=$1 AND case_id=$2 ORDER BY id',[row.id,caseId])).rows.map(r=>r.id);
  await tx.query(`INSERT INTO record_case_row_projections(id,observation_id,case_id,organization_id,environment,location_id,operator_membership_id,state,normalized,assertion_indexes,relationship_indexes,assertion_ids,relationship_ids,basis,supersedes_id,created_at) VALUES($1,$2,$3,$4,'sandbox',$5,$6,$7,$8::jsonb,'[]'::jsonb,'[]'::jsonb,$9::jsonb,$10::jsonb,'{"kind":"retained-reader-fixture"}'::jsonb,$11,$12)`,[`timeline-projection-${++sequence}`,row.id,caseId,org,site,member,options.state??'linked',JSON.stringify({...row.normalized,...change}),JSON.stringify(options.assertionIds??assertions),JSON.stringify(relationships),prior?.id??null,clock.now().toISOString()]);
 }

 it.each<Order>(['operational','received'])('traverses complete %s history with signed nonzero offsets and keeps other sections on page one',async order=>{
  const fixture=await makeCase(`traverse-${order}`,[{label:'high',occurredAt:stamp(20)},{label:'low',occurredAt:stamp(5),received:1},{label:'equal-a',occurredAt:stamp(10),received:1},{label:'unknown',occurredAt:null,received:2},{label:'equal-offset',occurredAt:'2026-11-12T12:00:00+02:00',received:3},{label:'occurred-first',occurredAt:stamp(6),sourceAsOf:stamp(23),received:4},{label:'snapshot-only',occurredAt:null,sourceAsOf:stamp(7),received:5}]);
  const expected=[...fixture.receipts].sort((a,b)=>order==='received'?Date.parse(a.receivedAt)-Date.parse(b.receivedAt)||compareId(a.id,b.id):(operationalTime(a.normalized)??Infinity)-(operationalTime(b.normalized)??Infinity)||compareId(a.id,b.id));
  const first=await page(opened.db,fixture.caseId,order,2),seen:string[]=[],offsets:number[]=[];
  let current=first;
  do{
   expect(current.pagination).toMatchObject({section:'timeline',limit:2,total:7,returnedCount:current.timeline.length});
   expect(current.assertions.map(a=>a.id)).toEqual(first.assertions.map(a=>a.id));
   expect(current.relationships.map(r=>r.id)).toEqual(first.relationships.map(r=>r.id));
   seen.push(...current.timeline.map(r=>r.id));
   const cursor=current.pagination.nextCursor;if(!cursor)break;
   offsets.push(JSON.parse(Buffer.from(cursor.split('.')[0],'base64url').toString('utf8')).position.offset);
   current=await page(opened.db,fixture.caseId,order,2,cursor);
  }while(true);
  expect(offsets).toEqual([2,4,6]);expect(seen).toEqual(expected.map(r=>r.id));expect(new Set(seen).size).toBe(7);
  const last=current.timeline.at(-1)!;expect(current.pagination.hasMore).toBe(false);
  if(order==='operational')expect(last).toMatchObject({id:fixture.byLabel.unknown.id,reportedAt:null,sourceAsOf:null,timeBasis:'unknown',late:false});
  const assertionsFirst=await getOperationalCase(opened.db,clock,readerWorkspace,fixture.caseId,{section:'assertions',timelineOrder:order,limit:2});
  expect(JSON.parse(Buffer.from(assertionsFirst.pagination.nextCursor!.split('.')[0],'base64url').toString('utf8')).position.offset).toBe(2);
  const assertionsNext=await getOperationalCase(opened.db,clock,readerWorkspace,fixture.caseId,{section:'assertions',timelineOrder:order,limit:2,cursor:assertionsFirst.pagination.nextCursor});
  expect(assertionsNext.assertions.map(a=>a.id)).not.toEqual(assertionsFirst.assertions.map(a=>a.id));
  expect(assertionsNext.timeline).toEqual(first.timeline);
 });

 it('rejects cursor order, limit, section, signature and changed case revision',async()=>{
  const fixture=await makeCase('cursor',[{label:'a',occurredAt:stamp(1)},{label:'b',occurredAt:stamp(2)},{label:'c',occurredAt:stamp(3)}]),first=await page(opened.db,fixture.caseId,'received',1),cursor=first.pagination.nextCursor!;
  expect(cursor).toMatch(/^[^.]+\.[^.]+$/);
  for(const change of [{timelineOrder:'operational'},{limit:2},{section:'assertions'}])await expect(getOperationalCase(opened.db,clock,await workspace(),fixture.caseId,{section:'timeline',timelineOrder:'received',limit:1,cursor,...change})).rejects.toMatchObject({code:'INVALID_CURSOR'});
  const [body,signature]=cursor.split('.'),tampered=`${body}.${signature[0]==='A'?'B':'A'}${signature.slice(1)}`;
  await expect(page(opened.db,fixture.caseId,'received',1,tampered)).rejects.toMatchObject({code:'INVALID_CURSOR'});
  await retained(async tx=>{await tx.query('UPDATE record_cases SET revision=revision+1 WHERE id=$1',[fixture.caseId]);await expect(page(tx,fixture.caseId,'received',1,cursor)).rejects.toMatchObject({code:'CASE_PROJECTION_CHANGED'});});
 });

 it.each([{kind:'event',raw:20,projected:5,late:true},{kind:'event',raw:5,projected:20,late:false},{kind:'snapshot',raw:20,projected:5,late:true},{kind:'snapshot',raw:5,projected:20,late:false}])('compares earlier raw $kind time $raw against current time, despite projected $projected',async example=>{
  const snapshot=example.kind==='snapshot',fixture=await makeCase(`asymmetry-${example.kind}-${example.raw}`,[{label:'earlier',occurredAt:snapshot?null:stamp(example.raw),sourceAsOf:snapshot?stamp(example.raw):null},{label:'current',occurredAt:snapshot?null:stamp(10),sourceAsOf:snapshot?stamp(10):null,received:1}]);
  await retained(async tx=>{
   await project(tx,fixture.caseId,fixture.byLabel.earlier,{occurredAt:snapshot?null:stamp(example.projected),sourceAsOf:snapshot?stamp(example.projected):null});
   for(const order of ['operational','received'] as const){const result=await page(tx,fixture.caseId,order);expect(result.timeline.find(r=>r.id===fixture.byLabel.current.id)?.late).toBe(example.late);expect(result.timeline.find(r=>r.id===fixture.byLabel.earlier.id)).toMatchObject(snapshot?{sourceAsOf:new Date(stamp(example.projected)).toISOString(),timeBasis:'snapshot_as_of',late:false}:{reportedAt:new Date(stamp(example.projected)).toISOString(),timeBasis:'event_time',late:false});}
  });
 });

 it('includes a linked current partition with a null legacy pointer and uses its projected sourceAsOf',async()=>{
  const fixture=await makeCase('null-legacy',[{label:'earlier',occurredAt:null,sourceAsOf:stamp(20)},{label:'current',occurredAt:null,sourceAsOf:stamp(22),received:1}]);
  await retained(async tx=>{
   await project(tx,fixture.caseId,fixture.byLabel.current,{sourceAsOf:stamp(10)});
   await tx.query("UPDATE record_typed_rows SET status='accepted_unlinked',case_id=NULL WHERE id=$1",[fixture.byLabel.current.id]);
   for(const order of ['operational','received'] as const){const result=await page(tx,fixture.caseId,order);expect(result.totals.timeline).toBe(2);expect(result.timeline.find(r=>r.id===fixture.byLabel.current.id)).toMatchObject({sourceAsOf:new Date(stamp(10)).toISOString(),timeBasis:'snapshot_as_of',late:true,active:true});}
  });
 });

 it('prioritizes occurredAt over sourceAsOf on both sides of the lateness comparison',async()=>{
  for(const [earlier,current,late] of [[5,10,false],[10,5,true]] as const){
   const fixture=await makeCase(`occurred-priority-${earlier}`,[{label:'earlier',occurredAt:stamp(earlier),sourceAsOf:stamp(23)},{label:'current',occurredAt:stamp(current),sourceAsOf:stamp(22),received:1}]);
   for(const order of ['operational','received'] as const){const result=await page(opened.db,fixture.caseId,order);expect(result.timeline.find(r=>r.id===fixture.byLabel.current.id)).toMatchObject({reportedAt:new Date(stamp(current)).toISOString(),sourceAsOf:new Date(stamp(22)).toISOString(),timeBasis:'event_time',late});}
  }
 });

 it('handles equal offset instants, null times, and receipt timestamp ties with strict ID ordering',async()=>{
  const fixture=await makeCase('time-ties',[{label:'utc',occurredAt:stamp(10)},{label:'offset',occurredAt:'2026-11-12T12:00:00+02:00'},{label:'unknown',occurredAt:null},{label:'low',occurredAt:stamp(5)}]);
  const received=[...fixture.receipts].sort((a,b)=>compareId(a.id,b.id)),result=await page(opened.db,fixture.caseId,'received');
  expect(new Set(fixture.receipts.map(r=>r.receivedAt)).size).toBe(1);expect(result.timeline.map(r=>r.id)).toEqual(received.map(r=>r.id));
  for(const row of result.timeline){const current=fixture.receipts.find(r=>r.id===row.id)!,time=operationalTime(current.normalized);expect(row.late).toBe(time!==null&&received.some(prior=>compareId(prior.id,current.id)<0&&(operationalTime(prior.normalized)??-Infinity)>time));}
  expect(result.timeline.find(r=>r.id===fixture.byLabel.utc.id)?.late).toBe(false);expect(result.timeline.find(r=>r.id===fixture.byLabel.offset.id)?.late).toBe(false);expect(result.timeline.find(r=>r.id===fixture.byLabel.unknown.id)?.late).toBe(false);
  const operational=await page(opened.db,fixture.caseId,'operational');expect(operational.timeline.map(r=>r.id)).toEqual([fixture.byLabel.low.id,...[fixture.byLabel.utc.id,fixture.byLabel.offset.id].sort(compareId),fixture.byLabel.unknown.id]);
  await retained(async tx=>{
   // Choose IDs after admission so this exercises the strict receipt-ID tie
   // regardless of the random suffixes generated for the actual source rows.
   await project(tx,fixture.caseId,received[0],{occurredAt:stamp(1),sourceAsOf:null,timeQuality:'event_time'});
   await project(tx,fixture.caseId,received.at(-1)!,{occurredAt:stamp(1),sourceAsOf:null,timeQuality:'event_time'});
   for(const order of ['operational','received'] as const){const tied=await page(tx,fixture.caseId,order);expect(tied.timeline.find(r=>r.id===received[0].id)?.late).toBe(false);expect(tied.timeline.find(r=>r.id===received.at(-1)!.id)?.late).toBe(true);}
  });
 });

 it('retains superseded source history and lets its raw time establish a late correction',async()=>{
  const event=`timeline-correction-${++sequence}`,fixture=await makeCase('superseded',[{label:'old',occurredAt:stamp(20),sourceEventId:event},{label:'new',occurredAt:stamp(10),sourceEventId:event,sourceRevision:'2',supersedes:{sourceEventId:event,sourceRevision:'1'},received:1}]);
  for(const order of ['operational','received'] as const){const result=await page(opened.db,fixture.caseId,order,1),next=await page(opened.db,fixture.caseId,order,1,result.pagination.nextCursor!);expect([...result.timeline,...next.timeline].map(r=>[r.id,r.active,r.late]).sort()).toEqual([[fixture.byLabel.old.id,false,false],[fixture.byLabel.new.id,true,true]].sort());expect(result.totals.timeline).toBe(2);}
 });

 it('excludes removed and other-case allocations before ordering, totals and lateness',async()=>{
  const fixture=await makeCase('allocation-heads',[{label:'removed',occurredAt:stamp(23)},{label:'elsewhere',occurredAt:stamp(22)},{label:'current',occurredAt:stamp(10),received:1}]),other=await makeCase('allocation-target',[{label:'target',occurredAt:stamp(1)}]);
  await retained(async tx=>{
   await project(tx,fixture.caseId,fixture.byLabel.removed);await project(tx,fixture.caseId,fixture.byLabel.removed,{}, {state:'removed'});
   await project(tx,other.caseId,fixture.byLabel.elsewhere);await tx.query('UPDATE record_typed_rows SET case_id=$2 WHERE id=$1',[fixture.byLabel.elsewhere.id,other.caseId]);
   for(const order of ['operational','received'] as const){const result=await page(tx,fixture.caseId,order,1);expect(result.timeline).toMatchObject([{id:fixture.byLabel.current.id,late:false}]);expect(result.totals.timeline).toBe(1);expect(result.pagination.hasMore).toBe(false);expect(result.assertions.every(a=>a.source.observationId===fixture.byLabel.current.id)).toBe(true);}
  });
 });

 it('excludes retained heads whose original batch no longer matches the current case site',async()=>{
  const fixture=await makeCase('foreign-site',[{label:'old-site',occurredAt:stamp(23)}]);
  await retained(async tx=>{
   const foreign='timeline-current-other-site';await tx.query('INSERT INTO record_locations(id,organization_id,name,created_at) VALUES($1,$2,$3,$4)',[foreign,org,'Other current site',clock.now().toISOString()]);
   await project(tx,fixture.caseId,fixture.byLabel['old-site']);await tx.query('UPDATE record_cases SET location_id=$2,location_key=$2 WHERE id=$1',[fixture.caseId,foreign]);
   for(const order of ['operational','received'] as const){const result=await page(tx,fixture.caseId,order);expect(result.timeline).toEqual([]);expect(result.assertions).toEqual([]);expect(result.totals.timeline).toBe(0);expect(result.totals.assertions).toBe(0);}
  });
 });

 it('returns sorted existing eligible assertion IDs instead of trusting a stale projection JSON list',async()=>{
  const fixture=await makeCase('assertion-ids',[{label:'row',occurredAt:stamp(10)}]),row=fixture.byLabel.row;
  await retained(async tx=>{
   const ids=(await tx.query<{id:string}>('SELECT id FROM record_case_assertions WHERE observation_id=$1 ORDER BY id',[row.id])).rows.map(r=>r.id);expect(ids).toHaveLength(3);
   await project(tx,fixture.caseId,row,{}, {assertionIds:[ids[2],'assertion-retained-missing',ids[0],ids[0]]});
   for(const order of ['operational','received'] as const){const result=await page(tx,fixture.caseId,order);expect(result.timeline[0].assertionIds).toEqual([ids[0],ids[2]]);expect(result.assertions.map(a=>a.id).sort(compareId)).toEqual([ids[0],ids[2]]);expect(result.totals.assertions).toBe(2);}
  });
 });

 it.each<Order>(['received','operational'])('keeps the early %s page readable when only a later raw timestamp is malformed',async order=>{
  const fixture=await makeCase(`malformed-${order}`,[{label:'early',occurredAt:stamp(10)},{label:'later',occurredAt:stamp(23),received:1},{label:'subsequent',occurredAt:stamp(22),received:2}]);
  await retained(async tx=>{
   // Admission rejects malformed timestamps. Simulate an older retained corrupt
   // row only under the isolated owner and rollback; never relax production casts.
   await project(tx,fixture.caseId,fixture.byLabel.later,{occurredAt:stamp(23)});
   await tx.query('ALTER TABLE record_typed_rows DISABLE TRIGGER record_typed_row_origin');
   await tx.query("UPDATE record_typed_rows SET normalized=jsonb_set(normalized,'{occurredAt}',to_jsonb('not-a-timestamp'::text)) WHERE id=$1",[fixture.byLabel.later.id]);
   await tx.query('ALTER TABLE record_typed_rows ENABLE TRIGGER record_typed_row_origin');
   const result=await page(tx,fixture.caseId,order,1);expect(result.timeline).toMatchObject([{id:fixture.byLabel.early.id,late:false}]);expect(result.totals.timeline).toBe(3);expect(result.pagination.hasMore).toBe(true);expect(result.pagination.nextCursor).toBeTypeOf('string');
   let cursor=result.pagination.nextCursor!;
   if(order==='received'){
    const second=await page(tx,fixture.caseId,order,1,cursor);expect(second.timeline).toMatchObject([{id:fixture.byLabel.later.id,late:false}]);cursor=second.pagination.nextCursor!;
   }
   // The subsequent source row sorts second operationally and third by receipt.
   // It must read the corrupt earlier raw time: retain the database cast error,
   // rather than silently treating malformed history as unknown or non-late.
   await expect(page(tx,fixture.caseId,order,1,cursor)).rejects.toMatchObject({code:'22007'});
  });
 });
});
