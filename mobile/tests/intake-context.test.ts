import test from 'node:test';
import assert from 'node:assert/strict';
import { assertIntakeAcceptance, canPollHandoffs, handoffPollDelay, intakeItemLabel, mergeHandoffs, type IntakeAcceptance, type IntakeHandoff } from '../src/intake/model.ts';

const acceptance: IntakeAcceptance = { proofId: 'p1', transactionId: 't1', session: { id: 'c1', proofId: 'p1', state: 'ISSUED', policyVersion: 'v1', expiresAt: '2026-09-08T12:10:00Z', recoverUntil: '2026-09-09T12:00:00Z' }, orderSnapshot: { id: 's1', proofId: 'p1', transactionId: 't1', version: 1, digest: 'abc', store: 'Store A', orderReference: '100', sourceKind: 'FORWARDED_EMAIL', items: [{ title: 'Cards', quantity: 2, variant: 'Blue' }] } };
test('capture accepts only one exact proof, transaction and snapshot context', () => {
  assert.doesNotThrow(() => assertIntakeAcceptance(acceptance));
  assert.throws(() => assertIntakeAcceptance({ ...acceptance, proofId: 'another-proof' }));
  assert.throws(() => assertIntakeAcceptance({ ...acceptance, transactionId: 'another-order' }));
  assert.throws(() => assertIntakeAcceptance({ ...acceptance, orderSnapshot: { ...acceptance.orderSnapshot, id: '' } }));
});
test('new handoffs queue without replacing a card under the seller’s finger', () => {
  const now = Date.parse('2026-09-08T12:00:00Z');
  const first: IntakeHandoff = { id: 'h1', snapshotId: 's1', sequence: 1, state: 'PENDING', expiresAt: '2026-09-08T12:10:00Z', orderSnapshot: acceptance.orderSnapshot };
  const second = { ...first, id: 'h2', sequence: 2 };
  assert.deepEqual(mergeHandoffs([first], [second, { ...first, orderSnapshot: { ...first.orderSnapshot, store: 'unexpected replacement' } }], now), [first, second]);
  assert.deepEqual(mergeHandoffs([first], [first], now + 11 * 60_000), []);
});
test('handoff polling stops for recording, background, another screen, no pair, or inactivity; failures back off', () => {
  const idle = { foreground: true, readyScreen: true, busy: false, paired: true, lastActivityAt: 0, now: 2_000 };
  assert.equal(canPollHandoffs(idle), true);
  for (const change of [{ foreground: false }, { readyScreen: false }, { busy: true }, { paired: false }, { now: 300_000 }]) assert.equal(canPollHandoffs({ ...idle, ...change }), false);
  assert.equal(handoffPollDelay(0), 2_000);
  assert.equal(handoffPollDelay(1), 4_000);
  assert.equal(handoffPollDelay(20), 30_000);
});
test('item presentation retains explicit variants and quantities without inventing missing values', () => {
  assert.equal(intakeItemLabel({ title: 'Cards', variant: 'Blue', quantity: 2 }), 'Cards · Blue · Quantity 2');
  assert.equal(intakeItemLabel({ title: null, quantity: null }), 'Item description missing · Quantity missing');
});
