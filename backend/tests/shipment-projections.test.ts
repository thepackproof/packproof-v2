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
import {previewTypedImport,commitTypedImport,readTypedImport,processPendingTypedImports,authorizeRetainedTypedImport,type TypedImportDeps,type TypedBatchRow} from '../src/records/typed-imports.js';
import {attachQualifiedShipmentProofs,caseObservationSupersededSql} from '../src/records/cases.js';
import {enqueueShipmentProjectionWork,processPendingShipmentProjections} from '../src/records/shipment-projections.js';
import {caseReceiptAffectsSql} from '../src/records/case-receipt-dependencies.js';
import type {TypedSourceObservation,TypedSourceReference} from '../src/records/source-contracts.js';
import {sha256Hex} from '../src/hash.js';

describe('bounded durable legacy shipment projection work',()=>{
 let opened:Awaited<ReturnType<typeof openIsolatedTestDatabase>>,dir:string,deps:TypedImportDeps,actor:PartnerActor;
 let owner:string,org:string,member:string,account:string,sequence=0,currentTime=Date.parse('2026-11-14T12:00:00Z');
 const clock={now:()=>new Date(currentTime)},site='shipment-projection-site',namespace='synthetic-shipment-projection';
 const identityPolicy={schema:'packproof.source-identity-policy/v1',eventKey:{kind:'composite',fields:['orderId','orderLineId','property']},revision:{kind:'source_as_of'}};
 const columnIdentityPolicy={schema:'packproof.source-identity-policy/v1',eventKey:{kind:'column'},revision:{kind:'column'}};
 const crossCasePolicy={schema:'packproof.cross-case-source-policy/v1',version:'synthetic-shipment/1',allowMultiOrderRows:true,partitionRule:'explicit_order_line_allocations',sharedEntityTypes:['handling_unit','load','stop'],sourceOwnerQualified:true,qualificationReference:'Synthetic shipment partition fixture only'};
 const snapshotMapping={orderId:'Order',orderLineId:'Line',property:'Property',amount:'Value',unit:'Unit',sourceAsOf:'AsOf'};
 interface Source {id:string;connectionId:string;profile:string;v2:boolean;policy:unknown;mapping:Record<string,string>;constants:Record<string,string>;}
 interface Work {batch_id:string;case_id:string;state:string;work_revision:string|number;cursor_key:string|null;case_revision:string|number|null;error_code:string|null;processed_groups:number;linked_groups:number;}
 const ref=(type:TypedSourceReference['type'],externalId:string,root:string):TypedSourceReference=>({namespace,type,externalId,...(type==='order_line'?{parentExternalId:root}:{})});
 function observation(root:string,shipment:string,event:string,line='001',applicable=true):TypedSourceObservation {
  const order=ref('order',root,root),item=ref('order_line',line,root),physical=ref('shipment',shipment,root);
  return {sourceEventId:event,sourceRevision:'1',observationKind:'snapshot',occurredAt:null,sourceAsOf:'2026-11-12T10:00:00Z',timeQuality:'snapshot_time_only',references:[order,item,physical],assertions:[{subjectReference:item,property:'allocatedQuantity',value:{amount:'10',unit:'each'},sourceLocator:{row:1,field:'quantity'},assurance:'source_reported'},...(applicable?[{subjectReference:item,property:'description' as const,value:`Synthetic item ${line}`,sourceLocator:{row:1,field:'description'},assurance:'source_reported' as const}]:[])],relationships:[{from:order,to:item,type:'has_line',quantity:null},{from:physical,to:item,type:'fulfills',quantity:null}],supersedes:null,originSystem:'Synthetic shipment fixture',copiedFromSource:null};
 }
 async function source(profile='packproof.order-lines/v1',v2=false,connectionId=account,partitioned=false,ownerQualified=true):Promise<Source> {
  const key=`shipment-source-${++sequence}`,w=await requireRecordWorkspace(opened.db,owner,org,'sandbox',true),policy=partitioned?columnIdentityPolicy:identityPolicy,mapping:Record<string,string>=v2&&!partitioned?snapshotMapping:{},constants:Record<string,string>=v2&&!partitioned?{observationKind:'snapshot',timeQuality:'snapshot_time_only'}:{};
  const proposed=await opened.db.transaction(tx=>proposeSourceSubscription(tx,clock,w,{connectionId,principalId:actor.principalId,operatorMembershipId:member,locationId:site,installationId:null,config:{...(v2?{batchSchema:'packproof.typed-source-batch/v2',identityPolicy:policy,...(partitioned?{crossCasePolicy}:{})}:{}),transport:'partner_api',displayName:'Synthetic shipment source',sourceProfile:profile,mappingVersion:'shipment-fixture/1',sourceNamespace:namespace,mapping,constants,wholeFileConsent:true,folderDigest:null,initialFileName:null,initialOriginalSha256:null,expectedHeaders:Object.values(mapping),historyFrom:'2026-11-01T00:00:00Z',historyTo:null,maxBytes:2097152,maxRows:1000,offlineWindowHours:24,expectedIntervalSeconds:3600,completenessPolicy:{kind:'snapshot',scope:'shipment_line',sourceOwnerQualified:ownerQualified,qualificationReference:ownerQualified?'Synthetic test contract only; no customer qualification':null}}},key));
  await opened.db.transaction(tx=>actOnSourceSubscription(tx,clock,w,proposed.id,{action:'approve',configurationRevision:1,configurationSha256:proposed.configurationSha256,wholeFileConsent:true},`approve-${key}`));
  return {id:proposed.id,connectionId,profile,v2,policy,mapping,constants};
 }
 async function queue(s:Source,rows:TypedSourceObservation[]|string):Promise<string> {
  currentTime+=1000;const key=`shipment-receipt-${++sequence}`,content=typeof rows==='string'?rows:JSON.stringify(rows),grant=Number((await opened.db.query<{grant_revision:string|number}>('SELECT grant_revision FROM record_source_subscriptions WHERE id=$1',[s.id])).rows[0].grant_revision);
  const preview=await previewTypedImport(deps,actor,{schema:s.v2?'packproof.typed-source-batch/v2':'packproof.typed-source-batch/v1',...(s.v2?{identityPolicy:s.policy}:{}),connectionId:s.connectionId,locationId:site,subscriptionId:s.id,configurationRevision:1,grantRevision:grant,sourceProfile:s.profile,mappingVersion:'shipment-fixture/1',sourceNamespace:namespace,wholeFileConsent:true,original:{name:typeof rows==='string'?'synthetic.csv':'synthetic.json',mediaType:typeof rows==='string'?'text/csv':'application/json',content,sha256:sha256Hex(content)},mapping:s.mapping,constants:s.constants,completeness:{kind:'snapshot',asOf:'2026-11-12T12:00:00Z',marker:'synthetic-qualified-snapshot'}},`preview-${key}`);
  expect(preview.value.rows.map(row=>row.errors)).toEqual(preview.value.rows.map(()=>[]));
  await commitTypedImport(deps,actor,preview.value.id,{previewVersion:preview.value.previewVersion,originalSha256:preview.value.original.sha256,importValidRows:false},`commit-${key}`);return preview.value.id;
 }
 function gate(){let release!:()=>void;return {promise:new Promise<void>(resolve=>{release=resolve;}),release:()=>release()};}
 function startReceipt(batchId:string,pausePrefix=false){
  const prefix=gate(),prefixContinue=gate(),terminal=gate(),terminalContinue=gate();let sawPrefix=false,sawTerminal=false;
  const observed:Database={query:(sql,params)=>opened.db.query(sql,params),transaction:async fn=>{
   const value=await opened.db.transaction(fn);
   const row=(await opened.db.query<{state:string;accepted:number;processing:number}>(`SELECT b.state,COUNT(*) FILTER(WHERE r.status IN ('accepted_linked','accepted_unlinked'))::integer accepted,COUNT(*) FILTER(WHERE r.status='processing')::integer processing FROM record_typed_batches b JOIN record_typed_rows r ON r.batch_id=b.id WHERE b.id=$1 GROUP BY b.state`,[batchId])).rows[0];
   if(pausePrefix&&!sawPrefix&&row.state==='running'&&row.accepted>0&&row.processing>0){sawPrefix=true;prefix.release();await prefixContinue.promise;}
   if(!sawTerminal&&['succeeded','partially_succeeded'].includes(row.state)){sawTerminal=true;terminal.release();await terminalContinue.promise;}
   return value;
  }};
  const worker=processPendingTypedImports({...deps,db:observed},1);
  const reached=(pending:Promise<void>)=>Promise.race([pending,worker.then(()=>{throw Error('Receipt finished without the expected durable boundary');})]);
  return {prefix:()=>reached(prefix.promise),terminal:()=>reached(terminal.promise),continuePrefix:()=>prefixContinue.release(),finish:async()=>{prefixContinue.release();terminalContinue.release();return worker;}};
 }
 async function unit(batchId:string,limit=1,input=deps,retryBudget=true){
  // Restrict only candidate selection to this fixture's original receipt;
  // authorization, work locks, durable mutations and original I/O stay real.
  const scoped:Database={query:(sql,params)=>input.db.query(sql.includes('SELECT w.* FROM record_typed_shipment_work w')?sql.replace("WHERE w.state='pending'","WHERE w.batch_id=$3 AND w.state='pending'"):sql,sql.includes('SELECT w.* FROM record_typed_shipment_work w')?[...(params??[]),batchId]:params),transaction:fn=>input.db.transaction(fn)};
  const snapshot=()=>input.db.query<{id:string;revision:string|number;members:number}>(`SELECT c.id,c.revision,(SELECT COUNT(*)::integer FROM record_case_members m WHERE m.case_id=c.id) members FROM record_cases c JOIN record_typed_shipment_work w ON w.case_id=c.id WHERE w.batch_id=$1 ORDER BY c.id`,[batchId]);
  for(let attempt=0;attempt<2;attempt++){
   const before=(await snapshot()).rows,prior=(await input.db.query<Work>('SELECT * FROM record_typed_shipment_work WHERE batch_id=$1 ORDER BY case_id',[batchId])).rows,result=await processPendingShipmentProjections({...input,db:scoped},limit),after=(await input.db.query<Work>('SELECT * FROM record_typed_shipment_work WHERE batch_id=$1 ORDER BY case_id',[batchId])).rows;
   if(!retryBudget||limit!==1||result.processed!==0||result.blocked!==1||!after.some(row=>row.error_code==='SHIPMENT_PROJECTION_TIME_BUDGET'))return result;
   expect((await snapshot()).rows).toEqual(before);
   expect(after.map(row=>({caseId:row.case_id,cursor:row.cursor_key,caseRevision:row.case_revision,processed:row.processed_groups,linked:row.linked_groups}))).toEqual(prior.map(row=>({caseId:row.case_id,cursor:row.cursor_key,caseRevision:row.case_revision,processed:row.processed_groups,linked:row.linked_groups})));
   expect(Number(after[0].work_revision)).toBe(Number(prior[0].work_revision)+1);
   if(attempt===1)return result;
   currentTime+=60001;
  }
  throw Error('Unreachable bounded retry');
 }
 const work=async(batch:string)=>(await opened.db.query<Work>('SELECT * FROM record_typed_shipment_work WHERE batch_id=$1 ORDER BY case_id',[batch])).rows;
 const revision=async(caseId:string)=>Number((await opened.db.query<{revision:string|number}>('SELECT revision FROM record_cases WHERE id=$1',[caseId])).rows[0].revision);
 const proofs=async(caseId:string)=>Number((await opened.db.query<{n:number}>('SELECT COUNT(DISTINCT proof_id)::integer n FROM record_case_members WHERE case_id=$1',[caseId])).rows[0].n);
 async function reenqueue(batchId:string,rowIds:string[],force=false){await opened.db.transaction(async tx=>{const batch=(await tx.query<TypedBatchRow>('SELECT * FROM record_typed_batches WHERE id=$1',[batchId])).rows[0];await authorizeRetainedTypedImport(deps,tx,actor,batch);await enqueueShipmentProjectionWork(tx,clock,batch,rowIds,force);});}
 const facts=async(batchId:string)=>Number((await opened.db.query<{n:number}>("SELECT COUNT(*)::integer n FROM record_typed_rows WHERE batch_id=$1 AND status='accepted_linked'",[batchId])).rows[0].n);
 beforeAll(async()=>{
  for(const flag of ['PACKPROOF_ORGANIZATIONS_ENABLED','PACKPROOF_TYPED_INTAKE_ENABLED','PACKPROOF_SOURCE_SUBSCRIPTIONS_ENABLED','PACKPROOF_CASE_RECONSTRUCTION_ENABLED','PACKPROOF_SOURCE_IDENTITY_V2_ENABLED'])vi.stubEnv(flag,'true');
  vi.stubEnv('PACKPROOF_CROSS_CASE_ENABLED','false');vi.stubEnv('PACKPROOF_EVENT_CURSOR_KEY',randomBytes(32).toString('base64'));
  opened=await openIsolatedTestDatabase();await migrate(opened.db);dir=await mkdtemp(path.join(os.tmpdir(),'shipment-projection-'));
  deps={db:opened.db,clock,objectStore:new LocalObjectStore(path.join(dir,'objects'),'http://localhost','synthetic-shipment-secret'),devAuth:true};
  const admin=await insertUser(opened.db,clock);owner=await insertUser(opened.db,clock);
  await opened.db.query("INSERT INTO user_verified_contacts(user_id,email_normalized,verified_at,source) VALUES($1,'nericollin@gmail.com',$2,'COGNITO')",[admin,clock.now().toISOString()]);
  org=(await createOrganization(opened.db,clock,admin,{kind:'MERCHANT',name:'Synthetic shipment warehouse',ownerUserId:owner},'shipment-fixture')).id;await setOrganizationEntitlement(opened.db,clock,admin,org,{enabled:true},'shipment-fixture');
  member=(await opened.db.query<{id:string}>('SELECT id FROM platform_memberships WHERE organization_id=$1 AND user_id=$2',[org,owner])).rows[0].id;
  const principal=await createServicePrincipal(opened.db,clock,owner,org,{name:'Synthetic shipment source'},'shipment-fixture'),credential=await issuePartnerCredential(opened.db,clock,owner,org,principal.id,{scopes:[...PARTNER_SCOPES],expiresAt:'2026-11-30T12:00:00Z'},'shipment-fixture');actor=await authenticatePartner(opened.db,clock,`Bearer ${credential.token}`,org,undefined,'shipment-fixture');
  account=(await createIntegrationAccount(opened.db,clock,owner,org,{provider:'synthetic-shipment-projection',externalAccountId:'fixture-only'},'shipment-fixture')).id;
  await opened.db.query('INSERT INTO record_locations(id,organization_id,name,created_at) VALUES($1,$2,$3,$4)',[site,org,'Synthetic shipment site',clock.now().toISOString()]);
 },60000);
 afterAll(async()=>{await opened?.close();if(dir)await rm(dir,{recursive:true,force:true});vi.unstubAllEnvs();});

 it('commits exactly one group per job step and saves its own post-binding case revision',async()=>{
  const s=await source(),batch=await queue(s,[observation('TWO-GROUPS','SHIP-GROUP-A','two-groups-a','001'),observation('TWO-GROUPS','SHIP-GROUP-B','two-groups-b','002')]),running=startReceipt(batch);
  try{
   await running.terminal();const receipt=await readTypedImport(deps,actor,batch),caseId=receipt.caseIds[0],initial=await revision(caseId);
   expect(receipt).toMatchObject({state:'succeeded',counts:{acceptedLinked:2,processing:0}});expect(await work(batch)).toEqual([expect.objectContaining({state:'pending',cursor_key:null,case_revision:null,processed_groups:0,linked_groups:0})]);
   expect(await unit(batch)).toEqual({processed:1,blocked:0});const first=(await work(batch))[0];
   expect(first).toMatchObject({state:'pending',processed_groups:1,linked_groups:1,error_code:null});expect(first.cursor_key).toMatch(/^typed:v1:[a-f0-9]{64}$/);expect(Number(first.case_revision)).toBe(initial+1);expect(await revision(caseId)).toBe(initial+1);expect(await proofs(caseId)).toBe(1);
   await reenqueue(batch,receipt.rows.map(row=>row.id));expect(await work(batch)).toEqual([first]);
   expect(await unit(batch)).toEqual({processed:1,blocked:0});const final=(await work(batch))[0];
   expect(final).toMatchObject({state:'complete',processed_groups:2,linked_groups:2,error_code:null});expect(Number(final.case_revision)).toBe(initial+2);expect(Number(final.work_revision)).toBeGreaterThan(Number(first.work_revision));expect(await proofs(caseId)).toBe(2);
   await reenqueue(batch,receipt.rows.map(row=>row.id));expect(await work(batch)).toEqual([final]);
   const repeated=await opened.db.transaction(tx=>attachQualifiedShipmentProofs(tx,clock,actor,batch,{caseId,afterShipmentKey:null,caseRevision:null,check:()=>{}}));
   expect(repeated.processedGroups).toBe(1);expect(repeated.linkedGroups).toBe(1);expect(await revision(caseId)).toBe(initial+2);expect(await proofs(caseId)).toBe(2);expect(await facts(batch)).toBe(2);
   expect(await unit(batch)).toEqual({processed:0,blocked:0});
   await reenqueue(batch,receipt.rows.map(row=>row.id),true);const forced=(await work(batch))[0];expect(forced).toMatchObject({state:'pending',cursor_key:null,case_revision:null,processed_groups:0,linked_groups:0});expect(Number(forced.work_revision)).toBe(Number(final.work_revision)+1);
   await unit(batch);await unit(batch);expect((await work(batch))[0]).toMatchObject({state:'complete',processed_groups:2,linked_groups:2});expect(await revision(caseId)).toBe(initial+2);expect(await proofs(caseId)).toBe(2);
  }finally{await running.finish();}
 },60000);

 it.each([
  {name:'explicit',partition:['8','2'],expected:[2,8]},
  {name:'unpartitioned',partition:[null,null],expected:[]},
  {name:'contradictory',partition:['8','3'],expected:[]},
 ])('preserves a split line and creates only supported shipment quantities ($name)',async({name,partition,expected})=>{
  const order='SPLIT-'+name,row=observation(order,'FIRST-'+name,order);
  const other=ref('shipment','SECOND-'+name,order),line=row.references[1];
  row.references.push(other);
  const quantity=(amount:string|null)=>amount===null?null:{amount,unit:'each'};
  row.relationships[1].quantity=quantity(partition[0]);
  row.relationships.push({type:'fulfills',from:other,to:line,quantity:quantity(partition[1])});
  const batch=await queue(await source(),[row]),running=startReceipt(batch);
  try{
   await running.terminal();
   const caseId=(await readTypedImport(deps,actor,batch)).caseIds[0];
   await unit(batch);await unit(batch);
   const shipments=await opened.db.query<{quantity:number}>(`SELECT t.quantity FROM record_case_members m
    JOIN proofs p ON p.id=m.proof_id JOIN transactions t ON t.id=p.transaction_id
    WHERE m.case_id=$1 ORDER BY t.quantity`,[caseId]);
   expect(shipments.rows.map(t=>Number(t.quantity))).toEqual(expected);
   expect(await facts(batch)).toBe(1);
  }finally{await running.finish();}
 },60000);

 it.each(['quantity','description'])('checks the actual source of a shipment %s on a shared connection',async(field)=>{
  const root='MIXED-SOURCE-'+field,shipment='SHIP-'+root;
  const unqualified=await source(undefined,false,account,false,false),qualified=await source();
  const foreign=observation(root,shipment,root+'-unqualified','001',field==='description');
  if(field==='description')foreign.assertions[0].property='orderedQuantity';
  const old=await queue(unqualified,[foreign]);
  await processPendingTypedImports(deps,1);
  const caseId=(await readTypedImport(deps,actor,old)).caseIds[0];
  expect(await proofs(caseId)).toBe(0);
  const trigger=observation(root,shipment,root+'-qualified','001',field==='quantity');
  if(field==='quantity')trigger.assertions[0].property='orderedQuantity';
  const independentlyQualified=observation(root,'SEPARATE-'+root,root+'-qualified-other','002');
  const next=await queue(qualified,[trigger,independentlyQualified]),worker=startReceipt(next);
  try{
   await worker.terminal();await unit(next);await unit(next);
   const references=await opened.db.query<{reference:string}>(`SELECT DISTINCT s.reference FROM record_case_members m
    JOIN record_state s ON s.proof_id=m.proof_id WHERE m.case_id=$1`,[caseId]);
   expect(references.rows.map(value=>value.reference)).toEqual(['SEPARATE-'+root]);
   expect(await facts(old)).toBe(1);expect(await facts(next)).toBe(2);
  }finally{await worker.finish();}
 },60000);

 it('resets a cursor after an external case revision without churning already-linked memberships',async()=>{
  const s=await source(),batch=await queue(s,[observation('CURSOR-RESET','CURSOR-SHIP-A','cursor-a','001'),observation('CURSOR-RESET','CURSOR-SHIP-B','cursor-b','002')]),running=startReceipt(batch);
  try{
   await running.terminal();const caseId=(await readTypedImport(deps,actor,batch)).caseIds[0];await unit(batch);const first=(await work(batch))[0],prior=await revision(caseId);
   // Model an independent committed case update; this fixture changes neither
   // the source inputs nor the already-linked group.
   await opened.db.query('UPDATE record_cases SET revision=revision+1 WHERE id=$1',[caseId]);
   await unit(batch);const reset=(await work(batch))[0];expect(reset.cursor_key).toBe(first.cursor_key);expect(reset).toMatchObject({state:'pending',processed_groups:1,linked_groups:1});expect(Number(reset.case_revision)).toBe(prior+1);expect(await revision(caseId)).toBe(prior+1);expect(await proofs(caseId)).toBe(1);
   await unit(batch);const finished=(await work(batch))[0];expect(finished,JSON.stringify(finished)).toMatchObject({state:'complete',processed_groups:2,linked_groups:2});expect(await proofs(caseId)).toBe(2);expect(await revision(caseId)).toBe(prior+2);
  }finally{await running.finish();}
 },60000);

 it('durably finishes a valid inapplicable group and explicitly refuses complete inputs above each cap',async()=>{
  const s=await source(),batch=await queue(s,[observation('NO-LEGACY-PROOF','NO-TITLE','no-title','001',false)]),running=startReceipt(batch);
  try{await running.terminal();const caseId=(await readTypedImport(deps,actor,batch)).caseIds[0],before=await revision(caseId);await unit(batch);expect((await work(batch))[0]).toMatchObject({state:'complete',processed_groups:1,linked_groups:0,error_code:null});expect(await proofs(caseId)).toBe(0);expect(await revision(caseId)).toBe(before);expect(await facts(batch)).toBe(1);}finally{await running.finish();}
  const bounded=await queue(s,[observation('CAPS','CAP-A','cap-a','001'),observation('CAPS','CAP-B','cap-b','002')]),second=startReceipt(bounded);
  try{
   await second.terminal();const caseId=(await readTypedImport(deps,actor,bounded)).caseIds[0];
   for(const cap of [{maxRows:1},{maxBytes:1},{maxGroups:1}]){
    const seen:string[]=[],db:Database={query:(sql,params)=>{seen.push(sql);return opened.db.query(sql,params);},transaction:fn=>opened.db.transaction(fn)};
    const outcome=await attachQualifiedShipmentProofs(db,clock,actor,bounded,{caseId,afterShipmentKey:null,caseRevision:null,check:()=>{},...cap});
    expect(outcome).toMatchObject({state:'unavailable',errorCode:'SHIPMENT_PROJECTION_CASE_LIMIT',processedGroups:0,linkedGroups:0});expect(seen.some(sql=>sql.includes('SELECT r.id,r.batch_id,'))).toBe(false);expect(await proofs(caseId)).toBe(0);
   }
  }finally{await second.finish();}
 },60000);

 it('never creates a whole-shipment Proof from two different one-case rows sharing the physical shipment',async()=>{
  vi.stubEnv('PACKPROOF_CROSS_CASE_ENABLED','true');
  const s=await source(undefined,true,account,true),batch=await queue(s,[observation('SHARED-ORDER-A','SHARED-PHYSICAL-SHIPMENT','shared-a'),observation('SHARED-ORDER-B','SHARED-PHYSICAL-SHIPMENT','shared-b')]),running=startReceipt(batch);
  try{
   await running.terminal();const receipt=await readTypedImport(deps,actor,batch);expect(receipt.caseIds).toHaveLength(2);expect(receipt.counts.acceptedLinked).toBe(2);const summary=await unit(batch,2);
   expect(summary).toEqual({processed:2,blocked:0});expect(JSON.stringify(summary)).not.toMatch(/SHARED|case_/);expect(await work(batch)).toEqual([expect.objectContaining({state:'complete',processed_groups:1,linked_groups:0}),expect.objectContaining({state:'complete',processed_groups:1,linked_groups:0})]);
   for(const id of receipt.caseIds)expect(await proofs(id)).toBe(0);expect(await facts(batch)).toBe(2);
  }finally{await running.finish();vi.stubEnv('PACKPROOF_CROSS_CASE_ENABLED','false');}
 },60000);

 it('keeps the physical-shipment peer guard within the exact original connection',async()=>{
  vi.stubEnv('PACKPROOF_CROSS_CASE_ENABLED','true');
  const otherAccount=(await createIntegrationAccount(opened.db,clock,owner,org,{provider:'synthetic-other-shipment-connection',externalAccountId:'other-fixture-only'},'other-shipment-account')).id,otherSource=await source(undefined,true,otherAccount,true),ownSource=await source(undefined,true,account,true);
  const peerBatch=await queue(otherSource,[observation('OTHER-CONNECTION-ORDER','SAME-REF-DIFFERENT-CONNECTION','other-connection-peer','001',false)]);await processPendingTypedImports(deps,1);
  const peer=(await readTypedImport(deps,actor,peerBatch)).caseIds[0];expect(await proofs(peer)).toBe(0);
  const batch=await queue(ownSource,[observation('OWN-CONNECTION-ORDER','SAME-REF-DIFFERENT-CONNECTION','own-connection-row')]),running=startReceipt(batch);
  try{await running.terminal();const caseId=(await readTypedImport(deps,actor,batch)).caseIds[0];expect(await unit(batch)).toEqual({processed:1,blocked:0});expect((await work(batch))[0]).toMatchObject({state:'complete',processed_groups:1,linked_groups:1});expect(await proofs(caseId)).toBe(1);expect(await proofs(peer)).toBe(0);}finally{await running.finish();vi.stubEnv('PACKPROOF_CROSS_CASE_ENABLED','false');}
 },60000);

 it('defers the complete case for a visible operational prefix, including an explicit successor moved away, then retries after that receipt settles',async()=>{
  const orderSource=await source(),operationalSource=await source('packproof.operational-observations/v1'),neighborBatch=await queue(orderSource,[observation('DEPENDENCY-NEIGHBOR','DEPENDENCY-NEIGHBOR-SHIP','dependency-neighbor','001',false)]);
  await processPendingTypedImports(deps,1);const neighbor=(await readTypedImport(deps,actor,neighborBatch)).caseIds[0];
  const batch=await queue(orderSource,[observation('WAIT-FOR-OPERATIONAL','WAIT-SHIP','waiting-order')]),orderWorker=startReceipt(batch);let operationalWorker:ReturnType<typeof startReceipt>|undefined;
  try{
   await orderWorker.terminal();const original=await readTypedImport(deps,actor,batch),caseId=original.caseIds[0],opRows=Array.from({length:6},(_,i)=>{const row=observation('WAIT-FOR-OPERATIONAL','WAIT-SHIP',`operational-prefix-${i}`);row.assertions=[{...row.assertions[0],property:'reportedLoadedQuantity'}];return row;}),operational=await queue(operationalSource,opRows);operationalWorker=startReceipt(operational,true);await operationalWorker.prefix();
   expect((await readTypedImport(deps,actor,operational)).counts).toMatchObject({acceptedLinked:1,processing:5});await unit(batch);expect((await work(batch))[0]).toMatchObject({state:'pending',cursor_key:null,processed_groups:0,error_code:'SHIPMENT_SOURCE_RECEIPT_PENDING'});expect(await proofs(caseId)).toBe(0);
   const rollback=Error('rollback reassociated explicit-successor fixture');
   await expect(opened.db.transaction(async tx=>{
    await tx.query("UPDATE record_typed_rows SET case_id=$2,supersedes_id=CASE WHEN row_number=1 THEN $3 ELSE NULL END WHERE batch_id=$1 AND status='accepted_linked'",[operational,neighbor,original.rows[0].id]);
    const indirect=(await tx.query<{affects:boolean;superseded:boolean}>(`SELECT ${caseReceiptAffectsSql('b','$2','$3')} affects,${caseObservationSupersededSql('$4','$2')} superseded FROM record_typed_batches b WHERE b.id=$1`,[operational,caseId,account,original.rows[0].id])).rows[0];expect(indirect).toEqual({affects:true,superseded:true});
    currentTime+=5000;await unit(batch,1,{...deps,db:tx});expect((await tx.query<Work>('SELECT * FROM record_typed_shipment_work WHERE batch_id=$1',[batch])).rows[0]).toMatchObject({state:'pending',processed_groups:0,error_code:'SHIPMENT_SOURCE_RECEIPT_PENDING'});throw rollback;
   })).rejects.toBe(rollback);
   operationalWorker.continuePrefix();await operationalWorker.terminal();expect((await readTypedImport(deps,actor,operational)).state).toBe('succeeded');currentTime+=5000;
   await unit(batch);expect((await work(batch))[0]).toMatchObject({state:'complete',processed_groups:1,linked_groups:1,error_code:null});expect(await proofs(caseId)).toBe(1);expect(await facts(operational)).toBe(6);expect(await work(operational)).toEqual([]);
  }finally{if(operationalWorker)await operationalWorker.finish();await orderWorker.finish();}
 },60000);

 it('uses the admitted exact-scope v2 snapshot ledger even after a newer accepted prefix is reassociated away',async()=>{
  const s=await source(undefined,true),neighborSource=await source(),neighborBatch=await queue(neighborSource,[observation('SNAPSHOT-NEIGHBOR','SNAPSHOT-NEIGHBOR-SHIP','snapshot-neighbor','001',false)]);await processPendingTypedImports(deps,1);const neighbor=(await readTypedImport(deps,actor,neighborBatch)).caseIds[0];
  const csv=(hour:number,count:number)=>`Order,Line,Property,Value,Unit,AsOf\n${Array.from({length:count},(_,i)=>`SNAPSHOT-DEPENDENCY,${String(i+1).padStart(3,'0')},orderedQuantity,${hour},each,2026-11-12T${hour}:00:00Z`).join('\n')}\n`;
  const batch=await queue(s,csv(10,1)),olderWorker=startReceipt(batch);let newerWorker:ReturnType<typeof startReceipt>|undefined;
  try{
   await olderWorker.terminal();const old=await readTypedImport(deps,actor,batch),caseId=old.caseIds[0],newer=await queue(s,csv(12,6));newerWorker=startReceipt(newer,true);await newerWorker.prefix();
   const accepted=(await opened.db.query<{id:string;supersedes_id:string|null}>('SELECT id,supersedes_id FROM record_typed_rows WHERE batch_id=$1 AND row_number=2',[newer])).rows[0];expect(accepted.supersedes_id).toBeNull();
   expect((await opened.db.query('SELECT 1 FROM record_typed_snapshot_versions WHERE observation_id=ANY($1::text[])',[[old.rows[0].id,accepted.id]])).rows).toHaveLength(2);
   const rollback=Error('rollback admitted snapshot reassociation fixture');
   await expect(opened.db.transaction(async tx=>{
    // Only allocation is perturbed, inside rollback. Both exact source-time
    // ledger rows above were admitted by the live qualification trigger.
    await tx.query("UPDATE record_typed_rows SET case_id=$2 WHERE batch_id=$1 AND status='accepted_linked'",[newer,neighbor]);
    const indirect=(await tx.query<{affects:boolean;superseded:boolean}>(`SELECT ${caseReceiptAffectsSql('b','$2','$3')} affects,${caseObservationSupersededSql('$4','$2')} superseded FROM record_typed_batches b WHERE b.id=$1`,[newer,caseId,account,old.rows[0].id])).rows[0];expect(indirect).toEqual({affects:true,superseded:true});
    await unit(batch,1,{...deps,db:tx});expect((await tx.query<Work>('SELECT * FROM record_typed_shipment_work WHERE batch_id=$1',[batch])).rows[0]).toMatchObject({state:'pending',processed_groups:0,error_code:'SHIPMENT_SOURCE_RECEIPT_PENDING'});
    const otherConnection=(await tx.query<{affects:boolean}>(`SELECT ${caseReceiptAffectsSql('b','$2',"'unrelated-connection'")} affects FROM record_typed_batches b WHERE b.id=$1`,[newer,caseId])).rows[0];expect(otherConnection.affects).toBe(false);throw rollback;
   })).rejects.toBe(rollback);
   newerWorker.continuePrefix();await newerWorker.terminal();currentTime+=5000;await unit(batch);expect((await work(batch))[0]).toMatchObject({state:'complete',processed_groups:0,linked_groups:0});
  }finally{if(newerWorker)await newerWorker.finish();await olderWorker.finish();}
 },60000);

 it('rolls back the whole group when the final awaited work mutation crosses the unit deadline',async()=>{
  const s=await source(),batch=await queue(s,[observation('DEADLINE','DEADLINE-SHIP','deadline-group')]),running=startReceipt(batch);
  try{
   await running.terminal();const caseId=(await readTypedImport(deps,actor,batch)).caseIds[0],before=await revision(caseId);let delayed=false;
   const slow:Database={query:(sql,params)=>opened.db.query(sql,params),transaction:fn=>opened.db.transaction(tx=>{
    const wrapped:Database={query:async(sql,params)=>{
     if(!delayed&&sql.startsWith('UPDATE record_typed_shipment_work SET work_revision=')){delayed=true;await new Promise(resolve=>setTimeout(resolve,220));}
     return tx.query(sql,params);
    },transaction:inner=>tx.transaction(inner)};return fn(wrapped);
   })};
   for(let attempt=0;attempt<2;attempt++){
    expect(await unit(batch,1,{...deps,db:slow},false)).toEqual({processed:0,blocked:1});
    expect((await work(batch))[0]).toMatchObject({state:'pending',cursor_key:null,processed_groups:0,linked_groups:0,error_code:'SHIPMENT_PROJECTION_TIME_BUDGET'});expect(await proofs(caseId)).toBe(0);expect(await revision(caseId)).toBe(before);expect(await facts(batch)).toBe(1);expect((await readTypedImport(deps,actor,batch)).state).toBe('succeeded');
    if(delayed)break;currentTime+=60001;
   }
   expect(delayed).toBe(true);
  }finally{await running.finish();}
 },60000);

 it.each(['original','credential'] as const)('fails closed on current %s verification while preserving accepted facts',async(kind)=>{
  const s=await source(),batch=await queue(s,[observation(`DENIED-${kind.toUpperCase()}`,`DENIED-SHIP-${kind}`,`denied-${kind}`)]),running=startReceipt(batch);
  try{
   await running.terminal();const caseId=(await readTypedImport(deps,actor,batch)).caseIds[0],before=await revision(caseId);
   if(kind==='original'){
    const objectStore=new Proxy(deps.objectStore,{get(target,property){if(property==='get')return async()=>({body:Buffer.from('synthetic altered original'),contentType:'application/json'});const value=Reflect.get(target,property,target);return typeof value==='function'?value.bind(target):value;}});
    expect(await unit(batch,1,{...deps,objectStore})).toEqual({processed:0,blocked:1});expect((await work(batch))[0]).toMatchObject({state:'unavailable',error_code:'TYPED_ORIGINAL_INTEGRITY_FAILED',processed_groups:0});
   }else{
    const rollback=Error('rollback current credential revocation fixture');await expect(opened.db.transaction(async tx=>{
     await tx.query('UPDATE platform_credentials SET revoked_at=$2 WHERE id=$1',[actor.credentialId,clock.now().toISOString()]);
     expect(await unit(batch,1,{...deps,db:tx})).toEqual({processed:0,blocked:1});expect((await tx.query<Work>('SELECT * FROM record_typed_shipment_work WHERE batch_id=$1',[batch])).rows[0]).toMatchObject({state:'unavailable',error_code:'INSUFFICIENT_SCOPE',processed_groups:0});throw rollback;
    })).rejects.toBe(rollback);
   }
   expect(await facts(batch)).toBe(1);expect(await proofs(caseId)).toBe(0);expect(await revision(caseId)).toBe(before);expect((await readTypedImport(deps,actor,batch)).state).toBe('succeeded');
  }finally{await running.finish();}
 },60000);
});
