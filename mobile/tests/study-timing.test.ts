import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createConsentedTimingBridge,type TimingJournal} from '../src/analytics/timing-bridge';
const datasetRef='pr_'+'a'.repeat(32),attemptRef='pr_'+'b'.repeat(32);
function fixture(){
  let journal:TimingJournal|null=null,granted=false,current=true;const starts:unknown[]=[],appends:unknown[]=[];
  let loseStart=false,loseAppend=false;
  const bridge=createConsentedTimingBridge({current:()=>current,newNonce:randomUUID,store:{read:async()=>structuredClone(journal),write:async value=>{journal=structuredClone(value);},remove:async()=>{journal=null;}},api:{
    getConsent:async()=>({datasetRef,granted,statementVersion:'capture-timing-study-v1'}),
    start:async input=>{starts.push(input);if(loseStart){loseStart=false;throw new Error('lost start response');}return{attemptRef};},
    append:async input=>{appends.push(input);if(loseAppend){loseAppend=false;throw new Error('lost timing response');}}
  }});
  return {bridge,starts,appends,get journal(){return journal;},grant:()=>{granted=true;},withdraw:()=>{granted=false;},switchAccount:()=>{current=false;},loseStart:()=>{loseStart=true;},loseAppend:()=>{loseAppend=true;}};
}
const start={datasetRef,taskKind:'packproof' as const,deviceClass:'web' as const,channel:'manual' as const};
const failed={phase:'ended' as const,outcome:'failed' as const,elapsedMs:5000,activeMs:500,unattendedMs:500,offlineMs:4000,errorCode:'network' as const};
test('no telemetry journal or writes before explicit consent',async()=>{const f=fixture();assert.equal(await f.bridge.start(start),false);assert.equal(f.journal,null);assert.equal(f.starts.length,0);});
test('offline failure and lost responses retain exactly the original timing intents',async()=>{
  const f=fixture();f.grant();await f.bridge.start(start);await f.bridge.checkpoint(failed);const original=structuredClone(f.journal);
  f.loseStart();await assert.rejects(f.bridge.flush(),/lost start/);assert.deepEqual(f.journal,original);
  f.loseAppend();await assert.rejects(f.bridge.flush(),/lost timing/);assert.equal(f.journal!.events.length,1);
  await f.bridge.flush();assert.deepEqual(f.starts[0],f.starts[1]);assert.deepEqual(f.appends[0],f.appends[1]);assert.equal(f.journal,null);
});
test('account changes prevent resumed writes and withdrawal discards only the timing journal',async()=>{
  const f=fixture();f.grant();await f.bridge.start(start);f.switchAccount();await assert.rejects(f.bridge.flush(),/ACCOUNT_CHANGED/);assert.equal(f.starts.length,0);assert.ok(f.journal);
  const withdrawn=fixture();withdrawn.grant();await withdrawn.bridge.start(start);withdrawn.withdraw();await withdrawn.bridge.flush();assert.equal(withdrawn.journal,null);assert.equal(withdrawn.starts.length,0);
});
test('extra metadata is never copied to disk and invalid timing field types reject',async()=>{
  const f=fixture();f.grant();await f.bridge.start({...start,email:'private'} as typeof start);await f.bridge.checkpoint({...failed,barcode:'private'} as typeof failed);
  assert.equal(JSON.stringify(f.journal).includes('private'),false);
  const invalid=fixture();invalid.grant();await invalid.bridge.start(start);await assert.rejects(invalid.bridge.checkpoint({...failed,activeMs:'private' as unknown as number}),/INVALID_STUDY_TIMING/);
});

test('long-running acknowledged progress reserves an end event within the lifetime intake limit',async()=>{
  const f=fixture();f.grant();await f.bridge.start(start);
  for(let elapsedMs=1;elapsedMs<=260;elapsedMs++){
    await f.bridge.checkpoint({phase:'confirmation',outcome:'pending',elapsedMs,activeMs:elapsedMs,offlineMs:0,unattendedMs:0});
    await f.bridge.flush();
  }
  assert.equal(f.appends.length,249);assert.equal(f.journal!.lastCheckpoint!.elapsedMs,260);
  await f.bridge.checkpoint({...failed,elapsedMs:6000});await f.bridge.flush();
  assert.equal(f.appends.length,250);assert.equal(f.journal,null);
});

test('cached explicit consent retains offline starts but cannot bypass a live withdrawal',async()=>{
  const f=fixture();
  assert.equal(await f.bridge.start(start,{datasetRef,granted:true,statementVersion:'capture-timing-study-v1'}),true);
  await f.bridge.checkpoint(failed);assert.ok(f.journal);assert.equal(f.starts.length,0);
  await f.bridge.flush();assert.equal(f.journal,null);assert.equal(f.starts.length,0);assert.equal(f.appends.length,0);
});
