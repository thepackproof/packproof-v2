/** Generated protocol fixtures; no Apple/Google hardware assertion is simulated. */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHash, createPrivateKey, createPublicKey, sign } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import cbor from 'cbor';
import * as asn1 from 'asn1js';
import { createGooglePlayIntegrityDecoder, PlatformServiceUnavailable, verifyPlayIntegrity, verifyAppAttestAttestation, verifyAppAttestAssertion, verifyAndroidKeyAttestationChain, type AppAttestPolicy, type AppAttestKeyRecord, type PlayIntegrityPolicy } from '../src/rnd/platform-assurance.js';

const hash = (value: Uint8Array | string) => createHash('sha256').update(value).digest();
const now = Date.now(), window = { now, challengeIssuedAt: now - 1000, challengeExpiresAt: now + 60_000 };
const binding = hash('server-generated randomized intent, subject and session fixture');
const appId = 'FIXTURETEAM.com.packproof.mobile.research';
let temporary: string, policy: AppAttestPolicy, fixture: { objectBase64: string; keyId: string; expectedClientDataHash: Buffer };
let key: AppAttestKeyRecord, privateKeyPem: string, authData: Buffer, rootPem: string, leafDer: Buffer, intermediateDer: Buffer;
const openssl = (...args: string[]) => execFileSync('openssl', args, { cwd: temporary, stdio: ['ignore', 'pipe', 'pipe'] });
const pem = (filename: string) => readFileSync(join(temporary, filename), 'utf8');
const file = (filename: string, text: string) => writeFileSync(join(temporary, filename), text);

beforeAll(async () => {
  temporary = mkdtempSync(join(tmpdir(), 'packproof-attestation-fixtures-'));
  openssl('req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:P-256', '-nodes', '-keyout', 'root.key', '-out', 'root.pem', '-sha256', '-days', '2', '-subj', '/CN=PackProof TEST ONLY Root', '-addext', 'basicConstraints=critical,CA:TRUE', '-addext', 'keyUsage=critical,keyCertSign,cRLSign');
  openssl('req', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:P-256', '-nodes', '-keyout', 'intermediate.key', '-out', 'intermediate.csr', '-subj', '/CN=PackProof TEST ONLY Intermediate');
  file('intermediate.ext', 'basicConstraints=critical,CA:TRUE,pathlen:0\nkeyUsage=critical,keyCertSign,cRLSign\n');
  openssl('x509', '-req', '-in', 'intermediate.csr', '-CA', 'root.pem', '-CAkey', 'root.key', '-set_serial', '2', '-out', 'intermediate.pem', '-days', '1', '-sha256', '-extfile', 'intermediate.ext');
  openssl('req', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:P-256', '-nodes', '-keyout', 'leaf.key', '-out', 'leaf.csr', '-subj', '/CN=PackProof TEST ONLY Credential');
  privateKeyPem = pem('leaf.key');
  const publicKey = createPublicKey(privateKeyPem), jwk = publicKey.export({ format: 'jwk' });
  const x = Buffer.from(jwk.x!, 'base64url'), y = Buffer.from(jwk.y!, 'base64url');
  const keyId = hash(Buffer.concat([Buffer.from([4]), x, y]));
  const header = Buffer.alloc(87); hash(appId).copy(header); header[32] = 0xc0; header.writeUInt32BE(0, 33);
  Buffer.from('appattestdevelop').copy(header, 37); header.writeUInt16BE(32, 53); keyId.copy(header, 55);
  authData = Buffer.concat([header, cbor.encode(new Map([[1, 2], [3, -7], [-1, 1], [-2, x], [-3, y]])), cbor.encode(new Map([['apple_validation_category_01', 3], ['apple_bundle_version_01', '1.0.1']]))]);
  const nonce = hash(Buffer.concat([authData, binding]));
  const extension = Buffer.from(new asn1.Sequence({ value: [new asn1.Constructed({ idBlock: { tagClass: 3, tagNumber: 1 }, value: [new asn1.OctetString({ valueHex: nonce })] })] }).toBER(false));
  file('leaf.ext', `basicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature\n1.2.840.113635.100.8.2=DER:${extension.toString('hex').match(/../g)!.join(':')}\n`);
  openssl('x509', '-req', '-in', 'leaf.csr', '-CA', 'intermediate.pem', '-CAkey', 'intermediate.key', '-set_serial', '3', '-out', 'leaf.pem', '-days', '1', '-sha256', '-extfile', 'leaf.ext');
  leafDer = openssl('x509', '-in', 'leaf.pem', '-outform', 'DER'); intermediateDer = openssl('x509', '-in', 'intermediate.pem', '-outform', 'DER'); rootPem = pem('root.pem');
  fixture = { objectBase64: cbor.encode({ fmt: 'apple-appattest', attStmt: { x5c: [leafDer, intermediateDer], receipt: Buffer.from('TEST ONLY RECEIPT') }, authData }).toString('base64'), keyId: keyId.toString('base64'), expectedClientDataHash: binding };
  policy = { appId, environment: 'development', trustedRootCertificatesPem: [rootPem], trustPolicyId: 'TEST-ONLY-GENERATED-ROOT-v1', trustPolicyExpiresAt: now + 60_000, now, allowedValidationCategories: [3], allowedBundleVersions: ['1.0.1'] };
  key = { keyId: fixture.keyId, publicKeyPem: publicKey.export({ format: 'pem', type: 'spki' }).toString(), appId, environment: 'development', counter: 0, trustPolicyId: policy.trustPolicyId };
});
afterAll(() => { if (temporary) rmSync(temporary, { recursive: true, force: true }); });

function assertion(counter = 1, details: { binding?: Buffer; app?: string; category?: number; version?: string; } = {}) {
  const header = Buffer.alloc(37); hash(details.app ?? appId).copy(header); header[32] = 0x80; header.writeUInt32BE(counter, 33);
  const authenticatorData = Buffer.concat([header, cbor.encode({ validationCategory: details.category ?? 3, bundleVersion: details.version ?? '1.0.1' })]);
  const signature = sign('sha256', Buffer.concat([authenticatorData, details.binding ?? binding]), createPrivateKey(privateKeyPem));
  return cbor.encode({ signature, authenticatorData }).toString('base64');
}

describe('App Attest cryptographic protocol fixtures (not Apple hardware qualification)', () => {
  it('validates actual generated certificate signatures, nonce extension, COSE key and app/environment binding', async () => {
    const checked = await verifyAppAttestAttestation({ ...window, ...fixture }, policy);
    expect(checked.reasonCodes).toEqual([]); expect(checked.state).toBe('VALIDATED');
    expect(checked.registeredKey).toEqual(key); expect(checked.components.cameraSensor).toBe('NOT_CHECKED');
  });
  it('fails closed without fresh configured roots', async () => {
    expect((await verifyAppAttestAttestation({ ...window, ...fixture })).state).toBe('UNSUPPORTED');
    expect((await verifyAppAttestAttestation({ ...window, ...fixture }, { ...policy, trustPolicyExpiresAt: now })).state).toBe('UNSUPPORTED');
    expect((await verifyAppAttestAttestation({ ...window, ...fixture }, { ...policy, trustedRootCertificatesPem: [pem('leaf.pem')] })).state).toBe('INVALID');
  });
  it('rejects wrong challenge, app, environment, key identity and revoked key', async () => {
    for (const [input, configured] of [
      [{ ...fixture, expectedClientDataHash: hash('different') }, policy],
      [fixture, { ...policy, appId: 'OTHERTEAM.com.packproof.mobile' }],
      [fixture, { ...policy, environment: 'production' as const }],
      [{ ...fixture, keyId: hash('other key').toString('base64') }, policy],
      [fixture, { ...policy, revokedKeyIds: [fixture.keyId] }],
    ] as const) expect((await verifyAppAttestAttestation({ ...window, ...input }, configured)).state).toBe('INVALID');
  });
  it('rejects altered certificate signatures and current extension policy mismatches', async () => {
    const modified = Buffer.from(leafDer); modified[modified.length - 2] ^= 1;
    const objectBase64 = cbor.encode({ fmt: 'apple-appattest', attStmt: { x5c: [modified, intermediateDer], receipt: Buffer.from('fixture') }, authData }).toString('base64');
    expect((await verifyAppAttestAttestation({ ...window, ...fixture, objectBase64 }, policy)).state).toBe('INVALID');
    for (const changed of [{ allowedValidationCategories: [4] }, { allowedBundleVersions: ['2.0.0'] }]) expect((await verifyAppAttestAttestation({ ...window, ...fixture }, { ...policy, ...changed })).state).toBe('INVALID');
  });
  it('rejects trailing CBOR, duplicate map keys and invalid encoding', async () => {
    for (const objectBase64 of [Buffer.concat([Buffer.from(fixture.objectBase64, 'base64'), cbor.encode(1)]).toString('base64'), Buffer.from('a2616101616102', 'hex').toString('base64'), '!!!!']) {
      expect((await verifyAppAttestAttestation({ ...window, ...fixture, objectBase64 }, policy)).state).toBe('INVALID');
    }
  });
  it('accepts a real ECDSA assertion only after an atomic counter advancement', async () => {
    let stored = 0;
    const advance = async (previous: number, next: number) => { if (stored !== previous) return false; stored = next; return true; };
    const input = { ...window, objectBase64: assertion(), expectedClientDataHash: binding, key };
    const checked = await verifyAppAttestAssertion(input, policy, advance);
    expect(checked.state).toBe('VALIDATED'); expect(stored).toBe(1);
    expect((await verifyAppAttestAssertion(input, policy, advance)).reasonCodes).toContain('ASSERTION_COUNTER_CONFLICT');
    expect((await verifyAppAttestAssertion({ ...input, key: { ...key, counter: 1 } }, policy, advance)).reasonCodes).toContain('ASSERTION_COUNTER_REPLAY');
  });
  it('rejects wrong assertion digest, app, counter and version; unavailable store never validates', async () => {
    const input = { ...window, objectBase64: assertion(), expectedClientDataHash: binding, key };
    expect((await verifyAppAttestAssertion(input, policy)).state).toBe('UNSUPPORTED');
    for (const objectBase64 of [assertion(0), assertion(1, { binding: hash('different') }), assertion(1, { app: 'WRONGTEAM.app' }), assertion(1, { category: 4 }), assertion(1, { version: '0.1' })]) {
      let called = false;
      expect((await verifyAppAttestAssertion({ ...input, objectBase64 }, policy, async () => { called = true; return true; })).state).toBe('INVALID');
      expect(called).toBe(false);
    }
  });
  it('rejects expired server challenges even when the signature is otherwise valid', async () => {
    expect((await verifyAppAttestAssertion({ ...window, challengeExpiresAt: now, objectBase64: assertion(), expectedClientDataHash: binding, key }, policy, async () => true)).state).toBe('INVALID');
  });
});

describe('Google server-decoded integrity payload policy', () => {
  const tokenPayloadExternal = {
    requestDetails: { requestPackageName: 'com.packproof.mobile.research', requestHash: binding.toString('base64url'), timestampMillis: String(now) },
    appIntegrity: { packageName: 'com.packproof.mobile.research', appRecognitionVerdict: 'PLAY_RECOGNIZED', certificateSha256Digest: [hash('test-signing-certificate').toString('base64url')], versionCode: '55' },
    deviceIntegrity: { deviceRecognitionVerdict: ['MEETS_DEVICE_INTEGRITY'] }, accountDetails: { appLicensingVerdict: 'LICENSED' },
  };
  const configured: PlayIntegrityPolicy = { packageName: 'com.packproof.mobile.research', certificateSha256Digests: tokenPayloadExternal.appIntegrity.certificateSha256Digest, minimumVersionCode: '55', requiredDeviceVerdicts: ['MEETS_DEVICE_INTEGRITY'], requireLicensed: true, maxTokenAgeMs: 120_000, decodeToken: async () => ({ tokenPayloadExternal }) };
  const input = { ...window, token: 'opaque-test-token', expectedRequestHash: binding.toString('base64url') };
  it('validates source-bound decoded fixture and labels sensor assurance unavailable', async () => {
    const checked = await verifyPlayIntegrity(input, configured); expect(checked.state).toBe('VALIDATED'); expect(checked.components.cameraSensor).toBe('NOT_CHECKED');
  });
  it('denies wrong request/certificate/version/device/license/freshness', async () => {
    for (const change of [
      { requestDetails: { ...tokenPayloadExternal.requestDetails, requestHash: hash('wrong').toString('base64url') } },
      { requestDetails: { ...tokenPayloadExternal.requestDetails, requestPackageName: 'evil.app' } },
      { requestDetails: { ...tokenPayloadExternal.requestDetails, timestampMillis: String(now - 5000) } },
      { requestDetails: { ...tokenPayloadExternal.requestDetails, timestampMillis: String(now + 31_000) } },
      { appIntegrity: { ...tokenPayloadExternal.appIntegrity, certificateSha256Digest: ['different'] } },
      { appIntegrity: { ...tokenPayloadExternal.appIntegrity, versionCode: '54' } },
      { appIntegrity: { ...tokenPayloadExternal.appIntegrity, appRecognitionVerdict: 'UNEVALUATED' } },
      { deviceIntegrity: { deviceRecognitionVerdict: [] } },
      { accountDetails: { appLicensingVerdict: 'UNLICENSED' } },
    ]) expect((await verifyPlayIntegrity(input, { ...configured, decodeToken: async () => ({ tokenPayloadExternal: { ...tokenPayloadExternal, ...change } }) })).state).toBe('INVALID');
  });
  it('missing service/configuration is unsupported, never a forged success', async () => {
    expect((await verifyPlayIntegrity(input)).state).toBe('UNSUPPORTED');
    expect((await verifyPlayIntegrity(input, { ...configured, decodeToken: async () => { throw new PlatformServiceUnavailable('GOOGLE_OFFLINE'); } })).state).toBe('UNSUPPORTED');
  });
  it('uses authenticated fixed Google endpoint and bounded response; no live Google call is made', async () => {
    const decode = createGooglePlayIntegrityDecoder({ packageName: configured.packageName, getAccessToken: async () => 'test-only-access-token', fetchImpl: async (url, init) => {
      expect(url).toBe('https://playintegrity.googleapis.com/v1/com.packproof.mobile.research:decodeIntegrityToken');
      expect(init?.redirect).toBe('error'); expect(init?.headers).toMatchObject({ Authorization: 'Bearer test-only-access-token' });
      expect(JSON.parse(String(init?.body))).toEqual({ integrity_token: 'opaque-test-token' });
      return new Response(JSON.stringify({ tokenPayloadExternal }), { status: 200 });
    } });
    expect((await verifyPlayIntegrity(input, { ...configured, decodeToken: decode })).state).toBe('VALIDATED');
    const unavailable = createGooglePlayIntegrityDecoder({ packageName: configured.packageName, getAccessToken: async () => null });
    expect((await verifyPlayIntegrity(input, { ...configured, decodeToken: unavailable })).state).toBe('UNSUPPORTED');
    const oversized = createGooglePlayIntegrityDecoder({ packageName: configured.packageName, getAccessToken: async () => 'test', fetchImpl: async () => new Response('x'.repeat(65537)) });
    expect((await verifyPlayIntegrity(input, { ...configured, decodeToken: oversized })).reasonCodes).toContain('GOOGLE_RESPONSE_TOO_LARGE');
  });
});

it('Android chain diagnostics fail closed without current roots/revocation and reject revoked certificates', async () => {
  const input = { certificatesBase64: [leafDer.toString('base64'), intermediateDer.toString('base64')], now };
  expect((await verifyAndroidKeyAttestationChain(input)).state).toBe('UNSUPPORTED');
  expect((await verifyAndroidKeyAttestationChain(input, { trustedRootCertificatesPem: [rootPem], revocationEntries: { '3': { status: 'REVOKED' } }, revocationValidUntil: now + 60_000, trustPolicyId: 'TEST_ONLY' })).reasonCodes).toContain('ANDROID_ATTESTATION_CERTIFICATE_REVOKED');
});
