import { test } from 'node:test';
import assert from 'node:assert/strict';
import { proofDetailModel, proofHistoryActor, proofTrackingSource } from '../src/experience/proof-detail-model.ts';
import { presentationForProof } from '../src/copy/proof-list.ts';
import type { LocalCapture } from '../src/capture.ts';
import type { ProofView } from '../src/v2-api.ts';

const proof = (patch: Partial<ProofView> = {}): ProofView => ({
  proofId: 'proof_current', transactionId: 'txn_current', status: 'READY_FOR_EVIDENCE',
  workflowType: 'COMMERCE_SALE', participationPolicy: 'COUNTERPARTY_OPTIONAL',
  createdAt: '2026-10-15', updatedAt: '2026-10-15', finalizedAt: null,
  transaction: { itemTitle: 'Signed baseball', externalReference: 'ORDER-7', transactionDate: null, shipping: null },
  participants: [{ participantId: 'participant-seller', userId: 'seller', role: 'SELLER', status: 'JOINED' }, { participantId: 'participant-buyer', userId: 'buyer', role: 'BUYER', status: 'JOINED' }],
  evidence: [], events: [], ...patch,
} as ProofView);
const recording = (patch: Partial<LocalCapture> = {}): LocalCapture => ({
  uri: 'file:///original.mp4', captureSessionId: 'capture_saved', captureProofId: 'proof_current', captureUserId: 'seller',
  byteSize: 200, durationMs: 1000, localFileAvailable: true,
  recovery: { apiBaseUrl: 'https://api.example', phase: 'LOCAL_ONLY', submitRequested: false }, ...patch,
} as LocalCapture);
const model = (value = proof(), captures: LocalCapture[] = [], overrides: Partial<Parameters<typeof proofDetailModel>[0]> = {}) => proofDetailModel({
  proof: value, userId: 'seller', apiBaseUrl: 'https://api.example', captures, progress: {}, online: true, reconciled: true, ...overrides,
});

test('detail ordinary task uses full current evidence, not a status-only catalog assumption', () => {
  assert.equal(model().action?.buttonLabel, 'Continue capture');
  const supplementary = proof({ status: 'EVIDENCE_COMMITTED', evidence: [{ validationStatus: 'COMMITTED', evidenceType: 'SELLER_EVIDENCE' }] as ProofView['evidence'] });
  assert.equal(model(supplementary).action?.kind, 'continue_proof');
  const packed = proof({ status: 'EVIDENCE_COMMITTED', evidence: [{ validationStatus: 'COMMITTED', evidenceType: 'FULFILLMENT_CAPTURE' }] as ProofView['evidence'] });
  assert.equal(model(packed).action?.kind, 'finalize_proof');
  assert.equal(model(packed).presentation.nextAction.label, model(packed).action?.buttonLabel);
});

test('server presentation restricting contribution stays authoritative in detail', () => {
  const value = proof();
  value.presentation = { ...presentationForProof(value, 'SELLER'), canContribute: false, nextAction: { type: 'VIEW_PROOF', label: 'View Proof' } };
  assert.equal(model(value).action, null);
});

test('saved offscreen original gets one exact review task before ordinary new capture', () => {
  const value = model(proof(), [recording()]);
  assert.equal(value.action?.kind, 'review_evidence');
  assert.equal(value.action?.sessionId, 'capture_saved');
  assert.equal(value.action?.targetId, 'proof_current');
});

test('foreign-account and foreign-server originals never appear in the detail projection', () => {
  for (const capture of [recording({ captureUserId: 'other' }), recording({ recovery: { apiBaseUrl: 'https://other.example', phase: 'LOCAL_ONLY' } as LocalCapture['recovery'] })]) {
    const value = model(proof(), [capture]);
    assert.equal(value.captures.length, 0);
    assert.equal(value.action?.kind, 'continue_proof');
    assert.equal(value.action?.sessionId, undefined);
  }
});

test('buyers and participants no longer joined cannot receive seller recording tasks', () => {
  assert.equal(model(proof(), [], { userId: 'buyer' }).action, null);
  const value = proof({ participants: [{ participantId: 'old', userId: 'seller', role: 'SELLER', status: 'REMOVED' }] as ProofView['participants'] });
  assert.equal(model(value, [recording()]).action, null);
});

test('other-device finalization suppresses stale root capture while authorized receiving remains distinct', () => {
  const finalized = proof({ status: 'FINALIZED', finalizedAt: '2026-10-15' });
  assert.equal(model(finalized, [recording()]).action, null);
  assert.equal(model(finalized).completed, true);
  finalized.presentation = { ...presentationForProof(finalized, 'BUYER'), canContribute: true, nextAction: { type: 'WORKFLOW_ACTION', label: 'Record receipt' } };
  const receipt = model(finalized, [recording()], { userId: 'buyer' });
  assert.equal(receipt.action?.kind, 'continue_proof');
  assert.match(receipt.action?.reason ?? '', /receipt or return/);
  assert.equal(receipt.action?.sessionId, undefined);
});

test('offline detail allows local review but never offers a server-only capture or confirmation', () => {
  assert.equal(model(proof(), [], { online: false, reconciled: false }).action, null);
  const local = model(proof(), [recording()], { online: false, reconciled: false });
  assert.equal(local.action?.kind, 'review_evidence');
  assert.equal(local.action?.sourceFreshness, 'device');
});

test('incomplete or missing original leads to exact recovery task rather than playable review', () => {
  for (const capture of [recording({ localFileAvailable: false }), recording({ recovery: { apiBaseUrl: 'https://api.example', phase: 'RECORDING' } as LocalCapture['recovery'] })]) {
    const value = model(proof(), [capture]);
    assert.equal(value.action?.kind, 'review_upload');
    assert.equal(value.action?.sessionId, 'capture_saved');
  }
});

test('queued and awaiting-server captures stay passive and do not imply finalization', () => {
  for (const phase of ['UPLOAD_QUEUED', 'UPLOADING', 'PRESERVATION_PENDING', 'FINALIZATION_PENDING']) {
    const capture = recording({ recovery: { apiBaseUrl: 'https://api.example', phase, submitRequested: true } as LocalCapture['recovery'] });
    const value = model(proof(), [capture], { progress: { proof_current: 100 } });
    assert.equal(value.action, null);
    assert.equal(value.completed, false);
  }
});

test('unknown or inconsistent server completion stays a refresh task', () => {
  for (const value of [proof({ status: 'UNKNOWN' }), proof({ status: 'FINALIZED', finalizedAt: null })]) {
    assert.equal(model(value).action?.kind, 'reconcile');
    assert.equal(model(value).completed, false);
  }
});

test('history actor labels use authorized identity matches without exposing raw identifiers', () => {
  const value = proof({ events: [{ eventId: 'mine', actorUserId: 'seller' }, { eventId: 'theirs', actorUserId: 'buyer' }, { eventId: 'unknown', actorUserId: 'someone@example.test' }] as ProofView['events'] });
  assert.equal(proofHistoryActor(value, { id: 'mine' }, 'seller'), 'You');
  assert.equal(proofHistoryActor(value, { id: 'theirs' }, 'seller'), 'Buyer');
  assert.equal(proofHistoryActor(value, { id: 'unknown' }, 'seller'), null);
  assert.equal(proofHistoryActor(value, { id: 'missing' }, 'seller'), null);
});

test('tracking source only claims the exact client-reported observation, never imported or manually inferred provenance', () => {
  const value = proof({ captureShipping: { source: 'PACKPROOF_CAPTURE', observations: [{ trackingNumber: 'TRACK-1' }] } as ProofView['captureShipping'] });
  assert.match(proofTrackingSource(value, 'TRACK-1')!, /not independently verified/);
  assert.match(proofTrackingSource(value, 'TRACK-2')!, /source not recorded/);
  assert.equal(proofTrackingSource(value, null), null);
});
