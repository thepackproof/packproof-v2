import { test } from 'node:test';
import assert from 'node:assert/strict';
import { originalAvailabilityCopy, operationTransportPercent, submissionPresentation } from '../src/experience/signal/submission-presentation';
const base = { offline: false, originalAvailable: true, percent: 37 };

test('queued and unsubmitted operations never manufacture active transfer progress', () => {
  const queued = submissionPresentation({ ...base, phase: 'UPLOAD_QUEUED' });
  assert.equal(queued.stage, 'queued'); assert.equal(queued.percent, null); assert.equal(queued.action, 'none');
  const local = submissionPresentation({ ...base, phase: 'LOCAL_ONLY' });
  assert.equal(local.stage, 'local'); assert.equal(local.percent, null); assert.equal(local.action, 'review');
});
test('100 percent transport remains distinct from canonical receipt confirmation', () => {
  const uploading = submissionPresentation({ ...base, phase: 'UPLOADING', percent: 100 });
  assert.equal(uploading.stage, 'uploading'); assert.equal(uploading.percent, 100);
  const received = submissionPresentation({ ...base, phase: 'PRESERVATION_PENDING', percent: 100 });
  assert.equal(received.stage, 'confirming'); assert.equal(received.percent, null);
  assert.notEqual(received.headline, 'Proof saved');
});
test('confirmation, expired sign-in and discard retain useful exact-operation actions', () => {
  assert.equal(submissionPresentation({ ...base, phase: 'CONFIRMATION_NEEDED' }).action, 'review');
  assert.equal(submissionPresentation({ ...base, phase: 'NEEDS_SIGN_IN' }).action, 'sign-in');
  assert.equal(submissionPresentation({ ...base, phase: 'DISCARD_PENDING' }).action, 'recovery');
  const offline = submissionPresentation({ ...base, phase: 'UPLOADING', offline: true });
  assert.equal(offline.stage, 'paused'); assert.equal(offline.percent, null);
});
test('missing, present and unknown local originals have distinct truthful copy', () => {
  assert.match(originalAvailabilityCopy(true), /is available/);
  assert.match(originalAvailabilityCopy(false), /not available/);
  assert.match(originalAvailabilityCopy(undefined), /has not been confirmed/);
  const unknown = submissionPresentation({ ...base, phase: 'NEEDS_ATTENTION', originalAvailable: undefined });
  assert.equal(unknown.originalLabel, 'Local original not checked');
  assert.doesNotMatch(unknown.originalDetail, /is retained|is available/);
  const missing = submissionPresentation({ ...base, phase: 'NEEDS_ATTENTION', originalAvailable: false });
  assert.equal(missing.originalLabel, 'Original unavailable on this device');
});

test('Proof-key transport progress cannot be borrowed by a foreign or ambiguous operation', () => {
  const identity = { userId: 'owner', apiBaseUrl: 'https://api.example.test', proofId: 'proof-a', operationId: 'operation-a' };
  const make = (changes: Record<string, unknown> = {}) => ({
    captureUserId: identity.userId, captureProofId: identity.proofId,
    recovery: { ...identity, phase: 'UPLOADING', ...changes },
  }) as unknown as Parameters<typeof operationTransportPercent>[0]['captures'][number];
  assert.equal(operationTransportPercent({ identity, captures: [make()], percent: 43 }), 43);
  assert.equal(operationTransportPercent({ identity, captures: [make({ phase: 'UPLOAD_QUEUED' })], percent: 43 }), null);
  assert.equal(operationTransportPercent({ identity, captures: [make({ userId: 'other-owner' })], percent: 43 }), null);
  assert.equal(operationTransportPercent({ identity, captures: [make({ apiBaseUrl: 'https://other.example.test' })], percent: 43 }), null);
  assert.equal(operationTransportPercent({ identity, captures: [make(), make({ operationId: 'operation-b' })], percent: 43 }), null);
  assert.equal(operationTransportPercent({ identity, captures: [make(), make()], percent: 43 }), 43);
});
