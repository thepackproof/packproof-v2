import {readFile} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {afterAll,beforeAll,describe,expect,it} from 'vitest';
import {splitSqlStatements} from '../src/db/sql.js';
import {createPgliteDatabase} from '../src/db/pglite.js';
import type {Database} from '../src/db/database.js';
import {createProgramDataset,recordProgramConsent,startProgramTiming,appendProgramTiming,exportProgramObservations,STUDY_STATEMENT_VERSION,STUDY_INTERACTIONS} from '../src/analytics/observation-export.js';

// This suite exercises only study migrations/intake. Operational export reads
// have no fixture rows; their canonical preservation behavior has separate tests.
const config={key:'isolated-study-ui-instrumentation-test-key-32-bytes',keyVersion:'test-ui-v1'};
const clock={now:()=>new Date('2026-09-08T12:00:00.000Z')};
const buildSha='ab'.repeat(20);
let opened:Awaited<ReturnType<typeof createPgliteDatabase>>,db:Database;
beforeAll(async()=>{
  opened=await createPgliteDatabase();db=opened.db;
  await db.query("CREATE FUNCTION reject_audit_mutation() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'AUDIT_IMMUTABLE'; END; $$;");
  for(const file of ['045_program_observations.sql','053_study_ui_instrumentation.sql'])for(const statement of splitSqlStatements(await readFile(new URL(`../migrations/${file}`,import.meta.url),'utf8')))await db.query(statement);
});
afterAll(async()=>{await opened?.close();});
const consent=(datasetRef:string,decision:'grant'|'withdraw'='grant')=>({datasetRef,decision,operationNonce:randomUUID(),statementVersion:STUDY_STATEMENT_VERSION});
const start=(datasetRef:string)=>({datasetRef,taskKind:'packproof',deviceClass:'web',channel:'manual',operationNonce:randomUUID(),clientStartedAt:clock.now().toISOString(),buildSha});
const checkpoint=(datasetRef:string,attemptRef:string)=>({datasetRef,attemptRef,operationNonce:randomUUID(),phase:'confirmation',outcome:'pending',elapsedMs:10,activeMs:10,offlineMs:0,unattendedMs:0,interaction:'review_opened'});
const finish=(datasetRef:string,attemptRef:string)=>({...checkpoint(datasetRef,attemptRef),phase:'ended',outcome:'succeeded',interaction:'server_completed'});
async function fixture(granted=true){const {datasetRef}=await createProgramDataset(db,clock,config),userId=`private-user-${randomUUID()}`;if(granted)await recordProgramConsent(db,clock,config,userId,consent(datasetRef));return{datasetRef,userId};}
async function exported(datasetRef:string){
  const source:Database={transaction:db.transaction.bind(db),query:async<T>(sql:string,params?:unknown[])=>{
    if(sql.includes('FROM program_'))return db.query<T>(sql,params);
    return{rows:[] as T[],rowCount:0};
  }};
  const exportClock={now:()=>new Date(clock.now().getTime()+1000)};
  return exportProgramObservations(source,exportClock,config,{datasetRef,start:'2026-09-08T00:00:00.000Z',end:'2026-09-09T00:00:00.000Z',asOf:exportClock.now().toISOString()});
}

describe('bounded opt-in UI instrumentation',()=>{
  it('requires current explicit consent and rejects private, unknown, or malformed payload fields',async()=>{
    const f=await fixture(false);
    await expect(startProgramTiming(db,clock,config,f.userId,start(f.datasetRef))).rejects.toMatchObject({code:'STUDY_CONSENT_REQUIRED'});
    await recordProgramConsent(db,clock,config,f.userId,consent(f.datasetRef));
    for(const value of ['', 'short', 'a'.repeat(39), 'g'.repeat(40), 'A'.repeat(40), 42, null])await expect(startProgramTiming(db,clock,config,f.userId,{...start(f.datasetRef),buildSha:value})).rejects.toMatchObject({code:'INVALID_STUDY_REQUEST'});
    for(const value of [{orderId:'private-order'},{barcode:'private-barcode'},{interaction:'order_selected'},{context:{email:'private'}}])await expect(startProgramTiming(db,clock,config,f.userId,{...start(f.datasetRef),...value})).rejects.toMatchObject({code:'INVALID_STUDY_REQUEST'});
    const attempt=await startProgramTiming(db,clock,config,f.userId,start(f.datasetRef));
    for(const value of [{interaction:'label:private-barcode'},{interaction:null},{buildSha},{errorCode:'private-error'},{labelText:'private-label'},{proofId:'private-proof'},{authority:'server'}])await expect(appendProgramTiming(db,clock,config,f.userId,{...checkpoint(f.datasetRef,attempt.attemptRef),...value})).rejects.toMatchObject({code:'INVALID_STUDY_REQUEST'});
    expect((await db.query('SELECT * FROM program_timing_events WHERE dataset_ref=$1',[f.datasetRef])).rows).toHaveLength(1);
  });
  it('round-trips only finite interactions and inherited source builds, preserving timing/outcome authority',async()=>{
    const f=await fixture(),input=start(f.datasetRef),attempt=await startProgramTiming(db,clock,config,f.userId,input);
    for(const interaction of STUDY_INTERACTIONS)await appendProgramTiming(db,clock,config,f.userId,{...checkpoint(f.datasetRef,attempt.attemptRef),interaction});
    await appendProgramTiming(db,clock,config,f.userId,finish(f.datasetRef,attempt.attemptRef));
    const result=await exported(f.datasetRef);
    expect(result.timingObservations.slice(1,-1).map(event=>event.interaction)).toEqual(STUDY_INTERACTIONS);
    expect(result.timingObservations.every(event=>event.buildSha===buildSha&&event.authority==='client')).toBe(true);
    expect(result.timingObservations.at(-1)).toMatchObject({phase:'ended',outcome:'succeeded',interaction:'server_completed',elapsedMs:10,activeMs:10,offlineMs:0,unattendedMs:0});
    expect(result.events.every(event=>event.eventName==='capture.interaction'&&event.authority==='client')).toBe(true);
    const persisted=JSON.stringify((await db.query('SELECT * FROM program_timing_events WHERE dataset_ref=$1',[f.datasetRef])).rows);
    for(const value of [f.userId,input.operationNonce]){expect(persisted).not.toContain(value);expect(JSON.stringify(result)).not.toContain(value);}
  });
  it('replays lost acknowledgements exactly and scopes pseudonymous identities to account and dataset',async()=>{
    const f=await fixture(),input=start(f.datasetRef),attempt=await startProgramTiming(db,clock,config,f.userId,input);
    expect(await startProgramTiming(db,clock,config,f.userId,input)).toEqual(attempt);
    await expect(startProgramTiming(db,clock,config,f.userId,{...input,buildSha:'cd'.repeat(20)})).rejects.toMatchObject({code:'STUDY_OPERATION_CONFLICT'});
    const event=finish(f.datasetRef,attempt.attemptRef),first=await appendProgramTiming(db,clock,config,f.userId,event);
    expect(await appendProgramTiming(db,clock,config,f.userId,event)).toEqual(first);
    await expect(appendProgramTiming(db,clock,config,f.userId,{...event,interaction:'consent_cancelled'})).rejects.toMatchObject({code:'STUDY_OPERATION_CONFLICT'});
    const otherUser=randomUUID();await recordProgramConsent(db,clock,config,otherUser,consent(f.datasetRef));
    const otherAttempt=await startProgramTiming(db,clock,config,otherUser,input);expect(otherAttempt.attemptRef).not.toBe(attempt.attemptRef);
    const otherEvent=await appendProgramTiming(db,clock,config,otherUser,{...event,attemptRef:otherAttempt.attemptRef});expect(otherEvent.eventRef).not.toBe(first.eventRef);
    const second=await fixture();const secondAttempt=await startProgramTiming(db,clock,config,second.userId,{...input,datasetRef:second.datasetRef});expect(secondAttempt.attemptRef).not.toBe(attempt.attemptRef);
    expect((await db.query('SELECT * FROM program_timing_events WHERE attempt_ref=$1',[attempt.attemptRef])).rows).toHaveLength(2);
  });
  it('blocks queued UI events on withdrawal and rejects a previous interval after consent is granted again',async()=>{
    const f=await fixture(),attempt=await startProgramTiming(db,clock,config,f.userId,start(f.datasetRef)),event=finish(f.datasetRef,attempt.attemptRef);
    await recordProgramConsent(db,clock,config,f.userId,consent(f.datasetRef,'withdraw'));
    await expect(appendProgramTiming(db,clock,config,f.userId,event)).rejects.toMatchObject({code:'STUDY_CONSENT_REQUIRED'});
    await expect(startProgramTiming(db,clock,config,f.userId,start(f.datasetRef))).rejects.toMatchObject({code:'STUDY_CONSENT_REQUIRED'});
    await recordProgramConsent(db,clock,config,f.userId,consent(f.datasetRef));
    await expect(appendProgramTiming(db,clock,config,f.userId,event)).rejects.toMatchObject({code:'STUDY_CONSENT_INTERVAL_CHANGED'});
    await expect(startProgramTiming(db,clock,config,f.userId,{...start(f.datasetRef),clientStartedAt:'2026-09-08T11:59:59.000Z'})).rejects.toMatchObject({code:'INVALID_STUDY_REQUEST'});
    expect((await db.query('SELECT * FROM program_timing_events WHERE dataset_ref=$1',[f.datasetRef])).rows).toHaveLength(1);
  });
  it('keeps interface-action journals out of capture effort and unfinished capture denominators',async()=>{
    const f=await fixture();await startProgramTiming(db,clock,config,f.userId,start(f.datasetRef));
    const baseline=await startProgramTiming(db,clock,config,f.userId,{...start(f.datasetRef),taskKind:'ordinary_baseline'});await appendProgramTiming(db,clock,config,f.userId,finish(f.datasetRef,baseline.attemptRef));
    const shared=await startProgramTiming(db,clock,config,f.userId,{...start(f.datasetRef),taskKind:'interface_action'});await appendProgramTiming(db,clock,config,f.userId,{...finish(f.datasetRef,shared.attemptRef),interaction:'share_created'});
    await startProgramTiming(db,clock,config,f.userId,{...start(f.datasetRef),taskKind:'interface_action'});
    const result=await exported(f.datasetRef);expect(result.coverage).toMatchObject({clientTaskStarts:2,clientInterfaceActionStarts:2,clientTasksWithoutTerminalEvent:1});expect(result.observations.effortTasks).toHaveLength(2);
    expect(result.observations.effortTasks.some(task=>task.taskRef===shared.attemptRef)).toBe(false);
    expect(result.timingObservations.some(event=>event.taskKind==='interface_action'&&event.interaction==='share_created')).toBe(true);
  });
  it('retains compatibility with legacy timing clients that omit build and interaction',async()=>{
    const f=await fixture();const {buildSha:_build,...input}=start(f.datasetRef);const attempt=await startProgramTiming(db,clock,config,f.userId,input);
    const {interaction:_interaction,...event}=finish(f.datasetRef,attempt.attemptRef);await appendProgramTiming(db,clock,config,f.userId,event);
    const result=await exported(f.datasetRef);expect(result.timingObservations).toHaveLength(2);expect(result.timingObservations.every(value=>!('buildSha' in value)&&!('interaction' in value))).toBe(true);
    expect(result.observations.effortTasks[0]).toMatchObject({completed:true,packproofActiveSeconds:0.01});
  });
});
