import {beforeAll,afterAll,it,expect,vi} from 'vitest';
import {readFileSync} from 'node:fs';
import {openIsolatedTestDatabase} from './isolated-test-database.js';
import {migrate} from '../src/db/migrate.js';
import {insertUser} from '../src/domain/users.js';
import {sha256Hex} from '../src/hash.js';
import {createOrganization,setOrganizationEntitlement,createServicePrincipal,issuePartnerCredential,createIntegrationAccount,authenticatePartner,addOrganizationMember,PARTNER_SCOPES,type PartnerActor} from '../src/platform/organizations.js';
import {requireRecordWorkspace,type RecordWorkspace} from '../src/records/access.js';
import {proposeSourceSubscription,actOnSourceSubscription} from '../src/records/source-subscriptions.js';
import {previewTypedImport,commitTypedImport,processPendingTypedImports,readTypedImport} from '../src/records/typed-imports.js';
import {readSourceRetentionReview,actOnSourceRetention,getCaseRetentionSummary,parseSourceRetentionPolicy} from '../src/records/source-retention.js';
import {readCaseAssertionSource} from '../src/records/reconstruction-exports.js';
import {MemoryObjectStore} from './memory-object-store.js';
import type {AppDependencies} from '../src/app.js';
class RetentionStore extends MemoryObjectStore {
 readonly unavailable=new Set<string>();readonly unreachable=new Set<string>();
 async putIfAbsent(key:string,body:Buffer,contentType:string){if(await this.get(key))return {created:false};await this.put(key,body,contentType);return {created:true};}
 async digest(key:string){const d=await super.digest(key);return d?{...d,versionId:'retention-original-version'}:null;}
 async get(key:string){if(this.unreachable.has(key))throw Error('Fixture storage outage');return this.unavailable.has(key)?null:super.get(key);}
}
const clock={now:()=>new Date('2026-11-14T03:00:00Z')},store=new RetentionStore(),site='retention-site';
const corpus=JSON.parse(readFileSync(new URL('./fixtures/reconstruction/source-contract-corpus.json',import.meta.url),'utf8'));
let opened:Awaited<ReturnType<typeof openIsolatedTestDatabase>>,w:RecordWorkspace,reviewer:RecordWorkspace,actor:PartnerActor,account:string,principal:string,deps:AppDependencies,sequence=0;
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
 deps={db:opened.db,clock,objectStore:store,devAuth:true,testFixtures:true} as AppDependencies;
},90000);
afterAll(async()=>{await opened?.close();vi.unstubAllEnvs();});
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
