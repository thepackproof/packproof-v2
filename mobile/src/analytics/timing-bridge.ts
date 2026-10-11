/** Opt-in seam only: importing this file registers no listeners and sends nothing.
 * The host supplies an account-scoped durable store, account-bound API, cryptographic
 * nonce factory, and current-account predicate. Never include domain IDs or text.
 */
export type StudyConsent={datasetRef:string;granted:boolean;statementVersion:string};
export type TimingErrorCode='network'|'authentication'|'quota'|'storage'|'capability'|'integrity'|'provider'|'cancelled'|'unknown';
export const TIMING_INTERACTIONS=['order_selected','recording_started','recording_stopped','label_read','label_mismatch','review_opened','consent_confirmed','consent_cancelled','consent_failed','upload_pending','server_completed','recovery_started','share_created','entry_viewed','start_selected','auth_started','auth_completed','auth_failed','capture_ready','capture_started','capture_saved','capture_interrupted','submission_authorized','upload_state_changed','help_opened','hint_dismissed','recovery_action'] as const;
export type TimingInteraction=typeof TIMING_INTERACTIONS[number];
export const ENTRY_SOURCES=['home','manual','order','deep_link','recovery','sample','help','auth','unknown'] as const;
export type EntrySource=typeof ENTRY_SOURCES[number];
export type TimingContext={flowVersion?:1;appVersion?:string;platform?:'android'|'ios'|'web'|'desktop';entrySource?:EntrySource};
export type TimingCheckpoint={phase:'preflight'|'recording'|'upload'|'confirmation'|'finalization'|'ended';outcome:'pending'|'succeeded'|'failed'|'cancelled';elapsedMs:number;activeMs:number;offlineMs:number;unattendedMs:number;errorCode?:TimingErrorCode;interaction?:TimingInteraction;clientOccurredAt?:string;networkState?:'online'|'offline'|'unknown';uploadState?:'queued'|'uploading'|'waiting'|'retrying'|'committing'|'finalizing'|'complete'|'needs_attention'};
export type TimingStart=TimingContext&{datasetRef:string;operationNonce:string;clientStartedAt:string;taskKind:'packproof'|'ordinary_baseline'|'interface_action';deviceClass:'s24_ultra'|'a16_5g'|'other_android'|'ios'|'web'|'unknown';channel:'ebay'|'stripe'|'paypal'|'manual'|'other'|'unknown';buildSha?:string};
export type TimingJournal={start:TimingStart;attemptRef?:string;events:Array<TimingCheckpoint&{operationNonce:string}>;lastCheckpoint?:TimingCheckpoint;recordedCount?:number;once?:string[];ended:boolean};
export interface TimingBridgeStore{read():Promise<TimingJournal|null>;write(value:TimingJournal):Promise<void>;remove():Promise<void>;}
export interface TimingBridgeApi{getConsent(datasetRef:string):Promise<StudyConsent>;start(input:TimingStart):Promise<{attemptRef:string}>;append(input:TimingCheckpoint&{datasetRef:string;attemptRef:string;operationNonce:string}):Promise<unknown>;}
function safeCheckpoint(value:TimingCheckpoint):TimingCheckpoint{
  if(!['preflight','recording','upload','confirmation','finalization','ended'].includes(value.phase)||!['pending','succeeded','failed','cancelled'].includes(value.outcome))throw new Error('INVALID_STUDY_TIMING');
  for(const number of [value.elapsedMs,value.activeMs,value.offlineMs,value.unattendedMs])if(!Number.isSafeInteger(number)||number<0||number>86400000)throw new Error('INVALID_STUDY_TIMING');
  if(value.activeMs+value.unattendedMs>value.elapsedMs||value.offlineMs>value.elapsedMs||(value.phase==='ended')===(value.outcome==='pending'))throw new Error('INVALID_STUDY_TIMING');
  if(value.errorCode!==undefined&&!['network','authentication','quota','storage','capability','integrity','provider','cancelled','unknown'].includes(value.errorCode))throw new Error('INVALID_STUDY_TIMING');
  if(value.interaction!==undefined&&!TIMING_INTERACTIONS.includes(value.interaction))throw new Error('INVALID_STUDY_TIMING');
  if(value.clientOccurredAt!==undefined&&!validTimestamp(value.clientOccurredAt))throw new Error('INVALID_STUDY_TIMING');
  if(value.networkState!==undefined&&!['online','offline','unknown'].includes(value.networkState))throw new Error('INVALID_STUDY_TIMING');
  if(value.uploadState!==undefined&&!['queued','uploading','waiting','retrying','committing','finalizing','complete','needs_attention'].includes(value.uploadState))throw new Error('INVALID_STUDY_TIMING');
  return {phase:value.phase,outcome:value.outcome,elapsedMs:value.elapsedMs,activeMs:value.activeMs,offlineMs:value.offlineMs,unattendedMs:value.unattendedMs,...(value.errorCode?{errorCode:value.errorCode}:{}),...(value.interaction!==undefined?{interaction:value.interaction}:{}),...(value.clientOccurredAt?{clientOccurredAt:value.clientOccurredAt}:{}),...(value.networkState?{networkState:value.networkState}:{}),...(value.uploadState?{uploadState:value.uploadState}:{})};
}
function validTimestamp(value:unknown):value is string{return typeof value==='string'&&/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)&&Number.isFinite(Date.parse(value))&&new Date(value).toISOString()===value;}
function safeStartInput(input:Omit<TimingStart,'operationNonce'|'clientStartedAt'>){
  if(!/^pr_[a-f0-9]{32}$/.test(input.datasetRef)||!['packproof','ordinary_baseline','interface_action'].includes(input.taskKind)||!['s24_ultra','a16_5g','other_android','ios','web','unknown'].includes(input.deviceClass)||!['ebay','stripe','paypal','manual','other','unknown'].includes(input.channel)||(input.buildSha!==undefined&&(typeof input.buildSha!=='string'||!/^[a-f0-9]{40}$/.test(input.buildSha))))throw new Error('INVALID_STUDY_START');
  if(input.flowVersion!==undefined&&input.flowVersion!==1||input.platform!==undefined&&!['android','ios','web','desktop'].includes(input.platform)||input.entrySource!==undefined&&!ENTRY_SOURCES.includes(input.entrySource)||input.appVersion!==undefined&&(typeof input.appVersion!=='string'||!/^[0-9][a-zA-Z0-9._-]{0,63}$/.test(input.appVersion)))throw new Error('INVALID_STUDY_START');
  return {datasetRef:input.datasetRef,taskKind:input.taskKind,deviceClass:input.deviceClass,channel:input.channel,...(input.buildSha!==undefined?{buildSha:input.buildSha}:{}),...(input.flowVersion?{flowVersion:input.flowVersion}:{}),...(input.platform?{platform:input.platform}:{}),...(input.entrySource?{entrySource:input.entrySource}:{}),...(input.appVersion?{appVersion:input.appVersion}:{})};
}
function safeNonce(value:string){if(typeof value!=='string'||!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(value))throw new Error('INVALID_STUDY_NONCE');return value;}
function safeJournal(value:TimingJournal):TimingJournal{
  const input=safeStartInput(value.start),clientStartedAt=value.start.clientStartedAt;
  if(typeof clientStartedAt!=='string'||!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(clientStartedAt)||!Number.isFinite(Date.parse(clientStartedAt))||new Date(clientStartedAt).toISOString()!==clientStartedAt||typeof value.ended!=='boolean'||!Array.isArray(value.events)||value.events.length>250)throw new Error('INVALID_STUDY_JOURNAL');
  if(value.attemptRef!==undefined&&!/^pr_[a-f0-9]{32}$/.test(value.attemptRef))throw new Error('INVALID_STUDY_JOURNAL');
  if(value.recordedCount!==undefined&&(!Number.isSafeInteger(value.recordedCount)||value.recordedCount<value.events.length||value.recordedCount>250))throw new Error('INVALID_STUDY_JOURNAL');
  if(value.once!==undefined&&(!Array.isArray(value.once)||value.once.length>32||value.once.some(name=>!TIMING_INTERACTIONS.includes(name as TimingInteraction))))throw new Error('INVALID_STUDY_JOURNAL');
  return {start:{...input,operationNonce:safeNonce(value.start.operationNonce),clientStartedAt},...(value.attemptRef!==undefined?{attemptRef:value.attemptRef}:{}),events:value.events.map(event=>({...safeCheckpoint(event),operationNonce:safeNonce(event.operationNonce)})),...(value.lastCheckpoint?{lastCheckpoint:safeCheckpoint(value.lastCheckpoint)}:{}),...(value.recordedCount!==undefined?{recordedCount:value.recordedCount}:{}),...(value.once?{once:[...value.once]}:{}),ended:value.ended};
}
export function createConsentedTimingBridge(options:{store:TimingBridgeStore;api:TimingBridgeApi;current:()=>boolean;newNonce:()=>string;now?:()=>Date}){
  let tail=Promise.resolve();
  const serial=<T>(run:()=>Promise<T>):Promise<T>=>{const next=tail.catch(()=>{}).then(run);tail=next.then(()=>{},()=>{});return next;};
  const active=()=>{if(!options.current())throw new Error('STUDY_ACCOUNT_CHANGED');};
  const allowed=async(datasetRef:string)=>{active();const consent=await options.api.getConsent(datasetRef);active();return consent.granted&&consent.datasetRef===datasetRef&&consent.statementVersion==='capture-timing-study-v1';};
  // Remote waits never hold the local journal lock: actual camera/save callbacks
  // remain durable while consent or an upload of study events is unavailable.
  const read=()=>serial(async()=>{active();const value=await options.store.read();return value?safeJournal(value):null;});
  let flushing:Promise<void>|null=null,flushAgain=false;
  const flush=():Promise<void>=>{
    if(flushing){flushAgain=true;return flushing;}
    const run=async()=>{do{
      flushAgain=false;
      const original=await read();if(!original)return;
      if(!await allowed(original.start.datasetRef)){
        await serial(async()=>{active();await options.store.remove();});return;
      }
      while(true){
        const journal=await read();if(!journal||journal.start.operationNonce!==original.start.operationNonce)return;
        if(!journal.attemptRef){
          const result=await options.api.start(journal.start);active();
          await serial(async()=>{active();const value=await options.store.read();if(!value||value.start.operationNonce!==journal.start.operationNonce)return;const latest=safeJournal(value);latest.attemptRef=result.attemptRef;await options.store.write(latest);});
          continue;
        }
        const event=journal.events[0];
        if(!event){
          if(journal.ended)await serial(async()=>{active();const latest=await options.store.read();if(latest?.start.operationNonce===journal.start.operationNonce&&latest.ended&&!latest.events.length)await options.store.remove();});
          break;
        }
        await options.api.append({...safeCheckpoint(event),operationNonce:event.operationNonce,datasetRef:journal.start.datasetRef,attemptRef:journal.attemptRef});active();
        await serial(async()=>{active();const value=await options.store.read();if(!value||value.start.operationNonce!==journal.start.operationNonce)return;const latest=safeJournal(value);if(latest.events[0]?.operationNonce===event.operationNonce){latest.events.shift();await options.store.write(latest);}});
      }
    }while(flushAgain);};
    flushing=run().finally(()=>{flushing=null;});return flushing;
  };
  return {
    start:(input:Omit<TimingStart,'operationNonce'|'clientStartedAt'>,cachedConsent?:StudyConsent,observedAt?:Date)=>serial(async()=>{
      const safeInput=safeStartInput(input);
      active();
      // An explicit grant cached on this account may retain an offline start.
      // It grants no intake authority: flush always rechecks the live consent,
      // and the server rejects starts outside the current grant interval.
      if(cachedConsent){if(!cachedConsent.granted||cachedConsent.datasetRef!==input.datasetRef||cachedConsent.statementVersion!=='capture-timing-study-v1')return false;}
      else if(!await allowed(input.datasetRef))return false;
      if(await options.store.read())throw new Error('STUDY_TIMING_ALREADY_PENDING');
      const start:TimingStart={...safeInput,operationNonce:safeNonce(options.newNonce()),clientStartedAt:(observedAt??options.now?.()??new Date()).toISOString()};
      // Persist start before the host performs the measured action. No successful
      // terminal response is required for this task to enter the denominator.
      await options.store.write({start,events:[],ended:false});return true;
    }),
    checkpoint:(checkpoint:TimingCheckpoint,once=false)=>serial(async()=>{
      active();const stored=await options.store.read();if(!stored)return;const journal=safeJournal(stored);
      if(once&&checkpoint.interaction){if(journal.once?.includes(checkpoint.interaction))return;journal.once=[...(journal.once??[]),checkpoint.interaction];}
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
