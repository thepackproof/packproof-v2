import assert from 'node:assert/strict';
import { test } from 'vitest';
import { orderSourceEvents, selectedSourceEvent, sourceEventInstant } from '../src/renderer/source-chronology.ts';
test('source chronology compares actual instants across offsets rather than timestamp text', () => {
  const events = [
    { id: 'later', occurredAt: '2026-10-24T09:30:00-04:00' },
    { id: 'earlier', occurredAt: '2026-10-24T12:00:00Z' },
    { id: 'latest', occurredAt: '2026-10-24T15:00:00+01:00' },
  ];
  assert.deepEqual(orderSourceEvents(events).map(event => event.id), ['earlier', 'later', 'latest']);
  assert.equal(events[0].id, 'later');
});
test('same instants have deterministic identity ties, and unknown dates remain visible at the end', () => {
  const result = orderSourceEvents([
    { id: 'unknown-b', occurredAt: '' }, { id: 'b', occurredAt: '2026-10-24T12:00:00Z' },
    { id: 'a', occurredAt: '2026-10-24T08:00:00-04:00' }, { id: 'unknown-a', occurredAt: 'unreported' },
  ]);
  assert.deepEqual(result.map(event => event.id), ['a', 'b', 'unknown-a', 'unknown-b']);
  assert.equal(sourceEventInstant('unreported'), null);
});
test('refresh preserves selected identity; removed sources never substitute a different event', () => {
  const selection = 'selected';
  const original = [{ id: 'selected' }, { id: 'other' }];
  assert.equal(selectedSourceEvent(original, selection)?.id, 'selected');
  assert.equal(selectedSourceEvent([{ id: 'new' }, { id: 'selected' }], selection)?.id, 'selected');
  assert.equal(selectedSourceEvent([{ id: 'other' }], selection), null);
  assert.equal(selectedSourceEvent(original, null), null);
});
