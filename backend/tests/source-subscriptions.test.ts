import {beforeAll,afterAll,it,expect,vi} from 'vitest';
import express from 'express';
import request from './in-process-http.js';
import {readFileSync} from 'node:fs';
import {openIsolatedTestDatabase} from './isolated-test-database.js';
import {migrate} from '../src/db/migrate.js';
import {insertUser} from '../src/domain/users.js';
import {newId} from '../src/ids.js';
import {sha256Hex} from '../src/hash.js';
import {canonicalize} from '../src/canonical.js';
import {createOrganization,setOrganizationEntitlement,createServicePrincipal,issuePartnerCredential,createIntegrationAccount,authenticatePartner,PARTNER_SCOPES,type PartnerActor} from '../src/platform/organizations.js';
import {requireRecordWorkspace,type RecordWorkspace} from '../src/records/access.js';
import {proposeSourceSubscription,actOnSourceSubscription,requireTypedSourceAuthority,heartbeatSourceSubscription,listSourceSubscriptions,parseSourceSubscriptionConfig,listAgentSourceSubscriptions,type SourceSubscriptionConfig} from '../src/records/source-subscriptions.js';
import {authorizeAgentRoute,type AgentApprovedConfig} from '../src/records/agent-restrictions.js';
import {previewTypedImport,commitTypedImport,processPendingTypedImports} from '../src/records/typed-imports.js';
import {createPartnerRouter} from '../src/platform/partner-router.js';
import type {AppDependencies} from '../src/app.js';
import {MemoryObjectStore} from './memory-object-store.js';
class VersionedStore extends MemoryObjectStore {
 async putIfAbsent(key:string,body:Buffer,contentType:string){if(await this.get(key))return {created:false};await this.put(key,body,contentType);return {created:true};}
 async digest(key:string){const v=await super.digest(key);return v?{...v,versionId:'synthetic-source-version'}:null;}
}
const clock={now:()=>new Date('2026-11-14T03:00:00Z')};
const corpus=JSON.parse(readFileSync(new URL('./fixtures/reconstruction/source-contract-corpus.json',import.meta.url),'utf8'));
let opened:Awaited<ReturnType<typeof openIsolatedTestDatabase>>,w:RecordWorkspace,actor:PartnerActor,legacy:PartnerActor,deps:AppDependencies;
let account:string,principal:string,legacyPrincipal:string,legacyCredential:string,legacyToken:string;
const site='subscription-site-a',siteB='subscription-site-b',installation='legacy-subscription-test';
let sequence=0;
function sourceConfig(overrides:Partial<SourceSubscriptionConfig>={}):SourceSubscriptionConfig {return {transport:'partner_api',displayName:'Synthetic order export',sourceProfile:'packproof.order-lines/v1',mappingVersion:'synthetic-pilot/1',sourceNamespace:'pilot-export',mapping:{},constants:{},wholeFileConsent:true,folderDigest:null,initialFileName:null,initialOriginalSha256:corpus.cases[0].input.original.sha256,expectedHeaders:[],historyFrom:'2026-01-01T00:00:00Z',historyTo:null,unknownTimePolicy:'quarantine',maxBytes:2097152,maxRows:1000,offlineWindowHours:24,expectedIntervalSeconds:null,completenessPolicy:{kind:'unknown',scope:'shipment_line',sourceOwnerQualified:false,qualificationReference:null},...overrides};}
async function propose(config=sourceConfig(),identity:{principalId?:string;installationId?:string;connectionId?:string;locationId?:string}={}) {return opened.db.transaction(tx=>proposeSourceSubscription(tx,clock,w,{connectionId:identity.connectionId??account,principalId:identity.principalId??principal,installationId:identity.installationId??null,operatorMembershipId:w.membershipId,locationId:identity.locationId??site,config},`propose-${++sequence}`));}
async function action(s:{id:string;configurationRevision:number;configurationSha256:string},name:string,extra:Record<string,unknown>={}) {return opened.db.transaction(tx=>actOnSourceSubscription(tx,clock,w,s.id,{action:name,configurationRevision:s.configurationRevision,configurationSha256:s.configurationSha256,...extra},`action-${++sequence}`));}
async function approved(config=sourceConfig(),identity:Parameters<typeof propose>[1]={}){const s=await propose(config,identity);return action(s,'approve',{wholeFileConsent:true});}
function identity(s:Awaited<ReturnType<typeof approved>>,overrides:Record<string,unknown>={}) {return {subscriptionId:s.id,configurationRevision:s.configurationRevision,grantRevision:s.grantRevision,connectionId:s.connectionId,locationId:s.locationId,sourceProfile:s.config.sourceProfile,mappingVersion:s.config.mappingVersion,sourceNamespace:s.config.sourceNamespace,mapping:s.config.mapping,constants:s.config.constants,wholeFileConsent:true,originalSha256:s.config.initialOriginalSha256??undefined,...overrides};}
function batchFor(s:Awaited<ReturnType<typeof approved>>) {return {...structuredClone(corpus.cases[0].input),connectionId:s.connectionId,locationId:s.locationId,subscriptionId:s.id,configurationRevision:s.configurationRevision,grantRevision:s.grantRevision};}
beforeAll(async()=>{
 for(const flag of ['PACKPROOF_ORGANIZATIONS_ENABLED','PACKPROOF_TYPED_INTAKE_ENABLED','PACKPROOF_SOURCE_SUBSCRIPTIONS_ENABLED','PACKPROOF_MULTI_SOURCE_AGENT_ENABLED','PACKPROOF_CASE_RECONSTRUCTION_ENABLED','PACKPROOF_SOURCE_HEALTH_ENABLED'])vi.stubEnv(flag,'true');
 opened=await openIsolatedTestDatabase();await migrate(opened.db);
 const developer=await insertUser(opened.db,clock),owner=await insertUser(opened.db,clock);
 await opened.db.query("INSERT INTO user_verified_contacts(user_id,email_normalized,verified_at,source) VALUES($1,'nericollin@gmail.com',$2,'COGNITO')",[developer,clock.now().toISOString()]);
 const org=(await createOrganization(opened.db,clock,developer,{kind:'MERCHANT',name:'Source subscription qualification',ownerUserId:owner},'setup')).id;
 await setOrganizationEntitlement(opened.db,clock,developer,org,{enabled:true},'setup');w=await requireRecordWorkspace(opened.db,owner,org,'sandbox');
 account=(await createIntegrationAccount(opened.db,clock,owner,org,{provider:'csv',externalAccountId:'typed-source-test'},'setup')).id;
 const p=await createServicePrincipal(opened.db,clock,owner,org,{name:'Typed source test'},'setup');principal=p.id;
 const credential=await issuePartnerCredential(opened.db,clock,owner,org,principal,{scopes:[...PARTNER_SCOPES],expiresAt:'2026-12-10T00:00:00Z'},'setup');actor=await authenticatePartner(opened.db,clock,`Bearer ${credential.token}`,org,undefined,'source-test');
 const p2=await createServicePrincipal(opened.db,clock,owner,org,{name:'Legacy installation'},'setup');legacyPrincipal=p2.id;
 const c2=await issuePartnerCredential(opened.db,clock,owner,org,legacyPrincipal,{scopes:[...PARTNER_SCOPES],expiresAt:'2026-12-10T00:00:00Z'},'setup');legacyCredential=c2.id;legacyToken=c2.token;legacy=await authenticatePartner(opened.db,clock,`Bearer ${c2.token}`,org,undefined,'legacy-test');
 await opened.db.query('INSERT INTO record_locations(id,organization_id,name,created_at) VALUES($1,$2,$3,$4),($5,$2,$6,$4)',[site,org,'Site A',clock.now().toISOString(),siteB,'Site B']);
 const config:AgentApprovedConfig={folderDigest:'a'.repeat(64),sourceName:'Legacy CSV source',integrationAccountId:account,operatorMembershipId:w.membershipId,locationId:site,mapping:{shipmentReference:'Shipment',itemTitle:'Description',quantity:'Quantity'},timeZone:'UTC',importValidRows:false,offlineWindowHours:24};
 await opened.db.query(`INSERT INTO record_agent_installations(id,organization_id,environment,principal_id,credential_id,integration_account_id,operator_membership_id,location_id,source_name,device_name,version,status,config_revision,approved_config,config_sha256,approval_user_id,created_at,updated_at,enrollment_acknowledged_at,enrollment_expires_at) VALUES($1,$2,'sandbox',$3,$4,$5,$6,$7,'Legacy CSV source','Fixture PC','0.1.2','ready',1,$8::jsonb,$9,$10,$11,$11,$11,'2026-11-14T03:10:00Z')`,[installation,org,legacyPrincipal,legacyCredential,account,w.membershipId,site,JSON.stringify(config),sha256Hex(canonicalize(config)),owner,clock.now().toISOString()]);
 deps={db:opened.db,clock,objectStore:new VersionedStore(),devAuth:true,testFixtures:true} as AppDependencies;
},90000);
afterAll(async()=>{await opened?.close();vi.unstubAllEnvs();});
it('requires exact whole-original administrator approval before typed source authority exists',async()=>{
 const s=await propose();await expect(requireTypedSourceAuthority(opened.db,clock,actor,identity(s),'preview')).rejects.toMatchObject({code:'SOURCE_AUTHORIZATION_REQUIRED'});
 await expect(action(s,'approve',{wholeFileConsent:true,configurationSha256:'a'.repeat(64)})).rejects.toMatchObject({code:'INVALID_SOURCE_SUBSCRIPTION'});
 const granted=await action(s,'approve',{wholeFileConsent:true});expect((await requireTypedSourceAuthority(opened.db,clock,actor,identity(granted),'preview')).operatorMembershipId).toBe(w.membershipId);
});
it('binds profile, namespace, mapping, constants, site, source and principal without granting export',async()=>{
 const s=await approved();
 for(const change of [{sourceProfile:'packproof.operational-observations/v1'},{mappingVersion:'unapproved/2'},{sourceNamespace:'another-system'},{mapping:{orderId:'Unapproved'}},{constants:{observationKind:'event'}},{locationId:siteB},{connectionId:'other-source'},{configurationRevision:2},{wholeFileConsent:false}])await expect(requireTypedSourceAuthority(opened.db,clock,actor,identity(s,change),'preview')).rejects.toMatchObject({httpStatus:403});
 await expect(requireTypedSourceAuthority(opened.db,clock,legacy,identity(s),'preview')).rejects.toMatchObject({code:'SOURCE_AUTHORIZATION_REQUIRED'});
 await expect(requireTypedSourceAuthority(opened.db,clock,actor,identity(s),'export')).rejects.toMatchObject({code:'SOURCE_OPERATION_DENIED'});
 await expect(requireTypedSourceAuthority(opened.db,clock,actor,identity(s,{originalSha256:'b'.repeat(64)}),'preview')).rejects.toMatchObject({code:'SOURCE_INITIAL_ORIGINAL_CHANGED'});
});
it('keeps first-file approval separate from recurring collection and requires a linked exact receipt',async()=>{
 const s=await approved();await expect(action(s,'activate',{recurringConsent:true,initialBatchId:'missing'})).rejects.toMatchObject({code:'SOURCE_FIRST_RECORD_REQUIRED'});
 const p=await previewTypedImport(deps,actor,batchFor(s),'subscription-first-preview');
 await commitTypedImport(deps,actor,p.value.id,{previewVersion:p.value.previewVersion,originalSha256:p.value.original.sha256,importValidRows:false},'subscription-first-commit');
 const completed=await processPendingTypedImports(deps);const receipt=(await opened.db.query('SELECT state,error_code FROM record_typed_batches WHERE id=$1',[p.value.id])).rows[0];expect(receipt.state,JSON.stringify({completed,receipt})).toBe('succeeded');
 const active=await action(s,'activate',{recurringConsent:true,initialBatchId:p.value.id});expect(active.state).toBe('active');
 expect((await requireTypedSourceAuthority(opened.db,clock,actor,identity(active,{originalSha256:'b'.repeat(64)}),'preview')).subscriptionId).toBe(s.id);
});
it('rechecks revoked authority around heartbeat idempotency and preserves its retained audit',async()=>{
 const s=await approved(),body={configurationRevision:1,grantRevision:s.grantRevision,state:'checked',sourceAsOf:null,backlog:0};
 expect((await heartbeatSourceSubscription(opened.db,clock,actor,s.id,body,'same-heartbeat')).replayed).toBe(false);
 expect((await heartbeatSourceSubscription(opened.db,clock,actor,s.id,body,'same-heartbeat')).replayed).toBe(true);
 await action(s,'revoke',{reason:'Synthetic revocation'});
 await expect(heartbeatSourceSubscription(opened.db,clock,actor,s.id,body,'same-heartbeat')).rejects.toMatchObject({code:'SOURCE_AUTHORIZATION_REQUIRED'});
 expect((await opened.db.query('SELECT state,last_check_at FROM record_source_subscriptions WHERE id=$1',[s.id])).rows[0].state).toBe('revoked');
});
it('source-local pause does not stop another approved source',async()=>{
 const [a,b]=[await approved(),await approved()];await action(a,'pause',{reason:'Source A drift'});
 await expect(requireTypedSourceAuthority(opened.db,clock,actor,identity(a),'preview')).rejects.toMatchObject({code:'SOURCE_AUTHORIZATION_REQUIRED'});
 await expect(requireTypedSourceAuthority(opened.db,clock,actor,identity(b),'preview')).resolves.toMatchObject({subscriptionId:b.id});
 await expect(action(a,'resume',{reason:'Unsafe resume before recurring grant'})).rejects.toMatchObject({code:'INVALID_SOURCE_SUBSCRIPTION'});
});
it('versions configuration immutably and invalidates pending execution under an old revision',async()=>{
 const s=await approved();const revised=await action(s,'revise',{config:sourceConfig({mappingVersion:'synthetic-pilot/2'})});expect(revised.configurationRevision).toBe(2);expect(revised.state).toBe('proposed');
 await expect(requireTypedSourceAuthority(opened.db,clock,actor,identity(s),'read')).rejects.toMatchObject({code:'SOURCE_AUTHORIZATION_REQUIRED'});
 await expect(opened.db.query("UPDATE record_source_subscription_revisions SET configuration='{}' WHERE subscription_id=$1 AND revision=1",[s.id])).rejects.toThrow(/immutable/);
 await expect(opened.db.query('UPDATE record_source_subscriptions SET location_id=$2 WHERE id=$1',[s.id,siteB])).rejects.toThrow(/immutable/);
});
it('denies legacy Windows credentials at HTTP and domain boundaries before an explicit typed subscription',async()=>{
 await expect(authorizeAgentRoute(opened.db,clock,legacy,'POST','/typed-imports/preview')).rejects.toMatchObject({code:'AGENT_OPERATION_DENIED'});
 const app=express();app.use(express.json({limit:'3mb'}));app.use('/v1/partner',createPartnerRouter(deps));
 const input={...corpus.cases[0].input,connectionId:account,locationId:site,subscriptionId:'unapproved'};
 const denied=await request(app).post('/v1/partner/typed-imports/preview').set('Authorization',`Bearer ${legacyToken}`).send(input);expect(denied.status).toBe(403);expect(denied.body.code).toBe('AGENT_OPERATION_DENIED');
 await expect(previewTypedImport(deps,legacy,input,'legacy-direct-denied')).rejects.toMatchObject({code:'SOURCE_AUTHORIZATION_REQUIRED'});
});
it('does not allow changing bounds, widening local paths or claiming source completeness without a contract',()=>{
 expect(()=>parseSourceSubscriptionConfig({...sourceConfig(),maxRows:1001})).toThrow(/bounded/);
 expect(()=>parseSourceSubscriptionConfig({...sourceConfig(),constants:{orderId:'invented'}})).toThrow(/documented/);
 expect(()=>parseSourceSubscriptionConfig({...sourceConfig(),mapping:{quantity:'Qty'},expectedHeaders:['Order']})).toThrow(/documented/);
 expect(()=>parseSourceSubscriptionConfig({...sourceConfig(),constants:{property:'reportedLoadedQuantity'}})).toThrow(/unsupported/);
 expect(()=>parseSourceSubscriptionConfig({...sourceConfig(),completenessPolicy:{kind:'snapshot',scope:'shipment_line',sourceOwnerQualified:true,qualificationReference:null}})).toThrow(/documented/);
 expect(()=>parseSourceSubscriptionConfig({...sourceConfig(),transport:'local_ntfs',folderDigest:'a'.repeat(64),initialFileName:'../unapproved.csv',expectedHeaders:['Order']})).toThrow(/plain CSV/);
});
it('paginates complete source inventories beyond fifty without hiding additional sources',async()=>{
 for(let i=0;i<53;i++)await propose(sourceConfig({displayName:`Pagination source ${i}`}));
 const seen=new Set<string>();let cursor:string|null=null;let pages=0;
 do {const page=await listSourceSubscriptions(opened.db,w,{cursor});expect(page.subscriptions.length).toBeLessThanOrEqual(50);for(const s of page.subscriptions){expect(seen.has(s.id)).toBe(false);seen.add(s.id);}cursor=page.nextCursor;pages++;}while(cursor);
 const total=(await opened.db.query<{n:string}>('SELECT COUNT(*)::text n FROM record_source_subscriptions WHERE organization_id=$1',[w.organizationId])).rows[0].n;expect(seen.size).toBe(Number(total));expect(pages).toBeGreaterThan(1);
});
it('binds an approved Windows source to exact CSV schema, first filename and media type',async()=>{
 const csv=corpus.cases.find((c:any)=>c.name==='csv-leading-zero-identities-and-exact-locator').input;
 const headers=csv.original.content.split('\r\n')[0].split(',');
 const config=sourceConfig({transport:'local_ntfs',folderDigest:'b'.repeat(64),initialFileName:csv.original.name,initialOriginalSha256:csv.original.sha256,expectedHeaders:headers,mapping:csv.mapping,constants:csv.constants});
 const s=await approved(config,{principalId:legacyPrincipal,installationId:installation});
 const exact=identity(s,{originalName:csv.original.name,originalMediaType:'text/csv',headers});
 await expect(requireTypedSourceAuthority(opened.db,clock,legacy,exact,'preview')).rejects.toMatchObject({code:'SOURCE_COLLECTOR_VERSION_UNSUPPORTED'});
 // A source approval cannot make an older binary understand the new contract.
 // Simulate the separately installed compatible service's next heartbeat.
 await opened.db.query("UPDATE record_agent_installations SET version='0.2.0' WHERE id=$1",[installation]);
 await expect(requireTypedSourceAuthority(opened.db,clock,legacy,exact,'preview')).resolves.toMatchObject({installationId:installation});
 for(const changed of [{originalName:'renamed.csv'},{originalMediaType:'application/json'},{headers:[...headers,'UnexpectedCustomer']}])await expect(requireTypedSourceAuthority(opened.db,clock,legacy,{...exact,...changed},'preview')).rejects.toMatchObject({httpStatus:expect.any(Number)});
 const input={...csv,connectionId:account,locationId:site,subscriptionId:s.id,configurationRevision:s.configurationRevision,grantRevision:s.grantRevision};
 const p=await previewTypedImport(deps,legacy,input,'local-source-positive');expect(p.value.original.sha256).toBe(csv.original.sha256);
 await action(s,'revoke',{reason:'Finish synthetic fixture'});
 await expect(previewTypedImport(deps,legacy,input,'local-source-positive')).rejects.toMatchObject({code:'SOURCE_AUTHORIZATION_REQUIRED'});
});
it('rechecks the appointed operator on replay and does not resurrect revoked membership',async()=>{
 const s=await approved(),rollback=new Error('Restore membership only through transaction rollback');
 await expect(opened.db.transaction(async tx=>{
  await tx.query('UPDATE platform_memberships SET revoked_at=$2 WHERE id=$1',[w.membershipId,clock.now().toISOString()]);
  await expect(requireTypedSourceAuthority(tx,clock,actor,identity(s),'replay')).rejects.toMatchObject({code:'SOURCE_AUTHORIZATION_REQUIRED'});
  throw rollback;
 })).rejects.toBe(rollback);
 await expect(requireTypedSourceAuthority(opened.db,clock,actor,identity(s),'read')).resolves.toMatchObject({subscriptionId:s.id});
});
