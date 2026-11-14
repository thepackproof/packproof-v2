import type {Database} from '../db/database.js';
import type {Clock} from '../clock.js';
import type {RecordWorkspace} from './access.js';
import {requireRecordWorkspace} from './access.js';
import {DomainError} from '../domain/errors.js';
import {requireCaseAccess} from './cases.js';
import {loadOperationalCaseProjection,readCaseSourceKeys,readCaseSourceCoverage,includePolicySourceCoverage,type CaseRow} from './reconstruction.js';
import {reconstructionFeatureEnabled} from './reconstruction-features.js';
import {readProjectionSourceCounter,reconcileProjectionSourceCounter,sourceProjectionSignature,projectionSourceDependencies} from './projection-store.js';
import {identityMappingDependencies} from './identity-projection.js';
import {sourceWorkRecheckIntervalMs,type SourceCoverage} from './coverage.js';

/** Derived worker state contains no original files or viewer-specific Proof
 * visibility. Active assertions, not retained timeline history, drive rules. */
export async function synchronizeOperationalCaseProjection(db:Database,clock:Clock,w:RecordWorkspace,caseId:string){
 const c=await requireCaseAccess(db,clock,w,caseId) as CaseRow;
 const sourceKeys=await readCaseSourceKeys(db,w,c),sources:SourceCoverage[]=[];
 for(const key of sourceKeys){const [id,connectionId,namespace]=JSON.parse(key) as string[];sources.push(await readCaseSourceCoverage(db,clock,w,c,id,connectionId,namespace));}
 await includePolicySourceCoverage(db,clock,w,c,sources);
 for(const source of sources)if(source.subscriptionId&&!(await readProjectionSourceCounter(db,source.subscriptionId)).ready)await reconcileProjectionSourceCounter(db,clock,source.subscriptionId);
 const projection=await loadOperationalCaseProjection(db,clock,w,caseId,{evaluation:true});
 const now=clock.now(),futureDeadlines=projection.comparisons.flatMap(c=>c.deadlineAt&&Date.parse(c.deadlineAt)>now.getTime()?[Date.parse(c.deadlineAt)]:[]),freshness=projection.sources.flatMap(s=>s.expectedIntervalSeconds&&s.coverage==='qualified'&&['current','quiet_checked'].includes(s.state)?[Math.min(...[s.lastCheckedAt,s.sourceAsOf,s.completeness.asOf].map(t=>Date.parse(t!)))+s.expectedIntervalSeconds*1000]:[]),validUntil=new Date(Math.min(now.getTime()+86400000,...(freshness.length?freshness:[now.getTime()+60000]),...futureDeadlines)).toISOString(),next=new Date(Math.min(now.getTime()+sourceWorkRecheckIntervalMs(projection.sources),Date.parse(validUntil))).toISOString();
 await db.transaction(async tx=>{
  await tx.query('SELECT pg_advisory_xact_lock(1347438167,hashtext($1))',[caseId]);
  await tx.query('SELECT id FROM record_cases WHERE id=$1 FOR UPDATE',[caseId]);
  const current=await requireCaseAccess(tx,clock,w,caseId);
  if(Number(current.revision)!==projection.case.revision)throw new DomainError('CASE_PROJECTION_CHANGED','Case inputs changed before the derived projection was committed',409);
  for(let index=0;index<projection.comparisons.length;index++){
   const comparison=projection.comparisons[index];
   await tx.query('INSERT INTO record_case_projection_comparisons(case_id,projection_version,comparison_id,position,data) VALUES($1,$2,$3,$4,$5::jsonb) ON CONFLICT DO NOTHING',[caseId,projection.projectionVersion,comparison.id,index,JSON.stringify(comparison)]);
  }
  await tx.query(`INSERT INTO record_case_projection_state(case_id,case_revision,projection_version,source_signature,summary,source_keys,source_snapshot,rule_capabilities,comparison_count,created_at,valid_until,next_check_at,error_code) VALUES($1,$2,$3,$4,$5::jsonb,$6::jsonb,$7::jsonb,$8::jsonb,$9,$10,$11,$12,NULL) ON CONFLICT(case_id) DO UPDATE SET case_revision=EXCLUDED.case_revision,projection_version=EXCLUDED.projection_version,source_signature=EXCLUDED.source_signature,summary=EXCLUDED.summary,source_keys=EXCLUDED.source_keys,source_snapshot=EXCLUDED.source_snapshot,rule_capabilities=EXCLUDED.rule_capabilities,comparison_count=EXCLUDED.comparison_count,created_at=EXCLUDED.created_at,valid_until=EXCLUDED.valid_until,next_check_at=EXCLUDED.next_check_at,error_code=NULL`,[caseId,projection.case.revision,projection.projectionVersion,sourceProjectionSignature({sources:projectionSourceDependencies(projection.sources),identityMappings:identityMappingDependencies(projection.identityMappings)}),JSON.stringify({issueCount:projection.case.issueCount}),JSON.stringify(sourceKeys),JSON.stringify(projection.sources),JSON.stringify(projection.ruleCapabilities),projection.comparisons.length,now.toISOString(),validUntil,next]);
 });
 return {caseId,projectionVersion:projection.projectionVersion,comparisonCount:projection.comparisons.length};
}

/** At most 100 dirty/due cases per invocation; failed current operator authority
 * backs off independently. Historical ingestion credentials are never replayed. */
export async function processPendingCaseProjections(db:Database,clock:Clock,limit=100){
 if(!reconstructionFeatureEnabled('reconstruction')||!reconstructionFeatureEnabled('pagedProjections'))return {processed:0,blocked:0};
 const n=Math.max(1,Math.min(100,Math.floor(limit))),now=clock.now().toISOString();
 const rows=(await db.query<{id:string;operator_membership_id:string;organization_id:string;environment:'sandbox'|'live'}>(`SELECT c.id,c.operator_membership_id,c.organization_id,c.environment FROM record_cases c LEFT JOIN record_case_projection_state s ON s.case_id=c.id WHERE s.case_id IS NULL OR (s.case_revision<c.revision AND (s.error_code IS NULL OR s.next_check_at<=$1)) OR s.next_check_at<=$1 ORDER BY CASE WHEN s.case_id IS NULL OR s.case_revision<c.revision THEN 0 ELSE 1 END,COALESCE(s.next_check_at,c.created_at),c.id LIMIT $2`,[now,n])).rows;
 let processed=0,blocked=0;
 for(const row of rows){try{
  const operator=(await db.query<{user_id:string}>('SELECT user_id FROM platform_memberships WHERE id=$1 AND organization_id=$2 AND revoked_at IS NULL',[row.operator_membership_id,row.organization_id])).rows[0];
  if(!operator)throw new DomainError('SOURCE_AUTHORIZATION_REQUIRED','Current case operator authority is unavailable',403);
  const w=await requireRecordWorkspace(db,operator.user_id,row.organization_id,row.environment);
  await synchronizeOperationalCaseProjection(db,clock,w,row.id);processed++;
 }catch(error){
  const code=error instanceof DomainError?error.code:'CASE_PROJECTION_RETRY';
  await db.query(`INSERT INTO record_case_projection_state(case_id,case_revision,projection_version,source_signature,summary,source_keys,source_snapshot,rule_capabilities,comparison_count,created_at,valid_until,next_check_at,error_code) VALUES($1,0,'','', '{}'::jsonb,'[]'::jsonb,'[]'::jsonb,'{}'::jsonb,0,$2,$2,$3,$4) ON CONFLICT(case_id) DO UPDATE SET next_check_at=EXCLUDED.next_check_at,error_code=EXCLUDED.error_code`,[row.id,now,new Date(clock.now().getTime()+(code==='CASE_PROJECTION_CHANGED'?250:300000)).toISOString(),code]);blocked++;
 }}
 return {processed,blocked};
}

export function operationalProjectionWorkerConfig(env:NodeJS.ProcessEnv=process.env){
 const integer=(name:string,fallback:number,min:number,max:number)=>{const n=Number(env[name]??fallback);if(!Number.isInteger(n)||n<min||n>max)throw new Error(`${name} must be an integer from ${min} to ${max}`);return n;};
 return {maxCasesPerPass:integer('PACKPROOF_CASE_PROJECTION_MAX_CASES_PER_PASS',100,1,100),intervalMs:integer('PACKPROOF_CASE_PROJECTION_INTERVAL_MS',250,250,60000)};
}
