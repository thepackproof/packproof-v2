import test from 'node:test';
import assert from 'node:assert/strict';
import { sessionRecordingLimits, requireNativeRecordingLimits, recordingLimitCopy } from '../src/capture/limits';

test('capture uses the accepted account limits and cannot widen the platform limits', () => {
  assert.deepEqual(sessionRecordingLimits({ maxRecordingBytes: 10_000_000, maxRecordingSeconds: 30 }), { maxRecordingBytes: 10_000_000, maxRecordingSeconds: 30 });
  assert.deepEqual(sessionRecordingLimits({ maxRecordingBytes: 500_000_000, maxRecordingSeconds: 600 }), { maxRecordingBytes: 250_000_000, maxRecordingSeconds: 300 });
  assert.match(recordingLimitCopy({ maxRecordingBytes: 10_000_000, maxRecordingSeconds: 30 }), /30 seconds and 10 MB/);
});

test('unknown or malformed account limits stop acquisition rather than inventing allowance', () => {
  for (const value of [null, {}, { maxRecordingBytes: 0, maxRecordingSeconds: 30 }, { maxRecordingBytes: 10, maxRecordingSeconds: NaN }, { maxRecordingBytes: '10', maxRecordingSeconds: 30 }, { maxRecordingBytes: 10, maxRecordingSeconds: 0.5 }])
    assert.throws(() => sessionRecordingLimits(value), { code: 'CAPTURE_LIMITS_UNAVAILABLE' });
});

test('older native binaries cannot record beyond a restricted account allowance', () => {
  assert.throws(() => requireNativeRecordingLimits({ maxRecordingBytes: 10_000_000, maxRecordingSeconds: 30 }, false), { code: 'CAPTURE_LIMITS_UPDATE_REQUIRED' });
  assert.doesNotThrow(() => requireNativeRecordingLimits({ maxRecordingBytes: 10_000_000, maxRecordingSeconds: 30 }, true));
  assert.doesNotThrow(() => requireNativeRecordingLimits({ maxRecordingBytes: 250_000_000, maxRecordingSeconds: 300 }, false));
});
