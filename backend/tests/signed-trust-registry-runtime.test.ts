import { generateKeyPairSync, sign } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { canonicalize } from '../src/canonical.js';
import { sha256Hex } from '../src/hash.js';
import { loadManifestSigningRuntime } from '../src/integrity/signing-runtime.js';
import { initializeManifestSigningRuntime, type KmsSigningTransport } from '../src/integrity/kms-signing-runtime.js';
import { parseSignedTrustRegistry, verifyWithTrustRegistry, type SigningTrustRegistry, type SigningTrustKey } from '../src/domain/signing-trust.js';
import type { ManifestSignature } from '../src/domain/manifest-signing.js';
const current=generateKeyPairSync('ec',{namedCurve:'prime256v1'}),authority=generateKeyPairSync('ec',{namedCurve:'prime256v1'});
const publicPem=current.publicKey.export({type:'spki',format:'pem'}).toString(),authorityPem=authority.publicKey.export({type:'spki',format:'pem'}).toString();
let now=new Date('2026-09-07T12:00:00Z');const clock={now:()=>new Date(now)};
const canonicalJson='{"proofId":"registry-fixture"}',input={proofId:'registry-fixture',manifestId:'m',canonicalJson,sha256:sha256Hex(canonicalJson)};
const keyArn='arn:aws:kms:us-east-1:123456789012:key/12345678-1234-1234-1234-123456789012';
const dirs:string[]=[];afterEach(async()=>{await Promise.all(dirs.splice(0).map(dir=>rm(dir,{recursive:true,force:true})));now=new Date('2026-09-07T12:00:00Z');});
function signedRegistry(overrides:Partial<SigningTrustKey>={},registryOverrides:Partial<SigningTrustRegistry>={}){
 const registry:SigningTrustRegistry={version:1,domain:'PACKPROOF_SIGNING_TRUST_REGISTRY',publishedAt:'2026-09-01T00:00:00Z',nextReviewAt:'2026-10-01T00:00:00Z',keys:[{keyId:'manifest-key',algorithm:'ECDSA_SHA_256',publicKeyPem:publicPem,validFrom:'2026-01-01T00:00:00Z',validUntil:null,status:'ACTIVE',statusEffectiveAt:null,reason:null,...overrides}],...registryOverrides};
 const signature:ManifestSignature={keyId:'independent-authority',algorithm:'ECDSA_SHA_256',signedAt:registry.publishedAt,signatureBase64:sign('sha256',Buffer.from(canonicalize(registry)),authority.privateKey).toString('base64')};return {registry,signature};
}
async function fixture(){
 const dir=await mkdtemp(path.join(os.tmpdir(),'packproof-registry-'));dirs.push(dir);
 const keyFile=path.join(dir,'private.pem'),registryFile=path.join(dir,'registry.json'),pinsFile=path.join(dir,'pins.json');
 await writeFile(keyFile,current.privateKey.export({type:'pkcs8',format:'pem'}),{mode:0o600});
 const bytes=JSON.stringify(signedRegistry(),null,2)+'\n';await writeFile(registryFile,bytes);await writeFile(pinsFile,JSON.stringify({'independent-authority':authorityPem}));
 const env={PACKPROOF_MANIFEST_SIGNING_MODE:'pem',PACKPROOF_MANIFEST_SIGNING_REQUIRED:'true',PACKPROOF_MANIFEST_SIGNING_KEY_ID:'manifest-key',PACKPROOF_MANIFEST_SIGNING_KEY_FILE:keyFile,PACKPROOF_MANIFEST_SIGNING_ALGORITHM:'ECDSA_SHA_256',PACKPROOF_MANIFEST_SIGNED_TRUST_REGISTRY_FILE:registryFile,PACKPROOF_MANIFEST_REGISTRY_AUTHORITY_KEYS_FILE:pinsFile};return {env,bytes,registryFile,pinsFile};
}
const verify=(signature:ManifestSignature,registry= signedRegistry())=>verifyWithTrustRegistry({canonicalJson,expectedSha256:input.sha256,signature,signedRegistry:registry,pinnedRegistryAuthorityKeys:{'independent-authority':authorityPem},now,onlineRevocationChecked:false});
describe('independently signed runtime trust registry',()=>{
 it('uses external pinned authority for PEM signing and retains the exact approved registry bytes',async()=>{
  const f=await fixture(),runtime=loadManifestSigningRuntime(clock,f.env);
  expect(runtime.signedTrustRegistryJson).toBe(f.bytes);expect(runtime.publicStatus).toMatchObject({trustSource:'SIGNED_REGISTRY',trustRegistrySha256:sha256Hex(f.bytes)});
  expect(verify(await runtime.signer!.signManifest(input))).toMatchObject({fullyVerified:true,currentRevocationKnowledge:'UNAVAILABLE',physicalTruthVerified:false});
  expect(runtime.signedTrustRegistryJson).not.toContain('PRIVATE KEY');
 });
 it('refuses unknown authority, expired review, unsigned extra fields and out-of-period signing',async()=>{
  const f=await fixture();await writeFile(f.pinsFile,JSON.stringify({'wrong-authority':authorityPem}));expect(()=>loadManifestSigningRuntime(clock,f.env)).toThrow('not trusted');
  await writeFile(f.pinsFile,JSON.stringify({'independent-authority':authorityPem}));
  await writeFile(f.registryFile,JSON.stringify(signedRegistry({},{nextReviewAt:'2026-09-02T00:00:00Z'})));expect(()=>loadManifestSigningRuntime(clock,f.env)).toThrow('current');
  await writeFile(f.registryFile,JSON.stringify(signedRegistry({validFrom:'2026-10-01T00:00:00Z'})));expect(()=>loadManifestSigningRuntime(clock,f.env)).toThrow();
  expect(()=>parseSignedTrustRegistry(Buffer.from(JSON.stringify({...signedRegistry(),embeddedAuthority:authorityPem})))).toThrow('schema');
  expect(()=>loadManifestSigningRuntime(clock,{...f.env,PACKPROOF_MANIFEST_REGISTRY_AUTHORITY_KEYS_FILE:''})).toThrow('both');
 });
 it('reloads signed compromise before another signature and refuses backdating as a trust repair',async()=>{
  const f=await fixture(),runtime=loadManifestSigningRuntime(clock,f.env),first=await runtime.signer!.signManifest(input);
  const compromised=signedRegistry({status:'COMPROMISED',statusEffectiveAt:'2026-09-07T00:00:00Z',reason:'Reviewed fixture incident'},{publishedAt:'2026-09-07T01:00:00Z'});
  await writeFile(f.registryFile,JSON.stringify(compromised));
  expect(runtime.readSignedTrustRegistry!()).toBe(JSON.stringify(compromised));
  expect(runtime.trustList!.keys[0].status).toBe('REVOKED');
  await expect(runtime.signer!.signManifest(input)).rejects.toMatchObject({code:'MANIFEST_TRUST_EXPIRED'});
  expect(verify({...first,signedAt:'2026-09-01T00:00:00Z'},compromised)).toMatchObject({signatureValid:true,fullyVerified:false,historicalTrust:'REQUIRES_REVIEW'});
 });
 it('pins KMS public key to the registry and blocks Sign after review expires',async()=>{
  const f=await fixture();const transport:KmsSigningTransport={getPublicKey:vi.fn(async()=>({$metadata:{},KeyId:keyArn,KeyUsage:'SIGN_VERIFY',KeySpec:'ECC_NIST_P256',SigningAlgorithms:['ECDSA_SHA_256'],PublicKey:current.publicKey.export({type:'spki',format:'der'})})),sign:vi.fn(async()=>({$metadata:{},KeyId:keyArn,SigningAlgorithm:'ECDSA_SHA_256',Signature:sign('sha256',Buffer.from(canonicalJson),current.privateKey)}))};
  const runtime=await initializeManifestSigningRuntime(clock,{...f.env,PACKPROOF_MANIFEST_SIGNING_MODE:'kms',PACKPROOF_MANIFEST_SIGNING_KEY_FILE:'',PACKPROOF_MANIFEST_KMS_KEY_ARN:keyArn},transport);
  await runtime.signer!.signManifest(input);expect(transport.sign).toHaveBeenCalledTimes(1);now=new Date('2026-10-01T00:00:00Z');
  await expect(runtime.signer!.signManifest(input)).rejects.toMatchObject({code:'MANIFEST_TRUST_REFRESH_FAILED'});expect(transport.sign).toHaveBeenCalledTimes(1);expect(runtime.trustList!.expiresAt).toBe('2026-10-01T00:00:00Z');expect(transport.getPublicKey).toHaveBeenCalledTimes(1);
  expect(()=>runtime.readSignedTrustRegistry!()).toThrow('current independently approved');
 });
 it('permits retired signatures only through retirement and keeps the legacy compatibility list conservative',async()=>{
  const f=await fixture(),registry=signedRegistry({status:'RETIRED',statusEffectiveAt:'2026-09-01T00:00:00Z'});await writeFile(f.registryFile,JSON.stringify(registry));
  const runtime=loadManifestSigningRuntime(clock,{...f.env,PACKPROOF_MANIFEST_SIGNING_MODE:'unsigned',PACKPROOF_MANIFEST_SIGNING_REQUIRED:'false',PACKPROOF_MANIFEST_SIGNING_KEY_ID:'',PACKPROOF_MANIFEST_SIGNING_KEY_FILE:'',PACKPROOF_MANIFEST_SIGNING_ALGORITHM:''});expect(runtime.trustList!.keys[0].status).toBe('REVOKED');
  const signature:ManifestSignature={keyId:'manifest-key',algorithm:'ECDSA_SHA_256',signatureBase64:sign('sha256',Buffer.from(canonicalJson),current.privateKey).toString('base64'),signedAt:'2026-08-01T00:00:00Z'};
  expect(verify(signature,registry).fullyVerified).toBe(true);expect(verify({...signature,signedAt:'2026-09-02T00:00:00Z'},registry).fullyVerified).toBe(false);expect(verify({...signature,signedAt:'2026-10-02T00:00:00Z'},registry).fullyVerified).toBe(false);
 });
});
