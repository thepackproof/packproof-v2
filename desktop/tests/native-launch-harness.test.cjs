const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { launchArguments, launchTarget, diagnosticRows, gracefulExitOutcome, assertCleanShutdown, requestWindowsClose, shutdownDiagnostics } = require('../scripts/native-launch-smoke.cjs');

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
test('Windows close request uses a file helper with exact owned PID/executable arguments and explicit delivery acknowledgement', () => {
  const child = { pid: 1234 }, executable = path.resolve('installed directory', 'PackProof Dev.exe');let invocation;
  const acknowledged = { method: 'owned-visible-window-wm-close', processId: child.pid, matchedWindows: 1, delivered: true };
  const result = requestWindowsClose(child, executable, (...args) => { invocation = args;return { status: 0, stdout: JSON.stringify(acknowledged) }; });
  assert.equal(result.delivered, true);assert.equal(result.matchedWindows, 1);
  assert.equal(invocation[0], 'powershell.exe');assert.ok(invocation[1].includes('-File'));assert.ok(!invocation[1].includes('-Command'));
  assert.deepEqual(invocation[1].slice(-4), ['-OwnedProcessId', '1234', '-ExpectedExecutable', executable]);assert.equal(invocation[2].timeout, 10000);
  assert.throws(() => requestWindowsClose({ pid: '1234; malicious' }, executable, () => { throw new Error('must not run'); }), /owned native process/);
});
test('missing, wrong-process, ambiguous, failed and timed-out Windows delivery cannot pass as a normal close', () => {
  const child = { pid: 1234 }, executable = path.resolve('PackProof Dev.exe');
  const acknowledged = { method: 'owned-visible-window-wm-close', processId: child.pid, matchedWindows: 1, delivered: true };
  for (const response of [
    { status: 0, stdout: '' }, { status: 0, stdout: JSON.stringify({ ...acknowledged, processId: 9999 }) },
    { status: 0, stdout: JSON.stringify({ ...acknowledged, matchedWindows: 2 }) },
    { status: 0, stdout: JSON.stringify({ ...acknowledged, delivered: false }) },
    { status: 1, stdout: JSON.stringify(acknowledged) }, { status: null, error: { code: 'ETIMEDOUT' }, stdout: JSON.stringify(acknowledged) },
  ]) assert.equal(requestWindowsClose(child, executable, () => response).delivered, false);
  const missing = requestWindowsClose(child, executable, () => ({ status: 1, stdout: JSON.stringify({ ...acknowledged, matchedWindows: 0, delivered: false, failureCode: 'NO_UNIQUE_OWNED_WINDOW' }) }));
  assert.equal(missing.matchedWindows, 0);assert.equal(missing.failureCode, 'NO_UNIQUE_OWNED_WINDOW');
  assert.throws(() => assertCleanShutdown({ exitCode: 0, signalCode: null }, 'normal-close-request-not-confirmed', []), /zero-exit/);
});
test('shutdown evidence contains only bounded fixed lifecycle codes and timestamps', () => {
  const rows=[{category:'SYSTEM',code:'QUIT_EVIDENCE_DRAINED',at:'2026-09-27T16:00:00Z',token:'secret',message:'private'}, {category:'SYSTEM',code:'ACCOUNT_PRIVATE',at:'2026-09-27T16:00:00Z'}, {category:'AUTH',code:'QUIT_REQUESTED',at:'2026-09-27T16:00:00Z'}];
  assert.deepEqual(shutdownDiagnostics(rows),[{code:'QUIT_EVIDENCE_DRAINED',at:'2026-09-27T16:00:00.000Z'}]);
  assert.equal(shutdownDiagnostics(Array(100).fill(rows[0])).length,32);
  assert.throws(()=>assertCleanShutdown({exitCode:0,signalCode:null},'normal-window-close',[{category:'SYSTEM',code:'QUIT_FAILED'}]),/QUIT_FAILED/);
});

test('Windows helper acknowledgments stay UTF-8 under an inherited Unicode console without weakening identity checks', { skip: process.platform !== 'win32' }, () => {
  const { spawnSync } = require('node:child_process');
  const helper = fs.readFileSync(path.join(__dirname, '../scripts/request-native-close-windows.ps1'), 'utf8');
  const begin = helper.indexOf('[Console]::OutputEncoding =');
  const end = helper.indexOf('$expectedPath =');
  assert.ok(begin >= 0 && end > begin);
  // Execute only the production protocol prelude, never process lookup or a UI close.
  const protocol = helper.slice(begin, end);
  const payload = "@{method='owned-visible-window-wm-close';processId=1234;matchedWindows=1;delivered=$true}";
  const invoke = code => spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', code], { timeout: 10000, windowsHide: true, encoding: 'utf8', maxBuffer: 16384 });
  const child = { pid: 1234 }, executable = path.resolve('PackProof Dev.exe');
  const inheritedUnicode = '[Console]::OutputEncoding=[Text.Encoding]::Unicode;';
  const unpinned = invoke(`${inheritedUnicode} ${payload} | ConvertTo-Json -Compress`);
  assert.equal(unpinned.status, 0);assert.ok(unpinned.stdout.includes('\0'));
  const rejected = requestWindowsClose(child, executable, () => unpinned);
  assert.equal(rejected.delivered, false);assert.equal(rejected.matchedWindows, null);
  const pinned = invoke(`${inheritedUnicode}\n${protocol}\nWrite-NativeCloseAcknowledgment ${payload}`);
  assert.equal(pinned.status, 0);assert.equal(pinned.error, undefined);
  assert.ok(!pinned.stdout.includes('\0'));assert.notEqual(pinned.stdout.codePointAt(0), 0xFEFF);
  assert.deepEqual(JSON.parse(pinned.stdout), { method: 'owned-visible-window-wm-close', processId: 1234, matchedWindows: 1, delivered: true });
  const accepted = requestWindowsClose(child, executable, () => pinned);
  assert.equal(accepted.delivered, true);assert.equal(accepted.acknowledgment, 'confirmed');
  assert.equal(requestWindowsClose({ pid: 9999 }, executable, () => pinned).delivered, false);
  assert.equal(requestWindowsClose(child, executable, () => ({ ...pinned, status: 1 })).delivered, false);
});

test('close helper failures expose bounded protocol metadata without raw process output or paths', () => {
  const child = { pid: 1234 }, executable = path.resolve('private candidate', 'PackProof Dev.exe');
  const result = requestWindowsClose(child, executable, () => ({ status: null, error: { code: 'ETIMEDOUT', message: executable }, stdout: 'private raw stdout', stderr: 'private raw stderr' }));
  assert.equal(result.delivered, false);assert.equal(result.helperStatus, null);assert.equal(result.helperError, 'ETIMEDOUT');assert.equal(result.acknowledgment, 'invalid-json');
  assert.ok(!JSON.stringify(result).includes('private'));
  assert.throws(() => assertCleanShutdown({ exitCode: 0, signalCode: null }, 'normal-close-request-not-confirmed', []), /zero-exit/);
});
