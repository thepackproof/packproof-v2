import { spawn } from 'node:child_process';
import { mkdtemp,readFile,writeFile,rm,stat,realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { sha256Hex } from '../hash.js';
import { parseStrictJson,canonicalize } from '../../../packages/evidence-contracts/contracts.mjs';
import { bad } from './security.js';
import type { RndDeps,AnalysisRow,WorkerResult,Source } from './types.js';
import { evidenceMatrix } from './matrix.js';
import { getLearningSummary } from './learning-registry.js';
import { executeZkAnalysis } from './zk-service.js';

export async function boundedProcess(program:string,args:string[],timeoutMs=60_000,maxOutput=1_048_576,sandbox?:{program:string;args:string[]}):Promise<string> {
 return new Promise((resolve,reject)=>{
  const grouped=process.platform!=='win32';
  const child=spawn(sandbox?.program??program,sandbox?[...sandbox.args,program,...args]:args,{shell:false,detached:grouped,stdio:['ignore','pipe','pipe'],env:{PATH:process.env.PATH??'/usr/bin:/bin',HOME:tmpdir(),PYTHONNOUSERSITE:'1',PYTHONDONTWRITEBYTECODE:'1',OMP_NUM_THREADS:'1',OPENBLAS_NUM_THREADS:'1'}});
  let stdout='',count=0,settled=false,failure:string|null=null;
  const stop=(code:string)=>{if(settled||failure)return;failure=code;clearTimeout(timer);try{if(grouped&&child.pid)process.kill(-child.pid,'SIGKILL');else child.kill('SIGKILL');}catch{/* close/error owns settlement */}};
  const timer=setTimeout(()=>stop('RND_WORKER_TIMEOUT'),timeoutMs);
  child.stdout.on('data',(chunk:Buffer)=>{count+=chunk.length;if(count>maxOutput)stop('RND_WORKER_OUTPUT_LIMIT');else stdout+=chunk.toString('utf8');});
  child.stderr.on('data',(chunk:Buffer)=>{count+=chunk.length;if(count>maxOutput)stop('RND_WORKER_OUTPUT_LIMIT');});
  child.on('error',()=>{clearTimeout(timer);if(settled)return;settled=true;reject(Object.assign(new Error('Worker unavailable'),{code:'RND_WORKER_UNAVAILABLE'}));});
  child.on('close',code=>{clearTimeout(timer);if(settled)return;settled=true;if(failure||code!==0)reject(Object.assign(new Error('Worker execution failed'),{code:failure??'RND_WORKER_FAILED'}));else resolve(stdout);});
 });
}
async function witnessStage(program:string,args:string[],stage:'APPEND'|'INCLUSION'|'CHECKPOINT'|'CONSISTENCY'|'OPERATOR'|'VERIFICATION') {
 try{return await boundedProcess(program,args);}catch(error){
  const original=error&&typeof error==='object'&&'code'in error?String(error.code):'';
  const reason=original==='RND_WORKER_TIMEOUT'?'TIMEOUT':original==='RND_WORKER_UNAVAILABLE'?'UNAVAILABLE':original==='RND_WORKER_OUTPUT_LIMIT'?'OUTPUT_LIMIT':'FAILED';
  throw Object.assign(new Error('Research witness stage requires attention'),{code:`RND_WITNESS_${stage}_${reason}`});
 }
}
export async function materializeSources(deps:RndDeps,sources:Source[],directory:string) {
 const total=sources.reduce((n,s)=>n+s.byteLength,0);
 if(total>(deps.rnd?.worker?.maxInputBytes??128*1024*1024))bad('RND_RESOURCE_LIMIT','Combined original bytes exceed the worker budget');
 return Promise.all(sources.map(async(s,index)=>{
  const original=await deps.objectStore.get(s.objectKey,{versionId:s.objectVersionId.startsWith('content-addressed:')?null:s.objectVersionId});
  if(!original||original.body.length!==s.byteLength||sha256Hex(original.body)!==s.sha256)bad('RND_SOURCE_INTEGRITY','Source changed or expired before analysis');
  const sourcePath=path.join(directory,`source-${index}${s.mimeType.startsWith('video/')?'.mp4':s.mimeType==='image/png'?'.png':s.mimeType==='image/jpeg'?'.jpg':s.mimeType==='image/x-portable-graymap'?'.pgm':'.bin'}`);
  await writeFile(sourcePath,original.body,{mode:0o600,flag:'wx'});
  return {sourceId:s.sourceId,path:sourcePath,sha256:s.sha256,byteLength:s.byteLength,objectVersionId:s.objectVersionId,mediaType:s.mimeType,mimeType:s.mimeType,captureSessionId:s.captureSessionId,legId:s.legId,packageInstanceId:s.packageInstanceId,...(s.relationship?{relationship:s.relationship}:{}),...(s.frameReference?{frameReference:s.frameReference}:{})};
 }));
}
function validateOutput(result:unknown,job:AnalysisRow):asserts result is WorkerResult {
 if(!result||typeof result!=='object')bad('RND_WORKER_OUTPUT_INVALID','Worker did not return a result');
 const r=result as WorkerResult;
 if(!['RECORDED','INCONCLUSIVE','NOT_CHECKED','UNSUPPORTED'].includes(r.findingState)||!Array.isArray(r.observations)||r.observations.length>1000||!r.coverage||Array.isArray(r.coverage)||!Array.isArray(r.limitations)||r.limitations.some(s=>typeof s!=='string'))bad('RND_WORKER_OUTPUT_INVALID','Worker result violates the unqualified profile');
 const sourceIds=new Set(job.input_json.sources.map(s=>s.sourceId));
 if('schemaVersion' in r&&(r.schemaVersion!=='packproof.vision-result.v1'||(r as unknown as Record<string,unknown>).feature!==job.feature||(r as unknown as Record<string,unknown>).analysisId!==job.id||(r as unknown as Record<string,unknown>).operationalState!=='SUCCEEDED'))bad('RND_WORKER_OUTPUT_INVALID','Worker result identity does not match its lease');
 for(const observation of r.observations){
  if(!observation||typeof observation!=='object'||!Array.isArray(observation.sourceRefs)||observation.sourceRefs.length===0)bad('RND_WORKER_OUTPUT_INVALID','Each observation requires source references');
  validateRefs(observation.sourceRefs as unknown[],job);
 }
 canonicalize(r);
}
function validateRefs(refs:unknown[],job:AnalysisRow) {
 for(const raw of refs){const ref=typeof raw==='string'?{sourceId:raw}:raw as Record<string,unknown>;
  const source=job.input_json.sources.find(s=>s.sourceId===ref?.sourceId);
  if(!source||ref.sha256!==undefined&&String(ref.sha256).replace(/^sha256:/,'')!==source.sha256||ref.objectVersionId!==undefined&&ref.objectVersionId!==source.objectVersionId)bad('RND_WORKER_OUTPUT_INVALID','Worker attempted to reference unrelated or changed evidence');
 }
}
async function persistArtifacts(deps:RndDeps,job:AnalysisRow,result:WorkerResult,directory:string) {
 const artifacts=result.artifacts??[];
 if(!Array.isArray(artifacts)||artifacts.length>65)bad('RND_WORKER_OUTPUT_INVALID','Invalid artifact inventory');
 const output=[];let total=0;
 for(const artifact of artifacts){
  if(!Array.isArray(artifact.sourceRefs)||artifact.sourceRefs.length===0)bad('RND_WORKER_OUTPUT_INVALID','Artifact requires original source references');validateRefs(artifact.sourceRefs,job);
  if(typeof artifact.path!=='string'||path.isAbsolute(artifact.path))bad('RND_WORKER_OUTPUT_INVALID','Artifact path must be relative');
  const file=await realpath(path.resolve(directory,artifact.path));
  if(!file.startsWith((await realpath(directory))+path.sep))bad('RND_WORKER_OUTPUT_INVALID','Artifact escaped worker sandbox');
  const info=await stat(file);total+=info.size;
  if(!info.isFile()||total>16*1024*1024)bad('RND_WORKER_OUTPUT_INVALID','Artifact bytes exceed budget');
  const bytes=await readFile(file),hash=sha256Hex(bytes);
  if(hash!==String(artifact.sha256).replace(/^sha256:/,'')||bytes.length!==artifact.byteLength)bad('RND_WORKER_OUTPUT_INVALID','Artifact hash mismatch');
  const key=`staging/rnd/${job.tenant_id.replace(/[^a-zA-Z0-9_-]/g,'_')}/${job.id}/${hash}`;
  await deps.objectStore.put(key,bytes,String(artifact.mimeType??'application/octet-stream'));
  const committed=await deps.objectStore.commitUpload(key,{sha256:hash,byteSize:bytes.length});
  if(!committed||committed.sha256!==hash)bad('RND_ARTIFACT_COMMIT_FAILED','Derivative could not be committed');
  const {path:discarded,...metadata}=artifact;
  output.push({...metadata,objectKey:committed.key,objectVersionId:committed.versionId??`content-addressed:${hash}`,sha256:hash,byteLength:bytes.length,retentionState:'AVAILABLE'});
 }
 result.artifacts=output;
}
/** Adapts immutable core observations only when their source/leg association is explicit. */
export async function shipmentObservations(deps:RndDeps,job:Pick<AnalysisRow,'input_json'|'proof_id'|'root_digest'>):Promise<Record<string,unknown>[]> {
 const observations:Record<string,unknown>[]=[];
 const rows=(await deps.db.query<Record<string,unknown>>('SELECT id,sha256,source,provider,event_type,event_data,observed_at,core_manifest_sha256 FROM shipment_events WHERE proof_id=$1 ORDER BY observed_at,id LIMIT 250',[job.proof_id])).rows;
 for(const row of rows){
  const data=row.event_data as Record<string,unknown>;
  if(!data||row.core_manifest_sha256&&row.core_manifest_sha256!==job.root_digest)continue;
  const bound=job.input_json.sources.filter(source=>data.sourceId===source.sourceId||data.evidenceId===source.evidenceId||data.legId===source.legId);
  if(bound.length!==1)continue;
  const provenance={recordId:row.id,recordDigest:row.sha256,provider:row.provider,providerSource:row.source,observedAt:new Date(row.observed_at as string).toISOString(),attribution:row.source==='PARTICIPANT_SUPPLIED'?'PARTICIPANT_STATEMENT':'PROVIDER_REPORT',sourceRefs:[{sourceId:bound[0].sourceId}],findingState:'RECORDED',qualified:false};
  if(typeof data.trackingNumber==='string'&&data.trackingNumber.length<=200)observations.push({...provenance,type:'REPORTED_TRACKING_IDENTIFIER',channel:'tracking',value:{trackingNumber:data.trackingNumber,carrier:typeof data.carrier==='string'?data.carrier:null}});
  const weight=(data.weight??data.reportedWeight) as Record<string,unknown>|undefined;
  const unit=typeof weight?.unit==='string'?weight.unit.toLowerCase():null,amount=weight?.value;
  const factors:Record<string,number>={g:1,kg:1000,oz:28.349523125,lb:453.59237};
  if(typeof amount==='number'&&Number.isFinite(amount)&&amount>=0&&unit&&factors[unit]&&amount*factors[unit]<=1e9)observations.push({...provenance,type:'REPORTED_MASS',channel:'weight',value:{reportedValue:amount,reportedUnit:unit,grams:amount*factors[unit],measurementAssurance:'UNVERIFIED_REPORT',calibration:null}});
 }
 const sessions=job.input_json.sources.map(s=>s.captureSessionId).filter(Boolean);
 const labels=(await deps.db.query<Record<string,unknown>>('SELECT id,session_id,tracking_number,carrier_hint,detected_at_ms,barcode_format,received_at FROM capture_label_observations WHERE proof_id=$1 AND session_id=ANY($2::text[]) ORDER BY received_at,id LIMIT 100',[job.proof_id,sessions])).rows;
 for(const label of labels){const source=job.input_json.sources.find(s=>s.captureSessionId===label.session_id);if(source)observations.push({type:'CAPTURE_LABEL_READING',channel:'tracking',sourceRefs:[{sourceId:source.sourceId,timeMs:label.detected_at_ms}],findingState:'RECORDED',qualified:false,attribution:'CLIENT_REPORTED_DECODER',recordId:label.id,observedAt:new Date(label.received_at as string).toISOString(),value:{trackingNumber:label.tracking_number,carrier:label.carrier_hint,barcodeFormat:label.barcode_format},limitations:['Client-reported label decoding is an observation, not an independently authenticated label or parcel identity.']});}
 return observations;
}
export async function executeVision(deps:RndDeps,job:AnalysisRow,mediaOnly=false):Promise<WorkerResult> {
 if(job.feature==='proofcollective')return getLearningSummary(deps,job);
 if(job.feature==='proofwitness'){
  const witness=deps.rnd?.witness;if(!witness)bad('RND_SERVICE_IDENTITY_REQUIRED','Configure the private witness service identity and pinned trust policy');
  const directory=await mkdtemp(path.join(tmpdir(),'packproof-witness-'));
  try{
   const policy=parseStrictJson(await readFile(witness.trustPolicyFile,'utf8')) as Record<string,unknown>;
   const params=job.input_json.parameters;
   const receipt=parseStrictJson(await witnessStage(witness.python,[witness.script,'append','--record-digest',String(params.recordDigest),'--blind',String(params.blind),'--log-db',witness.logDb,'--log-key',witness.logKey,'--log-id',witness.logId,'--policy-id',String(policy.policyId)],'APPEND')) as Record<string,unknown>;
   const receiptPath=path.join(directory,'receipt.json');await writeFile(receiptPath,canonicalize(receipt),{mode:0o600});
   let verification=parseStrictJson(await witnessStage(witness.python,[witness.script,'verify-inclusion',receiptPath,'--policy',witness.trustPolicyFile,'--record-digest',String(params.recordDigest)],'INCLUSION')) as Record<string,unknown>;
   if(verification.valid!==true||verification.publicationState!=='INCLUDED')bad('RND_WITNESS_INVALID','Log inclusion could not be independently verified');
   if(witness.operators){
    const required=policy.requiredOperators,keys=Object.values(policy.witnessKeys as Record<string,Record<string,unknown>>??{});
    if(witness.operators.length!==2||new Set(witness.operators.map(o=>o.operatorId)).size!==2||policy.testOnly!==true||!Array.isArray(required)||required.length!==2||witness.operators.some(o=>!required.includes(o.operatorId)||!keys.some(k=>k.operatorId===o.operatorId&&k.testOnly===true&&k.independent===false)))bad('RND_WITNESS_POLICY','Locally controlled witness keys require two named test-only, non-independent trust entries');
    const checkpoint=receipt.checkpoint as Record<string,unknown>,signatures:unknown[]=[],links:unknown[]=[];
    for(const [index,operator] of witness.operators.entries()){
     const previous=parseStrictJson(await witnessStage(witness.python,[witness.script,'checkpoint','--state-db',operator.stateDb,'--log-id',witness.logId,'--operator-id',operator.operatorId],'CHECKPOINT')) as Record<string,unknown>|null;
     const args=[witness.script,'witness',receiptPath,'--policy',witness.trustPolicyFile,'--state-db',operator.stateDb,'--key',operator.keyFile,'--operator-id',operator.operatorId];
     if(previous&&Number(previous.treeSize)<Number(checkpoint.treeSize)){
      const proof=parseStrictJson(await witnessStage(witness.python,[witness.script,'consistency','--log-db',witness.logDb,'--old-size',String(previous.treeSize),'--new-size',String(checkpoint.treeSize)],'CONSISTENCY'));
      const proofPath=path.join(directory,`consistency-${index}.json`);await writeFile(proofPath,canonicalize(proof),{mode:0o600});args.push('--consistency-proof',proofPath);links.push({previousCheckpoint:previous,checkpoint,proof});
     }
     signatures.push(parseStrictJson(await witnessStage(witness.python,args,'OPERATOR')));
    }
    receipt.witnessSignatures=signatures;receipt.consistencyLinks=links;receipt.publicationState='WITNESSED';
    await writeFile(receiptPath,canonicalize(receipt),{mode:0o600});
    verification=parseStrictJson(await witnessStage(witness.python,[witness.script,'verify',receiptPath,'--policy',witness.trustPolicyFile,'--record-digest',String(params.recordDigest)],'VERIFICATION')) as Record<string,unknown>;
    if(verification.valid!==true||verification.assurance!=='TEST_WITNESSED'||verification.independentOperatorCount!==0)bad('RND_WITNESS_INVALID','Controlled witness verification failed');
   }
   const {blind,recordDigest,...parameters}=params;
   const committedRecord={...job.input_json,parameters};
   if(sha256Hex(canonicalize(committedRecord))!==recordDigest)bad('RND_WITNESS_INVALID','Witness opening does not bind the exact exported record');
   return {findingState:'RECORDED',observations:[{type:'TRANSPARENCY_LOG_INCLUSION',sourceRefs:job.input_json.sources.map(s=>({sourceId:s.sourceId})),receipt,verification,committedRecord}],coverage:{committedRecords:1,controlledTestWitnesses:witness.operators?.length??0,independentWitnesses:0},limitations:['Private log inclusion and locally controlled test witnesses are not independent witnessing.','This receipt does not authenticate scene truth or prove all evidence was submitted.']};
  }finally{await rm(directory,{recursive:true,force:true});}
 }
 if(job.feature==='proofmatch'&&!mediaOnly){
  const supporting=(await deps.db.query<AnalysisRow>('SELECT * FROM rnd_analyses WHERE id=ANY($1::text[]) AND proof_id=$2 AND tenant_id=$3 AND operational_state=\'SUCCEEDED\'',[job.input_json.relatedAnalysisIds,job.proof_id,job.tenant_id])).rows;
  const extra=[...(Array.isArray(job.input_json.parameters.shipmentObservations)?job.input_json.parameters.shipmentObservations:[])] as Record<string,unknown>[];
  let appearance:WorkerResult|undefined,appearanceFailure:string|null=null;
  if(deps.rnd?.worker){try{appearance=await executeVision(deps,job,true);extra.push(...appearance.observations);}catch(error){appearanceFailure=error&&typeof error==='object'&&'code'in error?String(error.code):'RND_WORKER_FAILED';}}
  const result=evidenceMatrix(job,supporting,extra);result.artifacts=appearance?.artifacts??[];
  result.diagnostics={...result.diagnostics,appearanceOperationalState:appearance?'SUCCEEDED':appearanceFailure?'FAILED':'NOT_CONFIGURED',appearanceErrorCode:appearanceFailure};
  result.provenance=appearance?.provenance??{};return result;
 }
 if(job.feature==='verifiedcapture'){
  const sessions=job.input_json.sources.map(s=>s.captureSessionId).filter(Boolean);
  const receipts=(await deps.db.query<{canonical_json:string;digest:string;signature:unknown}>(`SELECT r.canonical_json,r.digest,r.signature FROM rnd_session_receipts r JOIN rnd_session_starts s ON s.intent_id=r.intent_id WHERE s.capture_session_id=ANY($1::text[])`,[sessions])).rows;
  return {findingState:receipts.length?'RECORDED':'NOT_CHECKED',observations:receipts.map(r=>({type:'CAPTURE_RECEIPT',channel:'provenance',sourceRefs:job.input_json.sources.map(s=>({sourceId:s.sourceId})),receipt:JSON.parse(r.canonical_json),digest:r.digest,signature:r.signature})),coverage:{receivedInventories:receipts.length,requestedSources:job.input_json.sources.length},limitations:['Valid file commitments do not authenticate the physical scene.','No hardware assurance is inferred from the acquisition platform.']};
 }
 const config=deps.rnd?.worker;if(!config)bad('RND_WORKER_UNAVAILABLE','Configure the bounded isolated research worker');
 const directory=await mkdtemp(path.join(tmpdir(),'packproof-rnd-'));
 try {
  const sources=await materializeSources(deps,job.input_json.sources,directory);
  const trustedModels:Record<string,unknown>={};
  if(job.feature==='proofsight'&&config.proofsightModel){
   const model=config.proofsightModel,info=await stat(model.path);if(!info.isFile()||info.size>4*1024*1024)bad('RND_MODEL_INVALID','Pinned numerical model exceeds the model budget');
   const bytes=await readFile(model.path);if(sha256Hex(bytes)!==model.sha256)bad('RND_MODEL_INVALID','Model bytes differ from the server-pinned release');parseStrictJson(bytes.toString('utf8'),4*1024*1024);
   const modelPath=path.join(directory,'proofsight-model.json');await writeFile(modelPath,bytes,{mode:0o400});trustedModels.proofsight={path:modelPath,sha256:model.sha256,releaseId:model.releaseId};
  }
  const input={schemaVersion:'packproof.vision-job.v1',feature:job.feature,analysisId:job.id,sandboxRoot:directory,sources,binding:{tenantId:job.tenant_id,proofId:job.proof_id,rootManifestDigest:`sha256:${job.root_digest}`,subject:job.input_json.subject},policyVersion:job.input_json.policyVersion,parameters:job.input_json.parameters,trustedModels};
  const inputPath=path.join(directory,'job.json'),outputPath=path.join(directory,'result.json');
  await writeFile(inputPath,canonicalize(input),{mode:0o600});
  if(job.feature==='proofshield'){
   if(['zk-enroll','zk-prove'].includes(String(job.input_json.parameters.mode))){const result=await executeZkAnalysis(deps,job,sources,directory);await persistArtifacts(deps,job,result,directory);return result;}
   if(job.input_json.parameters.mode!==undefined&&job.input_json.parameters.mode!=='redact')bad('RND_UNSUPPORTED_PRIVACY_MODE','Unknown privacy transformation mode');
   if(sources.length!==1)bad('RND_INVALID_SOURCES','Redaction requires one source per derivative');
   const masksPath=path.join(directory,'masks.json');await writeFile(masksPath,JSON.stringify(job.input_json.parameters.masks??[]),{mode:0o600});
   const derivative=path.join(directory,job.input_json.parameters.kind==='video'?'derivative.mp4':'derivative.png');
   const privacyScript=path.resolve(path.dirname(config.script),'../privacy/redact.py');
   const stdout=await boundedProcess(config.python,[privacyScript,'create',sources[0].path,derivative,'--masks',masksPath,'--kind',String(job.input_json.parameters.kind??'still'),'--unsigned-record'],config.timeoutMs,1_048_576,config.sandbox);
   const parsed=parseStrictJson(stdout) as Record<string,unknown>,record=parsed.record as Record<string,unknown>;
   const bytes=await readFile(derivative);
   if(!record||String(record.sourceSha256).replace(/^sha256:/,'')!==sources[0].sha256||String(record.derivativeSha256).replace(/^sha256:/,'')!==sha256Hex(bytes))bad('RND_WORKER_OUTPUT_INVALID','Redaction lineage does not match committed bytes');
   const result:WorkerResult={findingState:'RECORDED',observations:[{type:'SIGNED_TRANSFORMATION_RECORD',sourceRefs:[{sourceId:sources[0].sourceId}],record,review:'REQUIRED',verificationLevel:'SIGNED_TRANSFORMATION_RECORD'}],coverage:{sourceCount:1,reviewApproved:false},limitations:['Human privacy review is required before external sharing.','A signed transformation record is not a zero-knowledge proof.','Original media remains access-controlled.'],artifacts:[{path:path.basename(derivative),sha256:sha256Hex(bytes),byteLength:bytes.length,mimeType:derivative.endsWith('.mp4')?'video/mp4':'image/png',sourceRefs:[{sourceId:sources[0].sourceId}],review:'REQUIRED'}]};
   await persistArtifacts(deps,job,result,directory);return result;
  }
  await boundedProcess(config.python,[config.script,'--job',inputPath,'--output',directory],config.timeoutMs,1_048_576,config.sandbox);
  const outputInfo=await stat(outputPath);if(outputInfo.size>1_048_576)bad('RND_WORKER_OUTPUT_LIMIT','Result exceeds size policy');
  const result=parseStrictJson(await readFile(outputPath,'utf8'));
  validateOutput(result,job);result.provenance={...result.provenance,processContainment:config.sandbox?'CONFIGURED_OS_SANDBOX_REQUIRES_DEPLOYMENT_VALIDATION':'BOUNDED_SUBPROCESS_ONLY_NO_NETWORK_SANDBOX',parentProcessGroupTermination:process.platform!=='win32'};await persistArtifacts(deps,job,result,directory);return result;
 } finally {await rm(directory,{recursive:true,force:true});}
}
