import { test } from 'node:test';
import assert from 'node:assert/strict';
import { approvedRecordingDevices, handoffPreferenceKey, parseHandoffTarget, reviewedHandoffSnapshot, sendReviewedHandoff, type SentHandoff } from '../src/intake/handoff-sender';
import type { IntakeOrder, IntakeSnapshot } from '../src/intake/model';

const snapshot: IntakeSnapshot = { id: 'snapshot_1', version: 1, digest: 'a'.repeat(64), proofId: 'proof_1', transactionId: 'txn_1', items: [{ title: 'Reviewed item', quantity: 2 }], store: 'Store', orderReference: 'Order 1', sourceKind: 'MARKETPLACE_API' };
function fixture() {
  const keys = new Map<string, string>(), requests: Array<{ snapshotId: string; targetDeviceId: string; idempotencyKey: string }> = [];
  let next = 0, current = true;
  const result: SentHandoff = { id: 'handoff_1', targetDeviceId: 'intake_device_other', proofId: snapshot.proofId, transactionId: snapshot.transactionId, snapshotId: snapshot.id, snapshotSha256: snapshot.digest, state: 'PENDING' };
  const deps = {
    assertAccount() { if (!current) throw new Error('ACCOUNT_CHANGED'); },
    async readKey(sourceId: string) { let key = keys.get(sourceId); if (!key) { key = `operation_${++next}`; keys.set(sourceId, key); } return key; },
    async clearKey(sourceId: string) { keys.delete(sourceId); },
    async send(input: { snapshotId: string; targetDeviceId: string; idempotencyKey: string }) { requests.push(input); return { handoff: { ...result } }; },
  };
  return { deps, keys, requests, result, switchAccount: () => { current = false; } };
}
test('default recording device preferences are scoped by API and account and contain no device token', () => {
  assert.equal(handoffPreferenceKey('https://api.test/', 'owner'), handoffPreferenceKey('https://api.test', 'owner'));
  assert.notEqual(handoffPreferenceKey('https://api.test', 'owner'), handoffPreferenceKey('https://api.test', 'other'));
  assert.notEqual(handoffPreferenceKey('https://api.test', 'owner'), handoffPreferenceKey('https://staging.test', 'owner'));
  assert.equal(parseHandoffTarget('intake_device_other'), 'intake_device_other');
  for (const value of [null, '', '{"deviceToken":"secret"}', 'https://other.test/device']) assert.equal(parseHandoffTarget(value), null);
});
test('only approved other devices are offered and prepared order must match the exact displayed Proof', () => {
  assert.deepEqual(approvedRecordingDevices([{ id: 'local', name: 'This device', state: 'APPROVED' }, { id: 'other', name: 'Other', state: 'APPROVED' }, { id: 'pending', name: 'Pending', state: 'AWAITING_APPROVAL' }, { id: 'revoked', name: 'Old', state: 'REVOKED' }], 'local').map(row => row.id), ['other']);
  const order: IntakeOrder = { observationId: 'obs_1', readiness: 'READY', reasons: [], transactionId: snapshot.transactionId, proofId: snapshot.proofId, snapshot };
  assert.equal(reviewedHandoffSnapshot(order, 'proof_1', 'txn_1'), snapshot);
  assert.throws(() => reviewedHandoffSnapshot({ ...order, readiness: 'NEEDS_INFORMATION' }, 'proof_1', 'txn_1'), /complete purchased-item/);
  assert.throws(() => reviewedHandoffSnapshot({ ...order, snapshot: { ...snapshot, proofId: 'proof_2' } }, 'proof_1', 'txn_1'), /differs/);
  assert.throws(() => reviewedHandoffSnapshot(order, 'proof_1', 'txn_other'), /differs/);
});
test('lost sender response reuses the persisted operation, snapshot and target after retry', async () => {
  const f = fixture(), original = f.deps.send;
  f.deps.send = async value => { await original(value); throw new Error('network response lost'); };
  await assert.rejects(sendReviewedHandoff({ snapshot, targetDeviceId: 'intake_device_other' }, f.deps), /lost/);
  f.deps.send = original;
  await sendReviewedHandoff({ snapshot, targetDeviceId: 'intake_device_other' }, f.deps);
  assert.deepEqual(f.requests[0], f.requests[1]);
  assert.equal(f.keys.size, 1);
});
test('only an authoritative expired handoff renews the operation once; claimed and revoked prompts do not', async () => {
  const f = fixture(), original = f.deps.send;
  f.deps.send = async value => { const result = await original(value); return { handoff: { ...result.handoff, state: f.requests.length === 1 ? 'EXPIRED' : 'PENDING' } }; };
  assert.equal((await sendReviewedHandoff({ snapshot, targetDeviceId: 'intake_device_other' }, f.deps)).state, 'PENDING');
  assert.equal(f.requests.length, 2); assert.notEqual(f.requests[0].idempotencyKey, f.requests[1].idempotencyKey);
  assert.equal(f.requests[0].snapshotId, f.requests[1].snapshotId);
  const claimed = fixture(); claimed.result.state = 'CLAIMED';
  assert.equal((await sendReviewedHandoff({ snapshot, targetDeviceId: 'intake_device_other' }, claimed.deps)).state, 'CLAIMED');
  assert.equal(claimed.requests.length, 1);
  const revoked = fixture(); revoked.result.state = 'REVOKED';
  await assert.rejects(sendReviewedHandoff({ snapshot, targetDeviceId: 'intake_device_other' }, revoked.deps), /disconnected/);
  assert.equal(revoked.requests.length, 1);
});
test('account changes before transport stop sends and mismatched responses cannot claim success', async () => {
  const f = fixture(), read = f.deps.readKey;
  f.deps.readKey = async id => { const result = await read(id); f.switchAccount(); return result; };
  await assert.rejects(sendReviewedHandoff({ snapshot, targetDeviceId: 'intake_device_other' }, f.deps), /ACCOUNT_CHANGED/);
  assert.equal(f.requests.length, 0);
  for (const change of [{ proofId: 'other' }, { transactionId: 'other' }, { snapshotSha256: 'b'.repeat(64) }, { targetDeviceId: 'other' }]) {
    const mismatched = fixture(); Object.assign(mismatched.result, change);
    await assert.rejects(sendReviewedHandoff({ snapshot, targetDeviceId: 'intake_device_other' }, mismatched.deps), /does not match/);
  }
});
