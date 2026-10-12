/** Generated certificates test protocol validation, not an actual Android device. */
import { afterAll,beforeAll,describe,expect,it } from 'vitest';
import { createHash,createPublicKey,generateKeyPairSync,sign } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtempSync,readFileSync,rmSync,writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as asn1 from 'asn1js';
import cbor from 'cbor';
import { evaluateAndroidKeyPolicy,type AndroidKeyPolicy } from '../src/rnd/android-key-policy.js';
import { verifyAndroidKeyAttestationChain,type AndroidKeyAttestationTrustPolicy } from '../src/rnd/platform-assurance.js';
import { issuePlatformChallenge,verifyPlatformChallenge,loadPlatformAssuranceConfig } from '../src/rnd/platform-assurance-service.js';
import { createHarness,createUser } from './helpers.js';
import { createTransaction } from '../src/domain/transactions.js';
import { createOrGetProof } from '../src/domain/create-proof.js';
import { createCaptureSession } from '../src/domain/capture-sessions.js';
import { recordConsent,issueIntent,startIntent } from '../src/rnd/capture.js';
import { enabledResearchConfig } from '../src/rnd/config.js';
import type { RndDeps } from '../src/rnd/types.js';
import type { ManifestSigningRuntime } from '../src/integrity/signing-runtime.js';
const hash=(value:string|Uint8Array)=>createHash('sha256').update(value).digest();
const I=(value:number)=>new asn1.Integer({value}),E=(value:number)=>new asn1.Enumerated({value}),O=(value:Uint8Array)=>new asn1.OctetString({valueHex:Buffer.from(value)}),S=(...value:asn1.BaseBlock[])=>new asn1.Sequence({value}),set=(...value:asn1.BaseBlock[])=>new asn1.Set({value}),tag=(n:number,value:asn1.BaseBlock)=>new asn1.Constructed({idBlock:{tagClass:3,tagNumber:n},value:[value]});
const now=Date.now()+30000,challenge=hash('randomized server challenge fixture'),appCert=hash('research app certificate');
const policy:AndroidKeyPolicy={packageName:'com.packproof.mobile.research',certificateSha256Digests:[appCert.toString('base64url')],minimumVersionCode:'55',allowedAttestationVersions:[100,200,300,400,500],allowedSecurityLevels:[1,2],minimumOsVersion:120000,minimumOsPatchLevel:202609,minimumVendorPatchLevel:20260901,minimumBootPatchLevel:20260901};
function record(options:{version?:number;security?:number;challenge?:Buffer;packageName?:string;appVersion?:number;appCert?:Buffer;hardware?:Map<number,asn1.BaseBlock>;software?:Map<number,asn1.BaseBlock>;locked?:boolean;bootState?:number;extra?:asn1.BaseBlock[]}={}){
 const hardware=new Map<number,asn1.BaseBlock>([[1,set(I(2))],[2,I(3)],[3,I(256)],[5,set(I(4))],[10,I(1)],[503,new asn1.Null()],[702,I(0)],[704,S(O(hash('boot key')),new asn1.Boolean({value:options.locked??true}),E(options.bootState??0),O(hash('boot image')))],[705,I(160000)],[706,I(202610)],[718,I(20261001)],[719,I(20261001)]]);
 const appId=Buffer.from(S(set(S(O(Buffer.from(options.packageName??policy.packageName)),I(options.appVersion??55))),set(O(options.appCert??appCert))).toBER(false));
 const software=new Map<number,asn1.BaseBlock>([[709,O(appId)]]);
 for(const [k,v]of options.hardware??[])hardware.set(k,v);for(const [k,v]of options.software??[])software.set(k,v);
 const auth=(list:Map<number,asn1.BaseBlock>)=>S(...[...list].sort(([a],[b])=>a-b).map(([n,v])=>tag(n,v)));
 return Buffer.from(S(I(options.version??300),E(options.security??1),I(options.version??300),E(options.security??1),O(options.challenge??challenge),O(Buffer.alloc(0)),auth(software),S(...auth(hardware).valueBlock.value,...options.extra??[])).toBER(false));
}
let temporary:string,publicKeyPem:string,privateKeyPem:string,trust:AndroidKeyAttestationTrustPolicy;
const run=(...args:string[])=>execFileSync('openssl',args,{cwd:temporary,stdio:['ignore','pipe','pipe']});
const read=(name:string)=>readFileSync(join(temporary,name),'utf8');
function certificate(extension=record(),options:{ancestor?:boolean;provisioning?:Buffer}={}){
 let issuer='root';
 if(options.ancestor||options.provisioning){
  const oid=options.ancestor?'1.3.6.1.4.1.11129.2.1.17':'1.3.6.1.4.1.11129.2.1.30',data=options.ancestor?record():options.provisioning!;
  writeFileSync(join(temporary,'intermediate.ext'),`basicConstraints=critical,CA:TRUE,pathlen:0\nkeyUsage=critical,keyCertSign,cRLSign\n${oid}=DER:${data.toString('hex').match(/../g)!.join(':')}\n`);
  run('x509','-req','-in','intermediate.csr','-CA','root.pem','-CAkey','root.key','-set_serial','2','-out','intermediate.pem','-days','1','-sha256','-extfile','intermediate.ext');issuer='intermediate';
 }
 writeFileSync(join(temporary,'leaf.ext'),`basicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature\n1.3.6.1.4.1.11129.2.1.17=DER:${extension.toString('hex').match(/../g)!.join(':')}\n`);
 run('x509','-req','-in','leaf.csr','-CA',`${issuer}.pem`,'-CAkey',`${issuer}.key`,'-set_serial','3','-out','leaf.pem','-days','1','-sha256','-extfile','leaf.ext');
 return [run('x509','-in','leaf.pem','-outform','DER').toString('base64'),...(issuer==='intermediate'?[run('x509','-in','intermediate.pem','-outform','DER').toString('base64')]:[])];
}
beforeAll(()=>{
 temporary=mkdtempSync(join(tmpdir(),'packproof-android-policy-'));
 run('req','-x509','-newkey','ec','-pkeyopt','ec_paramgen_curve:P-256','-nodes','-keyout','root.key','-out','root.pem','-sha256','-days','2','-subj','/CN=TEST ONLY Android protocol root','-addext','basicConstraints=critical,CA:TRUE','-addext','keyUsage=critical,keyCertSign,cRLSign');
 for(const name of ['leaf','intermediate'])run('req','-newkey','ec','-pkeyopt','ec_paramgen_curve:P-256','-nodes','-keyout',`${name}.key`,'-out',`${name}.csr`,'-subj',`/CN=TEST ONLY ${name}`);
 privateKeyPem=read('leaf.key');publicKeyPem=createPublicKey(privateKeyPem).export({format:'pem',type:'spki'}).toString();
 trust={trustedRootCertificatesPem:[read('root.pem')],revocationEntries:{},revocationValidUntil:now+600000,trustPolicyExpiresAt:now+600000,trustPolicyId:'TEST_ONLY_GENERATED_ROOT',authorization:policy};
});
afterAll(()=>rmSync(temporary,{recursive:true,force:true}));
const evaluate=(extensionDer=record(),configured=policy,expectedPublicKeyPem=publicKeyPem)=>evaluateAndroidKeyPolicy({extensionDer,expectedChallenge:challenge,certificatePublicKeyPem:publicKeyPem,expectedPublicKeyPem,now},configured);
const check=(certificatesBase64=certificate(),configured=trust)=>verifyAndroidKeyAttestationChain({certificatesBase64,now,expectedChallenge:challenge,expectedPublicKeyPem:publicKeyPem},configured);
describe('strict Android KeyMint authorization policy',()=>{
 it('parses current hardware fields with no standalone trusted verdict or device identifier',()=>{const value=evaluate();expect(value).toMatchObject({attestationVersion:300,verifiedBoot:'VERIFIED_AND_LOCKED',applicationVersion:55,keyProtection:'HARDWARE_POLICY_VALIDATED'});expect(value).not.toHaveProperty('state');expect(value).not.toHaveProperty('uniqueId');});
 it.each([
  ['wrong challenge',{challenge:hash('other')}],['software security',{security:0}],['unlocked boot',{locked:false}],['unverified boot',{bootState:2}],['other app',{packageName:'evil.app'}],['old app',{appVersion:54}],['other certificate',{appCert:hash('wrong')}],['key agreement purpose',{hardware:new Map([[1,set(I(6))]])}],['SHA1 digest',{hardware:new Map([[5,set(I(2))]])}],['imported origin',{hardware:new Map([[702,I(2)]])}],['RSA algorithm',{hardware:new Map([[2,I(1)]])}],['wrong curve',{hardware:new Map([[10,I(2)]])}],['old OS patch',{hardware:new Map([[706,I(202608)]])}],['old vendor patch',{hardware:new Map([[718,I(20260801)]])}],['old boot patch',{hardware:new Map([[719,I(20260801)]])}],['duplicate hardware tag',{extra:[tag(719,I(20261001))]}],['software fallback conflict',{software:new Map([[1,set(I(2))]])}],['all applications',{software:new Map([[600,new asn1.Null()]])}],['expired key',{hardware:new Map([[401,I(now-1)]])}]
 ] as const)('rejects %s',(_name,options)=>{expect(()=>evaluate(record(options))).toThrow();});
 it('rejects wrong public key, trailing/malformed ASN1 and unconfigured policy floors',()=>{
  const other=generateKeyPairSync('ec',{namedCurve:'prime256v1'}).publicKey.export({type:'spki',format:'pem'}).toString();expect(()=>evaluate(record(),policy,other)).toThrow(/PUBLIC_KEY/);expect(()=>evaluate(record(),policy,privateKeyPem)).toThrow(/PUBLIC_KEY_FORMAT/);
  for(const bytes of [Buffer.concat([record(),Buffer.from([0])]),Buffer.from('3000','hex')])expect(()=>evaluate(bytes)).toThrow();
  expect(()=>evaluate(record(),{...policy,minimumOsPatchLevel:0})).toThrow(/POLICY/);
 });
 it('fails explicitly unsupported for unqualified Keymaster and new unknown authorization tags',()=>{for(const bytes of [record({version:4}),record({extra:[tag(999,new asn1.Null())]})])try{evaluate(bytes);throw Error('Unexpected acceptance');}catch(error){expect(error).toMatchObject({unsupported:true});}});
 it('verifies actual X509 signatures and root pins before yielding scoped hardware policy observations',async()=>{const result=await check();expect(result.reasonCodes).toEqual([]);expect(result.state).toBe('VALIDATED');expect(result.components).toMatchObject({qualification:'RESEARCH_UNQUALIFIED',cameraSensor:'NOT_CHECKED'});});
 it('rejects forged chain signature, revoked serial and unknown trust root',async()=>{
  const certs=certificate(),bytes=Buffer.from(certs[0],'base64');bytes[bytes.length-1]^=1;
  expect((await check([bytes.toString('base64')])).state).toBe('INVALID');expect((await check(certs,{...trust,revocationEntries:{'03':{status:'REVOKED'}}})).reasonCodes).toContain('ANDROID_ATTESTATION_CERTIFICATE_REVOKED');
  expect((await check(certs,{...trust,trustedRootCertificatesPem:[read('leaf.pem')]})).state).toBe('INVALID');
 });
 it('rejects stale roots/revocation and never upgrades a chain-only diagnostic',async()=>{const certs=certificate();for(const configured of [{...trust,revocationValidUntil:now},{...trust,trustPolicyExpiresAt:now},{...trust,authorization:undefined}])expect((await check(certs,configured)).state).toBe('UNSUPPORTED');});
 it('selects root-most attestation and refuses an attacker descendant claiming that key protection',async()=>{expect((await check(certificate(record(),{ancestor:true}))).reasonCodes).toContain('ANDROID_DELEGATED_KEY_PROFILE_NOT_SUPPORTED');});
 it('validates provisioning adjacency and refuses reported-lost/security mismatch evidence',async()=>{expect((await check(certificate(record(),{provisioning:cbor.encode(new Map([[1,50],[4,'TEE']]))}))).state).toBe('VALIDATED');for(const details of [new Map<unknown,unknown>([[4,'TEE'],[6,true]]),new Map<unknown,unknown>([[4,'STRONG_BOX']])])expect((await check(certificate(record(),{provisioning:cbor.encode(details)}))).state).toBe('INVALID');});
 it('loads only explicit server research policy and rejects production package identity',()=>{
  const path=join(temporary,'policy.json'),write=(androidKey:unknown)=>writeFileSync(path,JSON.stringify({schemaVersion:'packproof.platform-policy.v1',androidKey}));
  write(trust);expect(loadPlatformAssuranceConfig({PACKPROOF_ENV:'research',PACKPROOF_RND_ENABLED:'1',PACKPROOF_RND_PLATFORM_POLICY_FILE:path})?.androidKey?.trustPolicyId).toBe(trust.trustPolicyId);
  write({...trust,authorization:{...policy,packageName:'com.packproof.mobile'}});expect(()=>loadPlatformAssuranceConfig({PACKPROOF_ENV:'research',PACKPROOF_RND_ENABLED:'1',PACKPROOF_RND_PLATFORM_POLICY_FILE:path})).toThrow(/policy/);
 });
 it('persists dedicated-key inventory assurance with exact challenge binding, idempotency and no recording-key upgrade',async()=>{
  const signer=generateKeyPairSync('ec',{namedCurve:'prime256v1'}),signing:ManifestSigningRuntime={publicStatus:{mode:'SIGNED',algorithm:'ECDSA_SHA_256',keyId:'TEST_ONLY_SIGNER',required:true,trustListSha256:null},signer:{async signManifest(input){return {algorithm:'ECDSA_SHA_256',keyId:'TEST_ONLY_SIGNER',signedAt:new Date(now).toISOString(),signatureBase64:sign('sha256',Buffer.from(input.canonicalJson),signer.privateKey).toString('base64')};}}};
  const h=await createHarness({now:()=>new Date(now)},{manifestSigning:signing});
  try{
   const actor=await createUser(h),deps:RndDeps={...h,manifestSigning:signing,rnd:{...enabledResearchConfig(),platform:{androidKey:trust}}};
   const transaction=await createTransaction(h.db,h.clock,actor,{itemTitle:'TEST ONLY Android protocol'}),proof=await createOrGetProof(h.db,h.clock,actor,transaction.transactionId),proofId=proof.proofId;
   await recordConsent(deps,actor,proofId,'consent',{purpose:'EXPERIMENTAL_ANALYSIS',version:'packproof.research-consent.v1',granted:true});
   const intent=await issueIntent(deps,actor,proofId,'intent',{legId:'OUTBOUND',acquisitionMode:'ONLINE',profileId:'TEST_ONLY'}),session=await createCaptureSession(h.db,h.clock,actor,proofId,{client:'NATIVE_CAMERA',idempotencyKey:'capture'});
   await startIntent(deps,actor,proofId,intent.intent.id,'start',{nonce:intent.intent.nonce,captureSessionId:session.id});
   const clientCanonicalJson='{"inventory":"generated-protocol-fixture"}',inventoryDigest=hash(clientCanonicalJson).toString('hex');
   const issue=(id:string)=>issuePlatformChallenge(deps,actor,proofId,id,{intentId:intent.intent.id,purpose:'CLOSE_INVENTORY',inventoryDigest});
   const issued=await issue('challenge'),certificateChainBase64=certificate(record({challenge:Buffer.from(issued.expectedClientDataHash,'base64')}));
   const input={platform:'android',certificateChainBase64,publicKeyPem,clientCanonicalJson,inventorySignatureBase64:sign('sha256',Buffer.from(clientCanonicalJson),privateKeyPem).toString('base64')};
   const checked=await verifyPlatformChallenge(deps,actor,proofId,issued.challenge.challengeId,'verify',input);
   expect(checked.assurance.reasonCodes).toEqual([]);expect(checked.assurance.state).toBe('VALIDATED');expect(checked.assurance.components).toMatchObject({keyRole:'ATTESTATION_REQUEST_KEY',inventorySignature:'VALIDATED',recordingSessionKeyProtection:'NOT_CHECKED'});
   expect(await verifyPlatformChallenge(deps,actor,proofId,issued.challenge.challengeId,'retry',input)).toEqual(checked);
   const replay=await issue('replay');expect((await verifyPlatformChallenge(deps,actor,proofId,replay.challenge.challengeId,'replay-verify',input)).assurance.reasonCodes).toContain('ANDROID_ATTESTATION_CHALLENGE_MISMATCH');
   const wrong=await issue('wrong');expect((await verifyPlatformChallenge(deps,actor,proofId,wrong.challenge.challengeId,'wrong-verify',{...input,clientCanonicalJson:'{}'})).assurance.reasonCodes).toContain('ANDROID_INVENTORY_BINDING_MISMATCH');
   const forged=await issue('forged');expect((await verifyPlatformChallenge(deps,actor,proofId,forged.challenge.challengeId,'forged-verify',{...input,inventorySignatureBase64:sign('sha256',Buffer.from(clientCanonicalJson),signer.privateKey).toString('base64')})).assurance.reasonCodes).toContain('ANDROID_INVENTORY_SIGNATURE_INVALID');
   await expect(verifyPlatformChallenge(deps,actor,proofId,forged.challenge.challengeId,'mixed',{...input,token:'mixed-provider'})).rejects.toMatchObject({code:'RND_PLATFORM_INPUT'});
  }finally{await h.close();}
 },30000);
});
