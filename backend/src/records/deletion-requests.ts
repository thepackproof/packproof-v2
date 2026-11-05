import express,{type Request,type Response,type NextFunction} from 'express';
import type {AppDependencies} from '../app.js';
import type {Database} from '../db/database.js';
import {DomainError} from '../domain/errors.js';
import {evaluateProofDisposition} from '../domain/retention-policy.js';
import {buildProofRecoverySnapshot,enqueueRecoveryEvent} from '../domain/recovery-journal.js';
import {appendAudit} from '../domain/audit.js';
import {strictBody,authorizePartnerProof,auditOrganization,type PartnerActor} from '../platform/organizations.js';
import {idempotent} from '../platform/idempotency.js';
import {textField} from '../platform/tenants.js';
import {canonicalize} from '../canonical.js';
import {sha256Hex} from '../hash.js';
import {newId} from '../ids.js';
import {requireRecordWorkspace,requireRecordAccess} from './access.js';
import type {CanonicalExportOwner} from './partner-snapshots.js';
type Deps=Pick<AppDependencies,'db'|'clock'|'envelopes'>;
const identity=(o:CanonicalExportOwner)=>o.kind==='HUMAN'?{organization:o.workspace.organizationId,environment:o.workspace.environment,user:o.workspace.userId,tenant:o.workspace.tenantId,key:o.workspace.membershipId}:{organization:o.actor.merchantId,environment:o.actor.environment,user:o.actor.actorUserId,tenant:o.actor.tenantId,key:`${o.actor.credentialId}:${o.actor.delegationGrantId??''}`};
async function access(deps:Deps,db:Database,o:CanonicalExportOwner,proofId:string) {if(o.kind==='PARTNER')await authorizePartnerProof(db,deps.clock,o.actor,proofId,'deletion:request');else{const w=await requireRecordAccess(db,o.workspace,proofId,true);if(!['OWNER','ADMIN'].includes(w.role))throw new DomainError('DELETION_ADMIN_REQUIRED','A workspace administrator must review retention requests.',403);}}
/** A bounded inventory hash changes when any known original, derivative,
 * generated package, hold or retention policy changes. Object locations remain private. */
export async function previewRecordDeletion(deps:Deps,o:CanonicalExportOwner,proofId:string) {
 await access(deps,deps.db,o,proofId);
 const state=(await deps.db.query<{revision:number}>('SELECT revision FROM record_state WHERE proof_id=$1',[proofId])).rows[0];
 const inventory=(await deps.db.query<{kind:string;id:string;digest:string;bytes:string;version:string|null}>(`SELECT 'capture' kind,id,sha256 digest,byte_size::text bytes,object_version_id version FROM evidence WHERE proof_id=$1 AND validation_status='COMMITTED'
 UNION ALL SELECT 'source',a.id,r.sha256,r.byte_size::text,r.object_version_id FROM record_source_artifacts a JOIN record_source_artifact_results r ON r.artifact_id=a.id WHERE a.proof_id=$1
 UNION ALL SELECT 'derivative',id,sha256,byte_size::text,NULL FROM proof_media_derivatives WHERE proof_id=$1 AND object_key IS NOT NULL
 UNION ALL SELECT 'stored_package',id,artifact_sha256,artifact_byte_size::text,object_version_id FROM record_canonical_export_jobs WHERE proof_id=$1 AND object_key IS NOT NULL
 ORDER BY kind,id LIMIT 10001`,[proofId])).rows;
 if(inventory.length>10000)throw new DomainError('DELETION_REVIEW_LIMIT','This record requires assisted inventory review.',409);
 const retention=await evaluateProofDisposition(deps.db,deps.clock,proofId),holds=(await deps.db.query('SELECT id,reason,scope,review_at,released_at,release_protect_until FROM proof_retention_holds WHERE proof_id=$1 ORDER BY id',[proofId])).rows,policies=(await deps.db.query('SELECT id,policy_json,anchors_json,contractual_preserve_until FROM proof_retention_assignments WHERE proof_id=$1 ORDER BY id',[proofId])).rows;
 const impact={schema:'packproof.deletion-review-impact.v1',proofId,revision:state?.revision??1,inventory,holds,policies,retention},digest=sha256Hex(canonicalize(impact));
 await access(deps,deps.db,o,proofId);
 return {proofId,revision:impact.revision,impactSha256:digest,knownArtifactCount:inventory.length,knownArtifactBytes:inventory.reduce((n,r)=>n+Number(r.bytes),0),retention,executionAvailable:false,scope:'REVIEW_ONLY',originalsDeleted:false,backupErasure:'NOT_CLAIMED',message:'Retention review does not erase evidence. Protected snapshots, downstream copies, backups and all storage classes require separately qualified disposition.'};
}
export async function readRecordDeletion(deps:Deps,o:CanonicalExportOwner,id:string) {
 const a=identity(o),row=(await deps.db.query<{proof_id:string;state:string;reason:string;created_at:string|Date;requested_revision:number;impact_sha256:string}>(`SELECT c.proof_id,r.state,r.reason,r.created_at,c.requested_revision,c.impact_sha256 FROM record_deletion_contexts c JOIN proof_deletion_requests r ON r.id=c.request_id WHERE c.request_id=$1 AND c.organization_id=$2 AND c.environment=$3`,[id,a.organization,a.environment])).rows[0];
 if(!row)throw new DomainError('DELETION_REQUEST_NOT_FOUND','Deletion request not found.',404);await access(deps,deps.db,o,row.proof_id);const reviews=(await deps.db.query('SELECT id,decision,reason,impact_sha256 AS "impactSha256",actor_user_id AS "actorUserId",created_at AS "createdAt" FROM record_deletion_reviews WHERE request_id=$1 ORDER BY created_at,id',[id])).rows;const impact=await previewRecordDeletion(deps,o,row.proof_id);return {id,proofId:row.proof_id,state:row.state,reason:row.reason,requestedAt:new Date(row.created_at).toISOString(),requestedRevision:row.requested_revision,requestedImpactSha256:row.impact_sha256,reviews,currentImpact:impact,originalsDeleted:false,executionAvailable:false};
}
export async function requestRecordDeletion(deps:Deps,o:CanonicalExportOwner,key:unknown,input:unknown) {
 const b=strictBody(input,['proofId','reason','impactSha256']),proofId=textField(b.proofId,'proofId'),reason=textField(b.reason,'reason',1000),a=identity(o);await access(deps,deps.db,o,proofId);
 const result=await idempotent(deps.db,deps.clock,a.tenant,`record-deletion-request:${a.key}`,key,b,async tx=>{
  await access(deps,tx,o,proofId);await tx.query('SELECT id FROM proofs WHERE id=$1 FOR UPDATE',[proofId]);
  const impact=await previewRecordDeletion({...deps,db:tx},o,proofId);
  if(b.impactSha256!==impact.impactSha256)throw new DomainError('DELETION_IMPACT_CHANGED','Refresh the retention impact and review it before requesting deletion.',409);
  const existing=(await tx.query<{id:string}>('SELECT id FROM proof_deletion_requests WHERE proof_id=$1 AND requested_by=$2',[proofId,a.user])).rows[0];
  if(existing){if(!(await tx.query('SELECT 1 FROM record_deletion_contexts WHERE request_id=$1',[existing.id])).rows[0])throw new DomainError('EXISTING_DELETION_REVIEW','Continue the existing retention review for this record.',409);return {id:existing.id};}
  const id=newId('deletion_request'),at=deps.clock.now().toISOString();await tx.query('INSERT INTO proof_deletion_requests(id,proof_id,requested_by,reason,created_at) VALUES($1,$2,$3,$4,$5)',[id,proofId,a.user,reason,at]);await tx.query('INSERT INTO record_deletion_contexts(request_id,proof_id,organization_id,environment,actor_kind,actor_context,requested_revision,impact_json,impact_sha256,created_at) VALUES($1,$2,$3,$4,$5,$6::jsonb,$7,$8::jsonb,$9,$10)',[id,proofId,a.organization,a.environment,o.kind,canonicalize(o),impact.revision,canonicalize(impact),impact.impactSha256,at]);await appendAudit(tx,{proofId,actorUserId:a.user,eventType:'RECORD_DELETION_REVIEW_REQUESTED',eventData:{requestId:id,impactSha256:impact.impactSha256,originalsDeleted:false},at:deps.clock.now()});await auditOrganization(tx,deps.clock,{...(o.kind==='HUMAN'?{userId:a.user,merchantId:a.organization}:{actor:o.actor}),requestId:id,operation:'RECORD_DELETION_REVIEW_REQUESTED',resourceId:proofId});await enqueueRecoveryEvent(tx,deps.clock,{operationId:`record-deletion-request:${id}`,kind:'RETENTION_CHANGED',proofId,actorUserId:a.user,payload:await buildProofRecoverySnapshot(tx,proofId)});return {id};
 });
 return {...result,value:await readRecordDeletion(deps,o,result.value.id)};
}
export async function reviewRecordDeletion(deps:Deps,o:CanonicalExportOwner,id:string,input:unknown) {
 if(o.kind!=='HUMAN')throw new DomainError('HUMAN_DELETION_REVIEW_REQUIRED','A current workspace administrator must review this request.',403);
 const b=strictBody(input,['decision','reason','impactSha256']),reason=textField(b.reason,'reason',1000);
 if(!['APPROVE','CANCEL'].includes(String(b.decision)))throw new DomainError('INVALID_DELETION_DECISION','Choose approve or cancel.',400);
 return deps.db.transaction(async tx=>{
  const request=await readRecordDeletion({...deps,db:tx},o,id);await tx.query('SELECT id FROM proof_deletion_requests WHERE id=$1 FOR UPDATE',[id]);
  await tx.query('SELECT id FROM proofs WHERE id=$1 FOR UPDATE',[request.proofId]);
  if(request.state!=='REQUESTED')throw new DomainError('DELETION_REVIEW_CLOSED','This deletion review is already closed.',409);
  const impact=await previewRecordDeletion({...deps,db:tx},o,request.proofId);if(b.impactSha256!==impact.impactSha256)throw new DomainError('DELETION_IMPACT_CHANGED','Review the current retention impact first.',409);
  if(b.decision==='APPROVE'&&!impact.retention.eligibleForDisposition)throw new DomainError('RETENTION_PROTECTED','Retention policy or a hold prevents disposition approval.',409);
  const at=deps.clock.now().toISOString();await tx.query('INSERT INTO record_deletion_reviews(id,request_id,decision,reason,impact_sha256,actor_user_id,created_at) VALUES($1,$2,$3,$4,$5,$6,$7)',[newId('deletion_review'),id,b.decision,reason,impact.impactSha256,o.workspace.userId,at]);if(b.decision==='CANCEL')await tx.query("UPDATE proof_deletion_requests SET state='CANCELLED' WHERE id=$1",[id]);await enqueueRecoveryEvent(tx,deps.clock,{operationId:`record-deletion-review:${id}:${newId('action')}`,kind:'RETENTION_CHANGED',proofId:request.proofId,actorUserId:o.workspace.userId,payload:await buildProofRecoverySnapshot(tx,request.proofId)});return readRecordDeletion({...deps,db:tx},o,id);
 });
}
export function createRecordDeletionRouter(deps:AppDependencies,human:boolean){
 const r=express.Router(),run=(fn:(r:Request,s:Response)=>Promise<void>)=>(req:Request,res:Response,next:NextFunction)=>void fn(req,res).catch(next);
 async function owner(req:Request):Promise<CanonicalExportOwner>{if(!human)return {kind:'PARTNER',actor:(req as Request&{partnerActor:PartnerActor}).partnerActor};const a=await deps.auth.authenticate(req.headers);return {kind:'HUMAN',workspace:await requireRecordWorkspace(deps.db,a.userId,req.query.organizationId,req.query.environment,true)};}
 r.use((_r,s,n)=>{s.setHeader('Cache-Control','private, no-store');n();});
 r.get(human?'/:proofId/deletion-impact':'/proofs/:proofId/deletion-impact',run(async(req,res)=>{res.json(await previewRecordDeletion(deps,await owner(req),req.params.proofId));}));
 r.post('/deletion-requests',run(async(req,res)=>{const result=await requestRecordDeletion(deps,await owner(req),req.header('Idempotency-Key'),req.body);res.setHeader('Idempotency-Replayed',String(result.replayed));res.status(202).json(result.value);}));
 r.get('/deletion-requests/:requestId',run(async(req,res)=>{res.json(await readRecordDeletion(deps,await owner(req),req.params.requestId));}));
 if(human)r.post('/deletion-requests/:requestId/review',run(async(req,res)=>{res.json(await reviewRecordDeletion(deps,await owner(req),req.params.requestId,req.body));}));
 return r;
}
