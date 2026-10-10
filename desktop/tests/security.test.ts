import {describe,it,expect} from 'vitest';
import {isTrustedRenderer,parseDeepLink,isAllowedExternal,integrationManagementUrl,schemas} from '../src/main/security';
describe('native boundary',()=>{
 it('opens marketplace management at the deployed website route without inheriting a base path',()=>{
  for(const base of ['https://thepackproof.com','https://thepackproof.com/','https://thepackproof.com/app']){
   const url=integrationManagementUrl(base);
   expect(url).toBe('https://thepackproof.com/stores');
   expect(isAllowedExternal(url,base)).toBe(true);
  }
 });
 it('limits IPC to the application origin',()=>{expect(isTrustedRenderer('packproof-app://app/index.html')).toBe(true);for(const bad of ['https://app/','file:///tmp/index.html','packproof-app://evil/index.html','packproof-app://user:pw@app/','packproof-app://app:4/'])expect(isTrustedRenderer(bad)).toBe(false);});
 it('deep links allow only typed identifiers without query authority',()=>{expect(parseDeepLink('packproof://proof/proof_01ABC')).toBe('/proof/proof_01ABC');expect(parseDeepLink('packproof://uploads')).toBe('/uploads');for(const bad of ['packproof://proof/../secrets','packproof://proof/a?token=secret','packproof://proof/a#x','packproof://u:p@proof/a','https://proof/a','packproof://order/%2fetc','packproof://proof/a/b'])expect(parseDeepLink(bad)).toBeNull();});
 it('external links cannot escape PackProof',()=>{for(const bad of ['javascript:alert(1)','https://thepackproof.com.evil.com/','https://evil.com/','https://user:pass@thepackproof.com/'])expect(isAllowedExternal(bad,'https://thepackproof.com')).toBe(false);expect(isAllowedExternal('https://thepackproof.com/privacy','https://thepackproof.com')).toBe(true);});
 it('capture payload rejects traversal, unknown properties, and oversized chunks',()=>{expect(schemas.id.safeParse(['../../x']).success).toBe(false);expect(schemas.chunk.safeParse(['job_1',0,new ArrayBuffer(8*1024*1024+1)]).success).toBe(false);expect(schemas.login.safeParse([{email:'a@example.com',password:'x',token:'injected'}]).success).toBe(false);expect(schemas.finish.safeParse(['job_1',{attestation:true,durationMs:NaN,detections:[]}]).success).toBe(false);});
 it('sharing requires explicit true consent, a current-format hash, and bounded future expiry',()=>{
  const input={previewHash:'a'.repeat(64),originalsReviewed:true,expiresAt:new Date(Date.now()+86400_000).toISOString()};
  expect(schemas.share.safeParse(['proof_1',input]).success).toBe(true);
  for(const bad of [{...input,originalsReviewed:false},{...input,originalsReviewed:undefined},{...input,previewHash:'forged'},{...input,expiresAt:new Date(Date.now()-1000).toISOString()},{...input,expiresAt:new Date(Date.now()+31*86400_000).toISOString()},{...input,token:'injected'},{...input,purpose:'PUBLIC_SAMPLE'}])expect(schemas.share.safeParse(['proof_1',bad]).success).toBe(false);
  expect(schemas.evidence.safeParse(['proof_1','evidence_1',input.previewHash]).success).toBe(true);
  expect(schemas.evidence.safeParse(['proof_1','evidence_1',input.previewHash,'stage_from_renderer']).success).toBe(false);
 });
});
