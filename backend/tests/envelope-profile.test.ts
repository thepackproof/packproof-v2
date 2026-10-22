import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { base64url, flattenedVerify, importSPKI } from 'jose';
import { createEnvelopeSigner, prepareEnvelope, jcsBytes, sha256, validateCoverage, COVERAGE_PROFILE, ENVELOPE_TYPE, type IntegrityCoverage } from '../src/integrity/envelope-profile.js';
import type { KmsSigningTransport } from '../src/integrity/kms-signing-runtime.js';

const keyArn = 'arn:aws:kms:us-east-1:123456789012:key/11111111-1111-1111-1111-111111111111';
const pair = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
const publicKeyPem = pair.publicKey.export({ format: 'pem', type: 'spki' }).toString();
const manifestBytes = Buffer.from('{ "legacy":true, "proofId":"proof_fixture" }\n');
function fixture() {
  const coverage: IntegrityCoverage = { profile: COVERAGE_PROFILE, proofId: 'proof_fixture', recordType: 'CORE', recordId: 'manifest_fixture',
    artifacts: [{ path: 'manifest.json', kind: 'MANIFEST', required: true, sha256: sha256(manifestBytes), byteSize: manifestBytes.length,
      storage: { bucket: 'fixture-bucket', key: 'frozen/manifest', versionId: 'version-original' }, sourcePath: null }], stages: [], omissions: [] };
  return prepareEnvelope({ proofId: coverage.proofId, recordType: 'CORE', recordId: coverage.recordId, manifestSchema: 'packproof.manifest.v1', manifestPath: 'manifest.json', manifestSha256: sha256(manifestBytes), issuer: 'https://thepackproof.com', issuedAt: '2026-10-22T04:00:00.000Z', manifestBytes, coverage });
}
function transport(payload: Uint8Array, options: { wrongKey?: boolean; doubleHash?: boolean; trailingDer?: boolean } = {}): KmsSigningTransport {
  return {
    getPublicKey: async () => ({ $metadata: {}, KeyId: keyArn, KeySpec: 'ECC_NIST_P256', KeyUsage: 'SIGN_VERIFY', SigningAlgorithms: ['ECDSA_SHA_256'], PublicKey: pair.publicKey.export({ format: 'der', type: 'spki' }) }),
    sign: async request => {
      const protectedHeader = base64url.encode(jcsBytes({ alg: 'ES256', kid: 'fixture-key', typ: ENVELOPE_TYPE }));
      const signingInput = Buffer.from(`${protectedHeader}.${base64url.encode(payload)}`);
      expect(request).toMatchObject({ KeyId: keyArn, MessageType: 'DIGEST', SigningAlgorithm: 'ECDSA_SHA_256' });
      expect(Buffer.from(request.Message!)).toEqual(createHash('sha256').update(signingInput).digest());
      const privateKey = options.wrongKey ? generateKeyPairSync('ec', { namedCurve: 'prime256v1' }).privateKey : pair.privateKey;
      let signature = sign('sha256', options.doubleHash ? Buffer.from(request.Message!) : signingInput, privateKey);
      if (options.trailingDer) signature = Buffer.concat([signature, Buffer.from([0])]);
      return { $metadata: {}, KeyId: keyArn, SigningAlgorithm: 'ECDSA_SHA_256', Signature: signature };
    },
  };
}
describe('additive JCS ES256 envelope profile', () => {
  it('uses RFC 8785 primitive formatting and UTF-16 property order', () => {
    expect(jcsBytes({ numbers: [333333333.33333329, 1e30, 4.50, 2e-3, 1e-27], '\u20ac': 'Euro', '\r': 'CR', '1': 'One', '\ud83d\ude00': 'Emoji', '\u0080': 'Control', '\u00f6': 'O', '\ufb33': 'Hebrew' }).toString()).toBe('{"\\r":"CR","1":"One","numbers":[333333333.3333333,1e+30,4.5,0.002,1e-27],"\u0080":"Control","ö":"O","€":"Euro","😀":"Emoji","דּ":"Hebrew"}');
    expect(() => jcsBytes({ bad: '\ud800' })).toThrow();
    expect(() => jcsBytes({ bad: Infinity })).toThrow();
  });
  it('hashes legacy manifest bytes without changing whitespace or serializer', () => {
    const prepared = fixture();
    expect(prepared.envelope.manifestSha256).toBe(sha256(manifestBytes));
    expect(prepared.envelope.manifestSha256).not.toBe(sha256(jcsBytes(JSON.parse(manifestBytes.toString()))));
    expect(prepared.envelope.coverageSha256).toBe(sha256(prepared.coverageBytes));
  });
  it('uses KMS DIGEST input and produces a JWS verified by JOSE', async () => {
    const prepared = fixture();
    const signer = await createEnvelopeSigner({ keyArn, keyId: 'fixture-key', pinnedPublicKeyPem: publicKeyPem, transport: transport(prepared.envelopeBytes) });
    for (let n = 0; n < 12; n++) {
      const jws = await signer(prepared.envelopeBytes);
      expect(base64url.decode(jws.signature)).toHaveLength(64);
      const verified = await flattenedVerify(jws, await importSPKI(publicKeyPem, 'ES256'), { algorithms: ['ES256'] });
      expect(Buffer.from(verified.payload)).toEqual(prepared.envelopeBytes);
    }
  });
  it.each([{ wrongKey: true }, { doubleHash: true }, { trailingDer: true }])('rejects incompatible returned signatures: %j', async options => {
    const prepared = fixture();
    const signer = await createEnvelopeSigner({ keyArn, keyId: 'fixture-key', pinnedPublicKeyPem: publicKeyPem, transport: transport(prepared.envelopeBytes, options) });
    await expect(signer(prepared.envelopeBytes)).rejects.toThrow();
  });
  it('rejects a substituted KMS public key and mutable alias', async () => {
    const prepared = fixture();
    const other = generateKeyPairSync('ec', { namedCurve: 'prime256v1' }).publicKey.export({ format: 'pem', type: 'spki' }).toString();
    await expect(createEnvelopeSigner({ keyArn, keyId: 'fixture-key', pinnedPublicKeyPem: other, transport: transport(prepared.envelopeBytes) })).rejects.toThrow('KMS_PUBLIC_KEY_MISMATCH');
    await expect(createEnvelopeSigner({ keyArn: 'alias/fixture', keyId: 'fixture-key', pinnedPublicKeyPem: publicKeyPem, transport: transport(prepared.envelopeBytes) })).rejects.toThrow('EXACT_KMS_KEY_REQUIRED');
  });
  it('refuses duplicate fields/noncanonical payloads before signing', async () => {
    const prepared = fixture();
    const signer = await createEnvelopeSigner({ keyArn, keyId: 'fixture-key', pinnedPublicKeyPem: publicKeyPem, transport: transport(prepared.envelopeBytes) });
    await expect(signer(Buffer.from(JSON.stringify(prepared.envelope, null, 2)))).rejects.toThrow('NONCANONICAL_ENVELOPE');
    await expect(signer(Buffer.from(prepared.envelopeBytes.toString().replace('{', '{"proofId":"attacker",')))).rejects.toThrow('NONCANONICAL_ENVELOPE');
  });
  it('rejects latest-version identities, orphan derivatives and substituted stages', () => {
    const valid = JSON.parse(fixture().coverageBytes.toString()) as IntegrityCoverage;
    const latest = structuredClone(valid); latest.artifacts[0].storage.versionId = 'null';
    expect(() => validateCoverage(latest)).toThrow('EXACT_OBJECT_VERSION_REQUIRED');
    const derivative = structuredClone(valid); derivative.artifacts[0].kind = 'DERIVATIVE'; derivative.artifacts[0].sourcePath = 'missing.mp4';
    expect(() => validateCoverage(derivative)).toThrow('ORIGINAL_SOURCE_REQUIRED');
    const stage = structuredClone(valid); stage.stages.push({ stageId: 'stage_a', manifestPath: 'manifest.json', manifestSha256: '0'.repeat(64) });
    expect(() => validateCoverage(stage)).toThrow('INVALID_STAGE_COMMITMENT');
  });
});

async function portableFixture() {
  const prepared = fixture();
  const coverage = JSON.parse(prepared.coverageBytes.toString()) as IntegrityCoverage;
  const original = Buffer.from('synthetic original byte fixture'), derivative = Buffer.from('synthetic derivative byte fixture');
  const stage = Buffer.from('{"stageId":"stage_a","proofId":"proof_fixture"}');
  for (const [path, kind, bytes, sourcePath] of [
    ['media/original.mp4', 'ORIGINAL', original, null],
    ['media/derived.jpg', 'DERIVATIVE', derivative, 'media/original.mp4'],
    ['stages/stage_a.json', 'MANIFEST', stage, null],
  ] as const) coverage.artifacts.push({ path, kind, sha256: sha256(bytes), byteSize: bytes.length, required: true, storage: { bucket: 'fixture-bucket', key: path, versionId: 'exact-' + path }, sourcePath });
  coverage.stages.push({ stageId: 'stage_a', manifestPath: 'stages/stage_a.json', manifestSha256: sha256(stage) });
  const next = prepareEnvelope({ ...prepared.envelope, manifestBytes, coverage });
  const signer = await createEnvelopeSigner({ keyArn, keyId: 'fixture-key', pinnedPublicKeyPem: publicKeyPem, transport: transport(next.envelopeBytes) });
  const jws = await signer(next.envelopeBytes);
  const files: Record<string, string> = Object.fromEntries(Object.entries({
    'package.json': jcsBytes({ schema: 'packproof.signed-proof-package.v2', proofId: 'proof_fixture', envelopePath: 'integrity/envelope.jws.json', coveragePath: 'integrity/coverage.json', timestamp: { state: 'NOT_PRESENT' } }),
    'manifest.json': manifestBytes, 'integrity/envelope.jws.json': jcsBytes(jws), 'integrity/coverage.json': next.coverageBytes,
    'media/original.mp4': original, 'media/derived.jpg': derivative, 'stages/stage_a.json': stage,
  }).map(([name, bytes]) => [name, bytes.toString('base64')]));
  const trust = { schema: 'packproof.envelope-trust.v1', issuer: 'https://thepackproof.com', publishedAt: '2026-10-22T04:30:00.000Z', nextReviewAt: '2026-10-23T04:30:00.000Z',
    keys: [{ keyId: 'fixture-key', publicKeyPem, status: 'ACTIVE', validFrom: '2026-10-01T00:00:00.000Z', validUntil: null as string | null, statusEffectiveAt: null as string | null }] };
  return { files, trust: trust as typeof trust | null, expectedProof: 'proof_fixture', expectedDigest: sha256(manifestBytes) };
}
function independent(fixture: Awaited<ReturnType<typeof portableFixture>>) {
  const python = process.env.PACKPROOF_ENVELOPE_PYTHON || (process.platform === 'win32' ? 'python' : 'python3');
  const runner = fileURLToPath(new URL('./verify-envelope-fixture.py', import.meta.url));
  const result = spawnSync(python, [runner], { input: JSON.stringify(fixture), encoding: 'utf8', timeout: 15000, windowsHide: true });
  if (result.error || result.status !== 0) throw new Error(`Independent verifier failed: ${result.error?.message || result.stderr}`);
  const report = JSON.parse(result.stdout);
  if (report.status === 'SIGNATURE_UNCHECKED') throw new Error(report.message);
  return report;
}
describe('independent Python package verification', () => {
  it('verifies the recorded synthetic signature from the real isolated KMS workload role', () => {
    const recorded = JSON.parse(readFileSync(new URL('./fixtures/envelope-kms-20261022.json', import.meta.url), 'utf8'));
    expect(independent(recorded)).toMatchObject({ status: 'VERIFIED', issuerSignature: 'VALID', timestamp: 'NOT_PRESENT', truthOfRecordedScene: 'NOT_ASSESSED' });
  });
  it('verifies the Node-produced JWS, original bytes, stage and derivative lineage', async () => {
    expect(independent(await portableFixture())).toMatchObject({ status: 'VERIFIED', hashIntegrity: 'PASS', issuerSignature: 'VALID', timestamp: 'NOT_PRESENT', coverage: 'COMPLETE_FOR_DECLARED_SCOPE', keyStatus: 'ACTIVE', truthOfRecordedScene: 'NOT_ASSESSED' });
  });
  it.each(['media/original.mp4', 'manifest.json', 'stages/stage_a.json', 'media/derived.jpg'])('rejects changed %s', async path => {
    const f = await portableFixture(); f.files[path] = Buffer.from('modified').toString('base64');
    expect(independent(f)).toMatchObject({ status: 'INTEGRITY_INCOMPLETE', hashIntegrity: 'FAIL', coverage: 'PARTIAL' });
  });
  it('reports an omitted required artifact as incomplete even with a valid issuer signature', async () => {
    const f = await portableFixture(); delete f.files['media/original.mp4'];
    expect(independent(f)).toMatchObject({ issuerSignature: 'VALID', hashIntegrity: 'INCOMPLETE', coverage: 'PARTIAL', status: 'INTEGRITY_INCOMPLETE' });
  });
  it('rejects substituted coverage and unindexed attacker keys', async () => {
    const f = await portableFixture();
    f.files['integrity/coverage.json'] = Buffer.from('{}').toString('base64');
    expect(independent(f).status).toBe('INVALID_INTEGRITY_PROFILE');
    const g = await portableFixture(); g.files['attacker-public.pem'] = Buffer.from(publicKeyPem).toString('base64');
    expect(independent(g).status).toBe('INVALID_INTEGRITY_PROFILE');
  });
  it('requires independent issuer-bound trust and detects the wrong public key', async () => {
    const f = await portableFixture(); f.trust = null;
    expect(independent(f)).toMatchObject({ issuerSignature: 'UNKNOWN_KEY', keyStatus: 'UNKNOWN', coverage: 'UNKNOWN' });
    const g = await portableFixture(); g.trust!.issuer = 'https://other.example';
    expect(independent(g).issuerSignature).toBe('UNKNOWN_KEY');
    const h = await portableFixture(); h.trust!.keys[0].publicKeyPem = generateKeyPairSync('ec', { namedCurve: 'prime256v1' }).publicKey.export({ format: 'pem', type: 'spki' }).toString();
    expect(independent(h)).toMatchObject({ issuerSignature: 'INVALID', status: 'INTEGRITY_INCOMPLETE' });
  });
  it('preserves retired-key verification without accepting compromised keys', async () => {
    const f = await portableFixture(); f.trust!.keys[0].status = 'RETIRED'; f.trust!.keys[0].statusEffectiveAt = '2026-10-22T04:15:00.000Z';
    expect(independent(f)).toMatchObject({ status: 'VERIFIED', keyStatus: 'RETIRED' });
    f.trust!.keys[0].status = 'COMPROMISED';
    expect(independent(f)).toMatchObject({ status: 'INTEGRITY_INCOMPLETE', keyStatus: 'COMPROMISED', keyTrustedAtIssue: false });
    f.trust!.keys[0].status = 'REVOKED';
    expect(independent(f)).toMatchObject({ status: 'INTEGRITY_INCOMPLETE', keyStatus: 'REVOKED', keyTrustedAtIssue: false });
  });
  it('does not treat stale trust or claimed timestamps as fresh verified assurance', async () => {
    const f = await portableFixture(); f.trust!.nextReviewAt = '2026-10-22T04:45:00.000Z';
    expect(independent(f)).toMatchObject({ status: 'INTEGRITY_INCOMPLETE', trust: { status: 'STALE_SNAPSHOT', currentRevocationKnowledge: 'UNAVAILABLE_OFFLINE' } });
    const g = await portableFixture(); const metadata = JSON.parse(Buffer.from(g.files['package.json'], 'base64').toString());
    metadata.timestamp.state = 'VALID'; g.files['package.json'] = jcsBytes(metadata).toString('base64');
    expect(independent(g).status).toBe('INVALID_INTEGRITY_PROFILE');
    metadata.timestamp.state = 'PENDING'; g.files['package.json'] = jcsBytes(metadata).toString('base64');
    expect(independent(g).timestamp).toBe('PENDING');
  });
  it('rejects a replay for a different expected Proof or root digest', async () => {
    const f = await portableFixture(); f.expectedProof = 'other_proof';
    expect(independent(f).status).toBe('INVALID_INTEGRITY_PROFILE');
    const g = await portableFixture(); g.expectedDigest = '0'.repeat(64);
    expect(independent(g).status).toBe('INVALID_INTEGRITY_PROFILE');
  });
});
