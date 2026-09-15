import test from 'node:test';
import assert from 'node:assert/strict';
import { buildIntakeResolution, resolutionDraft, type IntakeObservationDetail } from '../src/intake/resolution.ts';

const source: IntakeObservationDetail = { observationId: 'o1', items: [{ title: 'Card', quantity: null, variant: 'Blue' }], physicalFulfillment: null, paid: null, fulfillmentScope: 'PARTIAL', orderReference: '100', reasonCodes: ['ITEM_DESCRIPTION_AND_QUANTITY_REQUIRED'] };
test('resolution preserves unknown facts and partial fulfillment instead of defaulting to an eligible order', () => {
  const draft = resolutionDraft(source);
  assert.equal(draft.items[0].quantity, '');
  assert.equal(draft.paid, 'unknown');
  draft.items[0].quantity = '2'; draft.reason = 'The receipt lists two blue cards.';
  const correction = buildIntakeResolution(draft, 'receipt1');
  assert.equal(correction.items[0].quantity, 2);
  assert.equal(correction.items[0].variant, 'Blue');
  assert.equal(correction.fulfillmentScope, 'PARTIAL');
  assert.equal('paid' in correction, false);
  assert.equal('physicalFulfillment' in correction, false);
});
test('seller corrections require precise quantities, item descriptions, and an attributed explanation', () => {
  const draft = resolutionDraft(source); draft.reason = 'Checked the original order.';
  for (const quantity of ['', '0', '-1', '1.5', '2abc', '9007199254740992']) { draft.items[0].quantity = quantity; assert.throws(() => buildIntakeResolution(draft, 'receipt1')); }
  draft.items[0].quantity = '2'; draft.reason = ''; assert.throws(() => buildIntakeResolution(draft, 'receipt1'));
  draft.reason = 'Checked the original order.'; draft.items[0].title = ''; assert.throws(() => buildIntakeResolution(draft, 'receipt1'));
});
