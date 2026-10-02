import { Router, type Request, type Response, type NextFunction } from 'express';
import { canonicalize } from '../../../packages/evidence-contracts/contracts.mjs';
import type { Database } from '../db/database.js';
import { newId } from '../ids.js';
import { authorized,bad,boundedId,onlyKeys,requireConsent,signedRecord } from './security.js';
import { requireRnd } from './config.js';
import { requestAnalysis } from './analyses.js';
import type { AnalysisRow,RndDeps,Source } from './types.js';

const ENROLLMENT_POLICY='packproof.proofprint-enrollment.v1';
const REQUIRED_GROUPS=Object.freeze(['label','carton']);
interface EnrollmentRow { id:string;proof_id:string;tenant_id:string;analysis_id:string;subject_id:string;root_digest:string;source_inventory:unknown;frozen_groups:string[];policy_version:string;supersedes_id:string|null;created_at:Date|string }
interface EventRow { sequence:number;state:string;canonical_json:string;digest:string;signature:unknown;created_at:Date|string }

async function appendEvent(deps:RndDeps,tx:Database,row:EnrollmentRow,state:string,details:Record<string,unknown>) {
 const previous=(await tx.query<EventRow>('SELECT * FROM rnd_enrollment_events WHERE enrollment_id=$1 ORDER BY sequence DESC LIMIT 1',[row.id])).rows[0];
 if(previous?.state==='LOCKED')bad('RND_ENROLLMENT_LOCKED','A locked enrollment cannot be edited; create a linked new version',409);
 const transitions:Record<string,string[]>= {CANDIDATE:['SOURCES_COMMITTED'],SOURCES_COMMITTED:['ANALYZED'],ANALYZED:['UNAVAILABLE'],UNAVAILABLE:['LOCKED']};
 if(previous?!transitions[previous.state]?.includes(state):state!=='CANDIDATE')bad('RND_ENROLLMENT_TRANSITION','Invalid enrollment transition',409);
 // No public/client/profile input can enable QUALIFIED in this research version.
 const sequence=(previous?.sequence??0)+1,id=newId('rnd_enrollment_event'),at=deps.clock.now().toISOString();
 const value={schemaVersion:'packproof.enrollment-event.v1',enrollmentId:row.id,proofId:row.proof_id,tenantId:row.tenant_id,
  sequence,state,previousDigest:previous?`sha256:${previous.digest}`:null,rootManifestDigest:`sha256:${row.root_digest}`,
  sourceInventory:row.source_inventory,frozenRequiredGroups:row.frozen_groups,policyVersion:row.policy_version,details,recordedAt:at};
 const signed=await signedRecord(deps,row.proof_id,id,value);
 await tx.query('INSERT INTO rnd_enrollment_events(id,enrollment_id,sequence,state,previous_digest,canonical_json,digest,signature,created_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)',
  [id,row.id,sequence,state,previous?.digest??null,signed.canonicalJson,signed.digest,JSON.stringify(signed.signature),at]);
}

async function ensureEnrollment(deps:RndDeps,tx:Database,job:AnalysisRow):Promise<EnrollmentRow> {
 const existing=(await tx.query<EnrollmentRow>('SELECT * FROM rnd_enrollments WHERE analysis_id=$1',[job.id])).rows[0];
 if(existing)return existing;
 if(job.feature!=='proofprint'||job.input_json.parameters.mode!=='enroll')bad('RND_ENROLLMENT_ANALYSIS_REQUIRED','Enrollment requires the passive ProofPrint job',409);
 const parent=job.input_json.parameters.enrollmentId ? boundedId(job.input_json.parameters.enrollmentId,'prior enrollment') : null;
 if(parent){
  const earlier=(await tx.query<EnrollmentRow>('SELECT * FROM rnd_enrollments WHERE id=$1 AND proof_id=$2 AND tenant_id=$3',[parent,job.proof_id,job.tenant_id])).rows[0];
  if(!earlier||earlier.subject_id!==job.input_json.subject.id)bad('RND_ENROLLMENT_PARENT_FORBIDDEN','A new version must reference the same authorized subject',403);
 }
 const sources=job.input_json.sources.map(s=>({sourceId:s.sourceId,sha256:`sha256:${s.sha256}`,objectVersionId:s.objectVersionId,
  byteLength:s.byteLength,captureSessionId:s.captureSessionId,legId:s.legId,packageInstanceId:s.packageInstanceId}));
 if(!sources.length||sources.some(s=>s.packageInstanceId!==job.input_json.subject.packageInstanceId))bad('RND_ENROLLMENT_SUBJECT_MISMATCH','Enrollment sources must belong to one bound package instance',403);
 const row:EnrollmentRow={id:`rnd_enrollment_${job.id}`,proof_id:job.proof_id,tenant_id:job.tenant_id,analysis_id:job.id,
  subject_id:job.input_json.subject.id,root_digest:job.root_digest,source_inventory:sources,frozen_groups:[...REQUIRED_GROUPS],
  policy_version:ENROLLMENT_POLICY,supersedes_id:parent,created_at:deps.clock.now().toISOString()};
 await tx.query('INSERT INTO rnd_enrollments(id,proof_id,tenant_id,analysis_id,subject_id,root_digest,source_inventory,frozen_groups,policy_version,supersedes_id,created_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)',
  [row.id,row.proof_id,row.tenant_id,row.analysis_id,row.subject_id,row.root_digest,JSON.stringify(sources),JSON.stringify(row.frozen_groups),row.policy_version,parent,row.created_at]);
 await appendEvent(deps,tx,row,'CANDIDATE',{analysisId:job.id,analysisCreatedAt:new Date(job.created_at).toISOString(),acquisition:'PASSIVE_COMMITTED_MEDIA'});
 await appendEvent(deps,tx,row,'SOURCES_COMMITTED',{sourceCount:sources.length,immutableSourcesVerified:true});
 return row;
}

/** Called inside the leased completion transaction while the Proof row is locked. */
export async function onEnrollmentAnalysisCompleted(deps:RndDeps,tx:Database,job:AnalysisRow,envelope:unknown) {
 if(job.feature!=='proofprint'||job.input_json.parameters.mode!=='enroll')return;
 const row=await ensureEnrollment(deps,tx,job);
 const last=(await tx.query<EventRow>('SELECT * FROM rnd_enrollment_events WHERE enrollment_id=$1 ORDER BY sequence DESC LIMIT 1',[row.id])).rows[0];
 if(last?.state==='LOCKED')return;
 const details=(envelope as Record<string,unknown>).details as {observations?:Record<string,unknown>[];artifacts?:Record<string,unknown>[]}|undefined;
 const observation=details?.observations?.find(o=>o.type==='PASSIVE_REGION_ENROLLMENT');
 const value=observation?.value as Record<string,unknown>|undefined;
 if(!value||canonicalize(value.frozenRequiredGroups)!==canonicalize(REQUIRED_GROUPS)||value.qualified!==false||value.qualificationState!=='UNAVAILABLE')bad('RND_ENROLLMENT_OUTPUT_INVALID','Worker enrollment changed the frozen group or qualification policy');
 const artifact=details?.artifacts?.find(a=>a.artifactId==='enrollment.json');
 if(!artifact||typeof artifact.sha256!=='string')bad('RND_ENROLLMENT_OUTPUT_INVALID','Enrollment requires its committed immutable artifact');
 await appendEvent(deps,tx,row,'ANALYZED',{analysisId:job.id,enrollmentArtifactSha256:artifact.sha256,extractorVersion:value.extractorVersion??null,
  regionCount:Array.isArray(value.regions)?value.regions.length:0,sourceBindingPreserved:true});
 await appendEvent(deps,tx,row,'UNAVAILABLE',{reasonCodes:value.unavailableReasons??['PHYSICAL_CAPTURE_PROFILE_UNQUALIFIED'],qualified:false});
 await appendEvent(deps,tx,row,'LOCKED',{qualificationState:'UNAVAILABLE',qualified:false,enrollmentArtifactSha256:artifact.sha256,
  nextVersionRule:'New source/method requires a new linked enrollment. Required groups and original source versions remain frozen.'});
}

export async function createEnrollment(deps:RndDeps,actor:string,proofId:string,key:unknown,input:unknown) {
 requireRnd(deps.rnd,'proofprint','processing');onlyKeys(input,['evidenceIds','supersedesEnrollmentId']);
 await authorized(deps.db,proofId,actor);await requireConsent(deps.db,proofId,actor);
 const prior=input.supersedesEnrollmentId?boundedId(input.supersedesEnrollmentId,'prior enrollment'):null;
 if(prior&&!(await deps.db.query('SELECT id FROM rnd_enrollments WHERE id=$1 AND proof_id=$2',[prior,proofId])).rows[0])bad('RND_ENROLLMENT_PARENT_FORBIDDEN','Prior enrollment is unavailable for this Proof',403);
 const analysis=await requestAnalysis(deps,actor,proofId,key,{feature:'proofprint',evidenceIds:input.evidenceIds,scope:'passive-region-enrollment',parameters:{mode:'enroll',...(prior?{enrollmentId:prior}:{})}});
 // requestAnalysis owns its transaction. Registering the append-only lifecycle in
 // a second transaction is retry-safe; the completion hook can recover the gap.
 const row=await deps.db.transaction(async tx=>{
  await tx.query('SELECT id FROM proofs WHERE id=$1 FOR UPDATE',[proofId]);
  const job=(await tx.query<AnalysisRow>('SELECT * FROM rnd_analyses WHERE id=$1 AND proof_id=$2',[analysis.analysisId,proofId])).rows[0];
  const enrolled=await ensureEnrollment(deps,tx,job);
  if(job.operational_state==='SUCCEEDED'&&job.result_json)await onEnrollmentAnalysisCompleted(deps,tx,job,job.result_json);
  return enrolled;
 });
 return {enrollmentId:row.id,analysisId:row.analysis_id,analysis,requiredGroups:row.frozen_groups,qualified:false};
}

/** Resolve the locked baseline on the server; never accept a client-selected favorable subset. */
export async function bindEnrollmentComparison(tx:Database,proofId:string,tenantId:string,enrollmentId:unknown,sources:Source[]) {
 const id=boundedId(enrollmentId,'enrollment');
 const row=(await tx.query<EnrollmentRow>('SELECT * FROM rnd_enrollments WHERE id=$1 AND proof_id=$2 AND tenant_id=$3',[id,proofId,tenantId])).rows[0];
 if(!row||sources.length!==2)bad('RND_ENROLLMENT_COMPARISON_FORBIDDEN','A comparison requires one locked authorized enrollment and one later source',403);
 const event=(await tx.query<EventRow>('SELECT * FROM rnd_enrollment_events WHERE enrollment_id=$1 ORDER BY sequence DESC LIMIT 1',[id])).rows[0];
 if(event?.state!=='LOCKED')bad('RND_ENROLLMENT_NOT_LOCKED','Wait for the immutable enrollment analysis',409);
 const analysis=(await tx.query<AnalysisRow>('SELECT * FROM rnd_analyses WHERE id=$1 AND proof_id=$2 AND tenant_id=$3 AND operational_state=\'SUCCEEDED\'',[row.analysis_id,proofId,tenantId])).rows[0];
 const details=analysis?.result_json?.details as {observations?:Record<string,unknown>[];artifacts?:Record<string,unknown>[]}|undefined;
 const value=details?.observations?.find(o=>o.type==='PASSIVE_REGION_ENROLLMENT')?.value as Record<string,unknown>|undefined;
 const selected=value?.selectedSourceRef as {sourceId?:string;sha256?:string;frameIndex?:number;objectVersionId?:string}|undefined;
 if(!selected?.sourceId||!Array.isArray(value?.regions)||!value.regions.length)bad('RND_ENROLLMENT_UNAVAILABLE','No passively associated regions exist for this enrollment',409);
 const index=sources.findIndex(source=>source.sourceId===selected.sourceId&&source.sha256===String(selected.sha256).replace(/^sha256:/,'')&&source.objectVersionId===selected.objectVersionId);
 if(index<0)bad('RND_ENROLLMENT_SOURCE_MISMATCH','Comparison must retain the exact enrolled source version',403);
 if(index===1)sources.reverse();
 const artifact=details?.artifacts?.find(a=>a.artifactId==='enrollment.json');
 return {regions:value.regions,enrollmentFrameRef:selected,expectedEnrollmentDigest:artifact?.sha256??null,frozenRequiredGroups:row.frozen_groups,
  baselineQualification:'UNAVAILABLE',comparisonScope:'UNQUALIFIED_LOCKED_BASELINE_DIAGNOSTIC'};
}

export async function listEnrollments(deps:RndDeps,actor:string,proofId:string) {
 await authorized(deps.db,proofId,actor);requireRnd(deps.rnd,'proofprint','internalDisplay');
 const rows=(await deps.db.query<EnrollmentRow>('SELECT * FROM rnd_enrollments WHERE proof_id=$1 ORDER BY created_at,id',[proofId])).rows;
 return {schemaVersion:'packproof.enrollment-list.v1',enrollments:await Promise.all(rows.map(async row=>{
  const events=(await deps.db.query<EventRow>('SELECT * FROM rnd_enrollment_events WHERE enrollment_id=$1 ORDER BY sequence',[row.id])).rows;
  const analysis=(await deps.db.query<{operational_state:string;error_code:string|null}>('SELECT operational_state,error_code FROM rnd_analyses WHERE id=$1',[row.analysis_id])).rows[0];
  return {enrollmentId:row.id,analysisId:row.analysis_id,subjectId:row.subject_id,rootManifestDigest:`sha256:${row.root_digest}`,sourceInventory:row.source_inventory,
   frozenRequiredGroups:row.frozen_groups,policyVersion:row.policy_version,analysisOperationalState:analysis?.operational_state??'UNAVAILABLE',analysisErrorCode:analysis?.error_code??null,supersedesEnrollmentId:row.supersedes_id,state:events.at(-1)?.state??'CANDIDATE',qualified:false,
   events:events.map(e=>({state:e.state,canonicalJson:e.canonical_json,digest:e.digest,signature:e.signature}))};
 }))};
}

export function rndEnrollmentRouter(deps:RndDeps) {
 const router=Router();
 const route=(fn:(r:Request,s:Response)=>Promise<unknown>)=>(r:Request,s:Response,next:NextFunction)=>{void fn(r,s).catch(next);};
 const actor=(r:Request)=>r.packproofUserId??bad('UNAUTHENTICATED','Authentication required',401);
 router.post('/proofs/:id/rnd/enrollments',route(async(r,s)=>s.status(202).json(await createEnrollment(deps,actor(r),r.params.id,r.header('Idempotency-Key'),r.body))));
 router.get('/proofs/:id/rnd/enrollments',route(async(r,s)=>s.json(await listEnrollments(deps,actor(r),r.params.id))));
 return router;
}
