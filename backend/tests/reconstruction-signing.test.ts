import {afterAll,it,expect} from 'vitest';
import {generateKeyPairSync} from 'node:crypto';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {loadManifestSigningRuntime} from '../src/integrity/signing-runtime.js';
import {verifyManifestIntegrity} from '../src/domain/manifest-signing.js';
import {canonicalize} from '../src/canonical.js';
import {sha256Hex} from '../src/hash.js';
import {createReconstructionSigningRuntime,initializeReconstructionSigningRuntime,verifySignedReconstructionPackage,RECONSTRUCTION_SIGNED_PROFILE_SHA256,type ReconstructionSigningBinding} from '../src/records/reconstruction-signing.js';
import {initializeSourceDispositionRuntime} from '../src/records/source-retention-disposition.js';
const directory=mkdtempSync(join(tmpdir(),'packproof-case-signing-test-')),clock={now:()=>new Date('2026-11-14T03:00:00Z')};
const pair=generateKeyPairSync('ec',{namedCurve:'prime256v1'}),publicKeyPem=pair.publicKey.export({type:'spki',format:'pem'}).toString();
writeFileSync(join(directory,'private.pem'),pair.privateKey.export({type:'pkcs8',format:'pem'}),{mode:0o600});
writeFileSync(join(directory,'trust.json'),canonicalize({schema:'packproof.trust-list.v1',generatedAt:'2026-11-13T00:00:00Z',expiresAt:'2026-11-16T00:00:00Z',keys:[{keyId:'synthetic-case-key',algorithm:'ECDSA_SHA_256',publicKeyPem,status:'ACTIVE'}]}));
const material=loadManifestSigningRuntime(clock,{PACKPROOF_MANIFEST_SIGNING_MODE:'pem',PACKPROOF_MANIFEST_SIGNING_KEY_FILE:join(directory,'private.pem'),PACKPROOF_MANIFEST_SIGNING_KEY_ID:'synthetic-case-key',PACKPROOF_MANIFEST_SIGNING_ALGORITHM:'ECDSA_SHA_256',PACKPROOF_MANIFEST_TRUST_LIST_FILE:join(directory,'trust.json')});
const binding:ReconstructionSigningBinding={schema:'packproof.reconstruction-signing-binding/v1',sourceSha:'a'.repeat(40),profileSha256:RECONSTRUCTION_SIGNED_PROFILE_SHA256,organizationIds:['synthetic-org'],environment:'sandbox',qualificationReference:'Synthetic test only',reviewedAt:'2026-11-13T00:00:00Z',expiresAt:'2026-11-16T00:00:00Z',keyId:'synthetic-case-key',mode:'synthetic_test'};
const payload={schema:'packproof.reconstruction-investigation/v1',integrity:{signed:false},projection:{case:{id:'synthetic-case',revision:3},projectionVersion:'projection-3',assertions:[{id:'assertion-1',value:2,source:{reportedAt:null,sourceAsOf:null,receivedAt:'2026-11-14T02:00:00Z',timeQuality:'unknown'}}],comparisons:[{ruleId:'synthetic-rule',ruleVersion:'2',policyVersion:'source-owner-fixture-v1',outcome:'not_comparable'}],ruleCapabilities:{quantityDisagreement:'prerequisites_required'},rulesStatus:{available:true},sources:[{subscriptionId:'synthetic-source',state:'coverage_unknown'}],timeline:[{id:'synthetic-observation',timeQuality:'unknown'}]},associationDecisions:[{id:'association-1',supersedesId:null}],issueHistory:[],extracts:[{assertionId:'assertion-1',original:{sha256:'b'.repeat(64)},originalAvailable:false,omission:'Synthetic missing source'}],artifactManifest:[{assertionId:'assertion-1',sha256:'c'.repeat(64)}],omissions:[{kind:'shared_originals'}],retention:{backupErasure:'not_claimed'}};
const bytes=Buffer.from(canonicalize(payload)),scope={caseId:'synthetic-case',organizationId:'synthetic-org',environment:'sandbox' as const,exportId:'synthetic-export',payloadSha256:sha256Hex(bytes)};
const runtime=(changes:Partial<ReconstructionSigningBinding>={},testFixtures=true)=>createReconstructionSigningRuntime({clock,manifestSigning:material,binding:{...binding,...changes},activeSourceSha:'a'.repeat(40),testFixtures});
afterAll(()=>rmSync(directory,{recursive:true,force:true}));
it('signs the frozen package inventory with the existing signer and independently verifies its signature',async()=>{
 const signed=await runtime().sign(scope,bytes);
 expect(signed.profile).toBe('packproof.reconstruction-investigation/v2');expect(signed.qualification).toBe('synthetic_test_only');expect(signed.physicalTruthVerified).toBe(false);expect(signed.content).toEqual(payload);
 expect(signed.manifest).toMatchObject({caseRevision:3,projectionVersion:'projection-3',content:{sha256:scope.payloadSha256,byteSize:bytes.length},assertions:{count:1},associationDecisions:{count:1},extracts:{count:1},artifacts:{count:1}});
 expect(verifyManifestIntegrity({canonicalJson:canonicalize(signed.manifest),expectedSha256:signed.manifestSha256,signature:signed.signature,publicKeyPem}).signatureValid).toBe(true);
 expect(verifyManifestIntegrity({canonicalJson:canonicalize({...signed.manifest,caseRevision:4}),expectedSha256:signed.manifestSha256,signature:signed.signature,publicKeyPem}).digestValid).toBe(false);
 expect(signed.manifest.timeQuality).toEqual({sha256:sha256Hex(canonicalize({assertions:[{id:'assertion-1',reportedAt:null,sourceAsOf:null,receivedAt:'2026-11-14T02:00:00Z',timeQuality:'unknown'}],timeline:payload.projection.timeline}))});
 expect(signed.manifest.ruleAndIssueRevisions).toEqual({sha256:sha256Hex(canonicalize({comparisons:payload.projection.comparisons,ruleCapabilities:payload.projection.ruleCapabilities,rulesStatus:payload.projection.rulesStatus,issueHistory:[],sources:payload.projection.sources}))});
 const untrustedRegistry={registry:{version:1 as const,domain:'PACKPROOF_SIGNING_TRUST_REGISTRY' as const,publishedAt:'2026-11-13T00:00:00Z',nextReviewAt:'2026-11-16T00:00:00Z',keys:[]},signature:signed.signature};
 const verification=verifySignedReconstructionPackage(signed,{now:clock.now(),signedRegistry:untrustedRegistry,pinnedRegistryAuthorityKeys:{},onlineRevocationChecked:false});expect(verification.inventoryValid).toBe(true);expect(verification.fullyVerified).toBe(false);
 const changed=structuredClone(signed);(changed.content as typeof payload).projection.assertions[0].source.timeQuality='source_reported';expect(verifySignedReconstructionPackage(changed,{now:clock.now(),signedRegistry:untrustedRegistry,pinnedRegistryAuthorityKeys:{},onlineRevocationChecked:false}).inventoryValid).toBe(false);
});
it('rejects stale source/profile/time/scope and never admits synthetic signing in live or ordinary runtime',async()=>{
 for(const changes of [{sourceSha:'b'.repeat(40)},{profileSha256:'b'.repeat(64)},{expiresAt:'2026-11-14T03:00:00Z'},{organizationIds:['other-org']},{mode:'qualified_kms' as const}])await expect(runtime(changes).sign(scope,bytes)).rejects.toMatchObject({code:'RECONSTRUCTION_SIGNING_UNAVAILABLE'});
 await expect(runtime({},false).sign(scope,bytes)).rejects.toMatchObject({code:'RECONSTRUCTION_SIGNING_UNAVAILABLE'});
 await expect(runtime({environment:'live'}).sign({...scope,environment:'live'},bytes)).rejects.toMatchObject({code:'RECONSTRUCTION_SIGNING_UNAVAILABLE'});
});
it('publishes only the case organization while retaining private multi-organization qualification internally',async()=>{
 const privateOrganizations=['synthetic-org','private-unrelated-customer-a','private-unrelated-customer-b'],privateReference='Private review for private-unrelated-customer-a and two additional organizations',configured=runtime({organizationIds:privateOrganizations,qualificationReference:privateReference}),signed=await configured.sign(scope,bytes),serialized=canonicalize(signed);
 expect(configured.binding.organizationIds).toEqual(privateOrganizations);expect(configured.binding.qualificationReference).toBe(privateReference);expect(signed.binding.organizationIds).toEqual([scope.organizationId]);expect(signed.manifest.bindingSha256).toBe(sha256Hex(canonicalize(signed.binding)));expect(signed.manifest.qualificationSha256).toBe(configured.bindingSha256);expect(signed.manifest.bindingSha256).not.toBe(configured.bindingSha256);expect(signed.manifest.qualificationProjection).toBe('case_organization_only/v1');
 for(const privateValue of [...privateOrganizations.slice(1),privateReference])expect(serialized).not.toContain(privateValue);expect(serialized).not.toMatch(/organizationCount|qualifiedOrganizationCount|privateOrganizations/);
 const untrustedRegistry={registry:{version:1 as const,domain:'PACKPROOF_SIGNING_TRUST_REGISTRY' as const,publishedAt:'2026-11-13T00:00:00Z',nextReviewAt:'2026-11-16T00:00:00Z',keys:[]},signature:signed.signature},verification={now:clock.now(),signedRegistry:untrustedRegistry,pinnedRegistryAuthorityKeys:{},onlineRevocationChecked:false};
 expect(verifySignedReconstructionPackage(signed,verification).inventoryValid).toBe(true);
 const extraScope=structuredClone(signed);extraScope.binding.organizationIds.push(privateOrganizations[1]);extraScope.manifest.bindingSha256=sha256Hex(canonicalize(extraScope.binding));expect(verifySignedReconstructionPackage(extraScope,verification).inventoryValid).toBe(false);
 const wrongScope=structuredClone(signed);wrongScope.binding.organizationIds=[privateOrganizations[1]];expect(verifySignedReconstructionPackage(wrongScope,verification).inventoryValid).toBe(false);
 const changedBinding=structuredClone(signed);changedBinding.binding.expiresAt='2026-11-17T00:00:00Z';expect(verifySignedReconstructionPackage(changedBinding,verification).inventoryValid).toBe(false);
});
it('rejects changed frozen bytes and mismatched case identity',async()=>{
 await expect(runtime().sign(scope,Buffer.from(canonicalize({...payload,omissions:[]})))).rejects.toMatchObject({code:'RECONSTRUCTION_SIGNING_UNAVAILABLE'});
 await expect(runtime().sign({...scope,caseId:'other-case'},bytes)).rejects.toMatchObject({code:'RECONSTRUCTION_SIGNING_UNAVAILABLE'});
});
it('rejects a valid trusted generic signature that does not use the exact qualified case key',async()=>{
 const signed=await runtime().sign(scope,bytes);signed.binding={...signed.binding,mode:'qualified_kms',keyId:'qualified-case-key-never-used'};signed.qualification='qualified_runtime';signed.manifest={...signed.manifest,bindingSha256:sha256Hex(canonicalize(signed.binding))};const canonicalJson=canonicalize(signed.manifest);signed.manifestSha256=sha256Hex(canonicalJson);signed.signature=await material.signer!.signManifest({proofId:scope.caseId,manifestId:scope.exportId,canonicalJson,sha256:signed.manifestSha256});
 const registry={version:1 as const,domain:'PACKPROOF_SIGNING_TRUST_REGISTRY' as const,publishedAt:'2026-11-13T00:00:00Z',nextReviewAt:'2026-11-16T00:00:00Z',keys:[{keyId:'synthetic-case-key',algorithm:'ECDSA_SHA_256' as const,publicKeyPem,validFrom:'2026-11-13T00:00:00Z',validUntil:null,status:'ACTIVE' as const,statusEffectiveAt:null,reason:null}]},registryCanonical=canonicalize(registry),signature=await material.signer!.signManifest({proofId:'synthetic-registry',manifestId:'synthetic-registry',canonicalJson:registryCanonical,sha256:sha256Hex(registryCanonical)});
 expect(verifyManifestIntegrity({canonicalJson,expectedSha256:signed.manifestSha256,signature:signed.signature,publicKeyPem}).signatureValid).toBe(true);
 const result=verifySignedReconstructionPackage(signed,{now:clock.now(),signedRegistry:{registry,signature},pinnedRegistryAuthorityKeys:{'synthetic-case-key':publicKeyPem},onlineRevocationChecked:true});expect(result.fullyVerified).toBe(false);expect(result.inventoryValid).toBe(false);
});
it('requires separately pinned reviewed runtime inputs when enabling either irreversible capability',()=>{
 expect(initializeReconstructionSigningRuntime({clock,activeSourceSha:'a'.repeat(40),env:{}})).toBeUndefined();expect(initializeSourceDispositionRuntime({clock,activeSourceSha:'a'.repeat(40),env:{}})).toBeUndefined();
 expect(()=>initializeReconstructionSigningRuntime({clock,manifestSigning:material,activeSourceSha:'a'.repeat(40),env:{PACKPROOF_SIGNED_CASE_EXPORTS_ENABLED:'true'}})).toThrow(/pinned/);
 const file=join(directory,'binding.json');writeFileSync(file,canonicalize(binding));
 expect(()=>initializeReconstructionSigningRuntime({clock,manifestSigning:material,activeSourceSha:'a'.repeat(40),testFixtures:true,env:{PACKPROOF_SIGNED_CASE_EXPORTS_ENABLED:'true',PACKPROOF_SIGNED_CASE_EXPORT_BINDING_FILE:file,PACKPROOF_SIGNED_CASE_EXPORT_BINDING_SHA256:'0'.repeat(64)}})).toThrow(/pinned/);
 expect(initializeReconstructionSigningRuntime({clock,manifestSigning:material,activeSourceSha:'a'.repeat(40),testFixtures:true,env:{PACKPROOF_SIGNED_CASE_EXPORTS_ENABLED:'true',PACKPROOF_SIGNED_CASE_EXPORT_BINDING_FILE:file,PACKPROOF_SIGNED_CASE_EXPORT_BINDING_SHA256:sha256Hex(canonicalize(binding))}})).toBeDefined();
});
