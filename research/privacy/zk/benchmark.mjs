import { mkdirSync,writeFileSync } from 'node:fs';
import { generateKeyPairSync,sign } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import os from 'node:os';
import { Bool,Field,UInt8,Cache,setNumberOfWorkers } from 'o1js';
import { PNG } from 'pngjs';
import canonicalize from 'canonicalize';
import { getProfile } from './circuit.mjs';
const cli=process.argv.slice(2),outputIndex=cli.indexOf('--output'),sizeIndex=cli.indexOf('--size');
const size=Number(sizeIndex>=0?cli[sizeIndex+1]:outputIndex>=0?4:cli[1]||4);
const {CIRCUIT_ID,WIDTH,HEIGHT,PIXELS,Redaction,RedactionPublic,ImagePixels,commitmentFor,outputDigestFor}=getProfile(size);
import { sha,verifyBundle } from './verify.mjs';
setNumberOfWorkers(2);
const dir=(outputIndex>=0?cli[outputIndex+1]:cli[0])||'/tmp/packproof-zk-benchmark'; mkdirSync(dir,{recursive:true});
function pngBytes(rgb){const png=new PNG({width:WIDTH,height:HEIGHT});for(let i=0;i<PIXELS;i++){png.data.set(rgb.slice(i*3,i*3+3),i*4);png.data[i*4+3]=255;}return PNG.sync.write(png);}
const src=Array.from({length:PIXELS*3},(_,i)=>(i*17+11)%256), mask=Array.from({length:PIXELS},(_,i)=>i%3===0), output=src.map((x,i)=>mask[Math.floor(i/3)]?0:x);
const channels=src.map(UInt8.from),blind=Field.random(),commitment=commitmentFor(channels,blind).toString(), outputBytes=pngBytes(output);
const {privateKey,publicKey}=generateKeyPairSync('ed25519');
const sourceRecord={schemaVersion:'packproof.pixel-source-binding.v1',assertionKind:'TRUSTED_PROCESSOR_RGB8_COMMITMENT',sourceSha256:sha(pngBytes(src)),canonicalPixelsSha256:sha(Buffer.from(src)),commitment,circuitId:CIRCUIT_ID,width:WIDTH,height:HEIGHT,formatVersion:1,extraction:'PNG decoded to RGB8; decoding is trusted, not proven',createdAt:new Date().toISOString()};
const sourceBinding={record:sourceRecord,keyId:sha(publicKey.export({type:'spki',format:'der'})),signature:sign(null,Buffer.from(canonicalize(sourceRecord)),privateKey).toString('base64')};
const started=performance.now(); console.log(`Compiling actual ${WIDTH}x${HEIGHT} circuit...`);
const {verificationKey}=await Redaction.compile({cache:Cache.FileSystem(`${dir}/cache`)});
const compileMs=performance.now()-started;
const publicInput=new RedactionPublic({commitment:Field(commitment),width:Field(WIDTH),height:Field(HEIGHT),formatVersion:Field(1),transformVersion:Field(1),mask:mask.map(Bool),outputDigest:outputDigestFor(output.map(UInt8.from))});
const proveStarted=performance.now(); console.log('Generating real proof...');
const {proof}=await Redaction.redact(publicInput,new ImagePixels({channels}),blind); const proverMs=performance.now()-proveStarted;
const trust={circuitId:CIRCUIT_ID,verificationKey:{data:verificationKey.data,hash:verificationKey.hash.toString()},verificationKeyId:sha(verificationKey.data),expectedSourceSha256:sourceRecord.sourceSha256,sourcePublicKeyPem:publicKey.export({type:'spki',format:'pem'})};
const bundle={schemaVersion:'packproof.zk-redaction.v1',circuitId:CIRCUIT_ID,verificationKeyId:trust.verificationKeyId,width:WIDTH,height:HEIGHT,formatVersion:1,transformVersion:1,mask,commitment,outputDigest:publicInput.outputDigest.toString(),outputSha256:sha(outputBytes),sourceBinding,proof:proof.toJSON()};
const verifierStarted=performance.now(); await verifyBundle(bundle,outputBytes,trust); const verifierMs=performance.now()-verifierStarted;
const results=[];
for(const [name,mutate] of [
 ['mask',b=>{b.mask[1]=!b.mask[1]}],['nonboolean mask',b=>{b.mask[0]=2}],['dimensions',b=>{b.width=5}],['format',b=>{b.formatVersion=2}],['transform',b=>{b.transformVersion=2}],['commitment',b=>{b.commitment='1'}],['circuit',b=>{b.circuitId='unknown'}],['verification key',b=>{b.verificationKeyId='0'.repeat(64)}],['missing source binding',b=>{delete b.sourceBinding}],['source inventory link',b=>{b.sourceBinding.record.sourceSha256='0'.repeat(64)}],['output digest',b=>{b.outputDigest='1'}],['proof field',b=>{b.proof.publicInput[0]='1'}],['proof bytes',b=>{b.proof.proof=b.proof.proof.slice(0,-10)+'AAAAAAAAAA'}],
]){const bad=structuredClone(bundle);mutate(bad);let rejected=false;try{await verifyBundle(bad,outputBytes,trust);}catch{rejected=true;}if(!rejected)throw Error(`tamper accepted: ${name}`);results.push({name,rejected});}
for(const channel of [0,1,2,3,47]){const bad=output.slice();bad[channel]=(bad[channel]+1)%256;let rejected=false;try{await verifyBundle(bundle,pngBytes(bad),trust);}catch{rejected=true;}if(!rejected)throw Error('output channel accepted');results.push({name:`output channel ${channel}`,rejected});}
// Constraint-only adversarial checks avoid redundant expensive valid proofs.
for(const [name,change] of [['wrong private source',x=>{x[4]=UInt8.from((src[4]+1)%256)}],['range overflow',x=>{x[4]=new UInt8(256)}]]){let rejected=false;try{const modified=channels.slice();change(modified);await Redaction.redact(publicInput,new ImagePixels({channels:modified}),blind);}catch{rejected=true;}if(!rejected)throw Error(`${name} accepted`);results.push({name,rejected});}
writeFileSync(`${dir}/proof.json`,JSON.stringify(bundle,null,2));writeFileSync(`${dir}/output.png`,outputBytes);writeFileSync(`${dir}/trust.json`,JSON.stringify(trust,null,2));
const report={schemaVersion:'packproof.zk-benchmark.v1',generatedAt:new Date().toISOString(),fixture:`synthetic ${WIDTH}x${HEIGHT} RGB8; not captured evidence`,framework:'o1js 2.15.0',hardware:{platform:os.platform(),arch:os.arch(),cpu:os.cpus()[0]?.model,workers:2},compileMs,proverMs,verifierMs,proofJsonBytes:Buffer.byteLength(JSON.stringify(bundle.proof)),bundleBytes:Buffer.byteLength(JSON.stringify(bundle)),maxRssKiB:process.resourceUsage().maxRSS,cloudSpendUsd:0,perImageCloudCost:'unmeasured',tests:results,securityReview:'PENDING',independentReview:false,publicReliance:false,setup:'o1js Kimchi/Pasta framework; no application-specific trusted ceremony; verify framework and parameters in specialist review',limits:[`Only ${WIDTH}x${HEIGHT} exact RGB8 profile measured in this run.`,'Decoding/extraction and source signer remain trusted.','No device capture, detector recall, real image size or public-use qualification.']};
writeFileSync(`${dir}/benchmark.json`,JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));
