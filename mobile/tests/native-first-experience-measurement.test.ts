import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {captureMeasurement,measuredUploadState} from '../src/analytics/capture-measurement';
import {createNativeStudyRuntime,type NativeStudyStorage,type NativeStudyTimer} from '../src/analytics/native-study-core';
import type {PackProofV2Client} from '../src/v2-api';
const datasetRef='pr_'+'a'.repeat(32),attemptRef='pr_'+'b'.repeat(32);
const consent={enabled:true,granted:true,datasetRef,statementVersion:'capture-timing-study-v1'};
const drain=()=>new Promise<void>(resolve=>setTimeout(resolve,30));
function fixture(){
  const memory=new Map<string,string>(),requests:Array<{path:string;body:unknown}>=[];
  let account:string|null='original-account',online=false;
  const storage:NativeStudyStorage={getItem:async key=>memory.get(key)??null,setItem:async(key,value)=>{memory.set(key,value);},removeItem:async key=>{memory.delete(key);},getAllKeys:async()=>[...memory.keys()]};
  const appState={currentState:'active',addEventListener:()=>({remove:()=>{}})};
  const api={apiBaseUrl:'https://api.example.test',studyRequest:async(path:string,_method:string,body:unknown)=>{requests.push({path,body});if(!online)throw new Error('network');return path==='/consent'?consent:path==='/timings/start'?{attemptRef}:{};}} as unknown as PackProofV2Client;
  const make=()=>{const value=createNativeStudyRuntime({storage,appState,newNonce:randomUUID,platform:'android',appVersion:()=> '1.0.2',sourceBuildSha:()=> 'b'.repeat(40)});value.registerStudyAccountReader(()=>account?{userId:account,apiBaseUrl:api.apiBaseUrl}:null);return value;};
  const runtime=make();
  const journals=()=>[...memory.entries()].filter(([key])=>key.includes(':task:')).map(([,value])=>JSON.parse(value));
  return {runtime,api,memory,storage,requests,journals,restart:make,setAccount:(value:string|null)=>{account=value;},online:()=>{online=true;}};
}

test('entry, selection, help and reauthentication are silent without an existing explicit study grant',async()=>{
  const f=fixture();try{
    assert.equal(await f.runtime.beginNativeFirstProof(f.api,'original-account','manual'),null);
    await f.runtime.recordNativeStudyInteraction(f.api,'original-account','entry_viewed','home');
    await f.runtime.recordNativeStudyFlowEvent(f.api,'original-account','help_opened','sample');
    await f.runtime.retainNativeStudyAuth(f.api,'original-account','auth_started');
    assert.equal(f.memory.size,0);assert.equal(f.requests.length,0);
  }finally{f.runtime.dispose();}
});

test('one durable choice joins actual camera callbacks across retries and process recovery without domain IDs in requests',async()=>{
  const f=fixture();let resumed:ReturnType<typeof f.restart>|undefined;
  try{
    await f.runtime.rememberNativeStudyConsent(f.api,'original-account',consent);
    const chosenAt=new Date('2026-10-11T16:00:00.000Z');
    const first=await f.runtime.beginNativeFirstProof(f.api,'original-account','manual',undefined,chosenAt);assert.ok(first);
    assert.equal((await f.runtime.beginNativeFirstProof(f.api,'original-account','manual'))?.localRef,first.localRef);
    const capture=await f.runtime.nativeStudyForNewCapture(f.api,'original-account','private-proof-123');assert.equal(capture?.localRef,first.localRef);
    const callbacks=captureMeasurement(capture);callbacks.ready();callbacks.ready();callbacks.started();callbacks.interrupted();
    await callbacks.saved(async()=> 'durable-original');callbacks.authorized();callbacks.upload('queued');callbacks.upload('queued');
    await drain();first.suspend();await drain();f.runtime.dispose();resumed=f.restart();
    const recovered=await resumed.nativeStudyForCapture(f.api,'original-account',undefined,'private-proof-123');assert.ok(recovered);assert.equal(recovered.localRef,first.localRef);
    recovered.event('capture_ready',{once:true});recovered.event('upload_state_changed',{uploadState:'queued'});await drain();
    const journal=f.journals()[0],events=journal.events.filter((event:{interaction?:string})=>event.interaction);
    assert.equal(journal.start.clientStartedAt,chosenAt.toISOString());
    assert.equal(journal.start.entrySource,'manual');assert.equal(journal.start.platform,'android');assert.equal(journal.start.appVersion,'1.0.2');
    for(const name of ['start_selected','capture_ready','capture_started','capture_saved','capture_interrupted','submission_authorized'])assert.equal(events.filter((event:{interaction:string})=>event.interaction===name).length,1,name);
    assert.equal(events.filter((event:{interaction:string})=>event.interaction==='upload_state_changed').length,1);
    assert.equal(events.find((event:{interaction:string})=>event.interaction==='start_selected').clientOccurredAt,chosenAt.toISOString());
    f.online();await resumed.flushNativeStudyTimings(f.api,'original-account');
    const serialized=JSON.stringify(f.requests.map(request=>request.body));
    for(const forbidden of ['private-proof-123','original-account','api.example','token','media','trackingNumber'])assert.equal(serialized.includes(forbidden),false,forbidden);
  }finally{f.runtime.dispose();resumed?.dispose();}
});

test('camera observation never reports readiness on mount and saved requires successful persistence even if telemetry is delayed',async()=>{
  const events:Array<{name:string;at?:Date}>=[];let resolveTimer!:(timer:NativeStudyTimer)=>void;
  const pending=new Promise<NativeStudyTimer>(resolve=>{resolveTimer=resolve;});
  const callbacks=captureMeasurement(pending);assert.deepEqual(events,[]);
  callbacks.ready();const readyUpperBound=Date.now();
  await assert.rejects(callbacks.saved(async()=>{throw new Error('disk full');}));
  // Local media persistence resolves while the optional study store is stalled.
  assert.equal(await callbacks.saved(async()=> 'original saved'),'original saved');
  assert.deepEqual(events,[]);
  const timer={localRef:randomUUID(),event:(name:string,options?:{at?:Date})=>{events.push({name,at:options?.at});},phase:()=>{},suspend:()=>{},end:()=>{},sampleContext:()=>{},problem:()=>{}} as NativeStudyTimer;
  resolveTimer(timer);await drain();
  assert.deepEqual(events.map(event=>event.name),['capture_ready','capture_saved']);
  assert.ok(events[0].at!.getTime()<=readyUpperBound);
});

test('ended tasks restart with a new identity and account switches fence pending work',async()=>{
  const f=fixture();try{
    await f.runtime.rememberNativeStudyConsent(f.api,'original-account',consent);
    const first=await f.runtime.beginNativeFirstProof(f.api,'original-account');assert.ok(first);first.end('cancelled','cancelled');await drain();
    const next=await f.runtime.beginNativeFirstProof(f.api,'original-account');assert.ok(next);assert.notEqual(next.localRef,first.localRef);
    f.setAccount('other-account');const before=f.requests.length;
    next.event('capture_ready',{once:true});assert.equal(await f.runtime.nativeStudyForNewCapture(f.api,'original-account','proof-other'),null);await drain();
    assert.equal(f.requests.length,before);
  }finally{f.runtime.dispose();}
});

test('previously consented authentication retries flush only after the original account signs in',async()=>{
  const f=fixture();try{
    await f.runtime.rememberNativeStudyConsent(f.api,'original-account',consent);f.setAccount(null);
    const at=new Date('2026-10-11T15:00:00.000Z');
    await f.runtime.retainNativeStudyAuth(f.api,'original-account','auth_started',at);
    await f.runtime.retainNativeStudyAuth(f.api,'original-account','auth_failed',new Date(at.getTime()+1000));
    assert.equal(f.requests.length,0);
    f.setAccount('other-account');await f.runtime.completeNativeStudyAuth(f.api,'original-account');assert.equal(f.requests.length,0);
    f.setAccount('original-account');await f.runtime.completeNativeStudyAuth(f.api,'original-account',new Date(at.getTime()+2000));await drain();
    const journal=f.journals()[0];assert.equal(journal.start.entrySource,'auth');
    assert.deepEqual(journal.events.filter((event:{interaction?:string})=>event.interaction).map((event:{interaction:string})=>event.interaction),['auth_started','auth_failed','auth_completed']);
    assert.equal(journal.events[0].clientOccurredAt,at.toISOString());
  }finally{f.runtime.dispose();}
});

test('local withdrawal removes pending study data and keeps capture originals untouched',async()=>{
  const f=fixture();try{
    await f.runtime.rememberNativeStudyConsent(f.api,'original-account',consent);
    const timer=await f.runtime.beginNativeFirstProof(f.api,'original-account');assert.ok(timer);await drain();
    f.memory.set('capture:original','keep');await f.runtime.rememberNativeStudyConsent(f.api,'original-account',{granted:false});
    const before=f.requests.length;timer.event('capture_saved',{once:true});await drain();
    assert.equal(f.requests.length,before);assert.deepEqual([...f.memory.entries()],[['capture:original','keep']]);
  }finally{f.runtime.dispose();}
});

test('upload measurement maps persisted states and never treats an unsubmitted recording as queued',()=>{
  assert.equal(measuredUploadState('LOCAL_ONLY'),undefined);assert.equal(measuredUploadState('RECORDING'),undefined);
  assert.equal(measuredUploadState('UPLOAD_QUEUED'),'queued');assert.equal(measuredUploadState('UPLOAD_QUEUED',true),'retrying');
  assert.equal(measuredUploadState('BYTES_RECEIVED'),'committing');assert.equal(measuredUploadState('PRESERVATION_PENDING'),'waiting');
  assert.equal(measuredUploadState('FINALIZATION_PENDING'),'finalizing');assert.equal(measuredUploadState('FINALIZED'),'complete');
});
