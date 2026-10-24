import assert from 'node:assert/strict';
import test from 'node:test';
import { connectedRecordEvents, connectedRecordSources, originalForRecordEvent } from '../src/copy/eim-record.ts';
import type { ChronologyEntry, ProofView } from '../src/v2-api.ts';
import type { RecordEvidence } from '../src/copy/proof-record.ts';

const event = (id: string, category = 'PROOF', occurredAt = '2026-10-24T12:00:00Z'): ChronologyEntry => ({ id, category, occurredAt, source: 'PACKPROOF', title: id, description: null, relatedEntityId: null, eventType: 'EVIDENCE_COMMITTED' });
const original: RecordEvidence = { evidenceId: 'original1', evidenceType: 'VIDEO', validationStatus: 'COMMITTED', sha256: 'abc', byteSize: 100, committedAt: '2026-10-24T12:00:00Z', contentType: 'video/mp4' };

test('connected history keeps deterministic identity order, unknown time and source distinctions', () => {
  const entries = [event('z'), event('unknown', 'PROOF', ''), event('a'), event('a'), { ...event('a'), source: 'PARTICIPANT' }, event('ship', 'SHIPMENT')];
  const snapshot = JSON.stringify(entries);
  const history = connectedRecordEvents(entries);
  assert.deepEqual(history.map(item => `${item.source}:${item.id}`), ['PACKPROOF:a', 'PARTICIPANT:a', 'PACKPROOF:ship', 'PACKPROOF:z', 'PACKPROOF:unknown']);
  assert.equal(JSON.stringify(entries), snapshot);
  assert.deepEqual(connectedRecordEvents(entries, 'SHIPMENT').map(item => item.id), ['ship']);
  assert.equal(connectedRecordEvents(entries, 'EVIDENCE').some(item => item.category === 'SHIPMENT'), false);
});

test('record source markers expose only actual sources and do not invent a shipment from an order label', () => {
  const proof = { transaction: { provenance: null, shipping: { trackingNumber: 'tracking-only' } }, shipmentObservations: { events: [] } } as unknown as ProofView;
  assert.deepEqual(connectedRecordSources(proof, []).map(source => source.key), ['COMMERCE']);
  assert.deepEqual(connectedRecordSources(proof, [original]).map(source => source.key), ['COMMERCE', 'EVIDENCE']);
});

test('event focus cannot substitute an unrelated or ambiguous stage original', () => {
  const stage = { ...original, stageId: 'return1' };
  assert.equal(originalForRecordEvent({ ...event('event'), relatedEntityId: 'unrelated' }, [original, stage]), undefined);
  assert.equal(originalForRecordEvent({ ...event('event'), relatedEntityId: original.evidenceId }, [stage, original]), original);
  assert.equal(originalForRecordEvent({ ...event('event'), relatedEntityId: 'return1:original1' }, [original, stage]), stage);
  assert.equal(originalForRecordEvent({ ...event('event'), relatedEntityId: original.evidenceId }, [stage]), undefined);
});

test('distinct provider or conflicting event representations remain inspectable', () => {
  const originalEvent = event('same-id', 'SHIPMENT');
  const entries = [originalEvent, { ...originalEvent, provider: 'provider2' }, { ...originalEvent, description: 'Conflicting source detail' }];
  assert.equal(connectedRecordEvents(entries).length, 3);
  assert.equal(connectedRecordEvents([originalEvent, { ...originalEvent }]).length, 1);
});

test('actual audit-shaped chronology links the exact committed original or stage without hash substitution', () => {
  const node = { ...event('audit1'), relatedEntityId: 'audit1' };
  const raw = { eventId: 'audit1', eventType: 'EVIDENCE_COMMITTED', actorUserId: 'seller', at: node.occurredAt, data: { evidenceId: 'original1', sha256: 'abc' } };
  assert.equal(originalForRecordEvent(node, [original], [raw]), original);
  assert.equal(originalForRecordEvent(node, [original], [{ ...raw, data: { ...raw.data, sha256: 'different-original' } }]), undefined);
  assert.equal(originalForRecordEvent(node, [original], [{ ...raw, at: 'other-time' }]), undefined);
  assert.equal(originalForRecordEvent(node, [original], [raw, raw]), undefined);
  const stage = { ...original, stageId: 'return1' };
  const stageNode = { ...node, eventType: 'LIFECYCLE_EVIDENCE_COMMITTED' };
  const stageRaw = { ...raw, eventType: stageNode.eventType, data: { ...raw.data, stageId: 'return1' } };
  assert.equal(originalForRecordEvent(stageNode, [original, stage], [stageRaw]), stage);
  assert.equal(originalForRecordEvent(stageNode, [original, stage], [{ ...stageRaw, data: raw.data }]), undefined);
});
