import type {PackProofV2Client} from '../v2-api';
import {createConsentedTimingBridge,type TimingCheckpoint,type TimingJournal,type TimingInteraction,type TimingStart,type EntrySource} from './timing-bridge';
export type NativeStudyDeviceClass='s24_ultra'|'a16_5g'|'other_android'|'ios';
export type NativeStudyStatus={enabled?:boolean;datasetRef?:string;granted:boolean;statementVersion?:string;statement?:string};
export type NativeStudyEventOptions={at?:Date;once?:boolean;uploadState?:TimingCheckpoint['uploadState']};
export interface NativeStudyTimer{localRef:string;settled?:()=>Promise<void>;event:(interaction:TimingInteraction,options?:NativeStudyEventOptions)=>void;suspend:()=>void;phase:(value:Exclude<TimingCheckpoint['phase'],'ended'>)=>void;end:(value:'succeeded'|'failed'|'cancelled',error?:TimingCheckpoint['errorCode'])=>void;sampleContext:()=>void;problem:(error:TimingCheckpoint['errorCode'])=>void;}
export interface NativeStudyStorage{getItem(key:string):Promise<string|null>;setItem(key:string,value:string):Promise<void>;removeItem(key:string):Promise<void>;getAllKeys():Promise<readonly string[]>;}
export interface NativeStudyAppState{currentState:string|null;addEventListener(type:'change',listener:(state:string)=>void):{remove():void};}
export function createNativeStudyRuntime({storage:AsyncStorage,appState:AppState,newNonce:newStudyOperationNonce,sourceBuildSha,appVersion,platform,defaultDeviceClass='other_android'}:{storage:NativeStudyStorage;appState:NativeStudyAppState;newNonce:()=>string;sourceBuildSha?:()=>string|undefined;appVersion?:()=>string|undefined;platform?:'android'|'ios';defaultDeviceClass?:NativeStudyDeviceClass}){
type Account={userId:string;apiBaseUrl:string};
let accountReader:()=>Account|null=()=>null,offline=false,connectivityKnown=false;
const locallyWithdrawn=new Set<string>();
function registerStudyAccountReader(read:()=>Account|null){accountReader=read;return()=>{if(accountReader===read)accountReader=()=>null;};}
const scope=(api:PackProofV2Client,userId:string)=>`packproof-study:${api.apiBaseUrl}:${userId}:`;
const current=(api:PackProofV2Client,userId:string)=>{const account=accountReader();return !locallyWithdrawn.has(scope(api,userId))&&account?.userId===userId&&account.apiBaseUrl.replace(/\/+$/,'')===api.apiBaseUrl;};
async function rememberNativeStudyConsent(api:PackProofV2Client,userId:string,status:NativeStudyStatus,deviceClass?:NativeStudyDeviceClass){
  const owner=accountReader();if(owner?.userId!==userId||owner.apiBaseUrl.replace(/\/+$/,'')!==api.apiBaseUrl)return;const key=scope(api,userId)+'consent';
  if(status.enabled!==false&&status.granted&&status.datasetRef){let previous:Record<string,unknown>={};try{previous=JSON.parse(await AsyncStorage.getItem(key)??'{}');}catch{}const selected=deviceClass??previous.deviceClass;await AsyncStorage.setItem(key,JSON.stringify({datasetRef:status.datasetRef,statementVersion:status.statementVersion,granted:true,deviceClass:['s24_ultra','a16_5g','other_android','ios'].includes(String(selected))?selected:defaultDeviceClass}));}
  if(status.enabled!==false&&status.granted&&status.datasetRef){locallyWithdrawn.delete(scope(api,userId));}
  else {
    locallyWithdrawn.add(scope(api,userId));
    for(const [timerKey,timer] of timers)if(timerKey.startsWith(scope(api,userId)))timer.suspend();
    for(const storedKey of await AsyncStorage.getAllKeys())if(storedKey.startsWith(scope(api,userId)))await AsyncStorage.removeItem(storedKey);
  }
}
const bridges=new Map<string,ReturnType<typeof createConsentedTimingBridge>>();
function bridge(api:PackProofV2Client,userId:string,localRef:string){
  const key=scope(api,userId)+'task:'+localRef,existing=bridges.get(key);if(existing)return existing;
  const value=createConsentedTimingBridge({newNonce:newStudyOperationNonce,current:()=>current(api,userId),api:{
    getConsent:async()=>{const status=await api.studyRequest<NativeStudyStatus>('/consent');return {datasetRef:status.datasetRef??'',granted:status.enabled!==false&&status.granted,statementVersion:status.statementVersion??''};},
    start:input=>api.studyRequest('/timings/start','POST',input),append:input=>api.studyRequest('/timings','POST',input),
  },store:{read:async()=>{const value=await AsyncStorage.getItem(key);return value?JSON.parse(value) as TimingJournal:null;},write:value=>AsyncStorage.setItem(key,JSON.stringify(value)),remove:async()=>{await AsyncStorage.removeItem(key);bridges.delete(key);}}});bridges.set(key,value);return value;
}
const timers=new Map<string,NativeStudyTimer>();
function updateNativeStudyConnectivity(value:boolean){for(const timer of timers.values())timer.sampleContext();offline=value;connectivityKnown=true;}
function timerFor(api:PackProofV2Client,userId:string,localRef:string,journal:TimingJournal,uploadState?:TimingCheckpoint['uploadState']):NativeStudyTimer|null{
  const key=scope(api,userId)+localRef,existing=timers.get(key);if(existing)return existing;if(journal.ended)return null;
  const tracker=bridge(api,userId,localRef),last=journal.lastCheckpoint;
  let phase:Exclude<TimingCheckpoint['phase'],'ended'>=last&&last.phase!=='ended'?last.phase:'preflight',previous=Date.now(),activeMs=last?.activeMs??0,offlineMs=last?.offlineMs??0,unattendedMs=last?.unattendedMs??0,foreground=AppState.currentState==='active',ended=false;
  const sample=()=>{const now=Date.now(),delta=Math.max(0,now-previous);previous=now;if(offline)offlineMs+=delta;if(!foreground||phase==='upload'||phase==='finalization')unattendedMs+=delta;else activeMs+=delta;return Math.min(86400000,Math.max(last?.elapsedMs??0,now-Date.parse(journal.start.clientStartedAt)));};
  let lastUploadState=uploadState??last?.uploadState;let localPersistence=Promise.resolve();
  const checkpoint=(next:TimingCheckpoint['phase'],outcome:TimingCheckpoint['outcome']='pending',errorCode?:TimingCheckpoint['errorCode'],interaction?:TimingInteraction,options:NativeStudyEventOptions={})=>{if(!current(api,userId))return;const elapsedMs=sample(),active=Math.min(elapsedMs,Math.floor(activeMs));localPersistence=tracker.checkpoint({phase:next,outcome,elapsedMs,activeMs:active,offlineMs:Math.min(elapsedMs,Math.floor(offlineMs)),unattendedMs:Math.min(elapsedMs-active,Math.floor(unattendedMs)),errorCode,...(interaction?{interaction,clientOccurredAt:(options.at??new Date()).toISOString(),networkState:!connectivityKnown?'unknown':offline?'offline':'online'}:{}),...(options.uploadState?{uploadState:options.uploadState}:{})},options.once===true);void localPersistence.then(()=>tracker.flush()).catch(()=>{});};
  const interval=setInterval(()=>{if(!current(api,userId)){stop();return;}checkpoint(phase);},15000);
  const state=AppState.addEventListener('change',value=>{if(!current(api,userId)){stop();return;}sample();foreground=value==='active';checkpoint(phase);});
  const stop=()=>{ended=true;clearInterval(interval);state.remove();timers.delete(key);};
  const timer:NativeStudyTimer={localRef,settled:()=>localPersistence,event:(interaction,options={})=>{if(ended||!current(api,userId))return;if(interaction==='upload_state_changed'){if(!options.uploadState||lastUploadState===options.uploadState)return;lastUploadState=options.uploadState;void AsyncStorage.setItem(scope(api,userId)+'upload-state:'+localRef,options.uploadState).catch(()=>{});}checkpoint(phase,'pending',undefined,interaction,options);},suspend:()=>{if(ended)return;checkpoint(phase);stop();},sampleContext:()=>{if(!current(api,userId)){stop();return;}if(!ended)sample();},problem:error=>{if(!ended)checkpoint(phase,'pending',error);},phase:next=>{if(ended||phase===next)return;checkpoint(next);phase=next;},end:(outcome,errorCode)=>{if(ended)return;checkpoint('ended',outcome,errorCode);stop();}};timers.set(key,timer);return timer;
}
async function startNativeStudy(api:PackProofV2Client,userId:string,taskKind:TimingStart['taskKind']='packproof',options:{observedAt?:Date;entrySource?:EntrySource;localRef?:string}={}):Promise<NativeStudyTimer|null>{
  const observedAt=options.observedAt??new Date();
  try{
    if(!current(api,userId))return null;const cached=await AsyncStorage.getItem(scope(api,userId)+'consent');if(!cached)return null;const savedConsent=JSON.parse(cached);const declared=savedConsent.deviceClass;const deviceClass: NativeStudyDeviceClass=['s24_ultra','a16_5g','other_android','ios'].includes(declared)?declared:defaultDeviceClass;
    let status:NativeStudyStatus={...savedConsent,enabled:true};
    // Persist the observed start under the existing explicit grant immediately.
    // Transport always rechecks live consent; camera entry never waits for it.
    if(!current(api,userId)||status.enabled===false||!status.granted||!status.datasetRef||status.statementVersion!=='capture-timing-study-v1')return null;
    const localRef=options.localRef??newStudyOperationNonce();if(!/^[a-f0-9-]{36}$/i.test(localRef))return null;const tracker=bridge(api,userId,localRef);
    const candidateBuild=sourceBuildSha?.();const buildSha=typeof candidateBuild==='string'&&/^[a-f0-9]{40}$/.test(candidateBuild)?candidateBuild:undefined;
    const version=appVersion?.();
    if(!await tracker.start({datasetRef:status.datasetRef,taskKind,deviceClass,channel:'unknown',flowVersion:1,...(platform?{platform}:{}),...(version&&/^[0-9][a-zA-Z0-9._-]{0,63}$/.test(version)?{appVersion:version}:{}),...(options.entrySource?{entrySource:options.entrySource}:{}),...(buildSha?{buildSha}:{})},{datasetRef:status.datasetRef,granted:true,statementVersion:status.statementVersion},observedAt))return null;
    const saved=await AsyncStorage.getItem(scope(api,userId)+'task:'+localRef);if(!saved)return null;
    void tracker.flush().catch(()=>{});return timerFor(api,userId,localRef,JSON.parse(saved));
  }catch{return null;}
}
async function nativeStudyForCapture(api:PackProofV2Client,userId:string,localRef:string|undefined,proofId?:string):Promise<NativeStudyTimer|null>{
  try{if(!current(api,userId))return null;
    // If optional measurement storage was slow at camera entry, the independent
    // account-scoped locator recovers it without delaying or rewriting capture.
    if(!localRef&&proofId)localRef=await AsyncStorage.getItem(scope(api,userId)+'proof-flow:'+proofId)??undefined;
    if(!localRef)return null;const saved=await AsyncStorage.getItem(scope(api,userId)+'task:'+localRef);
    const storedUpload=await AsyncStorage.getItem(scope(api,userId)+'upload-state:'+localRef);
    const uploadState=storedUpload&&['queued','uploading','waiting','retrying','committing','finalizing','complete','needs_attention'].includes(storedUpload)?storedUpload as TimingCheckpoint['uploadState']:undefined;
    return saved?timerFor(api,userId,localRef,JSON.parse(saved),uploadState):null;
  }catch{return null;}
}
const flushing=new Map<string,Promise<void>>();
function flushNativeStudyTimings(api:PackProofV2Client,userId:string){
  const prefix=scope(api,userId)+'task:',existing=flushing.get(prefix);if(existing)return existing;
  const task=(async()=>{
    if(!current(api,userId))return;
    for(const key of (await AsyncStorage.getAllKeys()).filter(key=>key.startsWith(prefix)).slice(0,100)){
      if(!current(api,userId))return;
      try{await bridge(api,userId,key.slice(prefix.length)).flush();}catch{/* Preserve the same operations for retry. */}
    }
  })().finally(()=>flushing.delete(prefix));flushing.set(prefix,task);return task;
}
async function recordNativeStudyInteraction(api:PackProofV2Client,userId:string,interaction:TimingInteraction,entrySource:EntrySource='unknown',at=new Date()) {
  const timer=await startNativeStudy(api,userId,'interface_action',{observedAt:at,entrySource});
  if(!timer)return;timer.event(interaction,{at,once:true});timer.end('succeeded');
}
// The locator is local only. Domain IDs are never copied into study requests.
type FlowLocator={localRef:string;proofId?:string;entrySource:EntrySource};
const flowOperations=new Map<string,Promise<unknown>>();
function withFlow<T>(api:PackProofV2Client,userId:string,work:()=>Promise<T>):Promise<T>{
  const key=scope(api,userId),previous=flowOperations.get(key)??Promise.resolve();
  const pending=previous.catch(()=>{}).then(work);flowOperations.set(key,pending);
  void pending.finally(()=>{if(flowOperations.get(key)===pending)flowOperations.delete(key);}).catch(()=>{});return pending;
}
async function flowLocator(api:PackProofV2Client,userId:string):Promise<FlowLocator|null>{
  try{const value=JSON.parse(await AsyncStorage.getItem(scope(api,userId)+'first-proof-flow')??'null');return value&&typeof value.localRef==='string'&&/^[a-f0-9-]{36}$/i.test(value.localRef)?value:null;}catch{return null;}
}
async function beginNativeFirstProof(api:PackProofV2Client,userId:string,entrySource:EntrySource='manual',proofId?:string,observedAt=new Date()):Promise<NativeStudyTimer|null>{
  return withFlow(api,userId,async()=>{try{
    if(!current(api,userId))return null;
    const previous=await flowLocator(api,userId);
    const reuse=previous&&previous.proofId===proofId?await nativeStudyForCapture(api,userId,previous.localRef):null;
    const timer=reuse??await startNativeStudy(api,userId,'packproof',{observedAt,entrySource});
    if(!timer||!current(api,userId))return null;
    await AsyncStorage.setItem(scope(api,userId)+'first-proof-flow',JSON.stringify({localRef:timer.localRef,entrySource,...(proofId?{proofId}:{})}));
    timer.event('start_selected',{at:observedAt,once:true});return timer;
  }catch{return null;}});
}
async function nativeStudyForNewCapture(api:PackProofV2Client,userId:string,proofId:string,observedAt=new Date()):Promise<NativeStudyTimer|null>{
  return withFlow(api,userId,async()=>{try{
    if(!current(api,userId))return null;
    const previous=await flowLocator(api,userId);
    const timer=previous&&(!previous.proofId||previous.proofId===proofId)?await nativeStudyForCapture(api,userId,previous.localRef):null;
    const selected=timer??await startNativeStudy(api,userId,'packproof',{observedAt,entrySource:'deep_link'});
    if(!selected||!current(api,userId))return null;
    await AsyncStorage.setItem(scope(api,userId)+'first-proof-flow',JSON.stringify({localRef:selected.localRef,proofId,entrySource:previous?.entrySource??'deep_link'}));
    await AsyncStorage.setItem(scope(api,userId)+'proof-flow:'+proofId,selected.localRef);
    selected.event('start_selected',{at:observedAt,once:true});return selected;
  }catch{return null;}});
}
async function recordNativeStudyFlowEvent(api:PackProofV2Client,userId:string,interaction:TimingInteraction,entrySource:EntrySource='unknown'){
  const at=new Date();
  try{const previous=await flowLocator(api,userId),timer=previous?await nativeStudyForCapture(api,userId,previous.localRef):null;
    if(timer){timer.event(interaction,{at});return;}
    await recordNativeStudyInteraction(api,userId,interaction,entrySource,at);
  }catch{/* Optional measurement never prevents the user's action. */}
}
// Previously consented reauthentication only. No fresh sign-up or arbitrary
// signed-out visitor is measured. Flush requires the same authenticated account.
type AuthPending={datasetRef:string;localRef?:string;transferred?:boolean;events:Array<{interaction:'auth_started'|'auth_failed';at:string}>};
async function retainNativeStudyAuth(api:PackProofV2Client,userId:string,interaction:'auth_started'|'auth_failed',at=new Date()){
  try{
    const consent=JSON.parse(await AsyncStorage.getItem(scope(api,userId)+'consent')??'null');
    if(locallyWithdrawn.has(scope(api,userId))||!consent?.granted||consent.statementVersion!=='capture-timing-study-v1'||!/^pr_[a-f0-9]{32}$/.test(consent.datasetRef))return;
    const key=scope(api,userId)+'reauth',old=JSON.parse(await AsyncStorage.getItem(key)??'null') as AuthPending|null;
    const events=old&&!old.transferred&&old.datasetRef===consent.datasetRef&&Array.isArray(old.events)?old.events:[];
    if(events.length>=16)return;events.push({interaction,at:at.toISOString()});
    await AsyncStorage.setItem(key,JSON.stringify({datasetRef:consent.datasetRef,events}));
  }catch{/* No credentials, email or error text enter this bounded journal. */}
}
async function completeNativeStudyAuth(api:PackProofV2Client,userId:string,at=new Date()){
 return withFlow(api,userId,async()=>{try{
    if(!current(api,userId))return;
    const key=scope(api,userId)+'reauth',pending=JSON.parse(await AsyncStorage.getItem(key)??'null') as AuthPending|null;
    const consent=JSON.parse(await AsyncStorage.getItem(scope(api,userId)+'consent')??'null');
    if(!pending?.events?.length||pending.events.length>16||pending.datasetRef!==consent?.datasetRef||pending.events.some(event=>!['auth_started','auth_failed'].includes(event.interaction)||!Number.isFinite(Date.parse(event.at))))return;
    pending.localRef??=newStudyOperationNonce();await AsyncStorage.setItem(key,JSON.stringify(pending));
    const stored=await AsyncStorage.getItem(scope(api,userId)+'task:'+pending.localRef);
    if(!stored&&pending.transferred){await AsyncStorage.removeItem(key);return;}
    if(stored&&JSON.parse(stored).ended){await AsyncStorage.removeItem(key);void bridge(api,userId,pending.localRef).flush().catch(()=>{});return;}
    const timer=stored?await nativeStudyForCapture(api,userId,pending.localRef):await startNativeStudy(api,userId,'interface_action',{observedAt:new Date(pending.events[0].at),entrySource:'auth',localRef:pending.localRef});
    if(!timer)return;
    pending.transferred=true;await AsyncStorage.setItem(key,JSON.stringify(pending));
    for(const event of pending.events)timer.event(event.interaction,{at:new Date(event.at),once:true});
    timer.event('auth_completed',{at,once:true});timer.end('succeeded');
    await timer.settled?.();
    await AsyncStorage.removeItem(key);
  }catch{/* Reauthentication itself is independent of optional measurement. */}});
}
return {registerStudyAccountReader,rememberNativeStudyConsent,updateNativeStudyConnectivity,startNativeStudy,nativeStudyForCapture,flushNativeStudyTimings,recordNativeStudyInteraction,beginNativeFirstProof,nativeStudyForNewCapture,recordNativeStudyFlowEvent,retainNativeStudyAuth,completeNativeStudyAuth,dispose:()=>{for(const timer of [...timers.values()])timer.suspend();accountReader=()=>null;}};
}
