import assert from 'node:assert/strict';
import test from 'node:test';
import { parseMotionPreference, resolveMotionMode, policyDuration } from '../src/theme/motion.ts';

test('OS reduced motion is never overridden by a saved presentation preference', () => {
  for (const preference of ['system', 'reduced', 'off'] as const) {
    const mode = resolveMotionMode(preference, true);
    assert.notEqual(mode, 'full');
    assert.ok(policyDuration(mode, 600) <= 100);
  }
});
test('active capture, station, background and performance suppression take immediate precedence', () => {
  for (const preference of ['system', 'reduced', 'off'] as const) {
    for (const systemReduced of [false, true]) {
      assert.equal(resolveMotionMode(preference, systemReduced, true), 'off');
      assert.equal(policyDuration(resolveMotionMode(preference, systemReduced, true), 600), 0);
    }
  }
});
test('runtime preference changes return to the system mode after Reduced and Off', () => {
  const modes = ['system', 'reduced', 'off', 'system'].map(preference => resolveMotionMode(parseMotionPreference(preference), false));
  assert.deepEqual(modes, ['full', 'reduced', 'off', 'full']);
});
test('unknown or absent stored preferences defer to the OS; Off is exactly immediate', () => {
  for (const value of [null, undefined, '', 'full', 'neon']) assert.equal(parseMotionPreference(value), 'system');
  assert.equal(resolveMotionMode(parseMotionPreference(null), true), 'reduced');
  for (const duration of [100, 180, 240, 320, 520, 600]) assert.equal(policyDuration('off', duration), 0);
});
