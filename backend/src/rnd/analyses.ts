import { readFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { newId } from '../ids.js';
import { sha256Hex } from '../hash.js';
import { canonicalize,assertAnalysisEnvelope,assertEvidenceExtension,type SourceRef } from '../../../packages/evidence-contracts/contracts.mjs';
import { loadProof } from '../domain/proof-access.js';
import type { Database } from '../db/database.js';
import { requireRnd } from './config.js';
import { authorized,bad,boundedId,digest,idempotent,onlyKeys,requireConsent,resolveSources,signedRecord,subjectFor,nonce } from './security.js';
import { FEATURES,type Feature,type RndDeps,type AnalysisInput,type AnalysisRow,type Source,type WorkerResult } from './types.js';
import { executeVision,shipmentObservations } from './worker.js';
import { assertSystemAdmin } from '../admin/auth.js';
import { executableInventory } from './method.js';
import { bindEnrollmentComparison,onEnrollmentAnalysisCompleted } from './enrollment.js';

export const POLICY='packproof.rnd.conservative.v1';
export const sourceRef=(s:Source):SourceRef=>({sourceId:s.sourceId,proofId:s.proofId,objectKey:s.objectKey,objectVersionId:s.objectVersionId,sha256:`sha256:${s.sha256}`,byteLength:s.byteLength,mimeType:s.mimeType,captureSessionId:s.captureSessionId,relationship:s.relationship??(s.captureSessionId?'ORIGINAL_RECORDING':'PARTICIPANT_IMPORT'),retentionState:'AVAILABLE',...(s.frameReference?{frameReference:{sampleId:s.frameReference.sampleId===undefined?null:String(s.frameReference.sampleId),offsetMs:typeof s.frameReference.offsetMs==='number'?s.frameReference.offsetMs:typeof s.frameReference.mediaTimeMs==='number'?s.frameReference.mediaTimeMs:null,clockDomain:typeof s.frameReference.clockDomain==='string'?s.frameReference.clockDomain:null,decoderBuild:null,rotation:typeof s.frameReference.rotation==='number'?s.frameReference.rotation:typeof s.frameReference.rotationDegrees==='number'?s.frameReference.rotationDegrees:null,colorConversion:typeof s.frameReference.colorConversion==='string'?s.frameReference.colorConversion:null}}:{})});
const featureOf=(value:unknown):Feature=>FEATURES.includes(value as Feature)?value as Feature:bad('RND_UNKNOWN_FEATURE','Unsupported research feature');
function parametersFor(feature:Feature,value:unknown):Record<string,unknown> {
 if(value===undefined)return {};
 const allowed:Record<Feature,string[]>={proofprint:['mode','regions','enrollmentId'],verifiedcapture:[],proofsight:['samplingHz','annotations','segmentation'],prooftwin:['mode','regions','objectMasks','focalLengthPixels'],proofmatch:[],prooflive:['challengeId'],proofshield:['masks','kind','mode','enrollmentId','mask'],proofpilot:['samplingHz'],proofwitness:[],proofcollective:['learningReportId']};
 onlyKeys(value,allowed[feature]);
 if(canonicalize(value).length>32_768)bad('RND_PARAMETERS_LIMIT','Parameters exceed the bounded request policy');
 return JSON.parse(canonicalize(value)) as Record<string,unknown>;
}
export async function requestAnalysis(deps:RndDeps,actor:string,proofId:string,key:unknown,input:unknown) {
 onlyKeys(input,['feature','evidenceIds','scope','parameters','relatedAnalysisIds']);
 const feature=featureOf(input.feature);requireRnd(deps.rnd,feature,'processing');
 const parameters=parametersFor(feature,input.parameters),scope=boundedId(input.scope??'research-observations','scope');
 return idempotent(deps,proofId,actor,`analysis:${feature}`,key,input,async tx=>{
  await requireConsent(tx,proofId,actor);
  if(feature==='proofcollective'){await assertSystemAdmin(tx,actor);await requireConsent(tx,proofId,actor,'LEARNING');}
  const {tenantId,proof}=await authorized(tx,proofId,actor);
  if(proof.status!=='FINALIZED')bad('RND_ROOT_NOT_SEALED','Finalize the ordinary Proof before asynchronous research analysis',409);
  const root=(await tx.query<{sha256:string}>('SELECT sha256 FROM final_manifests WHERE proof_id=$1',[proofId])).rows[0];
  if(!root)bad('RND_ROOT_NOT_SEALED','A sealed root manifest is required',409);
  await tx.query('SELECT pg_advisory_xact_lock(hashtext($1),79)',[tenantId]);
  const admission=(await tx.query<{active:string;hourly:string}>(`SELECT COUNT(*) FILTER(WHERE operational_state IN ('QUEUED','RUNNING')) AS active,COUNT(*) FILTER(WHERE feature='proofmatch' AND created_at>=$2) AS hourly FROM rnd_analyses WHERE tenant_id=$1`,[tenantId,new Date(deps.clock.now().getTime()-3600000).toISOString()])).rows[0];
  if(Number(admission.active)>=32||feature==='proofmatch'&&Number(admission.hourly)>=20)bad('RND_ADMISSION_LIMIT','Research queue or comparison-probing budget reached; retry existing requests with their original idempotency keys',429);
  const sources=await resolveSources(deps,tx,proofId,actor,input.evidenceIds);
  if(feature==='proofsight'&&parameters.annotations!==undefined)parameters.annotationActorId=actor;
  if(feature==='proofprint'&&parameters.mode!=='enroll'&&parameters.enrollmentId){Object.assign(parameters,await bindEnrollmentComparison(tx,proofId,tenantId,parameters.enrollmentId,sources));}
  if(feature==='proofmatch'&&(sources.length!==2||sources[0].legId===sources[1].legId))bad('RND_COMPARISON_RELATION','Comparison requires two committed sources from different authorized lifecycle legs of one Proof',409);
  const mixedSubjects=sources.some(s=>s.subjectId!==sources[0].subjectId||s.packageInstanceId!==sources[0].packageInstanceId||s.legId!==sources[0].legId);
  if(mixedSubjects&&(!['proofmatch','proofprint','prooftwin'].includes(feature)||sources.length!==2))bad('RND_SOURCE_SUBJECT_MISMATCH','This analysis requires a single bound subject or an authorized two-source comparison',409);
  const related=input.relatedAnalysisIds??[];
  if(!Array.isArray(related)||related.length>20||new Set(related).size!==related.length)bad('RND_INVALID_RELATED','Invalid supporting analysis list');
  for(const raw of related){
   const id=boundedId(raw,'analysis');
   const found=(await tx.query<AnalysisRow>('SELECT * FROM rnd_analyses WHERE id=$1 AND proof_id=$2 AND tenant_id=$3 AND operational_state=\'SUCCEEDED\'',[id,proofId,tenantId])).rows[0];
   if(!found||found.input_json.sources.some(s=>!sources.some(src=>src.sourceId===s.sourceId)))bad('RND_RELATED_SOURCE_FORBIDDEN','Supporting findings must be completed and bound to these same authorized sources',403);
  }
  if(feature==='prooflive'){
   const challengeId=boundedId(parameters.challengeId,'challenge');
   const challenge=(await tx.query<{canonical_json:string;expires_at:Date|string;capture_session_id:string}>(`SELECT c.canonical_json,c.expires_at,s.capture_session_id FROM rnd_live_challenges c JOIN rnd_session_starts s ON s.intent_id=c.intent_id WHERE c.id=$1 AND c.proof_id=$2 AND c.actor_id=$3`,[challengeId,proofId,actor])).rows[0];
   if(!challenge||sources.length!==1||sources[0].captureSessionId!==challenge.capture_session_id)bad('RND_CHALLENGE_BINDING','Response source must belong to the challenged capture',403);
   if(new Date(challenge.expires_at).getTime()<=deps.clock.now().getTime())bad('RND_CHALLENGE_EXPIRED','Response was not committed within the laboratory freshness window',409);
   if((await tx.query('SELECT 1 FROM rnd_live_responses WHERE challenge_id=$1',[challengeId])).rows[0])bad('RND_CHALLENGE_REPLAY','Challenge already has an immutable response',409);
   parameters.challenge=JSON.parse(challenge.canonical_json);
  }
  const subject=await subjectFor(deps,tx,proofId,actor,sources[0].legId);
  const method=await executableInventory(deps,feature);
  const request:AnalysisInput={schemaVersion:'packproof.analysis-request.v1',feature,proofId,tenantId,actorId:actor,rootManifestDigest:root.sha256,subject,sources,scope,policyVersion:POLICY,parameters,relatedAnalysisIds:related.map(String),executableDigest:method.digest};
  if(feature==='proofmatch')parameters.shipmentObservations=await shipmentObservations(deps,{input_json:request,proof_id:proofId,root_digest:root.sha256});
  const identityDigest=digest(request),prior=(await tx.query<AnalysisRow>('SELECT * FROM rnd_analyses WHERE tenant_id=$1 AND identity_digest=$2',[tenantId,identityDigest])).rows[0];
  if(prior)return analysisView(prior);
  if(feature==='proofwitness')request.parameters={...parameters,blind:randomBytes(32).toString('hex'),recordDigest:identityDigest};
  const id=newId('rnd_analysis'),at=deps.clock.now().toISOString();
  const heavy=feature==='proofshield'&&String(parameters.mode).startsWith('zk-');
  await tx.query(`INSERT INTO rnd_analyses(id,proof_id,tenant_id,actor_id,feature,identity_digest,root_digest,input_json,operational_state,available_at,created_at,max_attempts) VALUES($1,$2,$3,$4,$5,$6,$7,$8,'QUEUED',$9,$9,$10)`,[id,proofId,tenantId,actor,feature,identityDigest,root.sha256,JSON.stringify(request),at,heavy?1:3]);
  if(feature==='prooflive')await tx.query('INSERT INTO rnd_live_responses(challenge_id,analysis_id,source_id,created_at) VALUES($1,$2,$3,$4)',[parameters.challengeId,id,sources[0].sourceId,at]);
  return {analysisId:id,feature,operationalState:'QUEUED',findingState:'NOT_CHECKED',result:null,errorCode:null,createdAt:at,completedAt:null};
 });
}
export function analysisView(row:AnalysisRow) {
 return {analysisId:row.id,feature:row.feature,operationalState:row.operational_state,findingState:row.result_json?.findingState??'NOT_CHECKED',result:row.result_json,errorCode:row.error_code,createdAt:new Date(row.created_at).toISOString(),completedAt:row.completed_at?new Date(row.completed_at).toISOString():null};
}
export async function getAnalysis(deps:RndDeps,actor:string,id:string) {
 const row=(await deps.db.query<AnalysisRow>('SELECT * FROM rnd_analyses WHERE id=$1',[id])).rows[0];
 if(!row)bad('RND_ANALYSIS_NOT_FOUND','Analysis unavailable',404);
 await authorized(deps.db,row.proof_id,actor);requireRnd(deps.rnd,row.feature,'internalDisplay');
 return analysisView(row);
}
export async function listAnalyses(deps:RndDeps,actor:string,proofId:string) {
 await authorized(deps.db,proofId,actor);
 if(!deps.rnd?.enabled||deps.rnd.killSwitch)bad('RND_DISABLED','Experimental analysis is disabled',404);
 const rows=(await deps.db.query<AnalysisRow>('SELECT * FROM rnd_analyses WHERE proof_id=$1 ORDER BY created_at DESC,id DESC LIMIT 100',[proofId])).rows.filter(r=>deps.rnd!.features[r.feature].internalDisplay);
  const available=(await deps.db.query<Record<string,unknown>>(`SELECT id,content_type,byte_size,sha256,'OUTBOUND' AS leg_id FROM evidence WHERE proof_id=$1 AND validation_status='COMMITTED' UNION ALL SELECT e.id,e.content_type,e.byte_size,e.sha256,s.id AS leg_id FROM commerce_stage_evidence e JOIN commerce_stages s ON s.id=e.stage_id WHERE s.proof_id=$1 AND e.committed_at IS NOT NULL AND e.discarded_at IS NULL`,[proofId])).rows;
  const sidecars=(await deps.db.query<Record<string,unknown>>(`SELECT c.id,c.mime_type AS content_type,c.byte_length AS byte_size,c.sha256,s.leg_id,c.parent_evidence_id,c.frame_reference,'CONCURRENT_SIDECAR' AS relationship FROM rnd_capture_sidecars c JOIN rnd_subjects s ON s.id=c.subject_id WHERE c.proof_id=$1 AND c.mime_type LIKE 'image/%'`,[proofId])).rows;available.push(...sidecars);
 return {analyses:rows.map(analysisView),sources:available.map(s=>({sourceId:s.id,evidenceId:s.id,proofId,mimeType:s.content_type,byteLength:Number(s.byte_size),sha256:s.sha256,legId:s.leg_id,retentionState:'AVAILABLE',relationship:s.relationship??'ORIGINAL_RECORDING',...(s.parent_evidence_id?{parentEvidenceId:s.parent_evidence_id,frameReference:s.frame_reference}:{})})),limitations:['Research findings are unqualified for customer claims.','Different lifecycle legs are separate package subjects until physical correspondence is independently qualified.']};
}
export async function leaseAnalysis(deps:RndDeps):Promise<AnalysisRow|null> {
 if(!deps.rnd?.enabled||deps.rnd.killSwitch)return null;
 return deps.db.transaction(async tx=>{
  await tx.query('SELECT pg_advisory_xact_lock(1347438146,79)');
  const at=deps.clock.now().toISOString();
  await tx.query(`UPDATE rnd_analyses SET operational_state='FAILED',error_code='RND_LEASE_EXHAUSTED',lease_token=NULL,lease_until=NULL,completed_at=$1 WHERE operational_state='RUNNING' AND lease_until<=$1 AND attempts>=max_attempts`,[at]);
  const eligible=FEATURES.filter(f=>deps.rnd!.features[f].processing);
  const row=(await tx.query<AnalysisRow>(`SELECT * FROM rnd_analyses candidate WHERE feature=ANY($2::text[]) AND attempts<max_attempts AND ((operational_state='QUEUED' AND available_at<=$1) OR (operational_state='RUNNING' AND lease_until<=$1))
   AND (COALESCE(candidate.input_json->'parameters'->>'mode','') NOT LIKE 'zk-%' OR NOT EXISTS(SELECT 1 FROM rnd_analyses heavy WHERE heavy.operational_state='RUNNING' AND heavy.lease_until>$1 AND heavy.input_json->'parameters'->>'mode' LIKE 'zk-%'))
   ORDER BY created_at,id FOR UPDATE SKIP LOCKED LIMIT 1`,[at,eligible])).rows[0];
  if(!row)return null;
  const heavy=row.feature==='proofshield'&&String(row.input_json.parameters.mode).startsWith('zk-');
  const token=nonce(),until=new Date(deps.clock.now().getTime()+(heavy?Math.min(180_000,(deps.rnd?.zk?.timeoutMs??120_000)+30_000):90_000)).toISOString();
  await tx.query(`UPDATE rnd_analyses SET operational_state='RUNNING',attempts=attempts+1,lease_token=$2,lease_until=$3,error_code=NULL WHERE id=$1`,[row.id,token,until]);
  return {...row,operational_state:'RUNNING',attempts:row.attempts+1,lease_token:token,lease_until:until};
 });
}
export async function completeAnalysis(deps:RndDeps,job:AnalysisRow,result:WorkerResult,executableDigest:string) {
 requireRnd(deps.rnd,job.feature,'processing');
 const envelope=assertAnalysisEnvelope({schemaVersion:'packproof.analysis.v1',feature:job.feature,tenantId:job.tenant_id,proofId:job.proof_id,rootManifestDigest:`sha256:${job.root_digest}`,subject:{packageInstanceId:job.input_json.subject.packageInstanceId,shipmentLegId:job.input_json.subject.legId},analysisId:job.id,sourceRefs:job.input_json.sources.map(sourceRef),inputDigest:`sha256:${digest(job.input_json)}`,method:{executableDigest:`sha256:${executableDigest}`,modelDigest:job.feature==='proofsight'&&deps.rnd?.worker?.proofsightModel&&result.provenance?.modelDigest===`sha256:${deps.rnd.worker.proofsightModel.sha256}`?String(result.provenance.modelDigest):null,policyVersion:POLICY},operationalState:'SUCCEEDED',findingState:result.findingState,scope:job.input_json.scope,coverage:result.coverage,reasonCodes:['RESEARCH_PROFILE_UNQUALIFIED'],limitations:result.limitations,supersedesId:null,serverReceivedAt:new Date(job.created_at).toISOString(),analyzedAt:deps.clock.now().toISOString(),qualification:{gate:'G0',scope:'LOCAL_PROTOCOL_ONLY',recordId:null},details:{input:job.input_json,observations:result.observations,artifacts:result.artifacts??[],diagnostics:result.diagnostics??{},provenance:result.provenance??{},resourceUsage:result.resourceUsage??{}}});
 // No executable may promote unqualified physical claims. Typed matrix differences concern observations only.
 if(['CONSISTENT','DIFFERENCE_OBSERVED'].includes(result.findingState)&&job.feature!=='proofmatch')bad('RND_UNQUALIFIED_FINDING','This profile cannot issue a qualified physical finding');
 return deps.db.transaction(async tx=>{
  await loadProof(tx,job.proof_id,true);
  await authorized(tx,job.proof_id,job.actor_id);await requireConsent(tx,job.proof_id,job.actor_id);
  const current=(await tx.query<AnalysisRow>('SELECT * FROM rnd_analyses WHERE id=$1 FOR UPDATE',[job.id])).rows[0];
  if(current.operational_state!=='RUNNING'||current.lease_token!==job.lease_token||new Date(current.lease_until!).getTime()<=deps.clock.now().getTime())bad('RND_LEASE_LOST','Expired worker cannot publish a result',409);
  const root=(await tx.query<{sha256:string}>('SELECT sha256 FROM final_manifests WHERE proof_id=$1',[job.proof_id])).rows[0];
  if(root.sha256!==job.root_digest)bad('RND_ROOT_CHANGED','Sealed root commitment changed',409);
  const previous=(await tx.query<{sequence:number;digest:string}>('SELECT sequence,digest FROM rnd_extensions WHERE proof_id=$1 ORDER BY sequence DESC LIMIT 1',[job.proof_id])).rows[0];
  const id=newId('rnd_extension'),sequence=(previous?.sequence??0)+1;
  const extension={schemaVersion:'packproof.extension.v1',extensionId:id,proofId:job.proof_id,tenantId:job.tenant_id,rootManifestDigest:`sha256:${job.root_digest}`,sequence,previousDigest:previous?`sha256:${previous.digest}`:null,eventKind:'ANALYSIS_COMPLETED',analysis:envelope,issuedAt:deps.clock.now().toISOString()};
  assertEvidenceExtension(extension);
  const signed=await signedRecord(deps,job.proof_id,id,extension);
  await tx.query(`UPDATE rnd_analyses SET operational_state='SUCCEEDED',result_json=$2,completed_at=$3,lease_token=NULL,lease_until=NULL WHERE id=$1`,[job.id,JSON.stringify(envelope),deps.clock.now().toISOString()]);
  await tx.query('INSERT INTO rnd_extensions(id,proof_id,tenant_id,sequence,previous_digest,root_digest,analysis_id,canonical_json,digest,signature,created_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)',[id,job.proof_id,job.tenant_id,sequence,previous?.digest??null,job.root_digest,job.id,signed.canonicalJson,signed.digest,JSON.stringify(signed.signature),deps.clock.now().toISOString()]);
  await onEnrollmentAnalysisCompleted(deps,tx,job,envelope as unknown as Record<string,unknown>);
  return envelope;
 });
}
export async function failAnalysis(deps:RndDeps,job:AnalysisRow,code:string) {
 const terminal=job.attempts>=job.max_attempts||['RND_CONSENT_REQUIRED','RND_SOURCE_INTEGRITY','RND_WORKER_OUTPUT_INVALID','RND_UNQUALIFIED_FINDING','RND_EXECUTABLE_CHANGED'].includes(code);
 await deps.db.query(`UPDATE rnd_analyses SET operational_state=$3,error_code=$4,lease_token=NULL,lease_until=NULL,available_at=$5,completed_at=$6 WHERE id=$1 AND operational_state='RUNNING' AND lease_token=$2`,[job.id,job.lease_token,terminal?'FAILED':'QUEUED',code,new Date(deps.clock.now().getTime()+Math.min(60_000,1000*2**job.attempts)).toISOString(),terminal?deps.clock.now().toISOString():null]);
}
export async function runRndWorkerOnce(deps:RndDeps,adapter?:((job:AnalysisRow)=>Promise<WorkerResult>)) {
 const job=await leaseAnalysis(deps);if(!job)return {state:'IDLE'};
 try {
  await authorized(deps.db,job.proof_id,job.actor_id);await requireConsent(deps.db,job.proof_id,job.actor_id);
  const method=await executableInventory(deps,job.feature);
  if(!adapter&&job.input_json.executableDigest!==method.digest)bad('RND_EXECUTABLE_CHANGED','Queued executable differs from the frozen job; request a new analysis with the updated method',409);
  const result=adapter?await adapter(job):await executeVision(deps,job);
  result.provenance={...result.provenance,executableInventory:method.files};
  const executableDigest=adapter?sha256Hex('TEST_INJECTED_ADAPTER'):method.digest;
  await completeAnalysis(deps,job,result,executableDigest);
  return {state:'SUCCEEDED',analysisId:job.id};
 } catch(error) {
  const code=error&&typeof error==='object'&&'code' in error&&typeof error.code==='string'&&/^RND_[A-Z_]+$/.test(error.code)?error.code:'RND_WORKER_FAILED';
  await failAnalysis(deps,job,code);return {state:'FAILED',analysisId:job.id,errorCode:code};
 }
}
