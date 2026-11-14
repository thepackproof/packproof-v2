import type {AppDependencies} from '../app.js';
import type {Database} from '../db/database.js';
import type {RecordWorkspace} from './access.js';
import {reauthorizeRecordWorkspace,requireRecordLocation} from './access.js';
import {requireCaseAccess} from './cases.js';
import {requireReconstructionFeature} from './reconstruction-features.js';
import {DomainError} from '../domain/errors.js';
import {strictBody,auditOrganization} from '../platform/organizations.js';
import {idempotent} from '../platform/idempotency.js';
import {canonicalize} from '../canonical.js';
import {sha256Hex} from '../hash.js';
import {newId} from '../ids.js';
import {explicitInstant} from './csv-semantics.js';
import {evaluateProofDisposition} from '../domain/retention-policy.js';

type Deps=Pick<AppDependencies,'db'|'clock'|'objectStore'>;
export const SOURCE_RETENTION_POLICY='packproof.source-retention-policy/v1' as const;
export interface SourceRetentionPolicy {
 schema:typeof SOURCE_RETENTION_POLICY;version:string;
 cloudOriginal:{retainUntil:string|null};normalizedHistory:{retainUntil:string|null};
 localSpool:{retainUntil:string|null;compactAfterAcknowledgement:true};
}
type Action='policy_assigned'|'hold'|'release_hold'|'disposition_requested'|'unavailable';
interface EventRow {id:string;batch_id:string;action:Action;policy:unknown;reason:string;related_event_id:string|null;actor_user_id:string;created_at:Date|string;}
interface BatchRow {id:string;organization_id:string;environment:'sandbox'|'live';location_id:string;connection_id:string;subscription_id:string;configuration_revision:number;operator_membership_id:string;original_name:string;original_sha256:string;original_byte_size:number;original_object_key:string;original_version_id:string;row_count:number;received_at:Date|string;}
const fail=(code:string,message:string,status=409):never=>{throw new DomainError(code,message,status);};
function text(input:unknown,name:string,max=1000){if(typeof input!=='string'||!input.trim()||input.length>max)throw new DomainError('INVALID_SOURCE_RETENTION',`Supply ${name} with at most ${max} characters`,400);return input;}
function retainUntil(input:unknown,name:string){if(input===null)return null;if(typeof input!=='string'||explicitInstant(input)===null)throw new DomainError('INVALID_SOURCE_RETENTION',`${name} must be an explicit-offset timestamp or null for an unspecified boundary`,400);return input;}
export function parseSourceRetentionPolicy(input:unknown):SourceRetentionPolicy {
 const p=strictBody(input,['schema','version','cloudOriginal','normalizedHistory','localSpool']);
 if(p.schema!==SOURCE_RETENTION_POLICY)fail('SOURCE_RETENTION_PROFILE_UNSUPPORTED','Use the versioned source retention declaration',400);
 const original=strictBody(p.cloudOriginal,['retainUntil']),history=strictBody(p.normalizedHistory,['retainUntil']),spool=strictBody(p.localSpool,['retainUntil','compactAfterAcknowledgement']);
 if(spool.compactAfterAcknowledgement!==true)fail('SOURCE_QUEUE_RETENTION_UNSAFE','Local captured work may be compacted only after its exact server receipt is reconciled',400);
 return {schema:SOURCE_RETENTION_POLICY,version:text(p.version,'policy version',100),cloudOriginal:{retainUntil:retainUntil(original.retainUntil,'cloud original retention')},normalizedHistory:{retainUntil:retainUntil(history.retainUntil,'normalized history retention')},localSpool:{retainUntil:retainUntil(spool.retainUntil,'local spool retention'),compactAfterAcknowledgement:true}};
}
async function sourceAdmin(db:Database,w:RecordWorkspace,batchId:string) {
 requireReconstructionFeature('sourceSubscriptions');
 if(w.partner)fail('HUMAN_RETENTION_ADMIN_REQUIRED','A current source administrator must review source retention',403);
 const current=await reauthorizeRecordWorkspace(db,w,true);
 if(!['OWNER','ADMIN'].includes(current.role))fail('SOURCE_RETENTION_ADMIN_REQUIRED','A workspace administrator with access to the complete source must review retention',403);
 const row=(await db.query<BatchRow>('SELECT * FROM record_typed_batches WHERE id=$1 AND organization_id=$2 AND environment=$3',[batchId,current.organizationId,current.environment])).rows[0];
 if(!row)fail('SOURCE_RETENTION_NOT_FOUND','Source retention review not found',404);
 await requireRecordLocation(db,current,row.location_id);
 return {workspace:current,batch:row};
}
async function eventRows(db:Database,batchId:string){const rows=(await db.query<EventRow>('SELECT * FROM record_typed_retention_events WHERE batch_id=$1 ORDER BY created_at,id LIMIT 1001',[batchId])).rows;if(rows.length>1000)fail('SOURCE_RETENTION_REVIEW_LIMIT','This source requires assisted retention history review');return rows;}
function currentPolicy(rows:EventRow[]){
 const assignments=rows.filter(e=>e.action==='policy_assigned'),superseded=new Set(assignments.flatMap(e=>e.related_event_id?[e.related_event_id]:[])),heads=assignments.filter(e=>!superseded.has(e.id));
 if(heads.length>1)fail('SOURCE_RETENTION_POLICY_AMBIGUOUS','The source retention ledger needs assisted reconciliation');
 const event=heads[0]??null;
 return event?{event,policy:parseSourceRetentionPolicy(event.policy)}:null;
}
function activeHolds(rows:EventRow[]){const released=new Set(rows.filter(e=>e.action==='release_hold').map(e=>e.related_event_id));return rows.filter(e=>e.action==='hold'&&!released.has(e.id));}
async function availability(deps:Deps,b:BatchRow){
 try {const object=await deps.objectStore.get(b.original_object_key,{versionId:b.original_version_id});if(!object)return 'missing' as const;return object.body.length===Number(b.original_byte_size)&&sha256Hex(object.body)===b.original_sha256?'available' as const:'integrity_failed' as const;}
 catch {return 'unreachable' as const;}
}
/** A batch can support several existing immutable Proofs. Their established
 * retention and hold gates cannot be bypassed by a newer source policy. */
async function relatedRecordProtection(deps:Pick<Deps,'db'|'clock'>,batchId:string){
 const proofs=(await deps.db.query<{proof_id:string}>(`SELECT DISTINCT m.proof_id FROM record_case_members m JOIN record_typed_rows r ON r.case_id=m.case_id WHERE r.batch_id=$1 ORDER BY m.proof_id LIMIT 1001`,[batchId])).rows;
 if(proofs.length>1000)fail('SOURCE_RETENTION_REVIEW_LIMIT','This source requires assisted related-record retention review');
 const results=[];
 for(const proof of proofs){const evaluation=await evaluateProofDisposition(deps.db,deps.clock,proof.proof_id);results.push({proofId:proof.proof_id,...evaluation});}
 return {protected:results.some(e=>!e.eligibleForDisposition),reviewSha256:sha256Hex(canonicalize(results))};
}
function evaluate(policy:SourceRetentionPolicy|null,holds:EventRow[],at:Date){
 const reasons:string[]=[];if(!policy)reasons.push('No complete source retention policy has been assigned');
 if(holds.length)reasons.push('One or more preservation holds remain active');
 if(policy)for(const [layer,value]of [['cloud original',policy.cloudOriginal.retainUntil],['normalized history',policy.normalizedHistory.retainUntil],['local spool',policy.localSpool.retainUntil]] as const){if(value===null)reasons.push(`The ${layer} retention boundary is unspecified`);else if(Date.parse(value)>at.getTime())reasons.push(`The ${layer} retention boundary has not elapsed`);}
 return {eligibleForDispositionReview:reasons.length===0,reasons,executionAvailable:false,originalsDeleted:false,normalizedHistoryDeleted:false,localSpoolErasure:'not_dispatched',backupErasure:'not_claimed'};
}
/** Source administrators may review the impact of an entire shared original.
 * A case viewer never acquires this broader source inventory authority. */
export async function readSourceRetentionReview(deps:Deps,w:RecordWorkspace,batchId:string){
 const {workspace:current,batch:b}=await sourceAdmin(deps.db,w,batchId),events=await eventRows(deps.db,batchId),assignment=currentPolicy(events),holds=activeHolds(events);
 const cases=(await deps.db.query<{id:string;reference:string;root_type:string}>(`SELECT DISTINCT c.id,c.root_external_id reference,c.root_type FROM record_cases c JOIN record_typed_rows r ON r.case_id=c.id WHERE r.batch_id=$1 AND c.organization_id=$2 AND c.environment=$3 AND c.location_id=$4 ORDER BY c.id LIMIT 1001`,[batchId,current.organizationId,current.environment,b.location_id])).rows;
 if(cases.length>1000)fail('SOURCE_RETENTION_REVIEW_LIMIT','This source requires assisted shared-case impact review');
 const counts=(await deps.db.query<{status:string;count:string}>('SELECT status,COUNT(*)::text count FROM record_typed_rows WHERE batch_id=$1 GROUP BY status ORDER BY status',[batchId])).rows;
 const originalAvailability=await availability(deps,b),relatedProtection=await relatedRecordProtection(deps,batchId),retention=evaluate(assignment?.policy??null,holds,deps.clock.now());
 if(relatedProtection.protected){retention.eligibleForDispositionReview=false;retention.reasons.push('Related shipment records retain existing preservation requirements');}
 const identity={schema:'packproof.source-retention-review/v1',batchId,source:{connectionId:b.connection_id,subscriptionId:b.subscription_id,configurationRevision:Number(b.configuration_revision),locationId:b.location_id},original:{name:b.original_name,sha256:b.original_sha256,byteSize:Number(b.original_byte_size),versionBound:!!b.original_version_id&&b.original_version_id!=='null',availability:originalAvailability},relatedRecordProtection:relatedProtection,rowCount:Number(b.row_count),counts:counts.map(c=>({status:c.status,count:Number(c.count)})),cases,policyEventId:assignment?.event.id??null,policy:assignment?.policy??null,events:events.map(e=>({id:e.id,action:e.action,policy:e.policy,relatedEventId:e.related_event_id,reason:e.reason,actorUserId:e.actor_user_id,createdAt:new Date(e.created_at).toISOString()})),retention};
 const impactSha256=sha256Hex(canonicalize(identity));
 await sourceAdmin(deps.db,current,batchId);
 return {...identity,impactSha256,activeHolds:holds.map(e=>({id:e.id,reason:e.reason,reviewAt:(e.policy as {reviewAt?:unknown}|null)?.reviewAt??null})),scope:'source_administrator_review_only',measuredAt:deps.clock.now().toISOString(),executionAvailable:false,originalsDeleted:false,backupErasure:'not_claimed',localSpoolPolicyDelivery:'not_dispatched'};
}
/** Decisions are append-only and idempotent. There is deliberately no storage
 * delete call: committed object, backup and collector disposition are separate
 * qualified operations, not an implied consequence of requesting review. */
export async function actOnSourceRetention(deps:Deps,w:RecordWorkspace,batchId:string,input:unknown,key:unknown){
 const b=strictBody(input,['organizationId','environment','action','reason','impactSha256','policy','relatedEventId','reviewAt']);
 if(!['policy_assigned','hold','release_hold','disposition_requested','unavailable'].includes(String(b.action)))fail('INVALID_SOURCE_RETENTION','Choose a documented source retention action',400);
 const action=b.action as Action,reason=text(b.reason,'review reason'),before=await sourceAdmin(deps.db,w,batchId);
 const result=await idempotent(deps.db,deps.clock,before.workspace.tenantId,`source-retention:${before.workspace.membershipId}:${batchId}`,key,input,async tx=>{
  // One lock order serializes hold/disposition/policy changes for this receipt.
  await tx.query('SELECT pg_advisory_xact_lock(1347438158,hashtext($1))',[batchId]);
  const {workspace:current,batch:original}=await sourceAdmin(tx,w,batchId),review=await readSourceRetentionReview({...deps,db:tx},current,batchId);
  if(b.impactSha256!==review.impactSha256)fail('SOURCE_RETENTION_IMPACT_CHANGED','Refresh the complete source impact before recording this decision');
  const events=await eventRows(tx,batchId),assignment=currentPolicy(events),holds=activeHolds(events);
  let policy:unknown=null,relatedEventId:string|null=null;
  if(action==='policy_assigned'){
   const requested=parseSourceRetentionPolicy(b.policy),sameVersion=events.filter(e=>e.action==='policy_assigned').find(e=>parseSourceRetentionPolicy(e.policy).version===requested.version);
   if(sameVersion){if(sameVersion.id===assignment?.event.id&&canonicalize(sameVersion.policy)===canonicalize(requested))return {eventId:sameVersion.id};fail('SOURCE_RETENTION_VERSION_REUSED','Use a new immutable policy version for a different retention assignment');}
   policy=requested;relatedEventId=assignment?.event.id??null;
  }else if(b.policy!==undefined)fail('INVALID_SOURCE_RETENTION','Only a policy assignment may supply a policy',400);
  if(action==='hold'){const reviewAt=b.reviewAt==null?null:retainUntil(b.reviewAt,'hold review time');policy={schema:'packproof.source-preservation-hold/v1',reviewAt,scope:'all_receipt_layers'};}
  if(action==='release_hold'){relatedEventId=text(b.relatedEventId,'active hold ID',200);if(!holds.some(e=>e.id===relatedEventId))fail('SOURCE_HOLD_NOT_ACTIVE','Release only an active hold belonging to this complete source receipt');}
  else if(b.relatedEventId!==undefined)fail('INVALID_SOURCE_RETENTION','Only a hold release may name another decision',400);
  if(action==='disposition_requested'){
   if(!review.retention.eligibleForDispositionReview)fail('SOURCE_RETENTION_PROTECTED','An active hold, unelapsed or unspecified policy prevents disposition review');
   relatedEventId=assignment!.event.id;policy={schema:'packproof.source-disposition-review/v1',impactSha256:review.impactSha256,executionAvailable:false,originalsDeleted:false,normalizedHistoryDeleted:false,localSpoolErasure:'not_dispatched',backupErasure:'not_claimed'};
  }
  if(action==='unavailable'){
   const observed=await availability({...deps,db:tx},original);
   if(observed==='available')fail('SOURCE_ORIGINAL_AVAILABLE','The exact original is available; it cannot be recorded as unavailable');
   if(observed==='unreachable')fail('SOURCE_STORAGE_UNREACHABLE','Storage could not be checked; an outage is not evidence that the exact original is missing',503);
   policy={schema:'packproof.source-original-availability/v1',observedState:observed,originalSha256:original.original_sha256,versionBound:original.original_version_id!=='null',observedAt:deps.clock.now().toISOString(),originalsDeleted:false,backupErasure:'not_claimed'};
  }
  const eventId=newId('source_retention'),at=deps.clock.now().toISOString();
  await tx.query('INSERT INTO record_typed_retention_events(id,batch_id,organization_id,environment,action,policy,reason,related_event_id,actor_user_id,created_at) VALUES($1,$2,$3,$4,$5,$6::jsonb,$7,$8,$9,$10)',[eventId,batchId,current.organizationId,current.environment,action,policy===null?null:JSON.stringify(policy),reason,relatedEventId,current.userId,at]);
  await auditOrganization(tx,deps.clock,{userId:current.userId,merchantId:current.organizationId,requestId:eventId,operation:`SOURCE_RETENTION_${action.toUpperCase()}`,resourceId:batchId});
  await sourceAdmin(tx,current,batchId);return {eventId};
 });
 const review=await readSourceRetentionReview(deps,w,batchId);
 return {...result,value:{eventId:result.value.eventId,review}};
}
/** Narrow summary for a permitted case: no other case IDs, unmapped fields,
 * hold reasons or full-source administration links are exposed. */
export async function getCaseRetentionSummary(deps:Pick<Deps,'db'|'clock'>,w:RecordWorkspace,caseId:string){
 // Pausing new source grants does not hide retention history for an already
 // authorized case. Case readers remain governed by the reconstruction flag.
 await requireCaseAccess(deps.db,deps.clock,w,caseId);
 const batches=(await deps.db.query<{id:string}>(`SELECT DISTINCT b.id FROM record_typed_batches b JOIN record_typed_rows r ON r.batch_id=b.id WHERE r.case_id=$1 AND r.status='accepted_linked' AND b.organization_id=$2 AND b.environment=$3 ORDER BY b.id`,[caseId,w.organizationId,w.environment])).rows;
 const summaries=[];
 for(const batch of batches){const events=await eventRows(deps.db,batch.id),assignment=currentPolicy(events),holds=activeHolds(events),related=await relatedRecordProtection(deps,batch.id);summaries.push({batchId:batch.id,decisionWatermarkSha256:sha256Hex(canonicalize(events.map(e=>({id:e.id,action:e.action,relatedEventId:e.related_event_id,createdAt:new Date(e.created_at).toISOString()})))),policyVersion:assignment?.policy.version??null,policy:assignment?.policy??null,preservationHoldActive:holds.length>0,sharedOriginalProtectedByRelatedRecord:related.protected,originalPreviouslyReportedUnavailable:events.some(e=>e.action==='unavailable'),executionAvailable:false,backupErasure:'not_claimed',localSpoolPolicyDelivery:'not_dispatched'});}
 await requireCaseAccess(deps.db,deps.clock,w,caseId);
 return {schema:'packproof.case-retention-summary/v1',caseId,batches:summaries,scope:'permitted_case_only',executionAvailable:false,backupErasure:'not_claimed'};
}
