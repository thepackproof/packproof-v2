/** Narrow KeyMint 100–500 authorization policy, using Android's published ASN.1.
 * This parser does not establish trust: call only after external-root chain and
 * revocation verification. No device identifiers or uniqueId are returned.
 * https://source.android.com/docs/security/features/keystore/attestation
 */
import { createHash, createPublicKey, timingSafeEqual } from 'node:crypto';
import * as asn1 from 'asn1js';
export interface AndroidKeyPolicy {
  packageName:string; certificateSha256Digests:string[]; minimumVersionCode:string;
  allowedAttestationVersions:number[]; allowedSecurityLevels:number[];
  minimumOsVersion:number; minimumOsPatchLevel:number; minimumVendorPatchLevel:number; minimumBootPatchLevel:number;
  verifiedBootKeySha256Digests?:string[];
}
export class AndroidKeyPolicyError extends Error { constructor(message:string,public readonly unsupported=false){super(message);} }
const need=(condition:unknown,reason:string):void=>{if(!condition)throw new AndroidKeyPolicyError(reason);};
const equal=(a:Buffer,b:Buffer)=>a.length===b.length&&timingSafeEqual(a,b);
function sequence(value:asn1.BaseBlock):asn1.BaseBlock[]{need(value instanceof asn1.Sequence,'ANDROID_EXPECTED_SEQUENCE');return (value as asn1.Sequence).valueBlock.value;}
function octets(value:asn1.BaseBlock):Buffer {need(value instanceof asn1.OctetString&&!value.idBlock.isConstructed,'ANDROID_EXPECTED_OCTETS');return Buffer.from((value as asn1.OctetString).valueBlock.valueHexView);}
function integer(value:asn1.BaseBlock,enumerated=false):number {
  need(enumerated?value instanceof asn1.Enumerated:value instanceof asn1.Integer&&!(value instanceof asn1.Enumerated),'ANDROID_EXPECTED_INTEGER');
  const bytes=Buffer.from((value as asn1.Integer).valueBlock.valueHexView);
  need(bytes.length>0&&bytes.length<=7&&!(bytes[0]&128)&&!(bytes.length>1&&bytes[0]===0&&!(bytes[1]&128)),'ANDROID_INTEGER_ENCODING');
  let n=0;for(const b of bytes)n=n*256+b;need(Number.isSafeInteger(n),'ANDROID_INTEGER_RANGE');return n;
}
function parse(data:Buffer):asn1.BaseBlock {
  need(data.length>0&&data.length<=16384,'ANDROID_EXTENSION_SIZE');
  const decoded=asn1.fromBER(data);need(decoded.offset===data.length&&!decoded.result.error,'ANDROID_MALFORMED_ASN1');
  let count=0;
  function bounded(node:asn1.BaseBlock,depth:number){need(depth<=12&&++count<=1024&&!node.lenBlock.isIndefiniteForm,'ANDROID_ASN1_LIMIT');if(node.idBlock.isConstructed){const children=(node as asn1.Constructed).valueBlock.value;need(Array.isArray(children),'ANDROID_ASN1_CONSTRUCTED');for(const child of children)bounded(child,depth+1);}}
  bounded(decoded.result,0);return decoded.result;
}
const knownTags=new Set([1,2,3,4,5,6,10,200,203,303,305,400,401,402,405,503,504,505,506,507,508,509,600,701,702,704,705,706,709,710,711,712,713,714,715,716,717,718,719,720,723,724]);
function authorization(value:asn1.BaseBlock):Map<number,asn1.BaseBlock>{
  const output=new Map<number,asn1.BaseBlock>();let previous=-1;
  for(const entry of sequence(value)){
    need(entry instanceof asn1.Constructed&&entry.idBlock.tagClass===3,'ANDROID_AUTHORIZATION_WRAPPER');
    const tag=entry.idBlock.tagNumber,children=(entry as asn1.Constructed).valueBlock.value;
    need(children.length===1&&!output.has(tag)&&tag>previous,'ANDROID_AUTHORIZATION_DUPLICATE_OR_ORDER');
    if(!knownTags.has(tag))throw new AndroidKeyPolicyError('ANDROID_AUTHORIZATION_TAG_NOT_SUPPORTED',true);
    output.set(tag,children[0]);previous=tag;
  }return output;
}
function required(list:Map<number,asn1.BaseBlock>,tag:number){const value=list.get(tag);need(value,'ANDROID_REQUIRED_AUTHORIZATION_MISSING');return value!;}
function intSet(value:asn1.BaseBlock):number[]{need(value instanceof asn1.Set,'ANDROID_EXPECTED_INTEGER_SET');const nums=(value as asn1.Set).valueBlock.value.map(v=>integer(v));need(nums.length>0&&nums.length<=16&&new Set(nums).size===nums.length,'ANDROID_INTEGER_SET_INVALID');return nums;}
export function assertAndroidKeyPolicy(policy:AndroidKeyPolicy):void {
  need(!!policy&&typeof policy.packageName==='string'&&/^[a-zA-Z][\w]*(?:\.[a-zA-Z][\w]*)+$/.test(policy.packageName),'ANDROID_POLICY_PACKAGE');
  need(Array.isArray(policy.certificateSha256Digests)&&policy.certificateSha256Digests.length>0&&policy.certificateSha256Digests.every(v=>/^[A-Za-z0-9_-]{43}$/.test(v))&&/^[1-9]\d{0,15}$/.test(policy.minimumVersionCode),'ANDROID_POLICY_APPLICATION');
  need(Array.isArray(policy.allowedAttestationVersions)&&policy.allowedAttestationVersions.length>0&&policy.allowedAttestationVersions.every(v=>[100,200,300,400,500].includes(v))&&Array.isArray(policy.allowedSecurityLevels)&&policy.allowedSecurityLevels.length>0&&policy.allowedSecurityLevels.every(v=>v===1||v===2),'ANDROID_POLICY_PROFILE');
  need([policy.minimumOsVersion,policy.minimumOsPatchLevel,policy.minimumVendorPatchLevel,policy.minimumBootPatchLevel].every(v=>Number.isSafeInteger(v)&&v>0),'ANDROID_POLICY_PATCH_FLOORS');
  need(policy.verifiedBootKeySha256Digests===undefined||Array.isArray(policy.verifiedBootKeySha256Digests)&&policy.verifiedBootKeySha256Digests.length>0&&policy.verifiedBootKeySha256Digests.every(v=>/^[A-Za-z0-9_-]{43}$/.test(v)),'ANDROID_POLICY_BOOT_PINS');
}
/** Returns policy observations, never a standalone assurance verdict. */
export function evaluateAndroidKeyPolicy(input:{extensionDer:Buffer;expectedChallenge:Uint8Array;certificatePublicKeyPem:string;expectedPublicKeyPem:string;now:number},policy:AndroidKeyPolicy):Record<string,unknown>{
  assertAndroidKeyPolicy(policy);
  const fields=sequence(parse(input.extensionDer));need(fields.length===8,'ANDROID_KEY_DESCRIPTION_SHAPE');
  const version=integer(fields[0]),attestationLevel=integer(fields[1],true),keyMintVersion=integer(fields[2]),keyLevel=integer(fields[3],true);
  if(!policy.allowedAttestationVersions.includes(version)||keyMintVersion!==version)throw new AndroidKeyPolicyError('ANDROID_KEYMINT_PROFILE_NOT_SUPPORTED',true);
  need(policy.allowedSecurityLevels.includes(attestationLevel)&&policy.allowedSecurityLevels.includes(keyLevel)&&attestationLevel===keyLevel,'ANDROID_SECURITY_LEVEL_NOT_ALLOWED');
  need(input.expectedChallenge.length===32&&equal(octets(fields[4]),Buffer.from(input.expectedChallenge)),'ANDROID_ATTESTATION_CHALLENGE_MISMATCH');octets(fields[5]);
  const software=authorization(fields[6]),hardware=authorization(fields[7]);
  for(const tag of hardware.keys())need(!software.has(tag),'ANDROID_AUTHORIZATION_CONFLICT');
  need(!software.has(600)&&!hardware.has(600),'ANDROID_ALL_APPLICATIONS_FORBIDDEN');
  const purposes=intSet(required(hardware,1)),digests=intSet(required(hardware,5));
  need(purposes.includes(2)&&purposes.every(v=>v===2||v===3),'ANDROID_KEY_PURPOSE_NOT_ALLOWED');
  need(integer(required(hardware,2))===3&&integer(required(hardware,3))===256&&integer(required(hardware,10))===1&&integer(required(hardware,702))===0,'ANDROID_KEY_PARAMETERS_NOT_ALLOWED');
  need(digests.length===1&&digests[0]===4,'ANDROID_KEY_DIGEST_NOT_ALLOWED');
  for(const list of [software,hardware])for(const [tag,expires] of [[400,false],[401,true],[402,true]] as const)if(list.has(tag)){const time=integer(list.get(tag)!);need(expires?input.now<time:time<=input.now,'ANDROID_KEY_VALIDITY_NOT_MET');}
  const root=sequence(required(hardware,704));need(root.length===4,'ANDROID_ROOT_OF_TRUST_SHAPE');
  const bootKey=octets(root[0]),bootHash=octets(root[3]);
  need(bootKey.length===32&&bootKey.some(v=>v!==0)&&bootHash.length===32&&root[1] instanceof asn1.Boolean&&root[1].valueBlock.value===true&&integer(root[2],true)===0,'ANDROID_VERIFIED_BOOT_REQUIRED');
  const bootKeyDigest=createHash('sha256').update(bootKey).digest('base64url');
  need(!policy.verifiedBootKeySha256Digests||policy.verifiedBootKeySha256Digests.includes(bootKeyDigest),'ANDROID_BOOT_KEY_NOT_ALLOWED');
  const osVersion=integer(required(hardware,705)),osPatchLevel=integer(required(hardware,706)),vendorPatchLevel=integer(required(hardware,718)),bootPatchLevel=integer(required(hardware,719));
  need(osVersion>=policy.minimumOsVersion&&osPatchLevel>=policy.minimumOsPatchLevel&&vendorPatchLevel>=policy.minimumVendorPatchLevel&&bootPatchLevel>=policy.minimumBootPatchLevel,'ANDROID_PATCH_POLICY_NOT_MET');
  const app=sequence(parse(octets(required(software,709))));need(app.length===2&&app[0] instanceof asn1.Set&&app[1] instanceof asn1.Set,'ANDROID_APPLICATION_ID_SHAPE');
  const packages=(app[0] as asn1.Set).valueBlock.value,certificates=(app[1] as asn1.Set).valueBlock.value;need(packages.length===1&&certificates.length>0&&certificates.length<=8,'ANDROID_APPLICATION_SCOPE');
  const pkg=sequence(packages[0]);need(pkg.length===2&&equal(octets(pkg[0]),Buffer.from(policy.packageName)),'ANDROID_PACKAGE_MISMATCH');
  const applicationVersion=integer(pkg[1]);need(BigInt(applicationVersion)>=BigInt(policy.minimumVersionCode),'ANDROID_APP_VERSION_NOT_ALLOWED');
  const certificateDigests=certificates.map(v=>octets(v));need(certificateDigests.every(v=>v.length===32&&policy.certificateSha256Digests.includes(v.toString('base64url'))),'ANDROID_APP_CERTIFICATE_MISMATCH');
  need(/^-----BEGIN PUBLIC KEY-----\r?\n[A-Za-z0-9+/\r\n=]+-----END PUBLIC KEY-----\r?\n?$/.test(input.expectedPublicKeyPem),'ANDROID_PUBLIC_KEY_FORMAT');
  const certKey=createPublicKey(input.certificatePublicKeyPem),expected=createPublicKey(input.expectedPublicKeyPem),jwk=certKey.export({format:'jwk'});
  need(jwk.kty==='EC'&&jwk.crv==='P-256'&&equal(certKey.export({format:'der',type:'spki'}),expected.export({format:'der',type:'spki'})),'ANDROID_ATTESTED_PUBLIC_KEY_MISMATCH');
  return {authorizationPolicy:'STRICT_KEYMINT_P256_V1',attestationVersion:version,keyMintVersion,attestationSecurityLevel:attestationLevel===2?'STRONG_BOX':'TRUSTED_ENVIRONMENT',keySecurityLevel:keyLevel===2?'STRONG_BOX':'TRUSTED_ENVIRONMENT',appIdentity:'VALIDATED',applicationVersion,verifiedBoot:'VERIFIED_AND_LOCKED',osVersion,osPatchLevel,vendorPatchLevel,bootPatchLevel,keyPurpose:'SIGN',keyProtection:'HARDWARE_POLICY_VALIDATED',publicKeySha256:createHash('sha256').update(certKey.export({format:'der',type:'spki'})).digest('hex')};
}
