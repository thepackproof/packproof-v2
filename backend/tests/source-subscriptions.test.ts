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
import {getOperationalCase,includePolicySourceCoverage,readCaseSourceCoverage,type CaseRow} from '../src/records/reconstruction.js';
import {synchronizeOperationalCaseProjection} from '../src/records/projection-worker.js';
import {authorizeAgentRoute,type AgentApprovedConfig} from '../src/records/agent-restrictions.js';
import {previewTypedImport,commitTypedImport,readTypedImport,processPendingTypedImports} from '../src/records/typed-imports.js';
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
 for(const flag of ['PACKPROOF_ORGANIZATIONS_ENABLED','PACKPROOF_TYPED_INTAKE_ENABLED','PACKPROOF_SOURCE_SUBSCRIPTIONS_ENABLED','PACKPROOF_MULTI_SOURCE_AGENT_ENABLED','PACKPROOF_CASE_RECONSTRUCTION_ENABLED','PACKPROOF_SOURCE_HEALTH_ENABLED','PACKPROOF_SOURCE_IDENTITY_V2_ENABLED','PACKPROOF_SOURCE_RULE_POLICIES_ENABLED','PACKPROOF_CROSS_CASE_ENABLED'])vi.stubEnv(flag,'true');
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

function operationalConfig(overrides:Partial<SourceSubscriptionConfig>={}):SourceSubscriptionConfig {return sourceConfig({batchSchema:'packproof.typed-source-batch/v2',sourceProfile:'packproof.operational-observations/v2',sourceNamespace:'operational-fixture',mapping:{sourceEventId:'Event',sourceRevision:'Revision'},identityPolicy:{schema:'packproof.source-identity-policy/v1',eventKey:{kind:'column'},revision:{kind:'column'}},completenessPolicy:{kind:'snapshot',scope:'tracking_package',sourceOwnerQualified:true,qualificationReference:'fixture-owner/inventory-v1'},...overrides});}
function labelPolicy(a:Awaited<ReturnType<typeof approved>>,b:Awaited<ReturnType<typeof approved>>):NonNullable<SourceSubscriptionConfig['rulePolicies']>{const binding=(s:typeof a)=>({subscriptionId:s.id,configurationRevision:s.configurationRevision,sourceNamespace:s.config.sourceNamespace});return {schema:'packproof.source-rule-policies/v1',version:'fixture-label/1',sourceOwnerQualified:true,qualificationReference:'fixture-owner/label-v1',labelAcceptance:{labelSource:binding(a),acceptanceSource:binding(b),subjectNamespace:'tracking-fixture',carrier:{code:'fixture-carrier',accountReference:'fixture-account',service:'fixture-service'},windowSeconds:3600,graceSeconds:600,labelCreatedValues:['CREATED'],labelVoidedValues:['VOID'],acceptedValues:['ACCEPTED']}};}
it('parses explicitly versioned source identity, rule and cross-case policies without widening v1',()=>{
 const crossCasePolicy:NonNullable<SourceSubscriptionConfig['crossCasePolicy']>={schema:'packproof.cross-case-source-policy/v1',version:'fixture-allocation/1',allowMultiOrderRows:true,partitionRule:'explicit_order_line_allocations',sharedEntityTypes:['handling_unit','load','stop'],sourceOwnerQualified:true,qualificationReference:'fixture-owner/allocation-v1'};
 const v2=operationalConfig({crossCasePolicy});expect(parseSourceSubscriptionConfig(v2)).toMatchObject({batchSchema:v2.batchSchema,identityPolicy:v2.identityPolicy,crossCasePolicy});
 expect(()=>parseSourceSubscriptionConfig({...v2,batchSchema:'packproof.typed-source-batch/v1'})).toThrow(/profile/);
 expect(()=>parseSourceSubscriptionConfig({...v2,identityPolicy:undefined})).toThrow(/identity policy/);
 expect(()=>parseSourceSubscriptionConfig({...v2,crossCasePolicy:{...crossCasePolicy,sourceOwnerQualified:false}})).toThrow(/source-qualified/);
 expect(()=>parseSourceSubscriptionConfig({...sourceConfig(),rulePolicies:{schema:'packproof.source-rule-policies/v1',version:'empty',sourceOwnerQualified:false,qualificationReference:null}})).toThrow(/at least one/);
});
it('binds operational policy roles to exact approved current source revisions and operational v2 scope',async()=>{
 const a=await approved(operationalConfig()),b=await approved(operationalConfig());const p=labelPolicy(a,b);
 await expect(approved(operationalConfig({rulePolicies:p}))).resolves.toMatchObject({state:'approved'});
 for(const bad of [{...p,labelAcceptance:{...p.labelAcceptance!,acceptanceSource:{...p.labelAcceptance!.acceptanceSource,configurationRevision:2}}},{...p,labelAcceptance:{...p.labelAcceptance!,acceptanceSource:{...p.labelAcceptance!.acceptanceSource,sourceNamespace:'unapproved-namespace'}}}])await expect(propose(operationalConfig({rulePolicies:bad}))).rejects.toMatchObject({code:'SOURCE_RULE_SCOPE_DENIED'});
 const otherSite=await approved(operationalConfig(),{locationId:siteB});await expect(propose(operationalConfig({rulePolicies:labelPolicy(a,otherSite)}))).rejects.toMatchObject({code:'SOURCE_RULE_SCOPE_DENIED'});
 const legacySource=await approved();await expect(propose(operationalConfig({rulePolicies:labelPolicy(a,legacySource)}))).rejects.toMatchObject({code:'SOURCE_RULE_PROFILE_DENIED'});
 const wrongScope=await approved(operationalConfig({completenessPolicy:{kind:'snapshot',scope:'shipment_line',sourceOwnerQualified:true,qualificationReference:'fixture-owner/line-v1'}}));await expect(propose(operationalConfig({rulePolicies:labelPolicy(a,wrongScope)}))).rejects.toMatchObject({code:'SOURCE_RULE_PROFILE_DENIED'});
 const oneProperty=await approved(operationalConfig({constants:{property:'carrierAcceptanceStatus'}}));await expect(propose(operationalConfig({rulePolicies:labelPolicy(a,oneProperty)}))).rejects.toMatchObject({code:'SOURCE_RULE_PROFILE_DENIED'});
 await action(b,'revise',{config:operationalConfig({mappingVersion:'changed-meaning/2'})});await expect(propose(operationalConfig({rulePolicies:p}))).rejects.toMatchObject({code:'SOURCE_RULE_SCOPE_DENIED'});
});

const compositeCorpus=JSON.parse(readFileSync(new URL('./fixtures/reconstruction/source-contract-corpus-v2.json',import.meta.url),'utf8'));
function compositeInput(){return structuredClone(compositeCorpus.cases.find((f:any)=>f.name==='composite-order-no-dedicated-ids').input);}
function compositeConfig():SourceSubscriptionConfig {const f=compositeInput();return sourceConfig({batchSchema:f.schema,identityPolicy:f.identityPolicy,sourceNamespace:f.sourceNamespace,sourceProfile:f.sourceProfile,mappingVersion:f.mappingVersion,mapping:f.mapping,constants:f.constants,initialOriginalSha256:f.original.sha256,expectedHeaders:f.original.content.split('\n')[0].split(',')});}
function compositeBatch(s:Awaited<ReturnType<typeof approved>>){return {...compositeInput(),connectionId:s.connectionId,locationId:s.locationId,subscriptionId:s.id,configurationRevision:s.configurationRevision,grantRevision:s.grantRevision};}
it('uses server-approved v2 identity policy for source heartbeats and rejects stale or changed authority',async()=>{
 const s=await approved(compositeConfig()),exact=identity(s,{batchSchema:s.config.batchSchema,identityPolicy:s.config.identityPolicy});
 const heartbeat={configurationRevision:s.configurationRevision,grantRevision:s.grantRevision,state:'checked',sourceAsOf:'2026-11-12T19:00:00Z',backlog:0};
 expect((await heartbeatSourceSubscription(opened.db,clock,actor,s.id,heartbeat,'v2-heartbeat-exact')).accepted).toBe(true);
 expect((await heartbeatSourceSubscription(opened.db,clock,actor,s.id,heartbeat,'v2-heartbeat-exact')).replayed).toBe(true);
 await expect(requireTypedSourceAuthority(opened.db,clock,actor,{...exact,batchSchema:undefined,identityPolicy:undefined},'read')).rejects.toMatchObject({code:'SOURCE_IDENTITY_POLICY_CHANGED'});
 await expect(requireTypedSourceAuthority(opened.db,clock,actor,{...exact,identityPolicy:{...s.config.identityPolicy,revision:{kind:'column'}}},'read')).rejects.toMatchObject({code:'SOURCE_IDENTITY_POLICY_CHANGED'});
 await action(s,'revise',{config:compositeConfig()});
 await expect(heartbeatSourceSubscription(opened.db,clock,actor,s.id,heartbeat,'v2-heartbeat-exact')).rejects.toMatchObject({code:'SOURCE_AUTHORIZATION_REQUIRED'});
});
it('keeps two approved composite source streams distinct on one connection and preserves replay authorization',async()=>{
 const first=await approved(compositeConfig()),second=await approved(compositeConfig());
 const batches=[];
 for(const [i,s]of [first,second].entries()){
  const p=await previewTypedImport(deps,actor,compositeBatch(s),`v2-source-isolation-${i}`);batches.push(p.value.id);
  await commitTypedImport(deps,actor,p.value.id,{previewVersion:p.value.previewVersion,originalSha256:p.value.original.sha256,importValidRows:false},`v2-source-isolation-commit-${i}`);
  await processPendingTypedImports(deps);
  const outcomes=(await opened.db.query<{status:string}>('SELECT status FROM record_typed_rows WHERE batch_id=$1 ORDER BY row_number',[p.value.id])).rows;
  expect(outcomes.map(r=>r.status)).toEqual(['accepted_linked','accepted_linked']);
 }
 const ledger=(await opened.db.query<{subscription_id:string;n:string}>('SELECT subscription_id,COUNT(*)::text n FROM record_typed_source_identities_v2 WHERE subscription_id=ANY($1::text[]) GROUP BY subscription_id ORDER BY subscription_id',[[first.id,second.id]])).rows;
 expect(ledger.map(r=>r.subscription_id).sort()).toEqual([first.id,second.id].sort());expect(ledger.map(r=>Number(r.n))).toEqual([2,2]);
 const keys=(await opened.db.query<{source_event_id:string;payload_sha256:string}>('SELECT source_event_id,payload_sha256 FROM record_typed_rows WHERE batch_id=ANY($1::text[]) ORDER BY batch_id,row_number',[batches])).rows;
 expect(keys[0].source_event_id).toBe(keys[2].source_event_id);expect(keys[0].payload_sha256).toBe(keys[2].payload_sha256);
 const repeated=await previewTypedImport(deps,actor,compositeBatch(first),'v2-source-isolation-repeat');
 await commitTypedImport(deps,actor,repeated.value.id,{previewVersion:repeated.value.previewVersion,originalSha256:repeated.value.original.sha256,importValidRows:false},'v2-source-isolation-repeat-commit');await processPendingTypedImports(deps);
 expect((await opened.db.query<{status:string}>('SELECT status FROM record_typed_rows WHERE batch_id=$1 ORDER BY row_number',[repeated.value.id])).rows.map(r=>r.status)).toEqual(['duplicate','duplicate']);
 const replay=await previewTypedImport(deps,actor,compositeBatch(first),'v2-source-isolation-0');expect(replay.replayed).toBe(true);
 await action(first,'revoke',{reason:'Verify current authority on cached source preview'});
 await expect(previewTypedImport(deps,actor,compositeBatch(first),'v2-source-isolation-0')).rejects.toMatchObject({code:'SOURCE_AUTHORIZATION_REQUIRED'});
});
it('requires the installed 0.3 candidate for v2 and keeps old source identity behavior available to 0.2',async()=>{
 const c=compositeConfig(),f=compositeInput();const s=await approved({...c,transport:'local_ntfs',folderDigest:'d'.repeat(64),initialFileName:f.original.name},{principalId:legacyPrincipal,installationId:installation});
 const exact=identity(s,{batchSchema:s.config.batchSchema,identityPolicy:s.config.identityPolicy,originalName:f.original.name,originalMediaType:'text/csv',headers:s.config.expectedHeaders});
 await opened.db.query("UPDATE record_agent_installations SET version='0.2.0' WHERE id=$1",[installation]);
 await expect(requireTypedSourceAuthority(opened.db,clock,legacy,exact,'preview')).rejects.toMatchObject({code:'SOURCE_COLLECTOR_VERSION_UNSUPPORTED'});
 await opened.db.query("UPDATE record_agent_installations SET version='0.3.0' WHERE id=$1",[installation]);
 await expect(requireTypedSourceAuthority(opened.db,clock,legacy,exact,'preview')).resolves.toMatchObject({installationId:installation});
 await expect(authorizeAgentRoute(opened.db,clock,legacy,'GET','/source-profiles')).resolves.toBeUndefined();
});

it('loads exact approved rule inventories with zero case observations and excludes cross-site references',async()=>{
 const a=await approved(operationalConfig()),b=await approved(operationalConfig()),policy=labelPolicy(a,b),host=await approved(operationalConfig({rulePolicies:policy}));
 const id=newId('case');await opened.db.query("INSERT INTO record_cases(id,organization_id,environment,location_id,location_key,operator_membership_id,root_namespace,root_type,root_external_id,created_at,updated_at) VALUES($1,$2,'sandbox',$3,$3,$4,'missing-feed-fixture','order',$1,$5,$5)",[id,w.organizationId,site,w.membershipId,clock.now().toISOString()]);
 const c=(await opened.db.query<CaseRow>('SELECT * FROM record_cases WHERE id=$1',[id])).rows[0];
 const sources=[await readCaseSourceCoverage(opened.db,clock,w,c,host.id,account,host.config.sourceNamespace)];
 await includePolicySourceCoverage(opened.db,clock,w,c,sources);expect(sources.map(source=>source.subscriptionId).sort()).toEqual([host.id,a.id,b.id].sort());
 for(const source of sources){expect(source.coverage).toBe('unknown');expect(source.completeness.asOf).toBeNull();expect(source.accountingGrain).toBe('source_subscription');}
 const foreign=await approved(operationalConfig(),{locationId:siteB}),forged={...sources[0],rulePolicies:labelPolicy(a,foreign)},scoped=[forged];await includePolicySourceCoverage(opened.db,clock,w,c,scoped);expect(scoped.some(source=>source.subscriptionId===foreign.id)).toBe(false);expect(scoped.some(source=>source.subscriptionId===a.id)).toBe(true);
 vi.stubEnv('PACKPROOF_SOURCE_RULE_POLICIES_ENABLED','false');try{const disabled=await readCaseSourceCoverage(opened.db,clock,w,c,host.id,account,host.config.sourceNamespace);expect(disabled.rulePolicies).toBeNull();const unchanged=[disabled];await includePolicySourceCoverage(opened.db,clock,w,c,unchanged);expect(unchanged).toHaveLength(1);expect(disabled.completeness).toEqual(sources[0].completeness);}finally{vi.stubEnv('PACKPROOF_SOURCE_RULE_POLICIES_ENABLED','true');}
});

it('stops new v2 admissions while preserving scoped accepted receipt reads when v2 identity is disabled',async()=>{
 const original=structuredClone(corpus.cases[0].input),config=operationalConfig({sourceProfile:original.sourceProfile,sourceNamespace:original.sourceNamespace,mappingVersion:original.mappingVersion,mapping:{},initialOriginalSha256:null,completenessPolicy:{kind:'unknown',scope:'shipment_line',sourceOwnerQualified:false,qualificationReference:null}}),source=await approved(config);
 const input={...original,schema:'packproof.typed-source-batch/v2',identityPolicy:config.identityPolicy,subscriptionId:source.id,configurationRevision:source.configurationRevision,grantRevision:source.grantRevision,connectionId:account,locationId:site};
 const p=await previewTypedImport(deps,actor,input,'read-after-v2-off-preview');await commitTypedImport(deps,actor,p.value.id,{previewVersion:p.value.previewVersion,originalSha256:p.value.original.sha256,importValidRows:false},'read-after-v2-off-commit');await processPendingTypedImports(deps,10);const accepted=await readTypedImport(deps,actor,p.value.id);expect(accepted.state).toBe('succeeded');
 const before=(await opened.db.query('SELECT id FROM record_typed_batches WHERE subscription_id=$1',[source.id])).rows;
 vi.stubEnv('PACKPROOF_SOURCE_IDENTITY_V2_ENABLED','false');try{expect((await readTypedImport(deps,actor,p.value.id)).rows).toEqual(accepted.rows);await expect(previewTypedImport(deps,actor,input,'v2-off-new-admission')).rejects.toMatchObject({code:'RECONSTRUCTION_CAPABILITY_DISABLED'});expect((await opened.db.query('SELECT id FROM record_typed_batches WHERE subscription_id=$1',[source.id])).rows).toEqual(before);}finally{vi.stubEnv('PACKPROOF_SOURCE_IDENTITY_V2_ENABLED','true');}
});

it('invalidates a ready case projection immediately when its bound installation pauses or becomes incompatible',async()=>{
 const previousPaged=process.env.PACKPROOF_PAGED_PROJECTIONS_ENABLED,previousRules=process.env.PACKPROOF_RECONSTRUCTION_RULES_ENABLED;
 vi.stubEnv('PACKPROOF_PAGED_PROJECTIONS_ENABLED','true');vi.stubEnv('PACKPROOF_RECONSTRUCTION_RULES_ENABLED','true');
 const csv=structuredClone(corpus.cases.find((c:any)=>c.name==='csv-leading-zero-identities-and-exact-locator').input);csv.original.content=csv.original.content.replace('O004,1,0010482','AGENT-HEALTH,1,AGENT-HEALTH-ORDER').replace('S-0021','AGENT-HEALTH-SHIP');csv.original.sha256=sha256Hex(csv.original.content);
 const headers=csv.original.content.split('\r\n')[0].split(','),config=sourceConfig({transport:'local_ntfs',folderDigest:'c'.repeat(64),initialFileName:csv.original.name,initialOriginalSha256:csv.original.sha256,expectedHeaders:headers,mapping:csv.mapping,constants:csv.constants,expectedIntervalSeconds:604800,completenessPolicy:{kind:'snapshot',scope:'shipment_line',sourceOwnerQualified:true,qualificationReference:'synthetic-agent-health'}});
 await opened.db.query("UPDATE record_agent_installations SET status='ready',version='0.3.0' WHERE id=$1",[installation]);
 try{
  const source=await approved(config,{principalId:legacyPrincipal,installationId:installation}),input={...csv,connectionId:account,locationId:site,subscriptionId:source.id,configurationRevision:source.configurationRevision,grantRevision:source.grantRevision};
  const p=await previewTypedImport(deps,legacy,input,'paused-agent-health-preview');await commitTypedImport(deps,legacy,p.value.id,{previewVersion:p.value.previewVersion,originalSha256:p.value.original.sha256,importValidRows:false},'paused-agent-health-commit');await processPendingTypedImports(deps,20);const accepted=await readTypedImport(deps,legacy,p.value.id);expect(accepted.counts.acceptedLinked).toBe(1);
  const active=await action(source,'activate',{recurringConsent:true,initialBatchId:p.value.id});await heartbeatSourceSubscription(opened.db,clock,legacy,source.id,{configurationRevision:active.configurationRevision,grantRevision:active.grantRevision,state:'checked',sourceAsOf:csv.completeness.asOf,backlog:0},'paused-agent-health-heartbeat');
  const caseId=accepted.caseIds[0];await synchronizeOperationalCaseProjection(opened.db,clock,w,caseId);const before=await getOperationalCase(opened.db,clock,w,caseId);expect(before.projectionStatus.state).toBe('ready');expect(before.sources.some(s=>s.subscriptionId===source.id&&s.coverage==='qualified'&&['current','quiet_checked'].includes(s.state))).toBe(true);
  await opened.db.query("UPDATE record_agent_installations SET status='paused' WHERE id=$1",[installation]);const paused=await getOperationalCase(opened.db,clock,w,caseId);expect(paused.projectionStatus.state).toBe('stale');expect(paused.case.issueCount).toBeNull();expect(paused.sources.find(s=>s.subscriptionId===source.id)?.state).toBe('offline');
  await opened.db.query("UPDATE record_agent_installations SET status='ready',version='0.1.2' WHERE id=$1",[installation]);const incompatible=await getOperationalCase(opened.db,clock,w,caseId);expect(incompatible.projectionStatus.state).toBe('stale');expect(incompatible.sources.find(s=>s.subscriptionId===source.id)?.state).toBe('offline');
  expect((await opened.db.query('SELECT id FROM record_typed_rows WHERE batch_id=$1',[p.value.id])).rows).toHaveLength(1);
 }finally{await opened.db.query("UPDATE record_agent_installations SET status='ready',version='0.3.0' WHERE id=$1",[installation]);vi.stubEnv('PACKPROOF_PAGED_PROJECTIONS_ENABLED',previousPaged??'false');vi.stubEnv('PACKPROOF_RECONSTRUCTION_RULES_ENABLED',previousRules??'false');}
},60000);
