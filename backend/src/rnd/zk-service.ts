import { spawn } from 'node:child_process';
import { createPublicKey,verify as verifySignature } from 'node:crypto';
import { readFile,writeFile,stat } from 'node:fs/promises';
import path from 'node:path';
import { canonicalize,parseStrictJson } from '../../../packages/evidence-contracts/contracts.mjs';
import { sha256Hex } from '../hash.js';
import { requireRnd } from './config.js';
import { authorized,bad,boundedId,requireConsent,signedRecord } from './security.js';
import type { AnalysisRow,RndDeps,WorkerResult } from './types.js';

type Materialized={sourceId:string;path:string;sha256:string;byteLength:number};
type Enrollment={id:string;analysis_id:string;source_id:string;root_digest:string;circuit_id:string;source_sha256:string;private_witness_json:string;source_binding_json:string;canonical_json:string;digest:string;signature:unknown};
type Registry={schemaVersion:string;profiles:Record<string,{verificationKeyId:string;verificationKey:{data:string;hash:string}}>};
const MEMORY_CAP=1024*1024*1024;
let activeProver=false;
async function rssTree(pid:number,seen=new Set<number>()):Promise<number>{
 if(seen.has(pid))return 0;seen.add(pid);
 try{const [status,children]=await Promise.all([readFile(`/proc/${pid}/status`,'utf8'),readFile(`/proc/${pid}/task/${pid}/children`,'utf8')]);
  const self=Number(/^VmRSS:\s+(\d+)\s+kB$/m.exec(status)?.[1]??0)*1024;
  return self+(await Promise.all(children.trim().split(/\s+/).filter(Boolean).map(p=>rssTree(Number(p),seen)))).reduce((a,b)=>a+b,0);
 }catch{return 0;}
}
async function run(config:NonNullable<NonNullable<RndDeps['rnd']>['zk']>,args:string[],timeoutMs:number):Promise<{stdout:string;peakRssBytes:number;elapsedMs:number}>{
 if(process.platform!=='linux'&&!config.sandbox)bad('RND_ZK_MEMORY_GUARD_UNAVAILABLE','This host needs an explicit memory-limited research sandbox');
 const started=Date.now();return new Promise((resolve,reject)=>{
  const grouped=process.platform!=='win32',command=config.sandbox?.program??config.node;
  const nodeArgs=['--max-old-space-size=256',...args];
  const child=spawn(command,config.sandbox?[...config.sandbox.args,config.node,...nodeArgs]:nodeArgs,{shell:false,detached:grouped,stdio:['ignore','pipe','pipe'],env:{PATH:process.env.PATH??'/usr/bin:/bin',OMP_NUM_THREADS:'1',OPENBLAS_NUM_THREADS:'1'}});
  let stdout='',bytes=0,peakRssBytes=0,reason:string|null=null,settled=false;
  const stop=(code:string)=>{if(settled||reason)return;reason=code;try{if(grouped&&child.pid)process.kill(-child.pid,'SIGKILL');else child.kill('SIGKILL');}catch{/* close handler settles */}};
  const timeout=setTimeout(()=>stop('RND_ZK_TIMEOUT'),Math.min(120000,timeoutMs));
  const monitor=setInterval(()=>{if(child.pid)void rssTree(child.pid).then(rss=>{peakRssBytes=Math.max(peakRssBytes,rss);if(rss>MEMORY_CAP)stop('RND_ZK_MEMORY_LIMIT');});},200);
  const cleanup=()=>{clearTimeout(timeout);clearInterval(monitor);};
  child.stdout.on('data',(b:Buffer)=>{bytes+=b.length;if(bytes>1048576)stop('RND_ZK_OUTPUT_LIMIT');else stdout+=b.toString('utf8');});
  child.stderr.on('data',(b:Buffer)=>{bytes+=b.length;if(bytes>1048576)stop('RND_ZK_OUTPUT_LIMIT');});
  child.on('error',()=>{cleanup();if(settled)return;settled=true;reject(Object.assign(new Error('ZK processor unavailable'),{code:'RND_ZK_UNAVAILABLE'}));});
  child.on('close',code=>{cleanup();if(settled)return;settled=true;if(reason||code!==0)reject(Object.assign(new Error('ZK processor failed'),{code:reason??'RND_ZK_PROCESSING_FAILED'}));else resolve({stdout,peakRssBytes,elapsedMs:Date.now()-started});});
 });
}
async function pinnedRegistry(file:string):Promise<Registry>{
 const info=await stat(file);if(!info.isFile()||info.size>1048576)bad('RND_ZK_TRUST_INVALID','Invalid verification registry size');
 const value=parseStrictJson(await readFile(file,'utf8')) as unknown as Registry;
 if(value.schemaVersion!=='packproof.zk-verification-registry.v1'||!value.profiles)bad('RND_ZK_TRUST_INVALID','Expected independently pinned ZK circuit registry');
 for(const [id,entry] of Object.entries(value.profiles))if(!['packproof-rgb8-opaque-4x4-v1','packproof-rgb8-opaque-8x8-v1'].includes(id)||!entry?.verificationKey?.data||sha256Hex(entry.verificationKey.data)!==entry.verificationKeyId)bad('RND_ZK_TRUST_INVALID','Unrecognized circuit or verification key digest');
 return value;
}
export async function executeZkAnalysis(deps:RndDeps,job:AnalysisRow,sources:Materialized[],directory:string):Promise<WorkerResult>{
 requireRnd(deps.rnd,'proofshield','processing');await authorized(deps.db,job.proof_id,job.actor_id);await requireConsent(deps.db,job.proof_id,job.actor_id);
 const config=deps.rnd?.zk;if(!config)bad('RND_ZK_NOT_CONFIGURED','Configure isolated source keys and independently pinned verification keys first');
 const mode=job.input_json.parameters.mode;
 if(!['zk-enroll','zk-prove'].includes(String(mode))||sources.length!==1||job.input_json.sources[0].mimeType!=='image/png'||sources[0].byteLength>262144)bad('RND_ZK_PROFILE_UNSUPPORTED','Only one already committed canonical 4x4 or 8x8 RGB8 PNG is supported');
 const png=await readFile(sources[0].path);
 if(png.length<33||png.subarray(0,8).toString('hex')!=='89504e470d0a1a0a'||![4,8].includes(png.readUInt32BE(16))||png.readUInt32BE(16)!==png.readUInt32BE(20)||sha256Hex(png)!==sources[0].sha256)bad('RND_ZK_PROFILE_UNSUPPORTED','No resizing, extraction, or source substitution is permitted');
 const width=png.readUInt32BE(16),circuitId=`packproof-rgb8-opaque-${width}x${width}-v1`,registry=await pinnedRegistry(config.verificationRegistryFile),pinned=registry.profiles[circuitId];
 if(!pinned)bad('RND_ZK_UNKNOWN_CIRCUIT','This exact circuit is not pinned');
 const publicKey=createPublicKey(await readFile(config.sourcePublicKeyFile));if(publicKey.asymmetricKeyType!=='ed25519')bad('RND_ZK_TRUST_INVALID','Source issuer must be pinned Ed25519');
 const privateFile=await stat(config.sourcePrivateKeyFile);if(process.platform!=='win32'&&(privateFile.mode&0o077))bad('RND_ZK_KEY_PERMISSIONS','Private source signer must be owner-readable only');
 const witnessPath=path.join(directory,'private-witness.json'),bindingPath=path.join(directory,'source-binding.json');
 if(mode==='zk-enroll'){
  if(job.input_json.parameters.mask!==undefined||job.input_json.parameters.masks!==undefined)bad('RND_ZK_ENROLLMENT_MASK_FORBIDDEN','Commit the source before selecting a mask');
  let existing=(await deps.db.query<Enrollment>('SELECT * FROM rnd_zk_enrollments WHERE analysis_id=$1',[job.id])).rows[0];
  if(!existing){
   await run(config,[config.script,'commit-source',sources[0].path,config.sourcePrivateKeyFile,witnessPath,bindingPath],30000);
   const binding=parseStrictJson(await readFile(bindingPath,'utf8')) as {record:{commitment:string;sourceSha256:string;circuitId:string};keyId:string;signature:string};
   if(binding.record.sourceSha256!==sources[0].sha256||binding.record.circuitId!==circuitId||binding.keyId!==sha256Hex(publicKey.export({type:'spki',format:'der'}))||!verifySignature(null,Buffer.from(canonicalize(binding.record)),publicKey,Buffer.from(binding.signature,'base64')))bad('RND_ZK_SOURCE_BINDING_INVALID','Processor did not use pinned source key and committed original');
   const id=`rnd_zk_${job.id}`,createdAt=deps.clock.now().toISOString(),record={schemaVersion:'packproof.zk-enrollment.v1',id,analysisId:job.id,proofId:job.proof_id,sourceId:sources[0].sourceId,sourceSha256:sources[0].sha256,rootManifestDigest:`sha256:${job.root_digest}`,sourceBinding:binding,createdAt,qualification:'TRUSTED_PROCESSOR_CANONICAL_PIXELS_ONLY'};
   const signed=await signedRecord(deps,job.proof_id,id,record),privateWitness=await readFile(witnessPath,'utf8');
   await deps.db.query('INSERT INTO rnd_zk_enrollments(id,analysis_id,proof_id,tenant_id,source_id,root_digest,circuit_id,source_sha256,private_witness_json,source_binding_json,canonical_json,digest,signature,created_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) ON CONFLICT(analysis_id) DO NOTHING',[id,job.id,job.proof_id,job.tenant_id,sources[0].sourceId,job.root_digest,circuitId,sources[0].sha256,privateWitness,canonicalize(binding),signed.canonicalJson,signed.digest,JSON.stringify(signed.signature),createdAt]);
   existing=(await deps.db.query<Enrollment>('SELECT * FROM rnd_zk_enrollments WHERE analysis_id=$1',[job.id])).rows[0];
  }
  return {findingState:'RECORDED',observations:[{type:'RGB8_COMMITMENT_ENROLLED',sourceRefs:[{sourceId:sources[0].sourceId}],enrollmentId:existing.id,canonicalJson:existing.canonical_json,digest:existing.digest,signature:existing.signature}],coverage:{canonicalPixels:width*width,sourceCount:1},limitations:['The source commitment is a trusted processor assertion, not camera-sensor attestation.','No redaction relation has been proved by enrollment.','Private witness material is service-only and omitted from exports.']};
 }
 const enrollmentId=boundedId(job.input_json.parameters.enrollmentId,'ZK enrollment'),mask=job.input_json.parameters.mask;
 if(!Array.isArray(mask)||mask.length!==width*width||mask.some(x=>typeof x!=='boolean'))bad('RND_ZK_MASK_INVALID','Use one public boolean per canonical pixel');
 const enrolled=(await deps.db.query<Enrollment>(`SELECT e.* FROM rnd_zk_enrollments e JOIN rnd_analyses a ON a.id=e.analysis_id WHERE e.id=$1 AND e.proof_id=$2 AND e.tenant_id=$3 AND a.operational_state='SUCCEEDED'`,[enrollmentId,job.proof_id,job.tenant_id])).rows[0];
 if(!enrolled||enrolled.source_id!==sources[0].sourceId||enrolled.source_sha256!==sources[0].sha256||enrolled.root_digest!==job.root_digest||enrolled.circuit_id!==circuitId||enrolled.analysis_id===job.id)bad('RND_ZK_PRIOR_ENROLLMENT_REQUIRED','A completed earlier source enrollment bound to this exact root/source is required');
 if(activeProver)bad('RND_ZK_CONCURRENCY_LIMIT','Only one heavy prover per research worker process is allowed');
 activeProver=true;
 try{
  await writeFile(witnessPath,enrolled.private_witness_json,{mode:0o600,flag:'wx'});await writeFile(bindingPath,enrolled.source_binding_json,{mode:0o600,flag:'wx'});
  const maskPath=path.join(directory,'mask.json'),outDir=path.join(directory,'zk-public');await writeFile(maskPath,JSON.stringify(mask),{mode:0o600,flag:'wx'});
  const measured=await run(config,[config.script,'prove',witnessPath,bindingPath,maskPath,config.sourcePublicKeyFile,sources[0].sha256,outDir],config.timeoutMs);
  const proofBytes=await readFile(path.join(outDir,'proof.json')),image=await readFile(path.join(outDir,'output.png')),bundle=parseStrictJson(proofBytes.toString()) as Record<string,unknown>;
  if(bundle.circuitId!==circuitId||bundle.verificationKeyId!==pinned.verificationKeyId||bundle.outputSha256!==sha256Hex(image))bad('RND_ZK_UNTRUSTED_PROOF','Generated proof does not match independently pinned circuit/output');
  const trust={circuitId,verificationKeyId:pinned.verificationKeyId,verificationKey:pinned.verificationKey,expectedSourceSha256:sources[0].sha256,sourcePublicKeyPem:publicKey.export({type:'spki',format:'pem'}).toString()};
  const trustPath=path.join(directory,'trusted-verification.json');await writeFile(trustPath,JSON.stringify(trust),{mode:0o600,flag:'wx'});
  await run(config,[path.join(path.dirname(config.script),'verify.mjs'),path.join(outDir,'proof.json'),path.join(outDir,'output.png'),trustPath],30000);
  const recipe={policyVersion:'zk-rgb8-opaque-v1',width,height:width,format:'RGB8',mask,constant:[0,0,0],circuitId,verificationKeyId:pinned.verificationKeyId},record={schemaVersion:'packproof.redaction.v1',sourceSha256:sources[0].sha256,derivativeSha256:sha256Hex(image),recipe,recipeSha256:sha256Hex(canonicalize(recipe)),verificationLevel:'ZERO_KNOWLEDGE_TRANSFORM_PROOF',review:{state:'REQUIRED'},enrollmentId,proofBundle:bundle,securityReview:'PENDING',publicReliance:false};
  return {findingState:'RECORDED',observations:[{type:'ZERO_KNOWLEDGE_TRANSFORM_PROOF',sourceRefs:[{sourceId:sources[0].sourceId}],record,verificationLevel:'ZERO_KNOWLEDGE_TRANSFORM_PROOF',review:'REQUIRED'}],coverage:{canonicalPixels:width*width,sourceCount:1,reviewApproved:false},limitations:['Exact canonical RGB8 mask relation only; decoding/extraction and source issuer remain trusted.','No camera-sensor authenticity, privacy recall, or physical truth is proved.','Cryptographic specialist review pending; external derivative sharing requires human review.'],resourceUsage:{elapsedMs:measured.elapsedMs,peakRssBytes:measured.peakRssBytes,memoryCapBytes:MEMORY_CAP,concurrencyPerProcess:1},artifacts:[{path:'zk-public/output.png',sha256:sha256Hex(image),byteLength:image.length,mimeType:'image/png',sourceRefs:[{sourceId:sources[0].sourceId}],review:'REQUIRED'}]};
 }finally{activeProver=false;}
}
