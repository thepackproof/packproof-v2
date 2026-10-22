import { generateKeyPairSync, sign } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { canonicalize } from '../src/canonical.js';
import { createEnvelopeTrust, createTrustedEnvelopeSigner } from '../src/integrity/envelope-trust.js';
import { COVERAGE_PROFILE, ENVELOPE_TYPE, jcsBytes, prepareEnvelope, sha256 } from '../src/integrity/envelope-profile.js';
import type { SigningTrustRegistry } from '../src/domain/signing-trust.js';
import { base64url } from 'jose';

const authority = generateKeyPairSync('ec', { namedCurve: 'prime256v1' }), signing = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
const pem = signing.publicKey.export({ format: 'pem', type: 'spki' }).toString();
const issuer = 'https://envelopes.example.test', now = new Date('2026-10-22T05:00:00.000Z'), clock = { now: () => new Date(now) };
const keyArn = 'arn:aws:kms:us-east-1:123456789012:key/11111111-2222-3333-4444-555555555555';
function fixture() {
  let registry: SigningTrustRegistry = { version: 1, domain: 'PACKPROOF_SIGNING_TRUST_REGISTRY', publishedAt: now.toISOString(), nextReviewAt: '2026-10-23T05:00:00.000Z',
    keys: [{ keyId: 'envelope-key', algorithm: 'ECDSA_SHA_256', publicKeyPem: pem, status: 'ACTIVE', validFrom: '2026-10-01T00:00:00.000Z', validUntil: null, statusEffectiveAt: null, reason: null }] };
  let signed: Buffer;
  const publish = () => { signed = Buffer.from(JSON.stringify({ registry, signature: { keyId: 'independent-authority', algorithm: 'ECDSA_SHA_256', signedAt: now.toISOString(), signatureBase64: sign('sha256', Buffer.from(canonicalize(registry)), authority.privateKey).toString('base64') } })); };
  publish();
  const trust = createEnvelopeTrust({ issuer, clock, readRegistry: () => signed, readAuthorityPins: () => ({ 'independent-authority': authority.publicKey.export({ format: 'pem', type: 'spki' }).toString() }) });
  const manifest = Buffer.from('{"frozen": true}\n');
  const prepared = prepareEnvelope({ proofId: 'proof_fixture', recordType: 'CORE', recordId: 'manifest_fixture', manifestSchema: 'packproof.manifest.v1', manifestPath: 'manifest.json', manifestSha256: sha256(manifest), manifestBytes: manifest, issuer, issuedAt: now.toISOString(),
    coverage: { profile: COVERAGE_PROFILE, proofId: 'proof_fixture', recordType: 'CORE', recordId: 'manifest_fixture', artifacts: [{ path: 'manifest.json', kind: 'MANIFEST', sha256: sha256(manifest), byteSize: manifest.length, required: true, storage: { bucket: 'artifact-fixture', key: 'frozen', versionId: 'exact-fixture-version' }, sourcePath: null }], stages: [], omissions: [] } });
  let calls = 0;
  const transport = {
    getPublicKey: async () => ({ $metadata: {}, KeyId: keyArn, KeySpec: 'ECC_NIST_P256' as const, KeyUsage: 'SIGN_VERIFY' as const, SigningAlgorithms: ['ECDSA_SHA_256' as const], PublicKey: signing.publicKey.export({ format: 'der', type: 'spki' }) }),
    sign: async () => { calls++; const header = base64url.encode(jcsBytes({ alg: 'ES256', kid: 'envelope-key', typ: ENVELOPE_TYPE })); const bytes = Buffer.from(`${header}.${base64url.encode(prepared.envelopeBytes)}`); return { $metadata: {}, KeyId: keyArn, SigningAlgorithm: 'ECDSA_SHA_256' as const, Signature: sign('sha256', bytes, signing.privateKey) }; },
  };
  return { trust, registry, publish, prepared, transport, calls: () => calls, tamper: () => { const value = JSON.parse(signed.toString()); value.registry.keys[0].publicKeyPem = authority.publicKey.export({ format: 'pem', type: 'spki' }); signed = Buffer.from(JSON.stringify(value)); } };
}
describe('issuer-bound envelope key history from independent signed authority', () => {
  it('uses the current authenticated registry and emits a separate public history snapshot', async () => {
    const f = fixture(); expect(await f.trust.trustedPublicKey(issuer, 'envelope-key', now.toISOString())).toBe(pem);
    expect(f.trust.snapshot()).toMatchObject({ schema: 'packproof.envelope-trust.v1', issuer, keys: [{ status: 'ACTIVE', publicKeyPem: pem }] });
    expect(await f.trust.trustedPublicKey('https://substitute.example.test', 'envelope-key', now.toISOString())).toBeNull();
  });
  it('allows historical retirement verification but refuses new signing, revocation and compromise', async () => {
    const f = fixture(); f.registry.keys[0].status = 'RETIRED'; f.registry.keys[0].statusEffectiveAt = '2026-10-22T04:30:00.000Z'; f.publish();
    expect(await f.trust.trustedPublicKey(issuer, 'envelope-key', '2026-10-22T04:00:00.000Z')).toBe(pem);
    expect(() => f.trust.activeKey('envelope-key')).toThrow('ENVELOPE_UNTRUSTED_KEY');
    for (const status of ['REVOKED', 'COMPROMISED'] as const) { f.registry.keys[0].status = status; f.publish(); expect(await f.trust.trustedPublicKey(issuer, 'envelope-key', '2026-10-22T04:00:00.000Z')).toBeNull(); expect(f.trust.snapshot().keys[0].status).toBe(status); }
  });
  it('refuses stale or substituted registry content and future issue times', async () => {
    const f = fixture(); expect(await f.trust.trustedPublicKey(issuer, 'envelope-key', '2026-10-22T05:01:00.000Z')).toBeNull();
    f.tamper(); expect(await f.trust.trustedPublicKey(issuer, 'envelope-key', now.toISOString())).toBeNull();
    f.registry.publishedAt = '2026-10-21T00:00:00.000Z'; f.registry.nextReviewAt = '2026-10-22T04:00:00.000Z'; f.publish();
    expect(() => f.trust.snapshot()).toThrow('ENVELOPE_TRUST_REGISTRY_UNAVAILABLE');
  });
  it('reloads status before every KMS call and does not backdate a newly signed legacy record', async () => {
    const f = fixture(), signer = await createTrustedEnvelopeSigner({ keyArn, keyId: 'envelope-key', transport: f.transport, trust: f.trust, clock });
    await signer('envelope-key', f.prepared.envelopeBytes); expect(f.calls()).toBe(1);
    const old = jcsBytes({ ...f.prepared.envelope, issuedAt: '2026-10-01T00:00:00.000Z' });
    await expect(signer('envelope-key', old)).rejects.toThrow('ENVELOPE_NEW_SIGNING_TIME_REQUIRED');
    f.registry.keys[0].status = 'REVOKED'; f.registry.keys[0].statusEffectiveAt = now.toISOString(); f.publish();
    await expect(signer('envelope-key', f.prepared.envelopeBytes)).rejects.toThrow('ENVELOPE_UNTRUSTED_KEY'); expect(f.calls()).toBe(1);
  });
  it('rejects an in-flight revocation before returning a signature', async () => {
    const f = fixture(), original = f.transport.sign;
    f.transport.sign = async () => { const result = await original(); f.registry.keys[0].status = 'COMPROMISED'; f.registry.keys[0].statusEffectiveAt = now.toISOString(); f.publish(); return result; };
    const signer = await createTrustedEnvelopeSigner({ keyArn, keyId: 'envelope-key', transport: f.transport, trust: f.trust, clock });
    await expect(signer('envelope-key', f.prepared.envelopeBytes)).rejects.toThrow('ENVELOPE_UNTRUSTED_KEY');
  });
});
