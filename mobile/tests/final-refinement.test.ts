import { test } from 'node:test';
import assert from 'node:assert/strict';
import { freshProofDestination, openFreshProofAction } from '../src/experience/action-routing.ts';
import { proofTaskCopy } from '../src/experience/home-adapter.ts';
import { humanChronologyTitle } from '../src/copy/chronology.ts';
import { proofHistoryActor } from '../src/experience/proof-detail-model.ts';
import type { ProofView } from '../src/v2-api.ts';
const proof = (patch: Partial<ProofView> = {}) => ({ proofId: 'proof_B', status: 'FINALIZED', finalizedAt: '2026-10-16', workflowType: 'COMMERCE_SALE', participants: [{ userId: 'seller', role: 'SELLER', status: 'JOINED' }], evidence: [], ...patch }) as ProofView;

test('F1.01 opening a finalized root record is ordinary read-only navigation', () => {
  assert.deepEqual(freshProofDestination(proof(), 'seller'), { route: 'proof' });
});
test('F1.02 workflow supporting copy comes from the same server requirement', () => {
  assert.deepEqual(proofTaskCopy('WORKFLOW_ACTION', 'Document item 1 of 1', 'Capture the front and back of this item.'), {
    buttonLabel: 'Document item 1 of 1', reason: 'Capture the front and back of this item.',
  });
});
test('F1.08 generic participant events never invent a buyer role', () => {
  assert.equal(humanChronologyTitle('PARTICIPANT_JOINED', 'Participant joined'), 'Participant joined');
  assert.equal(humanChronologyTitle('PARTICIPANT_INVITED', 'Participant invited'), 'Participant invited');
});
test('F1.08 a historical actor role survives later participant changes', () => {
  const p = proof({ events: [{ eventId: 'event_seller', eventType: 'PARTICIPANT_JOINED', actorUserId: 'seller', at: '2026-10-16', data: { role: 'SELLER', userId: 'seller' } }], participants: [] });
  assert.equal(proofHistoryActor(p, { id: 'event_seller' }, 'viewer'), 'Seller');
});
test('F1.04 a mismatched server record cannot be substituted into a tapped Proof', async () => {
  const routes: string[] = [];
  await assert.rejects(openFreshProofAction('proof_A', {
    userId: 'seller', assertCurrentAccount() {}, refreshProof: async () => proof(),
    navigate: route => routes.push(route), openReceipt: id => routes.push(id), notice: text => routes.push(text),
  }), /requested Proof/);
  assert.deepEqual(routes, []);
});

import { proofListDetail } from '../src/experience/home-adapter.ts';
import { proofHistoryTitle } from '../src/experience/proof-detail-model.ts';
import { createProofRequestGate, loadProofSnapshot, SupersededProofRequest } from '../src/experience/proof-request.ts';
import { notificationProofId } from '../src/notifications/destination.ts';

test('F1.02 lists render a repeated task only once and preserve distinct upload states', () => {
  assert.equal(proofListDetail('Document item 1 of 1', 'Document item 1 of 1'), 'Document item 1 of 1');
  assert.equal(proofListDetail('Waiting to upload', 'View Proof'), 'Waiting to upload · View Proof');
  assert.equal(proofTaskCopy('WORKFLOW_ACTION', 'Document item 2 of 3').reason, 'Capture the front and back of this item.');
  assert.equal(proofTaskCopy('WORKFLOW_ACTION', 'New server requirement').buttonLabel, 'New server requirement');
});
test('F1.08 event role belongs to the historic event, not its viewer or a related entity', () => {
  const p = proof({ events: [{ eventId: 'seller_join', eventType: 'PARTICIPANT_JOINED', actorUserId: 'seller', at: '2026-10-16', data: { role: 'SELLER', userId: 'seller' } }] });
  assert.equal(proofHistoryTitle(p, { id: 'seller_join', eventType: 'PARTICIPANT_JOINED', title: 'Participant joined' }), 'Seller joined');
  assert.equal(proofHistoryActor(p, { id: 'seller_join' }, 'seller'), 'You');
  assert.equal(proofHistoryActor(p, { id: 'unrelated', relatedEntityId: 'seller_join' }, 'seller'), null);
  assert.equal(proofHistoryTitle(p, { id: 'unknown', eventType: 'PARTICIPANT_JOINED', title: 'Participant joined' }), 'Participant joined');
});
test('F1.04 removed membership cannot start capture even if server presentation is stale', () => {
  const p = proof({ status: 'READY_FOR_EVIDENCE', finalizedAt: null, participants: [{ userId: 'seller', role: 'SELLER', status: 'REMOVED' }] as ProofView['participants'] });
  assert.equal(freshProofDestination(p, 'seller').route, 'proof');
});
const defer = <T>() => { let resolve!: (value: T) => void; const promise = new Promise<T>(r => { resolve = r; }); return { promise, resolve }; };
test('F1.04 delayed Proof A cannot replace B, including after its secondary reads start', async () => {
  const gate = createProofRequestGate();
  const transactionA = defer<any>();
  const enteredA = defer<void>();
  const published: string[] = [];
  const ports = {
    getProof: async (id: string) => proof({ proofId: id, transactionId: `txn_${id}` }),
    getTransaction: async (id: string) => { if (id === 'txn_proof_A') { enteredA.resolve(); return transactionA.promise; } return { transactionId: id } as any; },
    getManifest: async (id: string) => ({ proofId: id }) as any,
    getShipmentIntegrity: async () => ({}) as any,
  };
  const first = loadProofSnapshot('proof_A', ports, gate.begin()).then(snapshot => published.push(snapshot.proof.proofId));
  const rejection = assert.rejects(first, SupersededProofRequest);
  await enteredA.promise;
  const second = await loadProofSnapshot('proof_B', ports, gate.begin());
  published.push(second.proof.proofId);
  transactionA.resolve({ transactionId: 'txn_proof_A' });
  await rejection;
  assert.deepEqual(published, ['proof_B']);
});
test('F1.04 changing tabs invalidates a pending Proof request', async () => {
  const gate = createProofRequestGate();
  const check = gate.begin();
  gate.invalidate();
  assert.throws(check, SupersededProofRequest);
});
test('F1.04 mixed transaction and manifest identities cannot be published', async () => {
  for (const mismatched of ['transaction', 'manifest']) {
    await assert.rejects(loadProofSnapshot('proof_B', {
      getProof: async () => proof({ transactionId: 'txn_B' }),
      getTransaction: async () => ({ transactionId: mismatched === 'transaction' ? 'txn_A' : 'txn_B' }) as any,
      getManifest: async () => ({ proofId: mismatched === 'manifest' ? 'proof_A' : 'proof_B' }) as any,
      getShipmentIntegrity: async () => ({}) as any,
    }, () => {}), /requested Proof/);
  }
});
test('F1.07 notifications require exact Proof and account identities', () => {
  assert.equal(notificationProofId({ proofId: 'proof_B', userId: 'seller' }, 'seller'), 'proof_B');
  for (const data of [{ proofId: 'proof_B', userId: 'other' }, { proofId: '', userId: 'seller' }, { proofId: 'proof_A/../proof_B', userId: 'seller' }, { userId: 'seller' }, null]) {
    assert.equal(notificationProofId(data, 'seller'), null);
  }
});
