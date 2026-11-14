import type {AppDependencies} from '../app.js';
import type {Database} from '../db/database.js';
import type {Clock} from '../clock.js';
import type {RecordWorkspace} from './access.js';
import {requireRecordWorkspace} from './access.js';
import {requireSourceRetentionAdmin,readSourceRetentionReview,sourceRelatedProofIds} from './source-retention.js';
import {requireReconstructionFeature,reconstructionFeatureEnabled} from './reconstruction-features.js';
import {loadProof} from '../domain/proof-access.js';
import {DomainError} from '../domain/errors.js';
import {strictBody,auditOrganization,reauthorizePartner,type PartnerActor} from '../platform/organizations.js';
import {requireTypedSourceAuthority} from './source-subscriptions.js';
import {idempotent} from '../platform/idempotency.js';
import {canonicalize} from '../canonical.js';
import {sha256Hex} from '../hash.js';
import {newId} from '../ids.js';
import {readPinnedReconstructionQualification} from './reconstruction-qualification.js';
import type {TypedSourceBatch} from './source-contracts.js';

export interface SourceDispositionTarget {batchId:string;organizationId:string;environment:'sandbox'|'live';key:string;versionId:string;sha256:string;byteSize:number;policyVersion:string;}
export interface SourceDispositionBinding {
 schema:'packproof.source-disposition-binding/v1';sourceSha:string;organizationIds:string[];environment:'sandbox'|'live';
 bucket:string;permittedPrefix:string;reviewedPolicyVersions:string[];policyReviewReference:string;
 qualificationReference:string;reviewedAt:string;expiresAt:string;mode:'qualified_exact_version'|'synthetic_test';
 aws?:{accountId:string;region:string;roleArn:string;bucketVersioning:'Enabled'};
}
/** Deliberately separate from ObjectStore. Ordinary API/worker storage cannot
 * delete committed originals. A production transport requires an independently
 * reviewed privileged role, bucket/version scope and operational qualification. */
export interface ExactVersionDispositionTransport {
 headExact(input:{bucket:string;key:string;versionId:string}):Promise<{versionId:string;sha256:string;byteSize:number}|null>;
 deleteExact(input:{bucket:string;key:string;versionId:string}):Promise<void>;
}
export interface QualifiedSourceDispositionStore {
 readonly bindingSha256:string;readonly synthetic:boolean;
 assertReady(target:SourceDispositionTarget):void;
 inspect(target:SourceDispositionTarget):Promise<'present'|'absent'>;
 dispose(target:SourceDispositionTarget):Promise<'deleted_exact_version'|'already_absent'>;
}
type Deps=Pick<AppDependencies,'db'|'clock'|'objectStore'>&{sourceDisposition?:QualifiedSourceDispositionStore};
const fail=(code:string,message:string,status=409):never=>{throw new DomainError(code,message,status);};
const hash=(value:unknown)=>sha256Hex(canonicalize(value));
const text=(v:unknown,name:string)=>{if(typeof v!=='string'||!v.trim()||v.length>1000)fail('INVALID_SOURCE_DISPOSITION',`Supply ${name} with at most 1000 characters`,400);return v as string;};
const instant=(v:string)=>typeof v==='string'&&/(?:Z|[+-]\d{2}:\d{2})$/.test(v)&&Number.isFinite(Date.parse(v));
export function createQualifiedSourceDispositionStore(input:{clock:Clock;binding:SourceDispositionBinding;activeSourceSha:string;transport:ExactVersionDispositionTransport;testFixtures?:boolean}):QualifiedSourceDispositionStore {
 const binding=JSON.parse(canonicalize(input.binding)) as SourceDispositionBinding,bindingSha256=hash(binding);
 function assertReady(t:SourceDispositionTarget){
  const now=input.clock.now().getTime();
  if(binding.schema!=='packproof.source-disposition-binding/v1'||!/^[a-f0-9]{40}$/.test(binding.sourceSha)||binding.sourceSha!==input.activeSourceSha||!instant(binding.reviewedAt)||!instant(binding.expiresAt)||Date.parse(binding.reviewedAt)>now||now>=Date.parse(binding.expiresAt)||!binding.policyReviewReference?.trim()||!binding.qualificationReference?.trim()||!binding.bucket?.trim()||!Array.isArray(binding.organizationIds)||binding.organizationIds.length>100||!binding.organizationIds.includes(t.organizationId)||binding.environment!==t.environment||!binding.reviewedPolicyVersions?.includes(t.policyVersion))fail('SOURCE_DISPOSITION_UNQUALIFIED','The exact-version source disposition runtime lacks a matching current qualification',503);
  if(binding.mode==='synthetic_test'?(input.testFixtures!==true||t.environment!=='sandbox'):binding.mode!=='qualified_exact_version')fail('SOURCE_DISPOSITION_UNQUALIFIED','Synthetic disposition is limited to explicit sandbox fixtures',503);
  // Bind the single original's complete committed key; never accept a prefix,
  // staging object, journal, traversal or unversioned delete from an API body.
  if(binding.permittedPrefix!==`evidence/${t.organizationId}/`||!t.key.startsWith(binding.permittedPrefix)||!/^evidence\/[A-Za-z0-9_-]+\/[A-Za-z0-9_-]+\/committed\/sha256-[a-f0-9]{64}$/.test(t.key)||!t.key.endsWith(`/sha256-${t.sha256}`)||!/^[a-f0-9]{64}$/.test(t.sha256)||!t.versionId||t.versionId==='null'||!Number.isSafeInteger(t.byteSize)||t.byteSize<1||t.byteSize>2097152)fail('SOURCE_DISPOSITION_TARGET_UNSAFE','Only a version-bound original under the reviewed committed-source prefix may be disposed');
 }
 async function inspect(t:SourceDispositionTarget){assertReady(t);const found=await input.transport.headExact({bucket:binding.bucket,key:t.key,versionId:t.versionId});if(!found)return 'absent' as const;if(found.versionId!==t.versionId||found.sha256!==t.sha256||found.byteSize!==t.byteSize)fail('SOURCE_DISPOSITION_INTEGRITY_CHANGED','The exact original no longer matches its reviewed digest and size');return 'present' as const;}
 return {bindingSha256,synthetic:binding.mode==='synthetic_test',assertReady,inspect,async dispose(t){
  if(await inspect(t)==='absent')return 'already_absent';
  await input.transport.deleteExact({bucket:binding.bucket,key:t.key,versionId:t.versionId});
  if(await inspect(t)!=='absent')fail('SOURCE_DISPOSITION_NOT_CONFIRMED','The exact version remains retrievable after the disposition operation',503);
  return 'deleted_exact_version';
 }};
}
export function initializeSourceDispositionRuntime(input:{clock:Clock;activeSourceSha:string;transport?:ExactVersionDispositionTransport;testFixtures?:boolean;env?:NodeJS.ProcessEnv}):QualifiedSourceDispositionStore|undefined {
 const env=input.env??process.env;if(env.PACKPROOF_SOURCE_DISPOSITION_ENABLED!=='true')return undefined;
 const binding=readPinnedReconstructionQualification<SourceDispositionBinding>(env,'PACKPROOF_SOURCE_DISPOSITION_BINDING');
 if(!input.transport)fail('SOURCE_DISPOSITION_TRANSPORT_UNAVAILABLE','An independently reviewed privileged exact-version disposition transport is required',503);
 const runtime=createQualifiedSourceDispositionStore({...input,transport:input.transport!,binding});
 if(!Array.isArray(binding.organizationIds)||!binding.organizationIds.length||!Array.isArray(binding.reviewedPolicyVersions)||!binding.reviewedPolicyVersions.length)fail('SOURCE_DISPOSITION_UNQUALIFIED','The reviewed source disposition scope is empty',503);
 for(const organizationId of binding.organizationIds)runtime.assertReady({batchId:'readiness',organizationId,environment:binding.environment,key:`evidence/${organizationId}/readiness/committed/sha256-${'0'.repeat(64)}`,versionId:'readiness',sha256:'0'.repeat(64),byteSize:1,policyVersion:binding.reviewedPolicyVersions[0]});
 return runtime;
}
interface RequestRow {id:string;batch_id:string;organization_id:string;environment:'sandbox'|'live';impact_sha256:string;policy_event_id:string;target:SourceDispositionTarget;requester:RecordWorkspace;reason:string;created_at:Date|string;}
interface ApprovalRow {approver:RecordWorkspace;impact_sha256:string;}
interface CollectorBatch {id:string;organization_id:string;environment:'sandbox'|'live';principal_id:string;subscription_id:string;configuration_revision:number;grant_revision:number;connection_id:string;location_id:string;operator_membership_id:string;source_profile:string;mapping_version:string;source_namespace:string;original_sha256:string;state:string;contract:Omit<TypedSourceBatch,'rows'>;}
export interface CollectorCompactionCommand {
 schema:'packproof.collector-compaction-command/v1';id:string;requestId:string;batchId:string;
 organizationId:string;environment:'sandbox'|'live';principalId:string;installationId:string;
 connectionId:string;locationId:string;operatorMembershipId:string;subscriptionId:string;
 configurationRevision:number;receiptGrantRevision:number;grantRevision:number;originalSha256:string;policyEventId:string;
 policyVersion:string;retainUntil:string;compactAfterAcknowledgement:true;expiresAt:string;
}
const json=<T>(v:T|string):T=>typeof v==='string'?JSON.parse(v):v;
async function requestRow(db:Database,id:string){const r=(await db.query<RequestRow>('SELECT * FROM record_source_disposition_requests WHERE id=$1',[id])).rows[0];if(!r)fail('SOURCE_DISPOSITION_NOT_FOUND','Source disposition not found',404);return {...r,target:json(r.target),requester:json(r.requester)};}
async function authorizeSaved(db:Database,saved:RecordWorkspace,batchId:string){const current=await requireRecordWorkspace(db,saved.userId,saved.organizationId,saved.environment,true);if(current.membershipId!==saved.membershipId)fail('SOURCE_DISPOSITION_AUTHORITY_CHANGED','The original disposition authority is no longer current',403);return (await requireSourceRetentionAdmin(db,current,batchId)).workspace;}
function targetOf(batch:Awaited<ReturnType<typeof requireSourceRetentionAdmin>>['batch'],policyVersion:string):SourceDispositionTarget{return {batchId:batch.id,organizationId:batch.organization_id,environment:batch.environment,key:batch.original_object_key,versionId:batch.original_version_id,sha256:batch.original_sha256,byteSize:Number(batch.original_byte_size),policyVersion};}
async function lockSourceImpact(db:Database,batchId:string){
 await db.query('SELECT pg_advisory_xact_lock(1347438158,hashtext($1))',[batchId]);
 const batch=(await db.query<{organization_id:string;environment:string;location_id:string}>('SELECT organization_id,environment,location_id FROM record_typed_batches WHERE id=$1',[batchId])).rows[0];if(!batch)fail('SOURCE_DISPOSITION_NOT_FOUND','Source disposition receipt not found',404);
 // The existing case writer uses this same site lock. A new Proof membership
 // from a different batch must not appear between impact review and execution.
 await db.query('SELECT pg_advisory_xact_lock(1347438153,hashtext($1))',[canonicalize([batch.organization_id,batch.environment,batch.location_id])]);
}
async function lockCollectorImpact(db:Database,actor:PartnerActor,batchId:string){
 // Match typed intake/replay ordering: principal, batch, site, Proof rows.
 await db.query('SELECT pg_advisory_xact_lock(1347438148,hashtext($1))',[actor.principalId]);await lockSourceImpact(db,batchId);
}
async function lockedReview(deps:Deps,w:RecordWorkspace,batchId:string){
 await lockSourceImpact(deps.db,batchId);
 // Existing Proof hold admission obtains the same Proof row locks. Acquire in
 // stable order before observing inherited holds and before the external call.
 for(const proofId of await sourceRelatedProofIds(deps.db,batchId))await loadProof(deps.db,proofId,true);
 return readSourceRetentionReview(deps,w,batchId);
}
async function enqueueCompaction(deps:Deps,r:RequestRow){
 const s=(await deps.db.query<CollectorBatch&{installation_id:string|null;current_configuration_revision:number;current_grant_revision:number;subscription_state:string}>(`SELECT b.*,s.installation_id,s.configuration_revision current_configuration_revision,s.grant_revision current_grant_revision,s.state subscription_state FROM record_typed_batches b JOIN record_source_subscriptions s ON s.id=b.subscription_id WHERE b.id=$1`,[r.batch_id])).rows[0];
 if(!s?.installation_id||!['approved','active'].includes(s.subscription_state)||Number(s.configuration_revision)!==Number(s.current_configuration_revision)||Number(s.current_grant_revision)<Number(s.grant_revision))return;
 const requester=await authorizeSaved(deps.db,r.requester,r.batch_id),review=await readSourceRetentionReview(deps,requester,r.batch_id);
 if(!review.retention.eligibleForDispositionReview||review.policyEventId!==r.policy_event_id||review.policy?.version!==r.target.policyVersion||!review.policy.localSpool.retainUntil)return;
 const id=newId('source_compaction'),now=deps.clock.now(),expiresAt=new Date(now.getTime()+86400000).toISOString();
 const command:CollectorCompactionCommand={schema:'packproof.collector-compaction-command/v1',id,requestId:r.id,batchId:r.batch_id,organizationId:r.organization_id,environment:r.environment,principalId:s.principal_id,installationId:s.installation_id,connectionId:s.connection_id,locationId:s.location_id,operatorMembershipId:s.operator_membership_id,subscriptionId:s.subscription_id,configurationRevision:Number(s.configuration_revision),receiptGrantRevision:Number(s.grant_revision),grantRevision:Number(s.current_grant_revision),originalSha256:s.original_sha256,policyEventId:r.policy_event_id,policyVersion:r.target.policyVersion,retainUntil:review.policy.localSpool.retainUntil,compactAfterAcknowledgement:true,expiresAt};
 await deps.db.query('INSERT INTO record_source_compaction_commands(id,request_id,batch_id,principal_id,installation_id,command,command_sha256,expires_at,created_at) VALUES($1,$2,$3,$4,$5,$6::jsonb,$7,$8,$9) ON CONFLICT(request_id) DO NOTHING',[id,r.id,r.batch_id,s.principal_id,s.installation_id,JSON.stringify(command),hash(command),expiresAt,now.toISOString()]);
}
async function requireCompactionAuthority(deps:Deps,actor:PartnerActor,command:CollectorCompactionCommand,historicalAcknowledgement=false){
 requireReconstructionFeature('sourceDisposition');requireReconstructionFeature('multiSourceAgent');
 const row=(await deps.db.query<CollectorBatch>('SELECT * FROM record_typed_batches WHERE id=$1 AND organization_id=$2 AND environment=$3',[command.batchId,actor.merchantId,actor.environment])).rows[0];
 if(!row||command.organizationId!==actor.merchantId||command.environment!==actor.environment||command.principalId!==actor.principalId||command.connectionId!==row.connection_id||command.locationId!==row.location_id||command.operatorMembershipId!==row.operator_membership_id||command.subscriptionId!==row.subscription_id||command.originalSha256!==row.original_sha256||command.configurationRevision!==Number(row.configuration_revision)||command.receiptGrantRevision!==Number(row.grant_revision)||command.grantRevision<command.receiptGrantRevision||!['succeeded','partially_succeeded'].includes(row.state))fail('SOURCE_COMPACTION_AUTHORITY_CHANGED','The exact completed collector receipt no longer matches its approved command',403);
 const contract=json(row.contract),current=await requireTypedSourceAuthority(deps.db,deps.clock,actor,{batchSchema:contract.schema,identityPolicy:contract.identityPolicy,subscriptionId:row.subscription_id,configurationRevision:Number(row.configuration_revision),grantRevision:Number(row.grant_revision),connectionId:row.connection_id,locationId:row.location_id,sourceProfile:row.source_profile,mappingVersion:row.mapping_version,sourceNamespace:row.source_namespace,mapping:contract.mapping,constants:contract.constants,wholeFileConsent:contract.wholeFileConsent},'read');
 if(current.installationId!==command.installationId||current.grantRevision!==command.grantRevision||current.operatorMembershipId!==command.operatorMembershipId||(!historicalAcknowledgement&&(Date.parse(command.expiresAt)<=deps.clock.now().getTime()||Date.parse(command.retainUntil)>deps.clock.now().getTime())))fail('SOURCE_COMPACTION_AUTHORITY_CHANGED','Refresh expired collector retention authority before compaction',403);
 // Historical acknowledgements perform no additional erasure. The persisted
 // permit and compaction time establish the earlier authorization boundary;
 // a later hold cannot restore data that was already compacted under it.
 if(historicalAcknowledgement)return current;
 for(const proofId of await sourceRelatedProofIds(deps.db,row.id))await loadProof(deps.db,proofId,true);
 const request=await requestRow(deps.db,command.requestId),requester=await authorizeSaved(deps.db,request.requester,row.id),approval=(await deps.db.query<ApprovalRow>('SELECT approver,impact_sha256 FROM record_source_disposition_approvals WHERE request_id=$1',[request.id])).rows[0];if(!approval||approval.impact_sha256!==request.impact_sha256)fail('SOURCE_DISPOSITION_APPROVAL_REQUIRED','The original independent compaction review is unavailable');await authorizeSaved(deps.db,json(approval.approver),row.id);
 const review=await readSourceRetentionReview(deps,requester,row.id);
 if(!review.retention.eligibleForDispositionReview||review.policyEventId!==command.policyEventId||review.policy?.version!==command.policyVersion||review.policy.localSpool.retainUntil!==command.retainUntil)fail('SOURCE_RETENTION_PROTECTED','Current source policy, inherited Proof preservation or source review authority prevents collector compaction');
 return current;
}
export async function readCollectorCompactionCommands(deps:Deps,actor:PartnerActor){
 requireReconstructionFeature('sourceDisposition');await reauthorizePartner(deps.db,deps.clock,actor,'imports:read');
 const rows=(await deps.db.query<{command:CollectorCompactionCommand;command_sha256:string}>(`SELECT c.command,c.command_sha256 FROM record_source_compaction_commands c JOIN record_source_disposition_requests r ON r.id=c.request_id WHERE c.principal_id=$1 AND r.organization_id=$2 AND r.environment=$3 AND NOT EXISTS(SELECT 1 FROM record_source_compaction_acknowledgements a WHERE a.command_id=c.id) ORDER BY (c.expires_at>$4) DESC,c.created_at,c.id LIMIT 50`,[actor.principalId,actor.merchantId,actor.environment,deps.clock.now().toISOString()])).rows;
 // Discovery permits acknowledgement recovery under a later hold or expiry.
 // It never authorizes new erasure: every uncompacted original needs a fresh
 // 30-second final permit, which rechecks all preservation gates.
 const commands=[];for(const row of rows){const command=json(row.command);try{await deps.db.transaction(async tx=>{await lockCollectorImpact(tx,actor,command.batchId);await requireCompactionAuthority({...deps,db:tx},actor,command,true);});commands.push({...command,commandSha256:row.command_sha256});}catch(error){if(!(error instanceof DomainError&&error.httpStatus<500))throw error;}}
 await reauthorizePartner(deps.db,deps.clock,actor,'imports:read');return {schema:'packproof.collector-compaction-commands/v1',commands,serverTime:deps.clock.now().toISOString()};
}
interface CompactionPermit {id:string;command_id:string;actor_credential_id:string;command_sha256:string;issued_at:Date|string;expires_at:Date|string;}
export async function authorizeCollectorCompactionPermit(deps:Deps,actor:PartnerActor,id:string,input:unknown,key:unknown){
 const body=strictBody(input,['commandSha256','batchId','originalSha256']);
 const row=(await deps.db.query<{command:CollectorCompactionCommand;command_sha256:string}>('SELECT command,command_sha256 FROM record_source_compaction_commands WHERE id=$1 AND principal_id=$2',[id,actor.principalId])).rows[0];if(!row)fail('SOURCE_COMPACTION_NOT_FOUND','Collector retention command not found',404);const command=json(row.command);
 if(body.commandSha256!==row.command_sha256||body.batchId!==command.batchId||body.originalSha256!==command.originalSha256)fail('SOURCE_COMPACTION_COMMAND_CHANGED','A final permit must name the exact reviewed command and completed receipt',400);
 await deps.db.transaction(async tx=>{await lockCollectorImpact(tx,actor,command.batchId);return requireCompactionAuthority({...deps,db:tx},actor,command);});
 const result=await idempotent(deps.db,deps.clock,actor.tenantId,`source-compaction-permit:${actor.principalId}:${id}`,key,input,async tx=>{
  await lockCollectorImpact(tx,actor,command.batchId);await requireCompactionAuthority({...deps,db:tx},actor,command);
  if((await tx.query('SELECT 1 FROM record_source_compaction_acknowledgements WHERE command_id=$1',[id])).rows[0])fail('SOURCE_COMPACTION_ALREADY_ACKNOWLEDGED','The exact collector receipt was already compacted and acknowledged');
  const count=Number((await tx.query<{n:string}>('SELECT COUNT(*)::text n FROM record_source_compaction_permits WHERE command_id=$1',[id])).rows[0].n);if(count>=20)fail('SOURCE_COMPACTION_PERMIT_LIMIT','This collector command requires assisted recovery after repeated permit attempts');
  const permitId=newId('compaction_permit'),issuedAt=new Date(Math.floor(deps.clock.now().getTime()/1000)*1000).toISOString(),expiresAt=new Date(Math.min(Date.parse(command.expiresAt),Date.parse(issuedAt)+30000)).toISOString();
  await tx.query('INSERT INTO record_source_compaction_permits(id,command_id,actor_credential_id,command_sha256,issued_at,expires_at) VALUES($1,$2,$3,$4,$5,$6)',[permitId,id,actor.credentialId,row.command_sha256,issuedAt,expiresAt]);
  return {id:permitId,commandId:id,commandSha256:row.command_sha256,batchId:command.batchId,originalSha256:command.originalSha256,issuedAt,expiresAt,serverTime:deps.clock.now().toISOString()};
 });
 // An expired cached permit never becomes a fresh authorization on replay.
 await deps.db.transaction(async tx=>{await lockCollectorImpact(tx,actor,command.batchId);return requireCompactionAuthority({...deps,db:tx},actor,command);});if(Date.parse(result.value.expiresAt)<=deps.clock.now().getTime())fail('SOURCE_COMPACTION_PERMIT_EXPIRED','Obtain a fresh online permit before compacting retained work');return result;
}
export async function ackCollectorCompactionCommand(deps:Deps,actor:PartnerActor,id:string,input:unknown,key:unknown){
 const body=strictBody(input,['permitId','commandSha256','batchId','originalSha256','serverReceiptReconciled','localDisposition','compactedAt']);
 const row=(await deps.db.query<{command:CollectorCompactionCommand;command_sha256:string}>('SELECT command,command_sha256 FROM record_source_compaction_commands WHERE id=$1 AND principal_id=$2',[id,actor.principalId])).rows[0];if(!row)fail('SOURCE_COMPACTION_NOT_FOUND','Collector retention command not found',404);const command=json(row.command);await requireCompactionAuthority(deps,actor,command,true);
 const permit=(await deps.db.query<CompactionPermit>('SELECT * FROM record_source_compaction_permits WHERE id=$1 AND command_id=$2 AND actor_credential_id=$3 AND command_sha256=$4',[body.permitId,id,actor.credentialId,row.command_sha256])).rows[0];if(!permit||!instant(String(body.compactedAt))||Date.parse(String(body.compactedAt))<new Date(permit.issued_at).getTime()||Date.parse(String(body.compactedAt))>=new Date(permit.expires_at).getTime())fail('SOURCE_COMPACTION_PERMIT_REQUIRED','Acknowledge only compaction completed within the exact credential-bound final permit',400);
 if(body.commandSha256!==row.command_sha256||body.batchId!==command.batchId||body.originalSha256!==command.originalSha256||body.serverReceiptReconciled!==true||!['compacted','already_compacted'].includes(String(body.localDisposition))||!instant(String(body.compactedAt))||Date.parse(String(body.compactedAt))>deps.clock.now().getTime())fail('INVALID_SOURCE_COMPACTION_ACKNOWLEDGEMENT','Acknowledge only the exact reconciled completed receipt and original digest',400);
 const result=await idempotent(deps.db,deps.clock,actor.tenantId,`source-compaction:${actor.principalId}:${id}`,key,input,async tx=>{
  const scoped={...deps,db:tx};await lockCollectorImpact(tx,actor,command.batchId);await requireCompactionAuthority(scoped,actor,command,true);
  const previous=(await tx.query<{acknowledgement:unknown}>('SELECT acknowledgement FROM record_source_compaction_acknowledgements WHERE command_id=$1',[id])).rows[0];if(previous&&canonicalize(json(previous.acknowledgement))!==canonicalize(body))fail('SOURCE_COMPACTION_ACKNOWLEDGEMENT_CHANGED','The retained collector acknowledgement is immutable');
  await tx.query('INSERT INTO record_source_compaction_acknowledgements(command_id,permit_id,actor_credential_id,acknowledgement,created_at) VALUES($1,$2,$3,$4::jsonb,$5) ON CONFLICT(command_id) DO NOTHING',[id,permit.id,actor.credentialId,JSON.stringify(body),deps.clock.now().toISOString()]);return {id,state:'acknowledged',backupErasure:'not_claimed'};
 });
 await deps.db.transaction(async tx=>{await lockCollectorImpact(tx,actor,command.batchId);return requireCompactionAuthority({...deps,db:tx},actor,command,true);});return result;
}
export async function requestSourceDisposition(deps:Deps,w:RecordWorkspace,batchId:string,input:unknown,key:unknown){
 requireReconstructionFeature('sourceDisposition');const body=strictBody(input,['organizationId','environment','impactSha256','reason']),reason=text(body.reason,'review reason'),before=await requireSourceRetentionAdmin(deps.db,w,batchId);
 const result=await idempotent(deps.db,deps.clock,before.workspace.tenantId,`source-disposition-request:${w.membershipId}:${batchId}`,key,input,async tx=>{
  const scoped={...deps,db:tx},review=await lockedReview(scoped,w,batchId),{workspace,batch}=await requireSourceRetentionAdmin(tx,w,batchId);
  if(review.impactSha256!==body.impactSha256)fail('SOURCE_RETENTION_IMPACT_CHANGED','Refresh the complete shared-source impact before requesting disposition');
  if(!review.retention.eligibleForDispositionReview||!review.policy||!review.policyEventId)fail('SOURCE_RETENTION_PROTECTED','An active hold, inherited preservation gate or unelapsed policy prevents disposition');
  if(!['succeeded','partially_succeeded'].includes(String((batch as unknown as {state:string}).state)))fail('SOURCE_DISPOSITION_BATCH_ACTIVE','Reconcile the complete source receipt before disposition');
  const target=targetOf(batch,review.policy!.version);if(!target.versionId||target.versionId==='null')fail('SOURCE_DISPOSITION_VERSION_REQUIRED','Disposition requires the immutable original object version');
  const existing=(await tx.query("SELECT 1 FROM record_source_disposition_requests r JOIN record_source_disposition_work w ON w.request_id=r.id WHERE r.batch_id=$1 AND w.state IN ('requested','approved','running','succeeded') LIMIT 1",[batchId])).rows[0];if(existing)fail('SOURCE_DISPOSITION_EXISTS','A disposition request already exists for this exact source receipt');
  const id=newId('source_disposition'),at=deps.clock.now().toISOString();
  await tx.query('INSERT INTO record_source_disposition_requests(id,batch_id,organization_id,environment,impact_sha256,policy_event_id,target,requester,reason,created_at) VALUES($1,$2,$3,$4,$5,$6,$7::jsonb,$8::jsonb,$9,$10)',[id,batchId,w.organizationId,w.environment,review.impactSha256,review.policyEventId,JSON.stringify(target),JSON.stringify(workspace),reason,at]);
  await tx.query("INSERT INTO record_source_disposition_work(request_id,state,next_attempt_at,updated_at) VALUES($1,'requested',$2,$2)",[id,at]);
  await auditOrganization(tx,deps.clock,{userId:workspace.userId,merchantId:workspace.organizationId,requestId:id,operation:'SOURCE_DISPOSITION_REQUESTED',resourceId:batchId});return {id};
 });return {...result,value:await readSourceDisposition(deps,w,result.value.id)};
}
export async function approveSourceDisposition(deps:Deps,w:RecordWorkspace,id:string,input:unknown,key:unknown){
 requireReconstructionFeature('sourceDisposition');const body=strictBody(input,['organizationId','environment','impactSha256','reason','approve']);if(body.approve!==true)fail('INVALID_SOURCE_DISPOSITION','Explicit approval is required',400);const reason=text(body.reason,'approval reason'),r=await requestRow(deps.db,id),before=await requireSourceRetentionAdmin(deps.db,w,r.batch_id);
 const result=await idempotent(deps.db,deps.clock,before.workspace.tenantId,`source-disposition-approve:${w.membershipId}:${id}`,key,input,async tx=>{
  const scoped={...deps,db:tx},review=await lockedReview(scoped,w,r.batch_id),current=(await requireSourceRetentionAdmin(tx,w,r.batch_id)).workspace;
  await authorizeSaved(tx,r.requester,r.batch_id);
  if(current.userId===r.requester.userId)fail('SOURCE_DISPOSITION_INDEPENDENT_APPROVER_REQUIRED','A second current source administrator must approve the complete impact',403);
  if(body.impactSha256!==r.impact_sha256||review.impactSha256!==r.impact_sha256||!review.retention.eligibleForDispositionReview)fail('SOURCE_RETENTION_IMPACT_CHANGED','The reviewed source inventory or preservation requirements changed');
  const state=(await tx.query<{state:string}>('SELECT state FROM record_source_disposition_work WHERE request_id=$1 FOR UPDATE',[id])).rows[0];if(state?.state!=='requested')fail('SOURCE_DISPOSITION_NOT_REQUESTED','Only a pending request may be approved');
  const at=deps.clock.now().toISOString();await tx.query('INSERT INTO record_source_disposition_approvals(id,request_id,impact_sha256,approver,reason,created_at) VALUES($1,$2,$3,$4::jsonb,$5,$6)',[newId('disposition_approval'),id,r.impact_sha256,JSON.stringify(current),reason,at]);
  await tx.query("UPDATE record_source_disposition_work SET state='approved',updated_at=$2 WHERE request_id=$1",[id,at]);
  await auditOrganization(tx,deps.clock,{userId:current.userId,merchantId:current.organizationId,requestId:id,operation:'SOURCE_DISPOSITION_APPROVED',resourceId:r.batch_id});return {id};
 });return {...result,value:await readSourceDisposition(deps,w,result.value.id)};
}
export async function readSourceDisposition(deps:Deps,w:RecordWorkspace,id:string){
 const r=await requestRow(deps.db,id);await requireSourceRetentionAdmin(deps.db,w,r.batch_id);
 const work=(await deps.db.query<{state:string;attempts:number;error_code:string|null}>('SELECT state,attempts,error_code FROM record_source_disposition_work WHERE request_id=$1',[id])).rows[0];
 const result=(await deps.db.query<{outcome:string;execution_qualification:string}>('SELECT outcome,execution_qualification FROM record_source_disposition_results WHERE request_id=$1',[id])).rows[0];
 const compaction=(await deps.db.query<{acknowledged:boolean}>('SELECT (a.command_id IS NOT NULL) acknowledged FROM record_source_compaction_commands c LEFT JOIN record_source_compaction_acknowledgements a ON a.command_id=c.id WHERE c.request_id=$1',[id])).rows[0];
 let executionAvailable=false;try{if(reconstructionFeatureEnabled('sourceDisposition')&&deps.sourceDisposition){deps.sourceDisposition.assertReady(r.target);executionAvailable=true;}}catch{}
 return {schema:'packproof.source-disposition-status/v1',id,batchId:r.batch_id,state:work.state,attempts:Number(work.attempts),errorCode:work.error_code,impactSha256:r.impact_sha256,executionAvailable,qualification:result?.execution_qualification??(deps.sourceDisposition?(deps.sourceDisposition.synthetic?'synthetic_test_only':'qualified_runtime'):'external_runtime_qualification_required'),original:{disposition:result?.outcome??'pending',sha256:r.target.sha256},normalizedHistory:{disposition:'preserved_audit_history'},localSpool:{state:compaction?(compaction.acknowledged?'acknowledged':'pending'):'not_dispatched'},backupErasure:'not_claimed',createdAt:new Date(r.created_at).toISOString()};
}
/** Bounded work. Durable intent precedes the irreversible call; an uncertain
 * acknowledgement is reconciled by inspecting that same exact version. */
export async function processSourceDispositions(deps:Deps,store:QualifiedSourceDispositionStore|undefined=deps.sourceDisposition,limit=5){
 if(!reconstructionFeatureEnabled('sourceDisposition')||!store)return {processed:0,executionAvailable:false};
 if(!Number.isSafeInteger(limit)||limit<1||limit>10)fail('INVALID_SOURCE_DISPOSITION_LIMIT','Process between one and ten source dispositions',400);
 const at=deps.clock.now(),jobs=(await deps.db.query<{request_id:string}>("SELECT request_id FROM record_source_disposition_work WHERE (state IN ('approved','failed') OR (state='running' AND lease_expires_at<=$1)) AND attempts<3 AND next_attempt_at<=$1 ORDER BY next_attempt_at,request_id LIMIT $2",[at.toISOString(),limit])).rows;
 let processed=0;
 for(const job of jobs){const token=newId('disposition_lease');
  const claimed=await deps.db.transaction(async tx=>{const changed=await tx.query("UPDATE record_source_disposition_work SET state='running',attempts=attempts+1,lease_token=$2,lease_expires_at=$3,updated_at=$4 WHERE request_id=$1 AND attempts<3 AND (state IN ('approved','failed') OR (state='running' AND lease_expires_at<=$4)) RETURNING request_id",[job.request_id,token,new Date(at.getTime()+300000).toISOString(),at.toISOString()]);if(!changed.rowCount)return false;const r=await requestRow(tx,job.request_id);try{store.assertReady(r.target);}catch(error){await tx.query("UPDATE record_source_disposition_work SET state='failed',lease_token=NULL,lease_expires_at=NULL,error_code=$2,next_attempt_at=$3,updated_at=$4 WHERE request_id=$1",[r.id,error instanceof DomainError?error.code:'SOURCE_DISPOSITION_UNQUALIFIED',new Date(at.getTime()+60000).toISOString(),at.toISOString()]);return false;}await tx.query('INSERT INTO record_source_disposition_intents(request_id,target_sha256,executor_binding_sha256,created_at) VALUES($1,$2,$3,$4) ON CONFLICT(request_id) DO NOTHING',[r.id,hash(r.target),store.bindingSha256,at.toISOString()]);return true;});if(!claimed)continue;
  try{await deps.db.transaction(async tx=>{
   const scoped={...deps,db:tx},r=await requestRow(tx,job.request_id),lease=(await tx.query<{lease_token:string}>('SELECT lease_token FROM record_source_disposition_work WHERE request_id=$1 FOR UPDATE',[r.id])).rows[0];if(lease.lease_token!==token)fail('SOURCE_DISPOSITION_LEASE_LOST','Disposition ownership changed');
   await lockSourceImpact(tx,r.batch_id);
   for(const proofId of await sourceRelatedProofIds(tx,r.batch_id))await loadProof(tx,proofId,true);
   const intent=(await tx.query<{target_sha256:string;executor_binding_sha256:string}>('SELECT target_sha256,executor_binding_sha256 FROM record_source_disposition_intents WHERE request_id=$1',[r.id])).rows[0];if(intent.target_sha256!==hash(r.target)||intent.executor_binding_sha256!==store.bindingSha256)fail('SOURCE_DISPOSITION_BINDING_CHANGED','Resume only the original exact-version execution binding');
   // Reconcile a lost deletion acknowledgement before admitting another call.
   const absent=await store.inspect(r.target)==='absent';
   let outcome:'already_absent'|'deleted_exact_version'='already_absent';
   if(!absent){
    const requester=await authorizeSaved(tx,r.requester,r.batch_id),approval=(await tx.query<ApprovalRow>('SELECT approver,impact_sha256 FROM record_source_disposition_approvals WHERE request_id=$1',[r.id])).rows[0];if(!approval||approval.impact_sha256!==r.impact_sha256)fail('SOURCE_DISPOSITION_APPROVAL_REQUIRED','A matching independent approval is required');await authorizeSaved(tx,json(approval.approver),r.batch_id);
    const review=await readSourceRetentionReview(scoped,requester,r.batch_id);if(review.impactSha256!==r.impact_sha256||!review.retention.eligibleForDispositionReview)fail('SOURCE_RETENTION_IMPACT_CHANGED','Current authority, original inventory or preservation requirements changed');
    outcome=await store.dispose(r.target);
   }
   const now=deps.clock.now().toISOString();await tx.query("INSERT INTO record_source_disposition_results(request_id,outcome,target_sha256,executor_binding_sha256,execution_qualification,normalized_history_disposition,backup_erasure,created_at) VALUES($1,$2,$3,$4,$5,'preserved_audit_history','not_claimed',$6) ON CONFLICT(request_id) DO NOTHING",[r.id,outcome,hash(r.target),store.bindingSha256,store.synthetic?'synthetic_test_only':'qualified_runtime',now]);await tx.query("UPDATE record_source_disposition_work SET state='succeeded',lease_token=NULL,lease_expires_at=NULL,error_code=NULL,updated_at=$2 WHERE request_id=$1",[r.id,now]);
   await auditOrganization(tx,deps.clock,{userId:r.requester.userId,merchantId:r.organization_id,requestId:r.id,operation:'SOURCE_ORIGINAL_EXACT_VERSION_DISPOSED',resourceId:r.batch_id});
   // Collector instructions are an independent receipt-bound policy command;
   // no local erasure is inferred until the installation acknowledges it.
   try{await enqueueCompaction(scoped,r);}catch(error){if(!(error instanceof DomainError&&error.httpStatus<500))throw error;}
  });processed++;}catch(error){const code=error instanceof DomainError?error.code:'SOURCE_DISPOSITION_TRANSPORT_UNCERTAIN',blocked=error instanceof DomainError&&error.httpStatus<500;await deps.db.query('UPDATE record_source_disposition_work SET state=$3,lease_token=NULL,lease_expires_at=NULL,error_code=$4,next_attempt_at=$5,updated_at=$6 WHERE request_id=$1 AND lease_token=$2',[job.request_id,token,blocked?'blocked':'failed',code,new Date(deps.clock.now().getTime()+60000).toISOString(),deps.clock.now().toISOString()]);}
 }
 return {processed,executionAvailable:true};
}
