import { test } from 'node:test';
import assert from 'node:assert/strict';
import { canSelectRelayOrder, parseRelayPairing, readRelayDevice, readRelayStation, relayStorageKey, RelayScope, sendRelayCommand, type RelayDevice, type RelayStation } from '../src/relay/model';
import { registerRemoteCaptureStop, stopRemoteCapture } from '../src/capture/remote-control';
import { proofEmailDeliveryMessage, proofEmailTrackerLink } from '../src/copy/proof-email';
import { PackProofV2Client } from '../src/v2-api';
const device: RelayDevice = { version: 1, id: 'relay_1', role: 'CONTROLLER', token: 't'.repeat(43) };
const station: RelayStation = { id: 'relay_1', state: 'SELECTED', paired: true, proofId: 'proof_1', captureSessionId: null, lastSequence: 1, acknowledgedSequence: 1, expiresAt: '2030-01-01T00:00:00.000Z', commands: [] };
test('pairing URLs and persisted station data reject changed host, route, command order and credentials', () => {
  const link = `https://thepackproof.com/station#relay=relay_1&pair=${'t'.repeat(43)}`;
  assert.deepEqual(parseRelayPairing(link), { id: 'relay_1', token: 't'.repeat(43) });
  assert.deepEqual(parseRelayPairing(link.replace('https://thepackproof.com/', 'packproof-v2://')), { id: 'relay_1', token: 't'.repeat(43) });
  for (const value of [link.replace('thepackproof.com', 'other.test'), link.replace('/station', '/proofs/proof_1'), link.replace('https:', 'http:'), link.replace('https://', 'https://owner:secret@'), link.replace('t'.repeat(43), 'short')]) assert.equal(parseRelayPairing(value), null);
  assert.notEqual(relayStorageKey('https://api.test', 'owner'), relayStorageKey('https://api.test', 'other'));
  assert.notEqual(relayStorageKey('https://api.test', 'owner'), relayStorageKey('https://staging.test', 'owner'));
  assert.equal(readRelayStation(station, 'relay_1').proofId, 'proof_1');
  assert.throws(() => readRelayStation(station, 'relay_2'));
  assert.throws(() => readRelayStation({ ...station, acknowledgedSequence: 2 }));
  assert.throws(() => readRelayStation({ ...station, lastSequence: 3, commands: [{ sequence: 3, type: 'START', idempotencyKey: 'command_3' }] }));
  assert.throws(() => readRelayStation({ ...station, commands: [{ sequence: 2, type: 'START', idempotencyKey: 'command_2' }] }));
  assert.equal(readRelayDevice(JSON.stringify(device))?.role, 'CONTROLLER');
  assert.throws(() => readRelayDevice(JSON.stringify({ ...device, token: 'broken' })));
  assert.throws(() => readRelayDevice(JSON.stringify({ ...device, pendingAck: { sequence: 0 } })));
  assert.throws(() => readRelayDevice(JSON.stringify({ ...device, pendingStart: { sequence: 2, captureSessionId: 'cap_1', proofId: '../../proof' } })));
});
test('uncertain sends retry exact durable command even if a different action is requested', async () => {
  let stored = device; const requests: unknown[] = [];
  const persist = async (value: RelayDevice) => { stored = value; };
  const request = async <T,>(_path: string, _method: string, body: unknown, token: string): Promise<T> => { assert.equal(token, device.token); assert.deepEqual(stored.pendingCommand, body); requests.push(body); if (requests.length === 1) throw new Error('response lost'); return { ...station, lastSequence: 2, command: body } as T; };
  await assert.rejects(sendRelayCommand({ device: stored, station, type: 'START', key: 'operation_1', persist, request }), /response lost/);
  assert.equal(stored.pendingCommand?.idempotencyKey, 'operation_1');
  stored = await sendRelayCommand({ device: stored, station: { ...station, lastSequence: 2 }, type: 'NEXT', proofId: 'another_proof', key: 'replacement_key', persist, request });
  assert.deepEqual(requests[0], requests[1]); assert.equal(stored.pendingCommand, undefined);
});
test('commands require saved intent and camera acknowledgement; next order requires committed capture', async () => {
  let sent = 0;
  const request = async <T,>(): Promise<T> => { sent++; return {} as T; };
  await assert.rejects(sendRelayCommand({ device, station, type: 'START', key: 'operation_1', persist: async () => { throw new Error('storage full'); }, request }), /storage full/);
  const persist = async () => undefined;
  await assert.rejects(sendRelayCommand({ device, station: { ...station, lastSequence: 2 }, type: 'START', key: 'operation_1', persist, request }), /acknowledge/);
  for (const state of ['ISSUED', 'RECORDED', 'UPLOADING']) {
    const saving = { ...station, state: 'SAVING', captureSessionId: 'cap_1', capture: { state } };
    assert.equal(canSelectRelayOrder(saving), false);
    await assert.rejects(sendRelayCommand({ device, station: saving, type: 'NEXT', proofId: 'proof_2', key: 'operation_2', persist, request }), /Finish saving/);
  }
  assert.equal(sent, 0);
  assert.equal(canSelectRelayOrder({ ...station, state: 'SAVING', captureSessionId: 'cap_1', capture: { state: 'COMMITTED' } }), true);
  assert.equal(canSelectRelayOrder({ ...station, paired: false }), false);
});
test('account changes and background transitions discard stale responses even after returning foreground', async () => {
  let signedIn = true, resolve!: (value: string) => void;
  const client = { apiBaseUrl: 'https://api.test', assertCaptureAccount() { if (!signedIn) throw new Error('ACCOUNT_CHANGED'); }, relayRequest: <T,>() => new Promise<T>(done => { resolve = done as (value: string) => void; }) };
  const scope = new RelayScope(client, 'owner'), lease = scope.lease();
  const response = lease.request('/relay_1'); signedIn = false; resolve('private_result'); await assert.rejects(response, /ACCOUNT_CHANGED/);
  signedIn = true; scope.setForeground(false); assert.throws(lease.assert); scope.setForeground(true); assert.throws(lease.assert);
  const fresh = scope.lease(); fresh.assert(); scope.dispose(); assert.throws(fresh.assert);
});
test('remote Stop can affect only the exact registered native session', () => {
  let stopped = 0;
  const release = registerRemoteCaptureStop('cap_original', () => { stopped++; });
  assert.equal(stopRemoteCapture('cap_other'), false); assert.equal(stopped, 0);
  assert.throws(() => registerRemoteCaptureStop('cap_original', () => undefined));
  assert.equal(stopRemoteCapture('cap_original'), true); assert.equal(stopped, 1);
  release(); assert.equal(stopRemoteCapture('cap_original'), false);
});
test('relay HTTP sends account auth and station token; email retains explicitly selected scope and preference', async () => {
  const seen: Array<{ url: string; init?: RequestInit }> = [], original = globalThis.fetch;
  globalThis.fetch = async (url, init) => { seen.push({ url: String(url), init }); return new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } }); };
  try {
    const client = new PackProofV2Client({ baseUrl: 'https://api.test', getToken: () => 'account_token' });
    await client.relayRequest('/relay_1/commands', 'POST', { sequence: 1, type: 'START', idempotencyKey: 'key_1' }, device.token);
    const headers = new Headers(seen[0].init?.headers);
    assert.equal(seen[0].url, 'https://api.test/me/packing-relay/relay_1/commands'); assert.equal(headers.get('Authorization'), 'Bearer account_token'); assert.equal(headers.get('X-PackProof-Station-Token'), device.token);
    await client.emailProof('proof_1', { email: 'recipient@example.test', preference: 'FINAL_ONLY', scope: 'SUMMARY' });
    assert.equal(seen[1].url, 'https://api.test/proofs/proof_1/email-subscriptions'); assert.deepEqual(JSON.parse(String(seen[1].init?.body)), { email: 'recipient@example.test', preference: 'FINAL_ONLY', scope: 'SUMMARY' });
  } finally { globalThis.fetch = original; }
});
test('email UI distinguishes delivered, queued and unknown and validates explicit copy links', () => {
  assert.match(proofEmailDeliveryMessage({ emailDeliveryConfigured: true, delivery: { sent: 1 } }, 'buyer@test'), /emailed/);
  assert.match(proofEmailDeliveryMessage({ emailDeliveryConfigured: true, delivery: { sent: 0 } }, 'buyer@test'), /queued/);
  assert.match(proofEmailDeliveryMessage({ emailDeliveryConfigured: false }, 'buyer@test'), /not configured/);
  assert.match(proofEmailDeliveryMessage({}, 'buyer@test'), /not been confirmed/);
  assert.equal(proofEmailTrackerLink('javascript:alert(1)'), null); assert.equal(proofEmailTrackerLink('https://user:password@thepackproof.com/p/token'), null);
  assert.equal(proofEmailTrackerLink('https://thepackproof.com/p/token'), 'https://thepackproof.com/p/token');
});

test('mismatched acceptance leaves the original pending command available for deliberate retry', async () => {
  let stored = device;
  await assert.rejects(sendRelayCommand({ device, station, type: 'START', key: 'operation_1', persist: async value => { stored = value; }, request: async <T,>() => ({ ...station, id: 'relay_other', command: { sequence: 2, type: 'START', proofId: station.proofId, idempotencyKey: 'operation_1' } }) as T }), /verified/);
  assert.equal(stored.pendingCommand?.idempotencyKey, 'operation_1');
});
