import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createNativeStudyRuntime,type NativeStudyStorage} from '../src/analytics/native-study-core';
import type {PackProofV2Client} from '../src/v2-api';
const datasetRef='pr_'+'a'.repeat(32),attemptRef='pr_'+'b'.repeat(32);
const consent={enabled:true,granted:true,datasetRef,statementVersion:'capture-timing-study-v1'};
const drain=()=>new Promise<void>(resolve=>setTimeout(resolve,20));
function fixture(){
  const memory=new Map<string,string>(),requests:Array<{path:string;body:unknown}>=[];let userId='original-account',granted=true,networkFail=false;
  const storage:NativeStudyStorage={getItem:async key=>memory.get(key)??null,setItem:async(key,value)=>{memory.set(key,value);},removeItem:async key=>{memory.delete(key);},getAllKeys:async()=>[...memory.keys()]};
  const appState={currentState:'active',addEventListener:()=>({remove:()=>{}})};
  const api={apiBaseUrl:'https://api.example.test',studyRequest:async(path:string,_method:string,body:unknown)=>{requests.push({path,body});if(networkFail)throw new Error('offline');if(path==='/consent')return {...consent,granted};if(path==='/timings/start')return{attemptRef};return{};}} as unknown as PackProofV2Client;
  const runtime=createNativeStudyRuntime({storage,appState,newNonce:randomUUID});runtime.registerStudyAccountReader(()=>({userId,apiBaseUrl:api.apiBaseUrl}));
  return {api,runtime,memory,requests,storage,appState,switchAccount:()=>{userId='other-account';},withdraw:()=>{granted=false;},offline:()=>{networkFail=true;},online:()=>{networkFail=false;}};
}
test('native default capture sends no study requests and persists no task',async()=>{
  const f=fixture();try{assert.equal(await f.runtime.startNativeStudy(f.api,'original-account'),null);assert.equal(f.requests.length,0);assert.equal(f.memory.size,0);}finally{f.runtime.dispose();}
});
test('consented native task starts fully offline, retains failure operations and replays after recovery without raw identifiers',async()=>{
  const f=fixture();try{
    await f.runtime.rememberNativeStudyConsent(f.api,'original-account',consent,'a16_5g');f.offline();
    const timer=await f.runtime.startNativeStudy(f.api,'original-account');assert.ok(timer);timer.phase('recording');f.runtime.updateNativeStudyConnectivity(true);await drain();timer.phase('upload');timer.end('failed','network');await drain();
    const pending=[...f.memory.entries()].find(([key])=>key.includes(':task:'));assert.ok(pending);
    assert.equal(pending[1].includes('original-account'),false);assert.equal(pending[1].includes('api.example'),false);
    const data=JSON.parse(pending[1]);assert.equal(data.start.deviceClass,'a16_5g');assert.equal(data.lastCheckpoint.outcome,'failed');
    f.online();await f.runtime.flushNativeStudyTimings(f.api,'original-account');assert.equal([...f.memory.keys()].some(key=>key.includes(':task:')),false);
    const starts=f.requests.filter(item=>item.path==='/timings/start');assert.equal(starts.length,1);assert.deepEqual(starts[0].body,data.start);
  }finally{f.runtime.dispose();}
});
test('account switch fences native retries, and withdrawal removes only unsent study data',async()=>{
  const f=fixture();try{
    await f.runtime.rememberNativeStudyConsent(f.api,'original-account',consent);f.offline();const timer=await f.runtime.startNativeStudy(f.api,'original-account');assert.ok(timer);timer.end('failed','network');await drain();const before=f.requests.length;
    f.switchAccount();await f.runtime.flushNativeStudyTimings(f.api,'original-account');assert.equal(f.requests.length,before);assert.ok([...f.memory.keys()].some(key=>key.includes(':task:')));
  }finally{f.runtime.dispose();}
  const w=fixture();try{await w.runtime.rememberNativeStudyConsent(w.api,'original-account',consent);w.offline();const timer=await w.runtime.startNativeStudy(w.api,'original-account');assert.ok(timer);timer.end('failed','network');await drain();w.memory.set('unrelated-capture-original','keep');w.withdraw();w.online();await w.runtime.flushNativeStudyTimings(w.api,'original-account');assert.equal([...w.memory.keys()].some(key=>key.includes(':task:')),false);assert.equal(w.memory.get('unrelated-capture-original'),'keep');}finally{w.runtime.dispose();}
});
test('acknowledged progress keeps a local counter checkpoint for process recovery',async()=>{
  const f=fixture();try{await f.runtime.rememberNativeStudyConsent(f.api,'original-account',consent);const timer=await f.runtime.startNativeStudy(f.api,'original-account');assert.ok(timer);timer.phase('recording');await drain();const pending=[...f.memory.entries()].find(([key])=>key.includes(':task:'));assert.ok(pending);const journal=JSON.parse(pending[1]);assert.equal(journal.events.length,0);assert.equal(journal.lastCheckpoint.phase,'recording');timer.end('succeeded');await drain();}finally{f.runtime.dispose();}
});
