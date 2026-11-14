import type {Database} from '../db/database.js';
import type {Clock} from '../clock.js';
import {DomainError} from '../domain/errors.js';
import {canonicalize} from '../canonical.js';
import {sha256Hex} from '../hash.js';
import {newId} from '../ids.js';
import {idempotent} from '../platform/idempotency.js';
import {strictBody,auditOrganization} from '../platform/organizations.js';
import {textField} from '../platform/tenants.js';
import {requireRecordWorkspace,type RecordWorkspace} from './access.js';
import {requireCaseAccess} from './cases.js';
import {loadOperationalCaseProjection} from './reconstruction.js';
import {requireReconstructionFeature,reconstructionFeatureEnabled} from './reconstruction-features.js';
import {RECONSTRUCTION_RULE_VERSION,type ReconstructionComparison} from './reconstruction-rules.js';

interface IssueRow {id:string;case_id:string;category:string;rule_version:string;subject:unknown;created_at:string|Date}
type Evaluation=Pick<ReconstructionComparison,'outcome'|'title'|'explanation'|'inputAssertionIds'>&{sourceHealth?:unknown;ruleVersion?:string;physicalCondition?:string};
const iso=(value:Date|string)=>new Date(value).toISOString();

/** Association correction changes current visibility, not the immutable ledger.
 * A historical finding cannot serve as an alternate route to rows now belonging
 * to another case. Exports explicitly inventory these restricted evaluations. */
async function restrictEvaluations(db:Database,caseId:string,values:Array<Evaluation|null>) {
 const ids=[...new Set(values.flatMap(value=>value?.inputAssertionIds??[]))];
 const allowed=new Set(ids.length?(await db.query<{id:string}>(`SELECT a.id FROM record_case_assertions a JOIN record_typed_rows r ON r.id=a.observation_id WHERE a.case_id=$1 AND r.case_id=a.case_id AND r.status='accepted_linked' AND a.id=ANY($2::text[])`,[caseId,ids])).rows.map(row=>row.id):[]);
 return values.map(value=>{
  if(value===null||value.inputAssertionIds.every(id=>allowed.has(id)))return value;
  return {outcome:'not_comparable',title:'Historical inputs have restricted visibility',explanation:'This evaluation was created under an earlier association. One or more inputs are no longer within this case current authorized scope. The immutable history is retained with source details withheld.',inputAssertionIds:value.inputAssertionIds.filter(id=>allowed.has(id)),historyVisibility:'restricted',omissions:['Source values, row details and source identifiers outside the current case association are withheld.']} as Evaluation&{historyVisibility:'restricted';omissions:string[]};
 });
}

async function appendAction(db:Database,clock:Clock,caseId:string,issueId:string,action:string,reason:string,actor:string|null,assignee:string|null=null,id?:string) {
 const sequence=Number((await db.query<{n:number}>('SELECT COALESCE(MAX(sequence),0)+1 AS n FROM record_case_issue_actions WHERE issue_id=$1',[issueId])).rows[0].n);
 const actionId=id??newId('case_issue_action');
 if(action==='system_resolve'||action==='system_reopen')await db.query('INSERT INTO record_case_issue_actions(id,issue_id,case_id,sequence,action,reason,created_at) VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(id) DO NOTHING',[actionId,issueId,caseId,sequence,action,reason,clock.now().toISOString()]);
 else await db.query('INSERT INTO record_case_issue_actions(id,issue_id,case_id,sequence,action,reason,actor_user_id,assignee_membership_id,created_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT(id) DO NOTHING',[actionId,issueId,caseId,sequence,action,reason,actor,assignee,clock.now().toISOString()]);
 return actionId;
}
async function currentAction(db:Database,id:string){return (await db.query<{action:string}>('SELECT action FROM record_case_issue_actions WHERE issue_id=$1 AND action NOT IN (\'note\',\'assign\') ORDER BY sequence DESC LIMIT 1',[id])).rows[0]?.action??'reopen';}

/** Called by the typed-ingestion worker after its durable projection commit.
 * Replaying the same input revision never duplicates an issue or action. */
export async function synchronizeOperationalCaseIssues(db:Database,clock:Clock,w:RecordWorkspace,caseId:string) {
 requireReconstructionFeature('rules');requireReconstructionFeature('sourceHealth');
 const projection=await loadOperationalCaseProjection(db,clock,w,caseId);
 return db.transaction(async tx=>{
  await tx.query('SELECT pg_advisory_xact_lock(1347438157,hashtext($1))',[caseId]);
  await tx.query('SELECT id FROM record_cases WHERE id=$1 FOR UPDATE',[caseId]);
  const c=await requireCaseAccess(tx,clock,w,caseId);
  if(Number(c.revision)!==projection.case.revision)throw new DomainError('CASE_PROJECTION_CHANGED','The case changed before its rules could be committed',409);
  const existing=(await tx.query<IssueRow>('SELECT * FROM record_case_issues WHERE case_id=$1 ORDER BY id',[caseId])).rows;
  const evaluations=new Map<string,{category:string;subject:unknown;value:Evaluation}>();
  for(const comparison of projection.comparisons)evaluations.set(comparison.issueKey,{category:comparison.category,subject:comparison.subject,value:comparison});
  // Coverage findings identify missing information, not a missing physical
  // action. Unknown/unqualified cadence does not manufacture an overdue alert.
  for(const source of projection.sources){
   if(source.coverage!=='qualified')continue;
   const key=`case_issue_${sha256Hex(canonicalize({caseId,subscriptionId:source.subscriptionId??source.connectionId,rule:'source_coverage',version:RECONSTRUCTION_RULE_VERSION}))}`;
   const good=['current','quiet_checked'].includes(source.state);
   const inputs=projection.assertions.filter(assertion=>assertion.source.subscriptionId===source.subscriptionId&&assertion.active).map(assertion=>assertion.id).sort();
   const value:Evaluation={outcome:good?'within_tolerance':'different',title:good?'Source interval current':'Source information needs review',explanation:good?'The source has a current qualified boundary. Earlier coverage warnings remain in history.':`${source.label}. ${source.nextAction} This describes unavailable or incomplete source information, not a proven missing warehouse action or lost goods.`,inputAssertionIds:inputs,sourceHealth:source,ruleVersion:RECONSTRUCTION_RULE_VERSION,physicalCondition:'not_established'};
   evaluations.set(key,{category:'source_coverage',subject:{subscriptionId:source.subscriptionId??null,connectionId:source.connectionId,sourceNamespace:source.sourceNamespace},value});
  }
  let recorded=0;
  for(const prior of existing)if(!evaluations.has(prior.id))evaluations.set(prior.id,{category:prior.category,subject:prior.subject,value:{outcome:'not_comparable',title:'Comparison no longer has active qualified inputs',explanation:'A source correction, tombstone, association decision or authorization change removed a required current input. Historical evaluations remain preserved; absence of information does not resolve the physical question.',inputAssertionIds:[]}});
  for(const [id,entry]of [...evaluations].sort(([a],[b])=>a.localeCompare(b))){
   const old=existing.find(issue=>issue.id===id);
   if(!old&&entry.value.outcome!=='different')continue;
   if(!old)await tx.query('INSERT INTO record_case_issues(id,case_id,category,rule_version,subject,created_at) VALUES($1,$2,$3,$4,$5::jsonb,$6) ON CONFLICT DO NOTHING',[id,caseId,entry.category,RECONSTRUCTION_RULE_VERSION,JSON.stringify(entry.subject),clock.now().toISOString()]);
   const evaluationId=`case_eval_${sha256Hex(canonicalize({issueId:id,projectionVersion:projection.projectionVersion}))}`;
   const sequence=Number((await tx.query<{n:number}>('SELECT COALESCE(MAX(sequence),0)+1 AS n FROM record_case_issue_evaluations WHERE issue_id=$1',[id])).rows[0].n);
   const inserted=(await tx.query('INSERT INTO record_case_issue_evaluations(id,issue_id,case_id,projection_version,sequence,outcome,evaluation,created_at) VALUES($1,$2,$3,$4,$5,$6,$7::jsonb,$8) ON CONFLICT(issue_id,projection_version) DO NOTHING RETURNING id',[evaluationId,id,caseId,projection.projectionVersion,sequence,entry.value.outcome,JSON.stringify(entry.value),clock.now().toISOString()])).rows.length>0;
   if(!inserted)continue;
   recorded++;
   const last=await currentAction(tx,id),resolved=['resolve','system_resolve'].includes(last);
   if(entry.value.outcome==='within_tolerance'&&!resolved)await appendAction(tx,clock,caseId,id,'system_resolve','The current qualified source assertions no longer disagree. Earlier findings and their inputs remain in history.',null,null,`${evaluationId}:resolve`);
   else if(entry.value.outcome==='different'&&resolved)await appendAction(tx,clock,caseId,id,'system_reopen','A new qualified input revision reports a disagreement after the prior resolution.',null,null,`${evaluationId}:reopen`);
  }
  await tx.query('INSERT INTO record_case_rule_runs(id,case_id,case_revision,projection_version,created_at) VALUES($1,$2,$3,$4,$5) ON CONFLICT(case_id,projection_version) DO NOTHING',[newId('case_rule_run'),caseId,projection.case.revision,projection.projectionVersion,clock.now().toISOString()]);
  await tx.query('INSERT INTO record_case_rule_state(case_id,case_revision,projection_version,checked_at,next_check_at,error_code) VALUES($1,$2,$3,$4,$5,NULL) ON CONFLICT(case_id) DO UPDATE SET case_revision=EXCLUDED.case_revision,projection_version=EXCLUDED.projection_version,checked_at=EXCLUDED.checked_at,next_check_at=EXCLUDED.next_check_at,error_code=NULL',[caseId,projection.case.revision,projection.projectionVersion,clock.now().toISOString(),new Date(clock.now().getTime()+60000).toISOString()]);
  await requireCaseAccess(tx,clock,w,caseId);
  return {caseId,projectionVersion:projection.projectionVersion,evaluationsRecorded:recorded};
 });
}

/** Bounded outbox-following rule work. Unchanged closed cases are not swept
 * repeatedly. Current source health is rechecked for cases with open findings;
 * a receipt or association revision always makes its case eligible again. */
export async function processPendingReconstructionIssues(db:Database,clock:Clock,limit=5) {
 if(!reconstructionFeatureEnabled('reconstruction')||!reconstructionFeatureEnabled('sourceHealth')||!reconstructionFeatureEnabled('rules'))return {processed:0,blocked:0};
 const n=Math.max(1,Math.min(20,Math.floor(limit))),now=clock.now().toISOString();
 const candidates=(await db.query<{id:string;revision:number;operator_membership_id:string;organization_id:string;environment:'sandbox'|'live'}>(`SELECT c.id,c.revision,c.operator_membership_id,c.organization_id,c.environment
  FROM record_cases c LEFT JOIN record_case_rule_state state ON state.case_id=c.id
  WHERE (state.case_id IS NULL OR state.next_check_at<=$1) AND (state.case_id IS NULL OR state.case_revision<c.revision OR EXISTS(SELECT 1 FROM record_case_issues i WHERE i.case_id=c.id AND COALESCE((SELECT a.action FROM record_case_issue_actions a WHERE a.issue_id=i.id AND a.action NOT IN ('note','assign') ORDER BY sequence DESC LIMIT 1),'reopen') NOT IN ('resolve','system_resolve')))
  ORDER BY COALESCE(state.next_check_at,c.created_at),c.id LIMIT $2`,[now,n])).rows;
 let processed=0,blocked=0;
 for(const candidate of candidates){
  try{
   // Rebuilding accepted history is a system read, not a replay of source input.
   // Current case/operator access is rechecked independently of the historical
   // ingestion token; a failed source is represented by measured health instead
   // of preventing other qualified sources from being interpreted.
   const operator=(await db.query<{user_id:string}>('SELECT user_id FROM platform_memberships WHERE id=$1 AND organization_id=$2 AND revoked_at IS NULL',[candidate.operator_membership_id,candidate.organization_id])).rows[0];
   if(!operator)throw new DomainError('SOURCE_AUTHORIZATION_REQUIRED','The approved case operator is unavailable',403);
   const workspace=await requireRecordWorkspace(db,operator.user_id,candidate.organization_id,candidate.environment);
   await synchronizeOperationalCaseIssues(db,clock,workspace,candidate.id);processed++;}
  catch(error){
   // A failed rule pass never changes or deletes accepted source data. Backoff
   // keeps unavailable case memberships from blocking independently authorized cases.
   const code=error instanceof DomainError?error.code:'RECONSTRUCTION_RULE_RETRY';
   await db.query('INSERT INTO record_case_rule_state(case_id,case_revision,projection_version,checked_at,next_check_at,error_code) VALUES($1,$2,NULL,$3,$4,$5) ON CONFLICT(case_id) DO UPDATE SET checked_at=EXCLUDED.checked_at,next_check_at=EXCLUDED.next_check_at,error_code=EXCLUDED.error_code',[candidate.id,0,now,new Date(clock.now().getTime()+300000).toISOString(),code]);blocked++;
  }
 }
 return {processed,blocked};
}

/** Paginated immutable history; callers cannot make a case-level permission into
 * access to the original shared source batch. */
export async function listOperationalCaseIssues(db:Database,clock:Clock,w:RecordWorkspace,caseId:string,input:Record<string,unknown>={}) {
 await requireCaseAccess(db,clock,w,caseId);
 const limit=input.limit==null?50:Number(input.limit),after=input.after==null?'':typeof input.after==='string'?input.after:'';
 if(!Number.isInteger(limit)||limit<1||limit>100||input.after!=null&&typeof input.after!=='string'||after.length>200)throw new DomainError('INVALID_CASE_ISSUE_PAGE','Use a valid issue page of at most 100 rows',400);
 const total=Number((await db.query<{n:number}>('SELECT COUNT(*)::integer AS n FROM record_case_issues WHERE case_id=$1',[caseId])).rows[0]?.n??0);
 const rows=(await db.query<IssueRow&{evaluation:Evaluation|null;outcome:string|null;evaluated_at:string|Date|null;last_action:string|null;assignee_membership_id:string|null}>(`SELECT i.*,
  (SELECT e.evaluation FROM record_case_issue_evaluations e WHERE e.issue_id=i.id ORDER BY e.sequence DESC LIMIT 1) AS evaluation,
  (SELECT e.outcome FROM record_case_issue_evaluations e WHERE e.issue_id=i.id ORDER BY e.sequence DESC LIMIT 1) AS outcome,
  (SELECT e.created_at FROM record_case_issue_evaluations e WHERE e.issue_id=i.id ORDER BY e.sequence DESC LIMIT 1) AS evaluated_at,
  (SELECT a.action FROM record_case_issue_actions a WHERE a.issue_id=i.id AND a.action NOT IN ('note','assign') ORDER BY a.sequence DESC LIMIT 1) AS last_action,
  (SELECT a.assignee_membership_id FROM record_case_issue_actions a WHERE a.issue_id=i.id AND a.action='assign' ORDER BY a.sequence DESC LIMIT 1) AS assignee_membership_id
  FROM record_case_issues i WHERE i.case_id=$1 AND i.id>$2 ORDER BY i.id LIMIT $3`,[caseId,after,limit+1])).rows;
 const page=rows.slice(0,limit);
 const scoped=await restrictEvaluations(db,caseId,page.map(row=>row.evaluation));
 const issues=page.map((row,index)=>({id:row.id,caseId:row.case_id,category:row.category,ruleVersion:row.rule_version,subject:(scoped[index] as {historyVisibility?:string}|null)?.historyVisibility==='restricted'?{visibility:'restricted'}:row.subject,status:(scoped[index] as {historyVisibility?:string}|null)?.historyVisibility==='restricted'?'suppressed':['resolve','system_resolve'].includes(row.last_action??'')?'resolved':['not_comparable','suppressed'].includes(row.outcome??'')?'suppressed':row.last_action==='acknowledge'?'acknowledged':'open',assigneeMembershipId:row.assignee_membership_id,evaluation:scoped[index],createdAt:iso(row.created_at),evaluatedAt:row.evaluated_at?iso(row.evaluated_at):null}));
 await requireCaseAccess(db,clock,w,caseId);
 return {issues,total,returnedCount:issues.length,hasMore:rows.length>limit,nextAfter:rows.length>limit?page.at(-1)!.id:null,enabled:reconstructionFeatureEnabled('rules')};
}

/** Complete immutable issue history for the versioned case export. Access is
 * rechecked after reads; raw source batches are never included by this helper. */
export async function loadOperationalCaseIssueHistory(db:Database,clock:Clock,w:RecordWorkspace,caseId:string) {
 await requireCaseAccess(db,clock,w,caseId);
 const [issues,evaluations,actions]=(await Promise.all([
  db.query('SELECT id,case_id,category,rule_version,subject,created_at FROM record_case_issues WHERE case_id=$1 ORDER BY id',[caseId]),
  db.query('SELECT id,issue_id,projection_version,sequence,outcome,evaluation,created_at FROM record_case_issue_evaluations WHERE case_id=$1 ORDER BY issue_id,sequence',[caseId]),
  db.query('SELECT id,issue_id,sequence,action,reason,actor_user_id,assignee_membership_id,created_at FROM record_case_issue_actions WHERE case_id=$1 ORDER BY issue_id,sequence',[caseId]),
 ])).map(result=>result.rows);
 const scoped=await restrictEvaluations(db,caseId,evaluations.map(row=>row.evaluation as Evaluation));
 const restrictedIssues=new Set(evaluations.filter((_,index)=>(scoped[index] as {historyVisibility?:string}|null)?.historyVisibility==='restricted').map(row=>row.issue_id));
 await requireCaseAccess(db,clock,w,caseId);
 return {schema:'packproof.case-issue-history/v1',issues:issues.map(row=>restrictedIssues.has(row.id)?{...row,subject:{visibility:'restricted'}}:row),evaluations:evaluations.map((row,index)=>({...row,evaluation:scoped[index]})),actions:actions.map(row=>restrictedIssues.has(row.issue_id)?{...row,reason:'Earlier review action retained. Its source details are restricted after an association correction.',historyVisibility:'restricted'}:row),omissions:restrictedIssues.size?['Some historical source evaluations and review text are restricted by current case association.']:[]};
}

export async function pageOperationalCaseIssueHistory(db:Database,clock:Clock,w:RecordWorkspace,caseId:string,issueId:string,input:Record<string,unknown>={}) {
 await requireCaseAccess(db,clock,w,caseId);
 if(!(await db.query('SELECT 1 FROM record_case_issues WHERE id=$1 AND case_id=$2',[issueId,caseId])).rows[0])throw new DomainError('ISSUE_NOT_FOUND','Case issue not found',404);
 const section=input.section??'evaluations',limit=input.limit==null?50:Number(input.limit),after=input.after==null?0:Number(input.after);
 if(!['evaluations','actions'].includes(String(section))||!Number.isInteger(limit)||limit<1||limit>100||!Number.isSafeInteger(after)||after<0)throw new DomainError('INVALID_CASE_ISSUE_PAGE','Choose an issue history section and page of at most 100 entries',400);
 const table=section==='evaluations'?'record_case_issue_evaluations':'record_case_issue_actions';
 const total=Number((await db.query<{n:number}>(`SELECT COUNT(*)::integer AS n FROM ${table} WHERE issue_id=$1 AND case_id=$2`,[issueId,caseId])).rows[0].n);
 const rows=(await db.query<Record<string,unknown>&{sequence:number}>(`SELECT * FROM ${table} WHERE issue_id=$1 AND case_id=$2 AND sequence>$3 ORDER BY sequence LIMIT $4`,[issueId,caseId,after,limit+1])).rows;
 let entries=rows.slice(0,limit);
 if(section==='evaluations'){const scoped=await restrictEvaluations(db,caseId,entries.map(row=>row.evaluation as Evaluation));entries=entries.map((row,index)=>({...row,evaluation:scoped[index]}));}
 else {const all=(await db.query<{evaluation:Evaluation}>('SELECT evaluation FROM record_case_issue_evaluations WHERE issue_id=$1 AND case_id=$2',[issueId,caseId])).rows,scoped=await restrictEvaluations(db,caseId,all.map(row=>row.evaluation));if(scoped.some(value=>(value as {historyVisibility?:string}|null)?.historyVisibility==='restricted'))entries=entries.map(row=>({...row,reason:'Earlier review action retained. Its source details are restricted after an association correction.',historyVisibility:'restricted'}));}
 await requireCaseAccess(db,clock,w,caseId);
 return {issueId,caseId,section,entries,total,returnedCount:entries.length,hasMore:rows.length>limit,nextAfter:rows.length>limit?Number(entries.at(-1)!.sequence):null};
}

export async function actOnOperationalCaseIssue(db:Database,clock:Clock,w:RecordWorkspace,caseId:string,issueId:string,input:unknown,key:unknown) {
 requireReconstructionFeature('rules');
 if(w.partner)throw new DomainError('HUMAN_APPROVAL_REQUIRED','Case issue review requires a current human workspace session',403);
 const c=await requireCaseAccess(db,clock,w,caseId,true),b=strictBody(input,['action','reason','membershipId']);
 if(!['acknowledge','resolve','reopen','note','assign'].includes(String(b.action)))throw new DomainError('INVALID_ISSUE_ACTION','Choose acknowledge, resolve, reopen, note or assign',400);
 const reason=textField(b.reason,'reason',1000);
 const current=await requireRecordWorkspace(db,w.userId,w.organizationId,w.environment,true);
 if(b.action==='assign'&&!['OWNER','ADMIN'].includes(current.role))throw new DomainError('RECORD_PERMISSION_DENIED','A current administrator assigns case review responsibility',403);
 const result=await idempotent(db,clock,current.tenantId,`case-issue:${current.membershipId}:${caseId}:${issueId}`,key,input,async tx=>{
  await requireCaseAccess(tx,clock,current,c.id,true);
  await tx.query('SELECT pg_advisory_xact_lock(1347438157,hashtext($1))',[caseId]);
  if(!(await tx.query('SELECT id FROM record_case_issues WHERE id=$1 AND case_id=$2',[issueId,caseId])).rows[0])throw new DomainError('ISSUE_NOT_FOUND','Case issue not found',404);
  let assignee:string|null=null;
  if(b.action==='assign'){
   if(!Object.hasOwn(b,'membershipId'))throw new DomainError('INVALID_ISSUE_ASSIGNMENT','Choose a current reviewer or explicitly clear the assignment',400);
   assignee=b.membershipId==null?null:textField(b.membershipId,'membershipId');
   if(assignee){const member=(await tx.query<{user_id:string}>('SELECT user_id FROM platform_memberships WHERE id=$1 AND organization_id=$2 AND revoked_at IS NULL',[assignee,w.organizationId])).rows[0];if(!member)throw new DomainError('ISSUE_REVIEWER_UNAVAILABLE','Choose a current member who can access this case',409);try{const reviewer=await requireRecordWorkspace(tx,member.user_id,w.organizationId,w.environment);await requireCaseAccess(tx,clock,reviewer,caseId);}catch(error){if(error instanceof DomainError)throw new DomainError('ISSUE_REVIEWER_UNAVAILABLE','Choose a current member who can access this case',409);throw error;}}
  }
  const id=await appendAction(tx,clock,caseId,issueId,String(b.action),reason,current.userId,assignee);
  await auditOrganization(tx,clock,{userId:current.userId,merchantId:current.organizationId,requestId:id,operation:`CASE_ISSUE_${String(b.action).toUpperCase()}`,resourceId:issueId});
  return {id,issueId,caseId,action:b.action};
 });
 await requireCaseAccess(db,clock,current,caseId,true);return {...result.value,replayed:result.replayed};
}
