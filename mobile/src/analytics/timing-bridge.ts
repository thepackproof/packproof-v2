/** Opt-in seam only: importing this file registers no listeners and sends nothing.
 * The host supplies an account-scoped durable store, account-bound API, cryptographic
 * nonce factory, and current-account predicate. Never include domain IDs or text.
 */
export type StudyConsent={datasetRef:string;granted:boolean;statementVersion:string};
export type TimingErrorCode='network'|'authentication'|'quota'|'storage'|'capability'|'integrity'|'provider'|'cancelled'|'unknown';
export type TimingCheckpoint={phase:'preflight'|'recording'|'upload'|'confirmation'|'finalization'|'ended';outcome:'pending'|'succeeded'|'failed'|'cancelled';elapsedMs:number;activeMs:number;offlineMs:number;unattendedMs:number;errorCode?:TimingErrorCode};
export type TimingStart={datasetRef:string;operationNonce:string;clientStartedAt:string;taskKind:'packproof'|'ordinary_baseline';deviceClass:'s24_ultra'|'a16_5g'|'other_android'|'web'|'unknown';channel:'ebay'|'stripe'|'paypal'|'manual'|'other'|'unknown'};
export type TimingJournal={start:TimingStart;attemptRef?:string;events:Array<TimingCheckpoint&{operationNonce:string}>;lastCheckpoint?:TimingCheckpoint;recordedCount?:number;ended:boolean};
export interface TimingBridgeStore{read():Promise<TimingJournal|null>;write(value:TimingJournal):Promise<void>;remove():Promise<void>;}
export interface TimingBridgeApi{getConsent(datasetRef:string):Promise<StudyConsent>;start(input:TimingStart):Promise<{attemptRef:string}>;append(input:TimingCheckpoint&{datasetRef:string;attemptRef:string;operationNonce:string}):Promise<unknown>;}
function safeCheckpoint(value:TimingCheckpoint):TimingCheckpoint{
  if(!['preflight','recording','upload','confirmation','finalization','ended'].includes(value.phase)||!['pending','succeeded','failed','cancelled'].includes(value.outcome))throw new Error('INVALID_STUDY_TIMING');
  for(const number of [value.elapsedMs,value.activeMs,value.offlineMs,value.unattendedMs])if(!Number.isSafeInteger(number)||number<0||number>86400000)throw new Error('INVALID_STUDY_TIMING');
  if(value.activeMs+value.unattendedMs>value.elapsedMs||value.offlineMs>value.elapsedMs||(value.phase==='ended')===(value.outcome==='pending'))throw new Error('INVALID_STUDY_TIMING');
  if(value.errorCode&&!['network','authentication','quota','storage','capability','integrity','provider','cancelled','unknown'].includes(value.errorCode))throw new Error('INVALID_STUDY_TIMING');
  return {phase:value.phase,outcome:value.outcome,elapsedMs:value.elapsedMs,activeMs:value.activeMs,offlineMs:value.offlineMs,unattendedMs:value.unattendedMs,...(value.errorCode?{errorCode:value.errorCode}:{})};
}
export function createConsentedTimingBridge(options:{store:TimingBridgeStore;api:TimingBridgeApi;current:()=>boolean;newNonce:()=>string;now?:()=>Date}){
  let tail=Promise.resolve();
  const serial=<T>(run:()=>Promise<T>):Promise<T>=>{const next=tail.catch(()=>{}).then(run);tail=next.then(()=>{},()=>{});return next;};
  const active=()=>{if(!options.current())throw new Error('STUDY_ACCOUNT_CHANGED');};
  const allowed=async(datasetRef:string)=>{active();const consent=await options.api.getConsent(datasetRef);active();return consent.granted&&consent.datasetRef===datasetRef&&consent.statementVersion==='capture-timing-study-v1';};
  const flush=()=>serial(async()=>{
    active();const journal=await options.store.read();if(!journal)return;
    // Recheck remote consent before every flush. Withdrawal discards unsent local
    // study data; capture media and the separate completion journal are untouched.
    if(!await allowed(journal.start.datasetRef)){await options.store.remove();return;}
    if(!journal.attemptRef){const start=await options.api.start(journal.start);active();journal.attemptRef=start.attemptRef;await options.store.write(journal);}
    while(journal.events.length){active();const event=journal.events[0];await options.api.append({...safeCheckpoint(event),operationNonce:event.operationNonce,datasetRef:journal.start.datasetRef,attemptRef:journal.attemptRef});active();journal.events.shift();await options.store.write(journal);}
    if(journal.ended)await options.store.remove();
  });
  return {
    start:(input:Omit<TimingStart,'operationNonce'|'clientStartedAt'>,cachedConsent?:StudyConsent)=>serial(async()=>{
      if(!/^pr_[a-f0-9]{32}$/.test(input.datasetRef)||!['packproof','ordinary_baseline'].includes(input.taskKind)||!['s24_ultra','a16_5g','other_android','web','unknown'].includes(input.deviceClass)||!['ebay','stripe','paypal','manual','other','unknown'].includes(input.channel))throw new Error('INVALID_STUDY_START');
      active();
      // An explicit grant cached on this account may retain an offline start.
      // It grants no intake authority: flush always rechecks the live consent,
      // and the server rejects starts outside the current grant interval.
      if(cachedConsent){if(!cachedConsent.granted||cachedConsent.datasetRef!==input.datasetRef||cachedConsent.statementVersion!=='capture-timing-study-v1')return false;}
      else if(!await allowed(input.datasetRef))return false;
      if(await options.store.read())throw new Error('STUDY_TIMING_ALREADY_PENDING');
      const start:TimingStart={datasetRef:input.datasetRef,taskKind:input.taskKind,deviceClass:input.deviceClass,channel:input.channel,operationNonce:options.newNonce(),clientStartedAt:(options.now?.()??new Date()).toISOString()};
      // Persist start before the host performs the measured action. No successful
      // terminal response is required for this task to enter the denominator.
      await options.store.write({start,events:[],ended:false});return true;
    }),
    checkpoint:(checkpoint:TimingCheckpoint)=>serial(async()=>{
      active();const journal=await options.store.read();if(!journal)return;
      if(journal.ended)throw new Error('STUDY_TIMING_ENDED');
      const recordedCount=journal.recordedCount??journal.events.length;
      // Keep a terminal slot even after a long confirmation/background wait.
      // Acknowledged checkpoints still count toward the server's lifetime limit.
      if(recordedCount>=249&&checkpoint.phase!=='ended'){
        journal.lastCheckpoint=safeCheckpoint(checkpoint);await options.store.write(journal);return;
      }
      if(recordedCount>=250)throw new Error('STUDY_TIMING_LIMIT');
      // Copy only schema fields; arbitrary caller metadata must never reach disk.
      const event={...safeCheckpoint(checkpoint),operationNonce:options.newNonce()};
      journal.recordedCount=recordedCount+1;journal.events.push(event);journal.lastCheckpoint=safeCheckpoint(checkpoint);journal.ended=checkpoint.phase==='ended';await options.store.write(journal);
    }),
    flush,
    // Call only for explicit study withdrawal; media/completion work has its own store.
    discardUnsent:()=>serial(async()=>{active();await options.store.remove();}),
  };
}
