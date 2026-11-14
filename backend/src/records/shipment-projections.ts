import {performance} from 'node:perf_hooks';
import type {Database} from '../db/database.js';
import type {Clock} from '../clock.js';
import {DomainError} from '../domain/errors.js';
import {canonicalize} from '../canonical.js';
import {attachQualifiedShipmentProofs,currentCaseObservationSql,observationCaseCandidatesSql} from './cases.js';
import {caseReceiptAffectsSql} from './case-receipt-dependencies.js';
import {reconstructionFeatureEnabled} from './reconstruction-features.js';
import {authorizeRetainedTypedImport,verifyRetainedTypedOriginal,type TypedBatchRow,type TypedImportDeps} from './typed-imports.js';
import type {TypedSourceBatch} from './source-contracts.js';

const profiles=['packproof.order-lines/v1','packproof.shipment-handling-units/v1'];
const at=(clock:Clock)=>clock.now().toISOString();
interface Work {
 batch_id:string;case_id:string;organization_id:string;environment:string;connection_id:string;
 location_id:string;operator_membership_id:string;witness_observation_id:string;
 work_revision:number|string;state:'pending'|'complete'|'unavailable';cursor_key:string|null;
 case_revision:number|string|null;next_attempt_at:Date|string;error_code:string|null;
 processed_groups:number;linked_groups:number;
}
const disposedSql=`EXISTS(SELECT 1 FROM record_source_disposition_requests request JOIN record_source_disposition_intents intent ON intent.request_id=request.id WHERE request.batch_id=$1) OR EXISTS(SELECT 1 FROM record_source_disposition_requests request JOIN record_source_disposition_results result ON result.request_id=request.id WHERE request.batch_id=$1)`;

/** The caller has current original authority and the receipt/site locks. New
 * derived work never transfers the original receipt's actor or source scope. */
export async function enqueueShipmentProjectionWork(db:Database,clock:Clock,b:TypedBatchRow,rowIds:string[],force=false):Promise<void> {
 if(!reconstructionFeatureEnabled('reconstruction')||!profiles.includes(b.source_profile)||!rowIds.length)return;
 await db.query('SELECT pg_advisory_xact_lock(1347438158,hashtext($1))',[b.id]);
 await db.query('SELECT pg_advisory_xact_lock(1347438153,hashtext($1))',[canonicalize([b.organization_id,b.environment,b.location_id])]);
 const disposed=!!(await db.query<{disposed:boolean}>(`SELECT ${disposedSql} disposed`,[b.id])).rows[0].disposed;
 const state=disposed?'unavailable':'pending',error=disposed?'SHIPMENT_SOURCE_DISPOSITION_STARTED':null,now=at(clock);
 const scope=[b.id,rowIds,b.organization_id,b.environment,b.connection_id,b.location_id,b.operator_membership_id,now,state,error,force];
 const currentPairs=`SELECT c.id case_id,MIN(r.id) witness FROM record_typed_rows r JOIN record_cases c ON c.id IN ${observationCaseCandidatesSql('r')} WHERE r.batch_id=$1 AND r.id=ANY($2::text[]) AND c.organization_id=$3 AND c.environment=$4 AND c.location_id=$6 AND c.operator_membership_id=$7 AND ${currentCaseObservationSql('r','c.id')} GROUP BY c.id`;
 await db.query(`INSERT INTO record_typed_shipment_work(batch_id,case_id,organization_id,environment,connection_id,location_id,operator_membership_id,witness_observation_id,created_at,state,next_attempt_at,error_code,updated_at) SELECT $1,p.case_id,$3,$4,$5,$6,$7,p.witness,$8,$9,$8,$10,$8 FROM (${currentPairs}) p ON CONFLICT(batch_id,case_id) DO UPDATE SET work_revision=record_typed_shipment_work.work_revision+1,state=EXCLUDED.state,cursor_key=NULL,case_revision=NULL,next_attempt_at=EXCLUDED.next_attempt_at,error_code=EXCLUDED.error_code,processed_groups=0,linked_groups=0,updated_at=EXCLUDED.updated_at WHERE $11::boolean OR record_typed_shipment_work.case_revision IS DISTINCT FROM (SELECT revision FROM record_cases WHERE id=EXCLUDED.case_id) OR (EXCLUDED.state='unavailable' AND record_typed_shipment_work.state<>'unavailable')`,scope);
 // A relink may remove the original row from an older case. Reawaken only
 // this same original's existing work; never lock another batch under a site.
 await db.query(`UPDATE record_typed_shipment_work work SET work_revision=work_revision+1,state=$9,cursor_key=NULL,case_revision=NULL,next_attempt_at=$8,error_code=$10,processed_groups=0,linked_groups=0,updated_at=$8 WHERE work.batch_id=$1 AND work.organization_id=$3 AND work.environment=$4 AND work.connection_id=$5 AND work.location_id=$6 AND work.operator_membership_id=$7 AND ($11::boolean OR work.case_revision IS DISTINCT FROM (SELECT revision FROM record_cases WHERE id=work.case_id) OR ($9='unavailable' AND work.state<>'unavailable')) AND work.case_id NOT IN (SELECT p.case_id FROM (${currentPairs}) p) AND work.case_id IN (SELECT d.case_id FROM record_case_association_decisions d WHERE d.observation_id=ANY($2::text[]) UNION SELECT p.case_id FROM record_case_row_projections p WHERE p.observation_id=ANY($2::text[]))`,scope);
}

/** Pending contributors include accepted corrections allocated elsewhere: the
 * existing supersession predicates can still hide this case's older source. */
async function pendingContributors(db:Database,w:Work):Promise<boolean> {
 return !!(await db.query<{pending:boolean}>(`SELECT EXISTS(SELECT 1 FROM record_typed_batches b WHERE EXISTS(SELECT 1 FROM record_typed_rows pending_row WHERE pending_row.batch_id=b.id AND pending_row.status='processing') AND ${caseReceiptAffectsSql('b','$1','$2')}) pending`,[w.case_id,w.connection_id])).rows[0].pending;
}

async function readBatch(db:Database,id:string,lock=false):Promise<TypedBatchRow> {
 const b=(await db.query<TypedBatchRow>(`SELECT * FROM record_typed_batches WHERE id=$1${lock?' FOR UPDATE':''}`,[id])).rows[0];
 if(!b)throw new DomainError('SHIPMENT_PROJECTION_SOURCE_MISSING','The original source receipt is unavailable',409);
 return b;
}
function sameScope(w:Work,b:TypedBatchRow) {
 return w.batch_id===b.id&&w.organization_id===b.organization_id&&w.environment===b.environment&&w.connection_id===b.connection_id&&w.location_id===b.location_id&&w.operator_membership_id===b.operator_membership_id;
}
async function updateWork(db:Database,clock:Clock,w:Work,input:{state:Work['state'];cursor:string|null;revision:number|null;error:string|null;processed?:number;linked?:number;delayMs?:number;resetProgress?:boolean}) {
 const now=clock.now();
 return db.query(`UPDATE record_typed_shipment_work SET work_revision=work_revision+1,state=$4,cursor_key=$5,case_revision=$6,error_code=$7,next_attempt_at=$8,processed_groups=CASE WHEN $12 THEN 0 ELSE processed_groups END+$9,linked_groups=CASE WHEN $12 THEN 0 ELSE linked_groups END+$10,updated_at=$11 WHERE batch_id=$1 AND case_id=$2 AND work_revision=$3 AND state='pending'`,[w.batch_id,w.case_id,w.work_revision,input.state,input.cursor,input.revision,input.error,new Date(now.getTime()+(input.delayMs??0)).toISOString(),input.processed??0,input.linked??0,now.toISOString(),input.resetProgress??false]);
}

/** Every unit is one shipment group in one case. Original I/O stays outside
 * authority locks; every write rechecks current authority and a fenced work
 * revision. No receipt or source collection is paused by this optional work. */
export async function processPendingShipmentProjections(deps:TypedImportDeps,limit=2):Promise<{processed:number;blocked:number}> {
 if(!reconstructionFeatureEnabled('typedIntake')||!reconstructionFeatureEnabled('reconstruction'))return {processed:0,blocked:0};
 const jobs=(await deps.db.query<Work>(`SELECT w.* FROM record_typed_shipment_work w JOIN record_typed_batches b ON b.id=w.batch_id WHERE w.state='pending' AND w.next_attempt_at<=$1 AND b.state IN ('succeeded','partially_succeeded') ORDER BY w.next_attempt_at,w.batch_id,w.case_id LIMIT $2`,[at(deps.clock),Math.max(1,Math.min(limit,10))])).rows;
 let processed=0,blocked=0;
 const originals=new Map<string,TypedSourceBatch>();
 for(const candidate of jobs){
  try {
   const before=await readBatch(deps.db,candidate.batch_id);
   const original=originals.get(before.id)??await verifyRetainedTypedOriginal(deps,before);originals.set(before.id,original);
   await deps.db.transaction(async tx=>{
    const started=performance.now(),check=()=>{if(performance.now()-started>200)throw new DomainError('SHIPMENT_PROJECTION_TIME_BUDGET','This optional shipment projection needs a quieter or smaller case',503);};
    await tx.query("SET LOCAL statement_timeout='200ms'");await tx.query("SET LOCAL lock_timeout='150ms'");
    await authorizeRetainedTypedImport(deps,tx,before.actor_context,before,'replay',original);check();
    await tx.query('SELECT pg_advisory_xact_lock(1347438158,hashtext($1))',[before.id]);
    const b=await readBatch(tx,before.id,true);if(!['succeeded','partially_succeeded'].includes(b.state))return;
    await authorizeRetainedTypedImport(deps,tx,b.actor_context,b,'replay',original);check();
    await tx.query('SELECT pg_advisory_xact_lock(1347438153,hashtext($1))',[canonicalize([b.organization_id,b.environment,b.location_id])]);
    const w=(await tx.query<Work>('SELECT * FROM record_typed_shipment_work WHERE batch_id=$1 AND case_id=$2 FOR UPDATE',[candidate.batch_id,candidate.case_id])).rows[0];
    if(!w||w.state!=='pending'||String(w.work_revision)!==String(candidate.work_revision))return;
    const mutate=async(input:Parameters<typeof updateWork>[3])=>{await updateWork(tx,deps.clock,w,input);check();};
    if(!sameScope(w,b))throw new DomainError('SHIPMENT_PROJECTION_SCOPE_CHANGED','The original projection scope no longer matches',403);
    const witness=(await tx.query<{found:boolean}>(`SELECT EXISTS(SELECT 1 FROM record_typed_rows r WHERE r.batch_id=$1 AND ${currentCaseObservationSql('r','$2')}) found`,[b.id,w.case_id])).rows[0];
    if(!witness.found){await mutate({state:'unavailable',cursor:null,revision:null,error:'SHIPMENT_PROJECTION_ASSOCIATION_CHANGED'});return;}
    if((await tx.query<{disposed:boolean}>(`SELECT ${disposedSql} disposed`,[b.id])).rows[0].disposed){await mutate({state:'unavailable',cursor:null,revision:null,error:'SHIPMENT_SOURCE_DISPOSITION_STARTED'});return;}
    if(await pendingContributors(tx,w)){check();await mutate({state:'pending',cursor:w.cursor_key,revision:w.case_revision===null?null:Number(w.case_revision),error:'SHIPMENT_SOURCE_RECEIPT_PENDING',delayMs:5000});return;}
    check();
    const outcome=await attachQualifiedShipmentProofs(tx,deps.clock,b.actor_context,b.id,{caseId:w.case_id,afterShipmentKey:w.cursor_key,caseRevision:w.case_revision===null?null:Number(w.case_revision),check});
    await authorizeRetainedTypedImport(deps,tx,b.actor_context,b,'replay',original);check();
    await mutate({state:outcome.state==='progress'?'pending':outcome.state,cursor:outcome.cursorKey,revision:outcome.caseRevision,error:outcome.errorCode,processed:outcome.processedGroups,linked:outcome.linkedGroups,resetProgress:outcome.resetProgress});
   });processed++;
  }catch(error){
   const code=error instanceof DomainError?error.code:'SHIPMENT_PROJECTION_RETRY_REQUIRED';
   const sqlCode=(error as {code?:string})?.code;
   const transient=(!(error instanceof DomainError)||error.httpStatus>=500)&&!['TYPED_ORIGINAL_INTEGRITY_FAILED','TYPED_RECEIPT_ACCOUNTING_FAILED'].includes(code);
   // Work revision advances on every change. A stale failure can never undo a
   // newer enqueue, another worker's progress, or a completed unit.
   await updateWork(deps.db,deps.clock,candidate,{state:transient?'pending':'unavailable',cursor:candidate.cursor_key,revision:candidate.case_revision===null?null:Number(candidate.case_revision),error:sqlCode==='57014'||sqlCode==='55P03'?'SHIPMENT_PROJECTION_TIME_BUDGET':code,delayMs:transient?60000:0});blocked++;
  }
 }
 return {processed,blocked};
}
