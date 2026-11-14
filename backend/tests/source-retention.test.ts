import {beforeAll,afterAll,it,expect,vi} from 'vitest';
import {readFileSync} from 'node:fs';
import {openIsolatedTestDatabase} from './isolated-test-database.js';
import {migrate} from '../src/db/migrate.js';
import {insertUser} from '../src/domain/users.js';
import {sha256Hex} from '../src/hash.js';
import {canonicalize} from '../src/canonical.js';
import {createOrganization,setOrganizationEntitlement,createServicePrincipal,issuePartnerCredential,createIntegrationAccount,authenticatePartner,addOrganizationMember,PARTNER_SCOPES,type PartnerActor} from '../src/platform/organizations.js';
import {requireRecordWorkspace,type RecordWorkspace} from '../src/records/access.js';
import {proposeSourceSubscription,actOnSourceSubscription} from '../src/records/source-subscriptions.js';
import {previewTypedImport,commitTypedImport,processPendingTypedImports,readTypedImport} from '../src/records/typed-imports.js';
import {readSourceRetentionReview,actOnSourceRetention,getCaseRetentionSummary,parseSourceRetentionPolicy} from '../src/records/source-retention.js';
import {readCaseAssertionSource} from '../src/records/reconstruction-exports.js';
import {MemoryObjectStore} from './memory-object-store.js';
import {requestSourceDisposition,approveSourceDisposition,readSourceDisposition,processSourceDispositions,createQualifiedSourceDispositionStore,readCollectorCompactionCommands,authorizeCollectorCompactionPermit,ackCollectorCompactionCommand,type ExactVersionDispositionTransport} from '../src/records/source-retention-disposition.js';
import type {AppDependencies} from '../src/app.js';
class RetentionStore extends MemoryObjectStore {
 readonly unavailable=new Set<string>();readonly unreachable=new Set<string>();
 async putIfAbsent(key:string,body:Buffer,contentType:string){if(await this.get(key))return {created:false};await this.put(key,body,contentType);return {created:true};}
 async digest(key:string){const d=await super.digest(key);return d?{...d,versionId:'retention-original-version'}:null;}
 async get(key:string){if(this.unreachable.has(key))throw Error('Fixture storage outage');return this.unavailable.has(key)?null:super.get(key);}
}
const clock={now:()=>new Date('2026-11-14T03:00:00Z')},store=new RetentionStore(),site='retention-site';
const corpus=JSON.parse(readFileSync(new URL('./fixtures/reconstruction/source-contract-corpus.json',import.meta.url),'utf8'));
let opened:Awaited<ReturnType<typeof openIsolatedTestDatabase>>,w:RecordWorkspace,reviewer:RecordWorkspace,secondAdmin:RecordWorkspace,actor:PartnerActor,account:string,principal:string,deps:AppDependencies,sequence=0;
const expiredPolicy=(version='1')=>({schema:'packproof.source-retention-policy/v1',version,cloudOriginal:{retainUntil:'2026-11-13T00:00:00Z'},normalizedHistory:{retainUntil:'2026-11-13T00:00:00Z'},localSpool:{retainUntil:'2026-11-13T00:00:00Z',compactAfterAcknowledgement:true}});
async function fixture(twoCases=false,shipments=false){
 const original=structuredClone(corpus.cases[0].input),raw=JSON.parse(original.original.content).slice(0,shipments?2:1),suffix=String(++sequence),order=`RETENTION-${suffix}`;
 const rewrite=(item:any,parent:string)=>{item.sourceEventId+=`-${parent}`;for(const ref of item.references){if(ref.type==='order')ref.externalId=parent;if(ref.type==='order_line')ref.parentExternalId=parent;if(ref.type==='shipment')ref.externalId+=`-${parent}`;}for(const a of item.assertions)if(a.subjectReference.type==='order_line')a.subjectReference.parentExternalId=parent;for(const r of item.relationships)for(const ref of [r.from,r.to]){if(ref.type==='order')ref.externalId=parent;if(ref.type==='order_line')ref.parentExternalId=parent;if(ref.type==='shipment')ref.externalId+=`-${parent}`;}};
 for(const row of raw)rewrite(row,order);
 if(shipments)raw[1].assertions.push({subjectReference:raw[1].references.find((r:any)=>r.type==='order_line'),property:'description',value:'Synthetic valve unit'});
 if(twoCases){const second=structuredClone(corpus.cases[0].input),rows=JSON.parse(second.original.content).slice(0,shipments?2:1);for(const row of rows)rewrite(row,`${order}-OTHER-CUSTOMER`);raw.push(...rows);}
 original.original.content=JSON.stringify(raw);original.original.sha256=sha256Hex(original.original.content);
 const config={transport:'partner_api',displayName:'Synthetic retention source',sourceProfile:original.sourceProfile,mappingVersion:original.mappingVersion,sourceNamespace:original.sourceNamespace,mapping:{},constants:{},wholeFileConsent:true,folderDigest:null,initialFileName:null,initialOriginalSha256:original.original.sha256,expectedHeaders:[],historyFrom:'2026-01-01T00:00:00Z',historyTo:null,maxBytes:2097152,maxRows:1000,offlineWindowHours:24,expectedIntervalSeconds:null,completenessPolicy:shipments?{kind:'snapshot',scope:'shipment_line',sourceOwnerQualified:true,qualificationReference:'synthetic retention fixture only'}:{kind:'unknown',scope:'shipment_line',sourceOwnerQualified:false,qualificationReference:null}};
 const p=await opened.db.transaction(tx=>proposeSourceSubscription(tx,clock,w,{connectionId:account,principalId:principal,operatorMembershipId:w.membershipId,locationId:site,config},`retention-propose-${sequence}`));
 const s=await opened.db.transaction(tx=>actOnSourceSubscription(tx,clock,w,p.id,{action:'approve',configurationRevision:p.configurationRevision,configurationSha256:p.configurationSha256,wholeFileConsent:true},`retention-approve-${sequence}`));
 const input={...original,connectionId:account,locationId:site,subscriptionId:s.id,configurationRevision:s.configurationRevision,grantRevision:s.grantRevision};
 const preview=await previewTypedImport(deps,actor,input,`retention-preview-${sequence}`);
 await commitTypedImport(deps,actor,preview.value.id,{previewVersion:preview.value.previewVersion,originalSha256:preview.value.original.sha256,importValidRows:false},`retention-commit-${sequence}`);
 await processPendingTypedImports(deps);
 const complete=await readTypedImport(deps,actor,preview.value.id);expect(complete.state,complete.errorCode??'').toBe('succeeded');
 const meta=(await opened.db.query<{original_object_key:string;original_sha256:string}>('SELECT original_object_key,original_sha256 FROM record_typed_batches WHERE id=$1',[complete.id])).rows[0];
 return {batchId:complete.id,caseIds:complete.caseIds,key:meta.original_object_key,digest:meta.original_sha256};
}
async function act(batchId:string,action:string,extra:Record<string,unknown>={},key?:string){const review=await readSourceRetentionReview(deps,w,batchId);return actOnSourceRetention(deps,w,batchId,{action,reason:'Synthetic retention review',impactSha256:review.impactSha256,...extra},key??`retention-${++sequence}`);}
beforeAll(async()=>{
 for(const flag of ['PACKPROOF_ORGANIZATIONS_ENABLED','PACKPROOF_TYPED_INTAKE_ENABLED','PACKPROOF_SOURCE_SUBSCRIPTIONS_ENABLED','PACKPROOF_CASE_RECONSTRUCTION_ENABLED','PACKPROOF_RECONSTRUCTION_EXPORTS_ENABLED'])vi.stubEnv(flag,'true');
 opened=await openIsolatedTestDatabase();await migrate(opened.db);
 const developer=await insertUser(opened.db,clock),owner=await insertUser(opened.db,clock);
 await opened.db.query("INSERT INTO user_verified_contacts(user_id,email_normalized,verified_at,source) VALUES($1,'nericollin@gmail.com',$2,'COGNITO')",[developer,clock.now().toISOString()]);
 const org=(await createOrganization(opened.db,clock,developer,{kind:'MERCHANT',name:'Retention test',ownerUserId:owner},'setup')).id;await setOrganizationEntitlement(opened.db,clock,developer,org,{enabled:true},'setup');w=await requireRecordWorkspace(opened.db,owner,org,'sandbox');
 await opened.db.query('INSERT INTO record_locations(id,organization_id,name,created_at) VALUES($1,$2,$3,$4)',[site,org,'Retention site',clock.now().toISOString()]);
 account=(await createIntegrationAccount(opened.db,clock,owner,org,{provider:'csv',externalAccountId:'retention-test'},'setup')).id;
 principal=(await createServicePrincipal(opened.db,clock,owner,org,{name:'Retention source'},'setup')).id;
 const credential=await issuePartnerCredential(opened.db,clock,owner,org,principal,{scopes:[...PARTNER_SCOPES],expiresAt:'2026-12-10T00:00:00Z'},'setup');actor=await authenticatePartner(opened.db,clock,`Bearer ${credential.token}`,org,undefined,'retention-test');
 const person=await insertUser(opened.db,clock);await addOrganizationMember(opened.db,clock,owner,org,{userId:person,role:'REVIEWER'},'setup');reviewer=await requireRecordWorkspace(opened.db,person,org,'sandbox');
 const admin=await insertUser(opened.db,clock);await addOrganizationMember(opened.db,clock,owner,org,{userId:admin,role:'ADMIN'},'setup');secondAdmin=await requireRecordWorkspace(opened.db,admin,org,'sandbox');
 deps={db:opened.db,clock,objectStore:store,devAuth:true,testFixtures:true} as AppDependencies;
},90000);
afterAll(async()=>{await opened?.close();vi.unstubAllEnvs();});
function dispositionStore(transport:ExactVersionDispositionTransport,runtimeClock=clock){return createQualifiedSourceDispositionStore({clock:runtimeClock,activeSourceSha:'a'.repeat(40),testFixtures:true,binding:{schema:'packproof.source-disposition-binding/v1',sourceSha:'a'.repeat(40),organizationIds:[w.organizationId],environment:'sandbox',bucket:'synthetic-source-bucket',permittedPrefix:`evidence/${w.organizationId}/`,reviewedPolicyVersions:['disposition-fixture'],policyReviewReference:'Synthetic policy fixture only',qualificationReference:'Synthetic executor fixture only',reviewedAt:'2026-11-13T00:00:00Z',expiresAt:'2026-11-16T00:00:00Z',mode:'synthetic_test'},transport});}
async function dispositionRequest(batchId:string){vi.stubEnv('PACKPROOF_SOURCE_DISPOSITION_ENABLED','true');await act(batchId,'policy_assigned',{policy:expiredPolicy('disposition-fixture')});const review=await readSourceRetentionReview(deps,w,batchId);return (await requestSourceDisposition(deps,w,batchId,{impactSha256:review.impactSha256,reason:'Synthetic complete shared-source impact review'},`disposition-${++sequence}`)).value;}
async function dispositionApprove(request:Awaited<ReturnType<typeof dispositionRequest>>){return approveSourceDisposition(deps,secondAdmin,request.id,{impactSha256:request.impactSha256,reason:'Synthetic independent approval',approve:true},`disposition-approve-${++sequence}`);}
it('requires independent approval and never turns a request into deletion without a qualified executor',async()=>{
 const f=await fixture(),request=await dispositionRequest(f.batchId);
 expect(request.state).toBe('requested');expect(request.executionAvailable).toBe(false);
 await expect(approveSourceDisposition(deps,w,request.id,{impactSha256:request.impactSha256,reason:'Same reviewer',approve:true},'same-reviewer')).rejects.toMatchObject({code:'SOURCE_DISPOSITION_INDEPENDENT_APPROVER_REQUIRED'});
 await dispositionApprove(request);expect((await processSourceDispositions(deps)).processed).toBe(0);expect(await store.get(f.key)).not.toBeNull();await opened.db.query("UPDATE record_source_disposition_work SET state='blocked',error_code='SYNTHETIC_FIXTURE_FINISHED' WHERE request_id=$1",[request.id]);
});
it('disposes only the reviewed exact version while keeping normalized audit history immutable',async()=>{
 const f=await fixture(),request=await dispositionRequest(f.batchId);await dispositionApprove(request);
 const calls:unknown[]=[],qualified=dispositionStore({async headExact(t){const value=await store.get(t.key);return value?{versionId:'retention-original-version',sha256:sha256Hex(value.body),byteSize:value.body.length}:null;},async deleteExact(t){calls.push(t);store.unavailable.add(t.key);}});
 const before=await opened.db.query<{count:string}>('SELECT COUNT(*)::text count FROM record_typed_rows WHERE batch_id=$1',[f.batchId]);
 await processSourceDispositions({...deps,sourceDisposition:qualified});const result=await readSourceDisposition({...deps,sourceDisposition:qualified},w,request.id);
 expect(result.state).toBe('succeeded');expect(result.original.disposition).toBe('deleted_exact_version');expect(result.qualification).toBe('synthetic_test_only');expect(result.normalizedHistory.disposition).toBe('preserved_audit_history');expect(result.backupErasure).toBe('not_claimed');expect(calls).toEqual([{bucket:'synthetic-source-bucket',key:f.key,versionId:'retention-original-version'}]);
 expect((await opened.db.query<{count:string}>('SELECT COUNT(*)::text count FROM record_typed_rows WHERE batch_id=$1',[f.batchId])).rows).toEqual(before.rows);
 await expect(opened.db.query("UPDATE record_source_disposition_results SET backup_erasure='claimed' WHERE request_id=$1",[request.id])).rejects.toThrow(/immutable|check/i);
 const hold=await act(f.batchId,'hold');expect(hold.value.review.activeHolds).toHaveLength(1);expect((hold.value.review.events.at(-1)?.policy as any).scope).toBe('remaining_receipt_layers');
});
it('rechecks source holds at the execution boundary after approval',async()=>{
 const f=await fixture(),request=await dispositionRequest(f.batchId);await dispositionApprove(request);await act(f.batchId,'hold');let deletes=0;
 const qualified=dispositionStore({async headExact(t){const value=await store.get(t.key);return value?{versionId:'retention-original-version',sha256:sha256Hex(value.body),byteSize:value.body.length}:null;},async deleteExact(){deletes++;}});
 await processSourceDispositions({...deps,sourceDisposition:qualified});expect(deletes).toBe(0);expect((await readSourceDisposition(deps,w,request.id)).state).toBe('blocked');expect(await store.get(f.key)).not.toBeNull();
});
it('reconciles a lost exact-version deletion acknowledgement without repeating the deletion',async()=>{
 const f=await fixture(),request=await dispositionRequest(f.batchId);await dispositionApprove(request);let deletes=0;
 const later={now:()=>new Date('2026-11-14T03:02:00Z')},qualified=dispositionStore({async headExact(t){const value=await store.get(t.key);return value?{versionId:'retention-original-version',sha256:sha256Hex(value.body),byteSize:value.body.length}:null;},async deleteExact(t){deletes++;store.unavailable.add(t.key);throw Error('Synthetic acknowledgement lost after exact deletion');}},later);
 await processSourceDispositions({...deps,sourceDisposition:qualified});expect((await readSourceDisposition(deps,w,request.id)).state).toBe('failed');
 const hold=await act(f.batchId,'hold');expect((hold.value.review.events.at(-1)?.policy as any).originalDispositionCannotBeUndone).toBe(true);
 await processSourceDispositions({...deps,clock:later,sourceDisposition:qualified});const result=await readSourceDisposition(deps,w,request.id);expect(result.state).toBe('succeeded');expect(result.original.disposition).toBe('already_absent');expect(deletes).toBe(1);
});
it('rejects unversioned, unrelated-prefix and integrity-changed disposition targets before deleting',async()=>{
 let deletes=0;const qualified=dispositionStore({async headExact(){return {versionId:'retention-original-version',sha256:'b'.repeat(64),byteSize:5};},async deleteExact(){deletes++;}}),target={batchId:'fixture',organizationId:w.organizationId,environment:'sandbox' as const,key:`evidence/${w.organizationId}/fixture/committed/sha256-${'a'.repeat(64)}`,versionId:'retention-original-version',sha256:'a'.repeat(64),byteSize:5,policyVersion:'disposition-fixture'};
 await expect(qualified.dispose({...target,versionId:'null'})).rejects.toMatchObject({code:'SOURCE_DISPOSITION_TARGET_UNSAFE'});await expect(qualified.dispose({...target,key:`recovery/${w.organizationId}/journal`})).rejects.toMatchObject({code:'SOURCE_DISPOSITION_TARGET_UNSAFE'});await expect(qualified.dispose(target)).rejects.toMatchObject({code:'SOURCE_DISPOSITION_INTEGRITY_CHANGED'});expect(deletes).toBe(0);
});
it('preserves the exact original while recording an immutable three-layer retention policy',async()=>{
 const f=await fixture(),result=await act(f.batchId,'policy_assigned',{policy:expiredPolicy()});
 expect(result.value.review.policy?.version).toBe('1');expect(result.value.review.retention.eligibleForDispositionReview).toBe(true);expect(result.value.review.executionAvailable).toBe(false);
 expect(sha256Hex((await store.get(f.key))!.body)).toBe(f.digest);
 await expect(opened.db.query("UPDATE record_typed_retention_events SET reason='changed' WHERE id=$1",[result.value.eventId])).rejects.toThrow(/immutable/i);
});
it('requires elapsed declared boundaries and active holds block disposition review',async()=>{
 const f=await fixture();expect((await readSourceRetentionReview(deps,w,f.batchId)).retention.eligibleForDispositionReview).toBe(false);
 await act(f.batchId,'policy_assigned',{policy:{...expiredPolicy(),cloudOriginal:{retainUntil:null}}});
 await expect(act(f.batchId,'disposition_requested')).rejects.toMatchObject({code:'SOURCE_RETENTION_PROTECTED'});
 await act(f.batchId,'policy_assigned',{policy:expiredPolicy('2')});
 const hold=await act(f.batchId,'hold',{reviewAt:'2026-12-01T00:00:00Z'});
 await expect(act(f.batchId,'disposition_requested')).rejects.toMatchObject({code:'SOURCE_RETENTION_PROTECTED'});
 await act(f.batchId,'release_hold',{relatedEventId:hold.value.eventId});
 const review=await act(f.batchId,'disposition_requested');expect(review.value.review.originalsDeleted).toBe(false);expect(review.value.review.backupErasure).toBe('not_claimed');expect(await store.get(f.key)).not.toBeNull();
});
it('rejects reused policy versions, stale inventory approval and release of another source hold',async()=>{
 const a=await fixture(),b=await fixture(),first=await readSourceRetentionReview(deps,w,a.batchId);
 await act(a.batchId,'policy_assigned',{policy:expiredPolicy()});
 await expect(act(a.batchId,'policy_assigned',{policy:{...expiredPolicy(),cloudOriginal:{retainUntil:'2027-01-01T00:00:00Z'}}})).rejects.toMatchObject({code:'SOURCE_RETENTION_VERSION_REUSED'});
 await expect(actOnSourceRetention(deps,w,a.batchId,{action:'hold',reason:'Stale review',impactSha256:first.impactSha256},'stale-impact')).rejects.toMatchObject({code:'SOURCE_RETENTION_IMPACT_CHANGED'});
 const hold=await act(b.batchId,'hold');await expect(act(a.batchId,'release_hold',{relatedEventId:hold.value.eventId})).rejects.toMatchObject({code:'SOURCE_HOLD_NOT_ACTIVE'});
});
it('case readers receive a narrow summary while source impact requires current administrator access',async()=>{
 const f=await fixture(true);expect(f.caseIds).toHaveLength(2);await act(f.batchId,'hold',{reason:'Private source-wide customer review'});
 await expect(readSourceRetentionReview(deps,reviewer,f.batchId)).rejects.toMatchObject({httpStatus:403});
 const summary=await getCaseRetentionSummary(deps,reviewer,f.caseIds[0]);expect(summary.batches[0].preservationHoldActive).toBe(true);
 const serialized=JSON.stringify(summary);expect(serialized).not.toContain(f.caseIds[1]);expect(serialized).not.toContain('Private source-wide');expect(serialized).not.toContain(f.key);
 expect((await readSourceRetentionReview(deps,w,f.batchId)).cases).toHaveLength(2);
});
it('does not declare an available original erased and distinguishes unavailable storage from missing data',async()=>{
 const f=await fixture();await expect(act(f.batchId,'unavailable')).rejects.toMatchObject({code:'SOURCE_ORIGINAL_AVAILABLE'});
 store.unreachable.add(f.key);await expect(act(f.batchId,'unavailable')).rejects.toMatchObject({code:'SOURCE_STORAGE_UNREACHABLE'});store.unreachable.delete(f.key);
 store.unavailable.add(f.key);const result=await act(f.batchId,'unavailable');expect(result.value.review.original.availability).toBe('missing');expect(result.value.review.originalsDeleted).toBe(false);
 const summary=await getCaseRetentionSummary(deps,reviewer,f.caseIds[0]);expect(summary.batches[0].originalPreviouslyReportedUnavailable).toBe(true);
 store.unavailable.delete(f.key);expect((await readSourceRetentionReview(deps,w,f.batchId)).original.availability).toBe('available');
});
it('cached retention commands do not bypass current account/membership authority',async()=>{
 const f=await fixture(),review=await readSourceRetentionReview(deps,w,f.batchId),body={action:'hold',reason:'Idempotency review',impactSha256:review.impactSha256};
 expect((await actOnSourceRetention(deps,w,f.batchId,body,'retention-cache')).replayed).toBe(false);expect((await actOnSourceRetention(deps,w,f.batchId,body,'retention-cache')).replayed).toBe(true);
 const rollback=Error('Retain current membership through transaction rollback');
 await expect(opened.db.transaction(async tx=>{await tx.query('UPDATE platform_memberships SET revoked_at=$2 WHERE id=$1',[w.membershipId,clock.now().toISOString()]);await expect(actOnSourceRetention({...deps,db:tx},w,f.batchId,body,'retention-cache')).rejects.toMatchObject({httpStatus:404});throw rollback;})).rejects.toBe(rollback);
});
it('honors existing related shipment retention even when the newer source policy has expired',async()=>{
 const f=await fixture(false,true);await act(f.batchId,'policy_assigned',{policy:expiredPolicy()});
 const review=await readSourceRetentionReview(deps,w,f.batchId);expect(review.relatedRecordProtection.protected).toBe(true);expect(review.retention.eligibleForDispositionReview).toBe(false);
 await expect(act(f.batchId,'disposition_requested')).rejects.toMatchObject({code:'SOURCE_RETENTION_PROTECTED'});
 expect((await getCaseRetentionSummary(deps,reviewer,f.caseIds[0])).batches[0].sharedOriginalProtectedByRelatedRecord).toBe(true);
});
it('retains case retention history when new source administration is disabled',async()=>{
 const f=await fixture();await act(f.batchId,'hold');vi.stubEnv('PACKPROOF_SOURCE_SUBSCRIPTIONS_ENABLED','false');
 try {expect((await getCaseRetentionSummary(deps,reviewer,f.caseIds[0])).batches[0].preservationHoldActive).toBe(true);await expect(readSourceRetentionReview(deps,w,f.batchId)).rejects.toMatchObject({code:'RECONSTRUCTION_CAPABILITY_DISABLED'});}
 finally {vi.stubEnv('PACKPROOF_SOURCE_SUBSCRIPTIONS_ENABLED','true');}
});
it('will not approve unsafe local compaction or infer dates from an incomplete policy',()=>{
 expect(()=>parseSourceRetentionPolicy({...expiredPolicy(),localSpool:{retainUntil:null,compactAfterAcknowledgement:false}})).toThrow(/reconciled/);
 expect(()=>parseSourceRetentionPolicy({...expiredPolicy(),cloudOriginal:{}})).toThrow(/timestamp/);
 expect(()=>parseSourceRetentionPolicy({...expiredPolicy(),cloudOriginal:{retainUntil:'2026-11-12T09:00:00'}})).toThrow(/timestamp/);
});
it('delivers and acknowledges only the completed v2 collector receipt under its exact current policy',async()=>{
 vi.stubEnv('PACKPROOF_MULTI_SOURCE_AGENT_ENABLED','true');vi.stubEnv('PACKPROOF_SOURCE_IDENTITY_V2_ENABLED','true');
 const installation='synthetic-retention-installation',at=clock.now().toISOString();
 await opened.db.query(`INSERT INTO record_agent_installations(id,organization_id,environment,principal_id,credential_id,integration_account_id,operator_membership_id,location_id,source_name,device_name,version,status,config_revision,approval_user_id,created_at,updated_at,enrollment_acknowledged_at,enrollment_expires_at) VALUES($1,$2,'sandbox',$3,$4,$5,$6,$7,'Synthetic retained source','Synthetic PC','0.3.0','ready',1,$8,$9,$9,$9,'2026-11-15T00:00:00Z')`,[installation,w.organizationId,actor.principalId,actor.credentialId,account,w.membershipId,site,w.userId,at]);
 const csv=structuredClone(corpus.cases.find((c:any)=>c.name==='csv-leading-zero-identities-and-exact-locator').input);csv.original.content=csv.original.content.replace(',S-0021,',',,');csv.original.sha256=sha256Hex(csv.original.content);
 csv.schema='packproof.typed-source-batch/v2';csv.identityPolicy={schema:'packproof.source-identity-policy/v1',eventKey:{kind:'column'},revision:{kind:'column'}};
 const config={transport:'local_ntfs',displayName:'Synthetic local retention source',batchSchema:csv.schema,identityPolicy:csv.identityPolicy,sourceProfile:csv.sourceProfile,mappingVersion:csv.mappingVersion,sourceNamespace:csv.sourceNamespace,mapping:csv.mapping,constants:csv.constants,wholeFileConsent:true,folderDigest:'a'.repeat(64),initialFileName:csv.original.name,initialOriginalSha256:csv.original.sha256,expectedHeaders:csv.original.content.split('\r\n')[0].split(','),historyFrom:'2026-01-01T00:00:00Z',historyTo:null,maxBytes:2097152,maxRows:1000,offlineWindowHours:24,expectedIntervalSeconds:null,completenessPolicy:{kind:'unknown',scope:'shipment_line',sourceOwnerQualified:false,qualificationReference:null}};
 const proposed=await opened.db.transaction(tx=>proposeSourceSubscription(tx,clock,w,{connectionId:account,principalId:principal,installationId:installation,operatorMembershipId:w.membershipId,locationId:site,config},'compaction-propose'));
 const approved=await opened.db.transaction(tx=>actOnSourceSubscription(tx,clock,w,proposed.id,{action:'approve',configurationRevision:proposed.configurationRevision,configurationSha256:proposed.configurationSha256,wholeFileConsent:true},'compaction-approve'));
 const input={...csv,connectionId:account,locationId:site,subscriptionId:approved.id,configurationRevision:approved.configurationRevision,grantRevision:approved.grantRevision};
 const preview=await previewTypedImport(deps,actor,input,'compaction-preview');await commitTypedImport(deps,actor,preview.value.id,{previewVersion:preview.value.previewVersion,originalSha256:preview.value.original.sha256,importValidRows:false},'compaction-commit');await processPendingTypedImports(deps);expect((await readTypedImport(deps,actor,preview.value.id)).state).toBe('succeeded');
 const active=await opened.db.transaction(tx=>actOnSourceSubscription(tx,clock,w,approved.id,{action:'activate',configurationRevision:approved.configurationRevision,initialBatchId:preview.value.id,recurringConsent:true},'compaction-activate'));expect(active.grantRevision).toBeGreaterThan(approved.grantRevision);
 const pending=await dispositionRequest(preview.value.id);await dispositionApprove(pending);const qualified=dispositionStore({async headExact(t){const value=await store.get(t.key);return value?{versionId:'retention-original-version',sha256:sha256Hex(value.body),byteSize:value.body.length}:null;},async deleteExact(t){store.unavailable.add(t.key);}});
 await processSourceDispositions({...deps,sourceDisposition:qualified});expect((await readSourceDisposition(deps,w,pending.id)).localSpool.state).toBe('pending');
 const inventory=await readCollectorCompactionCommands(deps,actor);expect(inventory.commands).toHaveLength(1);const command=inventory.commands[0],{commandSha256,...unsignedCommand}=command;expect(commandSha256).toBe(sha256Hex(canonicalize(unsignedCommand)));expect(command).toMatchObject({batchId:preview.value.id,installationId:installation,principalId:actor.principalId,receiptGrantRevision:approved.grantRevision,grantRevision:active.grantRevision,originalSha256:csv.original.sha256});expect(command.receiptGrantRevision).not.toBe(command.grantRevision);
 const permitInput={commandSha256,batchId:command.batchId,originalSha256:command.originalSha256};
 await expect(authorizeCollectorCompactionPermit(deps,actor,command.id,{...permitInput,batchId:'unrelated-receipt'},'compaction-wrong-receipt')).rejects.toMatchObject({code:'SOURCE_COMPACTION_COMMAND_CHANGED'});
 const otherPrincipal=await createServicePrincipal(opened.db,clock,w.userId,w.organizationId,{name:'Unrelated compaction source'},'compaction-other-principal'),otherCredential=await issuePartnerCredential(opened.db,clock,w.userId,w.organizationId,otherPrincipal.id,{scopes:[...PARTNER_SCOPES],expiresAt:'2026-12-10T00:00:00Z'},'compaction-other-credential'),otherActor=await authenticatePartner(opened.db,clock,`Bearer ${otherCredential.token}`,w.organizationId,undefined,'compaction-other');
 await expect(authorizeCollectorCompactionPermit(deps,otherActor,command.id,permitInput,'compaction-other-source')).rejects.toMatchObject({code:'SOURCE_COMPACTION_NOT_FOUND'});
 const restorePending=Error('Restore completed receipt after pending-work boundary check');await expect(opened.db.transaction(async tx=>{await tx.query("UPDATE record_typed_batches SET state='queued' WHERE id=$1",[command.batchId]);await expect(authorizeCollectorCompactionPermit({...deps,db:tx},actor,command.id,permitInput,'compaction-pending-receipt')).rejects.toMatchObject({code:'SOURCE_COMPACTION_AUTHORITY_CHANGED'});throw restorePending;})).rejects.toBe(restorePending);
 const restoreGrant=Error('Restore active grant after pause boundary check');await expect(opened.db.transaction(async tx=>{await actOnSourceSubscription(tx,clock,w,active.id,{action:'pause',configurationRevision:active.configurationRevision,reason:'Synthetic pause after command issuance'},'compaction-pause');await expect(authorizeCollectorCompactionPermit({...deps,db:tx},actor,command.id,permitInput,'compaction-paused-grant')).rejects.toMatchObject({code:'SOURCE_AUTHORIZATION_REQUIRED'});throw restoreGrant;})).rejects.toBe(restoreGrant);
 const blockedHold=await act(command.batchId,'hold');await expect(authorizeCollectorCompactionPermit(deps,actor,command.id,permitInput,'compaction-permit-blocked')).rejects.toMatchObject({code:'SOURCE_RETENTION_PROTECTED'});expect((await readCollectorCompactionCommands(deps,actor)).commands).toHaveLength(1);
 await act(command.batchId,'release_hold',{relatedEventId:blockedHold.value.eventId});
 const permit=(await authorizeCollectorCompactionPermit(deps,actor,command.id,permitInput,'compaction-permit')).value;expect(Date.parse(permit.expiresAt)-Date.parse(permit.issuedAt)).toBe(30000);
 const inFlightHold=await act(command.batchId,'hold');expect((inFlightHold.value.review.events.at(-1)?.policy as any).inFlightCompactionMayComplete).toBe(true);await expect(authorizeCollectorCompactionPermit(deps,actor,command.id,permitInput,'compaction-new-permit-after-hold')).rejects.toMatchObject({code:'SOURCE_RETENTION_PROTECTED'});
 const acknowledgement={permitId:permit.id,commandSha256,batchId:command.batchId,originalSha256:command.originalSha256,serverReceiptReconciled:true,localDisposition:'compacted',compactedAt:at};
 expect((await ackCollectorCompactionCommand(deps,actor,command.id,acknowledgement,'compaction-ack')).replayed).toBe(false);expect((await ackCollectorCompactionCommand(deps,actor,command.id,acknowledgement,'compaction-ack')).replayed).toBe(true);expect((await readSourceDisposition(deps,w,pending.id)).localSpool.state).toBe('acknowledged');
 await act(command.batchId,'policy_assigned',{policy:expiredPolicy('subsequent-review')});expect((await ackCollectorCompactionCommand(deps,actor,command.id,acknowledgement,'compaction-ack')).replayed).toBe(true);
});
