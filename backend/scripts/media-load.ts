import {fork,execFile,type ChildProcess} from 'node:child_process';
import {promisify} from 'node:util';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import {mkdir,readFile,writeFile,open,stat,readdir} from 'node:fs/promises';
import {setTimeout as delay} from 'node:timers/promises';
const exec=promisify(execFile),here=path.dirname(fileURLToPath(import.meta.url)),repo=path.resolve(here,'../..');
const directory=path.resolve(process.argv[2]??path.join(repo,'.media-load-run'));
await mkdir(directory,{recursive:true});
const deployment=await readFile(path.join(repo,'infra/api-service.yaml'),'utf8');
const configuredMiB=Number(/Memory:\s*"([0-9]+)"/.exec(deployment)?.[1]);
if(configuredMiB!==1024)throw new Error('Review deployment memory changes before changing this acceptance target');
const configuredBytes=configuredMiB*1024*1024,thresholdBytes=configuredBytes*0.7;
let phase='fixture',api:ChildProcess|undefined,db:ChildProcess|undefined,commandId=0;
const workers=new Map<number,ChildProcess>(),commands=new Map<number,{resolve:(value:any)=>void;reject:(error:Error)=>void;pid:number}>();
const hostPids=new Map<number,number>();
const ready=new Map<number,{resolve:()=>void;reject:(error:Error)=>void}>(),children=new Map<number,{pid:number;command:string;phase:string}>(),exits:any[]=[];
const pendingDb=new Map<number,{resolve:(value:any)=>void;reject:(error:Error)=>void}>();let dbId=0;
let crashResolve:((value:unknown)=>void)|null=null;
const report:any={schema:'packproof.local-media-load.v1',startedAt:new Date().toISOString(),sourceCommit:(await exec('git',['rev-parse','HEAD'],{cwd:repo})).stdout.trim(),configuredMemory:{source:'infra/api-service.yaml:ExpressService.Properties.Memory',MiB:configuredMiB,bytes:configuredBytes,thresholdFraction:0.7,thresholdBytes,kernelEnforced:false},environment:{platform:process.platform,node:process.version,hostCgroupMemoryMax:(await readFile('/sys/fs/cgroup/memory.max','utf8')).trim(),hostCpuMax:(await readFile('/sys/fs/cgroup/cpu.max','utf8')).trim(),deploymentCpuUnits:256,database:'Separate PGlite process via transaction-preserving IPC; excluded from API memory as external RDS is in deployment',objectStore:'LocalObjectStore exact-version filesystem implementation',auth:'Synthetic local BearerUserAdapter accounts',isolationLimitations:['Shared host cgroup is read-only: deployment 1 GiB kernel limit and 0.25-vCPU quota cannot be installed here.','Observer samples API + all observed media subprocess RSS every 20 ms; short-lived process exits are captured separately.','This is local memory and recovery evidence, not production S3/PostgreSQL/IAM, network or capacity evidence.']},workload:{fixtureBytes:100000000,resolution:'1280x720',fps:30,durationSeconds:39,playbacks:10,playbackBytesPerSecondEach:2500000,commits:2,exports:2,framesPerExport:4,frameOffsetsMs:[1000,9000,18000,30000]},samples:[]};
function attach(child:ChildProcess,isDatabase=false){
  workers.set(child.pid!,child);
  child.on('message',(m:any)=>{
    if(m.type==='ready'){if(!Number.isSafeInteger(m.hostPid)||m.hostPid<1){ready.get(child.pid!)?.reject(new Error('Procfs host PID mapping unavailable'));return;}hostPids.set(child.pid!,m.hostPid);ready.get(child.pid!)?.resolve();return;}
    if(m.type==='db'){db!.send(m);return;}
    if(m.type==='db-result'){
      if(m.clientId===0){const p=pendingDb.get(m.id);pendingDb.delete(m.id);m.error?p?.reject(Object.assign(new Error(m.error.message),m.error)):p?.resolve(m.result);return;}
      const recipient=workers.get(m.clientId);if(recipient?.connected)recipient.send(m);return;
    }
    if(m.type==='command-result'){const p=commands.get(m.id);commands.delete(m.id);m.error?p?.reject(Object.assign(new Error(m.error.message),m.error)):p?.resolve(m.result);return;}
    if(m.type==='subprocess'){
      if(m.event==='started'){children.set(m.pid,{pid:m.pid,command:m.command,phase});if(phase==='fault-injection')crashResolve?.(m);}
      else{exits.push({...m,phase:children.get(m.pid)?.phase??phase});children.delete(m.pid);}return;
    }
  });
  child.on('exit',(code,signal)=>{exits.push({type:isDatabase?'database':'api',pid:child.pid,phase,code,signal});ready.get(child.pid!)?.reject(new Error(`Child exited before ready: ${code}/${signal}`));for(const [id,p] of commands)if(p.pid===child.pid){commands.delete(id);p.reject(new Error(`API exited: ${code}/${signal}`));}});
  child.stderr?.on('data',bytes=>process.stderr.write(bytes));
  child.stdout?.on('data',bytes=>process.stdout.write(bytes));
}
function spawn(file:string,args:string[],database=false){const child=fork(path.join(here,file),args,{execArgv:['--import','tsx'],serialization:'advanced',stdio:['ignore','pipe','pipe','ipc'],detached:!database});attach(child,database);const promise=new Promise<void>((resolve,reject)=>ready.set(child.pid!,{resolve,reject}));return {child,promise};}
function command(name:string,input:unknown={}){const id=++commandId,pid=api!.pid!;return new Promise<any>((resolve,reject)=>{commands.set(id,{resolve,reject,pid});api!.send({type:'command',id,name,input});});}
function dbQuery(sql:string,params:unknown[]=[]){const id=++dbId;return new Promise<any>((resolve,reject)=>{pendingDb.set(id,{resolve,reject});db!.send({clientId:0,id,method:'query',sql,params});});}
async function processMemory(pid:number){try{const text=await readFile(`/proc/${pid}/status`,'utf8');return {rss:Number(/VmRSS:\s+(\d+)/.exec(text)?.[1]??0)*1024,hwm:Number(/VmHWM:\s+(\d+)/.exec(text)?.[1]??0)*1024};}catch{return {rss:0,hwm:0};}}
async function descendants(hostPid:number){
  // Some restricted kernels omit task/<tid>/children. Status retains both the
  // outer PID and PPid, so build the actual process tree from that relationship.
  const all=(await Promise.all((await readdir('/proc')).filter(value=>/^\d+$/.test(value)).map(async pid=>{try{const text=await readFile(`/proc/${pid}/status`,'utf8');return {pid:Number(/^Pid:\s+(\d+)/m.exec(text)?.[1]),parent:Number(/^PPid:\s+(\d+)/m.exec(text)?.[1])};}catch{return null;}}))).filter((value):value is {pid:number;parent:number}=>value!==null);
  const found:number[]=[],parents=new Set([hostPid]);let changed=true;while(changed){changed=false;for(const row of all)if(parents.has(row.parent)&&!parents.has(row.pid)){parents.add(row.pid);found.push(row.pid);changed=true;}}return found;
}
let sampling=false,sampleBusy=false,peak=0,conservativePeak=0,peakApi=0,dbPeak=0,samples=0,maximumChildren=0,limitHit=false,invalidMemorySamples=0;
async function sample(){if(!sampling||sampleBusy)return;sampleBusy=true;try{const own=await processMemory(hostPids.get(api!.pid!)!),live=await descendants(hostPids.get(api!.pid!)!),child=await Promise.all(live.map(processMemory)),database=await processMemory(hostPids.get(db!.pid!)!);if(own.rss<16*1024*1024)invalidMemorySamples++;const rss=own.rss+child.reduce((s,row)=>s+row.rss,0),hwm=own.hwm+child.reduce((s,row)=>s+row.hwm,0);peak=Math.max(peak,rss);conservativePeak=Math.max(conservativePeak,hwm);peakApi=Math.max(peakApi,own.rss);dbPeak=Math.max(dbPeak,database.rss);maximumChildren=Math.max(maximumChildren,child.filter(row=>row.rss>0).length);samples++;if(samples%10===0)report.samples.push({atMs:performance.now(),rssBytes:rss,apiRssBytes:own.rss,childRssBytes:rss-own.rss,children:live.length});if(rss>=configuredBytes&&!limitHit){limitHit=true;process.kill(-api!.pid!,'SIGKILL');}}finally{sampleBusy=false;}}
const timer=setInterval(()=>void sample(),20);
async function fixture(){
  const filename=path.join(directory,'fixture-100MB.mp4');
  try{if((await stat(filename)).size===100000000)return;}catch{}
  process.stdout.write('Generating bounded 100 MB valid synthetic MP4 fixture.\n');
  const args=['-nostdin','-y','-v','error','-f','lavfi','-i','testsrc2=size=1280x720:rate=30','-t','39','-an','-c:v','libx264','-preset','ultrafast','-pix_fmt','yuv420p','-b:v','20M','-minrate','20M','-maxrate','20M','-bufsize','20M','-x264-params','nal-hrd=cbr:force-cfr=1','-threads','1','-movflags','+faststart',filename];
  await exec('ffmpeg',args,{timeout:120000,maxBuffer:100000});
  const size=(await stat(filename)).size,remaining=100000000-size;
  if(size<90000000||remaining<8)throw new Error(`Generated video size is outside expected padding range: ${size}`);
  const file=await open(filename,'a');try{const header=Buffer.alloc(8);header.writeUInt32BE(remaining);header.write('free',4,'ascii');await file.write(header);let left=remaining-8;const chunk=Buffer.alloc(65536);while(left){const n=Math.min(left,chunk.length);await file.write(chunk.subarray(0,n));left-=n;}}finally{await file.close();}
  report.fixtureGeneration={command:['ffmpeg',...args.slice(0,-1),'<fixture>'],encodedBytes:size,validMp4FreeBoxBytes:remaining};
}
async function playback(baseUrl:string,s:any,index:number){const started=performance.now();const response=await fetch(`${baseUrl}/proofs/${s.playback.proofId}/evidence/${s.playback.evidenceId}`,{headers:{Authorization:`Bearer ${s.actor}`}});if(response.status!==200)throw new Error(`Playback ${index} HTTP ${response.status}: ${await response.text()}`);let bytes=0;for await(const chunk of response.body!){bytes+=chunk.length;const wait=bytes/2500000*1000-(performance.now()-started);if(wait>0)await delay(wait);}if(bytes!==100000000)throw new Error(`Playback ${index} byte mismatch`);return {index,bytes,durationMs:performance.now()-started};}
try{
  await fixture();report.ffmpeg=(await exec('ffmpeg',['-version'],{maxBuffer:20000})).stdout.split('\n')[0];report.fixtureProbe=JSON.parse((await exec('ffprobe',['-v','error','-show_entries','stream=codec_name,width,height,avg_frame_rate:format=duration,size','-of','json',path.join(directory,'fixture-100MB.mp4')],{maxBuffer:10000})).stdout);
  phase='setup';process.stdout.write('Starting isolated database and measured API/media worker.\n');const database=spawn('media-load-database.ts',[path.join(directory,'database')],true);db=database.child;await database.promise;const runtime=spawn('media-load-worker.ts',[directory]);api=runtime.child;await runtime.promise;
  const setup=await command('setup'),scenario=setup.scenario;report.fixtureSha256=scenario.fixtureSha256;
  const baseline=await processMemory(hostPids.get(api.pid!)!);if(baseline.rss<16*1024*1024)throw new Error('API RSS measurement is invalid; no memory gate may pass');
  report.memoryObserver={apiNamespacePid:api.pid,apiProcfsPid:hostPids.get(api.pid!),databaseProcfsPid:hostPids.get(db.pid!),descendantDiscovery:'Recursive outer-Pid/PPid graph from /proc/*/status; includes the API process tree even when task/children files are unavailable'};
  phase='range';sampling=true;const rangeBaseline=await processMemory(hostPids.get(api.pid!)!);const range=await command('range');await sample();sampling=false;report.range={...range,apiRssBeforeBytes:rangeBaseline.rss,apiRssAfterBytes:(await processMemory(hostPids.get(api.pid!)!)).rss,passed:range.status===206&&range.returnedBytes===1048576&&range.storageReadBytes===1048576&&range.largestSourceChunk<=65536};
  phase='load';peak=0;conservativePeak=0;peakApi=0;samples=0;maximumChildren=0;invalidMemorySamples=0;report.samples=[];await command('start-measurement');sampling=true;const loadStarted=performance.now();process.stdout.write('Running 10 real HTTP playbacks, 2 native evidence commits and 2 four-frame recipient exports.\n');
  const jobs=[...Array.from({length:10},(_,i)=>playback(setup.baseUrl,scenario,i)),...scenario.commits.map(async(row:any)=>{const began=performance.now();const response=await fetch(`${setup.baseUrl}/proofs/${row.proofId}/evidence/${row.evidenceId}/commit`,{method:'POST',headers:{Authorization:`Bearer ${row.actor}`,'Content-Type':'application/json'},body:JSON.stringify({sha256:scenario.fixtureSha256})});const body=await response.json();if(response.status!==200||body.validationStatus!=='COMMITTED')throw new Error(`Commit failed HTTP ${response.status}: ${JSON.stringify(body)}`);return {kind:'commit',evidenceId:row.evidenceId,durationMs:performance.now()-began};}),...Array.from({length:2},async()=>{const began=performance.now(),result=await command('export');if(result.failed||result.processed!==1)throw new Error(`Export failed: ${JSON.stringify(result)}`);return {kind:'export',durationMs:performance.now()-began,...result};})];
  const results=await Promise.allSettled(jobs);await sample();sampling=false;report.loadDurationMs=performance.now()-loadStarted;report.jobResults=results.map(result=>result.status==='fulfilled'?{status:result.status,...result.value}:{status:result.status,error:String(result.reason)});
  const state=await command('state');report.storage={readBytes:state.storageReadBytes,largestChunk:state.largestSourceChunk};report.exports=state.exports.map((row:any)=>({state:row.state,files:row.artifact?.files.map((file:any)=>({contentType:file.contentType,byteSize:file.byteSize,pages:file.pages})),selectedFrames:row.artifact?.sources.length}));report.commits=state.commits;
  const abnormal=exits.filter(row=>row.phase==='load'&&(row.code!==0||row.signal));report.memory={baselineApiRssBytes:baseline.rss,peakApiRssBytes:peakApi,peakApiAndChildrenRssBytes:peak,conservativePeakConcurrentHighWaterSumBytes:conservativePeak,fractionOfConfiguredLimit:peak/configuredBytes,conservativeFractionOfConfiguredLimit:conservativePeak/configuredBytes,sampleIntervalMs:20,samples,invalidMemorySamples,maximumConcurrentMediaSubprocesses:maximumChildren,databaseExcludedPeakRssBytes:dbPeak};report.loadAbnormalExits=abnormal;report.limitFuseTriggered=limitHit;
  report.memoryMeasurementValid=!invalidMemorySamples&&samples>100&&maximumChildren>=2&&peakApi>16*1024*1024;
  report.localLoadGatePassed=results.every(result=>result.status==='fulfilled')&&state.exports.every((row:any)=>row.state==='READY')&&state.commits.every((row:any)=>row.validation_status==='COMMITTED')&&conservativePeak<thresholdBytes&&!abnormal.length&&!limitHit&&report.memoryMeasurementValid;
  process.stdout.write(`Local measured peak including children: ${(peak/1024/1024).toFixed(1)} MiB; conservative concurrent HWM sum ${(conservativePeak/1024/1024).toFixed(1)} MiB; target <716.8 MiB.\n`);
  if(!report.localLoadGatePassed)throw new Error('Local load gate failed; inspect recorded memory/results');
  phase='fault-injection';const queued=await command('queue-recovery');const started=new Promise(resolve=>{crashResolve=resolve;});const abandoned=command('export').catch(error=>({intentionalExit:String(error)}));await started;crashResolve=null;
  const claimed=await dbQuery('SELECT state,attempts,lease_token,lease_until FROM recipient_export_jobs WHERE id=$1',[queued.jobId]);
  if(claimed.rows[0]?.state!=='RENDERING')throw new Error('Fault injection did not interrupt an actually claimed export');
  const crashedPid=api.pid!;process.kill(-crashedPid,'SIGKILL');await abandoned;
  for(const [pid,child] of children)if(child.phase==='fault-injection'){children.delete(pid);exits.push({type:'intentional-fault-child',pid,phase:'fault-injection',signal:'SIGKILL'});}
  phase='recovery';const replacement=spawn('media-load-worker.ts',[directory]);api=replacement.child;await replacement.promise;await command('resume');const recovered=await command('recover');report.queueRecovery={injection:'Intentional API/process-group SIGKILL after a real RENDERING lease was committed; outside measured load',clockAdvance:'11 minutes of fixture clock to exceed existing 10-minute lease; no database lease rewrite',claimedBeforeCrash:{state:claimed.rows[0].state,attempts:claimed.rows[0].attempts},recovered,passed:recovered.state==='READY'&&recovered.attempts===2&&recovered.lease_token===null};
  if(!report.queueRecovery.passed)throw new Error('Queued export did not recover after worker replacement');
  report.passed=report.localLoadGatePassed&&report.range.passed&&report.queueRecovery.passed;
}catch(error){report.passed=false;report.error={phase,message:String((error as Error).message)};process.exitCode=1;}
finally{
  sampling=false;clearInterval(timer);phase='cleanup';
  if(api?.connected)try{await command('stop');}catch{}
  if(db?.connected)db.send({method:'close'});
  report.completedAt=new Date().toISOString();report.subprocessExits=exits;
  await writeFile(path.join(directory,'media-load-report.json'),JSON.stringify(report,null,2)+'\n',{mode:0o600});process.stdout.write(`Report: ${path.join(directory,'media-load-report.json')}\n`);
}
