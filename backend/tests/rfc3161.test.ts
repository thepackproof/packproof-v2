import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateKeyPairSync, X509Certificate } from 'node:crypto';
import { FlattenedSign } from 'jose';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { fromBER, Integer } from 'asn1js';
import { TimeStampReq } from 'pkijs';
import { createTimestampRequest, inspectTimestampRequest, inspectTimestampResponse, timestampImprint, timestampMaterial, validateTimestampTrust, verifyTimestampResponse, type TimestampTrust } from '../src/integrity/rfc3161.js';
import { COVERAGE_PROFILE, ENVELOPE_TYPE, jcsBytes, prepareEnvelope, sha256, type EnvelopeJws, type IntegrityCoverage } from '../src/integrity/envelope-profile.js';
import { streamEnvelopePackage } from '../src/integrity/envelope-package.js';
import { collectSmallZip } from '../src/export/zip-stream.js';

const jws: EnvelopeJws = { protected: 'eyJhbGciOiJFUzI1NiJ9', payload: 'eyJwcm9vZklkIjoiZml4dHVyZSJ9', signature: 'c3ludGhldGljLWp3cy1mb3ItZGF0YS1oYXNoLW9ubHk' };
const policy = '1.3.6.1.4.1.55555.1';

describe('RFC 3161 request and policy boundaries', () => {
  it('timestamps the canonical flattened signature including every JWS member', () => {
    expect(timestampImprint(jws)).toBe(sha256(jcsBytes(jws)));
    expect(timestampImprint({ ...jws, signature: 'b3RoZXI' })).not.toBe(timestampImprint(jws));
    expect(() => timestampImprint({ ...jws, uncommitted: 'x' } as any)).toThrow('JWS_INVALID');
  });
  it('creates a SHA-256 query with a fresh 127-bit nonce and requested certificates', () => {
    const a = createTimestampRequest(jws, policy), b = createTimestampRequest(jws, policy);
    expect(a.equals(b)).toBe(false);
    expect(inspectTimestampRequest(a, jws, policy).certReq).toBe(true);
    expect(inspectTimestampRequest(a, jws, policy).nonce!.valueBlock.valueHexView.length).toBe(16);
  });
  it('rejects altered data, policy, suffix bytes and oversized ASN.1 before verification', () => {
    const request = createTimestampRequest(jws, policy);
    expect(() => inspectTimestampRequest(request, { ...jws, payload: 'b3RoZXI' }, policy)).toThrow('IMPRINT_MISMATCH');
    expect(() => inspectTimestampRequest(request, jws, policy + '.1')).toThrow('REQUEST_INVALID');
    expect(() => inspectTimestampRequest(Buffer.concat([request, Buffer.from([0])]), jws, policy)).toThrow('ASN1_INVALID');
    expect(() => inspectTimestampRequest(Buffer.alloc(4097), jws, policy)).toThrow('SIZE_LIMIT');
  });
  it('rejects short or absent nonce and invalid policy identifiers', () => {
    const request = new TimeStampReq({ schema: fromBER(createTimestampRequest(jws, policy)).result });
    request.nonce = new Integer({ value: 1 });
    expect(() => inspectTimestampRequest(new Uint8Array(request.toSchema().toBER(false)), jws, policy)).toThrow('NONCE_INVALID');
    for (const value of ['', 'url:https://tsa.example', '1.2.03', '1.2\n']) expect(() => createTimestampRequest(jws, value)).toThrow('POLICY_INVALID');
  });
  it('refuses stale independent trust before touching any certificate or subprocess', () => {
    expect(() => validateTimestampTrust({ schema: 'packproof.timestamp-trust.v1', policyOid: policy, reviewedAt: '2026-01-01T00:00:00.000Z', nextReviewAt: '2026-01-02T00:00:00.000Z' } as TimestampTrust, new Date('2026-01-03T00:00:00Z'))).toThrow('TRUST_STALE');
  });
});

// The restricted Windows host cannot execute its MSYS OpenSSL. Linux CI is the
// required real-crypto gate; absence/failure of OpenSSL there is a test failure.
describe.skipIf(process.platform === 'win32')('RFC 3161 real OpenSSL authority and verification', () => {
  let dir: string, request: Buffer, response: Buffer, trust: TimestampTrust;
  const openssl = (...args: string[]) => execFileSync('openssl', args, { cwd: dir, timeout: 15000, maxBuffer: 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'packproof-ts-fixture-'));
    writeFileSync(join(dir, 'empty.cnf'), '');
    openssl('req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', 'root.key', '-out', 'root.pem', '-days', '2', '-subj', '/CN=PackProof synthetic timestamp root', '-addext', 'basicConstraints=critical,CA:TRUE', '-addext', 'keyUsage=critical,keyCertSign,cRLSign');
    openssl('req', '-new', '-newkey', 'rsa:2048', '-nodes', '-keyout', 'tsa.key', '-out', 'tsa.csr', '-subj', '/CN=PackProof synthetic timestamp authority');
    writeFileSync(join(dir, 'tsa.ext'), 'basicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature\nextendedKeyUsage=critical,timeStamping\nsubjectKeyIdentifier=hash\nauthorityKeyIdentifier=keyid\n');
    openssl('x509', '-req', '-in', 'tsa.csr', '-CA', 'root.pem', '-CAkey', 'root.key', '-set_serial', '2', '-out', 'tsa.pem', '-days', '2', '-sha256', '-extfile', 'tsa.ext');
    writeFileSync(join(dir, 'serial'), '01\n');
    writeFileSync(join(dir, 'tsa.cnf'), `[tsa]\ndefault_tsa=synthetic\n[synthetic]\nserial=serial\nsigner_cert=tsa.pem\ncerts=root.pem\nsigner_key=tsa.key\nsigner_digest=sha256\ndefault_policy=${policy}\nother_policies=${policy}.1\ndigests=sha256\naccuracy=secs:1\nordering=yes\ntsa_name=yes\ness_cert_id_chain=yes\ness_cert_id_alg=sha256\n`);
    request = createTimestampRequest(jws, policy);
    writeFileSync(join(dir, 'request.tsq'), request);
    openssl('ts', '-reply', '-config', 'tsa.cnf', '-queryfile', 'request.tsq', '-out', 'response.tsr');
    response = readFileSync(join(dir, 'response.tsr'));
    const root = new X509Certificate(readFileSync(join(dir, 'root.pem'))), signer = new X509Certificate(readFileSync(join(dir, 'tsa.pem')));
    trust = { schema: 'packproof.timestamp-trust.v1', policyOid: policy, reviewedAt: new Date(Date.now() - 60000).toISOString(), nextReviewAt: new Date(Date.now() + 3600000).toISOString(), roots: [{ certificatePem: root.toString(), sha256: sha256(root.raw) }], signerSha256: [sha256(signer.raw)], revokedCertificateSha256: [] };
  }, 60000);
  afterAll(() => { if (dir) rmSync(dir, { recursive: true, force: true }); });
  const verify = (patch: Partial<Parameters<typeof verifyTimestampResponse>[0]> = {}) => verifyTimestampResponse({ request, response, jws, trust, now: new Date(), ...patch });
  it('verifies a real nonce-bound token and retains the original response and certificate material', async () => {
    const validation = await verify();
    expect(validation.state).toBe('VALID');
    expect(validation.messageImprint).toBe(timestampImprint(jws));
    expect(validation.certificateSha256).toContain(trust.signerSha256[0]);
    expect(validation.revocationKnowledge).toBe('INDEPENDENT_REVIEW_SNAPSHOT');
    const material = timestampMaterial(request, response, validation);
    expect(Buffer.from(material.responseBase64, 'base64')).toEqual(response);
    expect(Buffer.from(material.requestBase64, 'base64')).toEqual(request);
  });
  it('rejects a valid response to another nonce or another signature', async () => {
    await expect(verify({ request: createTimestampRequest(jws, policy) })).rejects.toThrow('NONCE_MISMATCH');
    await expect(verify({ jws: { ...jws, signature: 'b3RoZXI' } })).rejects.toThrow('IMPRINT_MISMATCH');
  });
  it('rejects a corrupt CMS signature even when all parsed fields remain valid', async () => {
    // The final octets are the CMS signature, not the embedded certificates.
    const tampered = Buffer.from(response); tampered[tampered.length - 1] ^= 1;
    expect(inspectTimestampResponse(tampered, request, jws, trust, new Date()).certificateSha256).toContain(trust.signerSha256[0]);
    await expect(verify({ response: tampered })).rejects.toThrow('CRYPTOGRAPHIC_VERIFICATION_FAILED');
  });
  it('refuses missing, substituted and revoked independent signer trust', async () => {
    await expect(verify({ trust: { ...trust, signerSha256: ['0'.repeat(64)] } })).rejects.toThrow('SIGNER_UNTRUSTED');
    await expect(verify({ trust: { ...trust, revokedCertificateSha256: [trust.signerSha256[0]] } })).rejects.toThrow('CERTIFICATE_REVOKED');
    await expect(verify({ trust: { ...trust, roots: [] } })).rejects.toThrow('TRUST_INVALID');
    await expect(verify({ trust: { ...trust, roots: [{ ...trust.roots[0], sha256: '0'.repeat(64) }] } })).rejects.toThrow('ROOT_INVALID');
  });
  it('rejects an untrusted path even with a pinned leaf and archive-included root', async () => {
    openssl('req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', 'other.key', '-out', 'other.pem', '-days', '2', '-subj', '/CN=Unrelated synthetic root', '-addext', 'basicConstraints=critical,CA:TRUE');
    const root = new X509Certificate(readFileSync(join(dir, 'other.pem')));
    await expect(verify({ trust: { ...trust, roots: [{ certificatePem: root.toString(), sha256: sha256(root.raw) }] } })).rejects.toThrow('CRYPTOGRAPHIC_VERIFICATION_FAILED');
  });
  it('rejects stale trust, future token time, trailing bytes and oversized responses', async () => {
    await expect(verify({ trust: { ...trust, nextReviewAt: new Date(Date.now() - 1).toISOString() } })).rejects.toThrow('TRUST_STALE');
    const prior = new Date(Date.now() - 3600000);
    await expect(verify({ now: prior, trust: { ...trust, reviewedAt: new Date(prior.getTime() - 60000).toISOString() } })).rejects.toThrow('TIME_INVALID');
    await expect(verify({ response: Buffer.concat([response, Buffer.from([0])]) })).rejects.toThrow('ASN1_INVALID');
    await expect(verify({ response: Buffer.alloc(512 * 1024 + 1) })).rejects.toThrow('SIZE_LIMIT');
  });
  it('independently verifies real tokens in Python and rejects forged validity claims', async () => {
    const material = timestampMaterial(request, response, await verify());
    const python = (patch: Record<string, unknown> = {}) => JSON.parse(execFileSync('python3', ['tests/verify-timestamp-fixture.py'], { input: JSON.stringify({ material, jws, trust, now: new Date().toISOString(), ...patch }), timeout: 30000, maxBuffer: 65536 }).toString());
    expect(python().state).toBe('VALID');
    expect(python().messageImprint).toBe(timestampImprint(jws));
    expect(python({ trust: null }).state).toBe('INVALID');
    expect(python({ jws: { ...jws, signature: 'b3RoZXI' } }).state).toBe('INVALID');
    const corrupt = Buffer.from(response); corrupt[corrupt.length - 1] ^= 1;
    expect(python({ material: { ...material, responseBase64: corrupt.toString('base64'), validation: { state: 'VALID' } } }).state).toBe('INVALID');
    expect(python({ material: { ...material, responseBase64: Buffer.concat([response, Buffer.from([0])]).toString('base64') } }).state).toBe('INVALID');
    expect(python({ trust: { ...trust, revokedCertificateSha256: [trust.signerSha256[0]] } }).state).toBe('INVALID');
  }, 60000);
  it('exports real timestamp material, verifies the archive independently and aborts on TSA trust changes', async () => {
    const pair = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    const publicKeyPem = pair.publicKey.export({ type: 'spki', format: 'pem' }).toString();
    const manifest = Buffer.from('{"synthetic":true}'), at = new Date(Date.now() - 1000).toISOString();
    const coverage: IntegrityCoverage = { profile: COVERAGE_PROFILE, proofId: 'timestamp-proof', recordType: 'CORE', recordId: 'timestamp-manifest', artifacts: [{ path: 'manifest.json', kind: 'MANIFEST', sha256: sha256(manifest), byteSize: manifest.length, required: true, sourcePath: null, storage: { bucket: 'synthetic', key: 'manifest', versionId: 'original-version' } }], stages: [], omissions: [] };
    const prepared = prepareEnvelope({ proofId: coverage.proofId, recordType: 'CORE', recordId: coverage.recordId, manifestSchema: 'manifest.v1', manifestPath: 'manifest.json', manifestSha256: sha256(manifest), issuer: 'https://packproof-fixture.test', issuedAt: at, coverage, manifestBytes: manifest });
    const signed = await new FlattenedSign(prepared.envelopeBytes).setProtectedHeader({ alg: 'ES256', kid: 'fixture-key', typ: ENVELOPE_TYPE }).sign(pair.privateKey);
    const envelopeJws: EnvelopeJws = { protected: signed.protected!, payload: signed.payload as string, signature: signed.signature };
    const query = createTimestampRequest(envelopeJws, policy);
    writeFileSync(join(dir, 'package.tsq'), query);
    openssl('ts', '-reply', '-config', 'tsa.cnf', '-queryfile', 'package.tsq', '-out', 'package.tsr');
    const reply = readFileSync(join(dir, 'package.tsr'));
    const material = timestampMaterial(query, reply, await verifyTimestampResponse({ request: query, response: reply, jws: envelopeJws, trust, now: new Date() }));
    let currentTrust = trust;
    const input = { jws: envelopeJws, coverage, trustedKeyId: 'fixture-key', trustedPublicKeyPem: publicKeyPem,
      openExactObject: async (object: { versionId: string }) => ({ versionId: object.versionId, body: (async function* () { yield manifest; })() }), assertCurrentAccess: async () => {},
      timestamp: { state: 'PRESENT' as const, material, trust: () => currentTrust, now: () => new Date() } };
    const archive = await collectSmallZip(await streamEnvelopePackage(input));
    const keyTrust = { schema: 'packproof.envelope-trust.v1', issuer: 'https://packproof-fixture.test', publishedAt: at, nextReviewAt: trust.nextReviewAt, keys: [{ keyId: 'fixture-key', publicKeyPem, status: 'ACTIVE', validFrom: at, validUntil: null, statusEffectiveAt: null }] };
    const python = (timestampTrust: TimestampTrust | null) => JSON.parse(execFileSync('python3', ['tests/verify-envelope-fixture.py'], { input: JSON.stringify({ archiveBase64: archive.toString('base64'), trust: keyTrust, timestampTrust, now: new Date().toISOString() }), timeout: 30000, maxBuffer: 65536 }).toString());
    expect(python(trust)).toMatchObject({ status: 'VERIFIED', issuerSignature: 'VALID', timestamp: 'VALID', truthOfRecordedScene: 'NOT_ASSESSED' });
    expect(python(null)).toMatchObject({ status: 'INTEGRITY_INCOMPLETE', issuerSignature: 'VALID', timestamp: 'INVALID' });
    const stream = await streamEnvelopePackage(input);
    currentTrust = { ...trust, revokedCertificateSha256: [trust.signerSha256[0]] };
    await expect(collectSmallZip(stream)).rejects.toThrow('TIMESTAMP_TRUST_CHANGED');
  }, 60000);
});
