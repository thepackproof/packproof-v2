import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {generateKeyPairSync} from 'node:crypto';
import {canonicalize,parseStrictJson,sha256,digest,domainDigest,readRndFlags,requireRndFlag,FEATURES,signPayload,verifyPayload,assertAnalysisEnvelope} from '../index.mjs';
const vectors=JSON.parse(readFileSync(new URL('../canonical-vectors.json',import.meta.url)));
test('RFC8785 vectors and duplicate/unicode input rejection',()=>{
 for(const v of vectors.vectors){assert.equal(canonicalize(v.value),v.canonical);assert.equal(sha256(v.canonical),v.sha256);assert.equal(canonicalize(parseStrictJson(v.canonical)),v.canonical);}
 for(const v of vectors.rejectedJson)assert.throws(()=>parseStrictJson(v));
 for(const v of [NaN,undefined,[,1],{x:undefined},new Date(),{get x(){return 1;}}])assert.throws(()=>canonicalize(v));
 assert.notEqual(domainDigest('ONE','ab','c'),domainDigest('ONE','a','bc'));
 assert.notEqual(domainDigest('ONE','a'),domainDigest('TWO','a'));
});
test('research flags default off, independent and global kill immediate',()=>{
 for(const flag of [readRndFlags(),readRndFlags({PACKPROOF_RND_ENABLED:'1',PACKPROOF_ENV:'production',PACKPROOF_RND_KILL_SWITCH:'0'})])for(const feature of FEATURES)assert.throws(()=>requireRndFlag(flag,feature,'collection'));
 const env={PACKPROOF_ENV:'research',PACKPROOF_RND_ENABLED:'1',PACKPROOF_RND_KILL_SWITCH:'0',PACKPROOF_RND_PROOFPILOT_COLLECTION:'1'};
 assert.equal(requireRndFlag(readRndFlags(env),'proofpilot','collection'),true);
 assert.throws(()=>requireRndFlag(readRndFlags(env),'proofpilot','processing'));
 assert.throws(()=>requireRndFlag(readRndFlags({...env,PACKPROOF_RND_KILL_SWITCH:'1'}),'proofpilot','collection'));
});
test('detached signature requires explicit trusted non-revoked key and exact canonical bytes',()=>{
 const {privateKey,publicKey}=generateKeyPairSync('ed25519');
 const envelope=signPayload({subject:'parcel-one',bytes:digest({media:'synthetic fixture'})},{keyId:'test-only',privateKey});
 const policy={policyId:'test-policy',keys:[{keyId:'test-only',algorithm:'Ed25519',publicKeyPem:publicKey.export({type:'spki',format:'pem'}),validFrom:'2026-01-01T00:00:00Z',validUntil:'2027-01-01T00:00:00Z',revoked:false}]};
 const at='2026-10-02T00:00:00Z';
 assert.equal(verifyPayload(envelope,policy,at).valid,true);
 assert.equal(verifyPayload({...envelope,canonicalJson:envelope.canonicalJson.replace('parcel-one','parcel-two')},policy,at).valid,false);
 assert.equal(verifyPayload(envelope,{...policy,keys:[]},at).valid,false);
 assert.equal(verifyPayload(envelope,{...policy,keys:[{...policy.keys[0],revoked:true}]},at).valid,false);
 assert.equal(verifyPayload(envelope,policy,'2028-01-01T00:00:00Z').valid,false);
 assert.equal(verifyPayload({...envelope,algorithm:'invented'},policy,at).valid,false);
});
test('failed jobs cannot become physical findings',()=>{
 const input={schemaVersion:'packproof.analysis.v1',feature:'proofprint',tenantId:'t',proofId:'p',rootManifestDigest:digest('root'),subject:{packageInstanceId:'pkg',shipmentLegId:'out'},analysisId:'a',sourceRefs:[],inputDigest:digest([]),method:{executableDigest:digest('build'),modelDigest:null,policyVersion:'v1'},operationalState:'FAILED',findingState:'DIFFERENCE_OBSERVED',scope:'label',coverage:{},reasonCodes:['TIMEOUT'],limitations:[],supersedesId:null,analyzedAt:null,details:{},serverReceivedAt:'2026-10-02T00:00:00Z'};
 assert.throws(()=>assertAnalysisEnvelope(input),/FAILED_JOB/);
 assert.equal(assertAnalysisEnvelope({...input,findingState:'NOT_CHECKED'}).findingState,'NOT_CHECKED');
});

const {assertSourceRef,assertEvidenceExtension,assertSignedRecord}=await import('../contracts.mjs');
const fixtures=await import('./schema-fixtures.mjs');
const {conforms,readSchema}=await import('./schema-conformance.mjs');
test('backend-shaped envelopes and signed extension payloads match runtime and schemas',()=>{
 assert.equal(assertAnalysisEnvelope(fixtures.analysis),fixtures.analysis);
 assert.equal(assertEvidenceExtension(fixtures.extension),fixtures.extension);
 for(const [name,value] of [['source',fixtures.source],['analysis',fixtures.analysis],['extension',fixtures.extension],['capture-receipt',fixtures.captureReceipt],['capture-session',fixtures.captureReceipt]])assert.equal(conforms(value,readSchema(name)),true,name);
 const record={canonicalJson:canonicalize(fixtures.extension),digest:fixtures.raw,signature:fixtures.signature};
 assert.equal(assertSignedRecord(record),record);
 assert.equal(conforms(record,readSchema('extension-record')),true);
 // A valid structural signature wrapper alone never establishes cryptographic trust.
 assert.equal(conforms(fixtures.extension,readSchema('extension-record')),false);
});
test('malformed commitments and missing required fields fail runtime and declared schema',()=>{
 const mutations=[a=>delete a.method.modelDigest,a=>delete a.details,a=>delete a.analyzedAt,a=>a.sourceRefs[0].byteLength=0,a=>a.sourceRefs[0].sha256=fixtures.raw,a=>a.method.modelDigest='guess',a=>a.method.executableDigest=[fixtures.hash],a=>a.method.modelDigest=[fixtures.hash],a=>a.qualification.gate=['G0'],a=>a.rootManifestDigest=fixtures.raw,a=>a.operationalState='FAILED',a=>a.reasonCodes=[true],a=>a.supersedesId=12,a=>a.sourceRefs[0].retentionState='ASSUMED',a=>a.serverReceivedAt='yesterday',a=>a.extraClaim='trusted'];
 for(const mutate of mutations){const value=structuredClone(fixtures.analysis);mutate(value);assert.throws(()=>assertAnalysisEnvelope(value));assert.equal(conforms(value,readSchema('analysis')),false);}
 assert.throws(()=>assertSourceRef({...fixtures.source,frameReference:{sampleId:'frame'}}));
});
test('extension predecessor and child subject bindings reject signed-but-rebound content',()=>{
 for(const mutate of [e=>e.previousDigest=fixtures.hash,e=>{e.sequence=2;e.previousDigest=null;},e=>e.sequence=0]){const e=structuredClone(fixtures.extension);mutate(e);assert.throws(()=>assertEvidenceExtension(e));assert.equal(conforms(e,readSchema('extension')),false);}
 for(const mutate of [e=>e.analysis.proofId='other',e=>e.analysis.tenantId='other',e=>e.analysis.rootManifestDigest='sha256:'+'b'.repeat(64),e=>e.analysis.sourceRefs.push(e.analysis.sourceRefs[0])]){const e=structuredClone(fixtures.extension);mutate(e);assert.throws(()=>assertEvidenceExtension(e));}
 assert.doesNotThrow(()=>assertEvidenceExtension({...fixtures.extension,sequence:2,previousDigest:fixtures.hash}));
});

test('late sidecar receipts preserve exact commitments and do not claim decoded pixel or sensor equivalence',()=>{
 const schema=readSchema('capture-sidecar-receipt');assert.equal(conforms(fixtures.sidecarReceipt,schema),true);
 for(const mutate of [s=>delete s.nativeInventoryDigest,s=>s.parentReceiptDigest=fixtures.hash,s=>s.assurance.sensorAttestation='VALIDATED',s=>s.assurance.pixelEquivalence='EQUIVALENT',s=>s.frameReference=null,s=>s.source.relationship='ORIGINAL_RECORDING',s=>s.frameReference.mediaTimeMs=-1,s=>s.fileName='../../frame.pgm']){const value=structuredClone(fixtures.sidecarReceipt);mutate(value);assert.equal(conforms(value,schema),false);}
 const metadata={...fixtures.sidecarReceipt,fileName:'research-acquisition.json',relationship:'CAPTURE_METADATA',frameReference:null,source:{...fixtures.sidecarReceipt.source,mimeType:'application/json',relationship:'CAPTURE_METADATA'}};assert.equal(conforms(metadata,schema),true);
 assert.equal(conforms({...metadata,frameReference:fixtures.nativeFrame},schema),false);
});

test('signed derivative grant and audit schemas exclude bearer material and scope escalation',()=>{
 const grant={schemaVersion:'packproof.derivative-grant.v1',id:'grant',proofId:'proof',analysisId:'analysis',issuerId:'actor',scope:'REVIEWED_DERIVATIVE_ZIP_ONLY',artifactSha256:fixtures.raw,recipeSha256:fixtures.raw,reviewDigest:fixtures.raw,createdAt:fixtures.at,expiresAt:'2026-10-02T11:00:00.000Z',limitations:['Downloaded copies cannot be recalled']};
 const schema=readSchema('derivative-grant');assert.equal(conforms(grant,schema),true);
 for(const fields of [{token:'secret'},{tokenHash:fixtures.raw},{scope:'ORIGINAL_MEDIA'},{artifactSha256:fixtures.hash},{expiresAt:'never'}])assert.equal(conforms({...grant,...fields},schema),false);
 const event={schemaVersion:'packproof.derivative-grant-event.v1',id:'event',grantId:'grant',kind:'REDEEM_COMPLETED',actorId:null,createdAt:fixtures.at},eventSchema=readSchema('derivative-grant-event');assert.equal(conforms(event,eventSchema),true);assert.equal(conforms({...event,token:'secret'},eventSchema),false);assert.equal(conforms({...event,kind:'UNKNOWN'},eventSchema),false);
});
