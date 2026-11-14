import type {AppDependencies} from '../app.js';
import type {Database} from '../db/database.js';
import type {RecordWorkspace} from './access.js';
import {reauthorizeRecordWorkspace,requireRecordLocation} from './access.js';
import {requireCaseAccess,currentCaseObservationSql} from './cases.js';
import {requireReconstructionFeature,reconstructionFeatureEnabled} from './reconstruction-features.js';
import {DomainError} from '../domain/errors.js';
import {strictBody,auditOrganization} from '../platform/organizations.js';
import {idempotent} from '../platform/idempotency.js';
import {canonicalize} from '../canonical.js';
import {sha256Hex} from '../hash.js';
import {newId} from '../ids.js';
import {explicitInstant} from './csv-semantics.js';
import {evaluateProofDisposition} from '../domain/retention-policy.js';
import type {QualifiedSourceDispositionStore} from './source-retention-disposition.js';

type Deps=Pick<AppDependencies,'db'|'clock'|'objectStore'>&{sourceDisposition?:QualifiedSourceDispositionStore};
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
export async function requireSourceRetentionAdmin(db:Database,w:RecordWorkspace,batchId:string) {
 requireReconstructionFeature('sourceSubscriptions');
 if(w.partner)fail('HUMAN_RETENTION_ADMIN_REQUIRED','A current source administrator must review source retention',403);
 const current=await reauthorizeRecordWorkspace(db,w,true);
 if(!['OWNER','ADMIN'].includes(current.role))fail('SOURCE_RETENTION_ADMIN_REQUIRED','A workspace administrator with access to the complete source must review retention',403);
 const row=(await db.query<BatchRow>('SELECT * FROM record_typed_batches WHERE id=$1 AND organization_id=$2 AND environment=$3',[batchId,current.organizationId,current.environment])).rows[0];
 if(!row)fail('SOURCE_RETENTION_NOT_FOUND','Source retention review not found',404);
 await requireRecordLocation(db,current,row.location_id);
 return {workspace:current,batch:row};
}
const sourceAdmin=requireSourceRetentionAdmin;
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
export async function sourceRelatedProofIds(db:Database,batchId:string){
 // Preserve historical Proof provenance as well as every current shared case.
 // A later reassociation cannot discard a Proof's inherited preservation gate.
 const proofs=(await db.query<{proof_id:string}>(`SELECT DISTINCT m.proof_id FROM record_case_members m WHERE m.source_row_id IN (SELECT id FROM record_typed_rows WHERE batch_id=$1) OR m.case_id IN (SELECT c.id FROM record_cases c JOIN record_typed_rows r ON ${currentCaseObservationSql('r','c.id')} JOIN record_typed_batches b ON b.id=r.batch_id WHERE b.id=$1 AND c.organization_id=b.organization_id AND c.environment=b.environment AND c.location_id=b.location_id AND c.operator_membership_id=b.operator_membership_id) ORDER BY m.proof_id LIMIT 1001`,[batchId])).rows;
 if(proofs.length>1000)fail('SOURCE_RETENTION_REVIEW_LIMIT','This source requires assisted related-record retention review');
 return proofs.map(p=>p.proof_id);
}
async function relatedRecordProtection(deps:Pick<Deps,'db'|'clock'>,batchId:string){
 const proofs=await sourceRelatedProofIds(deps.db,batchId);
 const results=[];
 for(const proofId of proofs){const evaluation=await evaluateProofDisposition(deps.db,deps.clock,proofId);results.push({proofId,...evaluation});}
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
 const cases=(await deps.db.query<{id:string;reference:string;root_type:string}>(`SELECT DISTINCT c.id,c.root_external_id reference,c.root_type FROM record_cases c JOIN record_typed_rows r ON ${currentCaseObservationSql('r','c.id')} WHERE r.batch_id=$1 AND c.organization_id=$2 AND c.environment=$3 AND c.location_id=$4 AND c.operator_membership_id=$5 ORDER BY c.id LIMIT 1001`,[batchId,current.organizationId,current.environment,b.location_id,b.operator_membership_id])).rows;
 if(cases.length>1000)fail('SOURCE_RETENTION_REVIEW_LIMIT','This source requires assisted shared-case impact review');
 const counts=(await deps.db.query<{status:string;count:string}>('SELECT status,COUNT(*)::text count FROM record_typed_rows WHERE batch_id=$1 GROUP BY status ORDER BY status',[batchId])).rows;
 const originalAvailability=await availability(deps,b),relatedProtection=await relatedRecordProtection(deps,batchId),retention=evaluate(assignment?.policy??null,holds,deps.clock.now());
 if(relatedProtection.protected){retention.eligibleForDispositionReview=false;retention.reasons.push('Related shipment records retain existing preservation requirements');}
 const identity={schema:'packproof.source-retention-review/v1',batchId,source:{connectionId:b.connection_id,subscriptionId:b.subscription_id,configurationRevision:Number(b.configuration_revision),locationId:b.location_id},original:{name:b.original_name,sha256:b.original_sha256,byteSize:Number(b.original_byte_size),versionBound:!!b.original_version_id&&b.original_version_id!=='null',availability:originalAvailability},relatedRecordProtection:relatedProtection,rowCount:Number(b.row_count),counts:counts.map(c=>({status:c.status,count:Number(c.count)})),cases,policyEventId:assignment?.event.id??null,policy:assignment?.policy??null,events:events.map(e=>({id:e.id,action:e.action,policy:e.policy,relatedEventId:e.related_event_id,reason:e.reason,actorUserId:e.actor_user_id,createdAt:new Date(e.created_at).toISOString()})),retention};
 const impactSha256=sha256Hex(canonicalize(identity));
 let executionAvailable=false;
 if(assignment&&deps.sourceDisposition&&reconstructionFeatureEnabled('sourceDisposition')){try{deps.sourceDisposition.assertReady({batchId:b.id,organizationId:b.organization_id,environment:b.environment,key:b.original_object_key,versionId:b.original_version_id,sha256:b.original_sha256,byteSize:Number(b.original_byte_size),policyVersion:assignment.policy.version});executionAvailable=true;}catch{}}
 const disposition=(await deps.db.query<{request_id:string;outcome:string;execution_qualification:string;acknowledged:boolean;command_id:string|null}>('SELECT result.request_id,result.outcome,result.execution_qualification,command.id command_id,(ack.command_id IS NOT NULL) acknowledged FROM record_source_disposition_results result JOIN record_source_disposition_requests request ON request.id=result.request_id LEFT JOIN record_source_compaction_commands command ON command.request_id=request.id LEFT JOIN record_source_compaction_acknowledgements ack ON ack.command_id=command.id WHERE request.batch_id=$1 ORDER BY result.created_at DESC LIMIT 1',[batchId])).rows[0];
 const dispositions=(await deps.db.query<{id:string;state:string;impact_sha256:string;created_at:Date|string}>('SELECT request.id,work.state,request.impact_sha256,request.created_at FROM record_source_disposition_requests request JOIN record_source_disposition_work work ON work.request_id=request.id WHERE request.batch_id=$1 ORDER BY request.created_at DESC,request.id DESC LIMIT 20',[batchId])).rows.map(r=>({id:r.id,state:r.state,impactSha256:r.impact_sha256,createdAt:new Date(r.created_at).toISOString()}));
 await sourceAdmin(deps.db,current,batchId);
 return {...identity,impactSha256,dispositions,activeHolds:holds.map(e=>{const p=e.policy as {reviewAt?:unknown;scope?:string;originalDispositionCannotBeUndone?:boolean;inFlightCompactionMayComplete?:boolean}|null;return {id:e.id,reason:e.reason,reviewAt:p?.reviewAt??null,scope:p?.scope??'all_receipt_layers',originalDispositionCannotBeUndone:p?.originalDispositionCannotBeUndone??false,inFlightCompactionMayComplete:p?.inFlightCompactionMayComplete??false};}),scope:'source_administrator_review_only',measuredAt:deps.clock.now().toISOString(),executionAvailable,originalDisposition:disposition?{requestId:disposition.request_id,outcome:disposition.outcome,qualification:disposition.execution_qualification}:null,originalsDeleted:disposition?.outcome==='deleted_exact_version',normalizedHistoryDisposition:'preserved_audit_history',backupErasure:'not_claimed',localSpoolPolicyDelivery:disposition?.command_id?(disposition.acknowledged?'acknowledged':'pending'):'not_dispatched'};
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
  if(action==='hold'){
   const originalBoundary=(await tx.query("SELECT 1 FROM record_source_disposition_intents intent JOIN record_source_disposition_requests request ON request.id=intent.request_id JOIN record_source_disposition_work work ON work.request_id=request.id WHERE request.batch_id=$1 AND work.state IN ('running','failed','succeeded') LIMIT 1",[batchId])).rows[0];
   const inFlight=(await tx.query('SELECT 1 FROM record_source_compaction_permits permit JOIN record_source_compaction_commands command ON command.id=permit.command_id WHERE command.batch_id=$1 AND permit.expires_at>$2 AND NOT EXISTS(SELECT 1 FROM record_source_compaction_acknowledgements ack WHERE ack.command_id=command.id) LIMIT 1',[batchId,deps.clock.now().toISOString()])).rows[0];
   const reviewAt=b.reviewAt==null?null:retainUntil(b.reviewAt,'hold review time');policy={schema:'packproof.source-preservation-hold/v1',reviewAt,scope:originalBoundary||inFlight?'remaining_receipt_layers':'all_receipt_layers',originalDispositionCannotBeUndone:!!originalBoundary,inFlightCompactionMayComplete:!!inFlight,meaning:'Prospective preservation of remaining data. Already completed or authorized in-flight disposition cannot be undone.'};
  }
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
 const batches=(await deps.db.query<{id:string}>(`SELECT DISTINCT b.id FROM record_typed_batches b JOIN record_typed_rows r ON r.batch_id=b.id WHERE ${currentCaseObservationSql('r','$1')} AND b.organization_id=$2 AND b.environment=$3 ORDER BY b.id LIMIT 1001`,[caseId,w.organizationId,w.environment])).rows;
 if(batches.length>1000)fail('SOURCE_RETENTION_REVIEW_LIMIT','This case requires assisted source retention review');
 const summaries=[];
 for(const batch of batches){const events=await eventRows(deps.db,batch.id),assignment=currentPolicy(events),holds=activeHolds(events),related=await relatedRecordProtection(deps,batch.id);
  const disposition=(await deps.db.query<{outcome:string;command_id:string|null;acknowledged:boolean}>(`SELECT result.outcome,command.id command_id,(ack.command_id IS NOT NULL) acknowledged FROM record_source_disposition_results result JOIN record_source_disposition_requests request ON request.id=result.request_id LEFT JOIN record_source_compaction_commands command ON command.request_id=request.id LEFT JOIN record_source_compaction_acknowledgements ack ON ack.command_id=command.id WHERE request.batch_id=$1 ORDER BY result.created_at DESC LIMIT 1`,[batch.id])).rows[0];
  summaries.push({batchId:batch.id,decisionWatermarkSha256:sha256Hex(canonicalize({events:events.map(e=>({id:e.id,action:e.action,relatedEventId:e.related_event_id,createdAt:new Date(e.created_at).toISOString()})),originalDisposition:disposition?.outcome??null})),policyVersion:assignment?.policy.version??null,policy:assignment?.policy??null,preservationHoldActive:holds.length>0,sharedOriginalProtectedByRelatedRecord:related.protected,originalPreviouslyReportedUnavailable:events.some(e=>e.action==='unavailable'),originalDisposition:disposition?.outcome??'not_requested',normalizedHistoryDisposition:'preserved_audit_history',executionAvailable:false,backupErasure:'not_claimed',localSpoolPolicyDelivery:disposition?.command_id?(disposition.acknowledged?'acknowledged':'pending'):'not_dispatched'});
 }
 await requireCaseAccess(deps.db,deps.clock,w,caseId);
 return {schema:'packproof.case-retention-summary/v1',caseId,batches:summaries,scope:'permitted_case_only',executionAvailable:false,backupErasure:'not_claimed'};
}
