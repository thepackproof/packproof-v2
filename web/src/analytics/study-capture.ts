import type {PackProofApi} from '../api/client';
import {randomId} from '../random-id';
import {createConsentedTimingBridge,type TimingJournal,type TimingCheckpoint,type StudyConsent,type TimingStart} from './timing-bridge';
import type { EntrySource, TimingContext } from '../../../mobile/src/analytics/timing-bridge';
export type StudyApi=Pick<PackProofApi,'recoveryScope'|'studyRequest'>;
export type StudyStatus=Partial<StudyConsent>&{enabled:boolean;statement?:string;changedAt?:string|null};
const prefix=(api:StudyApi,userId:string)=>`${api.recoveryScope}:${userId}:`;
const locallyWithdrawn=new Set<string>();
export function rememberStudyStatus(api:StudyApi,userId:string,status:StudyStatus){
  const scope=prefix(api,userId);
  if(status.enabled&&status.granted&&status.datasetRef)locallyWithdrawn.delete(scope);
  else {locallyWithdrawn.add(scope);for(const [taskKey,live]of liveTimers)if(taskKey.startsWith(scope)){live.timer.suspend();liveTimers.delete(taskKey);}}
  try{const key=`packproof-study-consent:${prefix(api,userId)}`;if(status.enabled&&status.granted&&status.datasetRef)localStorage.setItem(key,JSON.stringify({datasetRef:status.datasetRef,granted:true,statementVersion:status.statementVersion}));else { localStorage.removeItem(key); for (const [taskKey, live] of liveTimers) if (taskKey.startsWith(prefix(api, userId))) { live.timer.suspend(); liveTimers.delete(taskKey); } }}catch{/* Unavailable local storage leaves capture uninstrumented. */}
}
async function storage<T>(mode:IDBTransactionMode,run:(store:IDBObjectStore)=>IDBRequest<T>):Promise<T>{
  const db=await new Promise<IDBDatabase>((resolve,reject)=>{const open=indexedDB.open('packproof-study-timing',1);open.onupgradeneeded=()=>open.result.createObjectStore('tasks',{keyPath:'key'});open.onsuccess=()=>resolve(open.result);open.onerror=()=>reject(open.error);});
  try{return await new Promise<T>((resolve,reject)=>{const tx=db.transaction('tasks',mode),request=run(tx.objectStore('tasks'));tx.oncomplete=()=>resolve(request.result);tx.onerror=()=>reject(tx.error);tx.onabort=()=>reject(tx.error);});}finally{db.close();}
}
const trackers=new Map<string,ReturnType<typeof createConsentedTimingBridge>>();
function bridge(api:StudyApi,key:string){const previous=trackers.get(key);if(previous)return previous;const created=createConsentedTimingBridge({newNonce:randomId,current:()=>true,api:{
  getConsent:async()=>{const status=await api.studyRequest<StudyStatus>('/consent');return {datasetRef:status.datasetRef??'',granted:status.enabled!==false&&status.granted===true,statementVersion:status.statementVersion??''};},
  start:input=>api.studyRequest('/timings/start','POST',input),append:input=>api.studyRequest('/timings','POST',input),
},store:{read:async()=>(await storage<{key:string;journal:TimingJournal}|undefined>('readonly',store=>store.get(key)))?.journal??null,write:async journal=>{await storage('readwrite',store=>store.put({key,journal}));},remove:async()=>{await storage('readwrite',store=>store.delete(key));trackers.delete(key);}}});trackers.set(key,created);return created;}
const flushing=new Map<string,Promise<void>>();
export function flushStudyTimings(api:StudyApi,userId:string):Promise<void>{
  const scope=prefix(api,userId),running=flushing.get(scope);if(running)return running;
  const task=(async()=>{const rows=await storage<Array<{key:string}>>('readonly',store=>store.getAll());for(const row of rows.filter(row=>row.key.startsWith(scope)).slice(0,100))try{await bridge(api,row.key).flush();}catch{/* Keep the original operation for the next consented, account-bound retry. */}})().finally(()=>flushing.delete(scope));flushing.set(scope,task);return task;
}
export type StudyInteraction = NonNullable<TimingCheckpoint['interaction']>;
export interface StationStudyTimer {
  /** Opaque, local-only journal locator; never include this in a study payload. */
  localRef: string;
  phase: (phase: Exclude<TimingCheckpoint['phase'], 'ended'>) => void;
  event: (interaction: StudyInteraction, options?: {once?:boolean;observedAt?:Date;uploadState?:TimingCheckpoint['uploadState'];errorCode?:TimingCheckpoint['errorCode']}) => void;
  problem: (errorCode: TimingCheckpoint['errorCode']) => void;
  end: (outcome: 'succeeded' | 'failed' | 'cancelled', errorCode?: TimingCheckpoint['errorCode']) => void;
  suspend: () => void;
}
type LiveTimer = { timer: StationStudyTimer; resume: () => void; datasetRef: string };
const liveTimers = new Map<string, LiveTimer>();
const localRefPattern = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const validBuildSha = () => {
  const sha = import.meta.env.VITE_PACKPROOF_BUILD_SHA;
  return typeof sha === 'string' && /^[a-f0-9]{40}$/.test(sha) ? sha : undefined;
};
async function consent(api: StudyApi, userId: string): Promise<StudyConsent | null> {
  if(locallyWithdrawn.has(prefix(api,userId)))return null;
  // An ordinary capture neither reads the remote study API nor installs listeners.
  const cached = localStorage.getItem(`packproof-study-consent:${prefix(api, userId)}`);
  if (!cached) return null;
  let status: StudyStatus = { ...JSON.parse(cached), enabled: true };
  if (!status.enabled || !status.granted || !status.datasetRef || status.statementVersion !== 'capture-timing-study-v1') return null;
  return { datasetRef: status.datasetRef, granted: true, statementVersion: status.statementVersion };
}
function makeTimer(api: StudyApi, userId: string, localRef: string, journal: TimingJournal): StationStudyTimer {
  const key = prefix(api, userId) + localRef, tracker = bridge(api, key);
  const last = journal.lastCheckpoint;
  let previous = performance.now(), elapsedMs = last?.elapsedMs ?? 0;
  let activeMs = last?.activeMs ?? 0, unattendedMs = last?.unattendedMs ?? 0, offlineMs = last?.offlineMs ?? 0;
  let current: Exclude<TimingCheckpoint['phase'], 'ended'> = last && last.phase !== 'ended' ? last.phase : 'preflight';
  let ended = false, suspended = true, tick: number | undefined;
  let offline = navigator.onLine === false, hidden = document.visibilityState === 'hidden';
  // Only observable foreground/background windows are accumulated. Time while the
  // page is closed is unmeasured, not fabricated as attention or offline time.
  const sample = () => {
    const now = performance.now(), delta = suspended ? 0 : Math.max(0, now - previous);
    previous = now;
    elapsedMs += delta;
    if (offline) offlineMs += delta;
    if (current === 'upload' || current === 'finalization' || hidden) unattendedMs += delta;
    else activeMs += delta;
  };
  const checkpoint = (phase: TimingCheckpoint['phase'], outcome: TimingCheckpoint['outcome'] = 'pending', errorCode?: TimingCheckpoint['errorCode'], interaction?: StudyInteraction, options?: {once?:boolean;observedAt?:Date;uploadState?:TimingCheckpoint['uploadState']}) => {
    if(locallyWithdrawn.has(prefix(api,userId)))return;
    try { if (!localStorage.getItem(`packproof-study-consent:${prefix(api, userId)}`)) return; } catch { return; }
    sample();
    const elapsed = Math.min(86400000, Math.floor(elapsedMs)), active = Math.min(elapsed, Math.floor(activeMs));
    void tracker.checkpoint({ phase, outcome, elapsedMs: elapsed, activeMs: active,
      unattendedMs: Math.min(elapsed - active, Math.floor(unattendedMs)), offlineMs: Math.min(elapsed, Math.floor(offlineMs)),
      ...(errorCode ? { errorCode } : {}), ...(interaction ? { interaction } : {}),
      ...(journal.start.flowVersion===1?{clientOccurredAt:(options?.observedAt??new Date()).toISOString(),networkState:offline?'offline' as const:'online' as const}:{}),
      ...(options?.uploadState?{uploadState:options.uploadState}:{}),
    },options?.once).then(() => tracker.flush()).catch(() => { /* The durable journal remains retryable. */ });
  };
  const networkChanged = () => { sample(); offline = navigator.onLine === false; };
  const visibilityChanged = () => { sample(); hidden = document.visibilityState === 'hidden'; };
  const suspend = () => {
    if (ended || suspended) return;
    checkpoint(current);
    suspended = true;
    if (tick !== undefined) clearInterval(tick);
    window.removeEventListener('pagehide', suspend);
    window.removeEventListener('online', networkChanged);
    window.removeEventListener('offline', networkChanged);
    document.removeEventListener('visibilitychange', visibilityChanged);
  };
  const resume = () => {
    if (ended || !suspended) return;
    suspended = false; previous = performance.now();
    offline = navigator.onLine === false; hidden = document.visibilityState === 'hidden';
    tick = window.setInterval(() => checkpoint(current), 15000);
    window.addEventListener('pagehide', suspend);
    window.addEventListener('online', networkChanged);
    window.addEventListener('offline', networkChanged);
    document.addEventListener('visibilitychange', visibilityChanged);
  };
  const timer: StationStudyTimer = {
    localRef,
    phase: phase => { if (ended || phase === current) return; checkpoint(phase); current = phase; },
    event: (interaction,options) => { if (!ended) checkpoint(current, 'pending', options?.errorCode, interaction,options); },
    problem: errorCode => { if (!ended) checkpoint(current, 'pending', errorCode); },
    suspend,
    end: (outcome, errorCode) => {
      if (ended) return;
      suspend(); ended = true;
      checkpoint('ended', outcome, errorCode);
      liveTimers.delete(key);
      try{const selected=`packproof-study-selected:${prefix(api,userId)}`;if(localStorage.getItem(selected)===localRef)localStorage.removeItem(selected);}catch{/* Optional locator cleanup. */}
    },
  };
  liveTimers.set(key, { timer, resume, datasetRef: journal.start.datasetRef });
  resume();
  return timer;
}
/** Begins before order lookup/camera preparation, after an explicit account-scoped
 * study opt-in. Capture content and domain identifiers never enter the journal. */
export async function startStationStudy(api: StudyApi, userId: string, taskKind: TimingStart['taskKind'] = 'packproof', context:TimingContext={}, observedAt=new Date()): Promise<StationStudyTimer | null> {
  try {
    const allowed = await consent(api, userId); if (!allowed) return null;
    const localRef = randomId(), key = prefix(api, userId) + localRef, tracker = bridge(api, key);
    const buildSha = validBuildSha();
    if (!await tracker.start({ datasetRef: allowed.datasetRef, taskKind, deviceClass: context.platform==='desktop'?'unknown':'web', channel: 'unknown', ...(buildSha ? { buildSha } : {}),...context }, allowed,observedAt)) return null;
    const row = await storage<{ journal: TimingJournal }>('readonly', store => store.get(key));
    const timer = makeTimer(api, userId, localRef, row.journal);
    void tracker.flush().catch(() => {});
    return timer;
  } catch { return null; }
}
/** Resumes only an existing consented journal. The reference remains on-device and
 * is scoped to the authenticated user and API; missing journals do not create tasks. */
export async function resumeStationStudy(api: StudyApi, userId: string, localRef: string | undefined): Promise<StationStudyTimer | null> {
  try {
    if (!localRef || !localRefPattern.test(localRef)) return null;
    const allowed = await consent(api, userId); if (!allowed) return null;
    const key = prefix(api, userId) + localRef;
    const live = liveTimers.get(key);
    if (live) {
      if (live.datasetRef !== allowed.datasetRef) { live.timer.suspend(); return null; }
      live.resume(); return live.timer;
    }
    const row = await storage<{ journal: TimingJournal } | undefined>('readonly', store => store.get(key));
    if (!row || row.journal.ended || row.journal.start.datasetRef !== allowed.datasetRef) return null;
    return makeTimer(api, userId, localRef, row.journal);
  } catch { return null; }
}
/** Standalone UI actions never inflate the packing-task effort denominator. Call
 * only after the operation succeeded, with the current authenticated identity. */
export async function recordStudyInteraction(api: StudyApi, userId: string, interaction: StudyInteraction): Promise<void> {
  const at=new Date();const firstEvent=['entry_viewed','help_opened','hint_dismissed','recovery_action'].includes(interaction);
  const timer = await startStationStudy(api, userId, 'interface_action',firstEvent?firstExperienceContext(interaction==='help_opened'?'help':'home'):{},at);
  timer?.phase('confirmation'); timer?.event(interaction,{observedAt:at}); timer?.end('succeeded');
}

function firstExperienceContext(entrySource:EntrySource):TimingContext {
  const version=import.meta.env.VITE_PACKPROOF_WEB_VERSION;
  return {flowVersion:1,platform:'web',entrySource,...(typeof version==='string'&&/^[0-9][a-zA-Z0-9._-]{0,63}$/.test(version)?{appVersion:version}:{})};
}
const selectedTasks=new Map<string,Promise<StationStudyTimer|null>>();
/** Capture the choice timestamp synchronously. Work proceeds without waiting for
 * consent lookup or telemetry storage; only an existing explicit grant is used. */
export function selectFirstProofStudy(api:StudyApi,userId:string,source:EntrySource,observedAt=new Date(),context:TimingContext={}):Promise<StationStudyTimer|null> {
  const scope=prefix(api,userId),pending=selectedTasks.get(scope);if(pending)return pending;
  const task=(async()=>{
    try {
      const saved=localStorage.getItem(`packproof-study-selected:${scope}`);
      if(saved){const resumed=await resumeStationStudy(api,userId,saved);if(resumed)return resumed;}
      const timer=await startStationStudy(api,userId,'packproof',{...firstExperienceContext(source),...context},observedAt);
      if(timer){timer.event('start_selected',{once:true,observedAt});try{localStorage.setItem(`packproof-study-selected:${scope}`,timer.localRef);}catch{/* Optional resume pointer must not suppress the observed choice. */}}
      return timer;
    }catch{return null;}
  })().finally(()=>selectedTasks.delete(scope));selectedTasks.set(scope,task);return task;
}
/** Direct task links choose a task too; a prior manual choice keeps its original
 * start instead of being replaced by camera-route entry. */
export function firstProofStudyForCapture(api:StudyApi,userId:string){return selectFirstProofStudy(api,userId,'deep_link');}
export function pauseStudyAccount(api:StudyApi,userId:string){for(const [key,live]of liveTimers)if(key.startsWith(prefix(api,userId)))live.timer.suspend();}

/** Retain only the bounded lifecycle of an already consented reauthentication.
 * Credential fields never enter this local buffer or the study API. */
export function retainStudyAuth(api:StudyApi,userId:string,name:'auth_started'|'auth_failed',observedAt=new Date()) {
  try {
    if(locallyWithdrawn.has(prefix(api,userId)))return;
    const allowed=JSON.parse(localStorage.getItem(`packproof-study-consent:${prefix(api,userId)}`)||'null');
    if(!allowed?.granted||allowed.statementVersion!=='capture-timing-study-v1')return;
    const key=`packproof-study-auth:${prefix(api,userId)}`,previous=JSON.parse(localStorage.getItem(key)||'null');
    const value=previous?.datasetRef===allowed.datasetRef&&!previous.transferred?previous:{datasetRef:allowed.datasetRef,localRef:randomId(),events:[]};
    if(!value.events.some((row:{name:string})=>row.name===name))value.events.push({name,at:observedAt.toISOString()});
    localStorage.setItem(key,JSON.stringify(value));
  }catch{/* Measurement never blocks sign-in. */}
}
const authCompletions=new Map<string,Promise<void>>();
export function completeStudyAuth(api:StudyApi,userId:string,observedAt=new Date()):Promise<void> {
 const key=prefix(api,userId),pending=authCompletions.get(key);if(pending)return pending;
 const task=completeStudyAuthOnce(api,userId,observedAt).finally(()=>authCompletions.delete(key));authCompletions.set(key,task);return task;
}
async function completeStudyAuthOnce(api:StudyApi,userId:string,observedAt:Date) {
  try {
    const bufferKey=`packproof-study-auth:${prefix(api,userId)}`,pending=JSON.parse(localStorage.getItem(bufferKey)||'null');
    const allowed=await consent(api,userId);
    if(!allowed||!pending||pending.datasetRef!==allowed.datasetRef||!localRefPattern.test(pending.localRef)||!Array.isArray(pending.events)||pending.events.length>2)return;
    const events=pending.events.filter((row:{name:string;at:string})=>['auth_started','auth_failed'].includes(row.name)&&/^\d{4}-\d{2}-\d{2}T/.test(row.at)&&Number.isFinite(Date.parse(row.at)));
    if(!events.length)return;
    const key=prefix(api,userId)+pending.localRef,tracker=bridge(api,key);
    let stored=await storage<{journal:TimingJournal}|undefined>('readonly',store=>store.get(key));
    if(!stored&&pending.transferred){localStorage.removeItem(bufferKey);return;}
    if(!stored){await tracker.start({datasetRef:allowed.datasetRef,taskKind:'interface_action',deviceClass:'web',channel:'unknown',...firstExperienceContext('auth')},allowed,new Date(events[0].at));stored=await storage('readonly',store=>store.get(key));}
    if(!pending.transferred){localStorage.setItem(bufferKey,JSON.stringify({...pending,transferred:true}));}
    if(!stored?.journal.ended){const timer=makeTimer(api,userId,pending.localRef,stored!.journal);for(const event of events)timer.event(event.name,{once:true,observedAt:new Date(event.at),...(event.name==='auth_failed'?{errorCode:'authentication'}:{})});timer.event('auth_completed',{once:true,observedAt});timer.end('succeeded');}
    await tracker.flush();localStorage.removeItem(bufferKey);
  }catch{/* Retain original bounded operations for same-account retry. */}
}
