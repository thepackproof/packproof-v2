/**
 * Server-side platform evidence checks. Call only with server-resolved bindings,
 * trust policies and keys. These signals do not attest the camera sensor or scene.
 * References: Apple DeviceCheck/validating-apps-that-connect-to-your-server;
 * Android Play Integrity/standard, /verdicts; security-key-attestation.
 */
import { createHash, createPublicKey, timingSafeEqual, verify, webcrypto, X509Certificate } from 'node:crypto';
import cbor from 'cbor';
import * as asn1 from 'asn1js';
import { Certificate, CertificateChainValidationEngine, CryptoEngine } from 'pkijs';
import { AndroidKeyPolicyError, evaluateAndroidKeyPolicy, type AndroidKeyPolicy } from './android-key-policy.js';

export type AssuranceState = 'VALIDATED' | 'INVALID' | 'UNSUPPORTED';
export interface PlatformAssuranceResult {
  state: AssuranceState;
  reasonCodes: string[];
  components: Record<string, unknown>;
  limitations: string[];
}
const LIMITATIONS = ['App, request and key assurance do not establish camera sensor provenance, physical identity or truth of the scene.'];
const result = (state: AssuranceState, reason: string, components: Record<string, unknown> = {}): PlatformAssuranceResult => ({ state, reasonCodes: reason ? [reason] : [], components, limitations: [...LIMITATIONS] });
const sha256 = (value: Uint8Array | string) => createHash('sha256').update(value).digest();
const same = (left: Uint8Array, right: Uint8Array) => left.byteLength === right.byteLength && timingSafeEqual(left, right);
class InvalidEvidence extends Error {}
export class PlatformServiceUnavailable extends Error {}
function requireThat(condition: unknown, reason: string): asserts condition { if (!condition) throw new InvalidEvidence(reason); }
function failure(error: unknown): PlatformAssuranceResult {
  return error instanceof PlatformServiceUnavailable ? result('UNSUPPORTED', error.message) : result('INVALID', error instanceof InvalidEvidence ? error.message : 'MALFORMED_PLATFORM_EVIDENCE');
}
function bytes(value: unknown, maximum = 65536): Buffer {
  requireThat(Buffer.isBuffer(value) || value instanceof Uint8Array, 'EXPECTED_BINARY_VALUE');
  const data = Buffer.from(value as Uint8Array);
  requireThat(data.length > 0 && data.length <= maximum, 'PLATFORM_EVIDENCE_SIZE');
  return data;
}
function base64(value: string, maximum = 65536): Buffer {
  requireThat(typeof value === 'string' && value.length <= Math.ceil(maximum / 3) * 4 && /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value), 'INVALID_BASE64');
  const data = Buffer.from(value, 'base64');
  requireThat(data.length > 0 && data.length <= maximum && data.toString('base64') === value, 'INVALID_BASE64');
  return data;
}
function map(value: unknown): Map<unknown, unknown> { requireThat(value instanceof Map, 'EXPECTED_CBOR_MAP'); return value as Map<unknown, unknown>; }
function decode(value: Buffer): Map<unknown, unknown> { return map(cbor.decodeFirstSync(value, { max_depth: 12, preventDuplicateKeys: true, preferMap: true })); }
function digest(value: Uint8Array): Buffer { const output = bytes(value, 32); requireThat(output.length === 32, 'INVALID_REQUEST_DIGEST'); return output; }

export interface ChallengeWindow { now: number; challengeIssuedAt: number; challengeExpiresAt: number; }
function checkWindow(window: ChallengeWindow) {
  requireThat([window.now, window.challengeIssuedAt, window.challengeExpiresAt].every(Number.isSafeInteger), 'INVALID_CHALLENGE_WINDOW');
  requireThat(window.challengeIssuedAt <= window.now && window.now < window.challengeExpiresAt && window.challengeExpiresAt - window.challengeIssuedAt <= 15 * 60_000, 'CHALLENGE_EXPIRED_OR_NOT_YET_VALID');
}
export interface PlayIntegrityPolicy {
  packageName: string;
  certificateSha256Digests: string[];
  minimumVersionCode: string;
  requiredDeviceVerdicts: string[];
  requireLicensed: boolean;
  maxTokenAgeMs: number;
  decodeToken?: (token: string) => Promise<unknown>;
}
/** The callback must authenticate to Google's service; never pass client-decoded JSON. */
export async function verifyPlayIntegrity(input: ChallengeWindow & { token: string; expectedRequestHash: string; expectedNonce?: string; }, policy?: PlayIntegrityPolicy): Promise<PlatformAssuranceResult> {
  if (!policy?.decodeToken || !policy.certificateSha256Digests.length) return result('UNSUPPORTED', 'PLAY_INTEGRITY_SERVICE_NOT_CONFIGURED');
  try {
    checkWindow(input);
    requireThat(typeof input.token === 'string' && input.token.length > 0 && input.token.length <= 65536, 'INVALID_INTEGRITY_TOKEN');
    requireThat(/^[A-Za-z0-9_-]{43}$/.test(input.expectedRequestHash), 'INVALID_REQUEST_HASH');
    requireThat(/^[1-9]\d{0,18}$/.test(policy.minimumVersionCode) && Number.isSafeInteger(policy.maxTokenAgeMs) && policy.maxTokenAgeMs > 0 && policy.maxTokenAgeMs <= 15 * 60_000, 'INVALID_PLAY_POLICY');
    const decoded = await policy.decodeToken(input.token) as { tokenPayloadExternal?: Record<string, any> };
    const payload = decoded?.tokenPayloadExternal;
    requireThat(payload && typeof payload === 'object', 'INVALID_GOOGLE_RESPONSE');
    const request = payload.requestDetails, app = payload.appIntegrity, device = payload.deviceIntegrity;
    requireThat(request?.requestPackageName === policy.packageName && app?.packageName === policy.packageName, 'PACKAGE_MISMATCH');
    requireThat(input.expectedNonce ? request.nonce === input.expectedNonce : request.requestHash === input.expectedRequestHash, 'REQUEST_BINDING_MISMATCH');
    requireThat(typeof request.timestampMillis === 'string' && /^\d{1,16}$/.test(request.timestampMillis), 'INVALID_TOKEN_TIME');
    const issued = Number(request.timestampMillis);
    requireThat(Number.isSafeInteger(issued) && issued >= input.challengeIssuedAt && issued <= input.now + 30_000 && issued < input.challengeExpiresAt && input.now - issued <= policy.maxTokenAgeMs, 'TOKEN_OUTSIDE_CHALLENGE_WINDOW');
    requireThat(app.appRecognitionVerdict === 'PLAY_RECOGNIZED', 'APP_NOT_RECOGNIZED');
    requireThat(Array.isArray(app.certificateSha256Digest) && app.certificateSha256Digest.length > 0 && app.certificateSha256Digest.every((value: unknown) => typeof value === 'string' && policy.certificateSha256Digests.includes(value)), 'APP_CERTIFICATE_MISMATCH');
    requireThat(typeof app.versionCode === 'string' && /^\d{1,19}$/.test(app.versionCode) && BigInt(app.versionCode) >= BigInt(policy.minimumVersionCode), 'APP_VERSION_NOT_ALLOWED');
    requireThat(Array.isArray(device?.deviceRecognitionVerdict) && policy.requiredDeviceVerdicts.length > 0 && policy.requiredDeviceVerdicts.every(value => device.deviceRecognitionVerdict.includes(value)), 'DEVICE_POLICY_NOT_MET');
    requireThat(!policy.requireLicensed || payload.accountDetails?.appLicensingVerdict === 'LICENSED', 'APP_NOT_LICENSED');
    return result('VALIDATED', '', { provider: 'GOOGLE_PLAY_INTEGRITY', requestBinding: 'VALIDATED', appIdentity: 'VALIDATED', deviceVerdicts: device.deviceRecognitionVerdict, license: payload.accountDetails?.appLicensingVerdict ?? 'UNEVALUATED', tokenDigest: sha256(input.token).toString('hex'), tokenIssuedAt: issued, cameraSensor: 'NOT_CHECKED' });
  } catch (error) { return failure(error); }
}

/** Token acquisition is injected from an authorized service-account credential provider. */
export function createGooglePlayIntegrityDecoder(options: { packageName: string; getAccessToken: () => Promise<string | null>; fetchImpl?: typeof fetch; timeoutMs?: number }): (token: string) => Promise<unknown> {
  if (!/^[a-zA-Z][\w]*(?:\.[a-zA-Z][\w]*)+$/.test(options.packageName)) throw new Error('Invalid configured Android package');
  return async token => {
    let accessToken: string | null;
    try { accessToken = await options.getAccessToken(); }
    catch { throw new PlatformServiceUnavailable('GOOGLE_CREDENTIAL_UNAVAILABLE'); }
    if (!accessToken) throw new PlatformServiceUnavailable('GOOGLE_CREDENTIAL_UNAVAILABLE');
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), Math.min(30_000, Math.max(100, options.timeoutMs ?? 10_000)));
    try {
      const response = await (options.fetchImpl ?? fetch)(`https://playintegrity.googleapis.com/v1/${options.packageName}:decodeIntegrityToken`, { method: 'POST', headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ integrity_token: token }), signal: controller.signal, redirect: 'error' });
      if (response.status === 400) throw new InvalidEvidence('GOOGLE_REJECTED_TOKEN');
      if (!response.ok || !response.body) throw new PlatformServiceUnavailable('GOOGLE_DECODE_UNAVAILABLE');
      const reader = response.body.getReader(), chunks: Uint8Array[] = []; let total = 0;
      try { for (;;) { const next = await reader.read(); if (next.done) break; total += next.value.length; if (total > 65536) throw new InvalidEvidence('GOOGLE_RESPONSE_TOO_LARGE'); chunks.push(next.value); } }
      finally { await reader.cancel().catch(() => {}); }
      return JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } catch (error) {
      if (error instanceof InvalidEvidence || error instanceof PlatformServiceUnavailable) throw error;
      throw new PlatformServiceUnavailable('GOOGLE_DECODE_UNAVAILABLE');
    } finally { clearTimeout(timer); }
  };
}

export interface AppAttestPolicy {
  appId: string;
  environment: 'development' | 'production';
  trustedRootCertificatesPem: string[];
  trustPolicyId: string;
  trustPolicyExpiresAt: number;
  now: number;
  /** Current policy is explicit. Legacy format is separately qualified, never inferred. */
  allowedValidationCategories: number[];
  allowedBundleVersions: string[];
  allowLegacyWithoutExtensions?: boolean;
  revokedKeyIds?: string[];
}
export interface AppAttestKeyRecord {
  keyId: string; publicKeyPem: string; appId: string; environment: 'development' | 'production'; counter: number; trustPolicyId: string;
}
export interface AppAttestResult extends PlatformAssuranceResult { registeredKey?: AppAttestKeyRecord; counter?: number; receiptBase64?: string; }
function applePolicyAvailable(policy?: AppAttestPolicy): policy is AppAttestPolicy {
  return !!policy && /^[A-Za-z0-9]+\.[A-Za-z0-9.-]+$/.test(policy.appId) && ['development', 'production'].includes(policy.environment) && !!policy.trustPolicyId && policy.trustedRootCertificatesPem.length > 0 && Number.isSafeInteger(policy.now) && Number.isSafeInteger(policy.trustPolicyExpiresAt) && policy.trustPolicyExpiresAt > policy.now;
}
function parseCertificate(input: Buffer): Certificate {
  requireThat(input.length <= 16384, 'CERTIFICATE_TOO_LARGE');
  const parsed = asn1.fromBER(input);
  requireThat(parsed.offset === input.length, 'MALFORMED_CERTIFICATE');
  return new Certificate({ schema: parsed.result });
}
async function chain(x5c: Buffer[], rootsPem: string[], now: number) {
  requireThat(x5c.length >= 1 && x5c.length <= 5 && rootsPem.length >= 1 && rootsPem.length <= 8, 'INVALID_CERTIFICATE_CHAIN');
  const native = x5c.map(value => new X509Certificate(value));
  for (let i = 0; i < native.length; i++) {
    requireThat(Date.parse(native[i].validFrom) <= now && Date.parse(native[i].validTo) >= now, 'CERTIFICATE_EXPIRED_OR_NOT_YET_VALID');
    if (i > 0) requireThat(native[i].ca && native[i - 1].checkIssued(native[i]) && native[i - 1].verify(native[i].publicKey), 'CERTIFICATE_SIGNATURE_OR_ORDER');
  }
  requireThat(!native[0].ca, 'CREDENTIAL_CERTIFICATE_IS_CA');
  const certificates = x5c.map(parseCertificate);
  const roots = rootsPem.map(value => parseCertificate(new X509Certificate(value).raw));
  const engine = new CryptoEngine({ name: 'node-webcrypto', crypto: webcrypto as unknown as Crypto });
  const checked = await new CertificateChainValidationEngine({ certs: [...certificates].reverse(), trustedCerts: roots, checkDate: new Date(now) }).verify({ passedWhenNotRevValues: true }, engine);
  requireThat(checked.result, 'UNTRUSTED_CERTIFICATE_CHAIN');
  return { certificates, native };
}
function extensionBytes(certificate: Certificate, oid: string): Buffer {
  const selected = certificate.extensions?.filter(extension => extension.extnID === oid) ?? [];
  requireThat(selected.length === 1, 'REQUIRED_CERTIFICATE_EXTENSION_MISSING_OR_DUPLICATED');
  return Buffer.from(selected[0].extnValue.valueBlock.valueHexView);
}
function publicPoint(publicKeyPem: string): Buffer {
  const key = createPublicKey(publicKeyPem), jwk = key.export({ format: 'jwk' });
  requireThat(jwk.kty === 'EC' && jwk.crv === 'P-256' && !!jwk.x && !!jwk.y, 'KEY_ALGORITHM_NOT_SUPPORTED');
  const x = Buffer.from(jwk.x!, 'base64url'), y = Buffer.from(jwk.y!, 'base64url');
  requireThat(x.length === 32 && y.length === 32, 'INVALID_EC_COORDINATE');
  return Buffer.concat([Buffer.from([4]), x, y]);
}
function parseAppleNonce(value: Buffer): Buffer {
  const parsed = asn1.fromBER(value);
  requireThat(parsed.offset === value.length && parsed.result instanceof asn1.Sequence, 'MALFORMED_APPLE_NONCE');
  const elements = (parsed.result as asn1.Sequence).valueBlock.value;
  requireThat(elements.length === 1 && elements[0] instanceof asn1.Constructed && elements[0].idBlock.tagClass === 3 && elements[0].idBlock.tagNumber === 1, 'MALFORMED_APPLE_NONCE');
  const wrapped = (elements[0] as asn1.Constructed).valueBlock.value;
  requireThat(wrapped.length === 1 && wrapped[0] instanceof asn1.OctetString, 'MALFORMED_APPLE_NONCE');
  return digest((wrapped[0] as asn1.OctetString).valueBlock.valueHexView);
}
function appleExtensions(data: Buffer, offset: number, flags: number, policy: AppAttestPolicy, attestation: boolean): Record<string, unknown> {
  if ((flags & 0x80) === 0) {
    requireThat(offset === data.length, 'UNDECLARED_AUTHENTICATOR_DATA');
    if (!policy.allowLegacyWithoutExtensions) throw new PlatformServiceUnavailable('APPLE_LEGACY_PROFILE_NOT_QUALIFIED');
    return { extensionProfile: 'LEGACY_EXPLICIT_POLICY' };
  }
  const extensions = decode(data.subarray(offset));
  const category = extensions.get(attestation ? 'apple_validation_category_01' : 'validationCategory');
  const bundle = extensions.get(attestation ? 'apple_bundle_version_01' : 'bundleVersion');
  requireThat(Number.isSafeInteger(category) && (category as number) > 0 && (category as number) < 7 && policy.allowedValidationCategories.includes(category as number), 'APPLE_VALIDATION_CATEGORY_NOT_ALLOWED');
  requireThat(typeof bundle === 'string' && policy.allowedBundleVersions.includes(bundle), 'APPLE_BUNDLE_VERSION_NOT_ALLOWED');
  return { extensionProfile: 'VALIDATED', validationCategory: category, bundleVersion: bundle };
}
/** Registration still requires atomic, actor/device-bound insertion and consuming the one-time intent. */
export async function verifyAppAttestAttestation(input: ChallengeWindow & { objectBase64: string; keyId: string; expectedClientDataHash: Uint8Array; }, policy?: AppAttestPolicy): Promise<AppAttestResult> {
  if (!applePolicyAvailable(policy)) return result('UNSUPPORTED', 'APPLE_TRUST_POLICY_UNAVAILABLE');
  try {
    checkWindow(input); requireThat(input.now === policy.now, 'POLICY_CLOCK_MISMATCH');
    const expectedHash = digest(input.expectedClientDataHash), keyId = base64(input.keyId, 32);
    requireThat(keyId.length === 32 && !policy.revokedKeyIds?.includes(input.keyId), 'KEY_REVOKED_OR_INVALID');
    const object = decode(base64(input.objectBase64)), statement = map(object.get('attStmt')), data = bytes(object.get('authData'));
    requireThat(object.get('fmt') === 'apple-appattest', 'UNSUPPORTED_ATTESTATION_FORMAT');
    const x5c = statement.get('x5c'); requireThat(Array.isArray(x5c), 'CERTIFICATE_CHAIN_MISSING');
    const verified = await chain((x5c as unknown[]).map(value => bytes(value, 16384)), policy.trustedRootCertificatesPem, policy.now);
    requireThat(data.length >= 87 && (data[32] & 0x40) !== 0, 'MALFORMED_ATTESTED_AUTHENTICATOR_DATA');
    requireThat(same(data.subarray(0, 32), sha256(policy.appId)), 'APP_ID_MISMATCH');
    requireThat(data.readUInt32BE(33) === 0, 'ATTESTATION_COUNTER_NOT_ZERO');
    const expectedAaguid = policy.environment === 'development' ? Buffer.from('appattestdevelop') : Buffer.concat([Buffer.from('appattest'), Buffer.alloc(7)]);
    requireThat(same(data.subarray(37, 53), expectedAaguid), 'APP_ATTEST_ENVIRONMENT_MISMATCH');
    requireThat(data.readUInt16BE(53) === 32 && same(data.subarray(55, 87), keyId), 'CREDENTIAL_ID_MISMATCH');
    const publicKeyPem = verified.native[0].publicKey.export({ type: 'spki', format: 'pem' }).toString();
    const point = publicPoint(publicKeyPem);
    requireThat(same(sha256(point), keyId), 'PUBLIC_KEY_ID_MISMATCH');
    requireThat(same(parseAppleNonce(extensionBytes(verified.certificates[0], '1.2.840.113635.100.8.2')), sha256(Buffer.concat([data, expectedHash]))), 'ATTESTATION_CHALLENGE_MISMATCH');
    // COSE EC2/P-256 public key must agree with the certificate and be fully consumed.
    const decodedKey = cbor.decodeFirstSync(data.subarray(87), { max_depth: 8, preventDuplicateKeys: true, preferMap: true, extendedResults: true });
    const cose = map(decodedKey.value);
    requireThat(cose.get(1) === 2 && cose.get(3) === -7 && cose.get(-1) === 1 && same(bytes(cose.get(-2), 32), point.subarray(1, 33)) && same(bytes(cose.get(-3), 32), point.subarray(33)), 'COSE_KEY_MISMATCH');
    const extensionResult = appleExtensions(data, 87 + decodedKey.length, data[32], policy, true);
    const receipt = bytes(statement.get('receipt'), 32768);
    return { ...result('VALIDATED', '', { provider: 'APPLE_APP_ATTEST', trustPolicyId: policy.trustPolicyId, requestBinding: 'VALIDATED', certificateChain: 'VALIDATED', cameraSensor: 'NOT_CHECKED', ...extensionResult }), registeredKey: { keyId: input.keyId, publicKeyPem, appId: policy.appId, environment: policy.environment, counter: 0, trustPolicyId: policy.trustPolicyId }, receiptBase64: receipt.toString('base64') };
  } catch (error) { return failure(error); }
}
/** advanceCounter must compare-and-swap in the same transaction as intent consumption. */
export async function verifyAppAttestAssertion(input: ChallengeWindow & { objectBase64: string; expectedClientDataHash: Uint8Array; key: AppAttestKeyRecord; }, policy: AppAttestPolicy | undefined, advanceCounter?: (previous: number, next: number) => Promise<boolean>): Promise<AppAttestResult> {
  if (!applePolicyAvailable(policy) || !advanceCounter) return result('UNSUPPORTED', 'APPLE_TRUST_OR_COUNTER_STORE_UNAVAILABLE');
  try {
    checkWindow(input); requireThat(input.now === policy.now, 'POLICY_CLOCK_MISMATCH');
    const key = input.key;
    requireThat(key.appId === policy.appId && key.environment === policy.environment && key.trustPolicyId === policy.trustPolicyId && !policy.revokedKeyIds?.includes(key.keyId), 'APP_ATTEST_KEY_POLICY_MISMATCH');
    requireThat(Number.isSafeInteger(key.counter) && key.counter >= 0 && key.counter < 0xffffffff, 'INVALID_STORED_COUNTER');
    requireThat(same(sha256(publicPoint(key.publicKeyPem)), base64(key.keyId, 32)), 'STORED_KEY_ID_MISMATCH');
    const object = decode(base64(input.objectBase64)), signature = bytes(object.get('signature'), 80), data = bytes(object.get('authenticatorData'));
    requireThat(data.length >= 37 && (data[32] & 0x40) === 0, 'MALFORMED_ASSERTION_AUTHENTICATOR_DATA');
    requireThat(same(data.subarray(0, 32), sha256(policy.appId)), 'APP_ID_MISMATCH');
    const counter = data.readUInt32BE(33); requireThat(counter > key.counter, 'ASSERTION_COUNTER_REPLAY');
    const extensionResult = appleExtensions(data, 37, data[32], policy, false);
    const signedBytes = Buffer.concat([data, digest(input.expectedClientDataHash)]);
    requireThat(verify('sha256', signedBytes, { key: key.publicKeyPem, dsaEncoding: 'der' }, signature), 'ASSERTION_SIGNATURE_INVALID');
    let advanced: boolean;
    try { advanced = await advanceCounter(key.counter, counter); }
    catch { throw new PlatformServiceUnavailable('APPLE_COUNTER_STORE_UNAVAILABLE'); }
    requireThat(advanced, 'ASSERTION_COUNTER_CONFLICT');
    return { ...result('VALIDATED', '', { provider: 'APPLE_APP_ATTEST', trustPolicyId: policy.trustPolicyId, requestBinding: 'VALIDATED', signature: 'VALIDATED', cameraSensor: 'NOT_CHECKED', ...extensionResult }), counter };
  } catch (error) { return failure(error); }
}

export interface AndroidKeyAttestationTrustPolicy {
  trustedRootCertificatesPem:string[]; revocationEntries:Record<string,{status:string}>;
  revocationValidUntil:number; trustPolicyId:string; trustPolicyExpiresAt?:number;
  authorization?:AndroidKeyPolicy;
}
/** Strict current-certificate profile. Root-most extension selection prevents
 * attacker-appended attestations; delegated key profiles are deliberately refused. */
export async function verifyAndroidKeyAttestationChain(input: { certificatesBase64:string[]; now:number; expectedChallenge?:Uint8Array; expectedPublicKeyPem?:string; }, policy?:AndroidKeyAttestationTrustPolicy):Promise<PlatformAssuranceResult> {
  if(!policy?.trustedRootCertificatesPem.length||!Number.isSafeInteger(input.now)||!(policy.revocationValidUntil>input.now)||policy.authorization&&!(Number.isSafeInteger(policy.trustPolicyExpiresAt)&&policy.trustPolicyExpiresAt!>input.now))return result('UNSUPPORTED','ANDROID_ROOTS_OR_REVOCATION_UNAVAILABLE');
  try {
    requireThat(Array.isArray(input.certificatesBase64)&&input.certificatesBase64.length<=5,'INVALID_CERTIFICATE_CHAIN');
    const verified=await chain(input.certificatesBase64.map(value=>base64(value,16384)),policy.trustedRootCertificatesPem,input.now);
    const revoked=new Set(Object.keys(policy.revocationEntries).map(serial=>serial.toLowerCase().replace(/^0+/,'')||'0'));
    for(const certificate of [...verified.native,...policy.trustedRootCertificatesPem.map(value=>new X509Certificate(value))])requireThat(!revoked.has(certificate.serialNumber.toLowerCase().replace(/^0+/,'')||'0'),'ANDROID_ATTESTATION_CERTIFICATE_REVOKED');
    const attestationOid='1.3.6.1.4.1.11129.2.1.17',provisioningOid='1.3.6.1.4.1.11129.2.1.30';
    let attestationIndex=-1,provisioningIndex=-1;
    verified.certificates.forEach((cert,index)=>{if(cert.extensions?.some(e=>e.extnID===attestationOid))attestationIndex=index;if(cert.extensions?.some(e=>e.extnID===provisioningOid))provisioningIndex=index;});
    requireThat(attestationIndex>=0,'ANDROID_ATTESTATION_EXTENSION_MISSING');
    if(!policy.authorization||!input.expectedChallenge||!input.expectedPublicKeyPem)return result('UNSUPPORTED','ANDROID_HARDWARE_POLICY_VERIFIER_REQUIRED',{certificateChain:'VALIDATED',revocationSnapshot:'VALIDATED',trustPolicyId:policy.trustPolicyId,keyProtection:'NOT_CHECKED'});
    // A root-most extension on an ancestor describes that ancestor's key, not the leaf.
    // Never apply those properties to an attacker-controlled descendant key.
    if(attestationIndex!==0)return result('UNSUPPORTED','ANDROID_DELEGATED_KEY_PROFILE_NOT_SUPPORTED');
    let provisioningSecurity:unknown;
    if(provisioningIndex>=0){
      requireThat(provisioningIndex===attestationIndex+1,'ANDROID_PROVISIONING_EXTENSION_ORDER');
      const provisioning=decode(extensionBytes(verified.certificates[provisioningIndex],provisioningOid));
      requireThat(provisioning.size<=16&&(!provisioning.has(6)||typeof provisioning.get(6)==='boolean'),'ANDROID_PROVISIONING_EXTENSION_SHAPE');
      requireThat(provisioning.get(6)!==true,'ANDROID_DEVICE_REPORTED_LOST');
      if(provisioning.has(1))requireThat(Number.isSafeInteger(provisioning.get(1))&&(provisioning.get(1) as number)>=0,'ANDROID_PROVISIONING_CERTIFICATE_COUNT');
      provisioningSecurity=provisioning.get(4);requireThat(provisioningSecurity===undefined||provisioningSecurity==='TEE'||provisioningSecurity==='STRONG_BOX','ANDROID_PROVISIONING_SECURITY_LEVEL');
    }
    const observations=evaluateAndroidKeyPolicy({extensionDer:extensionBytes(verified.certificates[attestationIndex],attestationOid),expectedChallenge:input.expectedChallenge,certificatePublicKeyPem:verified.native[attestationIndex].publicKey.export({format:'pem',type:'spki'}).toString(),expectedPublicKeyPem:input.expectedPublicKeyPem,now:input.now},policy.authorization);
    requireThat(provisioningSecurity===undefined||provisioningSecurity===(observations.attestationSecurityLevel==='STRONG_BOX'?'STRONG_BOX':'TEE'),'ANDROID_PROVISIONING_SECURITY_MISMATCH');
    return {...result('VALIDATED','',{provider:'ANDROID_KEY_ATTESTATION',certificateChain:'VALIDATED',revocationSnapshot:'VALIDATED',trustPolicyId:policy.trustPolicyId,requestBinding:'VALIDATED',cameraSensor:'NOT_CHECKED',qualification:'RESEARCH_UNQUALIFIED',...observations}),limitations:[...LIMITATIONS,'Only the explicitly pinned strict KeyMint P-256 profile is checked; device qualification and independent policy review remain required.']};
  }catch(error){if(error instanceof AndroidKeyPolicyError)return result(error.unsupported?'UNSUPPORTED':'INVALID',error.message);return failure(error);}
}
