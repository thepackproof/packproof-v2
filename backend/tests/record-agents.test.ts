import {beforeAll,afterAll,it,expect,vi} from 'vitest';
import {openIsolatedTestDatabase} from './isolated-test-database.js';
import {migrate} from '../src/db/migrate.js';
import {insertUser} from '../src/domain/users.js';
import {MemoryObjectStore} from './memory-object-store.js';
import type {AppDependencies} from '../src/app.js';
import {createOrganization,setOrganizationEntitlement,createIntegrationAccount,authenticatePartner} from '../src/platform/organizations.js';
import {requireRecordWorkspace,type RecordWorkspace} from '../src/records/access.js';
import {startEnrollment,decideEnrollment,redeemEnrollment,heartbeatAgent,proposeAgentConfig,actOnAgent,loadInstallation,agentView,renewAgentCredential,readEnrollment,agentWorkspace} from '../src/records/agent-enrollments.js';
import {sha256Hex} from '../src/hash.js';
import {authorizeAgentRoute} from '../src/records/agent-restrictions.js';
import {previewPartnerImport,commitPartnerImport,processPendingPartnerImports,readPartnerImport} from '../src/records/partner-imports.js';
let opened:Awaited<ReturnType<typeof openIsolatedTestDatabase>>,deps:AppDependencies,w:RecordWorkspace,org:string,member:string,owner:string;
class AgentTestStore extends MemoryObjectStore {
 async putIfAbsent(key:string,body:Buffer,type:string){if(await this.get(key))return {created:false};await this.put(key,body,type);return {created:true};}
 async digest(key:string){const d=await super.digest(key);return d?{...d,versionId:'test-version-1'}:null;}
}
let time=Date.now(),sequence=0;const clock={now:()=>new Date(time)};
beforeAll(async()=>{
 vi.stubEnv('PACKPROOF_ORGANIZATIONS_ENABLED','true');opened=await openIsolatedTestDatabase();await migrate(opened.db);
 const admin=await insertUser(opened.db,clock);owner=await insertUser(opened.db,clock);
 await opened.db.query("INSERT INTO user_verified_contacts(user_id,email_normalized,verified_at,source) VALUES($1,'nericollin@gmail.com',$2,'COGNITO')",[admin,clock.now().toISOString()]);
 org=(await createOrganization(opened.db,clock,admin,{kind:'MERCHANT',name:'Connect tests',ownerUserId:owner},'setup')).id;
 await setOrganizationEntitlement(opened.db,clock,admin,org,{enabled:true},'setup');
 member=(await opened.db.query<{id:string}>('SELECT id FROM platform_memberships WHERE organization_id=$1 AND user_id=$2',[org,owner])).rows[0].id;
 w=await requireRecordWorkspace(opened.db,owner,org,'sandbox',true);
 deps={db:opened.db,clock,objectStore:new AgentTestStore(),devAuth:true,testFixtures:true,webhookConfig:{encryptionKey:Buffer.alloc(32,7).toString('base64'),allowedHosts:[]}} as AppDependencies;
},90000);
afterAll(async()=>{await opened?.close();vi.unstubAllEnvs();});
async function enroll(){
 const account=(await createIntegrationAccount(opened.db,clock,owner,org,{provider:'csv',externalAccountId:`agent-source-${++sequence}`},'setup')).id;
 const e=await startEnrollment(deps,{deviceName:`PC ${sequence}`,version:'0.1.0'});
 await opened.db.transaction(tx=>decideEnrollment(deps,tx,w,e.id,{organizationId:org,environment:'sandbox',decision:'approve',comparisonCode:e.comparisonCode,integrationAccountId:account,operatorMembershipId:member,locationId:null,sourceName:'Scheduled CSV Export Folder v1'},'approve'));
 const result=await redeemEnrollment(deps,e.id,{redeemSecret:e.redeemSecret}) as {state:string;token:string;installationId:string};
 const actor=await authenticatePartner(opened.db,clock,`Bearer ${result.token}`,org,undefined,'test');
 return {e,account,result,actor};
}
async function ack(a:Awaited<ReturnType<typeof enroll>>){return heartbeatAgent(deps,a.actor,{version:'0.1.0',queueCount:0,enrollmentAcknowledged:true});}
const config=(account:string)=>({folderDigest:'a'.repeat(64),sourceName:'Scheduled CSV Export Folder v1',integrationAccountId:account,operatorMembershipId:member,locationId:null,mapping:{shipmentReference:'Reference',itemTitle:'Description',quantity:'Quantity'},timeZone:'America/New_York',importValidRows:false,offlineWindowHours:24});
const humanAction=async(id:string,body:Record<string,unknown>)=>{const i=await loadInstallation(opened.db,id);return opened.db.transaction(tx=>actOnAgent(deps,tx,w,id,{organizationId:org,environment:'sandbox',configRevision:i.config_revision,configSha256:i.config_sha256,...body},'human-command'));};
it('enrollment credentials replay only to the private secret and disappear after protected acknowledgement',async()=>{
 const a=await enroll();
 await expect(authorizeAgentRoute(opened.db,clock,a.actor,'POST','/imports/preview')).rejects.toMatchObject({code:'AGENT_AUTHORIZATION_REQUIRED'});
 await expect(redeemEnrollment(deps,a.e.id,{redeemSecret:'wrong-secret'})).rejects.toMatchObject({code:'ENROLLMENT_NOT_FOUND'});
 time+=5001;const replay=await redeemEnrollment(deps,a.e.id,{redeemSecret:a.e.redeemSecret}) as {token:string};expect(replay.token).toBe(a.result.token);
 const stored=(await opened.db.query<{credential_response:unknown}>('SELECT credential_response FROM record_agent_enrollments WHERE id=$1',[a.e.id])).rows[0];expect(JSON.stringify(stored)).not.toContain(a.result.token);
 await ack(a);const after=await redeemEnrollment(deps,a.e.id,{redeemSecret:a.e.redeemSecret});expect(after).toEqual({state:'acknowledged',installationId:a.result.installationId});
 expect((await opened.db.query('SELECT credential_response FROM record_agent_enrollments WHERE id=$1',[a.e.id])).rows[0].credential_response).toBeNull();
 const detail=await readEnrollment(deps,a.e.id,w);expect(detail.choices?.integrationAccounts.length).toBeGreaterThan(0);expect(detail.choices?.operators[0]).toHaveProperty('name');
 await expect(readEnrollment(deps,a.e.id,{...w,organizationId:'another-workspace'})).rejects.toMatchObject({code:'ENROLLMENT_NOT_FOUND'});
});
it('rechecks current workspace entitlement inside browser decisions rather than trusting a stale workspace object',async()=>{
 const a=await enroll();await ack(a);
 const pending=await startEnrollment(deps,{deviceName:`PC pending ${sequence}`,version:'0.1.0'});
 const rollback=new Error('rollback entitlement fixture');
 await expect(opened.db.transaction(async tx=>{
  await tx.query('UPDATE platform_organizations SET enabled=false WHERE id=$1',[org]);
  await expect(actOnAgent(deps,tx,w,a.result.installationId,{action:'pause'},'stale')).rejects.toMatchObject({code:'WORKSPACE_PENDING'});
  await expect(decideEnrollment(deps,tx,w,pending.id,{decision:'deny',comparisonCode:pending.comparisonCode},'stale')).rejects.toMatchObject({code:'WORKSPACE_PENDING'});
  throw rollback;
 })).rejects.toBe(rollback);
 expect((await loadInstallation(opened.db,a.result.installationId)).status).toBe('setup');
});
it('requires exact human config, whole-batch test authority and durable terminal import before activation',async()=>{
 const a=await enroll();await ack(a);const c=config(a.account),proposal=await proposeAgentConfig(deps,a.actor,c);
 expect((await loadInstallation(opened.db,a.result.installationId)).status).toBe('setup');
 await expect(humanAction(a.result.installationId,{action:'configure',proposalSha256:'changed'})).rejects.toMatchObject({code:'PROPOSAL_CHANGED'});
 await humanAction(a.result.installationId,{action:'configure',proposalSha256:proposal.proposalSha256});
 const original='\uFEFFReference,Description,Quantity,Unused\r\n000001,Parcel,2,kept original\r\n000002,"Quoted, parcel",1,also kept\r\n';
 const p=(await previewPartnerImport(deps,a.actor,'preview-exact',{integrationAccountId:c.integrationAccountId,operatorMembershipId:c.operatorMembershipId,sourceName:c.sourceName,mapping:c.mapping,timeZone:c.timeZone,csv:original})).value;
 expect(p.original.sha256).toBe(sha256Hex(Buffer.from(original,'utf8')));
 await expect(commitPartnerImport(deps,a.actor,p.id,'commit-exact',{previewVersion:p.previewVersion,importValidRows:false})).rejects.toMatchObject({code:'AGENT_TEST_APPROVAL_REQUIRED'});
 await expect(humanAction(a.result.installationId,{action:'activate'})).rejects.toMatchObject({code:'VERIFICATION_REQUIRED'});
 await humanAction(a.result.installationId,{action:'authorize_test',importId:p.id});
 await commitPartnerImport(deps,a.actor,p.id,'commit-exact',{previewVersion:p.previewVersion,importValidRows:false});
 await expect(humanAction(a.result.installationId,{action:'activate'})).rejects.toMatchObject({code:'VERIFICATION_REQUIRED'});
 await processPendingPartnerImports(deps);const terminal=await readPartnerImport(deps,a.actor,p.id);expect(terminal.state).toBe('succeeded');expect(terminal.recordIds).toHaveLength(2);
 const active=await humanAction(a.result.installationId,{action:'activate'});expect(active.state).toBe('active');expect(active.health.completedImports).toBe(1);expect(active.health.sourceFreshness).toBe('unknown');
 await expect(humanAction(a.result.installationId,{action:'activate',configRevision:0})).rejects.toMatchObject({code:'CONFIGURATION_CHANGED'});
 const forged=await heartbeatAgent(deps,a.actor,{version:'0.1.0',queueCount:0,lastScanAt:clock.now().toISOString()});expect(forged.health.completedImports).toBe(1);
 await expect(heartbeatAgent(deps,a.actor,{version:'0.1.0',queueCount:0,completedImports:999})).rejects.toMatchObject({code:'INVALID_REQUEST'});
 const newProposal=await proposeAgentConfig(deps,a.actor,{...c,folderDigest:'b'.repeat(64)});expect((await loadInstallation(opened.db,a.result.installationId)).status).toBe('active');
 time+=1;await humanAction(a.result.installationId,{action:'configure',proposalSha256:newProposal.proposalSha256});
 const reset=await loadInstallation(opened.db,a.result.installationId);expect(reset.test_import_id).toBeNull();expect(reset.verified_import_id).toBeNull();await expect(humanAction(reset.id,{action:'authorize_test',importId:p.id})).rejects.toBeDefined();
});
it('rejects location/source escalation, invalid mappings, forbidden routes and duplicate host ownership',async()=>{
 const a=await enroll();await ack(a);
 await expect(proposeAgentConfig(deps,a.actor,{...config(a.account),integrationAccountId:'another-source'})).rejects.toMatchObject({code:'BINDING_CHANGED'});
 await expect(proposeAgentConfig(deps,a.actor,{...config(a.account),mapping:{shipmentReference:'Reference'}})).rejects.toMatchObject({code:'INVALID_MAPPING'});
 for(const path of ['/event-stream','/proofs','/proofs/resolve','/webhooks','/proofs/guess/package'])await expect(authorizeAgentRoute(opened.db,clock,a.actor,'GET',path)).rejects.toMatchObject({code:'AGENT_OPERATION_DENIED'});
 const e=await startEnrollment(deps,{deviceName:'Replacement PC',version:'0.1.0'});
 await expect(opened.db.transaction(tx=>decideEnrollment(deps,tx,w,e.id,{organizationId:org,environment:'sandbox',decision:'approve',comparisonCode:e.comparisonCode,integrationAccountId:a.account,operatorMembershipId:member,locationId:null,sourceName:'Scheduled CSV Export Folder v1'},'duplicate'))).rejects.toMatchObject({code:'SOURCE_ALREADY_INSTALLED'});
 await humanAction(a.result.installationId,{action:'revoke'});await expect(authorizeAgentRoute(opened.db,clock,a.actor,'GET','/agent/config')).rejects.toMatchObject({code:'AGENT_AUTHORIZATION_REQUIRED'});
});
it('expires unacknowledged credentials without plaintext fallback or permanent polling secrets',async()=>{
 const a=await enroll();time+=600001;
 await expect(authorizeAgentRoute(opened.db,clock,a.actor,'POST','/agent/heartbeat')).rejects.toMatchObject({code:'AGENT_AUTHORIZATION_REQUIRED'});
 expect(await redeemEnrollment(deps,a.e.id,{redeemSecret:a.e.redeemSecret})).toEqual({state:'expired'});
 await expect(authenticatePartner(opened.db,clock,`Bearer ${a.result.token}`,org,undefined,'expired')).rejects.toMatchObject({code:'UNAUTHENTICATED'});
});
it('renews one successor only after quiescence, recovers a lost response and tolerates lost acknowledgement',async()=>{
 const a=await enroll();await ack(a);
 await expect(renewAgentCredential(deps,a.actor,'stable-renew',{})).rejects.toMatchObject({code:'RENEWAL_NOT_DUE'});
 time+=24*86400000;
 const next=await renewAgentCredential(deps,a.actor,'stable-renew',{}) as {token:string;credentialId:string};
 expect(await renewAgentCredential(deps,a.actor,'stable-renew',{})).toEqual(next);
 await expect(renewAgentCredential(deps,a.actor,'different-renew',{})).rejects.toMatchObject({code:'RENEWAL_PENDING'});
 await expect(authorizeAgentRoute(opened.db,clock,a.actor,'POST','/imports/preview')).rejects.toMatchObject({code:'AGENT_AUTHORIZATION_REQUIRED'});
 const successor=await authenticatePartner(opened.db,clock,`Bearer ${next.token}`,org,undefined,'renewal');
 await heartbeatAgent(deps,successor,{version:'0.1.0',queueCount:0,renewalAcknowledged:true});
 await heartbeatAgent(deps,successor,{version:'0.1.0',queueCount:0,renewalAcknowledged:true});
 await expect(authenticatePartner(opened.db,clock,`Bearer ${a.result.token}`,org,undefined,'old')).rejects.toMatchObject({code:'UNAUTHENTICATED'});
 expect((await agentView(deps,await loadInstallation(opened.db,a.result.installationId))).state).toBe('setup');
});
it('holds preview-bound credentials until explicit preserved-original resolution and cancels an unsafe successor save',async()=>{
 const a=await enroll();await ack(a);const c=config(a.account),proposal=await proposeAgentConfig(deps,a.actor,c);
 await humanAction(a.result.installationId,{action:'configure',proposalSha256:proposal.proposalSha256});
 const p=(await previewPartnerImport(deps,a.actor,'pending-before-renewal',{integrationAccountId:c.integrationAccountId,operatorMembershipId:c.operatorMembershipId,sourceName:c.sourceName,mapping:c.mapping,timeZone:c.timeZone,csv:'Reference,Description,Quantity\r\nPENDING-001,Parcel,1\r\n'})).value;
 time+=24*86400000;
 await expect(renewAgentCredential(deps,a.actor,'held-renewal',{})).rejects.toMatchObject({code:'IMPORTS_PENDING'});
 await humanAction(a.result.installationId,{action:'abandon_preview',importId:p.id});
 expect((await opened.db.query('SELECT state,original_sha256 FROM partner_import_jobs WHERE id=$1',[p.id])).rows[0]).toMatchObject({state:'action_needed',original_sha256:p.original.sha256});
 const next=await renewAgentCredential(deps,a.actor,'held-renewal',{}) as {credentialId:string;token:string};
 const cancelled=await renewAgentCredential(deps,a.actor,'cancel-save-failure',{cancelCredentialId:next.credentialId});
 expect(cancelled).toMatchObject({state:'cancelled'});expect(await renewAgentCredential(deps,a.actor,'cancel-save-failure',{cancelCredentialId:next.credentialId})).toEqual(cancelled);
 expect(await renewAgentCredential(deps,a.actor,'held-renewal',{})).toMatchObject({state:'cancelled'});
 await expect(authenticatePartner(opened.db,clock,`Bearer ${next.token}`,org,undefined,'unsafe-save')).rejects.toMatchObject({code:'UNAUTHENTICATED'});
 await expect(authenticatePartner(opened.db,clock,`Bearer ${a.result.token}`,org,undefined,'previous-safe')).resolves.toMatchObject({credentialId:a.actor.credentialId});
});
it('requires recent human authentication and refuses enrollment without protected server response storage',async()=>{
 const oldSession={...deps,devAuth:false,testFixtures:false,auth:{authenticate:async()=>({userId:owner,authenticatedAt:time/1000-400})}} as unknown as AppDependencies;
 await expect(agentWorkspace(oldSession,{},org,'sandbox',true)).rejects.toMatchObject({code:'RECENT_AUTHENTICATION_REQUIRED'});
 const malformedSession={...oldSession,auth:{authenticate:async()=>({userId:owner,authenticatedAt:Number.NaN})}} as unknown as AppDependencies;
 await expect(agentWorkspace(malformedSession,{},org,'sandbox',true)).rejects.toMatchObject({code:'RECENT_AUTHENTICATION_REQUIRED'});
 await expect(startEnrollment({...deps,webhookConfig:{encryptionKey:'',allowedHosts:[]}},{deviceName:'No protected storage',version:'0.1.0'})).rejects.toMatchObject({code:'SECRET_RESPONSE_UNAVAILABLE'});
});

it('reconciles a versioned scheduled source and never treats healthy scans or late backfill as fresh data',async()=>{
 const a=await enroll();await ack(a);
 const c={...config(a.account),mapping:{shipmentReference:'Reference',itemTitle:'Description',quantity:'Quantity',shippedAt:'Reported at'},sourceContract:{schema:'packproof.scheduled-csv/v1' as const,exporterName:'Synthetic receipt fixture',exporterVersion:'fixture-1',expectedHeaders:['Reference','Description','Quantity','Reported at'],expectedIntervalSeconds:60,backfillFrom:new Date(time-3600000).toISOString()}};
 const proposal=await proposeAgentConfig(deps,a.actor,c);await humanAction(a.result.installationId,{action:'configure',proposalSha256:proposal.proposalSha256});
 const input={integrationAccountId:a.account,operatorMembershipId:member,sourceName:c.sourceName,mapping:c.mapping,timeZone:c.timeZone,csv:`Reference,Description,Quantity,Reported at\r\nVERSIONED-0001,Parcel,1,${clock.now().toISOString()}\r\n`};
 const preview=(await previewPartnerImport(deps,a.actor,'versioned-source-first',input)).value;
 await humanAction(a.result.installationId,{action:'authorize_test',importId:preview.id});await commitPartnerImport(deps,a.actor,preview.id,'versioned-commit',{previewVersion:preview.previewVersion,importValidRows:false});await processPendingPartnerImports(deps);
 const active=await humanAction(a.result.installationId,{action:'activate'});
 expect(active.health.sourceFreshness).toBe('current');expect(active.health.sourceAccounting).toMatchObject({receivedExports:1,acceptedRows:1,duplicateRows:0,rejectedRows:0,pendingRows:0,linkedProofs:1});
 time+=61000;
 const scans=await heartbeatAgent(deps,a.actor,{version:'0.1.0',queueCount:0,lastScanAt:clock.now().toISOString(),lastExportAt:clock.now().toISOString(),lastReceiptReconciledAt:clock.now().toISOString()});
 expect(scans.health.serviceOnline).toBe(true);expect(scans.health.sourceFreshness).toBe('delayed');
 expect(scans.health.lastReceiptReconciledAt).toBe(clock.now().toISOString());expect(scans.health.sourceAccounting.receivedExports).toBe(1);
 expect(scans.health.conditions).toContainEqual(expect.objectContaining({code:'SOURCE_DELAYED',repair:expect.stringContaining('exporter')}));
 const repeated=await heartbeatAgent(deps,a.actor,{version:'0.1.0',queueCount:0,lastScanAt:clock.now().toISOString(),lastExportAt:clock.now().toISOString(),lastReceiptReconciledAt:clock.now().toISOString()});expect(repeated.health.history).toEqual(scans.health.history);
 const late=(await previewPartnerImport(deps,a.actor,'versioned-late-backfill',{...input,csv:`Reference,Description,Quantity,Reported at\r\nVERSIONED-0002,Old parcel,1,${new Date(time-120000).toISOString()}\r\n`})).value;
 await commitPartnerImport(deps,a.actor,late.id,'versioned-late-commit',{previewVersion:late.previewVersion,importValidRows:false});await processPendingPartnerImports(deps);
 const afterBackfill=await heartbeatAgent(deps,a.actor,{version:'0.1.0',queueCount:0});expect(afterBackfill.health.sourceFreshness).toBe('delayed');expect(afterBackfill.health.sourceAccounting).toMatchObject({receivedExports:2,acceptedRows:2,linkedProofs:2});
 const before=Number((await opened.db.query<{n:string}>('SELECT COUNT(*)::text n FROM partner_import_jobs WHERE principal_id=$1',[a.actor.principalId])).rows[0].n);
 await expect(previewPartnerImport(deps,a.actor,'versioned-drift',{...input,csv:input.csv.replace('Reported at\r\n','Reported at,Private extra\r\n').replace(',Parcel,1,',',Parcel,1,')})).rejects.toMatchObject({code:'MAPPING_NEEDS_REVIEW'});
 expect(Number((await opened.db.query<{n:string}>('SELECT COUNT(*)::text n FROM partner_import_jobs WHERE principal_id=$1',[a.actor.principalId])).rows[0].n)).toBe(before);
 for(let attempt=0;attempt<33;attempt++)await heartbeatAgent(deps,a.actor,{version:'0.1.0',queueCount:0,lastErrorCode:attempt%2?'MAPPING_NEEDS_REVIEW':'CSV_ENCODING_UNSUPPORTED'});
 const bounded=await heartbeatAgent(deps,a.actor,{version:'0.1.0',queueCount:0,lastErrorCode:'CSV_ENCODING_UNSUPPORTED'});expect(bounded.health.history).toHaveLength(30);expect(bounded.health.history.every(event=>event.configRevision===1)).toBe(true);
});
