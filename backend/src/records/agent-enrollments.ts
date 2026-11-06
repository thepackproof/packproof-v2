import { randomBytes, timingSafeEqual } from 'node:crypto';
import type { AppDependencies } from '../app.js';
import type { Database } from '../db/database.js';
import { DomainError } from '../domain/errors.js';
import { newId } from '../ids.js';
import { sha256Hex } from '../hash.js';
import { canonicalize } from '../canonical.js';
import { CSV_MAPPING_FIELDS, type CsvMapping } from './csv.js';
import { requireRecordWorkspace, requireRecordLocation, listRecordLocations, type RecordWorkspace } from './access.js';
import { strictBody, organizationAdmin, createServicePrincipal, issuePartnerCredential, auditOrganization, reauthorizePartner, type PartnerActor } from '../platform/organizations.js';
import { textField } from '../platform/tenants.js';
import { protectWebhookResponse, webhookConfigFromEnv } from '../platform/webhooks.js';

type Deps = Pick<AppDependencies, 'db'|'clock'|'auth'|'devAuth'|'testFixtures'|'webhookConfig'>;
export interface AgentConfig {
 folderDigest:string; sourceName:string; integrationAccountId:string; operatorMembershipId:string;
 locationId:string|null; mapping:CsvMapping; timeZone:string; importValidRows:boolean; offlineWindowHours:number;
}
export interface Installation {
 id:string; organization_id:string; environment:'sandbox'|'live'; principal_id:string; credential_id:string;
 integration_account_id:string; operator_membership_id:string; location_id:string|null; source_name:string;
 device_name:string; version:string; status:'setup'|'ready'|'active'|'paused'|'revoked';
 config_revision:number; approved_config:AgentConfig|null; config_sha256:string|null;
 pending_proposal:AgentConfig|null; pending_proposal_sha256:string|null; test_import_id:string|null; verified_import_id:string|null;
 approval_user_id:string; enrollment_expires_at:string; enrollment_acknowledged_at:string|null;
 created_at:string; updated_at:string; last_seen_at:string|null; heartbeat:Record<string,unknown>;
 renewal_credential_id:string|null; renewal_response:unknown; renewal_expires_at:string|null; renewal_key_hash:string|null;
}
interface Enrollment {id:string;secret_hash:string;comparison_code:string;device_name:string;version:string;state:string;created_at:string;expires_at:string;last_poll_at:string|null;installation_id:string|null;credential_response:unknown}
const scopes=['imports:read','imports:write','proofs:read','proofs:write'];
const iso=(x:string|Date|null)=>x?new Date(x).toISOString():null;
const fail=(code:string,message:string,status=409):never=>{throw new DomainError(code,message,status);};
function protection(deps:Deps,context:string){return protectWebhookResponse(`connect:${context}`,deps.webhookConfig??webhookConfigFromEnv());}
function ensureEncryption(deps:Deps){if(Buffer.from((deps.webhookConfig??webhookConfigFromEnv()).encryptionKey,'base64').length!==32)fail('SECRET_RESPONSE_UNAVAILABLE','Protected credential delivery is not configured',503);}
export async function agentWorkspace(deps:Deps,headers:Record<string,unknown>,organizationId:unknown,environment:unknown,mutating=false){
 const auth=await deps.auth.authenticate(headers as Parameters<Deps['auth']['authenticate']>[0]);
 if(mutating&&!(deps.devAuth&&deps.testFixtures)){
  const age=deps.clock.now().getTime()/1000-(auth.authenticatedAt??0);
  if(age<0||age>300)fail('RECENT_AUTHENTICATION_REQUIRED','Sign in again before approving this computer',401);
 }
 const workspace=await requireRecordWorkspace(deps.db,auth.userId,organizationId,environment,mutating);
 if(!['OWNER','ADMIN'].includes(workspace.role))fail('AGENT_ADMIN_REQUIRED','A workspace owner or administrator must approve this connection',403);
 await organizationAdmin(deps.db,auth.userId,workspace.organizationId);
 return workspace;
}
export async function loadInstallation(db:Database,id:string,lock=false){
 if(lock){const p=(await db.query<{principal_id:string}>('SELECT principal_id FROM record_agent_installations WHERE id=$1',[id])).rows[0];if(p)await db.query('SELECT pg_advisory_xact_lock(1347438148,hashtext($1))',[p.principal_id]);}
 const row=(await db.query<Installation>(`SELECT * FROM record_agent_installations WHERE id=$1${lock?' FOR UPDATE':''}`,[id])).rows[0];
 if(!row)fail('INSTALLATION_NOT_FOUND','Installation not found',404);return row;
}
export async function installationForActor(db:Database,a:PartnerActor,lock=false){
 if(lock)await db.query('SELECT pg_advisory_xact_lock(1347438148,hashtext($1))',[a.principalId]);
 const row=(await db.query<Installation>(`SELECT * FROM record_agent_installations WHERE principal_id=$1${lock?' FOR UPDATE':''}`,[a.principalId])).rows[0];
 if(!row||row.organization_id!==a.merchantId||row.environment!==a.environment||![row.credential_id,row.renewal_credential_id].includes(a.credentialId))fail('INSTALLATION_NOT_FOUND','Installation not found',404);
 return row;
}
export async function startEnrollment(deps:Deps,input:unknown){
 ensureEncryption(deps);
 const b=strictBody(input,['deviceName','version']),name=textField(b.deviceName,'deviceName',100),version=textField(b.version,'version',40),now=deps.clock.now(),hash=sha256Hex(name);
 return deps.db.transaction(async tx=>{
  await tx.query('SELECT pg_advisory_xact_lock(1347438147,hashtext($1))',[`agent-enrollment:${hash}`]);
  const pending=(await tx.query<{n:string}>("SELECT COUNT(*)::text n FROM record_agent_enrollments WHERE device_hash=$1 AND state='pending' AND expires_at>$2",[hash,now.toISOString()])).rows[0];
  if(Number(pending.n)>=3)fail('ENROLLMENT_LIMIT','Finish or wait for an existing setup request to expire',429);
  const id=newId('enrollment'),secret=randomBytes(32).toString('base64url'),code=randomBytes(5).toString('hex').toUpperCase(),expiresAt=new Date(now.getTime()+600000).toISOString();
  await tx.query('INSERT INTO record_agent_enrollments(id,secret_hash,comparison_code,device_name,device_hash,version,created_at,expires_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',[id,sha256Hex(secret),code,name,hash,version,now.toISOString(),expiresAt]);
  return {id,redeemSecret:secret,comparisonCode:code,expiresAt,pollAfterSeconds:5,approvalPath:`/app/records/connect/approve?enrollmentId=${encodeURIComponent(id)}`};
 });
}
async function enrollment(db:Database,id:string,lock=false){
 const row=(await db.query<Enrollment>(`SELECT * FROM record_agent_enrollments WHERE id=$1${lock?' FOR UPDATE':''}`,[id])).rows[0];
 if(!row)fail('ENROLLMENT_NOT_FOUND','Setup request not found',404);return row;
}
export async function readEnrollment(deps:Deps,id:string,w?:RecordWorkspace){
 const e=await enrollment(deps.db,id);
 const choices=w?{integrationAccounts:(await deps.db.query(`SELECT id,provider AS name,external_account_id AS "sourceSystem" FROM platform_integration_accounts WHERE merchant_id=$1 AND environment=$2 ORDER BY provider,id LIMIT 100`,[w.organizationId,w.environment])).rows,operators:(await deps.db.query(`SELECT m.id,COALESCE(u.display_name,u.username,'Team member') AS name,m.role FROM platform_memberships m JOIN users u ON u.id=m.user_id WHERE m.organization_id=$1 AND m.revoked_at IS NULL AND m.role IN ('OWNER','ADMIN','OPERATOR') AND u.status='ACTIVE' ORDER BY m.id LIMIT 200`,[w.organizationId])).rows,locations:await listRecordLocations(deps.db,w)}:undefined;
 return {id:e.id,comparisonCode:e.comparison_code,deviceName:e.device_name,version:e.version,state:new Date(e.expires_at)<=deps.clock.now()&&e.state!=='acknowledged'?'expired':e.state,expiresAt:iso(e.expires_at),...(choices?{choices}:{})};
}
export async function redeemEnrollment(deps:Deps,id:string,input:unknown){
 const b=strictBody(input,['redeemSecret']),secret=textField(b.redeemSecret,'redeemSecret',100);
 return deps.db.transaction(async tx=>{
  const e=await enrollment(tx,id,true),actual=Buffer.from(sha256Hex(secret),'hex'),expected=Buffer.from(e.secret_hash,'hex');
  if(!timingSafeEqual(actual,expected))fail('ENROLLMENT_NOT_FOUND','Setup request not found',404);
  const now=deps.clock.now();
  if(e.state==='acknowledged')return {state:'acknowledged',installationId:e.installation_id};
  if(new Date(e.expires_at)<=now){
   if(e.installation_id){const i=await loadInstallation(tx,e.installation_id,true);await tx.query('UPDATE platform_credentials SET revoked_at=COALESCE(revoked_at,$2) WHERE id=$1',[i.credential_id,now.toISOString()]);await tx.query("UPDATE record_agent_installations SET status='revoked',updated_at=$2 WHERE id=$1",[i.id,now.toISOString()]);}
   await tx.query("UPDATE record_agent_enrollments SET state='expired',credential_response=NULL WHERE id=$1",[id]);return {state:'expired'};
  }
  if(e.last_poll_at&&now.getTime()-new Date(e.last_poll_at).getTime()<5000)fail('ENROLLMENT_SLOW_DOWN','Wait five seconds before checking approval again',429);
  await tx.query('UPDATE record_agent_enrollments SET last_poll_at=$2 WHERE id=$1',[id,now.toISOString()]);
  if(e.state!=='approved')return {state:e.state};
  const i=await loadInstallation(tx,e.installation_id!);
  if(i.status==='revoked')return {state:'denied'};
  return {state:'credential',...protection(deps,`enrollment:${id}`).open(e.credential_response) as object};
 });
}
async function validateBinding(db:Database,w:RecordWorkspace,b:Record<string,unknown>){
 const account=textField(b.integrationAccountId,'integrationAccountId'),operator=textField(b.operatorMembershipId,'operatorMembershipId'),sourceName=textField(b.sourceName,'sourceName',80),locationId=await requireRecordLocation(db,w,b.locationId);
 if(!(await db.query('SELECT 1 FROM platform_integration_accounts WHERE id=$1 AND merchant_id=$2 AND environment=$3',[account,w.organizationId,w.environment])).rows[0])fail('INTEGRATION_NOT_FOUND','Choose an integration account in this workspace',404);
 const m=(await db.query<{location_scoped:boolean}>(`SELECT m.location_scoped FROM platform_memberships m JOIN users u ON u.id=m.user_id WHERE m.id=$1 AND m.organization_id=$2 AND m.revoked_at IS NULL AND m.role IN ('OWNER','ADMIN','OPERATOR') AND u.status='ACTIVE'`,[operator,w.organizationId])).rows[0];
 if(!m)fail('OPERATOR_NOT_AUTHORIZED','Choose an active responsible teammate',403);
 if(m.location_scoped&&(!locationId||!(await db.query('SELECT 1 FROM record_membership_locations WHERE membership_id=$1 AND location_id=$2 AND organization_id=$3',[operator,locationId,w.organizationId])).rows[0]))fail('LOCATION_NOT_FOUND','The teammate needs an explicit grant for this location',404);
 return {account,operator,sourceName,locationId};
}
export async function decideEnrollment(deps:Deps,tx:Database,w:RecordWorkspace,id:string,input:unknown,requestId:string){
 ensureEncryption(deps);
 const b=strictBody(input,['organizationId','environment','decision','comparisonCode','integrationAccountId','operatorMembershipId','locationId','sourceName']),e=await enrollment(tx,id,true);
 if(e.state!=='pending'||new Date(e.expires_at)<=deps.clock.now())fail('ENROLLMENT_UNAVAILABLE','This setup request has ended; start again on the computer');
 if(b.comparisonCode!==e.comparison_code)fail('COMPARISON_CODE_MISMATCH','Compare the code shown on the setup computer',400);
 if(!['approve','deny'].includes(String(b.decision)))fail('INVALID_REQUEST','Choose approve or deny',400);
 if(b.decision==='deny'){await tx.query("UPDATE record_agent_enrollments SET state='denied' WHERE id=$1",[id]);return {state:'denied'};}
 const binding=await validateBinding(tx,w,b);
 await tx.query('SELECT pg_advisory_xact_lock(1347438147,hashtext($1))',[`agent-source:${w.organizationId}:${binding.account}`]);
 if((await tx.query("SELECT 1 FROM record_agent_installations WHERE organization_id=$1 AND environment=$2 AND integration_account_id=$3 AND status<>'revoked'",[w.organizationId,w.environment,binding.account])).rows[0])fail('SOURCE_ALREADY_INSTALLED','Revoke the existing installation before explicitly replacing it');
 const principal=await createServicePrincipal(tx,deps.clock,w.userId,w.organizationId,{name:`Connect ${e.device_name}`},requestId),expiresAt=new Date(deps.clock.now().getTime()+30*86400000).toISOString();
 const credential=await issuePartnerCredential(tx,deps.clock,w.userId,w.organizationId,principal.id,{scopes,expiresAt},requestId),installationId=newId('installation'),now=deps.clock.now().toISOString();
 await tx.query(`INSERT INTO record_agent_installations(id,organization_id,environment,principal_id,credential_id,integration_account_id,operator_membership_id,location_id,source_name,device_name,version,approval_user_id,enrollment_expires_at,created_at,updated_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$14)`,[installationId,w.organizationId,w.environment,principal.id,credential.id,binding.account,binding.operator,binding.locationId,binding.sourceName,e.device_name,e.version,w.userId,e.expires_at,now]);
 const response={installationId,credentialId:credential.id,token:credential.token,expiresAt,organizationId:w.organizationId,environment:w.environment};
 await tx.query("UPDATE record_agent_enrollments SET state='approved',installation_id=$2,credential_response=$3::jsonb WHERE id=$1",[id,installationId,JSON.stringify(protection(deps,`enrollment:${id}`).seal(response))]);
 await auditOrganization(tx,deps.clock,{userId:w.userId,merchantId:w.organizationId,requestId,operation:'AGENT_ENROLLMENT_APPROVED',resourceId:installationId});
 return {state:'approved',installationId};
}
export async function agentView(deps:Deps,i:Installation,db=deps.db){
 const last=(await db.query<{completed_at:string|null;completed_imports:string}>(`SELECT MAX(updated_at) completed_at,COUNT(*)::text completed_imports FROM partner_import_jobs WHERE principal_id=$1 AND state='succeeded'`,[i.principal_id])).rows[0];
 const expiry=(await db.query<{expires_at:string}>('SELECT expires_at FROM platform_credentials WHERE id=$1',[i.credential_id])).rows[0];
 return {id:i.id,installationId:i.id,state:i.status,authorizationUpdatedAt:iso(i.updated_at),deviceName:i.device_name,version:i.version,integrationAccountId:i.integration_account_id,operatorMembershipId:i.operator_membership_id,locationId:i.location_id,sourceName:i.source_name,organizationId:i.organization_id,environment:i.environment,configRevision:i.config_revision,configSha256:i.config_sha256,config:i.approved_config,pendingProposal:i.pending_proposal,pendingProposalSha256:i.pending_proposal_sha256,testImportId:i.test_import_id,verifiedImportId:i.verified_import_id,lastSeenAt:iso(i.last_seen_at),credentialExpiresAt:iso(expiry?.expires_at??null),health:{serviceOnline:!!i.last_seen_at&&deps.clock.now().getTime()-new Date(i.last_seen_at).getTime()<180000,lastFolderScanAt:i.heartbeat.lastScanAt??null,lastObservedExportAt:i.heartbeat.lastExportAt??null,lastCompletedImportAt:iso(last?.completed_at??null),completedImports:Number(last?.completed_imports??0),queueCount:i.heartbeat.queueCount??null,sourceFreshness:'unknown',lastErrorCode:i.heartbeat.lastErrorCode??null},limits:{maxCsvBytes:2097152,maxRows:1000,maxColumns:50,maxJsonBytes:6291456,scanIntervalSeconds:30,heartbeatIntervalSeconds:60,offlineWindowSeconds:(i.approved_config?.offlineWindowHours??0)*3600}};
}
export async function readAgentInventory(deps:Deps,w:RecordWorkspace){
 const rs=(await deps.db.query<Installation>('SELECT * FROM record_agent_installations WHERE organization_id=$1 AND environment=$2 ORDER BY created_at DESC,id LIMIT 100',[w.organizationId,w.environment])).rows;
 return {installations:await Promise.all(rs.map(i=>agentView(deps,i)))};
}
export async function ownedImport(db:Database,i:Installation,id:string){
 const j=(await db.query<{id:string;state:string;integration_account_id:string;operator_membership_id:string;source_name:string;mapping:CsvMapping;time_zone:string;original_sha256:string;original_byte_size:number;preview_version:string;import_valid_rows:boolean;agent_installation_id:string;agent_config_revision:number}>(`SELECT * FROM partner_import_jobs WHERE id=$1 AND organization_id=$2 AND environment=$3 AND principal_id=$4 AND integration_account_id=$5`,[id,i.organization_id,i.environment,i.principal_id,i.integration_account_id])).rows[0];
 if(!j)fail('IMPORT_NOT_FOUND','Import not found',404);
 if(!i.approved_config||j.agent_installation_id!==i.id||j.agent_config_revision!==i.config_revision||j.source_name!==i.approved_config.sourceName||j.operator_membership_id!==i.operator_membership_id||j.time_zone!==i.approved_config.timeZone||canonicalize(j.mapping)!==canonicalize(i.approved_config.mapping))fail('CONFIGURATION_CHANGED','This import does not match the currently approved configuration');
 const counts=(await db.query<{status:string;n:string}>('SELECT status,COUNT(*)::text n FROM partner_import_rows WHERE import_id=$1 GROUP BY status',[id])).rows;
 const rs=(await db.query<{location_id:string|null}>("SELECT normalized->>'locationId' location_id FROM partner_import_rows WHERE import_id=$1 AND normalized IS NOT NULL",[id])).rows;
 if(rs.some(r=>(r.location_id??null)!==i.location_id))fail('LOCATION_NOT_FOUND','The batch contains an unapproved location',404);
 return {id:j.id,state:j.state,previewVersion:j.preview_version,original:{sha256:j.original_sha256,byteSize:j.original_byte_size},counts:Object.fromEntries(counts.map(r=>[r.status,Number(r.n)])),totalRows:counts.reduce((n,r)=>n+Number(r.n),0)};
}
export async function readAgentDetail(deps:Deps,w:RecordWorkspace,id:string,importId?:string){
 const i=await loadInstallation(deps.db,id);
 if(i.organization_id!==w.organizationId||i.environment!==w.environment)fail('INSTALLATION_NOT_FOUND','Installation not found',404);
 return {...await agentView(deps,i),...(importId?{testCandidate:await ownedImport(deps.db,i,importId)}:{})};
}
export async function actOnAgent(deps:Deps,tx:Database,w:RecordWorkspace,id:string,input:unknown,requestId:string){
 const b=strictBody(input,['organizationId','environment','action','proposalSha256','importId','configRevision','configSha256']),i=await loadInstallation(tx,id,true),now=deps.clock.now().toISOString();
 if(i.organization_id!==w.organizationId||i.environment!==w.environment)fail('INSTALLATION_NOT_FOUND','Installation not found',404);
 if(i.status==='revoked')fail('INSTALLATION_REVOKED','Enroll again to restore this connection');
 if(['authorize_test','abandon_preview','activate','resume'].includes(String(b.action))&&(b.configRevision!==i.config_revision||b.configSha256!==i.config_sha256))fail('CONFIGURATION_CHANGED','Refresh and review the exact current configuration before approving');
 if(b.action==='revoke'){
  await tx.query("UPDATE record_agent_installations SET status='revoked',renewal_response=NULL,updated_at=$2 WHERE id=$1",[id,now]);
  await tx.query('UPDATE platform_credentials SET revoked_at=COALESCE(revoked_at,$3) WHERE id IN ($1,$2)',[i.credential_id,i.renewal_credential_id,now]);
 }else if(b.action==='configure'){
  if(!i.pending_proposal||b.proposalSha256!==i.pending_proposal_sha256)fail('PROPOSAL_CHANGED','Refresh and review the exact proposed configuration');
  await validateBinding(tx,w,i.pending_proposal as unknown as Record<string,unknown>);
  if((await tx.query("SELECT 1 FROM partner_import_jobs WHERE principal_id=$1 AND state IN ('queued','running') LIMIT 1",[i.principal_id])).rows[0])fail('IMPORTS_PENDING','Wait for accepted imports before changing configuration');
  await tx.query("UPDATE record_agent_installations SET approved_config=pending_proposal,config_sha256=pending_proposal_sha256,config_revision=config_revision+1,pending_proposal=NULL,pending_proposal_sha256=NULL,test_import_id=NULL,verified_import_id=NULL,status='ready',approval_user_id=$2,updated_at=$3 WHERE id=$1",[id,w.userId,now]);
 }else if(b.action==='authorize_test'){
  const j=await ownedImport(tx,i,textField(b.importId,'importId'));
  if(j.state!=='previewed'||j.totalRows<1||Object.entries(j.counts).some(([status,n])=>status!=='valid'&&n>0))fail('TEST_PREVIEW_INVALID','The first test needs a completely valid preview; approve the entire displayed batch');
  if(new Date((await tx.query<{received_at:string}>('SELECT received_at FROM partner_import_jobs WHERE id=$1',[j.id])).rows[0].received_at)<new Date(i.updated_at))fail('CONFIGURATION_CHANGED','Create a new preview after configuration approval');
  await tx.query('UPDATE record_agent_installations SET test_import_id=$2,verified_import_id=NULL,updated_at=$3 WHERE id=$1',[id,j.id,now]);
 }else if(b.action==='abandon_preview'){
  const j=await ownedImport(tx,i,textField(b.importId,'importId'));
  if(j.state!=='previewed')fail('PREVIEW_ALREADY_COMMITTED','Only an uncommitted preview can be explicitly abandoned');
  await tx.query("UPDATE partner_import_jobs SET state='action_needed',last_error_code='AGENT_PREVIEW_ABANDONED',updated_at=$2 WHERE id=$1",[j.id,now]);
  await tx.query('UPDATE record_agent_installations SET test_import_id=CASE WHEN test_import_id=$2 THEN NULL ELSE test_import_id END,updated_at=$3 WHERE id=$1',[id,j.id,now]);
 }else if(b.action==='activate'||b.action==='resume'){
  if(!i.test_import_id||!i.approved_config)fail('VERIFICATION_REQUIRED','Verify the approved source before enabling automatic collection');
  const j=await ownedImport(tx,i,i.test_import_id!);
  const actual=(await tx.query(`SELECT 1 FROM partner_import_rows r JOIN proofs p ON p.id=r.proof_id WHERE r.import_id=$1 AND r.status='imported' LIMIT 1`,[j.id])).rows[0];
  if(j.state!=='succeeded'||!actual)fail('VERIFICATION_REQUIRED','Wait for every row outcome and a durable canonical record');
  await validateBinding(tx,w,i.approved_config as unknown as Record<string,unknown>);
  await tx.query("UPDATE record_agent_installations SET status='active',verified_import_id=test_import_id,approval_user_id=$2,updated_at=$3 WHERE id=$1",[id,w.userId,now]);
 }else if(b.action==='pause')await tx.query("UPDATE record_agent_installations SET status='paused',updated_at=$2 WHERE id=$1",[id,now]);
 else fail('INVALID_REQUEST','Choose a documented installation action',400);
 await auditOrganization(tx,deps.clock,{userId:w.userId,merchantId:w.organizationId,requestId,operation:`AGENT_${String(b.action).toUpperCase()}`,resourceId:id});
 return agentView(deps,await loadInstallation(tx,id),tx);
}
export function validateAgentConfig(input:unknown,i:Installation):AgentConfig{
 const b=strictBody(input,['folderDigest','sourceName','integrationAccountId','operatorMembershipId','locationId','mapping','timeZone','importValidRows','offlineWindowHours']);
 if(typeof b.folderDigest!=='string'||!/^[a-f0-9]{64}$/.test(b.folderDigest))fail('INVALID_REQUEST','Use the service-verified folder fingerprint',400);
 if(b.integrationAccountId!==i.integration_account_id||b.operatorMembershipId!==i.operator_membership_id||b.sourceName!==i.source_name||(b.locationId??null)!==i.location_id)fail('BINDING_CHANGED','A different source or teammate needs a new administrator-approved enrollment');
 if(typeof b.importValidRows!=='boolean'||typeof b.offlineWindowHours!=='number'||![0,24].includes(b.offlineWindowHours))fail('INVALID_REQUEST','Choose a supported row policy and offline collection window',400);
 const mapping=b.mapping as Record<string,unknown>|null;
 if(!mapping||Array.isArray(mapping)||typeof mapping!=='object'||Object.keys(mapping).some(k=>!CSV_MAPPING_FIELDS.includes(k as typeof CSV_MAPPING_FIELDS[number]))||Object.values(mapping).some(v=>typeof v!=='string'||!v.trim()||v.length>200)||!mapping.shipmentReference||!mapping.itemTitle||!mapping.quantity)fail('INVALID_MAPPING','Confirm reference, description and quantity columns',400);
 if(new Set(Object.values(mapping!)).size!==Object.values(mapping!).length)fail('INVALID_MAPPING','Each field must use a distinct exact column heading',400);
 if(typeof b.timeZone!=='string'||b.timeZone.length>100)fail('INVALID_TIME_ZONE','Choose an explicit source time zone',400);
 try{new Intl.DateTimeFormat('en-US',{timeZone:b.timeZone as string}).format();}catch{fail('INVALID_TIME_ZONE','Choose an IANA source time zone',400);}
 return b as unknown as AgentConfig;
}
export async function proposeAgentConfig(deps:Deps,a:PartnerActor,input:unknown){
 return deps.db.transaction(async tx=>{
  await reauthorizePartner(tx,deps.clock,a,'imports:read');const i=await installationForActor(tx,a,true);
  if(i.status==='revoked')fail('INSTALLATION_REVOKED','This installation was revoked',403);
  const config=validateAgentConfig(input,i),digest=sha256Hex(canonicalize(config));
  await tx.query('UPDATE record_agent_installations SET pending_proposal=$2::jsonb,pending_proposal_sha256=$3 WHERE id=$1',[i.id,JSON.stringify(config),digest]);
  return {proposalSha256:digest,approvalPath:`/app/records/connect/approve?installationId=${encodeURIComponent(i.id)}`};
 });
}
export async function heartbeatAgent(deps:Deps,a:PartnerActor,input:unknown){
 const b=strictBody(input,['enrollmentAcknowledged','renewalAcknowledged','version','queueCount','lastScanAt','lastExportAt','lastErrorCode']);
 if(typeof b.version!=='string'||b.version.length>40||!Number.isInteger(b.queueCount)||Number(b.queueCount)<0||Number(b.queueCount)>10000)fail('INVALID_REQUEST','Send bounded service health measurements',400);
 for(const k of ['lastScanAt','lastExportAt'])if(b[k]!==undefined&&b[k]!==null&&(typeof b[k]!=='string'||!Number.isFinite(Date.parse(b[k] as string))||Date.parse(b[k] as string)>deps.clock.now().getTime()+60000))fail('INVALID_REQUEST','Send a valid observed timestamp',400);
 if(b.lastErrorCode!==undefined&&b.lastErrorCode!==null&&(typeof b.lastErrorCode!=='string'||!/^[A-Z0-9_]{1,80}$/.test(b.lastErrorCode)))fail('INVALID_REQUEST','Send a safe diagnostic code',400);
 return deps.db.transaction(async tx=>{
  const i=await installationForActor(tx,a,true),now=deps.clock.now().toISOString();
  await reauthorizePartner(tx,deps.clock,a,'imports:read');
  if(i.status==='revoked')fail('INSTALLATION_REVOKED','This installation was revoked',403);
  if(!i.enrollment_acknowledged_at&&new Date(i.enrollment_expires_at)<=deps.clock.now())fail('ENROLLMENT_EXPIRED','Start browser approval again',403);
  if(b.enrollmentAcknowledged===true&&!i.enrollment_acknowledged_at){
   await tx.query('UPDATE record_agent_installations SET enrollment_acknowledged_at=$2 WHERE id=$1',[i.id,now]);
   await tx.query("UPDATE record_agent_enrollments SET state='acknowledged',credential_response=NULL WHERE installation_id=$1",[i.id]);
  }
  if(b.renewalAcknowledged===true&&!(a.credentialId===i.credential_id&&!i.renewal_credential_id)){
   if(a.credentialId!==i.renewal_credential_id||!i.renewal_expires_at||new Date(i.renewal_expires_at)<=deps.clock.now())fail('RENEWAL_UNAVAILABLE','Renewal acknowledgement expired; retain the previous credential and request recovery');
   await tx.query('UPDATE platform_credentials SET revoked_at=COALESCE(revoked_at,$2) WHERE id=$1',[i.credential_id,now]);
   await tx.query('UPDATE record_agent_installations SET credential_id=renewal_credential_id,renewal_credential_id=NULL,renewal_response=NULL,renewal_expires_at=NULL,renewal_key_hash=NULL WHERE id=$1',[i.id]);
  }
  const {enrollmentAcknowledged:_,renewalAcknowledged:__,...safe}=b;
  await tx.query('UPDATE record_agent_installations SET last_seen_at=$2,version=$3,heartbeat=$4::jsonb WHERE id=$1',[i.id,now,b.version,JSON.stringify(safe)]);
  return agentView(deps,await loadInstallation(tx,i.id),tx);
 });
}
export async function renewAgentCredential(deps:Deps,a:PartnerActor,key:unknown,input:unknown){
 const b=strictBody(input,['cancelCredentialId']);ensureEncryption(deps);const keyHash=sha256Hex(textField(key,'Idempotency-Key'));
 return deps.db.transaction(async tx=>{
  const i=await installationForActor(tx,a,true),now=deps.clock.now();
  await reauthorizePartner(tx,deps.clock,a,'imports:read');
  if(i.status==='revoked'||!i.enrollment_acknowledged_at||a.credentialId!==i.credential_id)fail('RENEWAL_UNAVAILABLE','A current installation credential is required',403);
  if(b.cancelCredentialId!==undefined){
   const target=textField(b.cancelCredentialId,'cancelCredentialId');
   if(target===i.credential_id)fail('INVALID_REQUEST','A failed protected save can cancel only its pending successor',400);
   const c=(await tx.query<{revoked_at:string|null}>('SELECT revoked_at FROM platform_credentials WHERE id=$1 AND principal_id=$2',[target,i.principal_id])).rows[0];
   if(!c||i.renewal_credential_id!==target&&!c.revoked_at)fail('RENEWAL_UNAVAILABLE','The pending successor no longer matches; refresh policy before recovery');
   if(i.renewal_credential_id===target){
    await tx.query('UPDATE platform_credentials SET revoked_at=COALESCE(revoked_at,$2) WHERE id=$1',[target,now.toISOString()]);
    await tx.query(`UPDATE record_agent_installations SET renewal_credential_id=NULL,renewal_response='{"state":"cancelled"}'::jsonb,renewal_expires_at=NULL WHERE id=$1`,[i.id]);
   }
   return {state:'cancelled',installationId:i.id,credentialId:target};
  }
  if(!i.renewal_credential_id&&i.renewal_key_hash===keyHash&&i.renewal_response)return {...i.renewal_response as object,installationId:i.id};
  if(i.renewal_credential_id){
   if(i.renewal_key_hash!==keyHash)fail('RENEWAL_PENDING','Recover and acknowledge the existing renewal using its original command key');
   if(!i.renewal_expires_at||new Date(i.renewal_expires_at)<=now){
    await tx.query('UPDATE platform_credentials SET revoked_at=COALESCE(revoked_at,$2) WHERE id=$1',[i.renewal_credential_id,now.toISOString()]);
    await tx.query(`UPDATE record_agent_installations SET renewal_credential_id=NULL,renewal_response='{"state":"expired"}'::jsonb,renewal_expires_at=NULL WHERE id=$1`,[i.id]);
    return {state:'expired',installationId:i.id};
   }
   return protection(deps,`renewal:${i.id}:${keyHash}`).open(i.renewal_response);
  }
  const current=(await tx.query<{expires_at:string;scopes:string[]}>('SELECT expires_at,scopes FROM platform_credentials WHERE id=$1',[i.credential_id])).rows[0];
  if(new Date(current.expires_at).getTime()-now.getTime()>7*86400000)fail('RENEWAL_NOT_DUE','Credential renewal begins seven days before expiry');
  if((await tx.query("SELECT 1 FROM partner_import_jobs WHERE credential_id=$1 AND state IN ('previewed','queued','running') LIMIT 1",[i.credential_id])).rows[0])fail('IMPORTS_PENDING','Drain or explicitly resolve imports before changing the originating credential');
  const w=await requireRecordWorkspace(tx,i.approval_user_id,i.organization_id,i.environment,true);
  if(!['OWNER','ADMIN'].includes(w.role))fail('AGENT_ADMIN_REQUIRED','The approving administrator must approve recovery',403);
  await validateBinding(tx,w,{integrationAccountId:i.integration_account_id,operatorMembershipId:i.operator_membership_id,locationId:i.location_id,sourceName:i.source_name});
  const expiresAt=new Date(now.getTime()+30*86400000).toISOString(),c=await issuePartnerCredential(tx,deps.clock,w.userId,w.organizationId,i.principal_id,{scopes:current.scopes.filter(s=>scopes.includes(s)),expiresAt},a.requestId);
  const response={installationId:i.id,credentialId:c.id,token:c.token,expiresAt},until=new Date(now.getTime()+600000).toISOString();
  await tx.query('UPDATE record_agent_installations SET renewal_credential_id=$2,renewal_response=$3::jsonb,renewal_expires_at=$4,renewal_key_hash=$5 WHERE id=$1',[i.id,c.id,JSON.stringify(protection(deps,`renewal:${i.id}:${keyHash}`).seal(response)),until,keyHash]);
  return response;
 });
}
