/** RFC 3161 protocol boundary. No database, network or implicit system trust.
 * Timestamp SHA-256(JCS(flattened JWS)), never an unsigned manifest or capture time.
 * The caller persists the request once and reuses it across transport retries.
 */
import { randomBytes, X509Certificate } from 'node:crypto';
import { execFile } from 'node:child_process';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { fromBER, Integer, Null, OctetString } from 'asn1js';
import { AlgorithmIdentifier, Certificate, MessageImprint, SignedData, TimeStampReq, TimeStampResp, TSTInfo } from 'pkijs';
import { jcsBytes, sha256, type EnvelopeJws } from './envelope-profile.js';

const run = promisify(execFile);
const SHA256 = '2.16.840.1.101.3.4.2.1';
const SIGNED_DATA = '1.2.840.113549.1.7.2';
const TST_INFO = '1.2.840.113549.1.9.16.1.4';
const MAX_RESPONSE = 512 * 1024;
const check = (ok: unknown, code: string): void => { if (!ok) throw Error(code); };
const oid = (value: string) => typeof value === 'string' && /^(0|1|2)\.(0|[1-9][0-9]*)(\.(0|[1-9][0-9]*)){1,18}$/.test(value) && value.length <= 160 && (value.startsWith('2.') || Number(value.split('.')[1]) < 40);
const hash = (value: string) => /^[a-f0-9]{64}$/.test(value);
const stamp = (value: string) => /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value) && new Date(value).toISOString() === value;

export interface TimestampTrust {
  schema: 'packproof.timestamp-trust.v1'; policyOid: string;
  reviewedAt: string; nextReviewAt: string;
  roots: { certificatePem: string; sha256: string }[];
  /** Leaf pins and revocations come from independently authenticated policy. */
  signerSha256: string[]; revokedCertificateSha256: string[];
}
export interface TimestampValidation {
  profile: 'packproof.timestamp-validation.v1'; state: 'VALID';
  messageImprintAlgorithm: 'SHA-256'; messageImprint: string;
  requestSha256: string; responseSha256: string; policyOid: string;
  generatedAt: string; verifiedAt: string; serialNumberHex: string;
  certificateSha256: string[]; trustSha256: string;
  revocationKnowledge: 'INDEPENDENT_REVIEW_SNAPSHOT';
}
export interface TimestampMaterial {
  profile: 'packproof.rfc3161-material.v1';
  requestBase64: string; responseBase64: string; validation: TimestampValidation;
}
function asn(bytes: Uint8Array, maximum: number) {
  check(bytes.length > 0 && bytes.length <= maximum, 'TIMESTAMP_SIZE_LIMIT');
  const parsed = fromBER(bytes);
  check(parsed.offset === bytes.length, 'TIMESTAMP_ASN1_INVALID');
  return parsed.result;
}
export function timestampImprint(jws: EnvelopeJws): string {
  check(!!jws && Object.keys(jws).sort().join(',') === 'payload,protected,signature', 'TIMESTAMP_JWS_INVALID');
  for (const [key, max] of [['protected', 4096], ['payload', 24000], ['signature', 100]] as const)
    check(typeof jws[key] === 'string' && jws[key].length > 0 && jws[key].length <= max && /^[A-Za-z0-9_-]+$/.test(jws[key]), 'TIMESTAMP_JWS_INVALID');
  return sha256(jcsBytes(jws));
}
/** 127 random bits; a nonzero leading octet gives a canonical positive INTEGER. */
export function createTimestampRequest(jws: EnvelopeJws, policyOid: string): Buffer {
  check(oid(policyOid), 'TIMESTAMP_POLICY_INVALID');
  const nonce = randomBytes(16); nonce[0] = (nonce[0] & 0x7f) | 0x40;
  const request = new TimeStampReq({ version: 1, reqPolicy: policyOid, certReq: true,
    nonce: new Integer({ valueHex: nonce }),
    messageImprint: new MessageImprint({ hashAlgorithm: new AlgorithmIdentifier({ algorithmId: SHA256, algorithmParams: new Null() }),
      hashedMessage: new OctetString({ valueHex: Buffer.from(timestampImprint(jws), 'hex') }) }) });
  return Buffer.from(request.toSchema().toBER(false));
}
export function inspectTimestampRequest(bytes: Uint8Array, jws: EnvelopeJws, policyOid: string) {
  const request = new TimeStampReq({ schema: asn(bytes, 4096) });
  check(request.version === 1 && request.certReq === true && request.reqPolicy === policyOid && !request.extensions?.length, 'TIMESTAMP_REQUEST_INVALID');
  check(request.messageImprint.hashAlgorithm.algorithmId === SHA256 && Buffer.from(request.messageImprint.hashedMessage.valueBlock.valueHexView).toString('hex') === timestampImprint(jws), 'TIMESTAMP_IMPRINT_MISMATCH');
  const nonce = request.nonce?.valueBlock.valueHexView;
  check(nonce && nonce.length === 16 && nonce[0] >= 0x40 && nonce[0] <= 0x7f, 'TIMESTAMP_NONCE_INVALID');
  return request;
}
export function validateTimestampTrust(trust: TimestampTrust, now: Date) {
  check(trust?.schema === 'packproof.timestamp-trust.v1' && oid(trust.policyOid), 'TIMESTAMP_TRUST_INVALID');
  check(stamp(trust.reviewedAt) && stamp(trust.nextReviewAt) && Date.parse(trust.reviewedAt) <= now.getTime() && now.getTime() < Date.parse(trust.nextReviewAt), 'TIMESTAMP_TRUST_STALE');
  check(Array.isArray(trust.roots) && trust.roots.length > 0 && trust.roots.length <= 10 && Array.isArray(trust.signerSha256) && trust.signerSha256.length > 0 && trust.signerSha256.length <= 100 && trust.signerSha256.every(hash) && Array.isArray(trust.revokedCertificateSha256) && trust.revokedCertificateSha256.length <= 1000 && trust.revokedCertificateSha256.every(hash), 'TIMESTAMP_TRUST_INVALID');
  for (const root of trust.roots) {
    check(typeof root.certificatePem === 'string' && root.certificatePem.length <= 32768 && !root.certificatePem.includes('PRIVATE') && hash(root.sha256), 'TIMESTAMP_ROOT_INVALID');
    const cert = new X509Certificate(root.certificatePem);
    check(cert.ca && sha256(cert.raw) === root.sha256 && !trust.revokedCertificateSha256.includes(root.sha256), 'TIMESTAMP_ROOT_INVALID');
    // Normalize one parsed certificate; appended PEM material never becomes trust.
  }
}
/** Parse bounded protocol fields. This is NOT signature or chain verification. */
export function inspectTimestampResponse(bytes: Uint8Array, requestBytes: Uint8Array, jws: EnvelopeJws, trust: TimestampTrust, now: Date) {
  validateTimestampTrust(trust, now);
  const request = inspectTimestampRequest(requestBytes, jws, trust.policyOid);
  const response = new TimeStampResp({ schema: asn(bytes, MAX_RESPONSE) });
  check([0, 1].includes(response.status.status) && response.timeStampToken?.contentType === SIGNED_DATA, 'TIMESTAMP_RESPONSE_REJECTED');
  const signed = new SignedData({ schema: response.timeStampToken!.content });
  check(signed.signerInfos.length === 1 && signed.encapContentInfo.eContentType === TST_INFO && signed.encapContentInfo.eContent instanceof OctetString && !signed.encapContentInfo.eContent.idBlock.isConstructed, 'TIMESTAMP_CONTENT_INVALID');
  const info = new TSTInfo({ schema: asn(signed.encapContentInfo.eContent!.valueBlock.valueHexView, 8192) });
  check(info.version === 1 && info.policy === trust.policyOid && !info.extensions?.length, 'TIMESTAMP_POLICY_MISMATCH');
  check(info.messageImprint.hashAlgorithm.algorithmId === SHA256 && Buffer.from(info.messageImprint.hashedMessage.valueBlock.valueHexView).toString('hex') === timestampImprint(jws), 'TIMESTAMP_IMPRINT_MISMATCH');
  check(info.nonce && Buffer.from(info.nonce.valueBlock.valueHexView).equals(Buffer.from(request.nonce!.valueBlock.valueHexView)), 'TIMESTAMP_NONCE_MISMATCH');
  check(Number.isFinite(info.genTime.getTime()) && info.genTime.getTime() <= now.getTime(), 'TIMESTAMP_TIME_INVALID');
  const serial = info.serialNumber.valueBlock.valueHexView;
  check(serial.length > 0 && serial.length <= 32 && !(serial[0] & 0x80), 'TIMESTAMP_SERIAL_INVALID');
  check(signed.certificates && signed.certificates.length > 0 && signed.certificates.length <= 10 && signed.certificates.every(c => c instanceof Certificate), 'TIMESTAMP_CERTIFICATES_INVALID');
  const certificates = (signed.certificates as Certificate[]).map(c => new X509Certificate(Buffer.from(c.toSchema().toBER(false))));
  const hashes = certificates.map(c => sha256(c.raw));
  check(!hashes.some(h => trust.revokedCertificateSha256.includes(h)), 'TIMESTAMP_CERTIFICATE_REVOKED');
  // The actual signer is selected by CMS issuer/serial, not merely any pinned
  // certificate present in an untrusted response.
  const sid = signed.signerInfos[0].sid;
  check(sid && 'issuer' in sid && 'serialNumber' in sid, 'TIMESTAMP_SIGNER_INVALID');
  const signer = (signed.certificates as Certificate[]).find(c => c.issuer.isEqual(sid.issuer) && c.serialNumber.isEqual(sid.serialNumber));
  check(signer && trust.signerSha256.includes(sha256(Buffer.from(signer.toSchema().toBER(false)))), 'TIMESTAMP_SIGNER_UNTRUSTED');
  check(['2.16.840.1.101.3.4.2.1', '2.16.840.1.101.3.4.2.2', '2.16.840.1.101.3.4.2.3'].includes(signed.signerInfos[0].digestAlgorithm.algorithmId), 'TIMESTAMP_DIGEST_UNSUPPORTED');
  return { generatedAt: info.genTime.toISOString(), serialNumberHex: Buffer.from(serial).toString('hex'), certificateSha256: hashes };
}
/** OpenSSL enforces CMS signature, ESS signer binding, critical timestamp-only
 * EKU, certificate path, request nonce/policy/imprint and validity at token time.
 * ts.c creates a new store from supplied CA inputs only; no system CA is loaded.
 * Fresh independent pins/revocations remain mandatory at verification time.
 */
export async function verifyTimestampResponse(input: {
  response: Uint8Array; request: Uint8Array; jws: EnvelopeJws; trust: TimestampTrust; now: Date;
}): Promise<TimestampValidation> {
  const info = inspectTimestampResponse(input.response, input.request, input.jws, input.trust, input.now);
  const dir = await mkdtemp(join(tmpdir(), 'packproof-ts-'));
  try {
    await Promise.all([
      writeFile(join(dir, 'request.tsq'), input.request, { mode: 0o600 }),
      writeFile(join(dir, 'response.tsr'), input.response, { mode: 0o600 }),
      writeFile(join(dir, 'roots.pem'), input.trust.roots.map(r => new X509Certificate(r.certificatePem).toString()).join('\n'), { mode: 0o600 }),
      writeFile(join(dir, 'openssl.cnf'), '', { mode: 0o600 }),
    ]);
    const env: NodeJS.ProcessEnv = { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, LC_ALL: 'C', OPENSSL_CONF: join(dir, 'openssl.cnf') };
    await run('openssl', ['ts', '-verify', '-in', 'response.tsr', '-queryfile', 'request.tsq', '-CAfile', 'roots.pem', '-attime', String(Math.floor(Date.parse(info.generatedAt) / 1000)), '-auth_level', '2', '-verify_depth', '8'], { cwd: dir, env, timeout: 10000, maxBuffer: 65536, windowsHide: true });
  } catch {
    throw Error('TIMESTAMP_CRYPTOGRAPHIC_VERIFICATION_FAILED');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
  return { profile: 'packproof.timestamp-validation.v1', state: 'VALID', messageImprintAlgorithm: 'SHA-256', messageImprint: timestampImprint(input.jws), requestSha256: sha256(input.request), responseSha256: sha256(input.response), policyOid: input.trust.policyOid, ...info, verifiedAt: input.now.toISOString(), trustSha256: sha256(jcsBytes(input.trust)), revocationKnowledge: 'INDEPENDENT_REVIEW_SNAPSHOT' };
}
export function timestampMaterial(request: Uint8Array, response: Uint8Array, validation: TimestampValidation): TimestampMaterial {
  check(validation.state === 'VALID' && validation.requestSha256 === sha256(request) && validation.responseSha256 === sha256(response), 'TIMESTAMP_VALIDATION_BINDING');
  return { profile: 'packproof.rfc3161-material.v1', requestBase64: Buffer.from(request).toString('base64'), responseBase64: Buffer.from(response).toString('base64'), validation };
}
export async function verifyTimestampMaterial(material: TimestampMaterial, jws: EnvelopeJws, trust: TimestampTrust, now: Date) {
  check(material?.profile === 'packproof.rfc3161-material.v1' && Object.keys(material).sort().join(',') === 'profile,requestBase64,responseBase64,validation' && jcsBytes(material).length <= 1024 * 1024, 'TIMESTAMP_MATERIAL_INVALID');
  const decode = (value: string, max: number) => {
    check(typeof value === 'string' && value.length <= 4 * Math.ceil(max / 3), 'TIMESTAMP_SIZE_LIMIT');
    const bytes = Buffer.from(value, 'base64');
    check(bytes.length > 0 && bytes.length <= max && bytes.toString('base64') === value, 'TIMESTAMP_ENCODING_INVALID');
    return bytes;
  };
  // Stored validation is a historical receipt; fresh verification is mandatory.
  return verifyTimestampResponse({ request: decode(material.requestBase64, 4096), response: decode(material.responseBase64, MAX_RESPONSE), jws, trust, now });
}
