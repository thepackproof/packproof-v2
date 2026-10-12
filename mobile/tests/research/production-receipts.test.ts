import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { canonicalize } from '../../../packages/evidence-contracts/contracts.mjs';
import { assertProductionReceiptEndpoint } from '../../src/research/isolation';
import { resolveRuntimeConfig } from '../../src/runtime-config';
import * as policy from '../../src/research/production-policy';
import { checkedReceiptReview, assertClosedReceipt, type ReceiptReview } from '../../src/research/receipt-review';
import type { LocalCapture } from '../../src/capture';
import type { PackProofV2Client } from '../../src/v2-api';

function signedReceipt(sourceId = 'evidence_A'): ReceiptReview['captureReceipts'][number] {
  const receipt = { schemaVersion: 'packproof.capture-receipt.v1' as const, proofId: 'proof_A', intentId: 'intent_A', captureSessionId: 'cap_A', receivedAt: '2026-10-11T00:00:00Z', sources: [{ evidenceId: sourceId, sha256: 'a'.repeat(64), byteLength: 123, mimeType: 'video/mp4' }], assurance: { chainCoverage: 'FINAL_FILE_ONLY' as const } };
  const canonicalJson = canonicalize(receipt);
  return { receipt, canonicalJson, digest: createHash('sha256').update(canonicalJson).digest('hex'), signature: {} };
}

const capabilities = { enabled: true, killSwitch: false, profile: 'capture-receipts-v1', qualification: 'DIGITAL_RECEIPTS_ONLY', supportedOperations: { captureReceipts: true }, features: { verifiedcapture: { collection: true }, proofpilot: { collection: true } } };
const consent = { proofId: 'proof_A', allowedPurposes: ['EXPERIMENTAL_ANALYSIS'], consents: [{ purpose: 'EXPERIMENTAL_ANALYSIS', version: policy.RECEIPT_CONSENT_VERSION, granted: true, recordedAt: '2026-10-11T00:00:00Z' }] };
test('production runtime uses fixed HTTPS Cognito and ignores cached lab API and identity', () => {
  const env = { EXPO_PUBLIC_PACKPROOF_RND_PRODUCTION: 'true', EXPO_PUBLIC_PACKPROOF_AUTH_MODE: 'cognito', EXPO_PUBLIC_PACKPROOF_API_BASE_URL: 'https://api.example.test', EXPO_PUBLIC_COGNITO_USER_POOL_ID: 'configured-pool', EXPO_PUBLIC_COGNITO_CLIENT_ID: 'configured-client' };
  const runtime = resolveRuntimeConfig({ env, isRelease: false, cached: { apiBaseUrl: 'http://localhost:3000', authMode: 'dev', cognitoClientId: 'cached' } });
  assert.equal(runtime.authMode, 'cognito'); assert.equal(runtime.apiBaseUrl, env.EXPO_PUBLIC_PACKPROOF_API_BASE_URL);
  assert.equal(runtime.cognito.clientId, 'configured-client'); assert.equal(runtime.allowsApiOverride, false); assert.equal(runtime.allowsDevAuth, false);
  for (const bad of [{ EXPO_PUBLIC_PACKPROOF_RND: 'true' }, { EXPO_PUBLIC_PACKPROOF_AUTH_MODE: 'dev' }, { EXPO_PUBLIC_PACKPROOF_API_BASE_URL: '' }])
    assert.throws(() => resolveRuntimeConfig({ env: { ...env, ...bad }, isRelease: true }));
  for (const bad of ['http://api.example.test', 'https://api.example.test/other', 'https://user:pass@api.example.test', 'https://other.example.test', 'https://10.0.0.1', 'https://192.168.2.1', 'https://localhost', 'https://[::1]', 'https://api.example.test?x=1', 'https://api.example.test:8443'])
    assert.throws(() => assertProductionReceiptEndpoint(bad, 'https://api.example.test'));
});
test('enrollment requires exact profile, current actor consent and admission; unavailable is never opt-in', async () => {
  let read = 0;
  const client = { researchCapabilities: async () => capabilities, async researchRequest<T>(): Promise<T> { read++; return structuredClone(consent) as T; } };
  assert.equal(await policy.productionReceiptEnrollment(client, 'proof_A'), true);
  for (const change of [{ enabled: false }, { killSwitch: true }, { profile: 'laboratory' }, { qualification: 'RESEARCH_UNQUALIFIED' }, { supportedOperations: {} }])
    assert.equal(await policy.productionReceiptEnrollment({ ...client, researchCapabilities: async () => ({ ...capabilities, ...change }) }, 'proof_A'), false);
  assert.equal(read, 1);
  for (const change of [{ allowedPurposes: [] }, { consents: [] }, { consents: [{ ...consent.consents[0], granted: false }] }, { consents: [{ ...consent.consents[0], version: 'old' }] }])
    assert.equal(await policy.productionReceiptEnrollment({ ...client, async researchRequest<T>() { return { ...consent, ...change } as T; } }, 'proof_A'), false);
  await assert.rejects(policy.productionReceiptEnrollment(client, 'proof_B'), /different Proof/);
});
test('production request boundary excludes analyses, sampling, active challenges, attestation and arbitrary paths', () => {
  for (const [method, path] of [['GET', '/consents'], ['GET', '/capture-receipts'], ['POST', '/consents'], ['POST', '/capture-intents'], ['POST', '/capture-intents/rnd_A/start'], ['POST', '/capture-intents/rnd_A/close'], ['POST', '/exports']]) policy.assertProductionReceiptOperation(path, method);
  for (const path of ['/analyses', '/sidecars', '/live-challenges', '/platform-challenges', '/derivatives', '/../consents', '/capture-intents/rnd_A/start?x=1'])
    assert.throws(() => policy.assertProductionReceiptOperation(path, 'POST'), /unavailable/);
  assert.throws(() => policy.assertProductionReceiptOperation('/capture-receipts', 'DELETE'));
});

// Execute the shipped coordinator, replacing only native I/O/platform transports.
function fixture() {
  const calls: string[] = []; let active = true, grant = true, failClose = false, failSign = false, switchDuringKey = false, wrongReceipt = false;
  let binding: Record<string, unknown> | null = null;
  const native = {
    async prepareResearchKey() { calls.push('key'); if (switchDuringKey) active = false; return { publicKeySpki: 'YWJj', keyProtection: 'ANDROID_KEYSTORE', appAttestation: 'NOT_CHECKED' }; },
    async bindResearchCapture(_session: string, _proof: string, value: string) { calls.push('bind'); binding = JSON.parse(value); },
    async readResearchCapture() { calls.push('read'); return JSON.stringify({ captureSessionId: 'cap_A', binding: { proofId: 'proof_A' }, mediaSha256: 'a'.repeat(64), mediaByteLength: 123, journalSha256: 'b'.repeat(64), acquisitionSha256: 'c'.repeat(64) }); },
    async signResearchCapture() { calls.push('sign'); if (failSign) throw new Error('native unavailable'); return { signature: 'signature', publicKeySpki: 'YWJj' }; },
  };
  const client = { apiBaseUrl: 'https://api.example.test', assertCaptureAccount(userId: string, api: string) { if (!active || userId !== 'seller' || api !== this.apiBaseUrl) throw new Error('ACCOUNT_CHANGED'); },
    async researchCapabilities() { return capabilities; },
    async researchRequest<T>(_proof: string, path: string): Promise<T> {
      calls.push(path);
      if (path === '/consents') return { ...consent, consents: [{ ...consent.consents[0], granted: grant }] } as T;
      if (path === '/capture-intents') return { intent: { id: 'intent_A', nonce: 'nonce', subject: {} }, canonicalJson: '{}', digest: 'digest', signature: {} } as T;
      if (path.endsWith('/close')) { if (failClose) throw new Error('network'); return signedReceipt(wrongReceipt ? 'wrong_evidence' : 'evidence_A') as T; }
      return {} as T;
    },
  } as unknown as PackProofV2Client;
  const modules: Record<string, unknown> = {
    './production-policy': policy,
    './receipt-review': { assertClosedReceipt },
    './sidecars': { uploadNativeSidecars: async () => { throw new Error('Production must never upload frames or sidecars'); } },
    './platform-assurance': { collectPlatformAssurance: async () => { throw new Error('Unexpected platform attestation'); }, collectAndroidKeyAssurance: async () => { throw new Error('Unexpected key attestation'); } },
    '../../../packages/evidence-contracts/contracts.mjs': { canonicalize },
    './native': { nativeResearch: () => native },
    './isolation': { researchEnabled: () => true, researchProductionEnabled: () => true, assertResearchApiEndpoint: (value: string) => assertProductionReceiptEndpoint(value, client.apiBaseUrl) },
    '../v2-api': { newIdempotencyKey: () => 'key' },
  };
  const compiled = ts.transpileModule(readFileSync(new URL('../../src/research/capture.ts', import.meta.url), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const loaded = { exports: {} as typeof import('../../src/research/capture') };
  new Function('require', 'module', 'exports', compiled)((id: string) => { assert.ok(id in modules, id); return modules[id]; }, loaded, loaded.exports);
  return { api: loaded.exports, client, calls, binding: () => binding, withdraw: () => { grant = false; }, switchAccount: () => { active = false; }, switchDuringKey: () => { switchDuringKey = true; }, failClose: (value: boolean) => { failClose = value; }, failSign: () => { failSign = true; }, wrongReceipt: () => { wrongReceipt = true; } };
}
test('actual production capture binds explicit final-only mode even if server advertises frame sampling', async () => {
  const f = fixture(), input = { proofId: 'proof_A', userId: 'seller' };
  const prepared = await f.api.prepareResearchSession(f.client, input); assert.ok(prepared); assert.equal(prepared.samplingEnabled, false);
  const result = await f.api.bindResearchSession(f.client, { ...input, captureSessionId: 'cap_A' }, prepared); assert.equal(result?.state, 'BOUND');
  assert.equal(f.binding()?.collectionMode, 'FINAL_FILE_RECEIPT'); assert.equal(f.binding()?.keyScope, 'https://api.example.test|seller');
  assert.equal(f.binding()?.samplingEnabled, false); assert.equal(f.binding()?.passiveChallenge, null);
  assert.equal(f.calls.includes('/live-challenges'), false);
});
test('opt-out and an account change during key preparation never issue or bind an optional capture intent', async () => {
  const f = fixture(); f.withdraw(); assert.equal(await f.api.prepareResearchSession(f.client, { proofId: 'proof_A', userId: 'seller' }), undefined); assert.equal(f.calls.includes('key'), false);
  const g = fixture(); g.switchDuringKey(); assert.equal(await g.api.prepareResearchSession(g.client, { proofId: 'proof_A', userId: 'seller' }), undefined); assert.equal(g.calls.includes('/capture-intents'), false);
  assert.equal(await g.api.bindResearchSession(g.client, { proofId: 'proof_A', userId: 'seller', captureSessionId: 'cap_A' }), undefined);
});
test('final-file receipt retry preserves original, skips sidecars/assurance and closes only once', async () => {
  const f = fixture(), input = { proofId: 'proof_A', userId: 'seller' };
  const prepared = await f.api.prepareResearchSession(f.client, input);
  const research = await f.api.bindResearchSession(f.client, { ...input, captureSessionId: 'cap_A' }, prepared);
  const capture: LocalCapture = { uri: 'file:///video.mp4', byteSize: 123, durationMs: 1000, contentType: 'video/mp4', captureProofId: 'proof_A', captureSessionId: 'cap_A', captureUserId: 'seller', research };
  let writes = 0; const save = async () => { writes++; };
  f.failClose(true); await f.api.closeResearchSession(f.client, capture, 'evidence_A', save);
  assert.equal(capture.research?.state, 'SIGNED'); assert.equal(capture.uri, 'file:///video.mp4'); assert.ok(capture.research?.unavailableReason);
  f.failClose(false); await Promise.all([f.api.closeResearchSession(f.client, capture, 'evidence_A', save), f.api.closeResearchSession(f.client, capture, 'evidence_A', save)]);
  assert.equal(capture.research?.state, 'RECEIVED'); assert.equal(capture.research?.unavailableReason, undefined); assert.ok(writes >= 3);
  assert.equal(f.calls.filter(value => value.endsWith('/close')).length, 2); assert.equal(f.calls.filter(value => value === 'sign').length, 1);
  await f.api.closeResearchSession(f.client, capture, 'evidence_A', save); assert.equal(f.calls.filter(value => value.endsWith('/close')).length, 2);
});
test('native signing failure is durable optional unavailability and never a false receipt', async () => {
  const f = fixture(), input = { proofId: 'proof_A', userId: 'seller' };
  const prepared = await f.api.prepareResearchSession(f.client, input), research = await f.api.bindResearchSession(f.client, { ...input, captureSessionId: 'cap_A' }, prepared);
  const capture = { captureProofId: 'proof_A', captureSessionId: 'cap_A', captureUserId: 'seller', research } as LocalCapture;
  f.failSign(); let writes = 0; await f.api.closeResearchSession(f.client, capture, 'evidence_A', async () => { writes++; });
  assert.equal(capture.research?.state, 'UNAVAILABLE'); assert.equal(capture.research?.receipt, undefined); assert.equal(writes, 1); assert.equal(f.calls.some(value => value.endsWith('/close')), false);
});
test('a receipt for another evidence source cannot mark this recording received', async () => {
  const f = fixture(), input = { proofId: 'proof_A', userId: 'seller' };
  const prepared = await f.api.prepareResearchSession(f.client, input), research = await f.api.bindResearchSession(f.client, { ...input, captureSessionId: 'cap_A' }, prepared);
  const capture = { captureProofId: 'proof_A', captureSessionId: 'cap_A', captureUserId: 'seller', research } as LocalCapture;
  f.wrongReceipt(); await f.api.closeResearchSession(f.client, capture, 'evidence_A');
  assert.equal(research?.state, 'SIGNED'); assert.equal(research?.receipt, undefined); assert.ok(research?.unavailableReason);
});
test('native production capability requires the version2 implementation and never enables iOS production receipt collection', () => {
  const compiled = ts.transpileModule(readFileSync(new URL('../../src/research/native.ts', import.meta.url), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  function load(os: string, version?: number, throws = false) {
    const native = { bindResearchCapture() {}, readResearchCapture() {}, prepareResearchKey() {}, signResearchCapture() {}, researchCaptureVersion: version === undefined ? undefined : () => { if (throws) throw new Error('native'); return version; } };
    const modules: Record<string, unknown> = { 'expo-modules-core': { requireOptionalNativeModule: () => native }, 'react-native': { Platform: { OS: os } }, './isolation': { researchEnabled: () => true, researchProductionEnabled: () => true } };
    const loaded = { exports: {} as typeof import('../../src/research/native') };
    new Function('require', 'module', 'exports', compiled)((id: string) => modules[id], loaded, loaded.exports);
    return loaded.exports.nativeResearch();
  }
  assert.ok(load('android', 2)); assert.equal(load('android'), null); assert.equal(load('android', 1), null); assert.equal(load('android', 2, true), null); assert.equal(load('ios', 2), null);
});
test('actual API transport refuses unqualified production methods and nonconfigured origins before network I/O', async () => {
  const { PackProofV2Client } = await import('../../src/v2-api');
  const names = ['EXPO_PUBLIC_PACKPROOF_RND', 'EXPO_PUBLIC_PACKPROOF_RND_PRODUCTION', 'EXPO_PUBLIC_PACKPROOF_API_BASE_URL'] as const;
  const saved = names.map(name => process.env[name]), fetch = globalThis.fetch;
  let requests = 0;
  try {
    process.env.EXPO_PUBLIC_PACKPROOF_RND = 'false'; process.env.EXPO_PUBLIC_PACKPROOF_RND_PRODUCTION = 'true'; process.env.EXPO_PUBLIC_PACKPROOF_API_BASE_URL = 'https://api.example.test';
    globalThis.fetch = async () => { requests++; return new Response(JSON.stringify(consent), { status: 200, headers: { 'Content-Type': 'application/json' } }); };
    const client = new PackProofV2Client({ baseUrl: 'https://api.example.test', getToken: () => 'fixture-token' });
    await client.researchRequest('proof_A', '/consents'); assert.equal(requests, 1);
    for (const path of ['/analyses', '/sidecars', '/live-challenges', '/platform-challenges', '/derivatives']) await assert.rejects(client.researchRequest('proof_A', path, 'POST'), /unavailable/);
    assert.throws(() => client.researchContentUrl('proof_A', '/sidecars/rnd_sidecar_A'), /Only receipt metadata/);
    const wrong = new PackProofV2Client({ baseUrl: 'https://other.example.test', getToken: () => 'fixture-token' });
    await assert.rejects(wrong.researchRequest('proof_A', '/consents'), /configured public HTTPS/); assert.equal(requests, 1);
  } finally { globalThis.fetch = fetch; names.forEach((name, i) => { if (saved[i] === undefined) delete process.env[name]; else process.env[name] = saved[i]; }); }
});
test('receipt review rejects altered canonical bytes, source digests and another Proof', () => {
  const receipt = { schemaVersion: 'packproof.capture-receipt.v1', proofId: 'proof_A', intentId: 'intent_A', captureSessionId: 'cap_A', receivedAt: 'now', sources: [{ evidenceId: 'ev_A', sha256: 'a'.repeat(64), byteLength: 123, mimeType: 'video/mp4' }], assurance: { chainCoverage: 'FINAL_FILE_ONLY' } };
  const canonicalJson = canonicalize(receipt), review = { proofId: 'proof_A', qualification: 'DIGITAL_RECEIPTS_ONLY', limitations: [], captureReceipts: [{ receipt, canonicalJson, digest: createHash('sha256').update(canonicalJson).digest('hex'), signature: {} }] } as ReceiptReview;
  assert.equal(checkedReceiptReview(review, 'proof_A'), review);
  assert.throws(() => checkedReceiptReview(review, 'proof_B'));
  for (const tamper of [(row: ReceiptReview['captureReceipts'][0]) => { row.receipt.sources[0].byteLength++; }, (row: ReceiptReview['captureReceipts'][0]) => { row.digest = 'b'.repeat(64); }, (row: ReceiptReview['captureReceipts'][0]) => { row.receipt.sources[0].sha256 = 'bad'; }]) {
    const bad = structuredClone(review); tamper(bad.captureReceipts[0]); assert.throws(() => checkedReceiptReview(bad, 'proof_A'));
  }
});
