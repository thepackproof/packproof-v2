const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { spawn, spawnSync } = require('node:child_process');
const { releaseContext } = require('./release-policy.cjs');

const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
const fatalCodes = new Set(['STARTUP_FAILED', 'UNCAUGHT_EXCEPTION', 'UNHANDLED_REJECTION', 'RENDERER_CRASH', 'SECURE_STORAGE_OR_QUEUE_UNAVAILABLE', 'QUIT_FAILED']);
const shutdownCodes = new Set(['WINDOW_CLOSE_REQUESTED','WINDOW_CLOSE_ALLOWED','WINDOW_CLOSE_WAITING_FOR_DRAIN','WINDOW_CLOSE_CAPTURE_BLOCKED','WINDOW_CLOSE_QUEUE_PROMPT','WINDOW_CLOSE_CANCELED','QUIT_REQUESTED','QUIT_EVIDENCE_DRAINED','QUIT_REPORTING_CLOSED','QUIT_CLOSE_ALLOWED','QUIT_NATIVE_REQUESTED','QUIT_CANCELED','QUIT_FAILED','APP_BEFORE_QUIT','APP_WILL_QUIT']);
function shutdownDiagnostics(rows) {
  return rows.filter(row => row.category === 'SYSTEM' && shutdownCodes.has(row.code)).slice(-32).map(row => ({ code: row.code, at: Number.isFinite(Date.parse(row.at)) ? new Date(row.at).toISOString() : null }));
}
function gracefulExitOutcome(child) {
  return child.exitCode === 0 && child.signalCode === null ? 'normal-window-close' : 'abnormal-exit-during-window-close';
}
function assertCleanShutdown(child, shutdown, rows) {
  const fatal = rows.find(row => fatalCodes.has(row.code));
  if (fatal) throw new Error(`Native application reported ${fatal.code} during this launch or shutdown.`);
  if (shutdown !== 'normal-window-close' || gracefulExitOutcome(child) !== 'normal-window-close') throw new Error('The native application did not complete a normal zero-exit window-close shutdown.');
}
function diagnosticRows(file) {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).flatMap(line => {
    try { return [JSON.parse(line)]; } catch { return []; }
  });
}
async function fingerprint(file) {
  const hash = crypto.createHash('sha256');
  for await (const chunk of fs.createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}
async function stopOwnedChild(child, target, result) {
  if (child.exitCode !== null || child.signalCode !== null) return 'already-exited';
  const quotedPath = target.appBundle.replaceAll('\\', '\\\\').replaceAll('"', '\\"');
  const request = spawnSync('osascript', ['-e', `tell application "${quotedPath}" to quit`], { timeout: 10000, stdio: 'ignore' });
  result.closeRequest = { method: 'application-quit', delivered: request.status === 0 && !request.error };
  const gracefulDeadline = Date.now() + 10000;
  while (child.exitCode === null && child.signalCode === null && Date.now() < gracefulDeadline) await delay(200);
  if (child.exitCode !== null || child.signalCode !== null) return result.closeRequest.delivered ? gracefulExitOutcome(child) : 'normal-close-request-not-confirmed';
  // Only the process created on this fresh unauthenticated CI profile may be terminated.
  child.kill('SIGTERM');
  const deadline = Date.now() + 5000;
  while (child.exitCode === null && child.signalCode === null && Date.now() < deadline) await delay(200);
  if (child.exitCode === null && child.signalCode === null) {
    child.kill('SIGKILL');
    return 'owned-fresh-profile-process-force-stopped';
  }
  return 'owned-fresh-profile-process-terminated';
}
async function launchCycle(target, logFile, result, { env = process.env } = {}) {
  const previousRows = diagnosticRows(logFile).length;
  let failure, child;
  try {
    // Keep the real sandbox, packaged runtime configuration and native credential store.
    child = spawn(target.executable, [], { cwd: path.dirname(target.executable), env, stdio: ['ignore', 'ignore', 'ignore'] });
    child.on('error', error => { failure = new Error(`Native process failed to start (${error.code || 'unknown'}).`); });
    const deadline = Date.now() + 90000; let readyAt = null;
    while (Date.now() < deadline) {
      if (failure) throw failure;
      if (child.exitCode !== null || child.signalCode !== null) throw new Error('Native application exited before startup verification completed.');
      // A restart must produce its own readiness events, not reuse the first launch's log.
      const rows = diagnosticRows(logFile).slice(previousRows);
      const fatal = rows.find(row => fatalCodes.has(row.code));
      if (fatal) throw new Error(`Native application reported ${fatal.code}.`);
      result.started = rows.some(row => row.category === 'SYSTEM' && row.code === 'STARTED');
      result.rendererReady = rows.some(row => row.category === 'SYSTEM' && row.code === 'RENDERER_READY');
      if (rows.some(row => row.code === 'SECURE_STORAGE_READY')) result.secureStorage = 'available';
      else if (rows.some(row => row.code === 'SECURE_STORAGE_UNAVAILABLE')) result.secureStorage = 'unavailable';
      if (result.started && result.rendererReady) { readyAt ??= Date.now(); if (Date.now() - readyAt >= 3000) break; }
      await delay(300);
    }
    if (!result.started || !result.rendererReady) throw new Error('Timed out waiting for this launch’s STARTED and renderer-to-preload IPC readiness.');
    if (result.secureStorage !== 'available') throw new Error('Native protected storage is unavailable; persisted-installation restart was not exercised.');
  } catch (error) { failure = error; }
  finally {
    if (child?.pid) result.shutdown = await stopOwnedChild(child, target, result);
    const rows = diagnosticRows(logFile).slice(previousRows);
    result.startupCodes = [...new Set(rows.filter(row => row.category === 'SYSTEM' && /^[A-Z_]{1,60}$/.test(row.code)).map(row => row.code))].slice(0,32);
    result.shutdownDiagnostics = shutdownDiagnostics(rows);
  }
  if (failure) throw failure;
  // Quit may fail after readiness: include shutdown diagnostics and require a clean owned-process exit.
  result.exitCode = child.exitCode; result.signalCode = child.signalCode;
  assertCleanShutdown(child, result.shutdown, diagnosticRows(logFile).slice(previousRows));
}
async function main() {
  if (process.env.CI !== 'true' || process.env.APP_ENV !== 'development') throw new Error('Native launch smoke is restricted to isolated development CI.');
  if (process.platform !== 'darwin') throw new Error('Native launch smoke requires macOS.');
  if (process.argv.length !== 2) throw new Error('Native launch smoke accepts no arguments.');
  const release = releaseContext();
  if (release.platform !== process.platform || release.arch !== process.arch) throw new Error('Launch smoke must run the native architecture.');
  const runtime = JSON.parse(fs.readFileSync(path.resolve('dist/main/runtime-config.json'), 'utf8'));
  if (runtime.channel !== 'development') throw new Error('Refusing to launch a production/staging profile in this smoke test.');
  const profileBase = path.join(os.homedir(), 'Library', 'Application Support');
  const profile = path.join(profileBase, release.productName);
  if (fs.existsSync(profile)) throw new Error('A development profile already exists. Preserve it; this CI smoke requires a clean runner.');
  const output = path.resolve(release.outputDirectory);
  const appBundle = path.join(output, release.arch === 'arm64' ? 'mac-arm64' : 'mac', release.productName + '.app');
  const executable = path.join(appBundle, 'Contents', 'MacOS', release.productName);
  if (!fs.existsSync(executable)) throw new Error('Packaged native application executable is missing.');
  const target = { executable, appBundle };
  const logFile = path.join(profile, 'Logs', 'desktop.log');
  const report = {
    schemaVersion: 2, sourceCommit: process.env.GITHUB_SHA || null,
    platform: process.platform, arch: process.arch, channel: 'development', executionLocation: 'packaged-output',
    started: false, rendererReady: false, secureStorage: 'not-reported', protectedInstallation: 'not-tested',
    authentication: 'not-tested', signedPublisherVerification: 'not-tested', captureHardware: 'not-tested',
    evidenceQueueRecovery: 'not-tested', shutdown: 'not-started', checks: [], launches: [],
  };
  let failure;
  try {
    const first = { started: false, rendererReady: false, secureStorage: 'not-reported', shutdown: 'not-started' }; report.launches.push(first);
    await launchCycle(target, logFile, first);
    const installation = path.join(profile, 'Credentials', 'installation.vault');
    if (!fs.existsSync(installation) || fs.statSync(installation).size < 32) throw new Error('Native protected installation material was not persisted.');
    // Compare ciphertext only, privately. Never decrypt, print or attach installation keys/ciphertext.
    const before = await fingerprint(installation);
    const second = { started: false, rendererReady: false, secureStorage: 'not-reported', shutdown: 'not-started' }; report.launches.push(second);
    await launchCycle(target, logFile, second);
    if ((await fingerprint(installation)) !== before) throw new Error('Native restart replaced the persisted installation material.');
    report.protectedInstallation = 'preserved-and-reopened-across-normal-restart';
    report.checks = ['native-process-running', 'packaged-main-started', 'local-renderer-assets-executed', 'sandboxed-preload-ipc-used', 'no-observed-startup-exception', 'normal-quit-and-native-relaunch', 'persisted-protected-installation-reopened'];
  } catch (error) { failure = error; report.error = error.message; }
  finally {
    report.started = report.launches.length === 2 && report.launches.every(cycle => cycle.started);
    report.rendererReady = report.launches.length === 2 && report.launches.every(cycle => cycle.rendererReady);
    report.secureStorage = report.launches.at(-1)?.secureStorage || 'not-reported';
    report.shutdown = report.launches.at(-1)?.shutdown || 'not-started';
    report.passed = !failure;
    fs.writeFileSync(path.join(output, 'native-launch-smoke.json'), `${JSON.stringify(report, null, 2)}\n`);
  }
  if (failure) throw failure;
  console.log('Native application launch, normal quit/relaunch and persisted protected installation passed. Authentication, real evidence recovery, hardware and production signing were not tested.');
}
module.exports = { diagnosticRows, gracefulExitOutcome, assertCleanShutdown, shutdownDiagnostics, launchCycle };
if (require.main === module) main().catch(error => { console.error(error.message); process.exitCode = 1; });
