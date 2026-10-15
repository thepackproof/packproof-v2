import { test } from 'node:test';
import assert from 'node:assert/strict';
import { proofDisplayTitle, resolveProofDisplayTitle } from '../src/copy/proof-title.ts';

test('provided transaction title wins over order reference without altering the source', () => {
  const proof = { proofId: 'proof_abcdefgh', transaction: { itemTitle: '  Signed\nbaseball  ', externalReference: 'ORD-7' } };
  assert.deepEqual(resolveProofDisplayTitle(proof), { title: 'Signed baseball', source: 'transaction-title' });
  assert.equal(proof.transaction.itemTitle, '  Signed\nbaseball  ');
});

test('email-like provided titles are preserved when individual field provenance is unknown', () => {
  const proof = { transaction: { itemTitle: 'seller@example.test', externalReference: 'ORD-7' } };
  assert.equal(proofDisplayTitle(proof), 'seller@example.test');
  assert.equal(resolveProofDisplayTitle(proof).source, 'transaction-title');
});

test('missing title uses an order reference and then a short Proof reference', () => {
  assert.equal(proofDisplayTitle({ transaction: { itemTitle: ' ', externalReference: '  ORD-7 ' } }), 'Order ORD-7');
  assert.equal(proofDisplayTitle({ proofId: 'proof_abcdefgh', transaction: { itemTitle: null } }), 'Shipment Proof · PP · ABCDEFGH');
  assert.equal(proofDisplayTitle({ transaction: {} }), 'Shipment Proof');
});

test('participant identity and an email-like order reference never become fallback titles', () => {
  const proof = { proofId: 'proof_abcdefgh', transaction: { itemTitle: null, externalReference: 'buyer@example.test' }, participants: [{ email: 'buyer@example.test' }], buyerEmail: 'buyer@example.test' };
  assert.equal(proofDisplayTitle(proof), 'Shipment Proof · PP · ABCDEFGH');
  assert.equal(resolveProofDisplayTitle(proof).source, 'untitled');
});
