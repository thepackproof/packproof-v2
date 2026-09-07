import type {PackProofApi} from '../api/client';
import {randomId} from '../random-id';
import {createConsentedTimingBridge,type TimingJournal,type TimingCheckpoint,type StudyConsent} from './timing-bridge';
export type StudyStatus=Partial<StudyConsent>&{enabled:boolean;statement?:string;changedAt?:string|null};
const prefix=(api:PackProofApi,userId:string)=>`${api.recoveryScope}:${userId}:`;
export function rememberStudyStatus(api:PackProofApi,userId:string,status:StudyStatus){
  try{const key=`packproof-study-consent:${prefix(api,userId)}`;if(status.enabled&&status.granted&&status.datasetRef)localStorage.setItem(key,JSON.stringify({datasetRef:status.datasetRef,granted:true,statementVersion:status.statementVersion}));else localStorage.removeItem(key);}catch{/* Unavailable local storage leaves capture uninstrumented. */}
}
async function storage<T>(mode:IDBTransactionMode,run:(store:IDBObjectStore)=>IDBRequest<T>):Promise<T>{
  const db=await new Promise<IDBDatabase>((resolve,reject)=>{const open=indexedDB.open('packproof-study-timing',1);open.onupgradeneeded=()=>open.result.createObjectStore('tasks',{keyPath:'key'});open.onsuccess=()=>resolve(open.result);open.onerror=()=>reject(open.error);});
  try{return await new Promise<T>((resolve,reject)=>{const tx=db.transaction('tasks',mode),request=run(tx.objectStore('tasks'));tx.oncomplete=()=>resolve(request.result);tx.onerror=()=>reject(tx.error);tx.onabort=()=>reject(tx.error);});}finally{db.close();}
}
const trackers=new Map<string,ReturnType<typeof createConsentedTimingBridge>>();
function bridge(api:PackProofApi,key:string){const previous=trackers.get(key);if(previous)return previous;const created=createConsentedTimingBridge({newNonce:randomId,current:()=>true,api:{
  getConsent:async()=>{const status=await api.studyRequest<StudyStatus>('/consent');return {datasetRef:status.datasetRef??'',granted:status.enabled!==false&&status.granted===true,statementVersion:status.statementVersion??''};},
  start:input=>api.studyRequest('/timings/start','POST',input),append:input=>api.studyRequest('/timings','POST',input),
},store:{read:async()=>(await storage<{key:string;journal:TimingJournal}|undefined>('readonly',store=>store.get(key)))?.journal??null,write:async journal=>{await storage('readwrite',store=>store.put({key,journal}));},remove:async()=>{await storage('readwrite',store=>store.delete(key));trackers.delete(key);}}});trackers.set(key,created);return created;}
const flushing=new Map<string,Promise<void>>();
export function flushStudyTimings(api:PackProofApi,userId:string):Promise<void>{
  const scope=prefix(api,userId),running=flushing.get(scope);if(running)return running;
  const task=(async()=>{const rows=await storage<Array<{key:string}>>('readonly',store=>store.getAll());for(const row of rows.filter(row=>row.key.startsWith(scope)).slice(0,100))try{await bridge(api,row.key).flush();}catch{/* Keep the original operation for the next consented, account-bound retry. */}})().finally(()=>flushing.delete(scope));flushing.set(scope,task);return task;
}
export interface StationStudyTimer{phase:(phase:Exclude<TimingCheckpoint['phase'],'ended'>)=>void;end:(outcome:'succeeded'|'failed'|'cancelled',errorCode?:TimingCheckpoint['errorCode'])=>void;}
/** Records only a deliberately consented station task. Operational capture/upload
 * content is never passed here. Foreground task windows are client timing context,
 * not a measurement of attention or a validated ordinary-work baseline. */
export async function startStationStudy(api:PackProofApi,userId:string):Promise<StationStudyTimer|null>{
  try{
    // Default capture does not perform a study request. Only a previously explicit,
    // account-scoped opt-in enables the live consent recheck below.
    if(!localStorage.getItem(`packproof-study-consent:${prefix(api,userId)}`))return null;
    const status=await api.studyRequest<StudyStatus>('/consent');if(!status.enabled||!status.granted||!status.datasetRef)return null;
    const key=prefix(api,userId)+randomId(),tracker=bridge(api,key);
    if(!await tracker.start({datasetRef:status.datasetRef,taskKind:'packproof',deviceClass:'web',channel:'unknown'}))return null;
    const started=performance.now();let previous=started,activeMs=0,unattendedMs=0,offlineMs=0,current:Exclude<TimingCheckpoint['phase'],'ended'>='preflight',ended=false,offline=navigator.onLine===false,hidden=document.visibilityState==='hidden';
    const sample=()=>{const now=performance.now(),delta=Math.max(0,now-previous);previous=now;if(offline)offlineMs+=delta;if(current==='upload'||current==='finalization'||hidden)unattendedMs+=delta;else activeMs+=delta;return Math.max(0,now-started);};
    const checkpoint=(phase:TimingCheckpoint['phase'],outcome:TimingCheckpoint['outcome']='pending',errorCode?:TimingCheckpoint['errorCode'])=>{
      const elapsedMs=Math.min(86400000,Math.floor(sample()));
      const active=Math.min(elapsedMs,Math.floor(activeMs));
      void tracker.checkpoint({phase,outcome,elapsedMs,activeMs:active,unattendedMs:Math.min(elapsedMs-active,Math.floor(unattendedMs)),offlineMs:Math.min(elapsedMs,Math.floor(offlineMs)),errorCode}).then(()=>tracker.flush()).catch(()=>{});
    };
    const tick=window.setInterval(()=>checkpoint(current),15000);
    // Save a final context checkpoint on page exit, without fabricating a terminal success.
    const leaving=()=>{if(!ended)checkpoint(current);};window.addEventListener('pagehide',leaving);
    const networkChanged=()=>{sample();offline=navigator.onLine===false;};const visibilityChanged=()=>{sample();hidden=document.visibilityState==='hidden';};
    window.addEventListener('online',networkChanged);window.addEventListener('offline',networkChanged);document.addEventListener('visibilitychange',visibilityChanged);
    void tracker.flush().catch(()=>{});
    return {phase:phase=>{if(ended||phase===current)return;checkpoint(phase);current=phase;},end:(outcome,errorCode)=>{if(ended)return;ended=true;clearInterval(tick);window.removeEventListener('pagehide',leaving);window.removeEventListener('online',networkChanged);window.removeEventListener('offline',networkChanged);document.removeEventListener('visibilitychange',visibilityChanged);checkpoint('ended',outcome,errorCode);}};
  }catch{return null;}
}
