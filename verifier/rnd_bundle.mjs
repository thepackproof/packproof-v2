#!/usr/bin/env node
/** Offline R&D verifier. No network or signing secrets; supplied bundle keys are ignored. */
import { createHash,createPublicKey,verify,constants } from 'node:crypto';
import { readFile,stat,realpath } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { canonicalize,parseStrictJson,assertAnalysisEnvelope,assertEvidenceExtension } from '../packages/evidence-contracts/contracts.mjs';
const MAX_JSON=64*1024*1024,MAX_FILES=1024,MAX_TOTAL_BYTES=220*1024*1024;
const fail=(code)=>{throw Error(code);};
export const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const digest=s=>typeof s==='string'&&/^(?:sha256:)?[a-f0-9]{64}$/.test(s)?s.replace(/^sha256:/,''):fail('INVALID_DIGEST');
const array=(x)=>Array.isArray(x)&&x.length<=MAX_FILES?x:fail('INVALID_OR_OVERSIZED_ARRAY');
const date=s=>typeof s==='string'&&/(?:Z|[+-]\d{2}:\d{2})$/.test(s)&&Number.isFinite(Date.parse(s))?Date.parse(s):fail('INVALID_DATE');
const equal=(a,b)=>canonicalize(a)===canonicalize(b);
function publicTrust(trust,now){
 if(trust?.schema!=='packproof.trust-list.v1')fail('EXPLICIT_TRUST_SNAPSHOT_REQUIRED');
 const from=date(trust.generatedAt),until=date(trust.expiresAt);
 if(from>now||until<=now||until<=from)fail('TRUST_SNAPSHOT_EXPIRED_OR_NOT_YET_VALID');
 const keys=new Map();
 for(const entry of array(trust.keys)){
  if(typeof entry.keyId!=='string'||keys.has(entry.keyId)||!['ECDSA_SHA_256','RSASSA_PSS_SHA_256','Ed25519'].includes(entry.algorithm)||typeof entry.publicKeyPem!=='string'||entry.publicKeyPem.includes('PRIVATE')||entry.publicKeyPem.length>32768)fail('INVALID_TRUST_KEY');
  const key=createPublicKey(entry.publicKeyPem);
  if(entry.algorithm==='ECDSA_SHA_256'&&(key.asymmetricKeyType!=='ec'||key.asymmetricKeyDetails?.namedCurve!=='prime256v1'))fail('KEY_ALGORITHM_MISMATCH');
  if(entry.algorithm==='RSASSA_PSS_SHA_256'&&(key.asymmetricKeyType!=='rsa'||key.asymmetricKeyDetails.modulusLength<2048))fail('KEY_ALGORITHM_MISMATCH');
  if(entry.algorithm==='Ed25519'&&key.asymmetricKeyType!=='ed25519')fail('KEY_ALGORITHM_MISMATCH');
  keys.set(entry.keyId,{...entry,key});
 }
 return keys;
}
function signature(raw,sig,keys,now){
 if(!sig||typeof sig.keyId!=='string')fail('SIGNATURE_REQUIRED');
 const entry=keys.get(sig.keyId);
 if(!entry||entry.algorithm!==sig.algorithm)fail('UNKNOWN_OR_MISMATCHED_SIGNER');
 if(entry.status!=='ACTIVE'||entry.revoked===true)fail('SIGNER_NOT_ACTIVE');
 const signedAt=date(sig.signedAt);
 if(signedAt>now+300000)fail('SIGNATURE_TIME_IN_FUTURE');
 if(entry.validFrom&&(date(entry.validFrom)>now||signedAt<date(entry.validFrom)))fail('SIGNER_NOT_YET_VALID');
 if(entry.validUntil&&(date(entry.validUntil)<=now||signedAt>date(entry.validUntil)))fail('SIGNER_EXPIRED');
 if(typeof sig.signatureBase64!=='string'||sig.signatureBase64.length>16384||!/^[A-Za-z0-9+/]+={0,2}$/.test(sig.signatureBase64))fail('INVALID_SIGNATURE_ENCODING');
 const bytes=Buffer.from(sig.signatureBase64,'base64');if(bytes.toString('base64')!==sig.signatureBase64)fail('NONCANONICAL_SIGNATURE_ENCODING');
 const options=sig.algorithm==='RSASSA_PSS_SHA_256'?{key:entry.key,padding:constants.RSA_PKCS1_PSS_PADDING,saltLength:32}:entry.key;
 if(!verify(sig.algorithm==='Ed25519'?null:'sha256',Buffer.from(raw),options,bytes))fail('INVALID_SIGNATURE');
 return {keyId:sig.keyId,algorithm:sig.algorithm,signatureVerified:true};
}
function signed(wrapper,keys,now,jcs=true){
 if(!wrapper||typeof wrapper.canonicalJson!=='string'||Buffer.byteLength(wrapper.canonicalJson)>MAX_JSON)fail('SIGNED_RECORD_REQUIRED');
 if(sha(wrapper.canonicalJson)!==digest(wrapper.digest))fail('SIGNED_RECORD_DIGEST_MISMATCH');
 const record=parseStrictJson(wrapper.canonicalJson,MAX_JSON);
 if(jcs&&canonicalize(record)!==wrapper.canonicalJson)fail('NONCANONICAL_RESEARCH_RECORD');
 signature(wrapper.canonicalJson,wrapper.signature,keys,now);return record;
}
function sameSource(ref,source,proofId){
 if(!ref||!source||ref.sourceId!==source.sourceId||ref.proofId&&ref.proofId!==proofId||digest(ref.sha256)!==digest(source.sha256)||ref.byteLength!==source.byteLength||ref.objectVersionId!==source.objectVersionId||ref.objectKey!==source.objectKey||ref.mimeType!==source.mimeType)fail('SOURCE_INVENTORY_BINDING_MISMATCH');
}
function frameCommitment(f){
 if(!f||!/^research-frame-[0-5]\.pgm$/.test(f.fileName)||!/^[a-f0-9]{64}$/.test(f.sha256)||!Number.isSafeInteger(f.byteLength)||f.byteLength<1||f.byteLength>2097216||!Number.isSafeInteger(f.width)||!Number.isSafeInteger(f.height)||f.width<2||f.height<2||f.width*f.height>2097152||!Number.isSafeInteger(f.mediaTimeMs)||f.mediaTimeMs<0||f.mediaTimeMs>86400000||f.relationship!=='CONCURRENT_CAPTURED_SIDECAR'||f.transform!=='NATIVE_LUMA_PLANE_PGM_NO_RESIZE')fail('SIDECAR_FRAME_COMMITMENT_INVALID');
 return f;
}
function acquisitionFrames(bytes){
 const metadata=parseStrictJson(bytes.toString('utf8'),2097216),names=new Set();
 if(metadata.schemaVersion!=='packproof.native-acquisition.v1'||metadata.mode!=='PASSIVE'||!Array.isArray(metadata.frames)||metadata.frames.length>6)fail('SIDECAR_ACQUISITION_INVALID');
 for(const f of metadata.frames){frameCommitment(f);if(names.has(f.fileName))fail('SIDECAR_ACQUISITION_DUPLICATE_FRAME');names.add(f.fileName);}
 return metadata.frames;
}
export async function verifyResearchBundle(bundle,{trust,baseDir=null,now=Date.now()}={}){
 const keys=publicTrust(trust,now);
 if(bundle?.schemaVersion!=='packproof.rnd-export.v1'||typeof bundle.proofId!=='string')fail('UNSUPPORTED_BUNDLE');
 const root=signed(bundle.root,keys,now,false); // Existing sealed root bytes are NOT recanonicalized.
 if(root.proofId!==bundle.proofId||root.manifestVersion!==1)fail('ROOT_PROOF_BINDING_MISMATCH');
 const sources=array(bundle.sources),inventory=new Map(),archivePaths=new Set();
 for(const source of sources){
  if(!source||typeof source.sourceId!=='string'||inventory.has(source.sourceId)||!Number.isSafeInteger(source.byteLength)||source.byteLength<1||source.byteLength>MAX_TOTAL_BYTES||typeof source.archivePath!=='string'||!/^originals\/[A-Za-z0-9_-]+\.bin$/.test(source.archivePath)||archivePaths.has(source.archivePath))fail('INVALID_SOURCE_INVENTORY');
  digest(source.sha256);inventory.set(source.sourceId,source);archivePaths.add(source.archivePath);
  const original=array(root.evidence??[]).find(e=>e.evidenceId===source.evidenceId);
  if(original&&(digest(original.sha256)!==digest(source.sha256)||original.byteSize!==source.byteLength||original.objectKey!==source.objectKey||(original.objectVersionId&&original.objectVersionId!==source.objectVersionId)))fail('ROOT_SOURCE_BINDING_MISMATCH');
 }
 const extensions=array(bundle.extensions),seenAnalysis=new Set(),analysesById=new Map(),expectedArtifacts=[];let previous=null,tenant=null;
 for(let i=0;i<extensions.length;i++){
  const e=assertEvidenceExtension(signed(extensions[i],keys,now));
  if(e.schemaVersion!=='packproof.extension.v1'||e.proofId!==bundle.proofId||digest(e.rootManifestDigest)!==digest(bundle.root.digest)||e.sequence!==i+1||(previous===null?e.previousDigest!==null:digest(e.previousDigest)!==previous))fail('EXTENSION_CHAIN_MISMATCH');
  if(tenant===null)tenant=e.tenantId;else if(tenant!==e.tenantId)fail('CROSS_TENANT_EXTENSION');
  const a=assertAnalysisEnvelope(e.analysis);
  if(a.proofId!==bundle.proofId||a.tenantId!==e.tenantId||digest(a.rootManifestDigest)!==digest(bundle.root.digest)||seenAnalysis.has(a.analysisId))fail('ANALYSIS_BINDING_MISMATCH');
  if(!a.details?.input||sha(canonicalize(a.details.input))!==digest(a.inputDigest)||a.details.input.proofId!==a.proofId||a.details.input.tenantId!==a.tenantId||a.details.input.feature!==a.feature||digest(a.details.input.rootManifestDigest)!==digest(bundle.root.digest))fail('ANALYSIS_INPUT_BINDING_MISMATCH');
  const input=a.details.input,subject=input.subject,inputSources=array(input.sources);
  if(!subject||typeof subject.id!=='string'||!subject.id||subject.proofId!==a.proofId||subject.tenantId!==a.tenantId||subject.packageInstanceId!==a.subject.packageInstanceId||subject.legId!==a.subject.shipmentLegId||!inputSources.length||inputSources.length!==a.sourceRefs.length)fail('ANALYSIS_SUBJECT_BINDING_MISMATCH');
  const pairFeature=['proofprint','prooftwin','proofmatch'].includes(a.feature);
  if(a.feature==='proofmatch'&&(inputSources.length!==2||inputSources[0].legId===inputSources[1].legId))fail('COMPARISON_SUBJECT_RELATION_INVALID');
  for(const [sourceIndex,src] of inputSources.entries()){
   sameSource(src,inventory.get(src.sourceId),bundle.proofId);
   if(src.proofId!==a.proofId||src.tenantId!==a.tenantId||typeof src.subjectId!=='string'||!src.subjectId||typeof src.legId!=='string'||!src.legId||typeof src.packageInstanceId!=='string'||!src.packageInstanceId||src.sourceId!==a.sourceRefs[sourceIndex].sourceId)fail('ANALYSIS_SOURCE_SUBJECT_MISMATCH');
   const sameSubject=src.subjectId===subject.id&&src.legId===subject.legId&&src.packageInstanceId===subject.packageInstanceId;
   if(!sameSubject&&!(pairFeature&&sourceIndex===1&&inputSources.length===2&&src.legId!==subject.legId&&src.subjectId!==subject.id))fail('ANALYSIS_SOURCE_SUBJECT_MISMATCH');
  }
  seenAnalysis.add(a.analysisId);analysesById.set(a.analysisId,a);
  for(const ref of a.sourceRefs)sameSource(ref,inventory.get(ref.sourceId),bundle.proofId);
  if(a.feature!=='proofshield')for(const [index,artifact] of array(a.details?.artifacts??[]).entries())expectedArtifacts.push({...artifact,archivePath:`artifacts/${a.analysisId}/${index}.bin`});
  previous=digest(extensions[i].digest);
 }
 const captureIntents=array(bundle.captureIntents),intentDigests=[],intentsById=new Map();
 for(const wrapper of captureIntents){
  const intent=signed(wrapper,keys,now);
  if(intent.schemaVersion!=='packproof.capture-intent.v1'||intent.proofId!==bundle.proofId||tenant&&intent.tenantId!==tenant||!intent.subject||intent.subject.proofId!==bundle.proofId||intent.subject.tenantId!==intent.tenantId||intentsById.has(intent.id)||!['ONLINE','OFFLINE'].includes(intent.acquisitionMode)||date(intent.expiresAt)<=date(intent.issuedAt))fail('CAPTURE_INTENT_BINDING_MISMATCH');
  const binding={proofId:intent.proofId,subject:intent.subject,actorId:intent.actorId,profileId:intent.profileId,nonce:intent.nonce,acquisitionMode:intent.acquisitionMode};
  if(sha(canonicalize(binding))!==digest(intent.requestBindingDigest))fail('CAPTURE_INTENT_REQUEST_BINDING_MISMATCH');
  intentsById.set(intent.id,{record:intent,digest:digest(wrapper.digest)});intentDigests.push(digest(wrapper.digest));
 }
 const receipts=array(bundle.captureReceipts),receiptDigests=[],receiptsByDigest=new Map(),nativeInventoriesByReceipt=new Map();
 for(const wrapper of receipts){
  const r=signed(wrapper,keys,now);
  if(r.schemaVersion!=='packproof.capture-receipt.v1'||r.proofId!==bundle.proofId||tenant&&r.tenantId!==tenant||sha(canonicalize(r.sources))!==digest(r.sourceInventoryDigest))fail('CAPTURE_RECEIPT_BINDING_MISMATCH');
  const intent=intentsById.get(r.intentId);
  if(!intent||intent.digest!==digest(r.intentDigest)||!equal(intent.record.subject,r.subject))fail('CAPTURE_RECEIPT_INTENT_MISMATCH');
  for(const src of array(r.sources)){sameSource(src,inventory.get(src.sourceId),bundle.proofId);if(src.captureSessionId!==r.captureSessionId)fail('CAPTURE_SESSION_MISMATCH');}
  if(r.clientInventory){
   const ci=r.clientInventory,cr=parseStrictJson(ci.canonicalJson);
   const ck=createPublicKey(ci.publicKeyPem);
   if(ck.asymmetricKeyType!=='ec'||ck.asymmetricKeyDetails?.namedCurve!=='prime256v1'||canonicalize(cr)!==ci.canonicalJson||cr.schemaVersion!=='packproof.native-final-file.v1'||cr.proofId!==bundle.proofId||cr.intentId!==r.intentId||cr.captureSessionId!==r.captureSessionId||cr.chainCoverage!=='FINAL_FILE_ONLY'||r.sources.length!==1||digest(cr.mediaSha256)!==digest(r.sources[0].sha256)||cr.mediaByteLength!==r.sources[0].byteLength||!verify('sha256',Buffer.from(ci.canonicalJson),ck,Buffer.from(ci.signatureBase64,'base64')))fail('CLIENT_INVENTORY_SIGNATURE_OR_BINDING_INVALID');
   nativeInventoriesByReceipt.set(digest(wrapper.digest),cr);
  }
  receiptDigests.push(digest(wrapper.digest));receiptsByDigest.set(digest(wrapper.digest),r);
 }
 const sidecars=array(bundle.sidecars),sidecarsById=new Map(),sidecarsByName=new Map(),sidecarFiles=[];
 for(const wrapper of sidecars){
  const s=signed(wrapper,keys,now),parent=receiptsByDigest.get(digest(s.parentReceiptDigest)),native=nativeInventoriesByReceipt.get(digest(s.parentReceiptDigest));
  if(s.schemaVersion!=='packproof.capture-sidecar-receipt.v1'||!equal(s,wrapper.sidecar)||typeof s.id!=='string'||!/^[A-Za-z0-9_-]+$/.test(s.id)||sidecarsById.has(s.id)||!parent||!native||s.proofId!==bundle.proofId||s.tenantId!==parent.tenantId||s.intentId!==parent.intentId||s.captureSessionId!==parent.captureSessionId||s.parentEvidenceId!==parent.sources[0].evidenceId||digest(s.parentSourceSha256)!==digest(parent.sources[0].sha256)||digest(s.nativeInventoryDigest)!==sha(parent.clientInventory.canonicalJson))fail('SIDECAR_PARENT_BINDING_MISMATCH');
  const src=s.source,p=parent.sources[0],nameKey=`${s.intentId}/${s.fileName}`;
  if(!src||src.proofId!==s.proofId||src.tenantId!==s.tenantId||src.captureSessionId!==s.captureSessionId||src.subjectId!==p.subjectId||src.legId!==p.legId||src.packageInstanceId!==p.packageInstanceId||src.evidenceId!==s.id||src.sourceId!==`rnd_source_${s.id}`||!Number.isSafeInteger(src.byteLength)||src.byteLength<1||src.byteLength>2097216||typeof src.objectKey!=='string'||typeof src.objectVersionId!=='string'||sidecarsByName.has(nameKey))fail('SIDECAR_SOURCE_BINDING_MISMATCH');
  date(s.receivedAt);digest(src.sha256);
  if(!equal(s.assurance,{byteReceipt:'SIGNED_BYTES_RECEIVED',association:'CLIENT_SIGNED_ACQUISITION_COMMITMENT',pixelEquivalence:'NOT_ASSERTED',sensorAttestation:'UNSUPPORTED'}))fail('SIDECAR_ASSURANCE_OVERCLAIM');
  if(s.fileName==='research-acquisition.json'||s.fileName==='native-journal.jsonl'){
   const expected=s.fileName==='research-acquisition.json'?native.acquisitionSha256:native.journalSha256;
   if(s.relationship!=='CAPTURE_METADATA'||src.relationship!=='CAPTURE_METADATA'||s.frameReference!==null||digest(src.sha256)!==digest(expected)||src.mimeType!==(s.fileName==='research-acquisition.json'?'application/json':'application/x-ndjson'))fail('SIDECAR_METADATA_BINDING_MISMATCH');
  }else{
   const f=frameCommitment(s.frameReference);
   if(f.fileName!==s.fileName||digest(f.sha256)!==digest(src.sha256)||f.byteLength!==src.byteLength||s.relationship!=='CONCURRENT_SIDECAR'||src.relationship!=='CONCURRENT_SIDECAR'||src.mimeType!=='image/x-portable-graymap')fail('SIDECAR_FRAME_BINDING_MISMATCH');
   sameSource(src,inventory.get(src.sourceId),bundle.proofId);
  }
  const known=inventory.get(src.sourceId);
  if(known){sameSource(src,known,bundle.proofId);if(wrapper.archivePath!==known.archivePath)fail('SIDECAR_ARCHIVE_BINDING_MISMATCH');}
  else{
   if(wrapper.archivePath!==`sidecars/${s.id}.bin`||archivePaths.has(wrapper.archivePath))fail('SIDECAR_ARCHIVE_BINDING_MISMATCH');
   archivePaths.add(wrapper.archivePath);sidecarFiles.push({...src,archivePath:wrapper.archivePath});
  }
  sidecarsById.set(s.id,wrapper);sidecarsByName.set(nameKey,wrapper);
 }
 for(const wrapper of sidecars){const s=wrapper.sidecar;if(s.frameReference&&!sidecarsByName.has(`${s.intentId}/research-acquisition.json`))fail('SIDECAR_ACQUISITION_REQUIRED');}
 const annotations=array(bundle.annotations),annotationIds=new Map();
 for(const wrapper of annotations){
  const n=signed(wrapper,keys,now),a=analysesById.get(n.analysisId);
  if(n.schemaVersion!=='packproof.reviewer-annotation.v1'||n.proofId!==bundle.proofId||tenant&&n.tenantId!==tenant||!a||!equal(n,wrapper.annotation)||n.attribution!=='PARTICIPANT_STATEMENT'||typeof n.statement!=='string'||!n.statement||typeof n.actorId!=='string'||annotationIds.has(n.annotationId))fail('ANNOTATION_BINDING_MISMATCH');
  for(const ref of array(n.sourceRefs)){sameSource(ref,inventory.get(ref.sourceId),bundle.proofId);if(!a.sourceRefs.some(s=>s.sourceId===ref.sourceId))fail('ANNOTATION_ANALYSIS_SOURCE_MISMATCH');}
  if(n.observationIndex!==null&&(!Number.isSafeInteger(n.observationIndex)||n.observationIndex<0||n.observationIndex>=(a.details?.observations?.length??0)))fail('ANNOTATION_TARGET_MISMATCH');
  if(n.supersedesId&&annotationIds.get(n.supersedesId)?.actorId!==n.actorId)fail('ANNOTATION_SUPERSESSION_MISMATCH');
  annotationIds.set(n.annotationId,n);
 }
 const enrollmentRecords=array(bundle.enrollmentRecords),enrollmentIds=new Map();
 for(const enrollment of enrollmentRecords){
  if(enrollmentIds.has(enrollment.enrollmentId)||digest(enrollment.rootManifestDigest)!==digest(bundle.root.digest)||enrollment.qualified!==false||!equal(enrollment.frozenRequiredGroups,['label','carton']))fail('ENROLLMENT_BINDING_MISMATCH');
  if(enrollment.supersedesEnrollmentId&&enrollmentIds.get(enrollment.supersedesEnrollmentId)?.subjectId!==enrollment.subjectId)fail('ENROLLMENT_SUPERSESSION_MISMATCH');
  for(const ref of array(enrollment.sourceInventory)){const source=inventory.get(ref.sourceId);if(!source||digest(ref.sha256)!==digest(source.sha256)||ref.objectVersionId!==source.objectVersionId||ref.byteLength!==source.byteLength)fail('ENROLLMENT_SOURCE_MISMATCH');}
  let prior=null,state=null;
  const transitions={CANDIDATE:'SOURCES_COMMITTED',SOURCES_COMMITTED:'ANALYZED',ANALYZED:'UNAVAILABLE',UNAVAILABLE:'LOCKED'};
  for(const [i,wrapper] of array(enrollment.events).entries()){
   const e=signed(wrapper,keys,now);
   if(e.schemaVersion!=='packproof.enrollment-event.v1'||e.enrollmentId!==enrollment.enrollmentId||e.proofId!==bundle.proofId||tenant&&e.tenantId!==tenant||digest(e.rootManifestDigest)!==digest(bundle.root.digest)||e.sequence!==i+1||(prior===null?e.previousDigest!==null:digest(e.previousDigest)!==prior)||e.state!==wrapper.state||e.state!==(state===null?'CANDIDATE':transitions[state])||!equal(e.sourceInventory,enrollment.sourceInventory)||!equal(e.frozenRequiredGroups,enrollment.frozenRequiredGroups)||e.policyVersion!==enrollment.policyVersion)fail('ENROLLMENT_EVENT_CHAIN_MISMATCH');
   prior=digest(wrapper.digest);state=e.state;
  }
  if(!state||state!==enrollment.state||(['ANALYZED','UNAVAILABLE','LOCKED'].includes(state)&&!analysesById.has(enrollment.analysisId)))fail('ENROLLMENT_STATE_MISMATCH');
  enrollmentIds.set(enrollment.enrollmentId,enrollment);
 }
 const artifacts=array(bundle.artifacts??[]);
 if(!equal(artifacts,expectedArtifacts))fail('ARTIFACT_INVENTORY_BINDING_MISMATCH');
 for(const artifact of artifacts){
  if(!Number.isSafeInteger(artifact.byteLength)||artifact.byteLength<1||artifact.byteLength>MAX_TOTAL_BYTES||typeof artifact.archivePath!=='string'||!/^artifacts\/[A-Za-z0-9_-]+\/[0-9]+\.bin$/.test(artifact.archivePath)||archivePaths.has(artifact.archivePath))fail('INVALID_ARTIFACT_INVENTORY');
  archivePaths.add(artifact.archivePath);digest(artifact.sha256);
  for(const ref of array(artifact.sourceRefs))if(!inventory.has(typeof ref==='string'?ref:ref.sourceId))fail('ARTIFACT_SOURCE_BINDING_MISMATCH');
 }
 const snapshot=signed(bundle.exportSnapshot,keys,now);
 if(snapshot.schemaVersion!=='packproof.rnd-export-snapshot.v1'||snapshot.proofId!==bundle.proofId||digest(snapshot.rootDigest)!==digest(bundle.root.digest)||snapshot.extensionCount!==extensions.length||snapshot.extensionHeadDigest!==previous||!equal(snapshot.captureReceiptDigests,receiptDigests)||!equal(snapshot.captureIntentDigests,intentDigests)||!equal(snapshot.annotations,annotations)||!equal(snapshot.enrollmentRecords,enrollmentRecords)||!equal(snapshot.sidecars,sidecars)||!equal(snapshot.sources,sources)||!equal(snapshot.extensionDigests,extensions.map(e=>digest(e.digest)))||!equal(snapshot.artifacts,artifacts)||snapshot.mode!==bundle.mode||!['METADATA_ONLY','ORIGINALS_INCLUDED'].includes(snapshot.mode)||snapshot.audience!==bundle.audience||!equal(snapshot.omissions,bundle.omissions)||snapshot.issuedAt!==bundle.exportedAt)fail('EXPORT_SNAPSHOT_INCOMPLETE_OR_CHANGED');
 const issuedAt=date(snapshot.issuedAt);if(issuedAt>now+300000)fail('EXPORT_SNAPSHOT_IN_FUTURE');
 let checked=0,total=0;
 if(baseDir){
  const base=await realpath(baseDir);
  const sidecarBytes=new Map(),sidecarPaths=new Set(sidecars.map(s=>s.archivePath));
  for(const source of [...sources,...artifacts,...sidecarFiles]){
   const file=await realpath(path.join(base,source.archivePath));
   if(!file.startsWith(base+path.sep))fail('ARCHIVE_PATH_ESCAPE');
   const info=await stat(file);total+=info.size;
   if(!info.isFile()||info.size!==source.byteLength||total>MAX_TOTAL_BYTES)fail('SOURCE_BYTE_LENGTH_OR_BUDGET_MISMATCH');
   const bytes=await readFile(file);
   if(sha(bytes)!==digest(source.sha256))fail('SOURCE_BYTES_CHANGED');if(inventory.has(source.sourceId))checked++;
   if(sidecarPaths.has(source.archivePath))sidecarBytes.set(source.archivePath,bytes);
  }
  const acquisitions=new Map();
  for(const w of sidecars)if(w.sidecar.fileName==='research-acquisition.json')acquisitions.set(w.sidecar.intentId,acquisitionFrames(sidecarBytes.get(w.archivePath)));
  for(const w of sidecars){
   const s=w.sidecar;if(!s.frameReference)continue;
   const f=acquisitions.get(s.intentId)?.find(f=>f.fileName===s.fileName),bytes=sidecarBytes.get(w.archivePath);
   if(!f||!equal(f,s.frameReference))fail('SIDECAR_ACQUISITION_FRAME_MISMATCH');
   const header=Buffer.from(`P5\n${f.width} ${f.height}\n255\n`);
   if(!bytes.subarray(0,header.length).equals(header)||bytes.length!==header.length+f.width*f.height)fail('SIDECAR_LUMA_BYTES_INVALID');
  }
 }
 const omittedRootEvidence=array(root.evidence??[]).filter(e=>!sources.some(s=>s.evidenceId===e.evidenceId)).map(e=>e.evidenceId);
 return {schemaVersion:'packproof.rnd-verification.v1',valid:true,proofId:bundle.proofId,rootDigest:digest(bundle.root.digest),signatureState:'VERIFIED_WITH_PINNED_TRUST',extensionCount:extensions.length,extensionHeadDigest:previous,captureReceiptCount:receipts.length,captureIntentCount:captureIntents.length,annotationCount:annotations.length,enrollmentCount:enrollmentRecords.length,sidecarCount:sidecars.length,sidecarAcquisitionBytes:baseDir?'VERIFIED_FOR_EXPORTED_INVENTORY':'NOT_CHECKED',sidecarPixelEquivalence:'NOT_ASSERTED',snapshotCompleteness:'VERIFIED_RELATIVE_TO_SIGNED_EXPORT_SNAPSHOT',snapshotIssuedAt:snapshot.issuedAt,sourceBytesState:baseDir?'VERIFIED_FOR_EXPORTED_INVENTORY':'NOT_CHECKED',checkedSourceCount:checked,declaredSourceCount:sources.length,checkedArtifactCount:baseDir?artifacts.length:0,declaredArtifactCount:artifacts.length,exportMode:snapshot.mode,omittedRootEvidenceIds:omittedRootEvidence,completeByteCoverage:!!baseDir&&omittedRootEvidence.length===0,physicalTruthVerified:false,hardwareAssurance:'NOT_CHECKED',witnessAssurance:'NOT_CHECKED',zeroKnowledgeAssurance:'NOT_CHECKED',trustSnapshotExpiresAt:trust.expiresAt,networkUsed:false,limitations:['Pinned trust snapshot cannot reveal later key revocations.','Snapshot completeness applies at export time; later or never-submitted extensions are not covered.','Witness/ZK/physical-scene assertions require their separate specialist verifiers; signatures alone do not validate them.','Native luma sidecars are concurrent sensor outputs; equality with decoded recording pixels is not asserted.',...(omittedRootEvidence.length?['Some sealed-root originals are omitted from this R&D inventory.']:[])]};
}
async function main(){
 const args=process.argv.slice(2),input=args[0],trustIndex=args.indexOf('--trust'),baseIndex=args.indexOf('--bytes-dir');
 if(!input||trustIndex<0||!args[trustIndex+1])fail('Usage: rnd_bundle.mjs bundle.json|EXTRACTED-DIRECTORY --trust INDEPENDENT-TRUST.json [--bytes-dir EXTRACTED-DIRECTORY]');
 let file=input,baseDir=baseIndex>=0?args[baseIndex+1]:null;
 if((await stat(input)).isDirectory()){baseDir=input;file=path.join(input,'bundle.json');}
 const bundleText=await readFile(file,'utf8'),trustText=await readFile(args[trustIndex+1],'utf8');
 const report=await verifyResearchBundle(parseStrictJson(bundleText,MAX_JSON),{trust:parseStrictJson(trustText),baseDir});console.log(JSON.stringify(report,null,2));
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href)main().catch(e=>{console.error(JSON.stringify({valid:false,error:e.message}));process.exitCode=1;});
