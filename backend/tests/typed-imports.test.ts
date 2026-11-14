import {beforeAll,afterAll,describe,it,expect,vi} from 'vitest';
import {mkdtemp,rm,readFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {randomBytes} from 'node:crypto';
import {openIsolatedTestDatabase} from './isolated-test-database.js';
import {migrate} from '../src/db/migrate.js';
import {insertUser} from '../src/domain/users.js';
import {createOrganization,setOrganizationEntitlement,createServicePrincipal,issuePartnerCredential,createIntegrationAccount,authenticatePartner,PARTNER_SCOPES,type PartnerActor} from '../src/platform/organizations.js';
import {LocalObjectStore} from '../src/s3/local-object-store.js';
import {requireRecordWorkspace} from '../src/records/access.js';
import {proposeSourceSubscription,actOnSourceSubscription} from '../src/records/source-subscriptions.js';
import {previewTypedImport,commitTypedImport,readTypedImport,readTypedImportRecordSubset,processPendingTypedImports,replayPendingTypedRows,resumeTypedImport,type TypedImportDeps} from '../src/records/typed-imports.js';
import {approveCaseCrosswalk,requireCaseAccess} from '../src/records/cases.js';
import {loadOperationalCaseProjection} from '../src/records/reconstruction.js';
import {exportOperationalCase} from '../src/records/reconstruction-exports.js';
import {importPartnerOrder,addPartnerBinding} from '../src/platform/partner-proofs.js';
import {sha256Hex} from '../src/hash.js';
import {canonicalize} from '../src/canonical.js';
import type {TypedSourceBatch,TypedSourceObservation,TypedSourceReference} from '../src/records/source-contracts.js';

describe('typed source receipts and operational case writes',()=>{
 let opened:Awaited<ReturnType<typeof openIsolatedTestDatabase>>,dir:string,deps:TypedImportDeps,owner:string,org:string,member:string,account:string,actor:PartnerActor,otherActor:PartnerActor,subscription:string;
 const clock={now:()=>new Date('2026-11-14T12:00:00Z')};
 const namespace='qualified-fixture',site='typed-fixture-site';
 const ref=(type:TypedSourceReference['type'],externalId:string,parent='0010482'):TypedSourceReference=>({namespace,type,externalId,...(type==='order_line'?{parentExternalId:parent}:{})});
 const order=(event:string,orderId='0010482'):TypedSourceObservation=>{
  const o=ref('order',orderId),line=ref('order_line','004',orderId);
  return {sourceEventId:event,sourceRevision:'1',observationKind:'snapshot',occurredAt:null,sourceAsOf:'2026-11-12T19:00:00Z',timeQuality:'snapshot_time_only',references:[o,line],assertions:[{subjectReference:line,property:'orderedQuantity',value:{amount:'10',unit:'each'},sourceLocator:{row:1,field:'ignored'},assurance:'source_reported'}],relationships:[{from:o,to:line,type:'has_line',quantity:null}],supersedes:null,originSystem:'fixture ERP',copiedFromSource:null};
 };
 async function source(profile='packproof.order-lines/v1',location=site,ns=namespace,qualified=false,unknownTimePolicy:'quarantine'|'retain_unknown'='quarantine'){
  const w=await requireRecordWorkspace(opened.db,owner,org,'sandbox',true);
  const proposed=await opened.db.transaction(tx=>proposeSourceSubscription(tx,clock,w,{connectionId:account,principalId:actor.principalId,installationId:null,operatorMembershipId:member,locationId:location,config:{transport:'partner_api',displayName:'Synthetic qualified export',sourceProfile:profile,mappingVersion:'fixture/1',sourceNamespace:ns,mapping:{},constants:{},wholeFileConsent:true,folderDigest:null,initialFileName:null,initialOriginalSha256:null,expectedHeaders:[],historyFrom:'2026-11-01T00:00:00Z',historyTo:null,unknownTimePolicy,maxBytes:2097152,maxRows:1000,offlineWindowHours:24,expectedIntervalSeconds:null,completenessPolicy:{kind:qualified?'snapshot':'unknown',scope:'shipment_line',sourceOwnerQualified:qualified,qualificationReference:qualified?'Synthetic test contract; not a customer qualification':null}}},`propose-${profile}-${location}-${ns}`));
  await opened.db.transaction(tx=>actOnSourceSubscription(tx,clock,w,proposed.id,{action:'approve',configurationRevision:1,configurationSha256:proposed.configurationSha256,wholeFileConsent:true},`approve-${proposed.id}`));return proposed.id;
 }
 function envelope(rows:unknown[],sub=subscription,profile='packproof.order-lines/v1',location=site,ns=namespace):Omit<TypedSourceBatch,'rows'|'headers'> {
  const content=JSON.stringify(rows);return {schema:'packproof.typed-source-batch/v1',connectionId:account,locationId:location,sourceProfile:profile as TypedSourceBatch['sourceProfile'],mappingVersion:'fixture/1',sourceNamespace:ns,subscriptionId:sub,configurationRevision:1,grantRevision:2,wholeFileConsent:true,original:{name:'synthetic.json',mediaType:'application/json',content,sha256:sha256Hex(content)},mapping:{},constants:{},completeness:{kind:'unknown',asOf:null,marker:null}};
 }
 async function ingest(input:unknown,key:string,partial=false){const p=await previewTypedImport(deps,actor,input,`preview-${key}`);await commitTypedImport(deps,actor,p.value.id,{previewVersion:p.value.previewVersion,originalSha256:p.value.original.sha256,importValidRows:partial},`commit-${key}`);await processPendingTypedImports(deps,10);return readTypedImport(deps,actor,p.value.id);}
 beforeAll(async()=>{
  for(const flag of ['PACKPROOF_ORGANIZATIONS_ENABLED','PACKPROOF_TYPED_INTAKE_ENABLED','PACKPROOF_SOURCE_SUBSCRIPTIONS_ENABLED','PACKPROOF_CASE_RECONSTRUCTION_ENABLED','PACKPROOF_RECONSTRUCTION_EXPORTS_ENABLED'])vi.stubEnv(flag,'true');
  vi.stubEnv('PACKPROOF_EVENT_CURSOR_KEY',randomBytes(32).toString('base64'));
  opened=await openIsolatedTestDatabase();await migrate(opened.db);dir=await mkdtemp(path.join(os.tmpdir(),'typed-sources-'));
  deps={db:opened.db,clock,objectStore:new LocalObjectStore(path.join(dir,'objects'),'http://localhost','typed-test-secret'),devAuth:true};
  const admin=await insertUser(opened.db,clock);owner=await insertUser(opened.db,clock);
  await opened.db.query("INSERT INTO user_verified_contacts(user_id,email_normalized,verified_at,source) VALUES($1,'nericollin@gmail.com',$2,'COGNITO')",[admin,clock.now().toISOString()]);
  org=(await createOrganization(opened.db,clock,admin,{kind:'MERCHANT',name:'Typed fixture warehouse',ownerUserId:owner},'typed-fixture')).id;await setOrganizationEntitlement(opened.db,clock,admin,org,{enabled:true},'typed-fixture');
  member=(await opened.db.query<{id:string}>('SELECT id FROM platform_memberships WHERE organization_id=$1 AND user_id=$2',[org,owner])).rows[0].id;
  const principal=await createServicePrincipal(opened.db,clock,owner,org,{name:'Typed export observer'},'typed-fixture');
  const token=await issuePartnerCredential(opened.db,clock,owner,org,principal.id,{scopes:[...PARTNER_SCOPES],expiresAt:'2026-11-15T12:00:00Z'},'typed-fixture');actor=await authenticatePartner(opened.db,clock,`Bearer ${token.token}`,org,undefined,'typed-test');
  const unrelated=await createServicePrincipal(opened.db,clock,owner,org,{name:'Unapproved observer'},'unapproved');const t=await issuePartnerCredential(opened.db,clock,owner,org,unrelated.id,{scopes:[...PARTNER_SCOPES],expiresAt:'2026-11-15T12:00:00Z'},'unapproved');otherActor=await authenticatePartner(opened.db,clock,`Bearer ${t.token}`,org,undefined,'typed-other');
  account=(await createIntegrationAccount(opened.db,clock,owner,org,{provider:'synthetic-qualified-export',externalAccountId:'typed-fixture'},'typed-fixture')).id;
  await opened.db.query('INSERT INTO record_locations(id,organization_id,name,created_at) VALUES($1,$2,$3,$4)',[site,org,'Synthetic Site A',clock.now().toISOString()]);subscription=await source();
 },60000);
 afterAll(async()=>{await opened?.close();if(dir)await rm(dir,{recursive:true,force:true});vi.unstubAllEnvs();});
 it('creates an order-only case without inventing a Proof, quantity or event time',async()=>{
  const done=await ingest(envelope([order('order-first')]),'order-first');expect(done).toMatchObject({state:'succeeded',counts:{acceptedLinked:1,processing:0}});expect(done.caseIds).toHaveLength(1);
  const c=(await opened.db.query('SELECT * FROM record_cases WHERE id=$1',[done.caseIds[0]])).rows[0];expect(c.root_external_id).toBe('0010482');
  expect((await opened.db.query('SELECT 1 FROM record_case_members WHERE case_id=$1',[done.caseIds[0]])).rows).toHaveLength(0);
  const assertion=(await opened.db.query('SELECT * FROM record_case_assertions WHERE observation_id=$1',[done.rows[0].id])).rows[0];expect(assertion.value).toEqual({amount:'10',unit:'each'});expect(assertion.occurred_at).toBeNull();expect(assertion.source_locator).toMatchObject({row:1,jsonPointer:'/0/assertions/0/value'});
 });
 it('retains exact original version and prevents mutation of original lineage',async()=>{
  const input=envelope([order('original-integrity','ORIGINAL')]),p=await previewTypedImport(deps,actor,input,'original-integrity');
  const saved=(await opened.db.query<{original_object_key:string;original_version_id:string}>('SELECT original_object_key,original_version_id FROM record_typed_batches WHERE id=$1',[p.value.id])).rows[0];
  const original=await deps.objectStore.get(saved.original_object_key,{versionId:saved.original_version_id});expect(original?.body.toString('utf8')).toBe(input.original.content);
  await expect(opened.db.query("UPDATE record_typed_batches SET original_sha256=$2 WHERE id=$1",[p.value.id,'f'.repeat(64)])).rejects.toThrow(/immutable/);
  await expect(opened.db.query("UPDATE record_typed_rows SET source_values='{}' WHERE batch_id=$1",[p.value.id])).rejects.toThrow(/immutable/);
 });
 it('accounts for every valid and malformed row and requires explicit partial approval',async()=>{
  const input=envelope([order('partial-good','PARTIAL'),{...order('partial-bad','PARTIAL'),assertions:[{...order('x').assertions[0],value:{amount:'unknown',unit:'each'}}]}]);
  const p=await previewTypedImport(deps,actor,input,'partial');expect(p.value.counts).toMatchObject({processing:1,quarantined:1});
  await expect(commitTypedImport(deps,actor,p.value.id,{previewVersion:p.value.previewVersion,originalSha256:p.value.original.sha256,importValidRows:false},'partial-refuse')).rejects.toMatchObject({code:'TYPED_IMPORT_HAS_ROW_ERRORS'});
  await commitTypedImport(deps,actor,p.value.id,{previewVersion:p.value.previewVersion,originalSha256:p.value.original.sha256,importValidRows:true},'partial-accept');await processPendingTypedImports(deps);
  const done=await readTypedImport(deps,actor,p.value.id);expect(done).toMatchObject({state:'partially_succeeded',rowCount:2,counts:{acceptedLinked:1,quarantined:1}});expect(Object.values(done.counts).reduce((a,b)=>a+b,0)).toBe(2);
 });
 it('returns exact idempotent receipts and detects changed keys without duplicate assertions',async()=>{
  const input=envelope([order('stable-retry','RETRY')]);const p=await previewTypedImport(deps,actor,input,'stable-preview');const same=await previewTypedImport(deps,actor,input,'stable-preview');expect(same.value.id).toBe(p.value.id);expect(same.replayed).toBe(true);
  await expect(previewTypedImport(deps,actor,envelope([order('different','RETRY')]),'stable-preview')).rejects.toMatchObject({code:'IDEMPOTENCY_CONFLICT'});
  const done=await ingest(input,'stable-import'),duplicate=await ingest(input,'stable-duplicate');expect(duplicate.counts.duplicate).toBe(1);expect((await opened.db.query('SELECT 1 FROM record_case_assertions WHERE observation_id=$1',[done.rows[0].id])).rows).toHaveLength(1);
 });
 it('retains changed immutable identities as conflicts',async()=>{
  const original=order('conflicting','CONFLICT');await ingest(envelope([original]),'conflict-original');original.assertions[0].value={amount:'8',unit:'each'};
  const changed=await ingest(envelope([original]),'conflict-changed');expect(changed).toMatchObject({state:'failed',counts:{conflict:1}});expect(changed.rows[0].errorCode).toBe('SOURCE_EVENT_CONFLICT');
 });
 it('uses explicit supersession without counting repeated cumulative snapshots',async()=>{
  const original=order('revisioned','REVISION');const a=await ingest(envelope([original]),'revision-one');
  const corrected={...original,sourceRevision:'2',observationKind:'correction',supersedes:{sourceEventId:original.sourceEventId,sourceRevision:'1'},assertions:[{...original.assertions[0],value:{amount:'8',unit:'each'}}]};
  const b=await ingest(envelope([corrected]),'revision-two');expect(b.counts.acceptedLinked).toBe(1);expect(b.rows[0].supersedesId).toBe(a.rows[0].id);
  for(let i=0;i<3;i++){const dup=await ingest(envelope([corrected]),`revision-repeat-${i}`);expect(dup.counts.duplicate).toBe(1);}
  const active=(await opened.db.query("SELECT a.* FROM record_case_assertions a WHERE a.case_id=$1 AND NOT EXISTS(SELECT 1 FROM record_typed_rows newer WHERE newer.supersedes_id=a.observation_id AND newer.status='accepted_linked')",[a.caseIds[0]])).rows;expect(active).toHaveLength(1);expect(active[0].value).toEqual({amount:'8',unit:'each'});
 });
 it('resolves a correction arriving before its parent without changing the preserved history',async()=>{
  const original=order('reverse-revision','REVERSE-REVISION'),corrected={...original,sourceRevision:'2',observationKind:'correction',supersedes:{sourceEventId:original.sourceEventId,sourceRevision:'1'},assertions:[{...original.assertions[0],value:{amount:'8',unit:'each'}}]};
  const early=await ingest(envelope([corrected]),'reverse-correction');expect(early.counts.acceptedUnlinked).toBe(1);
  const late=await ingest(envelope([original]),'reverse-original');expect(late.counts.acceptedLinked).toBe(1);
  const replayed=await readTypedImport(deps,actor,early.id);expect(replayed.counts.acceptedLinked).toBe(1);expect(replayed.rows[0].supersedesId).toBe(late.rows[0].id);
 });
 it('replays a loading observation after the qualified order shipment arrives',async()=>{
  const observation=order('loading-early','ARRIVES-LATE');observation.references.push(ref('shipment','S-LATE'));observation.assertions[0].property='reportedLoadedQuantity';observation.assertions[0].value={amount:'8',unit:'each'};observation.relationships=[{from:ref('shipment','S-LATE'),to:observation.references[0],type:'fulfills',quantity:null}];
  const sub=await source('packproof.operational-observations/v1');const early=await ingest(envelope([observation],sub,'packproof.operational-observations/v1'),'early-loading');expect(early.counts.acceptedUnlinked).toBe(1);
  const allocation=order('order-late','ARRIVES-LATE');allocation.references.push(ref('shipment','S-LATE'));allocation.assertions[0].property='allocatedQuantity';allocation.relationships.push({from:ref('shipment','S-LATE'),to:allocation.references.find(r=>r.type==='order_line')!,type:'fulfills',quantity:{amount:'10',unit:'each'}});
  const late=await ingest(envelope([allocation]),'late-order');const replayed=await readTypedImport(deps,actor,early.id);expect(replayed.caseIds).toEqual(late.caseIds);expect(replayed.counts.acceptedLinked).toBe(1);
 });
 it('provides source-only canonical materialization without exposing other case feeds',async()=>{
  const a=await ingest(envelope([order('subset-one','SUBSET')]),'subset-one');const b=await ingest(envelope([order('subset-two','SUBSET')]),'subset-two');
  const subset=await readTypedImportRecordSubset(deps,actor,a.id);expect(subset.rows).toHaveLength(1);expect(subset.rows[0].assertions).toHaveLength(1);expect(subset.rows[0].assertions[0].value).toEqual({amount:'10',unit:'each'});
  expect(subset.rows[0].assertions[0].subjectReference).toMatchObject({externalId:'004',parentExternalId:'SUBSET'});expect(JSON.stringify(subset)).not.toContain(b.rows[0].id);
  await expect(readTypedImportRecordSubset(deps,otherActor,a.id)).rejects.toMatchObject({code:'TYPED_IMPORT_NOT_FOUND'});
 });
 it('creates one qualified multi-line shipment Proof through existing domain commands without default values',async()=>{
  const make=(lineId:string,title:string,amount:string)=>{
   const n=order(`qualified-${lineId}`,'QUALIFIED-ORDER'),line=ref('order_line',lineId,'QUALIFIED-ORDER'),shipment=ref('shipment','QUALIFIED-SHIPMENT');
   n.references=[ref('order','QUALIFIED-ORDER'),line,shipment];n.assertions=[{...n.assertions[0],subjectReference:line,property:'allocatedQuantity',value:{amount,unit:'each'}},{...n.assertions[0],subjectReference:line,property:'description',value:title}];
   n.relationships=[{from:ref('order','QUALIFIED-ORDER'),to:line,type:'has_line',quantity:null},{from:shipment,to:line,type:'fulfills',quantity:{amount,unit:'each'}}];return n;
  };
  const sub=await source('packproof.order-lines/v1',site,namespace,true),input=envelope([make('004','Source supplied brass fitting','5'),make('005','Source supplied valve','3')],sub);input.completeness={kind:'snapshot',asOf:'2026-11-12T19:00:00Z',marker:'synthetic-qualified-full-shipment'};
  const done=await ingest(input,'qualified-shipment');expect(done.counts.acceptedLinked).toBe(2);
  const members=(await opened.db.query<{proof_id:string}>('SELECT DISTINCT proof_id FROM record_case_members WHERE case_id=$1',[done.caseIds[0]])).rows;expect(members).toHaveLength(1);
  const proof=(await opened.db.query<{item_title:string;quantity:number}>('SELECT t.item_title,t.quantity FROM proofs p JOIN transactions t ON t.id=p.transaction_id WHERE p.id=$1',[members[0].proof_id])).rows[0];expect(proof).toEqual({item_title:'Source supplied brass fitting; Source supplied valve',quantity:8});
  expect((await opened.db.query("SELECT 1 FROM audit_events WHERE proof_id=$1 AND event_type='TYPED_SOURCE_SHIPMENT_IMPORTED'",[members[0].proof_id])).rows).toHaveLength(1);
 });
 it('preserves pending source rows until a human crosswalk, and appends corrected associations',async()=>{
  const first=await ingest(envelope([order('crosswalk-first','CROSSWALK-A')]),'crosswalk-first'),second=await ingest(envelope([order('crosswalk-second','CROSSWALK-B')]),'crosswalk-second');
  const ns='separate-wms-namespace',shipment={namespace:ns,type:'shipment' as const,externalId:'WMS-SHIPMENT'},n={...order('crosswalk-loading'),references:[shipment],assertions:[{subjectReference:shipment,property:'reportedLoadedQuantity',value:{amount:'8',unit:'each'}}],relationships:[]};
  const sub=await source('packproof.operational-observations/v1',site,ns),pending=await ingest(envelope([n],sub,'packproof.operational-observations/v1',site,ns),'crosswalk-pending');expect(pending.counts.acceptedUnlinked).toBe(1);
  const w=await requireRecordWorkspace(opened.db,owner,org,'sandbox',true),body={caseId:first.caseIds[0],locationId:site,namespace:ns,type:'shipment',externalId:shipment.externalId,ruleVersion:'source-owner-mapping/1',reason:'Synthetic owner verified explicit shipment assignment'};
  const approved=await approveCaseCrosswalk(opened.db,clock,w,body,'crosswalk-approve');await replayPendingTypedRows(deps);const linked=await readTypedImport(deps,actor,pending.id);expect(linked.caseIds).toEqual(first.caseIds);
  await approveCaseCrosswalk(opened.db,clock,w,{...body,caseId:second.caseIds[0],supersedesId:approved.id,reason:'Synthetic owner corrected its prior mapping'},'crosswalk-correct');await resumeTypedImport(deps,actor,pending.id,'crosswalk-reconcile');await processPendingTypedImports(deps);
  const corrected=await readTypedImport(deps,actor,pending.id);expect(corrected.caseIds).toEqual(second.caseIds);
  const history=(await opened.db.query<{case_id:string;supersedes_id:string|null;basis:{kind:string}}> ('SELECT case_id,supersedes_id,basis FROM record_case_association_decisions WHERE observation_id=$1 ORDER BY created_at,id',[pending.rows[0].id])).rows;expect(history).toHaveLength(2);expect(history.every(d=>d.basis.kind==='approved_crosswalk')).toBe(true);
  expect((await opened.db.query('SELECT 1 FROM record_case_assertions WHERE observation_id=$1',[pending.rows[0].id])).rows).toHaveLength(2);
 });
 it('filters superseded Proof membership while preserving the prior exported case',async()=>{
  const first=await ingest(envelope([order('proof-map-a','PROOF-MAP-A')]),'proof-map-a'),second=await ingest(envelope([order('proof-map-b','PROOF-MAP-B')]),'proof-map-b');
  const ns='proof-wms',shipment={namespace:ns,type:'shipment' as const,externalId:'SOURCE-PROOF-SHIPMENT'},proof=(await importPartnerOrder(opened.db,clock,actor,{integrationAccountId:account,externalId:'source-qualified-existing-proof',operatorMembershipId:member,transaction:{itemTitle:'Actual source-supplied shipment title',quantity:8}})).proofId;
  const bindingKey=`typed:v1:${sha256Hex(canonicalize([site,ns,'shipment',shipment.externalId]))}`;await addPartnerBinding(opened.db,clock,actor,proof,{integrationAccountId:account,resourceType:'SHIPMENT',externalId:bindingKey});
  await opened.db.query('INSERT INTO record_state(proof_id,organization_id,environment,location_id,updated_at) VALUES($1,$2,$3,$4,$5)',[proof,org,'sandbox',site,clock.now().toISOString()]);
  const w=await requireRecordWorkspace(opened.db,owner,org,'sandbox',true),body={caseId:first.caseIds[0],locationId:site,namespace:ns,type:'shipment',externalId:shipment.externalId,ruleVersion:'verified-source-map/1',reason:'Synthetic source owner qualified this existing shipment identity'},approved=await approveCaseCrosswalk(opened.db,clock,w,body,'proof-map-approve');
  const n={...order('proof-source-row'),references:[shipment],assertions:[{subjectReference:shipment,property:'reportedLoadedQuantity',value:{amount:'8',unit:'each'}}],relationships:[]},sub=await source('packproof.operational-observations/v1',site,ns),receipt=await ingest(envelope([n],sub,'packproof.operational-observations/v1',site,ns),'proof-source-row');
  const before=await loadOperationalCaseProjection(opened.db,clock,w,first.caseIds[0]);expect(before.case.proofIds).toEqual([proof]);const frozen=await exportOperationalCase(deps,w,first.caseIds[0]);
  await approveCaseCrosswalk(opened.db,clock,w,{...body,caseId:second.caseIds[0],supersedesId:approved.id,reason:'Synthetic owner corrected its initial association'},'proof-map-correct');await resumeTypedImport(deps,actor,receipt.id,'proof-map-reconcile');await processPendingTypedImports(deps);
  expect((await loadOperationalCaseProjection(opened.db,clock,w,first.caseIds[0])).case.proofIds).toEqual([]);expect((await loadOperationalCaseProjection(opened.db,clock,w,second.caseIds[0])).case.proofIds).toEqual([proof]);
  const retained=(await opened.db.query<{payload_canonical:string;payload_sha256:string}>('SELECT payload_canonical,payload_sha256 FROM record_reconstruction_exports WHERE id=$1',[frozen.id])).rows[0];expect(retained.payload_sha256).toBe(frozen.sha256);expect(sha256Hex(retained.payload_canonical)).toBe(frozen.sha256);expect(JSON.parse(retained.payload_canonical).projection.case.proofIds).toEqual([proof]);
 });
 it('blocks accepted work when the approval grant changes rather than transferring its authority',async()=>{
  const sub=await source(),input=envelope([order('grant-retained','GRANT-RETAINED')],sub),p=await previewTypedImport(deps,actor,input,'grant-retained');
  await commitTypedImport(deps,actor,p.value.id,{previewVersion:p.value.previewVersion,originalSha256:p.value.original.sha256,importValidRows:false},'grant-commit');
  await opened.db.query('UPDATE record_source_subscriptions SET grant_revision=grant_revision+1 WHERE id=$1',[sub]);await processPendingTypedImports(deps);
  const blocked=await readTypedImport(deps,actor,p.value.id);expect(blocked).toMatchObject({state:'blocked_policy',errorCode:'SOURCE_GRANT_CHANGED'});
  expect((await opened.db.query('SELECT 1 FROM record_case_assertions WHERE batch_id=$1',[p.value.id])).rows).toHaveLength(0);
  await expect(resumeTypedImport(deps,actor,p.value.id,'grant-unsafe-resume')).rejects.toMatchObject({code:'SOURCE_GRANT_CHANGED'});
 });
 it('tombstones a source fact without deleting its old assertions or original',async()=>{
  const original=order('tombstone-original','TOMBSTONE'),input=envelope([original]),first=await ingest(input,'tombstone-original');
  const tombstone={...original,sourceEventId:'tombstone-deletion',observationKind:'tombstone',assertions:[],relationships:[],supersedes:{sourceEventId:original.sourceEventId,sourceRevision:'1'}};
  const removed=await ingest(envelope([tombstone]),'tombstone-delete');expect(removed.counts.acceptedLinked).toBe(1);
  const w=await requireRecordWorkspace(opened.db,owner,org,'sandbox'),projection=await loadOperationalCaseProjection(opened.db,clock,w,first.caseIds[0]);expect(projection.assertions.filter(a=>a.active)).toHaveLength(0);expect(projection.assertions).toHaveLength(1);
  const originalRow=(await opened.db.query<{original_object_key:string;original_version_id:string}>('SELECT original_object_key,original_version_id FROM record_typed_batches WHERE id=$1',[first.id])).rows[0];expect((await deps.objectStore.get(originalRow.original_object_key,{versionId:originalRow.original_version_id}))?.body.toString('utf8')).toBe(input.original.content);
 });
 it('does not combine the same reference or line number across sites or orders',async()=>{
  const first=await ingest(envelope([order('scoped-a','SAME-ORDER')]),'scoped-a');
  const otherSite='typed-fixture-site-b';await opened.db.query('INSERT INTO record_locations(id,organization_id,name,created_at) VALUES($1,$2,$3,$4)',[otherSite,org,'Synthetic Site B',clock.now().toISOString()]);const sub=await source('packproof.order-lines/v1',otherSite);
  const second=await ingest(envelope([order('scoped-b','SAME-ORDER')],sub,'packproof.order-lines/v1',otherSite),'scoped-b');const differentOrder=await ingest(envelope([order('scoped-other-order','OTHER-ORDER')]),'scoped-other-order');
  expect(new Set([first.caseIds[0],second.caseIds[0],differentOrder.caseIds[0]]).size).toBe(3);
 });
 it('keeps unknown source time outside a bounded history grant',async()=>{
  const n={...order('unknown-time','UNKNOWN-TIME'),sourceAsOf:null,timeQuality:'unknown'};const p=await previewTypedImport(deps,actor,envelope([n]),'unknown-time');expect(p.value.counts.quarantined).toBe(1);expect(p.value.rows[0].errorCode).toBe('SOURCE_HISTORY_TIME_UNKNOWN');
 });
 it('retains unknown source times only under an explicit approved policy, without inventing history eligibility',async()=>{
  const sub=await source('packproof.order-lines/v1',site,namespace,false,'retain_unknown'),n={...order('retained-unknown-time','RETAINED-UNKNOWN'),sourceAsOf:null,timeQuality:'unknown'};
  const done=await ingest(envelope([n],sub),'retained-unknown-time');expect(done).toMatchObject({state:'succeeded',counts:{acceptedLinked:1}});expect(done.rows[0]).toMatchObject({historyEligibility:'unknown',normalized:{occurredAt:null,sourceAsOf:null,timeQuality:'unknown'}});
  const subset=await readTypedImportRecordSubset(deps,actor,done.id);expect(subset.rows[0].historyEligibility).toBe('unknown');expect(subset.rows[0].assertions[0].occurredAt).toBeNull();
 });
 it('keeps multi-order observations pending before they can contaminate an existing case',async()=>{
  const existing=await ingest(envelope([order('multi-root-existing','MULTI-EXISTING')]),'multi-root-existing'),n=order('multi-root-attempt','MULTI-EXISTING');n.references.push(ref('order','UNSEEN-SECOND-ORDER'));
  const pending=await ingest(envelope([n]),'multi-root-attempt');expect(pending).toMatchObject({state:'succeeded',counts:{acceptedUnlinked:1}});expect(pending.rows[0].errorCode).toBe('MULTI_ORDER_RECONSTRUCTION_UNQUALIFIED');
  expect((await opened.db.query('SELECT 1 FROM record_case_entities WHERE case_id=$1 AND external_id=$2',[existing.caseIds[0],'UNSEEN-SECOND-ORDER'])).rows).toHaveLength(0);
  const later=await ingest(envelope([order('multi-root-later','UNSEEN-SECOND-ORDER')]),'multi-root-later');expect(later.caseIds[0]).not.toBe(existing.caseIds[0]);
 });
 it('denies another principal, source reconfiguration and revoked cached retries',async()=>{
  const input=envelope([order('revoked-cache','REVOKED')]);const p=await previewTypedImport(deps,actor,input,'revoked-cache');
  await expect(readTypedImport(deps,otherActor,p.value.id)).rejects.toMatchObject({code:'TYPED_IMPORT_NOT_FOUND'});
  await expect(previewTypedImport(deps,otherActor,input,'other-principal')).rejects.toMatchObject({code:'SOURCE_AUTHORIZATION_REQUIRED'});
  await opened.db.query("UPDATE record_source_subscriptions SET state='revoked' WHERE id=$1",[subscription]);
  await expect(previewTypedImport(deps,actor,input,'revoked-cache')).rejects.toMatchObject({code:'SOURCE_AUTHORIZATION_REQUIRED'});
  await expect(readTypedImport(deps,actor,p.value.id)).rejects.toMatchObject({code:'SOURCE_AUTHORIZATION_REQUIRED'});
  // Restore only this synthetic test subscription so subsequent independent
  // cases can use it; production revocation requires a new explicit source.
  await opened.db.query("UPDATE record_source_subscriptions SET state='approved' WHERE id=$1",[subscription]);
 });
});
