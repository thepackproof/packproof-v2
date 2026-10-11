import type { Database } from '../db/database.js';
import type { Clock } from '../clock.js';
import type { ProgramObservationConfig } from './observation-router.js';
import { requireProgramDataset } from './observation-export.js';
import { pseudonymizeReference, timestamp } from './contracts.js';
import { ELIGIBLE_PACKING_PROOFS_SQL, ELIGIBLE_FINALIZED_PACKING_PROOFS_SQL } from '../domain/onboarding.js';
import { DomainError } from '../domain/errors.js';

const DAY=86_400_000;
type ClientEvent={merchant_ref:string;attempt_ref:string;event_ref:string;client_started_at:Date|string;client_occurred_at:Date|string|null;recorded_at:Date|string;interaction:string;platform:string|null;entry_source:string|null;app_version:string|null;flow_version:number|null;elapsed_ms:number;active_ms:number;unattended_ms:number;offline_ms:number;error_code:string|null;upload_state:string|null};
type Consent={merchant_ref:string;decision:string;recorded_at:Date|string};
const at=(value:Date|string)=>new Date(value).getTime();
function bounded<T>(rows:T[]){if(rows.length>100_000)throw new DomainError('STUDY_EXPORT_LIMIT','Narrow the observation window; partial denominators are not reported.',413);return rows;}
const quantile=(values:number[],q:number)=>values.length?[...values].sort((a,b)=>a-b)[Math.max(0,Math.ceil(values.length*q)-1)]:null;

/** Read-only operational cohort query. Client claims cannot create server outcomes.
 * Raw account/Proof IDs stay inside this trusted boundary and are not returned. */
export async function firstExperienceReport(db:Database,clock:Clock,config:ProgramObservationConfig|null|undefined,input:{from:string;to:string;asOf:string}) {
  if(!config)return {status:'unavailable' as const,reason:'Optional study collection is disabled. No full-population Create Proof choice timestamp is collected.'};
  for(const value of Object.values(input))timestamp(value,'period');
  if(at(input.from)>=at(input.to)||at(input.asOf)<at(input.from)||at(input.asOf)>clock.now().getTime())throw new DomainError('INVALID_ADMIN_QUERY','Invalid observation window.',400);
  await requireProgramDataset(db,config,config.datasetRef);
  const cutoff=new Date(Math.min(at(input.to),at(input.asOf))).toISOString();
  // Select first intent across this dataset's full history before applying the
  // requested cohort interval; retries/later devices never add another user.
  const starts=bounded((await db.query<ClientEvent>(`SELECT * FROM (
    SELECT DISTINCT ON(merchant_ref) * FROM program_timing_events
    WHERE dataset_ref=$1 AND interaction='start_selected' AND flow_version=1 AND task_kind='packproof' AND recorded_at<=$2 AND client_started_at<$3
    ORDER BY merchant_ref,client_started_at,sequence
  ) first_choice WHERE client_started_at >= $4 LIMIT 100001`,[config.datasetRef,input.asOf,cutoff,input.from])).rows);
  const events=bounded((await db.query<ClientEvent>(`SELECT * FROM program_timing_events WHERE dataset_ref=$1 AND recorded_at<=$2 AND client_started_at >= $3 AND client_started_at<$4 AND interaction IS NOT NULL ORDER BY sequence LIMIT 100001`,[config.datasetRef,input.asOf,input.from,cutoff])).rows);
  const consents=bounded((await db.query<Consent>('SELECT merchant_ref,decision,recorded_at FROM program_consent_events WHERE dataset_ref=$1 AND recorded_at<=$2 ORDER BY sequence LIMIT 100001',[config.datasetRef,input.asOf])).rows);
  const users=bounded((await db.query<{id:string}>(`SELECT u.id FROM users u WHERE u.created_at<=$1
    AND EXISTS(SELECT 1 FROM auth_identities ai WHERE ai.user_id=u.id AND ai.provider<>'dev')
    AND NOT EXISTS(SELECT 1 FROM auth_identities ai WHERE ai.user_id=u.id AND ai.provider='dev')
    AND NOT EXISTS(SELECT 1 FROM user_system_roles r WHERE r.user_id=u.id AND r.role='SYSTEM_ADMIN') LIMIT 100001`,[input.asOf])).rows);
  const ref=(kind:string,id:string)=>pseudonymizeReference(config.key,kind,JSON.stringify([config.datasetRef,id]));
  const identities=new Map(users.map(user=>[ref('merchant',user.id),user.id]));
  const eligibleStarts=starts.filter(event=>identities.has(event.merchant_ref));
  const accountIds=eligibleStarts.map(event=>identities.get(event.merchant_ref)!);
  const history=accountIds.length?bounded((await db.query<{id:string;seller_user_id:string;recorded_at:Date|string|null;finalized_at:Date|string|null}>(`SELECT p.id,p.seller_user_id,p.recorded_at,f.finalized_at FROM (${ELIGIBLE_PACKING_PROOFS_SQL}) p
    LEFT JOIN (${ELIGIBLE_FINALIZED_PACKING_PROOFS_SQL}) f ON f.id=p.id
    WHERE p.seller_user_id=ANY($1::text[]) AND p.created_at<=$2 LIMIT 100001`,[accountIds,input.asOf])).rows):[];
  const consentAt=(merchant:string,time:number)=>consents.filter(row=>row.merchant_ref===merchant&&at(row.recorded_at)<=time).at(-1)?.decision==='grant';
  const authoritativeEvents:Array<{eventName:'evidence_committed'|'proof_finalized';authority:'server';eventRef:string;merchantRef:string;occurredAt:string}>=[];
  for(const row of history){const merchant=ref('merchant',row.seller_user_id);for(const [name,date] of [['evidence_committed',row.recorded_at],['proof_finalized',row.finalized_at]] as const){if(date&&at(date)>=at(input.from)&&at(date)<=at(input.asOf)&&consentAt(merchant,at(date)))authoritativeEvents.push({eventName:name,authority:'server',eventRef:ref(name,row.id),merchantRef:merchant,occurredAt:new Date(date).toISOString()});}}
  let priorActivated=0,withdrawn=0,immature=0,completed=0,saved=0,submitted=0,committed=0,denominator=0;
  const cohortMerchants=new Set<string>();let recoveryAccounts=0,recoveredAccounts=0,interventionAccounts=0;
  const readyMs:number[]=[],recordMs:number[]=[],observedActiveMs:number[]=[],observedOfflineMs:number[]=[];
  const cohorts=new Map<string,{platform:string;entrySource:string;appVersion:string;started:number;mature:number;finalized:number}>();
  for(const start of eligibleStarts){
    const selectedAt=at(start.client_started_at),end=selectedAt+DAY,user=identities.get(start.merchant_ref)!;
    const proofs=history.filter(row=>row.seller_user_id===user);
    if(proofs.some(row=>row.finalized_at&&at(row.finalized_at)<selectedAt)){priorActivated++;continue;}
    cohortMerchants.add(start.merchant_ref);
    const key=JSON.stringify([start.platform??'unknown',start.entry_source??'unknown',start.app_version??'unknown']);
    const cohort=cohorts.get(key)??{platform:start.platform??'unknown',entrySource:start.entry_source??'unknown',appVersion:start.app_version??'unknown',started:0,mature:0,finalized:0};cohort.started++;cohorts.set(key,cohort);
    if(end>at(input.asOf)){immature++;continue;}
    if(!consentAt(start.merchant_ref,selectedAt)||consents.some(row=>row.merchant_ref===start.merchant_ref&&row.decision==='withdraw'&&at(row.recorded_at)>=selectedAt&&at(row.recorded_at)<end)){withdrawn++;continue;}
    denominator++;cohort.mature++;
    const own=events.filter(event=>event.merchant_ref===start.merchant_ref&&event.client_occurred_at&&at(event.client_occurred_at)>=selectedAt&&at(event.client_occurred_at)<=end);
    if(own.some(event=>event.interaction==='capture_saved'))saved++;
    if(own.some(event=>event.interaction==='submission_authorized'))submitted++;
    if(proofs.some(row=>row.recorded_at&&at(row.recorded_at)>=selectedAt&&at(row.recorded_at)<=end))committed++;
    const finalized=proofs.some(row=>row.finalized_at&&at(row.finalized_at)>=selectedAt&&at(row.finalized_at)<=end);
    if(finalized){completed++;cohort.finalized++;}
    if(own.some(event=>event.interaction==='recovery_action'||event.upload_state==='retrying')){recoveryAccounts++;if(finalized)recoveredAccounts++;}
    if(own.some(event=>event.upload_state==='needs_attention'||event.interaction==='auth_failed'))interventionAccounts++;
    // Match timing to the same original attempt, never to unrelated interface help.
    const attempt=own.filter(event=>event.attempt_ref===start.attempt_ref);
    for(const [kind,values]of [['capture_ready',readyMs],['capture_started',recordMs]] as const){const row=attempt.find(event=>event.interaction===kind);if(row?.client_occurred_at)values.push(at(row.client_occurred_at)-selectedAt);}
    const recording=attempt.find(event=>event.interaction==='capture_started');if(recording){observedActiveMs.push(Number(recording.active_ms));observedOfflineMs.push(Number(recording.offline_ms));}
  }
  const cohortEvents=events.filter(event=>cohortMerchants.has(event.merchant_ref));
  return {status:'available' as const,definitionVersion:1,asOf:input.asOf,datasetRef:config.datasetRef,
    observedStarters:starts.length,excludedIneligibleAccounts:starts.length-eligibleStarts.length,previouslyActivatedAccounts:priorActivated,immatureAccounts:immature,withdrawnBeforeFullWindow:withdrawn,
    matureConsentedAccounts:denominator,finalizedAccounts:completed,conversion24hPercent:denominator?Math.round(completed/denominator*1000)/10:null,
    stages:{clientReportedDurableCapture:saved,clientReportedSubmissionAuthorization:submitted,authoritativeEvidenceCommitted:committed,authoritativeProofFinalized:completed},
    timings:{choiceToReadyMs:{samples:readyMs.length,p50:quantile(readyMs,.5),p95:quantile(readyMs,.95)},choiceToRecordingMs:{samples:recordMs.length,p50:quantile(recordMs,.5),p95:quantile(recordMs,.95)},observedForegroundBeforeRecordingMs:{samples:observedActiveMs.length,p50:quantile(observedActiveMs,.5),p95:quantile(observedActiveMs,.95)},observedOfflineBeforeRecordingMs:{samples:observedOfflineMs.length,p50:quantile(observedOfflineMs,.5),p95:quantile(observedOfflineMs,.95)}},
    cohorts:[...cohorts.values()],authoritativeEvents:authoritativeEvents.filter(event=>cohortMerchants.has(event.merchantRef)),
    guardrails:{recoveryAccounts,recoveredAccounts,retrySuccess24hPercent:recoveryAccounts?Math.round(recoveredAccounts/recoveryAccounts*1000)/10:null,interventionAccounts,interventionPercent:denominator?Math.round(interventionAccounts/denominator*1000)/10:null,reportedIntegrityErrors:cohortEvents.filter(event=>event.error_code==='integrity').length,crashes:{status:'unavailable',reason:'A missing terminal event is not evidence of an operating-system crash.'},acknowledgedMediaLoss:{status:'unavailable',reason:'Requires reconciliation of a prior durable local acknowledgement with actual device storage and authoritative server state.'},duplicateRootProofs:{status:'constraint_enforced',definition:'One root Proof per transaction is enforced by proofs_transaction_id_key; semantically duplicated transactions require source review.'},duplicateCharges:{status:'reconciliation_required',definition:'billing_proof_usage permits one usage row per Proof; payment processor charges require existing ledger/provider reconciliation.'}},
    eventCountsPopulation:'Eligible first-choice accounts, including immature and withdrawn cohorts; client events actually received in the selected window.',
    eventCounts:Object.fromEntries([...new Set(cohortEvents.map(row=>row.interaction))].sort().map(name=>[name,cohortEvents.filter(row=>row.interaction===name).length])),
    notes:['This is the explicitly consented study population, not all customers. Never-started accounts remain in the separate seven-day account-activation report.',
      'First intentional packing choice per account and dataset defines entry. No prior eligible packing finalization is allowed. Failures and starts without terminal events remain in the denominator after a full 24-hour window.',
      'Withdrawal before the full 24-hour window is reported separately as censored; outcomes after withdrawal are not collected. Non-development identity and no current system-admin role define account eligibility; governed ordinary-login test accounts still require cohort review.',
      'Client timestamps, platform, build and local-save reports are self-reported. Evidence commitment and finalization come only from eligible canonical backend history. Their event IDs are stable server pseudonyms.',
      'Observed foreground time is not app-controlled overhead: it includes user effort and OS prompts. Closed-process intervals and auth or permission wait are not silently subtracted. Controlled device studies must classify those intervals separately.',
      'Counts are descriptive. No improvement, latency target, or physical device performance pass is inferred.']};
}
