/** Small-sample supported-profile measurements, never a performance qualification. */
import {mkdirSync,readFileSync,writeFileSync,existsSync} from 'node:fs';
import {generateKeyPairSync,sign} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {performance} from 'node:perf_hooks';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {createRequire} from 'node:module';
import {resolve,dirname,join} from 'node:path';
import os from 'node:os';
import {getProfile} from '../../privacy/zk/circuit.mjs';
import {sha,verifyBundle} from '../../privacy/zk/verify.mjs';

const moduleDirectory=dirname(fileURLToPath(import.meta.url));
const zkDirectory=resolve(moduleDirectory,'../../privacy/zk');
const require=createRequire(join(zkDirectory,'package.json'));
const canonicalize=require('canonicalize');
const {PNG}=require('pngjs');
// Match the existing circuit's ESM instance; CJS creates incompatible field types.
const o1jsDirectory=join(zkDirectory,'node_modules/o1js');
const o1jsPackage=JSON.parse(readFileSync(join(o1jsDirectory,'package.json')));
const {Bool,Field,UInt8,Cache,setNumberOfWorkers}=await import(pathToFileURL(join(o1jsDirectory,o1jsPackage.exports.node.import)).href);

const args=process.argv.slice(2);
if(args.length!==6||args[0]!=='--size'||args[2]!=='--samples'||args[4]!=='--output')throw Error('Use --size 4|8 --samples 1..3 --output NEW_DIRECTORY');
const size=Number(args[1]),samples=Number(args[3]),directory=resolve(args[5]);
if(![4,8].includes(size)||!Number.isInteger(samples)||samples<1||samples>3||existsSync(directory))throw Error('Only supported profiles, 1..3 samples and a fresh output directory are accepted');
const repository=resolve(moduleDirectory,'../../..');
const git=spawnSync('git',['rev-parse','HEAD'],{cwd:repository,encoding:'utf8'});
const state=spawnSync('git',['status','--porcelain'],{cwd:repository,encoding:'utf8'});
const sourceFiles=['research/privacy/zk/circuit.mjs','research/privacy/zk/verify.mjs','research/qualification/privacy/performance-preflight.mjs','research/privacy/zk/package-lock.json'];
const report={schemaVersion:'packproof.zk-performance-preflight.v1',startedAt:new Date().toISOString(),
 source:{head:git.status===0?git.stdout.trim():null,workingTreeDirty:state.status===0?Boolean(state.stdout.trim()):null,files:sourceFiles.map(path=>({path,sha256:sha(readFileSync(join(repository,path)))}))},
 runtime:{node:process.version,o1js:o1jsPackage.version,platform:process.platform,arch:process.arch,cpu:os.cpus()[0]?.model,workers:2},
 profile:size,requestedSamples:samples,measurements:[],passed:false,qualificationPassed:false,independentReview:false,publicReliance:false,
 limitations:['Synthetic exact-size RGB8 only; no real source media or video.','At most three observations: no p95, SLA, population reliability or full-size extrapolation.','Compilation measured separately; subsequent proofs share a compiled circuit in one process.','Process high-water RSS is not an OS allocation limit or aggregate system measurement.','No cloud or target-device cost measurement; no deployment, certification or independent review.']};
mkdirSync(directory,{recursive:false,mode:0o700});
const timeout=setTimeout(()=>{report.failureCode='WALL_TIME_LIMIT';save();process.exit(2);},240000);
function save(){writeFileSync(join(directory,'performance.json'),JSON.stringify(report,null,2)+'\n');}
try{
 setNumberOfWorkers(2);
 const {CIRCUIT_ID,WIDTH,HEIGHT,PIXELS,Redaction,RedactionPublic,ImagePixels,commitmentFor,outputDigestFor}=getProfile(size);
 const pngBytes=rgb=>{const png=new PNG({width:WIDTH,height:HEIGHT});for(let i=0;i<PIXELS;i++){png.data.set(rgb.slice(i*3,i*3+3),i*4);png.data[i*4+3]=255;}return PNG.sync.write(png);};
 const compileStarted=performance.now();
 const {verificationKey}=await Redaction.compile({cache:Cache.FileSystem(join(directory,'compile-cache'))});
 report.compileMs=performance.now()-compileStarted;
 for(let sample=0;sample<samples;sample++){
  const rgb=Array.from({length:PIXELS*3},(_,i)=>(i*17+11+sample*7)%256),mask=Array.from({length:PIXELS},(_,i)=>(i+sample)%3===0);
  const output=rgb.map((v,i)=>mask[Math.floor(i/3)]?0:v),sourceBytes=pngBytes(rgb),outputBytes=pngBytes(output);
  const channels=rgb.map(UInt8.from),blind=Field.random(),commitment=commitmentFor(channels,blind).toString();
  const {privateKey,publicKey}=generateKeyPairSync('ed25519');
  const record={schemaVersion:'packproof.pixel-source-binding.v1',assertionKind:'TRUSTED_PROCESSOR_RGB8_COMMITMENT',sourceSha256:sha(sourceBytes),canonicalPixelsSha256:sha(Buffer.from(rgb)),commitment,circuitId:CIRCUIT_ID,width:WIDTH,height:HEIGHT,formatVersion:1,extraction:'Synthetic PNG decoded to RGB8; decoding trusted, not proven',createdAt:new Date().toISOString()};
  const sourceBinding={record,keyId:sha(publicKey.export({type:'spki',format:'der'})),signature:sign(null,Buffer.from(canonicalize(record)),privateKey).toString('base64')};
  const trust={circuitId:CIRCUIT_ID,verificationKey:{data:verificationKey.data,hash:verificationKey.hash.toString()},verificationKeyId:sha(verificationKey.data),expectedSourceSha256:record.sourceSha256,sourcePublicKeyPem:publicKey.export({type:'spki',format:'pem'})};
  const input=new RedactionPublic({commitment:Field(commitment),width:Field(WIDTH),height:Field(HEIGHT),formatVersion:Field(1),transformVersion:Field(1),mask:mask.map(Bool),outputDigest:outputDigestFor(output.map(UInt8.from))});
  const provingStarted=performance.now();const {proof}=await Redaction.redact(input,new ImagePixels({channels}),blind);const proveMs=performance.now()-provingStarted;
  const bundle={schemaVersion:'packproof.zk-redaction.v1',circuitId:CIRCUIT_ID,verificationKeyId:trust.verificationKeyId,width:WIDTH,height:HEIGHT,formatVersion:1,transformVersion:1,mask,commitment,outputDigest:input.outputDigest.toString(),outputSha256:sha(outputBytes),sourceBinding,proof:proof.toJSON()};
  const verificationStarted=performance.now();await verifyBundle(bundle,outputBytes,trust);const verifyMs=performance.now()-verificationStarted;
  const sampleDirectory=join(directory,`sample-${sample+1}`);mkdirSync(sampleDirectory);
  for(const [name,value] of [['proof.json',bundle],['public-test-trust.json',trust]])writeFileSync(join(sampleDirectory,name),JSON.stringify(value,null,2)+'\n');
  writeFileSync(join(sampleDirectory,'output.png'),outputBytes);
  report.measurements.push({sample:sample+1,proveMs,verifyMs,proofJsonBytes:Buffer.byteLength(JSON.stringify(bundle.proof)),bundleBytes:Buffer.byteLength(JSON.stringify(bundle)),proofSha256:sha(readFileSync(join(sampleDirectory,'proof.json'))),outputSha256:sha(outputBytes),verified:true});
  save();
 }
 const summary=key=>{const values=report.measurements.map(x=>x[key]).sort((a,b)=>a-b);return {count:values.length,min:values[0],median:values.length%2?values[(values.length-1)/2]:(values[values.length/2-1]+values[values.length/2])/2,max:values.at(-1)};};
 report.descriptiveSummary={proveMs:summary('proveMs'),verifyMs:summary('verifyMs')};
 report.maxRssKiB=process.resourceUsage().maxRSS;report.completedAt=new Date().toISOString();report.passed=true;
}catch(error){report.failureCode='SUPPORTED_PROFILE_RUN_FAILED';report.syntheticFailureMessage=String(error?.message??'Unknown error').slice(0,512);process.exitCode=1;}
finally{clearTimeout(timeout);save();console.log(JSON.stringify({passed:report.passed,profile:size,samples:report.measurements.length,report:join(directory,'performance.json'),qualificationPassed:false}));}
