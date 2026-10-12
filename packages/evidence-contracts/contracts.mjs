/** Research extensions only. Never substitute this serializer for the existing root format. */
export const SCHEMA_VERSION = 'packproof.analysis.v1';
export const FEATURES = Object.freeze(['proofprint','verifiedcapture','proofsight','prooftwin','proofmatch','prooflive','proofshield','proofpilot','proofwitness','proofcollective']);
export const OPERATIONS = Object.freeze(['collection','processing','internalDisplay','customerDisplay']);
export const OPERATIONAL_STATES = Object.freeze(['QUEUED','RUNNING','SUCCEEDED','FAILED','CANCELLED']);
export const FINDING_STATES = Object.freeze(['RECORDED','CONSISTENT','DIFFERENCE_OBSERVED','INCONCLUSIVE','NOT_CHECKED','UNSUPPORTED']);
export const FEATURE_LABELS = Object.freeze({proofprint:'ProofPrint',verifiedcapture:'Verified Capture',proofsight:'ProofSight',prooftwin:'ProofTwin',proofmatch:'ProofMatch',prooflive:'ProofLive',proofshield:'ProofShield',proofpilot:'ProofPilot',proofwitness:'ProofWitness',proofcollective:'ProofCollective'});
const validUnicode = (s) => {
  for (let i=0;i<s.length;i++) {
    const c=s.charCodeAt(i);
    if(c>=0xd800 && c<=0xdbff) { const next=s.charCodeAt(++i); if(!(next>=0xdc00 && next<=0xdfff)) throw new Error('INVALID_UNICODE'); }
    else if(c>=0xdc00 && c<=0xdfff) throw new Error('INVALID_UNICODE');
  }
  return s;
};
/** RFC8785: ECMAScript number serialization, UTF-16 key sorting, no normalization. */
export function canonicalize(value) {
  const seen=new Set();
  function encode(v,depth) {
    if(depth>64) throw new Error('JSON_DEPTH_LIMIT');
    if(v===null || typeof v==='boolean') return JSON.stringify(v);
    if(typeof v==='number') { if(!Number.isFinite(v)) throw new Error('NON_FINITE_NUMBER'); return JSON.stringify(v); }
    if(typeof v==='string') return JSON.stringify(validUnicode(v));
    if(typeof v!=='object' || seen.has(v)) throw new Error('NON_JSON_VALUE');
    seen.add(v);
    let result;
    if(Array.isArray(v)) {
      for(let i=0;i<v.length;i++) if(!Object.hasOwn(v,i)) throw new Error('SPARSE_ARRAY');
      result='['+v.map(x=>encode(x,depth+1)).join(',')+']';
    } else {
      if(![null,Object.prototype].includes(Object.getPrototypeOf(v))) throw new Error('NON_JSON_OBJECT');
      if(Object.getOwnPropertySymbols(v).length) throw new Error('NON_JSON_KEY');
      const descriptors=Object.getOwnPropertyDescriptors(v);
      result='{'+Object.keys(v).sort().map(k=>{
        if(!Object.hasOwn(descriptors[k],'value')) throw new Error('JSON_ACCESSOR');
        return JSON.stringify(validUnicode(k))+':'+encode(descriptors[k].value,depth+1);
      }).join(',')+'}';
    }
    seen.delete(v); return result;
  }
  return encode(value,0);
}
/** Parse before signature verification without silently accepting duplicate keys. */
export function parseStrictJson(text,maxLength=1048576) {
  if(typeof text!=='string'||text.length>maxLength) throw new Error('JSON_SIZE_LIMIT');
  let pos=0;
  const ws=()=>{while(/[\t\n\r ]/.test(text[pos]??'x'))pos++;};
  function string() {
    const start=pos++;
    while(pos<text.length) { const c=text[pos++]; if(c==='\\')pos++; else if(c==='"')return validUnicode(JSON.parse(text.slice(start,pos))); }
    throw new Error('INVALID_JSON');
  }
  function read(depth) {
    if(depth>64)throw new Error('JSON_DEPTH_LIMIT');ws();
    if(text[pos]==='"')return string();
    if(text[pos]==='{') {
      pos++;ws();const keys=new Set();const result=Object.create(null);
      if(text[pos]==='}') {pos++;return result;}
      while(pos<text.length) {
        ws();if(text[pos]!=='"')throw new Error('INVALID_JSON');const key=string();
        if(keys.has(key))throw new Error('DUPLICATE_JSON_KEY');keys.add(key);ws();
        if(text[pos++]!==':')throw new Error('INVALID_JSON');result[key]=read(depth+1);ws();
        const end=text[pos++];if(end==='}')return result;if(end!==',')throw new Error('INVALID_JSON');
      }
    } else if(text[pos]==='[') {
      pos++;ws();const result=[];if(text[pos]===']'){pos++;return result;}
      while(pos<text.length) {result.push(read(depth+1));ws();const end=text[pos++];if(end===']')return result;if(end!==',')throw new Error('INVALID_JSON');}
    } else {
      const match=/^(?:null|true|false|-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?)/.exec(text.slice(pos));
      if(match){pos+=match[0].length;const value=JSON.parse(match[0]);if(typeof value==='number'&&!Number.isFinite(value))throw new Error('NON_FINITE_NUMBER');return value;}
    }
    throw new Error('INVALID_JSON');
  }
  const value=read(0);ws();if(pos!==text.length)throw new Error('INVALID_JSON');return value;
}
export function readRndFlags(env={}) {
  const enabled=env.PACKPROOF_RND_ENABLED==='1' && env.PACKPROOF_ENV==='research';
  const killSwitch=env.PACKPROOF_RND_KILL_SWITCH!=='0';
  const features=Object.fromEntries(FEATURES.map(feature=>[feature,Object.fromEntries(OPERATIONS.map(operation=>{
    const suffix=operation.replace(/[A-Z]/g,c=>'_'+c).toUpperCase();
    return [operation,enabled&&!killSwitch&&env[`PACKPROOF_RND_${feature.toUpperCase()}_${suffix}`]==='1'];
  }))]));
  return {enabled,killSwitch,features,releaseAuthorized:false};
}
export function requireRndFlag(flags,feature,operation) {
  if(!FEATURES.includes(feature)||!OPERATIONS.includes(operation))throw new Error('UNSUPPORTED_RND_OPERATION');
  if(!flags?.enabled||flags.killSwitch||!flags.features?.[feature]?.[operation])throw new Error('RND_DISABLED');
  // Customer display needs per-profile, server-resolved qualification in addition to this flag.
  return true;
}
const ID = /^[^\u0000-\u001f\u007f]{1,512}$/;
const DIGEST = /^sha256:[a-f0-9]{64}$/;
const RAW_DIGEST = /^[a-f0-9]{64}$/;
const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const check = (condition, reason) => { if (!condition) throw new Error(reason); };
const id = (value, reason='INVALID_IDENTIFIER') => check(typeof value==='string' && ID.test(value),reason);
const date = value => check(typeof value==='string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?(?:Z|[+-]\d\d:\d\d)$/.test(value) && Number.isFinite(Date.parse(value)),'INVALID_TIMESTAMP');
function shape(value, required, optional=[],reason='INVALID_RECORD_SHAPE') {
  check(isObject(value) && required.every(key=>Object.hasOwn(value,key)) && Object.keys(value).every(key=>required.includes(key)||optional.includes(key)),reason);
}
function strings(value) {check(Array.isArray(value)&&value.length<=100&&value.every(v=>typeof v==='string'&&v.length<=2048),'INVALID_STRING_ARRAY');}
function subject(value) {shape(value,['packageInstanceId','shipmentLegId'],['productInstanceId']);id(value.packageInstanceId);id(value.shipmentLegId);if(value.productInstanceId!==undefined&&value.productInstanceId!==null)id(value.productInstanceId);}
function method(value) {shape(value,['executableDigest','modelDigest','policyVersion']);check(typeof value.executableDigest==='string'&&DIGEST.test(value.executableDigest)&& (value.modelDigest===null||typeof value.modelDigest==='string'&&DIGEST.test(value.modelDigest)),'INVALID_ANALYSIS_METHOD');id(value.policyVersion);}
/** Source commitments in analysis envelopes use namespaced SHA-256 digests. */
export function assertSourceRef(value) {
  canonicalize(value);
  shape(value,['sourceId','proofId','objectKey','objectVersionId','sha256','byteLength','mimeType','captureSessionId','relationship','retentionState'],['frameReference'],'INVALID_SOURCE_SHAPE');
  for(const field of ['sourceId','proofId','objectKey','objectVersionId','mimeType'])id(value[field]);
  check(typeof value.sha256==='string'&&DIGEST.test(value.sha256),'INVALID_SOURCE_DIGEST');
  check(Number.isSafeInteger(value.byteLength)&&value.byteLength>0&&value.byteLength<=1073741824,'INVALID_SOURCE_LENGTH');
  if(value.captureSessionId!==null)id(value.captureSessionId);
  check(['ORIGINAL_RECORDING','CONCURRENT_SIDECAR','DECODED_FRAME','PARTICIPANT_IMPORT'].includes(value.relationship)&&['AVAILABLE','EXPIRED','DELETED'].includes(value.retentionState),'INVALID_SOURCE_STATE');
  if(value.frameReference!==undefined&&value.frameReference!==null){
    const frame=value.frameReference;shape(frame,['sampleId','offsetMs','clockDomain','decoderBuild','rotation','colorConversion']);
    for(const field of ['sampleId','clockDomain','decoderBuild','colorConversion'])if(frame[field]!==null)id(frame[field]);
    check(frame.offsetMs===null||typeof frame.offsetMs==='number'&&Number.isFinite(frame.offsetMs)&&frame.offsetMs>=0,'INVALID_FRAME_OFFSET');
    check(frame.rotation===null||[0,90,180,270].includes(frame.rotation),'INVALID_FRAME_ROTATION');
  }
  return value;
}
export function assertAnalysisEnvelope(value) {
  canonicalize(value);
  check(value?.schemaVersion===SCHEMA_VERSION&&FEATURES.includes(value?.feature),'UNSUPPORTED_ANALYSIS');
  check(OPERATIONAL_STATES.includes(value.operationalState)&&FINDING_STATES.includes(value.findingState),'INVALID_ANALYSIS_STATE');
  check(value.operationalState==='SUCCEEDED'||['NOT_CHECKED','UNSUPPORTED','INCONCLUSIVE'].includes(value.findingState),'FAILED_JOB_CANNOT_ASSERT_FINDING');
  shape(value,['schemaVersion','feature','tenantId','proofId','rootManifestDigest','subject','analysisId','sourceRefs','inputDigest','method','operationalState','findingState','scope','coverage','reasonCodes','limitations','supersedesId','serverReceivedAt','analyzedAt','details'],['qualification'],'INVALID_ANALYSIS_SHAPE');
  for(const field of ['tenantId','proofId','analysisId','scope'])id(value[field],'INVALID_'+field);
  check(typeof value.rootManifestDigest==='string'&&DIGEST.test(value.rootManifestDigest)&&typeof value.inputDigest==='string'&&DIGEST.test(value.inputDigest),'INVALID_ANALYSIS_DIGEST');
  subject(value.subject);method(value.method);
  check(Array.isArray(value.sourceRefs)&&value.sourceRefs.length<=64,'INVALID_ANALYSIS_SOURCES');
  const seen=new Set();
  for(const source of value.sourceRefs){assertSourceRef(source);check(source.proofId===value.proofId&&!seen.has(source.sourceId),'SOURCE_SUBJECT_MISMATCH_OR_DUPLICATE');seen.add(source.sourceId);}
  check(isObject(value.coverage)&&isObject(value.details),'INVALID_ANALYSIS_DETAILS');strings(value.reasonCodes);strings(value.limitations);
  if(value.supersedesId!==null){id(value.supersedesId);check(value.supersedesId!==value.analysisId,'SELF_SUPERSESSION');}
  date(value.serverReceivedAt);if(value.analyzedAt!==null)date(value.analyzedAt);
  if(value.qualification!==undefined){shape(value.qualification,['gate','scope','recordId']);check(typeof value.qualification.gate==='string'&&/^G[0-5]$/.test(value.qualification.gate),'INVALID_QUALIFICATION_GATE');id(value.qualification.scope);if(value.qualification.recordId!==null)id(value.qualification.recordId);}
  return value;
}
/** Structural/link validation only; callers separately verify exact hashes and signatures. */
export function assertEvidenceExtension(value) {
  canonicalize(value);
  shape(value,['schemaVersion','extensionId','proofId','tenantId','rootManifestDigest','sequence','previousDigest','eventKind','analysis','issuedAt'],[],'INVALID_EXTENSION_SHAPE');
  check(value.schemaVersion==='packproof.extension.v1'&&value.eventKind==='ANALYSIS_COMPLETED','UNSUPPORTED_EXTENSION');
  for(const field of ['extensionId','proofId','tenantId'])id(value[field]);
  check(typeof value.rootManifestDigest==='string'&&DIGEST.test(value.rootManifestDigest),'INVALID_EXTENSION_ROOT');
  check(Number.isSafeInteger(value.sequence)&&value.sequence>=1,'INVALID_EXTENSION_SEQUENCE');
  check(value.sequence===1?value.previousDigest===null:typeof value.previousDigest==='string'&&DIGEST.test(value.previousDigest),'INVALID_EXTENSION_PREDECESSOR');
  const analysis=assertAnalysisEnvelope(value.analysis);
  check(analysis.proofId===value.proofId&&analysis.tenantId===value.tenantId&&analysis.rootManifestDigest===value.rootManifestDigest,'EXTENSION_ANALYSIS_BINDING_MISMATCH');
  check(analysis.operationalState==='SUCCEEDED','INVALID_COMPLETED_EXTENSION_STATE');date(value.issuedAt);
  return value;
}
export function assertSignedRecord(value) {
  canonicalize(value);shape(value,['canonicalJson','digest','signature'],[],'INVALID_SIGNED_RECORD_SHAPE');
  check(typeof value.canonicalJson==='string'&&value.canonicalJson.length>=2&&value.canonicalJson.length<=4194304&&canonicalize(parseStrictJson(value.canonicalJson,4194304))===value.canonicalJson,'INVALID_CANONICAL_RECORD');
  check(typeof value.digest==='string'&&RAW_DIGEST.test(value.digest),'INVALID_RECORD_DIGEST');
  const signature=value.signature;shape(signature,['algorithm','keyId','signatureBase64','signedAt'],[],'INVALID_SIGNATURE_SHAPE');
  check(['ECDSA_SHA_256','RSASSA_PSS_SHA_256'].includes(signature.algorithm),'UNSUPPORTED_SIGNATURE_ALGORITHM');id(signature.keyId);date(signature.signedAt);
  check(typeof signature.signatureBase64==='string'&&signature.signatureBase64.length>=4&&signature.signatureBase64.length<=2048&&/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(signature.signatureBase64),'INVALID_SIGNATURE_ENCODING');
  return value;
}
export function findingLabel(value) {
  if(value.operationalState==='FAILED')return 'Analysis unavailable';
  if(value.operationalState==='QUEUED'||value.operationalState==='RUNNING')return 'Analysis pending';
  if(value.operationalState==='CANCELLED')return 'Analysis cancelled';
  return {RECORDED:'Observation recorded',CONSISTENT:'Consistent within stated scope',DIFFERENCE_OBSERVED:'Visible difference observed',INCONCLUSIVE:'Unable to conclude',NOT_CHECKED:'Not checked',UNSUPPORTED:'Unsupported for this profile'}[value.findingState]??'Unknown result';
}
