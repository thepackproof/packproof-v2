import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createConsentedTimingBridge,TIMING_INTERACTIONS,type TimingJournal} from '../src/analytics/timing-bridge';
const datasetRef='pr_'+'a'.repeat(32),attemptRef='pr_'+'b'.repeat(32);
function fixture(){
  let journal:TimingJournal|null=null,granted=false,current=true;const starts:unknown[]=[],appends:unknown[]=[];
  let loseStart=false,loseAppend=false;
  const bridge=createConsentedTimingBridge({current:()=>current,newNonce:randomUUID,store:{read:async()=>structuredClone(journal),write:async value=>{journal=structuredClone(value);},remove:async()=>{journal=null;}},api:{
    getConsent:async()=>({datasetRef,granted,statementVersion:'capture-timing-study-v1'}),
    start:async input=>{starts.push(input);if(loseStart){loseStart=false;throw new Error('lost start response');}return{attemptRef};},
    append:async input=>{appends.push(input);if(loseAppend){loseAppend=false;throw new Error('lost timing response');}}
  }});
  return {bridge,starts,appends,get journal(){return journal;},restore:(value:TimingJournal)=>{journal=value;},grant:()=>{granted=true;},withdraw:()=>{granted=false;},switchAccount:()=>{current=false;},loseStart:()=>{loseStart=true;},loseAppend:()=>{loseAppend=true;}};
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
  assert.equal(f.appends.length,248);assert.equal(f.journal!.lastCheckpoint!.elapsedMs,260);
  await f.bridge.checkpoint({...failed,elapsedMs:6000});await f.bridge.flush();
  assert.equal(f.appends.length,249);assert.equal(f.journal,null);
});

test('cached explicit consent retains offline starts but cannot bypass a live withdrawal',async()=>{
  const f=fixture();
  assert.equal(await f.bridge.start(start,{datasetRef,granted:true,statementVersion:'capture-timing-study-v1'}),true);
  await f.bridge.checkpoint(failed);assert.ok(f.journal);assert.equal(f.starts.length,0);
  await f.bridge.flush();assert.equal(f.journal,null);assert.equal(f.starts.length,0);assert.equal(f.appends.length,0);
});

const buildSha='ab'.repeat(20);
test('finite interactions and source build survive exact lost acknowledgement replay without private metadata',async()=>{
  const f=fixture();f.grant();await f.bridge.start({...start,buildSha,email:'private-start'} as typeof start);
  for(const interaction of TIMING_INTERACTIONS)await f.bridge.checkpoint({phase:'confirmation',outcome:'pending',elapsedMs:10,activeMs:10,offlineMs:0,unattendedMs:0,interaction,orderId:'private-order'} as Parameters<typeof f.bridge.checkpoint>[0]);
  const original=structuredClone(f.journal!);assert.equal(original.start.buildSha,buildSha);assert.deepEqual(original.events.map(event=>event.interaction),TIMING_INTERACTIONS);
  assert.equal(JSON.stringify(original).includes('private'),false);f.loseStart();await assert.rejects(f.bridge.flush(),/lost start/);assert.deepEqual(f.journal,original);
  f.loseAppend();await assert.rejects(f.bridge.flush(),/lost timing/);await f.bridge.flush();assert.deepEqual(f.starts[0],f.starts[1]);assert.deepEqual(f.appends[0],f.appends[1]);
});
test('build and interaction validation rejects private values and malformed source identifiers before persistence',async()=>{
  for(const buildSha of ['', 'short', 'a'.repeat(39), 'g'.repeat(40), 'A'.repeat(40), 42, null]){
    const f=fixture();f.grant();await assert.rejects(f.bridge.start({...start,buildSha} as typeof start),/INVALID_STUDY_START/);assert.equal(f.journal,null);
  }
  const f=fixture();f.grant();await f.bridge.start({...start,buildSha});
  for(const interaction of ['label:private-tracking', '', {}, null])await assert.rejects(f.bridge.checkpoint({...failed,interaction} as typeof failed),/INVALID_STUDY_TIMING/);
  assert.deepEqual(f.journal!.events,[]);
});
test('restored journal metadata is sanitized at the account boundary before retry',async()=>{
  const f=fixture();f.grant();await f.bridge.start({...start,buildSha});await f.bridge.checkpoint({...failed,interaction:'consent_failed'});
  const value=structuredClone(f.journal!) as TimingJournal&{privateId?:string};value.privateId='private-root';Object.assign(value.start,{email:'private-email'});Object.assign(value.events[0],{barcode:'private-barcode'});f.restore(value);
  f.loseAppend();await assert.rejects(f.bridge.flush(),/lost timing/);
  assert.equal(JSON.stringify({journal:f.journal,starts:f.starts,appends:f.appends}).includes('private-'),false);
});
test('interactions are absent before consent and queued events are discarded on withdrawal',async()=>{
  const f=fixture();await f.bridge.checkpoint({...failed,interaction:'consent_failed'});assert.equal(f.journal,null);
  f.grant();await f.bridge.start({...start,buildSha});await f.bridge.checkpoint({...failed,interaction:'consent_cancelled'});f.withdraw();await f.bridge.flush();
  assert.equal(f.journal,null);assert.equal(f.starts.length,0);assert.equal(f.appends.length,0);
});

test('separate interface actions preserve their explicit task kind across retries',async()=>{
  const f=fixture();f.grant();await f.bridge.start({...start,taskKind:'interface_action',buildSha});await f.bridge.checkpoint({...failed,outcome:'succeeded',interaction:'share_created'});await f.bridge.flush();
  assert.equal((f.starts[0] as {taskKind:string}).taskKind,'interface_action');assert.equal((f.appends[0] as {interaction:string}).interaction,'share_created');
});
