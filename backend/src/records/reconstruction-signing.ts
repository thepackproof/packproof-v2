import type {Clock} from '../clock.js';
import type {ManifestSigningRuntime} from '../integrity/signing-runtime.js';
import type {ManifestSignature} from '../domain/manifest-signing.js';
import {verifyManifestIntegrity} from '../domain/manifest-signing.js';
import {parseSignedTrustRegistry,verifySignedTrustRegistry,verifyWithTrustRegistry,type SignedTrustRegistry} from '../domain/signing-trust.js';
import {canonicalize} from '../canonical.js';
import {sha256Hex} from '../hash.js';
import {DomainError} from '../domain/errors.js';
import {readPinnedReconstructionQualification} from './reconstruction-qualification.js';

/** New profile: existing Proof, snapshot and unsigned investigation bytes are never rewritten. */
export const RECONSTRUCTION_SIGNED_PROFILE='packproof.reconstruction-investigation/v2' as const;
export const RECONSTRUCTION_SIGNED_PROFILE_SHA256=sha256Hex(canonicalize({profile:RECONSTRUCTION_SIGNED_PROFILE,content:'packproof.reconstruction-investigation/v1',inventory:'packproof.reconstruction-signed-inventory/v1',qualificationProjection:'case_organization_only/v1',canonicalization:'packproof-canonical-json/v1',physicalTruthVerified:false}));
const PUBLIC_QUALIFICATION_REFERENCE='Private runtime qualification committed by the signed qualificationSha256';
export interface ReconstructionSigningBinding {
 schema:'packproof.reconstruction-signing-binding/v1';sourceSha:string;profileSha256:string;
 organizationIds:string[];environment:'sandbox'|'live';qualificationReference:string;
 reviewedAt:string;expiresAt:string;keyId:string;mode:'qualified_kms'|'synthetic_test';
}
export interface ReconstructionSigningScope {caseId:string;organizationId:string;environment:'sandbox'|'live';exportId:string;payloadSha256:string;}
export interface ReconstructionSigningRuntime {
 readonly binding:ReconstructionSigningBinding;readonly bindingSha256:string;
 assertReady(scope:ReconstructionSigningScope):void;
 sign(scope:ReconstructionSigningScope,frozenBytes:Buffer):Promise<SignedReconstructionPackage>;
}
export interface SignedReconstructionPackage {
 schema:'packproof.signed-reconstruction-package/v1';profile:typeof RECONSTRUCTION_SIGNED_PROFILE;
 qualification:'qualified_runtime'|'synthetic_test_only';physicalTruthVerified:false;
 manifest:Record<string,unknown>;manifestSha256:string;signature:ManifestSignature;
 content:unknown;trust:unknown;binding:ReconstructionSigningBinding;
}
const fail=(message:string):never=>{throw new DomainError('RECONSTRUCTION_SIGNING_UNAVAILABLE',message,503);};
const instant=(s:string)=>typeof s==='string'&&/(?:Z|[+-]\d{2}:\d{2})$/.test(s)&&Number.isFinite(Date.parse(s));
const record=(v:unknown):Record<string,unknown>=>v!==null&&typeof v==='object'&&!Array.isArray(v)?v as Record<string,unknown>:{};
const list=(v:unknown):unknown[]=>Array.isArray(v)?v:[];
const digest=(v:unknown)=>sha256Hex(canonicalize(v??null));
const supportedBinding=(b:ReconstructionSigningBinding)=>Object.keys(b).sort().join(',')===['schema','sourceSha','profileSha256','organizationIds','environment','qualificationReference','reviewedAt','expiresAt','keyId','mode'].sort().join(',')&&b.schema==='packproof.reconstruction-signing-binding/v1'&&/^[a-f0-9]{40}$/.test(b.sourceSha)&&b.profileSha256===RECONSTRUCTION_SIGNED_PROFILE_SHA256&&Array.isArray(b.organizationIds)&&b.organizationIds.length>0&&b.organizationIds.length<=100&&b.organizationIds.every(id=>typeof id==='string'&&id.length>0&&id.length<=200)&&['sandbox','live'].includes(b.environment)&&typeof b.qualificationReference==='string'&&!!b.qualificationReference.trim()&&b.qualificationReference.length<=1000&&typeof b.keyId==='string'&&/^[A-Za-z0-9_:/.-]{1,200}$/.test(b.keyId)&&['qualified_kms','synthetic_test'].includes(b.mode)&&instant(b.reviewedAt)&&instant(b.expiresAt)&&Date.parse(b.reviewedAt)<Date.parse(b.expiresAt);
const timeInventory=(assertions:unknown[],timeline:unknown)=>({assertions:assertions.map(a=>{const v=record(a),source=record(v.source);return {id:v.id,reportedAt:source.reportedAt??v.occurredAt??null,sourceAsOf:source.sourceAsOf??v.sourceAsOf??null,receivedAt:source.receivedAt??null,timeQuality:source.timeQuality??v.timeQuality??'unknown'};}),timeline});
const ruleInventory=(projection:Record<string,unknown>,history:unknown)=>({comparisons:projection.comparisons,rules:projection.rules,ruleCapabilities:projection.ruleCapabilities,rulesStatus:projection.rulesStatus,identityRules:projection.identityRules,issues:projection.issues,issueHistory:history,sources:projection.sources,coverage:projection.coverage});
/** Deployment qualification may admit other customers and contain private
 * review notes. A case download receives only its own public scope. */
function projectPublicBinding(binding:ReconstructionSigningBinding,scope:ReconstructionSigningScope):ReconstructionSigningBinding {
 return {schema:binding.schema,sourceSha:binding.sourceSha,profileSha256:binding.profileSha256,organizationIds:[scope.organizationId],environment:binding.environment,qualificationReference:PUBLIC_QUALIFICATION_REFERENCE,reviewedAt:binding.reviewedAt,expiresAt:binding.expiresAt,keyId:binding.keyId,mode:binding.mode};
}

/** Uses the established signing provider and independent trust registry. The
 * binding is a reviewed deployment input, never an HTTP request field. */
export function createReconstructionSigningRuntime(input:{clock:Clock;manifestSigning:ManifestSigningRuntime;binding:ReconstructionSigningBinding;activeSourceSha:string;testFixtures?:boolean}):ReconstructionSigningRuntime {
 const binding=JSON.parse(canonicalize(input.binding)) as ReconstructionSigningBinding;
 const material=input.manifestSigning,bindingSha256=digest(binding);
 function assertReady(scope:ReconstructionSigningScope){
  const now=input.clock.now().getTime();
  if(!supportedBinding(binding))fail('The reviewed signing binding contains unsupported fields or scope');
  if(binding.schema!=='packproof.reconstruction-signing-binding/v1'||!/^[a-f0-9]{40}$/.test(binding.sourceSha)||binding.sourceSha!==input.activeSourceSha||binding.profileSha256!==RECONSTRUCTION_SIGNED_PROFILE_SHA256||!binding.qualificationReference?.trim()||!instant(binding.reviewedAt)||!instant(binding.expiresAt)||Date.parse(binding.reviewedAt)>now||now>=Date.parse(binding.expiresAt)||!Array.isArray(binding.organizationIds)||binding.organizationIds.length<1||binding.organizationIds.length>100||!binding.organizationIds.includes(scope.organizationId)||binding.environment!==scope.environment)fail('The signed case profile needs a current matching source, organization and environment qualification');
  if(!material.signer||material.publicStatus.mode!=='SIGNED'||material.publicStatus.keyId!==binding.keyId)fail('The qualified case signing key is unavailable');
  if(binding.mode==='synthetic_test'){
   if(input.testFixtures!==true||scope.environment!=='sandbox'||!material.trustList||Date.parse(material.trustList.generatedAt)>now||now>=Date.parse(material.trustList.expiresAt))fail('Synthetic signing is limited to explicit sandbox fixtures');
   if(!material.trustList!.keys.some(k=>k.keyId===binding.keyId&&k.status==='ACTIVE'))fail('Synthetic verification trust is unavailable');
  }else if(binding.mode==='qualified_kms'){
   if(material.publicStatus.provider!=='AWS_KMS'||material.publicStatus.trustSource!=='SIGNED_REGISTRY'||!material.registryAuthorityKeys||!Object.keys(material.registryAuthorityKeys).length)fail('Case signing requires the reviewed KMS provider and independently pinned registry authority');
   const registry=readRegistry();if(!registry||!verifySignedTrustRegistry(registry,material.registryAuthorityKeys!,input.clock.now()).current)fail('The signing trust registry needs a current operational review');
  }else fail('Choose an explicit qualified signing mode');
 }
 function readRegistry(){try{return material.readSignedTrustRegistry?parseSignedTrustRegistry(Buffer.from(material.readSignedTrustRegistry())):material.signedTrustRegistry;}catch{return undefined;}}
 Object.freeze(binding.organizationIds);Object.freeze(binding);
 return {binding,bindingSha256,assertReady,async sign(scope,bytes){
  assertReady(scope);
  if(bytes.length===0||bytes.length>32*1024*1024||sha256Hex(bytes)!==scope.payloadSha256)fail('The frozen case content digest changed');
  let content:unknown;try{content=JSON.parse(bytes.toString('utf8'));}catch{return fail('The frozen case package is not JSON');}
  const payload=record(content),projection=record(payload.projection),caseRecord=record(projection.case);
  if(payload.schema!=='packproof.reconstruction-investigation/v1'||canonicalize(content)!==bytes.toString('utf8')||caseRecord.id!==scope.caseId||!Number.isSafeInteger(caseRecord.revision)||!projection.projectionVersion)fail('The frozen package does not match the supported case projection');
  const assertions=list(projection.assertions),extracts=list(payload.extracts),artifacts=list(payload.artifactManifest),publicBinding=projectPublicBinding(binding,scope);
  const manifest={schema:'packproof.reconstruction-signed-inventory/v1',profile:RECONSTRUCTION_SIGNED_PROFILE,scope,sourceSha:binding.sourceSha,profileSha256:binding.profileSha256,bindingSha256:digest(publicBinding),qualificationProjection:'case_organization_only/v1',qualificationSha256:bindingSha256,caseRevision:caseRecord.revision,projectionVersion:projection.projectionVersion,content:{sha256:scope.payloadSha256,byteSize:bytes.length,profile:payload.schema},assertions:{count:assertions.length,sha256:digest(assertions)},associationDecisions:{count:list(payload.associationDecisions).length,sha256:digest(payload.associationDecisions)},ruleAndIssueRevisions:{sha256:digest(ruleInventory(projection,payload.issueHistory))},artifacts:{count:artifacts.length,sha256:digest(artifacts)},extracts:{count:extracts.length,sha256:digest(extracts)},omissions:{sha256:digest(payload.omissions)},timeQuality:{sha256:digest(timeInventory(assertions,projection.timeline))},originalAvailability:{sha256:digest(extracts.map(e=>{const v=record(e);return {assertionId:v.assertionId,original:v.original,originalAvailable:v.originalAvailable,omission:v.omission};}))},retention:{sha256:digest(payload.retention)},physicalTruthVerified:false};
  const canonicalJson=canonicalize(manifest),manifestSha256=sha256Hex(canonicalJson);
  const signature=await material.signer!.signManifest({proofId:scope.caseId,manifestId:scope.exportId,canonicalJson,sha256:manifestSha256});
  assertReady(scope);
  if(signature.keyId!==binding.keyId||signature.algorithm!==material.publicStatus.algorithm||!instant(signature.signedAt)||Date.parse(signature.signedAt)>input.clock.now().getTime()||Date.parse(signature.signedAt)<Date.parse(binding.reviewedAt)||Date.parse(signature.signedAt)>=Date.parse(binding.expiresAt))fail('The signing provider returned an unexpected signing identity');
  const registry=readRegistry();
  const verified=binding.mode==='qualified_kms'&&registry?verifyWithTrustRegistry({canonicalJson,expectedSha256:manifestSha256,signature,signedRegistry:registry,pinnedRegistryAuthorityKeys:material.registryAuthorityKeys!,now:input.clock.now(),onlineRevocationChecked:true}).fullyVerified:verifyManifestIntegrity({canonicalJson,expectedSha256:manifestSha256,signature,publicKeyPem:material.trustList?.keys.find(k=>k.keyId===signature.keyId&&k.status==='ACTIVE')?.publicKeyPem}).signatureValid===true;
  if(!verified)fail('The returned case signature did not verify against independent current trust');
  return {schema:'packproof.signed-reconstruction-package/v1',profile:RECONSTRUCTION_SIGNED_PROFILE,qualification:binding.mode==='synthetic_test'?'synthetic_test_only':'qualified_runtime',physicalTruthVerified:false,manifest,manifestSha256,signature,content,trust:binding.mode==='qualified_kms'?registry:material.trustList,binding:publicBinding};
 }};
}
export async function signFrozenReconstructionPackage(runtime:ReconstructionSigningRuntime,scope:ReconstructionSigningScope,frozenBytes:Buffer){return runtime.sign(scope,frozenBytes);}
/** Verification trust is supplied independently. Embedded package keys and a
 * valid signature alone never qualify a runtime or verify physical truth. */
export function verifySignedReconstructionPackage(pkg:SignedReconstructionPackage,input:{now:Date;signedRegistry:SignedTrustRegistry;pinnedRegistryAuthorityKeys:Record<string,string>;onlineRevocationChecked:boolean}){
 try{
  const payload=record(pkg.content),projection=record(payload.projection),manifest=pkg.manifest,content=record(manifest.content),scope=record(manifest.scope),assertions=list(projection.assertions),extracts=list(payload.extracts),caseRecord=record(projection.case);
  const byteString=canonicalize(pkg.content),canonicalJson=canonicalize(manifest);
  // Trust in another registry key never substitutes for this profile's exact
  // reviewed signing identity, even when that other signature is valid.
  if(pkg.signature.keyId!==pkg.binding.keyId)return {inventoryValid:false,digestValid:sha256Hex(canonicalJson)===pkg.manifestSha256,signatureValid:false,fullyVerified:false,physicalTruthVerified:false};
  if(!Array.isArray(pkg.binding.organizationIds)||pkg.binding.organizationIds.length!==1||pkg.binding.organizationIds[0]!==scope.organizationId||pkg.binding.qualificationReference!==PUBLIC_QUALIFICATION_REFERENCE||manifest.qualificationProjection!=='case_organization_only/v1'||typeof manifest.qualificationSha256!=='string'||!/^[a-f0-9]{64}$/.test(manifest.qualificationSha256))return {inventoryValid:false,digestValid:sha256Hex(canonicalJson)===pkg.manifestSha256,signatureValid:false,fullyVerified:false,physicalTruthVerified:false};
  const matches=(name:string,value:unknown,count?:number)=>record(manifest[name]).sha256===digest(value)&&(count===undefined||record(manifest[name]).count===count);
  const inventoryValid=pkg.schema==='packproof.signed-reconstruction-package/v1'&&pkg.profile===RECONSTRUCTION_SIGNED_PROFILE&&manifest.profile===pkg.profile&&manifest.schema==='packproof.reconstruction-signed-inventory/v1'&&payload.schema==='packproof.reconstruction-investigation/v1'&&content.sha256===sha256Hex(byteString)&&content.byteSize===Buffer.byteLength(byteString)&&scope.payloadSha256===content.sha256&&caseRecord.id===scope.caseId&&caseRecord.revision===manifest.caseRevision&&projection.projectionVersion===manifest.projectionVersion&&manifest.bindingSha256===digest(pkg.binding)&&pkg.binding.profileSha256===RECONSTRUCTION_SIGNED_PROFILE_SHA256&&manifest.profileSha256===pkg.binding.profileSha256&&manifest.sourceSha===pkg.binding.sourceSha&&pkg.binding.organizationIds.includes(String(scope.organizationId))&&pkg.binding.environment===scope.environment&&matches('assertions',assertions,assertions.length)&&matches('associationDecisions',payload.associationDecisions,list(payload.associationDecisions).length)&&matches('ruleAndIssueRevisions',ruleInventory(projection,payload.issueHistory))&&matches('artifacts',payload.artifactManifest,list(payload.artifactManifest).length)&&matches('extracts',extracts,extracts.length)&&matches('omissions',payload.omissions)&&matches('timeQuality',timeInventory(assertions,projection.timeline))&&matches('originalAvailability',extracts.map(e=>{const v=record(e);return {assertionId:v.assertionId,original:v.original,originalAvailable:v.originalAvailable,omission:v.omission};}))&&matches('retention',payload.retention);
  const trust=verifyWithTrustRegistry({canonicalJson,expectedSha256:pkg.manifestSha256,signature:pkg.signature,signedRegistry:input.signedRegistry,pinnedRegistryAuthorityKeys:input.pinnedRegistryAuthorityKeys,now:input.now,onlineRevocationChecked:input.onlineRevocationChecked});
  const bindingValidAtSignature=supportedBinding(pkg.binding)&&instant(pkg.signature.signedAt)&&Date.parse(pkg.binding.reviewedAt)<=Date.parse(pkg.signature.signedAt)&&Date.parse(pkg.signature.signedAt)<Date.parse(pkg.binding.expiresAt);
  return {...trust,inventoryValid,bindingValidAtSignature,fullyVerified:inventoryValid&&bindingValidAtSignature&&trust.fullyVerified&&pkg.qualification==='qualified_runtime'&&pkg.binding.mode==='qualified_kms',physicalTruthVerified:false};
 }catch{return {inventoryValid:false,digestValid:false,signatureValid:false,fullyVerified:false,physicalTruthVerified:false};}
}
export function initializeReconstructionSigningRuntime(input:{clock:Clock;manifestSigning?:ManifestSigningRuntime;activeSourceSha:string;testFixtures?:boolean;env?:NodeJS.ProcessEnv}):ReconstructionSigningRuntime|undefined {
 const env=input.env??process.env;if(env.PACKPROOF_SIGNED_CASE_EXPORTS_ENABLED!=='true')return undefined;
 if(!input.manifestSigning)fail('The independently qualified signing provider is unavailable');
 const binding=readPinnedReconstructionQualification<ReconstructionSigningBinding>(env,'PACKPROOF_SIGNED_CASE_EXPORT_BINDING');
 const runtime=createReconstructionSigningRuntime({...input,manifestSigning:input.manifestSigning!,binding});
 // Validate the entire admitted scope at startup as well as on every signature.
 if(!Array.isArray(binding.organizationIds)||!binding.organizationIds.length)fail('The reviewed signing organization scope is empty');
 for(const organizationId of binding.organizationIds)runtime.assertReady({caseId:'readiness',organizationId,environment:binding.environment,exportId:'readiness',payloadSha256:'0'.repeat(64)});
 return runtime;
}
