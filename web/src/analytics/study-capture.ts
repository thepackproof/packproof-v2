import type {PackProofApi} from '../api/client';
import {randomId} from '../random-id';
import {createConsentedTimingBridge,type TimingJournal,type TimingCheckpoint,type StudyConsent,type TimingStart} from './timing-bridge';
export type StudyStatus=Partial<StudyConsent>&{enabled:boolean;statement?:string;changedAt?:string|null};
const prefix=(api:PackProofApi,userId:string)=>`${api.recoveryScope}:${userId}:`;
export function rememberStudyStatus(api:PackProofApi,userId:string,status:StudyStatus){
  try{const key=`packproof-study-consent:${prefix(api,userId)}`;if(status.enabled&&status.granted&&status.datasetRef)localStorage.setItem(key,JSON.stringify({datasetRef:status.datasetRef,granted:true,statementVersion:status.statementVersion}));else { localStorage.removeItem(key); for (const [taskKey, live] of liveTimers) if (taskKey.startsWith(prefix(api, userId))) { live.timer.suspend(); liveTimers.delete(taskKey); } }}catch{/* Unavailable local storage leaves capture uninstrumented. */}
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
export type StudyInteraction = NonNullable<TimingCheckpoint['interaction']>;
export interface StationStudyTimer {
  /** Opaque, local-only journal locator; never include this in a study payload. */
  localRef: string;
  phase: (phase: Exclude<TimingCheckpoint['phase'], 'ended'>) => void;
  event: (interaction: StudyInteraction) => void;
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
async function consent(api: PackProofApi, userId: string): Promise<StudyConsent | null> {
  // An ordinary capture neither reads the remote study API nor installs listeners.
  const cached = localStorage.getItem(`packproof-study-consent:${prefix(api, userId)}`);
  if (!cached) return null;
  let status: StudyStatus = { ...JSON.parse(cached), enabled: true };
  if (navigator.onLine !== false) try { status = await api.studyRequest<StudyStatus>('/consent'); }
  catch { /* A cached explicit grant can retain an offline task; intake rechecks consent. */ }
  if (!status.enabled || !status.granted || !status.datasetRef || status.statementVersion !== 'capture-timing-study-v1') return null;
  return { datasetRef: status.datasetRef, granted: true, statementVersion: status.statementVersion };
}
function makeTimer(api: PackProofApi, userId: string, localRef: string, journal: TimingJournal): StationStudyTimer {
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
  const checkpoint = (phase: TimingCheckpoint['phase'], outcome: TimingCheckpoint['outcome'] = 'pending', errorCode?: TimingCheckpoint['errorCode'], interaction?: StudyInteraction) => {
    try { if (!localStorage.getItem(`packproof-study-consent:${prefix(api, userId)}`)) return; } catch { return; }
    sample();
    const elapsed = Math.min(86400000, Math.floor(elapsedMs)), active = Math.min(elapsed, Math.floor(activeMs));
    void tracker.checkpoint({ phase, outcome, elapsedMs: elapsed, activeMs: active,
      unattendedMs: Math.min(elapsed - active, Math.floor(unattendedMs)), offlineMs: Math.min(elapsed, Math.floor(offlineMs)),
      ...(errorCode ? { errorCode } : {}), ...(interaction ? { interaction } : {}),
    }).then(() => tracker.flush()).catch(() => { /* The durable journal remains retryable. */ });
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
    event: interaction => { if (!ended) checkpoint(current, 'pending', undefined, interaction); },
    problem: errorCode => { if (!ended) checkpoint(current, 'pending', errorCode); },
    suspend,
    end: (outcome, errorCode) => {
      if (ended) return;
      suspend(); ended = true;
      checkpoint('ended', outcome, errorCode);
      liveTimers.delete(key);
    },
  };
  liveTimers.set(key, { timer, resume, datasetRef: journal.start.datasetRef });
  resume();
  return timer;
}
/** Begins before order lookup/camera preparation, after an explicit account-scoped
 * study opt-in. Capture content and domain identifiers never enter the journal. */
export async function startStationStudy(api: PackProofApi, userId: string, taskKind: TimingStart['taskKind'] = 'packproof'): Promise<StationStudyTimer | null> {
  try {
    const allowed = await consent(api, userId); if (!allowed) return null;
    const localRef = randomId(), key = prefix(api, userId) + localRef, tracker = bridge(api, key);
    const buildSha = validBuildSha();
    if (!await tracker.start({ datasetRef: allowed.datasetRef, taskKind, deviceClass: 'web', channel: 'unknown', ...(buildSha ? { buildSha } : {}) }, allowed)) return null;
    const row = await storage<{ journal: TimingJournal }>('readonly', store => store.get(key));
    const timer = makeTimer(api, userId, localRef, row.journal);
    void tracker.flush().catch(() => {});
    return timer;
  } catch { return null; }
}
/** Resumes only an existing consented journal. The reference remains on-device and
 * is scoped to the authenticated user and API; missing journals do not create tasks. */
export async function resumeStationStudy(api: PackProofApi, userId: string, localRef: string | undefined): Promise<StationStudyTimer | null> {
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
export async function recordStudyInteraction(api: PackProofApi, userId: string, interaction: StudyInteraction): Promise<void> {
  const timer = await startStationStudy(api, userId, 'interface_action');
  timer?.phase('confirmation'); timer?.event(interaction); timer?.end('succeeded');
}
