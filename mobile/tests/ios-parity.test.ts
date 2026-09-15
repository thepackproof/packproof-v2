import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { PackProofV2Client } from '../src/v2-api';
import { requireCaptureCapabilities } from '../src/capture/capabilities';
import { connectionReturnFromLink, proofIdFromLink } from '../src/app/deep-links';
import { identifierCaptureEnabled, identifierObservation } from '../src/capture/identifier-observation';
import { shouldNotifyUploadLocally, type NotificationPreferences } from '../src/notifications/policy';

test('iOS capture requires its advertised biometric protocol and cannot silently use Android-only capabilities', () => {
  const capabilities = { schemaVersion: 1, capture: { protocolVersions: [1], maxBytes: 250000000, maxDurationSeconds: 300, maxActiveUploads: 2 }, preservation: { receiptVersions: [1], durableReceiptsRequired: true }, sellerAttestation: { challengeVersions: [1], statementVersion: 1, methods: ['ANDROID_BIOMETRIC_STRONG'] } };
  assert.throws(() => requireCaptureCapabilities(capabilities, true, 'IOS_BIOMETRIC'), { code: 'CAPABILITY_ATTESTATION_REQUIRED' });
  capabilities.sellerAttestation.methods.push('IOS_BIOMETRIC');
  assert.equal(requireCaptureCapabilities(capabilities, true, 'IOS_BIOMETRIC'), capabilities);
  assert.equal(requireCaptureCapabilities(capabilities, true), capabilities);
});

test('iOS identifier policy retains Apple provenance, null unknown bytes, and approximate frame timing', () => {
  assert.equal(identifierCaptureEnabled({ version: 1, captureEnabled: true, autofillEnabled: true, reviewEnabled: true, surface: 'IOS' }), true);
  assert.equal(identifierCaptureEnabled({ version: 1, captureEnabled: true, autofillEnabled: true, reviewEnabled: true, surface: 'WEB' }), false);
  const row = identifierObservation({ rawValue: '012345678905', format: 'UPC_A', detectedAtMs: 1900, detectedAtUnixMs: 2000, latencyMs: 10, decoderVersion: 'apple-avfoundation-18.0' }, 'cap_ios', 'IOS');
  assert.equal(row.adapterVersion, 'ios-identifiers-1');
  assert.equal(row.capabilityProfile, 'IOS_AVFOUNDATION_VISION_V1_UNQUALIFIED');
  assert.equal(row.decoderVersion, 'apple-avfoundation-18.0');
  assert.equal(row.timestampOrigin, 'MONOTONIC_APPROXIMATE');
  assert.equal(row.timestampUncertaintyMs, null);
  assert.equal(row.rawBytes, null);
  assert.equal(row.decoderEncoding, null);
  assert.equal(identifierObservation({ rawValue: '012345678905', format: 'UPC_A', detectedAtMs: 1900, detectedAtUnixMs: 2000, latencyMs: 10 }, 'cap_android').adapterVersion, 'android-identifiers-1');
});

test('native commerce callbacks support each provider and reject unrelated URLs', () => {
  for (const provider of ['ebay', 'etsy', 'shopify', 'google']) {
    assert.deepEqual(connectionReturnFromLink(`packproof-v2://connections/${provider}?${provider}=connected`), { provider, failed: false, code: null });
    assert.deepEqual(connectionReturnFromLink(`packproof-v2://connections/${provider}?${provider}=error&code=OAUTH_FAILED`), { provider, failed: true, code: 'OAUTH_FAILED' });
  }
  for (const value of ['https://untrusted.test/connections/ebay', 'packproof-v2://connections.evil/ebay', 'packproof-v2://name@connections/ebay', 'packproof-v2://connections/ebay/extra']) assert.equal(connectionReturnFromLink(value), null);
  assert.equal(proofIdFromLink('packproof://proof/proof_ios'), 'proof_ios');
  assert.equal(proofIdFromLink('https://untrusted.test/proof/proof_ios'), null);
});

test('local completion notices respect user choice, per-Proof mute, and remote push deduplication', () => {
  const prefs: NotificationPreferences = { enabled: true, uploads: true, evidence: true, participants: true, shipments: true, returns: true };
  assert.equal(shouldNotifyUploadLocally(prefs, false, [], 'proof_1'), true);
  assert.equal(shouldNotifyUploadLocally(prefs, true, [], 'proof_1'), false);
  assert.equal(shouldNotifyUploadLocally(prefs, false, ['proof_1'], 'proof_1'), false);
  assert.equal(shouldNotifyUploadLocally({ ...prefs, uploads: false }, false, [], 'proof_1'), false);
  assert.equal(shouldNotifyUploadLocally({ ...prefs, enabled: false }, false, [], 'proof_1'), false);
  assert.equal(shouldNotifyUploadLocally(null, false, [], 'proof_1'), false);
});

test('iOS native capture and store reconnection send the explicit platform to canonical authenticated APIs', async () => {
  const requests: Array<{ path: string; body: unknown; authorization: string | undefined }> = [];
  const server = createServer(async (req, res) => {
    let body = ''; for await (const chunk of req) body += chunk.toString();
    requests.push({ path: req.url!, body: JSON.parse(body || '{}'), authorization: req.headers.authorization });
    res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('{}');
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const client = new PackProofV2Client({ baseUrl: `http://127.0.0.1:${address.port}`, getToken: () => 'fixture-token' });
  try {
    await client.createCaptureSession('proof_ios', 'same-operation', 'stage_1', 'IOS');
    await client.startConnectedAccountConnect('etsy', { surface: 'ios' });
    await client.reauthorizeConnectedAccount('account_etsy', 'ios');
    assert.equal((requests[0].body as { surface: string }).surface, 'IOS');
    assert.equal((requests[0].body as { stageId: string }).stageId, 'stage_1');
    assert.deepEqual(requests.slice(1).map(row => row.body), [{ surface: 'ios' }, { surface: 'ios' }]);
    assert.ok(requests.every(row => row.authorization === 'Bearer fixture-token'));
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
});
