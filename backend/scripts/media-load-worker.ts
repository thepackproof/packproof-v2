import cp from 'node:child_process';
import {syncBuiltinESMExports} from 'node:module';
import {promisify} from 'node:util';
import {createReadStream} from 'node:fs';
import {readFile,writeFile} from 'node:fs/promises';
import {Readable,Transform} from 'node:stream';
import path from 'node:path';
import type {Database,QueryResult} from '../src/db/database.js';

// Observe real parser/render subprocess exits, including processes shorter than
// one RSS sampling interval. Instrumentation changes no renderer arguments.
const original=cp.execFile;
const observed=(...args:unknown[])=>{
  const child=(original as (...args:unknown[])=>ReturnType<typeof cp.execFile>)(...args);
  process.send?.({type:'subprocess',event:'started',pid:child.pid,command:path.basename(String(args[0]))});
  child.on('exit',(code,signal)=>process.send?.({type:'subprocess',event:'exited',pid:child.pid,code,signal}));
  return child;
};
Object.defineProperty(observed,promisify.custom,{value:(...args:unknown[])=>{
  let child:ReturnType<typeof cp.execFile>;
  const promise=new Promise((resolve,reject)=>{child=observed(...args,(error:Error|null,stdout:string,stderr:string)=>{if(error){Object.assign(error,{stdout,stderr});reject(error);}else resolve({stdout,stderr});});});
  return Object.assign(promise,{child:child!});
}});
(cp as unknown as {execFile:unknown}).execFile=observed;syncBuiltinESMExports();

const [{createServerApp},{BearerUserAdapter},{LocalObjectStore},{insertUser},{createTransaction},{createOrGetProof},{createCaptureSession,completeCaptureSession},{initializeEvidenceUpload,commitEvidence,readCommittedEvidenceStream},{createSignatureSnapshot,buildSignatureCase},{queueRecipientExport,processRecipientExport,getRecipientExport},{RECIPIENT_PROFILES},{sha256HexFromStream}]=await Promise.all([
  import('../src/server-app.js'),import('../src/auth/adapter.js'),import('../src/s3/local-object-store.js'),import('../src/domain/users.js'),import('../src/domain/transactions.js'),import('../src/domain/create-proof.js'),import('../src/domain/capture-sessions.js'),import('../src/domain/evidence.js'),import('../src/domain/signature.js'),import('../src/domain/recipient-exports.js'),import('../src/export/recipient-profiles.js'),import('../src/hash.js'),
]);
let next=0;const pending=new Map<number,{resolve:(value:any)=>void;reject:(error:Error)=>void}>();
function rpc(method:string,payload:Record<string,unknown>={}){const id=++next;return new Promise<any>((resolve,reject)=>{pending.set(id,{resolve,reject});process.send?.({type:'db',clientId:process.pid,id,method,...payload});});}
function database(transactionId?:string):Database{return {query:<T>(sql:string,params:unknown[]=[])=>rpc('query',{sql,params,transactionId}) as Promise<QueryResult<T>>,transaction:async fn=>{if(transactionId)return fn(database(transactionId));const begun=await rpc('begin');try{const value=await fn(database(begun.transactionId));await rpc('commit',{transactionId:begun.transactionId});return value;}catch(error){await rpc('rollback',{transactionId:begun.transactionId});throw error;}}};}
const db=database(),directory=process.argv[2];let clockDate=new Date('2026-09-07T12:00:00Z');const clock={now:()=>new Date(clockDate)};
const store=new LocalObjectStore(path.join(directory,'objects'),'http://127.0.0.1:9','synthetic-load-fixture');
let measurement=false,storageReadBytes=0,largestSourceChunk=0;const getStream=store.getStream.bind(store);
store.getStream=async(key,input={})=>{
  const result=await getStream(key,input);if(!result)return result;
  const source=result.body,body=new Transform({highWaterMark:65536,transform(chunk,_encoding,callback){if(measurement){storageReadBytes+=chunk.length;largestSourceChunk=Math.max(largestSourceChunk,chunk.length);}callback(null,chunk);}});
  source.on('error',error=>body.destroy(error));body.on('close',()=>source.destroy());source.pipe(body);return {...result,body};
};
// Buffering a full original is a hard harness failure, including in exporter code.
const get=store.get.bind(store);store.get=async(key,reference)=>{if(key.includes('/committed/'))throw new Error('Whole original buffering is forbidden by the load harness');return get(key,reference);};
const app=createServerApp({db,clock,objectStore:store,auth:new BearerUserAdapter(db),publicBaseUrl:'http://127.0.0.1:9',devAuth:true});
const server=app.listen(0,'127.0.0.1');await new Promise<void>(resolve=>server.once('listening',resolve));
const address=server.address() as {port:number},baseUrl=`http://127.0.0.1:${address.port}`;
type PendingEvidence={proofId:string;evidenceId:string;actor:string};
type Scenario={actor:string;playback:PendingEvidence;commits:PendingEvidence[];caseId:string;exportIds:string[];fixtureBytes:number;fixtureSha256:string;recoveryId?:string};
let scenario:Scenario|undefined;
const command=async(name:string,input:any)=>{
  if(name==='setup'){
    const fixture=path.join(directory,'fixture-100MB.mp4'),digest=await sha256HexFromStream(createReadStream(fixture));
    const actor=await insertUser(db,clock);const setup=async(key:string)=>{
      const transaction=await createTransaction(db,clock,actor,{itemTitle:'Synthetic media resource fixture',quantity:1});
      const proof=await createOrGetProof(db,clock,actor,transaction.transactionId);
      const capture=await createCaptureSession(db,clock,actor,proof.proofId,{client:'NATIVE_CAMERA',idempotencyKey:key});
      await completeCaptureSession(db,clock,actor,proof.proofId,capture.id,{sha256:digest.sha256,byteSize:digest.byteSize,contentType:'video/mp4'});
      const upload=await initializeEvidenceUpload(db,clock,store,actor,proof.proofId,{captureSessionId:capture.id,contentType:'video/mp4',evidenceType:'FULFILLMENT_CAPTURE',idempotencyKey:key});
      await store.putStream!(upload.objectKey,createReadStream(fixture),'video/mp4',digest.byteSize);
      return {actor,proofId:proof.proofId,evidenceId:upload.evidenceId};
    };
    const playback=await setup('existing-playback-source');await commitEvidence(db,clock,store,actor,playback.proofId,playback.evidenceId,digest.sha256);
    const snapshot=await createSignatureSnapshot(db,clock,actor,playback.proofId),packet=await buildSignatureCase(db,clock,actor,playback.proofId,{snapshotId:snapshot.snapshotId,template:'WRONG_ITEM',scope:{fields:['status','order','shipping','evidence','statements'],evidenceIds:[playback.evidenceId]}});
    scenario={actor,playback,commits:[await setup('concurrent-commit-one'),await setup('concurrent-commit-two')],caseId:packet.caseId,exportIds:[],fixtureBytes:digest.byteSize,fixtureSha256:digest.sha256};
    scenario.exportIds=[await enqueue('load-one'),await enqueue('load-two')];
    await writeFile(path.join(directory,'scenario.json'),JSON.stringify(scenario),{mode:0o600});return {scenario,baseUrl};
  }
  if(name==='range'){
    const before=storageReadBytes;measurement=true;largestSourceChunk=0;
    const source=await readCommittedEvidenceStream(db,store,scenario!.actor,scenario!.playback.proofId,scenario!.playback.evidenceId,'bytes=1048576-2097151');
    let bytes=0;for await(const chunk of source.body!)bytes+=chunk.length;
    measurement=false;return {requestedBytes:1048576,returnedBytes:bytes,storageReadBytes:storageReadBytes-before,largestSourceChunk,status:source.status,contentRange:source.headers['Content-Range']};
  }
  if(name==='start-measurement'){measurement=true;storageReadBytes=0;largestSourceChunk=0;return {};}
  if(name==='export'){const result=await processRecipientExport(db,clock,store);return result;}
  if(name==='state'){return {exports:await Promise.all(scenario!.exportIds.map(id=>getRecipientExport(db,scenario!.actor,scenario!.playback.proofId,id))),commits:(await db.query('SELECT id,validation_status,sha256,byte_size FROM evidence WHERE id=ANY($1::text[])',[scenario!.commits.map(row=>row.evidenceId)])).rows,storageReadBytes,largestSourceChunk};}
  if(name==='queue-recovery'){scenario!.recoveryId=await enqueue('post-load-recovery');await writeFile(path.join(directory,'scenario.json'),JSON.stringify(scenario),{mode:0o600});return {jobId:scenario!.recoveryId};}
  if(name==='recover'){clockDate=new Date('2026-09-07T12:11:00Z');const result=await processRecipientExport(db,clock,store);const job=await getRecipientExport(db,scenario!.actor,scenario!.playback.proofId,scenario!.recoveryId!);const row=(await db.query('SELECT state,attempts,lease_token,lease_until FROM recipient_export_jobs WHERE id=$1',[scenario!.recoveryId])).rows[0];return {result,state:job.state,...row};}
  if(name==='resume'){scenario=JSON.parse(await readFile(path.join(directory,'scenario.json'),'utf8'));return {baseUrl};}
  if(name==='stop'){server.close();setTimeout(()=>process.exit(0),50);return {};}
  throw new Error(`Unknown load command ${name}`);
};
async function enqueue(key:string){const s=scenario!;const job=await queueRecipientExport(db,clock,s.actor,s.playback.proofId,{caseId:s.caseId,profileId:RECIPIENT_PROFILES.find(profile=>profile.destination==='STRIPE_DISPUTE')!.id,idempotencyKey:key,destinationInstructionsReviewed:true,destinationDeadline:'2026-09-12T12:00:00Z',narrative:'Synthetic load recording; no real shipment or dispute.',frames:[1000,9000,18000,30000].map((offsetMs,i)=>({evidenceId:s.playback.evidenceId,offsetMs,label:`Synthetic full frame ${i+1}`}))});return job.jobId;}
process.on('message',(m:any)=>{
  if(m.type==='db-result'){const p=pending.get(m.id);if(!p)return;pending.delete(m.id);m.error?p.reject(Object.assign(new Error(m.error.message),{code:m.error.code})):p.resolve(m.result);return;}
  if(m.type==='command')void command(m.name,m.input).then(result=>process.send?.({type:'command-result',id:m.id,result}),error=>process.send?.({type:'command-result',id:m.id,error:{message:String(error?.message),code:error?.code,stack:error?.stack}}));
});
const processStatus=await readFile('/proc/self/status','utf8');
process.send?.({type:'ready',baseUrl,hostPid:Number(/^Pid:\s+(\d+)/m.exec(processStatus)?.[1])});
