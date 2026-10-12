#!/usr/bin/env node
/** Actual Linux containment and worker checks; inability to isolate is a failure. */
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {mkdirSync,mkdtempSync,readFileSync,writeFileSync,chmodSync,rmSync,readlinkSync} from 'node:fs';
import {createServer} from 'node:net';
import {resolve,dirname,join} from 'node:path';
import {fileURLToPath} from 'node:url';
import os from 'node:os';
import {sandboxCommand} from './rnd-worker-sandbox.mjs';

const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const flags=process.argv.slice(2);
const option=name=>{const i=flags.indexOf(name);assert(i>=0&&flags[i+1],`${name} required`);return resolve(flags[i+1]);};
const reportPath=option('--report');
const report={schema:'packproof.rnd-sandbox-probe.v1',observedAt:new Date().toISOString(),sourceSha:process.env.GITHUB_SHA??null,platform:process.platform,kernel:os.release(),passed:false,checks:{},releaseAuthorized:false,scope:'Synthetic unprivileged Linux decoder containment on this runner only; no physical, production, witness-service or ZK isolation qualification.'};
const directories=[];let listener;
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
function withLargeAncillaryChunk(png) {
 // A valid private ancillary PNG chunk tests admitted original bytes above the
 // former 32-MiB file ceiling without inflating decoded dimensions or claiming
 // a large physical-image corpus. No original fixture is modified.
 assert(png.subarray(-8,-4).equals(Buffer.from('IEND')),'PNG_FIXTURE_IEND_REQUIRED');
 const body=Buffer.concat([Buffer.from('npAD'),Buffer.alloc(33*1024*1024)]);
 const table=Uint32Array.from({length:256},(_,n)=>{let value=n;for(let bit=0;bit<8;bit++)value=(value&1)?(0xedb88320^(value>>>1)):(value>>>1);return value>>>0;});
 let crc=0xffffffff;for(const byte of body)crc=table[(crc^byte)&255]^(crc>>>8);
 const length=Buffer.alloc(4),checksum=Buffer.alloc(4);length.writeUInt32BE(body.length-4);checksum.writeUInt32BE((crc^0xffffffff)>>>0);
 return Buffer.concat([png.subarray(0,-12),length,body,checksum,png.subarray(-12)]);
}
const privateDirectory=prefix=>{const dir=mkdtempSync(`/tmp/${prefix}`);chmodSync(dir,0o700);directories.push(dir);return dir;};
const execute=(runtime,code,script,args,expected=0)=>{
 const command=sandboxCommand(['--runtime',runtime,'--code',code,'--',join(runtime,'bin/python'),join(code,script),...args]);
 const result=spawnSync(command.program,command.args,{encoding:'utf8',timeout:65000,killSignal:'SIGKILL',maxBuffer:1048576,env:{PATH:'/usr/bin:/bin',PACKPROOF_SANDBOX_CANARY:'synthetic-not-a-secret'}});
 // Static classification only; raw paths, environment and third-party stderr
 // are not copied into the public evidence report.
 report.lastProcess={entryPoint:script,exitCode:result.status,signal:result.signal??null,
  failureClass:result.error?'PROCESS_UNAVAILABLE':/bwrap:.*(?:permitted|namespace)/i.test(result.stderr??'')?'NAMESPACE_UNAVAILABLE':result.status!==0?'CHILD_NONZERO':null};
 // This harness creates every input itself and passes a cleared environment.
 // Retain a bounded synthetic-only traceback so CI failures are diagnosable;
 // the application worker's general error-reporting policy is unchanged.
 if(result.status!==expected&&result.status!==0)report.lastProcess.syntheticStderrTail=(result.stderr??'').slice(-8192);
 assert(!result.error,'SANDBOX_PROCESS_UNAVAILABLE');if(expected!==null)assert.equal(result.status,expected,'SANDBOX_PROCESS_FAILED');
 return result.stdout;
};
try {
 assert.equal(process.platform,'linux','LINUX_REQUIRED');
 const vision=option('--vision-runtime'),privacy=option('--privacy-runtime');
 const version=spawnSync('/usr/bin/bwrap',['--version'],{encoding:'utf8'});assert.equal(version.status,0,'BUBBLEWRAP_REQUIRED');
 report.bubblewrap=version.stdout.trim();
 report.stage='HOSTILE_SYNTHETIC_PAYLOAD';
 const outside=privateDirectory('packproof-sandbox-outside-'),code=privateDirectory('packproof-sandbox-code-'),job=privateDirectory('packproof-rnd-');
 mkdirSync(join(code,'vision'));writeFileSync(join(code,'vision/worker.py'),readFileSync(join(root,'scripts/rnd-sandbox-probe.py')),{mode:0o600});
 writeFileSync(join(code,'code-canary.txt'),'synthetic code canary',{mode:0o600});
 writeFileSync(join(outside,'unrelated.txt'),'synthetic outside canary',{mode:0o600});
 listener=createServer(socket=>socket.destroy());await new Promise((yes,no)=>{listener.once('error',no);listener.listen(0,'127.0.0.1',yes);});
 const input={hostPort:listener.address().port,outsideCanary:join(outside,'unrelated.txt'),codeCanary:join(code,'code-canary.txt'),runtimeCanary:join(vision,'pyvenv.cfg'),hostNamespaces:Object.fromEntries(['net','pid','mnt','user'].map(name=>[name,readlinkSync(`/proc/self/ns/${name}`)]))};
 writeFileSync(join(job,'probe.json'),JSON.stringify(input),{mode:0o600});
 const probe=JSON.parse(execute(vision,code,'vision/worker.py',['--job',join(job,'probe.json'),'--output',job],null));
 report.checks=probe.checks;report.processLimits=probe.limits;report.nativeTools=probe.nativeTools;assert.equal(probe.passed,true,'CONTAINMENT_PROBE_FAILED');
 report.stage='REAL_VISION_WORKER';
 const research=join(root,'research'),visionJob=privateDirectory('packproof-rnd-');
 const source=readFileSync(join(root,'backend/tests/fixtures/rnd-mask-source.png'));const sourceHash=hash(source);
 const largeSource=withLargeAncillaryChunk(source),largeHash=hash(largeSource);
 assert(largeSource.length>32*1024*1024&&largeSource.length<128*1024*1024);
 writeFileSync(join(visionJob,'source.png'),largeSource,{mode:0o600});
 const visionInput={schemaVersion:'packproof.vision-job.v1',feature:'proofsight',analysisId:'synthetic-sandbox-probe',sandboxRoot:visionJob,sources:[{sourceId:'synthetic-source',path:join(visionJob,'source.png'),sha256:largeHash,byteLength:largeSource.length,mimeType:'image/png'}],parameters:{}};
 writeFileSync(join(visionJob,'job.json'),JSON.stringify(visionInput),{mode:0o600});
 execute(vision,research,'vision/worker.py',['--job',join(visionJob,'job.json'),'--output',visionJob]);
 const result=JSON.parse(readFileSync(join(visionJob,'result.json'),'utf8'));
 assert.equal(result.operationalState,'SUCCEEDED');assert.equal(result.qualification.customerFindingsEnabled,false);assert.equal(result.provenance.sources[0].sha256,largeHash);
 assert.equal(hash(readFileSync(join(visionJob,'source.png'))),largeHash);report.checks.realVisionWorker=true;report.checks.admittedSourceAbove32MiB=true;report.syntheticSourceByteLength=largeSource.length;
 // Retain partial identity before testing it. Run the independent redaction
 // check first so a missing OCR observation cannot hide its native-tool error.
 report.ocrRuntime=result.provenance.ocrRuntime;
 report.stage='MALFORMED_MEDIA';
 const badJob=privateDirectory('packproof-rnd-'),bad=Buffer.from('\x89PNG\r\n\x1a\ninvalid-synthetic-container','binary');
 writeFileSync(join(badJob,'source.png'),bad,{mode:0o600});
 writeFileSync(join(badJob,'job.json'),JSON.stringify({...visionInput,sandboxRoot:badJob,sources:[{...visionInput.sources[0],path:join(badJob,'source.png'),sha256:hash(bad),byteLength:bad.length}]}),{mode:0o600});
 execute(vision,research,'vision/worker.py',['--job',join(badJob,'job.json'),'--output',badJob],2);
 const failure=JSON.parse(readFileSync(join(badJob,'result.json'),'utf8'));assert.equal(failure.operationalState,'FAILED');assert.equal(failure.findingState,'NOT_CHECKED');assert.deepEqual(failure.observations,[]);report.checks.malformedMediaFailsWithoutFinding=true;
 report.stage='REAL_REDACTION_WORKER';
 const privacyJob=privateDirectory('packproof-rnd-');writeFileSync(join(privacyJob,'source.png'),source,{mode:0o600});
 writeFileSync(join(privacyJob,'masks.json'),JSON.stringify([{x:0,y:0,width:8,height:8,class:'manual'}]),{mode:0o600});
 const manifest=JSON.parse(execute(privacy,research,'privacy/redact.py',['create',join(privacyJob,'source.png'),join(privacyJob,'derivative.png'),'--masks',join(privacyJob,'masks.json'),'--kind','still','--unsigned-record']));
 assert.equal(manifest.record.sourceSha256,sourceHash);assert.equal(manifest.record.derivativeSha256,hash(readFileSync(join(privacyJob,'derivative.png'))));assert.equal(manifest.requiresServerSignature,true);assert.equal(manifest.record.review.state,'REQUIRED');assert.equal(hash(readFileSync(join(privacyJob,'source.png'))),sourceHash);report.checks.realUnsignedRedactionWorker=true;
 report.stage='OCR_RUNTIME_IDENTITY';
 assert.equal(report.ocrRuntime.state,'RECORDED');assert.match(report.ocrRuntime.executableSha256,/^[a-f0-9]{64}$/);assert.match(report.ocrRuntime.traineddataSha256,/^[a-f0-9]{64}$/);assert.equal(report.ocrRuntime.approvedRuntime,false);report.checks.observedOcrRuntimeHashes=true;
 report.launcherSha256=hash(readFileSync(join(root,'scripts/rnd-worker-sandbox.mjs')));report.probeSha256=hash(readFileSync(join(root,'scripts/rnd-sandbox-probe.py')));
 report.passed=Object.values(report.checks).every(value=>value===true);
 report.stage='COMPLETE';
} catch(error) {
 report.failureCode=error?.code==='ERR_ASSERTION'?'CHECK_FAILED':'CONTAINMENT_UNAVAILABLE';
 process.exitCode=1;
} finally {
 if(listener)await new Promise(resolve=>listener.close(resolve));
 for(const directory of directories)rmSync(directory,{recursive:true,force:true});
 mkdirSync(dirname(reportPath),{recursive:true});writeFileSync(reportPath,JSON.stringify(report,null,2)+'\n');
 console.log(JSON.stringify({passed:report.passed,checks:Object.keys(report.checks).length,failureCode:report.failureCode??null}));
}
