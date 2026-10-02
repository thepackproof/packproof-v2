import { randomBytes } from 'node:crypto';
import { Router,type Request,type Response,type NextFunction } from 'express';
import { assertSystemAdmin } from '../admin/auth.js';
import { appendAudit } from '../domain/audit.js';
import { newId } from '../ids.js';
import { requireRnd } from './config.js';
import { authorized,bad,digest,idempotent,onlyKeys,requireConsent,resolveSources } from './security.js';
import { executableInventory } from './method.js';
import { analysisView } from './analyses.js';
import type { AnalysisRow,RndDeps } from './types.js';

export async function rndMetrics(deps:RndDeps,actor:string) {
 await assertSystemAdmin(deps.db,actor);if(!deps.rnd?.enabled)bad('RND_DISABLED','Experimental analysis is disabled',404);
 const rows=(await deps.db.query<Record<string,unknown>>(`SELECT feature,operational_state,count(*) AS jobs,sum(attempts) AS attempts,
 MIN(created_at) AS oldest_created_at,AVG(EXTRACT(EPOCH FROM(completed_at-created_at))*1000) AS average_completion_ms,
 SUM(CASE WHEN operational_state='RUNNING' AND lease_until<$1 THEN 1 ELSE 0 END) AS expired_leases
 FROM rnd_analyses GROUP BY feature,operational_state ORDER BY feature,operational_state`,[deps.clock.now().toISOString()])).rows;
 const errors=(await deps.db.query('SELECT feature,error_code,count(*) AS count FROM rnd_analyses WHERE error_code IS NOT NULL GROUP BY feature,error_code ORDER BY feature,error_code')).rows;
 const witness=await witnessMetrics(deps);
 return {schemaVersion:'packproof.rnd-metrics.v1',asOf:deps.clock.now().toISOString(),killSwitch:deps.rnd.killSwitch,rows:rows.map(r=>({...r,jobs:Number(r.jobs),attempts:Number(r.attempts),expired_leases:Number(r.expired_leases),average_completion_ms:r.average_completion_ms===null?null:Number(r.average_completion_ms),oldest_age_ms:Math.max(0,deps.clock.now().getTime()-new Date(r.oldest_created_at as string).getTime())})),errors,witness,limitations:['Completion latency includes queue time and retries.','Capture hardware pressure, cloud cost, qualified-profile coverage and physical accuracy require separate measured instrumentation.']};
}
async function witnessMetrics(deps:RndDeps) {
 // Project only operational metadata in SQL. Openings, signing material, sources and paths never enter this result.
 const recent=(await deps.db.query<Record<string,unknown>>(`SELECT id AS analysis_id,
 result_json#>>'{details,observations,0,receipt,trustPolicyId}' AS policy_id,
 result_json#>>'{details,observations,0,receipt,checkpoint,origin}' AS log_id,
 result_json#>>'{details,observations,0,receipt,checkpoint,issuedAt}' AS checkpoint_at,
 result_json#>>'{details,observations,0,receipt,checkpoint,treeSize}' AS tree_size,
 jsonb_array_length(COALESCE(result_json#>'{details,observations,0,receipt,witnessSignatures}','[]'::jsonb)) AS signature_count,
 result_json#>>'{details,observations,0,verification,assurance}' AS assurance,
 result_json#>>'{details,observations,0,verification,independentOperatorCount}' AS independent_count
 FROM rnd_analyses WHERE feature='proofwitness' AND operational_state='SUCCEEDED' ORDER BY completed_at DESC,id DESC LIMIT 100`)).rows;
 const latest=new Map<string,Record<string,unknown>>();
 for(const row of recent){
  const key=JSON.stringify([row.log_id,row.policy_id]);if(latest.has(key))continue;
  const timestamp=Date.parse(String(row.checkpoint_at)),signedAge=Number.isFinite(timestamp)?deps.clock.now().getTime()-timestamp:null;
  latest.set(key,{analysisId:row.analysis_id,policyId:row.policy_id,logId:row.log_id,checkpointIssuedAt:row.checkpoint_at,checkpointAgeMs:signedAge===null?null:Math.max(0,signedAge),checkpointInFuture:signedAge!==null&&signedAge < -300000,treeSize:Number(row.tree_size),controlledSignatureCount:Number(row.signature_count),independentOperatorCount:Number(row.independent_count),assurance:row.assurance});
 }
 const failures=(await deps.db.query<{error_code:string;count:string}>(`SELECT error_code,COUNT(*) AS count FROM rnd_analyses WHERE feature='proofwitness' AND error_code IS NOT NULL AND created_at>=$1 GROUP BY error_code ORDER BY error_code`,[new Date(deps.clock.now().getTime()-86400000).toISOString()])).rows.map(row=>({code:row.error_code,jobs:Number(row.count),stage:/^RND_WITNESS_(APPEND|INCLUSION|CHECKPOINT|CONSISTENCY|OPERATOR|VERIFICATION)_/.exec(row.error_code)?.[1]??'UNCLASSIFIED'}));
 return {scope:'LOCAL_RESEARCH_CONTROLLED_OPERATORS',sampleLimit:100,sampledCompleted:recent.length,latestCheckpoints:[...latest.values()],attentionErrorsLast24Hours:failures,health:failures.length||[...latest.values()].some(r=>r.checkpointInFuture)?'NEEDS_ATTENTION':recent.length?'RESEARCH_OBSERVED':'NO_COMPLETED_RECEIPTS',limitations:['Operator-stage failures can include availability, policy or consistency problems; no specific attack is inferred.','Checkpoint age is measured, not a qualified publication-latency SLO. Locally controlled signatures are not independent witnessing.']};
}
export async function retryResearchAnalysis(deps:RndDeps,admin:string,analysisId:string,key:unknown,input:unknown) {
 await assertSystemAdmin(deps.db,admin);onlyKeys(input,['reason']);
 if(typeof input.reason!=='string'||input.reason.trim().length<3||input.reason.length>500)bad('RND_RETRY_REASON','An explicit bounded retry reason is required');
 const original=(await deps.db.query<AnalysisRow>('SELECT * FROM rnd_analyses WHERE id=$1',[analysisId])).rows[0];
 if(!original||original.operational_state!=='FAILED')bad('RND_RETRY_PRECONDITION','Only failed analyses may be retried through this administrative action',409);
 requireRnd(deps.rnd,original.feature,'processing');
 return idempotent(deps,original.proof_id,original.actor_id,`admin-retry:${admin}:${analysisId}`,key,input,async tx=>{
  await assertSystemAdmin(tx,admin);await authorized(tx,original.proof_id,original.actor_id);await requireConsent(tx,original.proof_id,original.actor_id);
  if(original.feature==='proofcollective'){await assertSystemAdmin(tx,original.actor_id);await requireConsent(tx,original.proof_id,original.actor_id,'LEARNING');}
  // Explicit reprocessing is a new record; terminal failures and original attempts remain immutable.
  const sources=await resolveSources(deps,tx,original.proof_id,original.actor_id,original.input_json.sources.map(s=>s.evidenceId));
  const method=await executableInventory(deps,original.feature),at=deps.clock.now().toISOString(),id=newId('rnd_analysis');
  const inputRecord={...original.input_json,sources,executableDigest:method.digest,retryOf:analysisId,retryRequestedBy:admin,retryReason:input.reason};
  if(original.feature==='proofwitness'){const {blind,recordDigest,...parameters}=inputRecord.parameters;inputRecord.parameters=parameters;inputRecord.parameters={...parameters,blind:randomBytes(32).toString('hex'),recordDigest:digest(inputRecord)};}
  if(original.feature==='prooflive')bad('RND_FRESH_CHALLENGE_REQUIRED','A failed scene challenge requires a new capture/challenge, not reuse of the previous response',409);
  await tx.query(`INSERT INTO rnd_analyses(id,proof_id,tenant_id,actor_id,feature,identity_digest,root_digest,input_json,operational_state,available_at,created_at,max_attempts) VALUES($1,$2,$3,$4,$5,$6,$7,$8,'QUEUED',$9,$9,$10)`,[id,original.proof_id,original.tenant_id,original.actor_id,original.feature,digest(inputRecord),original.root_digest,JSON.stringify(inputRecord),at,original.max_attempts]);
  await appendAudit(tx,{proofId:original.proof_id,actorUserId:admin,eventType:'RND_ANALYSIS_RETRY_REQUESTED',eventData:{analysisId:id,originalAnalysisId:analysisId,reason:input.reason},at:deps.clock.now()});
  return {analysisId:id,originalAnalysisId:analysisId,operationalState:'QUEUED'};
 });
}
export function rndOperationsRouter(deps:RndDeps) {
 const router=Router(),wrap=(fn:(r:Request,s:Response)=>Promise<unknown>)=>(r:Request,s:Response,n:NextFunction)=>{void fn(r,s).catch(n);};
 const actor=(r:Request)=>r.packproofUserId??bad('UNAUTHENTICATED','Authentication required',401);
 router.get('/rnd/metrics',wrap(async(r,s)=>s.json(await rndMetrics(deps,actor(r)))));
 router.post('/rnd/analyses/:analysisId/retry',wrap(async(r,s)=>s.status(202).json(await retryResearchAnalysis(deps,actor(r),r.params.analysisId,r.header('Idempotency-Key'),r.body))));return router;
}
