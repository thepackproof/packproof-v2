import { test } from 'node:test';
import assert from 'node:assert/strict';
import { gradingCreationKey, gradingCreationRequest, parseGradingCreation, type GradingCreation } from '../src/experience/grading-creation';
const operation: GradingCreation = { schema: 1, userId: 'seller', apiBaseUrl: 'https://api.example', key: 'original-request-key', itemCount: 2, itemTitle: 'Two cards' };
test('a restored grading request keeps its transaction identity and exact submitted details', () => {
  const restored = parseGradingCreation(JSON.stringify(operation), operation.apiBaseUrl + '/', operation.userId)!;
  assert.deepEqual(gradingCreationRequest(restored), { workflowType: 'GRADING_SUBMISSION', itemCount: 2, transaction: { itemTitle: 'Two cards', quantity: 2, idempotencyKey: operation.key } });
  assert.equal(gradingCreationKey(operation.apiBaseUrl, 'seller'), gradingCreationKey(operation.apiBaseUrl + '/', 'seller'));
  assert.notEqual(gradingCreationKey(operation.apiBaseUrl, 'seller'), gradingCreationKey(operation.apiBaseUrl, 'buyer'));
});
test('invalid or foreign creation journals cannot silently create another Proof', () => {
  assert.equal(parseGradingCreation(null, operation.apiBaseUrl, operation.userId), null);
  for (const change of [{ userId: 'buyer' }, { apiBaseUrl: 'https://other.example' }, { key: '' }, { itemCount: 0 }, { itemCount: 21 }, { itemCount: 1.5 }, { itemTitle: '' }, { schema: 2 }])
    assert.throws(() => parseGradingCreation(JSON.stringify({ ...operation, ...change }), operation.apiBaseUrl, operation.userId));
});
