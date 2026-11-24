const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { diagnosticRows, gracefulExitOutcome, assertCleanShutdown, shutdownDiagnostics } = require('../scripts/native-launch-smoke.cjs');

test('diagnostic polling tolerates only an incomplete append and exposes fresh rows for restart checks', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'packproof-native-log-')), file = path.join(root, 'log');
  try { fs.writeFileSync(file, '{"code":"STARTED"}\n{"code":"RENDER');assert.equal(diagnosticRows(file).length, 1);fs.appendFileSync(file, 'ER_READY"}\n');assert.deepEqual(diagnosticRows(file).slice(1), [{ code: 'RENDERER_READY' }]); }
  finally { fs.rmSync(root, { recursive: true, force: true }); }
});
test('normal window close requires zero exit without a signal and rejects pre-existing exits', () => {
  const clean = { exitCode: 0, signalCode: null };
  assert.equal(gracefulExitOutcome(clean), 'normal-window-close');
  assert.doesNotThrow(() => assertCleanShutdown(clean, 'normal-window-close', [{ code: 'STARTED' }, { code: 'RENDERER_READY' }]));
  assert.throws(() => assertCleanShutdown(clean, 'already-exited', []), /zero-exit/);
  for (const child of [{ exitCode: 1, signalCode: null }, { exitCode: null, signalCode: 'SIGTERM' }, { exitCode: 0, signalCode: 'SIGKILL' }]) {
    assert.equal(gracefulExitOutcome(child), 'abnormal-exit-during-window-close');
    assert.throws(() => assertCleanShutdown(child, 'normal-window-close', []), /zero-exit/);
  }
});
test('fatal diagnostics appended after renderer readiness make even a zero-exit shutdown fail', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'packproof-shutdown-log-')), file = path.join(root, 'log');
  try {
    fs.writeFileSync(file, '{"code":"STARTED"}\n{"code":"RENDERER_READY"}\n');
    const clean = { exitCode: 0, signalCode: null };
    assert.doesNotThrow(() => assertCleanShutdown(clean, 'normal-window-close', diagnosticRows(file)));
    fs.appendFileSync(file, '{"code":"UNCAUGHT_EXCEPTION"}\n');
    assert.throws(() => assertCleanShutdown(clean, 'normal-window-close', diagnosticRows(file)), /UNCAUGHT_EXCEPTION/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
test('shutdown evidence contains only bounded fixed lifecycle codes and timestamps', () => {
  const rows=[{category:'SYSTEM',code:'QUIT_EVIDENCE_DRAINED',at:'2026-09-27T16:00:00Z',token:'secret',message:'private'}, {category:'SYSTEM',code:'ACCOUNT_PRIVATE',at:'2026-09-27T16:00:00Z'}, {category:'AUTH',code:'QUIT_REQUESTED',at:'2026-09-27T16:00:00Z'}];
  assert.deepEqual(shutdownDiagnostics(rows),[{code:'QUIT_EVIDENCE_DRAINED',at:'2026-09-27T16:00:00.000Z'}]);
  assert.equal(shutdownDiagnostics(Array(100).fill(rows[0])).length,32);
  assert.throws(()=>assertCleanShutdown({exitCode:0,signalCode:null},'normal-window-close',[{category:'SYSTEM',code:'QUIT_FAILED'}]),/QUIT_FAILED/);
});
