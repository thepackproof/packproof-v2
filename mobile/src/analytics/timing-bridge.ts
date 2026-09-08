/** Opt-in seam only: importing this file registers no listeners and sends nothing.
 * The host supplies an account-scoped durable store, account-bound API, cryptographic
 * nonce factory, and current-account predicate. Never include domain IDs or text.
 */
export type StudyConsent={datasetRef:string;granted:boolean;statementVersion:string};
export type TimingErrorCode='network'|'authentication'|'quota'|'storage'|'capability'|'integrity'|'provider'|'cancelled'|'unknown';
export const TIMING_INTERACTIONS=['order_selected','recording_started','recording_stopped','label_read','label_mismatch','review_opened','consent_confirmed','consent_cancelled','consent_failed','upload_pending','server_completed','recovery_started','share_created'] as const;
export type TimingInteraction=typeof TIMING_INTERACTIONS[number];
export type TimingCheckpoint={phase:'preflight'|'recording'|'upload'|'confirmation'|'finalization'|'ended';outcome:'pending'|'succeeded'|'failed'|'cancelled';elapsedMs:number;activeMs:number;offlineMs:number;unattendedMs:number;errorCode?:TimingErrorCode;interaction?:TimingInteraction};
export type TimingStart={datasetRef:string;operationNonce:string;clientStartedAt:string;taskKind:'packproof'|'ordinary_baseline'|'interface_action';deviceClass:'s24_ultra'|'a16_5g'|'other_android'|'web'|'unknown';channel:'ebay'|'stripe'|'paypal'|'manual'|'other'|'unknown';buildSha?:string};
export type TimingJournal={start:TimingStart;attemptRef?:string;events:Array<TimingCheckpoint&{operationNonce:string}>;lastCheckpoint?:TimingCheckpoint;recordedCount?:number;ended:boolean};
export interface TimingBridgeStore{read():Promise<TimingJournal|null>;write(value:TimingJournal):Promise<void>;remove():Promise<void>;}
export interface TimingBridgeApi{getConsent(datasetRef:string):Promise<StudyConsent>;start(input:TimingStart):Promise<{attemptRef:string}>;append(input:TimingCheckpoint&{datasetRef:string;attemptRef:string;operationNonce:string}):Promise<unknown>;}
function safeCheckpoint(value:TimingCheckpoint):TimingCheckpoint{
  if(!['preflight','recording','upload','confirmation','finalization','ended'].includes(value.phase)||!['pending','succeeded','failed','cancelled'].includes(value.outcome))throw new Error('INVALID_STUDY_TIMING');
  for(const number of [value.elapsedMs,value.activeMs,value.offlineMs,value.unattendedMs])if(!Number.isSafeInteger(number)||number<0||number>86400000)throw new Error('INVALID_STUDY_TIMING');
  if(value.activeMs+value.unattendedMs>value.elapsedMs||value.offlineMs>value.elapsedMs||(value.phase==='ended')===(value.outcome==='pending'))throw new Error('INVALID_STUDY_TIMING');
  if(value.errorCode!==undefined&&!['network','authentication','quota','storage','capability','integrity','provider','cancelled','unknown'].includes(value.errorCode))throw new Error('INVALID_STUDY_TIMING');
  if(value.interaction!==undefined&&!TIMING_INTERACTIONS.includes(value.interaction))throw new Error('INVALID_STUDY_TIMING');
  return {phase:value.phase,outcome:value.outcome,elapsedMs:value.elapsedMs,activeMs:value.activeMs,offlineMs:value.offlineMs,unattendedMs:value.unattendedMs,...(value.errorCode?{errorCode:value.errorCode}:{}),...(value.interaction!==undefined?{interaction:value.interaction}:{})};
}
function safeStartInput(input:Omit<TimingStart,'operationNonce'|'clientStartedAt'>){
  if(!/^pr_[a-f0-9]{32}$/.test(input.datasetRef)||!['packproof','ordinary_baseline','interface_action'].includes(input.taskKind)||!['s24_ultra','a16_5g','other_android','web','unknown'].includes(input.deviceClass)||!['ebay','stripe','paypal','manual','other','unknown'].includes(input.channel)||(input.buildSha!==undefined&&(typeof input.buildSha!=='string'||!/^[a-f0-9]{40}$/.test(input.buildSha))))throw new Error('INVALID_STUDY_START');
  return {datasetRef:input.datasetRef,taskKind:input.taskKind,deviceClass:input.deviceClass,channel:input.channel,...(input.buildSha!==undefined?{buildSha:input.buildSha}:{})};
}
function safeNonce(value:string){if(typeof value!=='string'||!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(value))throw new Error('INVALID_STUDY_NONCE');return value;}
function safeJournal(value:TimingJournal):TimingJournal{
  const input=safeStartInput(value.start),clientStartedAt=value.start.clientStartedAt;
  if(typeof clientStartedAt!=='string'||!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(clientStartedAt)||!Number.isFinite(Date.parse(clientStartedAt))||new Date(clientStartedAt).toISOString()!==clientStartedAt||typeof value.ended!=='boolean'||!Array.isArray(value.events)||value.events.length>250)throw new Error('INVALID_STUDY_JOURNAL');
  if(value.attemptRef!==undefined&&!/^pr_[a-f0-9]{32}$/.test(value.attemptRef))throw new Error('INVALID_STUDY_JOURNAL');
  if(value.recordedCount!==undefined&&(!Number.isSafeInteger(value.recordedCount)||value.recordedCount<value.events.length||value.recordedCount>250))throw new Error('INVALID_STUDY_JOURNAL');
  return {start:{...input,operationNonce:safeNonce(value.start.operationNonce),clientStartedAt},...(value.attemptRef!==undefined?{attemptRef:value.attemptRef}:{}),events:value.events.map(event=>({...safeCheckpoint(event),operationNonce:safeNonce(event.operationNonce)})),...(value.lastCheckpoint?{lastCheckpoint:safeCheckpoint(value.lastCheckpoint)}:{}),...(value.recordedCount!==undefined?{recordedCount:value.recordedCount}:{}),ended:value.ended};
}
export function createConsentedTimingBridge(options:{store:TimingBridgeStore;api:TimingBridgeApi;current:()=>boolean;newNonce:()=>string;now?:()=>Date}){
  let tail=Promise.resolve();
  const serial=<T>(run:()=>Promise<T>):Promise<T>=>{const next=tail.catch(()=>{}).then(run);tail=next.then(()=>{},()=>{});return next;};
  const active=()=>{if(!options.current())throw new Error('STUDY_ACCOUNT_CHANGED');};
  const allowed=async(datasetRef:string)=>{active();const consent=await options.api.getConsent(datasetRef);active();return consent.granted&&consent.datasetRef===datasetRef&&consent.statementVersion==='capture-timing-study-v1';};
  const flush=()=>serial(async()=>{
    active();const stored=await options.store.read();if(!stored)return;const journal=safeJournal(stored);
    // Recheck remote consent before every flush. Withdrawal discards unsent local
    // study data; capture media and the separate completion journal are untouched.
    if(!await allowed(journal.start.datasetRef)){await options.store.remove();return;}
    if(!journal.attemptRef){const start=await options.api.start(journal.start);active();journal.attemptRef=start.attemptRef;await options.store.write(journal);}
    while(journal.events.length){active();const event=journal.events[0];await options.api.append({...safeCheckpoint(event),operationNonce:event.operationNonce,datasetRef:journal.start.datasetRef,attemptRef:journal.attemptRef});active();journal.events.shift();await options.store.write(journal);}
    if(journal.ended)await options.store.remove();
  });
  return {
    start:(input:Omit<TimingStart,'operationNonce'|'clientStartedAt'>,cachedConsent?:StudyConsent)=>serial(async()=>{
      const safeInput=safeStartInput(input);
      active();
      // An explicit grant cached on this account may retain an offline start.
      // It grants no intake authority: flush always rechecks the live consent,
      // and the server rejects starts outside the current grant interval.
      if(cachedConsent){if(!cachedConsent.granted||cachedConsent.datasetRef!==input.datasetRef||cachedConsent.statementVersion!=='capture-timing-study-v1')return false;}
      else if(!await allowed(input.datasetRef))return false;
      if(await options.store.read())throw new Error('STUDY_TIMING_ALREADY_PENDING');
      const start:TimingStart={...safeInput,operationNonce:safeNonce(options.newNonce()),clientStartedAt:(options.now?.()??new Date()).toISOString()};
      // Persist start before the host performs the measured action. No successful
      // terminal response is required for this task to enter the denominator.
      await options.store.write({start,events:[],ended:false});return true;
    }),
    checkpoint:(checkpoint:TimingCheckpoint)=>serial(async()=>{
      active();const stored=await options.store.read();if(!stored)return;const journal=safeJournal(stored);
      if(journal.ended)throw new Error('STUDY_TIMING_ENDED');
      const recordedCount=journal.recordedCount??journal.events.length;
      // Keep a terminal slot even after a long confirmation/background wait.
      // Acknowledged checkpoints and the started row count toward the server's
      // 250-row lifetime limit: 248 progress events plus one terminal event.
      if(recordedCount>=248&&checkpoint.phase!=='ended'){
        journal.lastCheckpoint=safeCheckpoint(checkpoint);await options.store.write(journal);return;
      }
      if(recordedCount>=249)throw new Error('STUDY_TIMING_LIMIT');
      // Copy only schema fields; arbitrary caller metadata must never reach disk.
      const event={...safeCheckpoint(checkpoint),operationNonce:safeNonce(options.newNonce())};
      journal.recordedCount=recordedCount+1;journal.events.push(event);journal.lastCheckpoint=safeCheckpoint(checkpoint);journal.ended=checkpoint.phase==='ended';await options.store.write(journal);
    }),
    flush,
    // Call only for explicit study withdrawal; media/completion work has its own store.
    discardUnsent:()=>serial(async()=>{active();await options.store.remove();}),
  };
}
