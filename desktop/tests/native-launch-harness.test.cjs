const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { launchArguments, launchTarget, diagnosticRows, gracefulExitOutcome, assertCleanShutdown } = require('../scripts/native-launch-smoke.cjs');

test('installed launch accepts only an explicit absolute executable argument', () => {
  assert.deepEqual(launchArguments([]), {});
  assert.deepEqual(launchArguments(['--installed-executable', path.resolve('fixture.exe')]), { installedExecutable: path.resolve('fixture.exe') });
  for (const args of [['--no-sandbox'], ['--installed-executable', 'relative.exe'], ['--installed-executable', path.resolve('fixture.exe'), '--no-sandbox']]) assert.throws(() => launchArguments(args));
});
test('installed application executable and actual asar must match the packaged candidate', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'packproof-native-harness-'));
  try {
    const output = path.join(root, 'release'), installed = path.join(root, 'installed');
    const packaged = path.join(output, 'win-unpacked');
    for (const dir of [packaged, installed]) { fs.mkdirSync(path.join(dir, 'resources'), { recursive: true }); fs.writeFileSync(path.join(dir, 'PackProof Dev.exe'), 'fixture executable'); fs.writeFileSync(path.join(dir, 'resources/app.asar'), 'fixture app'); }
    const release = { platform: 'win32', arch: 'x64', productName: 'PackProof Dev' }, executable = path.join(installed, 'PackProof Dev.exe');
    assert.equal((await launchTarget(release, output, executable)).executionLocation, 'registered-current-user-install');
    assert.equal((await launchTarget(release, output)).executionLocation, 'packaged-output');
    await assert.rejects(launchTarget(release, output, path.join(packaged, 'PackProof Dev.exe')), /registered installed/);
    fs.writeFileSync(path.join(installed, 'resources/app.asar'), 'different app');
    await assert.rejects(launchTarget(release, output, executable), /bytes differ/);
    fs.writeFileSync(path.join(installed, 'resources/app.asar'), 'fixture app');fs.writeFileSync(executable, 'different executable');
    await assert.rejects(launchTarget(release, output, executable), /bytes differ/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
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
