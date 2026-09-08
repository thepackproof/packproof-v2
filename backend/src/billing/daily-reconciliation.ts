import {randomBytes} from 'node:crypto';
import type {Database} from '../db/database.js';
import type {Clock} from '../clock.js';
import {DomainError} from '../domain/errors.js';
import {newId} from '../ids.js';
import {ingestVerifiedBillingEvent,type VerifiedProviderEvent} from './usage-ledger.js';
const DAY=86400000;
export interface AccountingEventSource{
 provider:string;environment:'sandbox'|'live';providerAccount:string;
 listAccountingEventReferences(input:{start:string;end:string;startingAfter?:string}):Promise<{events:Array<{eventReference:string;createdAt:string}>;hasMore:boolean;nextStartingAfter:string|null}>;
 readVerifiedAccountingEvent(eventReference:string):Promise<VerifiedProviderEvent>;
}
type Scan={baseline_at:Date|string;covered_through:Date|string|null;window_start:Date|string|null;window_end:Date|string|null;cursor:string|null;scan_complete:boolean;state:string;lease_until:Date|string|null;next_attempt_at:Date|string;last_error_code:string|null};
const iso=(value:Date|string)=>new Date(value).toISOString();
const safeCode=(error:unknown)=>error instanceof DomainError&&/^[A-Z0-9_]{1,100}$/.test(error.code)?error.code:'BILLING_RECONCILIATION_FAILED';
/** One bounded scheduled tick: one scan page, at most ten accounting reads by
 * default. Database leases/cursors survive process loss. No HTTP visit is needed.
 */
export async function processStripeBillingReconciliation(db:Database,clock:Clock,source:AccountingEventSource,options:{initialStartAt:string;maxEventsPerRun?:number}){
 const baseline=Date.parse(options.initialStartAt),now=clock.now(),max=options.maxEventsPerRun??10;
 if(!Number.isFinite(baseline)||new Date(baseline).toISOString()!==options.initialStartAt||baseline%1000!==0||baseline>now.getTime()||!Number.isInteger(max)||max<1||max>50)throw new DomainError('INVALID_BILLING_RECONCILIATION','An explicit UTC baseline and bounded event count are required',400);
 const key=[source.provider,source.environment,source.providerAccount],token=randomBytes(20).toString('hex'),today=new Date(Date.UTC(now.getUTCFullYear(),now.getUTCMonth(),now.getUTCDate())).toISOString();
 let blockedCode:string|null=null;
 const claim=await db.transaction(async tx=>{
  await tx.query(`INSERT INTO billing_provider_reconciliation(provider,environment,provider_account,baseline_at,next_attempt_at,updated_at) VALUES($1,$2,$3,$4,$5,$5) ON CONFLICT DO NOTHING`,[...key,options.initialStartAt,now.toISOString()]);
  const row=(await tx.query<Scan>('SELECT * FROM billing_provider_reconciliation WHERE provider=$1 AND environment=$2 AND provider_account=$3 FOR UPDATE',key)).rows[0];
  if(iso(row.baseline_at)!==options.initialStartAt)throw new DomainError('BILLING_BASELINE_CONFLICT','Provider reconciliation baseline cannot silently change',409);
  if(row.state==='BLOCKED'){blockedCode=row.last_error_code??'BILLING_RECONCILIATION_BLOCKED';return null;}
  if(row.lease_until&&new Date(row.lease_until)>now||new Date(row.next_attempt_at)>now)return null;
  if(!row.window_end||row.state==='COMPLETE'){
   if(iso(row.covered_through??row.baseline_at)>=today)return null;
   row.window_start=new Date(Math.max(baseline,new Date(row.covered_through??row.baseline_at).getTime()-2*DAY));row.window_end=today;row.cursor=null;row.scan_complete=false;
  }
  if(new Date(row.window_start!).getTime()<now.getTime()-30*DAY){
   blockedCode='STRIPE_EVENT_HISTORY_GAP';
   await tx.query("UPDATE billing_provider_reconciliation SET state='BLOCKED',last_error_code='STRIPE_EVENT_HISTORY_GAP',updated_at=$4 WHERE provider=$1 AND environment=$2 AND provider_account=$3",[...key,now.toISOString()]);
   await tx.query("INSERT INTO billing_reconciliation_audit(id,provider,environment,provider_account,event_type,window_start,window_end,error_code,recorded_at) VALUES($1,$2,$3,$4,'SCAN_BLOCKED',$5,$6,'STRIPE_EVENT_HISTORY_GAP',$7)",[newId('billing_scan'),...key,row.window_start,row.window_end,now.toISOString()]);return null;
  }
  await tx.query("UPDATE billing_provider_reconciliation SET state='RUNNING',window_start=$4,window_end=$5,cursor=$6,scan_complete=$7,lease_token=$8,lease_until=$9,updated_at=$10 WHERE provider=$1 AND environment=$2 AND provider_account=$3",[...key,row.window_start,row.window_end,row.cursor,row.scan_complete,token,new Date(now.getTime()+15*60000).toISOString(),now.toISOString()]);return row;
 });
 if(!claim)return{processed:0,state:blockedCode?'BLOCKED':'IDLE',errorCode:blockedCode,financialReconciliation:'unreconciled'};
 const fenced=async(tx:Database)=>{const row=(await tx.query('SELECT 1 FROM billing_provider_reconciliation WHERE provider=$1 AND environment=$2 AND provider_account=$3 AND lease_token=$4 FOR UPDATE',[...key,token])).rows[0];if(!row)throw new DomainError('BILLING_SCAN_LEASE_LOST','Billing scan lease was superseded',409);};
 let processed=0;
 try{
  if(!claim.scan_complete){
   const page=await source.listAccountingEventReferences({start:iso(claim.window_start!),end:iso(claim.window_end!),startingAfter:claim.cursor??undefined});
   if(page.events.length>100||page.hasMore&&!page.nextStartingAfter||page.nextStartingAfter===claim.cursor&&page.hasMore)throw new DomainError('STRIPE_EVENT_CURSOR_STALLED','Provider scan cursor did not advance',409);
   await db.transaction(async tx=>{await fenced(tx);for(const event of page.events){if(!/^evt_[A-Za-z0-9]{1,180}$/.test(event.eventReference)||event.createdAt<iso(claim.window_start!)||event.createdAt>=iso(claim.window_end!))throw new DomainError('STRIPE_EVENT_CONTEXT_MISMATCH','Scan event is outside its required window',409);
    await tx.query('INSERT INTO billing_reconciliation_events(provider,environment,provider_account,event_reference,provider_created_at,next_attempt_at) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING',[...key,event.eventReference,event.createdAt,clock.now().toISOString()]);}
    await tx.query('UPDATE billing_provider_reconciliation SET cursor=$4,scan_complete=$5 WHERE provider=$1 AND environment=$2 AND provider_account=$3',[...key,page.nextStartingAfter,!page.hasMore]);});claim.scan_complete=!page.hasMore;
  }
  const events=(await db.query<{event_reference:string;attempts:number;provider_created_at:Date|string}>("SELECT event_reference,attempts,provider_created_at FROM billing_reconciliation_events WHERE provider=$1 AND environment=$2 AND provider_account=$3 AND state='PENDING' AND next_attempt_at<=$4 ORDER BY provider_created_at,event_reference LIMIT $5",[...key,clock.now().toISOString(),max])).rows;
  for(const pending of events){
   try{if(new Date(pending.provider_created_at).getTime()<clock.now().getTime()-30*DAY)throw new DomainError('STRIPE_EVENT_HISTORY_GAP','Unreconciled event exceeded provider history',409);
    const event=await source.readVerifiedAccountingEvent(pending.event_reference);if(event.eventReference!==pending.event_reference)throw new DomainError('STRIPE_EVENT_CONTEXT_MISMATCH','Verified event identity differs from queued event',409);
    await ingestVerifiedBillingEvent(db,clock,{provider:source.provider,environment:source.environment,providerAccount:source.providerAccount,verifyAndNormalize:async()=>event},{rawBody:Buffer.alloc(0),signature:null});
    await db.transaction(async tx=>{await fenced(tx);await tx.query("UPDATE billing_reconciliation_events SET state='COMPLETE',completed_at=$5,last_error_code=NULL WHERE provider=$1 AND environment=$2 AND provider_account=$3 AND event_reference=$4",[...key,pending.event_reference,clock.now().toISOString()]);});processed++;
   }catch(error){const code=safeCode(error),ignored=code==='STRIPE_EVENT_NOT_SETTLED',ordering=code==='BILLING_REFUND_RECONCILIATION_REQUIRED';const attempts=pending.attempts+(ordering?0:1),terminal=code==='STRIPE_EVENT_HISTORY_GAP'||attempts>=12;
    await db.transaction(async tx=>{await fenced(tx);await tx.query('UPDATE billing_reconciliation_events SET state=$5,attempts=$6,next_attempt_at=$7,last_error_code=$8 WHERE provider=$1 AND environment=$2 AND provider_account=$3 AND event_reference=$4',[...key,pending.event_reference,ignored?'IGNORED':terminal?'FAILED':'PENDING',attempts,new Date(clock.now().getTime()+(ordering?60000:Math.min(3600000,1000*2**Math.min(attempts,12)))).toISOString(),code]);});
   }
  }
  return await db.transaction(async tx=>{await fenced(tx);const counts=(await tx.query<{pending:string;failed:string}>("SELECT COUNT(*) FILTER(WHERE state='PENDING') AS pending,COUNT(*) FILTER(WHERE state='FAILED') AS failed FROM billing_reconciliation_events WHERE provider=$1 AND environment=$2 AND provider_account=$3",key)).rows[0];
   const state=Number(counts.failed)>0?'BLOCKED':claim.scan_complete&&Number(counts.pending)===0?'COMPLETE':'PENDING';
   await tx.query('UPDATE billing_provider_reconciliation SET state=$4,covered_through=CASE WHEN $4=\'COMPLETE\' THEN window_end ELSE covered_through END,lease_token=NULL,lease_until=NULL,next_attempt_at=$5,last_error_code=$6,updated_at=$7 WHERE provider=$1 AND environment=$2 AND provider_account=$3',[...key,state,new Date(clock.now().getTime()+(state==='COMPLETE'?60000:1000)).toISOString(),state==='BLOCKED'?'BILLING_EVENT_RECONCILIATION_FAILED':null,clock.now().toISOString()]);
   if(state==='COMPLETE'||state==='BLOCKED')await tx.query('INSERT INTO billing_reconciliation_audit(id,provider,environment,provider_account,event_type,window_start,window_end,error_code,recorded_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)',[newId('billing_scan'),...key,state==='COMPLETE'?'SCAN_COMPLETED':'SCAN_BLOCKED',claim.window_start,claim.window_end,state==='BLOCKED'?'BILLING_EVENT_RECONCILIATION_FAILED':null,clock.now().toISOString()]);
   return{processed,state,coveredThrough:state==='COMPLETE'?iso(claim.window_end!):null,financialReconciliation:'unreconciled',historyBeforeBaseline:'not_claimed'};
  });
 }catch(error){const code=safeCode(error);await db.transaction(async tx=>{await fenced(tx);await tx.query("UPDATE billing_provider_reconciliation SET state='PENDING',lease_token=NULL,lease_until=NULL,next_attempt_at=$5,last_error_code=$6,updated_at=$7 WHERE provider=$1 AND environment=$2 AND provider_account=$3 AND lease_token=$4",[...key,token,new Date(clock.now().getTime()+60000).toISOString(),code,clock.now().toISOString()]);});return{processed,state:'PENDING',errorCode:code,financialReconciliation:'unreconciled'};}
}

/** Operational status only; no provider secrets, event bodies or customer details. */
export async function getStripeBillingReconciliationStatus(db:Database,source:Pick<AccountingEventSource,'provider'|'environment'|'providerAccount'>){
 const key=[source.provider,source.environment,source.providerAccount];
 const row=(await db.query<Scan>('SELECT * FROM billing_provider_reconciliation WHERE provider=$1 AND environment=$2 AND provider_account=$3',key)).rows[0];
 if(!row)return{configured:false,state:'NOT_STARTED',financialReconciliation:'unreconciled'};
 const counts=(await db.query<{pending:string;failed:string}>("SELECT COUNT(*) FILTER(WHERE state='PENDING') AS pending,COUNT(*) FILTER(WHERE state='FAILED') AS failed FROM billing_reconciliation_events WHERE provider=$1 AND environment=$2 AND provider_account=$3",key)).rows[0];
 return{configured:true,environment:source.environment,state:row.state,baselineAt:iso(row.baseline_at),coveredThrough:row.covered_through?iso(row.covered_through):null,pendingEvents:Number(counts.pending),failedEvents:Number(counts.failed),errorCode:row.last_error_code,financialReconciliation:'unreconciled',historyBeforeBaseline:'not_claimed'};
}
