import { IdentifierJournal } from '../../../backend/src/identifiers/journal';
import type { IdentifierJournalState, IdentifierPolicy, IdentifierReview } from '../../../backend/src/identifiers/types';
import type { PackProofApi } from '../api/client';
import { randomId } from '../random-id';

type Checkpoint = Parameters<PackProofApi['checkpointCaptureIdentifiers']>[2];
const keyFor = (apiScope:string,userId:string,proofId:string,sessionId:string) => JSON.stringify([apiScope,userId,proofId,sessionId]);
const live = new Map<string,IdentifierJournal>();
const liveApis = new Map<string,PackProofApi>();
const initializing = new Map<string,{api:PackProofApi;promise:Promise<IdentifierJournal>}>();
function open():Promise<IDBDatabase> {
  return new Promise((resolve,reject)=>{
    const request=indexedDB.open('packproof-identifiers',1);
    request.onupgradeneeded=()=>{request.result.createObjectStore('journals');request.result.createObjectStore('checkpoints');};
    request.onsuccess=()=>resolve(request.result);
    request.onerror=()=>reject(new Error('Item recognition could not be saved locally.'));
  });
}
async function storage<T>(store:'journals'|'checkpoints',key:string,value?:T):Promise<T|undefined> {
  const db=await open();
  try { return await new Promise((resolve,reject)=>{
    const transaction=db.transaction(store,value===undefined?'readonly':'readwrite');
    const request=value===undefined?transaction.objectStore(store).get(key):transaction.objectStore(store).put(value,key);
    transaction.oncomplete=()=>resolve(value===undefined?request.result:value);
    transaction.onerror=transaction.onabort=()=>reject(new Error('Item recognition could not be saved locally.'));
  }); } finally { db.close(); }
}
export async function browserIdentifierJournal(api:PackProofApi,userId:string,proofId:string,sessionId:string,policy:IdentifierPolicy,assertScope:()=>void):Promise<IdentifierJournal> {
  const key=keyFor(api.recoveryScope,userId,proofId,sessionId);
  assertScope();
  const running=live.get(key); if(running&&liveApis.get(key)===api) return running;
  const creating=initializing.get(key);if(creating?.api===api)return creating.promise;
  const promise=initializeBrowserIdentifierJournal(api,userId,proofId,sessionId,policy,assertScope,key);
  initializing.set(key,{api,promise});
  try {return await promise;}finally {if(initializing.get(key)?.promise===promise)initializing.delete(key);}
}
async function initializeBrowserIdentifierJournal(api:PackProofApi,userId:string,proofId:string,sessionId:string,policy:IdentifierPolicy,assertScope:()=>void,key:string):Promise<IdentifierJournal> {
  const existing=await storage<IdentifierJournalState>('journals',key); assertScope();
  if(existing&&(existing.apiScope!==api.recoveryScope||existing.userId!==userId||existing.proofId!==proofId||existing.sessionId!==sessionId))
    throw Object.assign(new Error('Open the original account and order to recover this recording.'),{code:'ACCOUNT_CHANGED'});
  const state:IdentifierJournalState=existing??{schemaVersion:1,apiScope:api.recoveryScope,userId,proofId,sessionId,policy,events:[],acknowledgedEventIds:[],omittedEvents:0,coverage:'COMPLETE',review:null,checkpointEventId:null};
  if(!existing) await storage('journals',key,state);
  const journal=new IdentifierJournal(state,{
    persist:async current=>{assertScope();await storage('journals',key,current);assertScope();},
    send:async events=>{assertScope();const review=await api.appendCaptureIdentifiers(proofId,sessionId,events);assertScope();return review;},
    makeId:randomId,assertScope,
  });
  if(initializing.get(key)?.api===api){live.set(key,journal);liveApis.set(key,api);} return journal;
}
export async function readBrowserIdentifierState(api:PackProofApi,userId:string,proofId:string,sessionId:string) {
  const key=keyFor(api.recoveryScope,userId,proofId,sessionId);
  return live.get(key)?.snapshot()??await storage<IdentifierJournalState>('journals',key);
}
export async function flushBrowserIdentifiers(api:PackProofApi,userId:string,proofId:string,sessionId:string,policy:IdentifierPolicy,assertScope:()=>void):Promise<{review:IdentifierReview|null;state:IdentifierJournalState|null}> {
  if(!policy.captureEnabled) return {review:null,state:null};
  let state:IdentifierJournalState|null=null;
  try {
    const journal=await browserIdentifierJournal(api,userId,proofId,sessionId,policy,assertScope);
    const review=await journal.flush(); assertScope(); state=journal.snapshot();
    return {review,state};
  } catch(error) {
    assertScope();
    const code=String((error as {code?:string}).code??'');
    if([401,403,409].includes((error as {status?:number}).status??0)||/ACCOUNT|AUTH|FORBIDDEN|CONFLICT|REVIEW_REQUIRED|SCOPE|INTEGRITY|IDEMPOTENCY|STALE/.test(code)) throw error;
    return {review:null,state};
  }
}
/** Called by the existing completion coordinator, before its declaration/finalize commands. */
export async function checkpointBrowserIdentifiers(api:PackProofApi,userId:string,proofId:string,sessionId:string,policy:IdentifierPolicy,assertScope:()=>void,onShipping:(scan:{rawValue:string;format:string;detectedAtMs:number;idempotencyKey:string})=>Promise<void>):Promise<IdentifierReview|null> {
  if(!policy.captureEnabled) return null;
  const {state}=await flushBrowserIdentifiers(api,userId,proofId,sessionId,policy,assertScope);
  let review:IdentifierReview;
  try {review=await api.getCaptureIdentifiers(proofId,sessionId);assertScope();}
  catch(error) {
    assertScope();
    if(state?.review?.reviewRequired)throw Object.assign(new Error('Review the item code before submitting.'),{code:'IDENTIFIER_REVIEW_REQUIRED',status:409});
    const status=(error as {status?:number}).status;
    if(status!==undefined&&status<500&&![404,408,429].includes(status))throw error;
    // The server's attestation/finalization barrier records UNAVAILABLE/PARTIAL
    // coverage under the same session locks and still refuses known conflicts.
    return null;
  }
  for(const row of review.observations) {
    if(row.route!=='SHIPPING'||row.supplemental)continue;
    await onShipping({rawValue:row.observation.rawText,format:row.observation.symbology,detectedAtMs:row.observation.mediaTimeMs,idempotencyKey:`identifier:${row.clientEventId}`}); assertScope();
  }
  if(review.reviewRequired)throw Object.assign(new Error('Review the item code seen in this recording before submitting.'),{code:'IDENTIFIER_REVIEW_REQUIRED',status:409});
  const accepted=new Set(review.acceptedEventIds);
  const missing=state?.events.some(event=>!accepted.has(event.clientEventId))??false;
  const coverage=!state?'UNAVAILABLE':missing||state.omittedEvents>0||state.coverage!=='COMPLETE'?'PARTIAL':'COMPLETE';
  const key=keyFor(api.recoveryScope,userId,proofId,sessionId);
  const fields={revision:review.revision,lastSequence:state?.events.at(-1)?.sequence??review.acknowledgedSequence,coverage,omittedEvents:state?.omittedEvents??0} as const;
  let prior:Checkpoint|undefined;
  try {prior=await storage<Checkpoint>('checkpoints',key);}catch{/* Optional local enrichment storage may be unavailable. */}
  // The first checkpoint is immutable. Later observations are supplemental,
  // including when the original checkpoint response was lost.
  if(review.checkpoint) return review;
  const request:Checkpoint=prior&&Object.entries(fields).every(([name,value])=>prior![name as keyof Checkpoint]===value)?prior:{clientEventId:randomId(),...fields};
  // A lost response reuses this exact checkpoint body on recovery.
  try { await storage('checkpoints',key,request); } catch { return null; }
  assertScope();
  try {const result=await api.checkpointCaptureIdentifiers(proofId,sessionId,request);assertScope();return result;}
  catch(error) {
    assertScope();const status=(error as {status?:number}).status;
    if(status!==undefined&&status<500&&![404,408,429].includes(status))throw error;
    return null;
  }
}
export function releaseBrowserIdentifierJournal(api:PackProofApi,userId:string,proofId:string,sessionId:string) { const key=keyFor(api.recoveryScope,userId,proofId,sessionId);live.delete(key);liveApis.delete(key); }

/** The existing account-scoped recovery worker also reconciles late, supplemental observations. */
export async function resumeBrowserIdentifierJournals(api:PackProofApi,userId:string,assertScope:()=>void) {
  assertScope();const db=await open();let states:IdentifierJournalState[];
  try { states=await new Promise((resolve,reject)=>{
    const tx=db.transaction('journals','readonly'),request=tx.objectStore('journals').getAll();
    tx.oncomplete=()=>resolve(request.result);tx.onerror=()=>reject(tx.error);
  }); } finally {db.close();}
  for(const state of states.filter(row=>row.apiScope===api.recoveryScope&&row.userId===userId&&row.events.some(event=>!row.acknowledgedEventIds.includes(event.clientEventId))).slice(0,20)) {
    assertScope();
    if(state.events.every(event=>state.acknowledgedEventIds.includes(event.clientEventId)))continue;
    const journal=await browserIdentifierJournal(api,userId,state.proofId,state.sessionId,state.policy,assertScope);
    await journal.flush();assertScope();
  }
}
