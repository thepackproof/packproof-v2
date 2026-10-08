import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pendingWorkspaceRecordings, readyWorkspaceOrders, recentWorkspaceProofs, workspaceProofRows } from '../src/copy/workspace-summary.ts';
import type { LocalCapture } from '../src/capture';
import type { CapturePhase } from '../src/capture/recovery-model';
import type { FulfillmentQueueItem, ProofCollectionItem, InvitationInboxView } from '../src/v2-api';

const proof = (overrides: Partial<ProofCollectionItem> = {}): ProofCollectionItem => ({
  proofId:'proof-a', transactionId:'txn-a', role:'SELLER', status:'READY_FOR_EVIDENCE',
  createdAt:'2026-09-01T12:00:00Z', updatedAt:'2026-09-08T12:00:00Z', finalizedAt:null,
  transaction:{itemTitle:'Shipment A',externalReference:'ORDER-A',transactionDate:null,carrier:null,trackingNumber:null}, ...overrides,
});
const recording = (uri: string, phase: CapturePhase): LocalCapture => ({
  uri, contentType:'video/mp4', byteSize:100, durationMs:1000, captureProofId:'proof-a',
  recovery:{version:1,operationId:uri,apiBaseUrl:'https://api.test',userId:'seller',proofId:'proof-a',phase,evidenceIdempotencyKey:uri,submitRequested:true,needsSellerAttestation:true,attempt:0,nextRetryAt:null,updatedAt:'2026-09-08T12:00:00Z'},
});
const order = (id: string, workflowState = 'READY_TO_PACK'): FulfillmentQueueItem => ({
  proofId:id,transactionId:`txn-${id}`,providerDisplay:'Shopify',externalOrderId:id,externalReference:id,itemSummary:'Shipment',itemCount:1,
  proofStatus:'READY_FOR_EVIDENCE',participationPolicy:'COUNTERPARTY_OPTIONAL',evidenceCount:0,pendingEvidenceCount:0,canComplete:false,workflowState,
});

test('dashboard pending recordings deduplicate the active original and keep submitted work pending', () => {
  const local = recording('file:///original.mp4', 'LOCAL_ONLY');
  assert.equal(pendingWorkspaceRecordings([local, recording('file:///submitted.mp4','SUBMITTED'), recording('file:///complete.mp4','FINALIZED')], local), 2);
  assert.equal(pendingWorkspaceRecordings([], null), 0);
});

test('dashboard classifications preserve invitation and receiver routes while exposing real local upload state', () => {
  const invitation: InvitationInboxView = {invitationId:'invite-b',proofId:'proof-b',status:'PENDING',createdAt:'2026-09-10T12:00:00Z',expiresAt:null,inviter:{userId:'seller',username:'seller',displayName:'Seller'},transaction:{transactionId:'txn-b',itemTitle:'Invited shipment',externalReference:'ORDER-B'}};
  const rows = workspaceProofRows({proofs:[proof(),proof({proofId:'receiver',accessKind:'RECEIVER',role:'BUYER'})],invitations:[invitation],recordings:[recording('file:///active.mp4','UPLOADING')],localCapture:null,captureStatus:'idle',uploadProgressByProof:{'proof-a':40}});
  assert.equal(rows.find(row => row.proofId === 'proof-a')?.presentation.displayStatus, 'Uploading · 40%');
  assert.equal(rows.find(row => row.proofId === 'proof-a')?.presentation.needsAttention, false);
  assert.equal(rows.find(row => row.proofId === 'proof-b')?.invitationId, 'invite-b');
  assert.equal(rows.find(row => row.proofId === 'proof-b')?.presentation.nextAction.type, 'ACCEPT_INVITATION');
  assert.equal(rows.find(row => row.proofId === 'receiver')?.accessKind, 'RECEIVER');
  assert.equal(recentWorkspaceProofs(rows, 1)[0].proofId, 'proof-b');
});

test('ready-to-fulfill count excludes in-progress, removed and finalized records even when queue data is stale', () => {
  const queue = [order('new'),order('new'),order('started','IN_PROGRESS'),order('removed','REMOVED_FROM_FULFILLMENT'),order('finalized')];
  const proofs = [proof({proofId:'finalized',status:'FINALIZED'})];
  assert.deepEqual(readyWorkspaceOrders(queue,proofs).map(row => row.proofId), ['new']);
});

test('ready-to-fulfill count uses canonical evidence and participant readiness', () => {
  const queue = [
    order('ready'),
    { ...order('pending-evidence'), pendingEvidenceCount: 1 },
    { ...order('existing-evidence'), evidenceCount: 1 },
    { ...order('awaiting-participant'), proofStatus: 'AWAITING_PARTICIPANT' },
    { ...order('finalized-on-server'), proofStatus: 'FINALIZED' },
  ];
  assert.deepEqual(readyWorkspaceOrders(queue, []).map(row => row.proofId), ['ready']);
});

test('ready-to-fulfill count excludes saved and active unfinished recordings', () => {
  const saved = recording('file:///saved.mp4', 'LOCAL_ONLY');
  const active = { ...recording('file:///active.mp4', 'UPLOADING'), captureProofId: 'active' };
  const legacy = { ...recording('file:///legacy.mp4', 'LOCAL_ONLY'), captureProofId: 'legacy', recovery: undefined };
  const queue = [order('ready'), order('proof-a'), order('active'), order('legacy')];
  assert.deepEqual(readyWorkspaceOrders(queue, [], [saved, legacy], active).map(row => row.proofId), ['ready']);
});

test('retained submitted or finalized originals are not unfinished recording work', () => {
  const submitted = recording('file:///submitted.mp4', 'SUBMITTED');
  const finalized = { ...recording('file:///finalized.mp4', 'FINALIZED'), captureProofId: 'complete' };
  const queue = [order('proof-a'), order('complete')];
  const proofs = [proof({ proofId: 'complete', status: 'FINALIZED' })];
  assert.deepEqual(readyWorkspaceOrders(queue, proofs, [submitted, finalized]).map(row => row.proofId), ['proof-a']);
});
