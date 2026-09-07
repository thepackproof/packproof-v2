import type {PackProofV2Client} from '../v2-api';
import {createConsentedTimingBridge,type TimingCheckpoint,type TimingJournal} from './timing-bridge';
export type NativeStudyStatus={enabled?:boolean;datasetRef?:string;granted:boolean;statementVersion?:string;statement?:string};
export interface NativeStudyTimer{localRef:string;phase:(value:Exclude<TimingCheckpoint['phase'],'ended'>)=>void;end:(value:'succeeded'|'failed'|'cancelled',error?:TimingCheckpoint['errorCode'])=>void;sampleContext:()=>void;problem:(error:TimingCheckpoint['errorCode'])=>void;}
export interface NativeStudyStorage{getItem(key:string):Promise<string|null>;setItem(key:string,value:string):Promise<void>;removeItem(key:string):Promise<void>;getAllKeys():Promise<readonly string[]>;}
export interface NativeStudyAppState{currentState:string|null;addEventListener(type:'change',listener:(state:string)=>void):{remove():void};}
export function createNativeStudyRuntime({storage:AsyncStorage,appState:AppState,newNonce:newStudyOperationNonce}:{storage:NativeStudyStorage;appState:NativeStudyAppState;newNonce:()=>string}){
type Account={userId:string;apiBaseUrl:string};
let accountReader:()=>Account|null=()=>null,offline=false;
function registerStudyAccountReader(read:()=>Account|null){accountReader=read;return()=>{if(accountReader===read)accountReader=()=>null;};}
const scope=(api:PackProofV2Client,userId:string)=>`packproof-study:${api.apiBaseUrl}:${userId}:`;
const current=(api:PackProofV2Client,userId:string)=>{const account=accountReader();return account?.userId===userId&&account.apiBaseUrl.replace(/\/+$/,'')===api.apiBaseUrl;};
async function rememberNativeStudyConsent(api:PackProofV2Client,userId:string,status:NativeStudyStatus,deviceClass?:'s24_ultra'|'a16_5g'|'other_android'){
  if(!current(api,userId))return;const key=scope(api,userId)+'consent';
  if(status.enabled!==false&&status.granted&&status.datasetRef){let previous:Record<string,unknown>={};try{previous=JSON.parse(await AsyncStorage.getItem(key)??'{}');}catch{}const selected=deviceClass??previous.deviceClass;await AsyncStorage.setItem(key,JSON.stringify({datasetRef:status.datasetRef,statementVersion:status.statementVersion,granted:true,deviceClass:['s24_ultra','a16_5g','other_android'].includes(String(selected))?selected:'other_android'}));}
  else await AsyncStorage.removeItem(key);
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
function updateNativeStudyConnectivity(value:boolean){for(const timer of timers.values())timer.sampleContext();offline=value;}
function timerFor(api:PackProofV2Client,userId:string,localRef:string,journal:TimingJournal):NativeStudyTimer|null{
  const key=scope(api,userId)+localRef,existing=timers.get(key);if(existing)return existing;if(journal.ended)return null;
  const tracker=bridge(api,userId,localRef),last=journal.lastCheckpoint;
  let phase:Exclude<TimingCheckpoint['phase'],'ended'>=last&&last.phase!=='ended'?last.phase:'preflight',previous=Date.now(),activeMs=last?.activeMs??0,offlineMs=last?.offlineMs??0,unattendedMs=last?.unattendedMs??0,foreground=AppState.currentState==='active',ended=false;
  const sample=()=>{const now=Date.now(),delta=Math.max(0,now-previous);previous=now;if(offline)offlineMs+=delta;if(!foreground||phase==='upload'||phase==='finalization')unattendedMs+=delta;else activeMs+=delta;return Math.min(86400000,Math.max(last?.elapsedMs??0,now-Date.parse(journal.start.clientStartedAt)));};
  const checkpoint=(next:TimingCheckpoint['phase'],outcome:TimingCheckpoint['outcome']='pending',errorCode?:TimingCheckpoint['errorCode'])=>{if(!current(api,userId))return;const elapsedMs=sample(),active=Math.min(elapsedMs,Math.floor(activeMs));void tracker.checkpoint({phase:next,outcome,elapsedMs,activeMs:active,offlineMs:Math.min(elapsedMs,Math.floor(offlineMs)),unattendedMs:Math.min(elapsedMs-active,Math.floor(unattendedMs)),errorCode}).then(()=>tracker.flush()).catch(()=>{});};
  const interval=setInterval(()=>{if(!current(api,userId)){stop();return;}checkpoint(phase);},15000);
  const state=AppState.addEventListener('change',value=>{if(!current(api,userId)){stop();return;}sample();foreground=value==='active';checkpoint(phase);});
  const stop=()=>{ended=true;clearInterval(interval);state.remove();timers.delete(key);};
  const timer:NativeStudyTimer={localRef,sampleContext:()=>{if(!current(api,userId)){stop();return;}if(!ended)sample();},problem:error=>{if(!ended)checkpoint(phase,'pending',error);},phase:next=>{if(ended||phase===next)return;checkpoint(next);phase=next;},end:(outcome,errorCode)=>{if(ended)return;checkpoint('ended',outcome,errorCode);stop();}};timers.set(key,timer);return timer;
}
async function startNativeStudy(api:PackProofV2Client,userId:string):Promise<NativeStudyTimer|null>{
  try{
    if(!current(api,userId))return null;const cached=await AsyncStorage.getItem(scope(api,userId)+'consent');if(!cached)return null;const savedConsent=JSON.parse(cached);const declared=savedConsent.deviceClass;const deviceClass: 's24_ultra'|'a16_5g'|'other_android'=declared==='s24_ultra'||declared==='a16_5g'?declared:'other_android';
    let status:NativeStudyStatus={...savedConsent,enabled:true};
    if(!offline)try{status=await api.studyRequest<NativeStudyStatus>('/consent');}catch{/* Keep the started-failure denominator under the prior explicit grant. */}
    if(!current(api,userId)||status.enabled===false||!status.granted||!status.datasetRef||status.statementVersion!=='capture-timing-study-v1')return null;
    const localRef=newStudyOperationNonce(),tracker=bridge(api,userId,localRef);
    if(!await tracker.start({datasetRef:status.datasetRef,taskKind:'packproof',deviceClass,channel:'unknown'},{datasetRef:status.datasetRef,granted:true,statementVersion:status.statementVersion}))return null;
    const saved=await AsyncStorage.getItem(scope(api,userId)+'task:'+localRef);if(!saved)return null;
    void tracker.flush().catch(()=>{});return timerFor(api,userId,localRef,JSON.parse(saved));
  }catch{return null;}
}
async function nativeStudyForCapture(api:PackProofV2Client,userId:string,localRef:string|undefined):Promise<NativeStudyTimer|null>{
  try{if(!localRef||!current(api,userId))return null;const saved=await AsyncStorage.getItem(scope(api,userId)+'task:'+localRef);return saved?timerFor(api,userId,localRef,JSON.parse(saved)):null;}catch{return null;}
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
return {registerStudyAccountReader,rememberNativeStudyConsent,updateNativeStudyConnectivity,startNativeStudy,nativeStudyForCapture,flushNativeStudyTimings,dispose:()=>{for(const timer of [...timers.values()])timer.end('cancelled','cancelled');accountReader=()=>null;}};
}
