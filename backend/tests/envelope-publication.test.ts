import { generateKeyPairSync, sign } from 'node:crypto';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import request from 'supertest';
import { afterEach, describe, expect, it } from 'vitest';
import { canonicalize } from '../src/canonical.js';
import type { SigningTrustRegistry } from '../src/domain/signing-trust.js';
import { initializeEnvelopeTrustPublication } from '../src/integrity/envelope-publication.js';
import { createHarness, type TestHarness } from './helpers.js';

const authority = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
const signer = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
const pem = signer.publicKey.export({ format: 'pem', type: 'spki' }).toString();
const issuer = 'https://envelopes.example.test';
const initial = '2026-10-22T05:00:00.000Z';
const endpoint = '/.well-known/packproof-envelope-trust.json';
let now = new Date(initial), directory: string | undefined, h: TestHarness | undefined;
const clock = { now: () => new Date(now) };
afterEach(async () => { await h?.close(); h = undefined; if (directory) await rm(directory, { recursive: true, force: true }); directory = undefined; now = new Date(initial); });

async function fixture() {
  directory = await mkdtemp(path.join(os.tmpdir(), 'packproof-envelope-publication-'));
  const env = { PACKPROOF_ENVELOPE_TRUST_PUBLICATION_ENABLED: 'true', PACKPROOF_ENVELOPE_ISSUER: issuer,
    PACKPROOF_MANIFEST_SIGNED_TRUST_REGISTRY_FILE: path.join(directory, 'registry.json'),
    PACKPROOF_MANIFEST_REGISTRY_AUTHORITY_KEYS_FILE: path.join(directory, 'pins.json') };
  const registry: SigningTrustRegistry = { version: 1, domain: 'PACKPROOF_SIGNING_TRUST_REGISTRY', publishedAt: initial, nextReviewAt: '2026-10-23T05:00:00.000Z',
    keys: (['ACTIVE', 'RETIRED', 'REVOKED', 'COMPROMISED'] as const).map(status => ({ keyId: `envelope-${status.toLowerCase()}`, algorithm: 'ECDSA_SHA_256', publicKeyPem: pem, status,
      validFrom: '2026-10-01T00:00:00.000Z', validUntil: null, statusEffectiveAt: status === 'ACTIVE' ? null : '2026-10-22T04:00:00.000Z', reason: null })) };
  const publish = async () => writeFile(env.PACKPROOF_MANIFEST_SIGNED_TRUST_REGISTRY_FILE, JSON.stringify({ registry, signature: {
    algorithm: 'ECDSA_SHA_256', keyId: 'independent-authority', signedAt: initial,
    signatureBase64: sign('sha256', Buffer.from(canonicalize(registry)), authority.privateKey).toString('base64'),
  } }));
  await writeFile(env.PACKPROOF_MANIFEST_REGISTRY_AUTHORITY_KEYS_FILE, JSON.stringify({ 'independent-authority': authority.publicKey.export({ format: 'pem', type: 'spki' }).toString() }));
  await publish();
  return { env, registry, publish };
}

describe('public envelope key-history distribution', () => {
  it('is disabled by default and strictly parses its opt-in flag', async () => {
    expect(initializeEnvelopeTrustPublication(clock, {})).toBeNull();
    expect(() => initializeEnvelopeTrustPublication(clock, { PACKPROOF_ENVELOPE_TRUST_PUBLICATION_ENABLED: 'yes' })).toThrow('FLAG_INVALID');
    h = await createHarness(clock);
    const response = await request(h.app).get(endpoint);
    expect(response.status).toBe(404); expect(response.body.error.code).toBe('ENVELOPE_TRUST_DISABLED');
    expect(response.headers['cache-control']).toBe('no-store');
  });

  it('refuses startup without a current signed registry, independent pins and HTTPS issuer', async () => {
    const f = await fixture();
    expect(() => initializeEnvelopeTrustPublication(clock, { ...f.env, PACKPROOF_ENVELOPE_ISSUER: '' })).toThrow('ISSUER_REQUIRED');
    for (const changes of [{ PACKPROOF_ENVELOPE_ISSUER: 'http://untrusted.test' }, { PACKPROOF_MANIFEST_REGISTRY_AUTHORITY_KEYS_FILE: '' }, { PACKPROOF_MANIFEST_SIGNED_TRUST_REGISTRY_FILE: '' }])
      expect(() => initializeEnvelopeTrustPublication(clock, { ...f.env, ...changes })).toThrow('Current independently authenticated');
    now = new Date(f.registry.nextReviewAt);
    expect(() => initializeEnvelopeTrustPublication(clock, f.env)).toThrow('Current independently authenticated');
  });

  it('publishes all dated key statuses anonymously from deployment configuration and reloads revocation', async () => {
    const f = await fixture(), publication = initializeEnvelopeTrustPublication(clock, f.env);
    h = await createHarness(clock, { envelopeTrustPublication: publication });
    const first = await request(h.app).get(endpoint + '?issuer=https://attacker.test').set('Host', 'attacker.test');
    expect(first.status).toBe(200);
    expect(first.body).toMatchObject({ schema: 'packproof.envelope-trust.v1', issuer, publishedAt: initial, nextReviewAt: f.registry.nextReviewAt });
    expect(first.body.keys.map((k: { status: string }) => k.status)).toEqual(['ACTIVE', 'RETIRED', 'REVOKED', 'COMPROMISED']);
    expect(first.headers['cache-control']).toBe('no-store'); expect(first.headers['x-content-type-options']).toBe('nosniff');
    expect(first.text).not.toContain('independent-authority'); expect(first.text).not.toContain('PRIVATE KEY');
    f.registry.keys[0].status = 'COMPROMISED'; f.registry.keys[0].statusEffectiveAt = initial; await f.publish();
    const changed = await request(h.app).get(endpoint).set('If-None-Match', first.headers.etag);
    expect(changed.status).toBe(200); expect(changed.body.keys[0].status).toBe('COMPROMISED');
    expect(publication!.snapshot().keys[0].status).toBe('COMPROMISED');
  });

  it('never serves a cached success after expiry, file loss or signature substitution', async () => {
    const f = await fixture(), publication = initializeEnvelopeTrustPublication(clock, f.env);
    h = await createHarness(clock, { envelopeTrustPublication: publication });
    const first = await request(h.app).get(endpoint); expect(first.status).toBe(200);
    const refused = async () => {
      const response = await request(h!.app).get(endpoint).set('If-None-Match', first.headers.etag);
      expect(response.status).toBe(503); expect(response.body.error.code).toBe('ENVELOPE_TRUST_UNAVAILABLE');
      expect(response.text).not.toContain(directory); expect(response.headers['cache-control']).toBe('no-store');
      expect(() => publication!.snapshot()).toThrow('Current independently authenticated');
    };
    now = new Date(f.registry.nextReviewAt); await refused(); now = new Date(initial);
    await writeFile(f.env.PACKPROOF_MANIFEST_SIGNED_TRUST_REGISTRY_FILE, JSON.stringify({ registry: f.registry, signature: { algorithm: 'ECDSA_SHA_256', keyId: 'independent-authority', signedAt: initial, signatureBase64: 'AAAA' } })); await refused();
    await f.publish(); await rm(f.env.PACKPROOF_MANIFEST_REGISTRY_AUTHORITY_KEYS_FILE); await refused();
  });
});
