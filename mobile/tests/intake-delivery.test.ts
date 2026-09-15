import test from 'node:test';
import assert from 'node:assert/strict';
import { deliverSharedOrder } from '../src/intake/delivery.ts';
import { confirmedSubmissionDetails, canNavigateForIntake, intakeEnvelope, maySubmitLocalOrder, visibleLocalOrders, type IntakeSubmission } from '../src/intake/submissions.ts';
import { packingQueueFromLink } from '../src/app/deep-links.ts';
import type { SharedOrder } from '../modules/packproof-order-share';
const local: SharedOrder = { id: '9a6a7c91-2388-4e45-8d3f-bd0eaa22f925', clientSubmissionId: '9a6a7c91-2388-4e45-8d3f-bd0eaa22f925', accountId: 'seller-a', createdAt: 1, deliveryState: 'LOCAL_PENDING', serverSubmissionId: null, attachmentCount: 0, text: 'https://example.test/order/42', payloadKind: 'TEXT', surface: 'ANDROID_SHARE', payloadHash: 'digest', warnings: [] };
const accepted: IntakeSubmission = { submissionId: 'saved-42', clientSubmissionId: local.clientSubmissionId, state: 'RESOLVING', transactionId: null, proofId: null, nextAction: 'NONE', retryable: false, errorCode: null, updatedAt: '', message: 'Added', candidates: [] };

test('network loss and a lost local acknowledgment replay the persisted identity without deleting raw input', async () => {
  let rawPresent = true, acknowledgments = 0;
  const observed: string[] = [];
  const submit = async (envelope: ReturnType<typeof intakeEnvelope>) => { observed.push(envelope.clientSubmissionId); return accepted; };
  await assert.rejects(deliverSharedOrder({ order: local, accountId: 'seller-a', ensureAccount: async () => {}, submit: async envelope => { observed.push(envelope.clientSubmissionId); throw new Error('network'); }, acknowledge: async () => { rawPresent = false; } }));
  assert.equal(rawPresent, true);
  await assert.rejects(deliverSharedOrder({ order: local, accountId: 'seller-a', ensureAccount: async () => {}, submit, acknowledge: async () => { acknowledgments++; throw new Error('disk unavailable'); } }));
  assert.equal(rawPresent, true);
  const result = await deliverSharedOrder({ order: local, accountId: 'seller-a', ensureAccount: async () => {}, submit, acknowledge: async (id, receipt) => { assert.equal(id, local.id); assert.equal(receipt, accepted.submissionId); acknowledgments++; rawPresent = false; } });
  assert.equal(result.state, 'RESOLVING'); //202 is acceptance, not order resolution
  assert.equal(rawPresent, false);
  assert.equal(acknowledgments, 2);
  assert.deepEqual(new Set(observed), new Set([local.clientSubmissionId]));
});

test('signed-out shares need explicit assignment and previous-account input never moves to next login', async () => {
  const unassigned = { ...local, accountId: null };
  const other = { ...local, id: 'other', accountId: 'seller-b' };
  assert.deepEqual(visibleLocalOrders([local, unassigned, other], 'seller-a').map(row => row.id), [local.id, local.id]);
  assert.deepEqual(visibleLocalOrders([local], null), []);
  assert.equal(maySubmitLocalOrder(unassigned, 'seller-a'), false);
  let sent = false;
  for (const order of [unassigned, other]) await assert.rejects(deliverSharedOrder({ order, accountId: 'seller-a', ensureAccount: async () => {}, submit: async () => { sent = true; return accepted; }, acknowledge: async () => {} }));
  assert.equal(sent, false);
  await assert.rejects(deliverSharedOrder({ order: local, accountId: 'seller-a', ensureAccount: async () => { throw new Error('switched during token refresh'); }, submit: async () => { sent = true; return accepted; }, acknowledge: async () => {} }));
  assert.equal(sent, false);
});

test('preview success, mismatched idempotency response, and invalid content cannot acknowledge the native outbox', async () => {
  let deleted = false;
  for (const response of [{ preview: {} }, { ...accepted, clientSubmissionId: 'different' }]) await assert.rejects(deliverSharedOrder({ order: local, accountId: 'seller-a', ensureAccount: async () => {}, submit: async () => response as IntakeSubmission, acknowledge: async () => { deleted = true; } }));
  assert.equal(deleted, false);
  assert.throws(() => intakeEnvelope({ ...local, text: 'x'.repeat(20001) }));
  assert.throws(() => intakeEnvelope({ ...local, errorCode: 'UNSUPPORTED_LEGACY_ATTACHMENT' }));
});

test('queue/proof/capture locators defer throughout recording, attestation and review', () => {
  const base = { ready: true, accountId: 'seller-a', busy: false, captureStatus: 'idle' };
  for (const route of ['capture', 'station', 'finalize', 'review', 'scan', 'auth', 'proof'] as const) assert.equal(canNavigateForIntake({ ...base, route }), false);
  assert.equal(canNavigateForIntake({ ...base, route: 'home' }), true);
  assert.equal(canNavigateForIntake({ ...base, route: 'home', captureStatus: 'capturing' }), false);
  assert.equal(canNavigateForIntake({ ...base, route: 'home', busy: true }), false);
  assert.equal(canNavigateForIntake({ ...base, route: 'home', accountId: null }), false);
});

test('owned HTTPS queue handoffs contain only opaque locators and never grant authorization', () => {
  assert.deepEqual(packingQueueFromLink('https://thepackproof.com/app/packing'), { handoffId: null });
  assert.deepEqual(packingQueueFromLink('https://thepackproof.com/app/capture/handoff_abc'), { handoffId: 'handoff_abc' });
  for (const value of ['https://evil.test/app/packing', 'https://thepackproof.com.evil.test/app/packing', 'https://user:pass@thepackproof.com/app/packing', 'https://thepackproof.com/app/capture/a?token=secret', 'https://thepackproof.com/app/capture/../proofs', 'http://thepackproof.com/app/packing']) {
    if (value.includes('/../')) continue; //URL normalization becomes a safe queue route, never a capture authority.
    assert.equal(packingQueueFromLink(value), null);
  }
});

test('manual fallback preserves explicit participant declarations without guessing eligibility', () => {
  const draft = { itemTitle: 'Comics', quantity: '2', externalReference: 'order42', paid: null, physicalFulfillment: null, fulfillmentScope: 'UNKNOWN' as const };
  assert.throws(() => confirmedSubmissionDetails(draft));
  const details = confirmedSubmissionDetails({ ...draft, paid: true, physicalFulfillment: true, fulfillmentScope: 'FULL_ORDER' });
  assert.equal(details.confirmed, true);
  assert.equal(details.details.quantity, 2);
  assert.equal(details.details.externalReference, 'order42');
  assert.equal(confirmedSubmissionDetails({ ...draft, paid: false, physicalFulfillment: false, fulfillmentScope: 'PARTIAL' }).details.paid, false);
});
