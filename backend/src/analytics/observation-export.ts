import { randomBytes } from 'node:crypto';
import type { Database } from '../db/database.js';
import type { Clock } from '../clock.js';
import { DomainError } from '../domain/errors.js';
import { sha256Hex } from '../hash.js';
import { PROGRAM_SCHEMA_VERSION, canonicalJson, enumValue, finiteNumber, pseudonymizeReference, record, reference, timestamp, validateProgramEvent, deduplicateProgramEvents, type ProgramEvent } from './contracts.js';
import { validateProgramInput, type ProgramInput } from './program-metrics.js';

export const STUDY_STATEMENT_VERSION = 'capture-timing-study-v1';
export const STUDY_STATEMENT = 'I agree to contribute capture task timings and operational outcomes from this account to this study dataset. Collection starts only after I agree. No recording content, label text, barcodes, names, email, or access tokens are collected. References are pseudonymous. I can stop future collection by withdrawing; observations already contributed remain in this dataset.';
export interface ProgramAnalyticsRuntime { key: string | Buffer; keyVersion: string; }
const PHASES = ['started','preflight','recording','upload','confirmation','finalization','ended'] as const;
const DEVICES = ['s24_ultra','a16_5g','other_android','web','unknown'] as const;
const CHANNELS = ['ebay','stripe','paypal','manual','other','unknown'] as const;
const ERRORS = ['network','authentication','quota','storage','capability','integrity','provider','cancelled','unknown'] as const;
export const STUDY_INTERACTIONS = ['order_selected','recording_started','recording_stopped','label_read','label_mismatch','review_opened','consent_confirmed','consent_cancelled','consent_failed','upload_pending','server_completed','recovery_started','share_created'] as const;
const LIMIT = 100_000;
type ConsentRow = { event_ref:string; merchant_ref:string; decision:'grant'|'withdraw'; recorded_at:Date|string; sequence:string; facts_sha256:string };
type TimingRow = { event_ref:string; merchant_ref:string; attempt_ref:string; consent_event_ref:string; task_kind:'packproof'|'ordinary_baseline'|'interface_action'; phase:typeof PHASES[number]; outcome:ProgramEvent['outcome']; device_class:ProgramEvent['deviceClass']; channel:ProgramEvent['channel']; error_code:ProgramEvent['errorCode']|null; interaction:typeof STUDY_INTERACTIONS[number]|null; source_build_sha:string|null; client_started_at:Date|string; elapsed_ms:number|string; active_ms:number|string; offline_ms:number|string; unattended_ms:number|string; recorded_at:Date|string; facts_sha256:string; sequence:string };
const iso = (value:Date|string) => new Date(value).toISOString();
function runtime(value:ProgramAnalyticsRuntime) {
  if (!value || Buffer.byteLength(value.key??'')<32 || !/^[a-z0-9][a-z0-9._-]{0,63}$/.test(value.keyVersion))
    throw new DomainError('STUDY_DISABLED','Study collection is not configured.',503);
}
function ref(config:ProgramAnalyticsRuntime, dataset:string, kind:string, id:string) {return pseudonymizeReference(config.key,kind,JSON.stringify([dataset,id]));}
function nonce(value:unknown) {if(typeof value!=='string'||!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(value))throw new Error('INVALID_OPERATION_NONCE');return value;}
function invalid(error:unknown):never {if(error instanceof DomainError)throw error;throw new DomainError('INVALID_STUDY_REQUEST','Use only the documented study fields and bounded timing values.',400);}
async function dataset(db:Database,config:ProgramAnalyticsRuntime,id:unknown,lock=false) {
  runtime(config);reference(id,'datasetRef');
  const found=(await db.query<{key_version:string;key_fingerprint:string;statement_version:string}>('SELECT key_version,key_fingerprint,statement_version FROM program_datasets WHERE dataset_ref=$1'+(lock?' FOR UPDATE':''),[id])).rows[0];
  if(!found||found.key_version!==config.keyVersion||found.key_fingerprint!==sha256Hex(Buffer.from(config.key))||found.statement_version!==STUDY_STATEMENT_VERSION)throw new DomainError('STUDY_UNAVAILABLE','This study dataset is unavailable.',404);
  return id;
}
/** Internal governance action. No dataset is seeded or enabled by normal capture. */
export async function createProgramDataset(db:Database,clock:Clock,config:ProgramAnalyticsRuntime) {
  runtime(config);const datasetRef=`pr_${randomBytes(16).toString('hex')}`;
  await db.query('INSERT INTO program_datasets(dataset_ref,key_version,key_fingerprint,statement_version,created_at) VALUES($1,$2,$3,$4,$5)',[datasetRef,config.keyVersion,sha256Hex(Buffer.from(config.key)),STUDY_STATEMENT_VERSION,clock.now().toISOString()]);
  return {datasetRef,statementVersion:STUDY_STATEMENT_VERSION,statement:STUDY_STATEMENT};
}
async function consentRows(db:Database,datasetRef:string,merchantRef:string) {return (await db.query<ConsentRow>('SELECT * FROM program_consent_events WHERE dataset_ref=$1 AND merchant_ref=$2 ORDER BY sequence',[datasetRef,merchantRef])).rows;}
export async function getProgramConsent(db:Database,config:ProgramAnalyticsRuntime,userId:string,datasetRef:string) {
  try {await dataset(db,config,datasetRef);const rows=await consentRows(db,datasetRef,ref(config,datasetRef,'merchant',userId));const last=rows.at(-1);
    return {datasetRef,granted:last?.decision==='grant',statementVersion:STUDY_STATEMENT_VERSION,statement:STUDY_STATEMENT,changedAt:last?iso(last.recorded_at):null};
  } catch(error){invalid(error);}
}
export async function recordProgramConsent(db:Database,clock:Clock,config:ProgramAnalyticsRuntime,userId:string,input:unknown) {
  try {
    const body=record(input,['datasetRef','operationNonce','decision','statementVersion'],['datasetRef','operationNonce','decision','statementVersion'],'consent');
    nonce(body.operationNonce);enumValue(body.decision,['grant','withdraw'],'decision');if(body.statementVersion!==STUDY_STATEMENT_VERSION)throw new Error('STATEMENT_VERSION');
    const facts=sha256Hex(canonicalJson(body));
    return await db.transaction(async tx=>{
      const datasetRef=await dataset(tx,config,body.datasetRef,true),merchantRef=ref(config,datasetRef,'merchant',userId),eventRef=ref(config,datasetRef,'consent',JSON.stringify([userId,body.operationNonce]));
      const prior=(await tx.query<{facts_sha256:string}>('SELECT facts_sha256 FROM program_consent_events WHERE event_ref=$1',[eventRef])).rows[0];
      if(prior&&prior.facts_sha256!==facts)throw new DomainError('STUDY_OPERATION_CONFLICT','This consent operation already has different facts.',409);
      if(!prior)await tx.query('INSERT INTO program_consent_events(event_ref,dataset_ref,merchant_ref,decision,statement_version,facts_sha256,recorded_at) VALUES($1,$2,$3,$4,$5,$6,$7)',[eventRef,datasetRef,merchantRef,body.decision,STUDY_STATEMENT_VERSION,facts,clock.now().toISOString()]);
      return {eventRef,...await getProgramConsent(tx,config,userId,datasetRef)};
    });
  }catch(error){invalid(error);}
}
async function requireConsent(db:Database,datasetRef:string,merchantRef:string) {
  const rows=await consentRows(db,datasetRef,merchantRef),last=rows.at(-1);
  if(last?.decision!=='grant')throw new DomainError('STUDY_CONSENT_REQUIRED','Study collection requires your explicit consent for this account and dataset.',403);
  return last;
}
async function insertTiming(tx:Database,clock:Clock,body:Record<string,unknown>) {
  await tx.query(`INSERT INTO program_timing_events(event_ref,dataset_ref,merchant_ref,attempt_ref,task_kind,phase,outcome,device_class,channel,error_code,client_started_at,elapsed_ms,active_ms,offline_ms,unattended_ms,facts_sha256,recorded_at,consent_event_ref,interaction,source_build_sha)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20)`,[body.eventRef,body.datasetRef,body.merchantRef,body.attemptRef,body.taskKind,body.phase,body.outcome,body.deviceClass,body.channel,body.errorCode??null,body.clientStartedAt,body.elapsedMs,body.activeMs,body.offlineMs,body.unattendedMs,body.factsSha256,clock.now().toISOString(),body.consentEventRef,body.interaction??null,body.buildSha??null]);
}
export async function startProgramTiming(db:Database,clock:Clock,config:ProgramAnalyticsRuntime,userId:string,input:unknown) {
  try {
    const keys=['datasetRef','operationNonce','clientStartedAt','deviceClass','channel','taskKind'];const body=record(input,[...keys,'buildSha'],keys,'start');
    nonce(body.operationNonce);timestamp(body.clientStartedAt,'clientStartedAt');enumValue(body.deviceClass,DEVICES,'deviceClass');enumValue(body.channel,CHANNELS,'channel');enumValue(body.taskKind,['packproof','ordinary_baseline','interface_action'],'taskKind');
    if(body.buildSha!==undefined&&(typeof body.buildSha!=='string'||!/^[a-f0-9]{40}$/.test(body.buildSha)))throw new Error('INVALID_BUILD_SHA');
    const factsSha256=sha256Hex(canonicalJson(body));
    return await db.transaction(async tx=>{
      const datasetRef=await dataset(tx,config,body.datasetRef,true),merchantRef=ref(config,datasetRef,'merchant',userId);
      const consent=await requireConsent(tx,datasetRef,merchantRef),attemptRef=ref(config,datasetRef,'timing-attempt',JSON.stringify([userId,body.operationNonce])),eventRef=ref(config,datasetRef,'timing-start',attemptRef);
      const prior=(await tx.query<{facts_sha256:string}>('SELECT facts_sha256 FROM program_timing_events WHERE event_ref=$1',[eventRef])).rows[0];
      if(prior&&prior.facts_sha256!==factsSha256)throw new DomainError('STUDY_OPERATION_CONFLICT','This task start already has different facts.',409);
      // No retrospective personal telemetry collection before consent. Client clocks
      // remain untrusted; collection time and task clock are exported separately.
      if(!prior&&(Date.parse(String(body.clientStartedAt))<Date.parse(iso(consent.recorded_at))||Date.parse(String(body.clientStartedAt))>clock.now().getTime()+300_000))throw new Error('START_OUTSIDE_CONSENT');
      if(!prior){const count=(await tx.query<{count:string}>("SELECT COUNT(*) AS count FROM program_timing_events WHERE dataset_ref=$1 AND merchant_ref=$2 AND phase='started' AND recorded_at>=$3",[datasetRef,merchantRef,new Date(clock.now().getTime()-86400000).toISOString()])).rows[0];if(Number(count.count)>=1000)throw new DomainError('STUDY_START_LIMIT','This account has reached its daily study task limit.',429);}
      if(!prior)await insertTiming(tx,clock,{...body,datasetRef,merchantRef,attemptRef,eventRef,factsSha256,consentEventRef:consent.event_ref,phase:'started',outcome:'pending',elapsedMs:0,activeMs:0,offlineMs:0,unattendedMs:0});
      return {attemptRef,eventRef,authority:'client' as const};
    });
  }catch(error){invalid(error);}
}
export async function appendProgramTiming(db:Database,clock:Clock,config:ProgramAnalyticsRuntime,userId:string,input:unknown) {
  try {
    const keys=['datasetRef','attemptRef','operationNonce','phase','outcome','elapsedMs','activeMs','offlineMs','unattendedMs'];const body=record(input,[...keys,'errorCode','interaction'],keys,'timing');
    nonce(body.operationNonce);reference(body.attemptRef,'attemptRef');enumValue(body.phase,PHASES.slice(1),'phase');enumValue(body.outcome,['pending','succeeded','failed','cancelled'],'outcome');
    if(body.phase!=='ended'&&body.outcome!=='pending')throw new Error('TERMINAL_PHASE_REQUIRED');if(body.phase==='ended'&&body.outcome==='pending')throw new Error('TERMINAL_OUTCOME_REQUIRED');
    for(const key of ['elapsedMs','activeMs','offlineMs','unattendedMs']){finiteNumber(body[key],key,0,true);if(Number(body[key])>86400000)throw new Error('TIMING_LIMIT');}
    if(Number(body.activeMs)+Number(body.unattendedMs)>Number(body.elapsedMs)||Number(body.offlineMs)>Number(body.elapsedMs))throw new Error('INVALID_TIMING_SUM');
    if(body.errorCode!==undefined)enumValue(body.errorCode,ERRORS,'errorCode');
    if(body.interaction!==undefined)enumValue(body.interaction,STUDY_INTERACTIONS,'interaction');
    const factsSha256=sha256Hex(canonicalJson(body));
    return await db.transaction(async tx=>{
      const datasetRef=await dataset(tx,config,body.datasetRef,true),merchantRef=ref(config,datasetRef,'merchant',userId);const consent=await requireConsent(tx,datasetRef,merchantRef);
      const history=(await tx.query<TimingRow>('SELECT * FROM program_timing_events WHERE dataset_ref=$1 AND merchant_ref=$2 AND attempt_ref=$3 ORDER BY sequence',[datasetRef,merchantRef,body.attemptRef])).rows;
      const first=history[0];if(!first)throw new DomainError('STUDY_ATTEMPT_NOT_FOUND','Study task not found for this account.',404);
      if(first.consent_event_ref!==consent.event_ref)throw new DomainError('STUDY_CONSENT_INTERVAL_CHANGED','Start a new study task after changing consent; withdrawn intervals cannot be backfilled.',409);
      const eventRef=ref(config,datasetRef,'timing-event',JSON.stringify([userId,body.operationNonce]));
      const prior=(await tx.query<{facts_sha256:string}>('SELECT facts_sha256 FROM program_timing_events WHERE event_ref=$1',[eventRef])).rows[0];
      if(prior){if(prior.facts_sha256!==factsSha256)throw new DomainError('STUDY_OPERATION_CONFLICT','This timing operation already has different facts.',409);return {eventRef,attemptRef:body.attemptRef,authority:'client' as const};}
      if(history.some(row=>row.phase==='ended'))throw new DomainError('STUDY_ATTEMPT_ENDED','The original task outcome is already recorded.',409);
      if(history.length>=250)throw new DomainError('STUDY_EVENT_LIMIT','This task has reached its timing event limit.',429);
      const last=history.at(-1)!;for(const [column,key]of [['elapsed_ms','elapsedMs'],['active_ms','activeMs'],['offline_ms','offlineMs'],['unattended_ms','unattendedMs']] as const)if(Number(body[key])<Number(last[column]))throw new Error('TIMING_REGRESSION');
      await insertTiming(tx,clock,{...body,datasetRef,merchantRef,eventRef,factsSha256,consentEventRef:first.consent_event_ref,taskKind:first.task_kind,deviceClass:first.device_class,channel:first.channel,buildSha:first.source_build_sha??undefined,clientStartedAt:iso(first.client_started_at)});
      return {eventRef,attemptRef:body.attemptRef,authority:'client' as const};
    });
  }catch(error){invalid(error);}
}

function canonicalReceiptAt(row:{receipt_state:string|null;receipt_json:unknown;event_sha256:string|null},operationId:string):string|null {
  if(row.receipt_state!=='DURABLE'||!row.receipt_json||typeof row.receipt_json!=='object')return null;
  const receipt=row.receipt_json as Record<string,unknown>;
  if(receipt.version!==1||receipt.operationId!==operationId||receipt.eventSha256!==row.event_sha256||typeof receipt.envelopeSha256!=='string'||!/^[a-f0-9]{64}$/.test(receipt.envelopeSha256)||!receipt.signature)return null;
  try{timestamp(receipt.preservedAt,'receipt.preservedAt');return receipt.preservedAt;}catch{return null;}
}
function bounded<T>(rows:T[]) {if(rows.length>LIMIT)throw new DomainError('STUDY_EXPORT_LIMIT','Narrow the export period; partial denominators are not exported.',413);return rows;}
/** Internal export only. An HTTP caller's authority field is never a source.
 * Raw operational identifiers exist only while reading canonical source rows;
 * every exported reference is generated here, scoped to this governed dataset.
 */
export async function exportProgramObservations(db:Database,clock:Clock,config:ProgramAnalyticsRuntime,input:unknown) {
  try {
    const keys=['datasetRef','start','end','asOf'];const body=record(input,keys,keys,'export');for(const key of ['start','end','asOf'])timestamp(body[key],key);
    if(String(body.start)>=String(body.end)||String(body.asOf)<String(body.start)||Date.parse(String(body.asOf))>clock.now().getTime())throw new Error('INVALID_PERIOD');
    const datasetRef=await dataset(db,config,body.datasetRef),start=String(body.start),end=String(body.end),asOf=String(body.asOf),cutoff=end<asOf?end:asOf;
    const consent=bounded((await db.query<ConsentRow>('SELECT * FROM program_consent_events WHERE dataset_ref=$1 AND recorded_at<=$2 ORDER BY sequence LIMIT 100001',[datasetRef,asOf])).rows);
    const merchantRef=(id:string)=>ref(config,datasetRef,'merchant',id);
    const consented=(merchant:string,at:string)=>consent.filter(row=>row.merchant_ref===merchant&&iso(row.recorded_at)<=at).at(-1)?.decision==='grant';
    const timings=bounded((await db.query<TimingRow>('SELECT * FROM program_timing_events WHERE dataset_ref=$1 AND recorded_at<=$2 AND client_started_at>=$3 AND client_started_at<$4 ORDER BY sequence LIMIT 100001',[datasetRef,asOf,start,cutoff])).rows);
    const timingGroups=new Map<string,TimingRow[]>();for(const row of timings){const list=timingGroups.get(row.attempt_ref)??[];list.push(row);timingGroups.set(row.attempt_ref,list);}
    const merchants=[...new Set(consent.filter(row=>row.decision==='grant').map(row=>row.merchant_ref))].map(id=>({merchantRef:id,qualified:false,enrolledAt:null,firstUseTestAt:null,firstUsableAt:null,assistedFirstProof:null,droppedOutAt:null,paidDecisionAt:null,firstPaidAt:null,secondPeriodStart:null,secondPeriodEnd:null,secondPaidAt:null}));
    type Upload={id:string;actor:string;created_at:Date|string;committed_at:Date|string|null;capture_session_id:string|null;validation_status:string;receipt_json:unknown;delivered_at:Date|string|null;receipt_state:string|null;event_sha256:string|null;stage:boolean};
    const uploads=bounded((await db.query<Upload>(`SELECT e.id,e.submitted_by AS actor,e.created_at,e.committed_at,e.capture_session_id,e.validation_status,d.receipt_json,d.delivered_at,d.state AS receipt_state,r.sha256 AS event_sha256,false AS stage FROM evidence e LEFT JOIN recovery_delivery d ON d.operation_id='evidence:'||e.id LEFT JOIN recovery_events r ON r.operation_id=d.operation_id WHERE e.created_at>=$1 AND e.created_at<$2
      UNION ALL SELECT e.id,s.actor_user_id AS actor,e.created_at,e.committed_at,e.capture_session_id,CASE WHEN e.committed_at IS NULL THEN 'PENDING' ELSE 'COMMITTED' END AS validation_status,d.receipt_json,d.delivered_at,d.state AS receipt_state,r.sha256 AS event_sha256,true AS stage FROM commerce_stage_evidence e JOIN commerce_stages s ON s.id=e.stage_id LEFT JOIN recovery_delivery d ON d.operation_id='stage-evidence:'||e.id LEFT JOIN recovery_events r ON r.operation_id=d.operation_id WHERE e.created_at>=$1 AND e.created_at<$2 LIMIT 100001`,[start,cutoff])).rows)
      .filter(row=>consented(merchantRef(row.actor),iso(row.created_at)));
    type Capture={id:string;actor_user_id:string;created_at:Date|string;state:string;client:string};
    const captures=bounded((await db.query<Capture>('SELECT id,actor_user_id,created_at,state,client FROM capture_sessions WHERE created_at>=$1 AND created_at<$2 ORDER BY created_at,id LIMIT 100001',[start,cutoff])).rows).filter(row=>consented(merchantRef(row.actor_user_id),iso(row.created_at)));
    const events:ProgramEvent[]=[];
    const event=(name:ProgramEvent['eventName'],id:string,merchant:string,subject:string,attempt:string,at:string,outcome:ProgramEvent['outcome'],authority:ProgramEvent['authority']='server',deviceClass:ProgramEvent['deviceClass']='unknown',channel:ProgramEvent['channel']='unknown',errorCode?:ProgramEvent['errorCode'])=>{
      if(at>asOf)return;events.push(validateProgramEvent({schemaVersion:PROGRAM_SCHEMA_VERSION,eventRef:ref(config,datasetRef,'event',`${name}:${id}`),tenantRef:ref(config,datasetRef,'account-scope',merchant),merchantRef:merchant,subjectRef:subject,logicalAttemptRef:attempt,eventName:name,occurredAt:at,authority,deviceClass,channel,outcome,...(errorCode?{errorCode}:{})}));
    };
    const uploadIntents=uploads.map(row=>{
      const merchant=merchantRef(row.actor),attempt=ref(config,datasetRef,'upload-attempt',row.id),capture=ref(config,datasetRef,'capture',row.capture_session_id??`attachment:${row.id}`),subject=ref(config,datasetRef,'evidence',row.id);
      const committed=row.committed_at&&iso(row.committed_at)<=asOf&&consented(merchant,iso(row.committed_at))?iso(row.committed_at):null;
      const receiptAt=canonicalReceiptAt(row,`${row.stage?'stage-evidence':'evidence'}:${row.id}`);
      const durable=committed&&receiptAt&&receiptAt>=committed&&receiptAt<=asOf&&consented(merchant,receiptAt)?receiptAt:null;
      event('upload.intent',row.id,merchant,subject,attempt,iso(row.created_at),'pending');
      if(committed)event('evidence.committed_pending_durability',row.id,merchant,subject,attempt,committed,'succeeded');
      if(durable)event('preservation.completed',row.id,merchant,subject,attempt,durable,'succeeded');
      return {logicalAttemptRef:attempt,captureRef:capture,merchantRef:merchant,startedAt:iso(row.created_at),eligibility:row.capture_session_id?'eligible' as const:'unsupported_workflow' as const,committedAt:committed,durableReceiptAt:durable,cancelledAt:null,offlineMs:null,outcome:durable?'completed' as const:row.validation_status==='REJECTED'?'unknown' as const:'pending' as const};
    });
    const finalized=bounded((await db.query<{id:string;actor:string;receipt_state:string;receipt_json:unknown;event_sha256:string}>(`SELECT p.id,pp.user_id AS actor,d.state AS receipt_state,d.receipt_json,r.sha256 AS event_sha256 FROM proofs p JOIN proof_participants pp ON pp.proof_id=p.id AND pp.role='SELLER' JOIN recovery_delivery d ON d.operation_id='finalize:'||p.id JOIN recovery_events r ON r.operation_id=d.operation_id WHERE p.status='FINALIZED' AND p.finalized_at<=$1 AND d.state='DURABLE' AND d.receipt_json IS NOT NULL LIMIT 100001`,[asOf])).rows);
    for(const row of finalized){const merchant=merchantRef(row.actor),preservedAt=canonicalReceiptAt(row,`finalize:${row.id}`);if(preservedAt&&preservedAt>=start&&preservedAt<cutoff&&consented(merchant,preservedAt)){const subject=ref(config,datasetRef,'proof',row.id);event('proof.finalized',row.id,merchant,subject,subject,preservedAt,'succeeded');}}
    const approved=bounded((await db.query<{id:string;actor:string;approved_at:Date|string}>(`SELECT j.id,a.actor_user_id AS actor,a.approved_at FROM recipient_export_approvals a JOIN recipient_export_jobs j ON j.id=a.job_id WHERE a.approved_at>=$1 AND a.approved_at<$2 LIMIT 100001`,[start,cutoff])).rows);
    for(const row of approved){const merchant=merchantRef(row.actor);if(consented(merchant,iso(row.approved_at))){const subject=ref(config,datasetRef,'export',row.id);event('export.approved',row.id,merchant,subject,subject,iso(row.approved_at),'succeeded');}}
    const timingObservations=timings.map(row=>{
      event('capture.interaction',row.event_ref,row.merchant_ref,row.attempt_ref,row.attempt_ref,iso(row.recorded_at),row.outcome,'client',row.device_class,row.channel,row.error_code??undefined);
      return {eventRef:row.event_ref,merchantRef:row.merchant_ref,attemptRef:row.attempt_ref,taskKind:row.task_kind,phase:row.phase,outcome:row.outcome,authority:'client' as const,clientStartedAt:iso(row.client_started_at),recordedAt:iso(row.recorded_at),elapsedMs:Number(row.elapsed_ms),activeMs:Number(row.active_ms),offlineMs:Number(row.offline_ms),unattendedMs:Number(row.unattended_ms),deviceClass:row.device_class,channel:row.channel,errorCode:row.error_code,...(row.interaction!==null?{interaction:row.interaction}:{}),...(row.source_build_sha!==null?{buildSha:row.source_build_sha}:{})};
    });
    const captureTimingGroups=[...timingGroups.values()].filter(rows=>rows[0].task_kind!=='interface_action');
    const effortTasks=captureTimingGroups.map(rows=>{const first=rows[0],last=rows.at(-1)!,ended=last.phase==='ended';return {taskRef:first.attempt_ref,merchantRef:first.merchant_ref,startedAt:iso(first.client_started_at),completed:ended&&last.outcome==='succeeded',ordinaryActiveSeconds:ended&&first.task_kind==='ordinary_baseline'?Number(last.active_ms)/1000:null,packproofActiveSeconds:ended&&first.task_kind==='packproof'?Number(last.active_ms)/1000:null,unattendedSeconds:ended?Number(last.unattended_ms)/1000:null};});
    const observations:ProgramInput=validateProgramInput({schemaVersion:PROGRAM_SCHEMA_VERSION,evidenceClass:'observed',period:{start,end,asOf},costPeriod:{start,end},billingReconciliation:{status:'unreconciled',sourceRef:null,unexplainedDifferenceMinor:null},currency:'USD',merchants,orders:[],uploadIntents,reviewerTasks:[],effortTasks,support:[],costs:[],payments:[]});
    return {datasetRef,keyVersion:config.keyVersion,observations,events:deduplicateProgramEvents(events),timingObservations,
      captureAttempts:captures.map(row=>({captureRef:ref(config,datasetRef,'capture',row.id),merchantRef:merchantRef(row.actor_user_id),startedAt:iso(row.created_at),state:'started' as const,deviceClass:row.client==='WEB_CAMERA'?'web':'unknown'})),
      coverage:{canonicalUploadAttempts:uploads.length,canonicalCaptureStarts:captures.length,clientTaskStarts:captureTimingGroups.length,clientInterfaceActionStarts:timingGroups.size-captureTimingGroups.length,clientTasksWithoutTerminalEvent:captureTimingGroups.filter(rows=>rows.at(-1)?.phase!=='ended').length,partial:true,
        warnings:['Only explicitly consented account/dataset time windows are included; this is not the total customer population.','Capture starts and initialized uploads are separate denominators; unfinished, failed, and cancelled starts are retained.','Client task clocks, outcomes, device classes, interactions, and source build identifiers are self-reported; server_completed describes the client observation and cannot assert preservation or server finalization.','Canonical finalized status does not establish usable quality. Eligibility review, orders, qualification, reviewer tasks, assistance, costs, payment reconciliation and paid cohorts require governed sources.','Effort tasks are unpaired observations; baseline and PackProof task pairing requires governed source review.','No raw media, text, barcodes, emails, access tokens, object keys, or domain identifiers are exported.']}};
  }catch(error){invalid(error);}
}
