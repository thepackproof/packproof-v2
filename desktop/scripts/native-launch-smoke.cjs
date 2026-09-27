const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawn, spawnSync } = require('node:child_process');
const { releaseContext } = require('./release-policy.cjs');

const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
const fatalCodes = new Set(['UNCAUGHT_EXCEPTION', 'UNHANDLED_REJECTION', 'RENDERER_CRASH', 'SECURE_STORAGE_OR_QUEUE_UNAVAILABLE']);

function diagnosticRows(file) {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).flatMap(line => {
    try { return [JSON.parse(line)]; } catch { return []; } // The last append may still be in progress.
  });
}

async function stopOwnedChild(child, appBundle) {
  if (child.exitCode !== null || child.signalCode !== null) return 'already-exited';
  if (process.platform === 'win32') {
    // The PID comes from spawn, never user input. CloseMainWindow follows PackProof's normal close handler.
    spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `$process = Get-Process -Id ${child.pid} -ErrorAction SilentlyContinue; if ($process) { [void]$process.CloseMainWindow() }`], { timeout: 10000, windowsHide: true, stdio: 'ignore' });
  } else {
    const quotedPath = appBundle.replaceAll('\\', '\\\\').replaceAll('"', '\\"');
    spawnSync('osascript', ['-e', `tell application "${quotedPath}" to quit`], { timeout: 10000, stdio: 'ignore' });
  }
  const gracefulDeadline = Date.now() + 10000;
  while (child.exitCode === null && child.signalCode === null && Date.now() < gracefulDeadline) await delay(200);
  if (child.exitCode !== null || child.signalCode !== null) return 'normal-window-close';
  // This script refuses pre-existing profiles and never signs in or records. Only its own new child is stopped.
  child.kill('SIGTERM');
  const deadline = Date.now() + 5000;
  while (child.exitCode === null && child.signalCode === null && Date.now() < deadline) await delay(200);
  if (child.exitCode === null && child.signalCode === null) {
    if (process.platform === 'win32') spawnSync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { timeout: 10000, stdio: 'ignore' });
    else child.kill('SIGKILL');
    return 'owned-fresh-profile-process-force-stopped';
  }
  return 'owned-fresh-profile-process-terminated';
}

async function main() {
  if (process.env.CI !== 'true' || process.env.APP_ENV !== 'development') throw new Error('Native launch smoke is restricted to isolated development CI.');
  if (!['win32', 'darwin'].includes(process.platform)) throw new Error('Native launch smoke requires Windows or macOS.');
  const release = releaseContext();
  if (release.platform !== process.platform || release.arch !== process.arch) throw new Error('Launch smoke must run the native architecture.');
  const runtime = JSON.parse(fs.readFileSync(path.resolve('dist/main/runtime-config.json'), 'utf8'));
  if (runtime.channel !== 'development') throw new Error('Refusing to launch a production/staging profile in this smoke test.');
  const profileBase = process.platform === 'win32' ? process.env.LOCALAPPDATA : path.join(os.homedir(), 'Library', 'Application Support');
  if (!profileBase) throw new Error('Native application-data location is unavailable.');
  const profile = path.join(profileBase, release.productName);
  if (fs.existsSync(profile)) throw new Error('A development profile already exists. Preserve it; this CI smoke requires a clean runner.');
  const output = path.resolve(release.outputDirectory);
  const appBundle = process.platform === 'darwin' ? path.join(output, release.arch === 'arm64' ? 'mac-arm64' : 'mac', `${release.productName}.app`) : null;
  const executable = appBundle ? path.join(appBundle, 'Contents', 'MacOS', release.productName) : path.join(output, 'win-unpacked', `${release.productName}.exe`);
  if (!fs.existsSync(executable)) throw new Error('Packaged native application executable is missing.');
  const logFile = path.join(profile, 'Logs', 'desktop.log');
  const report = {
    schemaVersion: 1, sourceCommit: process.env.GITHUB_SHA || null,
    platform: process.platform, arch: process.arch, channel: 'development',
    started: false, rendererReady: false, secureStorage: 'not-reported', authentication: 'not-tested',
    signedPublisherVerification: 'not-tested', captureHardware: 'not-tested', shutdown: 'not-started', checks: [],
  };
  let child;
  let failure;
  try {
    // No --no-sandbox, remote-debugging, credential-store substitution or environment override.
    child = spawn(executable, [], { cwd: path.dirname(executable), env: process.env, stdio: ['ignore', 'ignore', 'ignore'] });
    child.on('error', error => { failure = new Error(`Native process failed to start (${error.code || 'unknown'}).`); });
    const deadline = Date.now() + 90000;
    let readyAt = null;
    while (Date.now() < deadline) {
      if (failure) throw failure;
      if (child.exitCode !== null || child.signalCode !== null) throw new Error('Native application exited before startup verification completed.');
      const rows = diagnosticRows(logFile);
      const fatal = rows.find(row => fatalCodes.has(row.code));
      if (fatal) throw new Error(`Native application reported ${fatal.code}.`);
      report.started = rows.some(row => row.category === 'SYSTEM' && row.code === 'STARTED');
      report.rendererReady = rows.some(row => row.category === 'SYSTEM' && row.code === 'RENDERER_READY');
      if (rows.some(row => row.code === 'SECURE_STORAGE_READY')) report.secureStorage = 'available';
      else if (rows.some(row => row.code === 'SECURE_STORAGE_UNAVAILABLE')) report.secureStorage = 'unavailable';
      if (report.started && report.rendererReady) {
        readyAt ??= Date.now();
        if (Date.now() - readyAt >= 3000) break;
      }
      await delay(300);
    }
    if (!report.started || !report.rendererReady) throw new Error('Timed out waiting for STARTED and renderer-to-preload IPC readiness.');
    report.checks = ['native-process-running', 'packaged-main-started', 'local-renderer-assets-executed', 'sandboxed-preload-ipc-used', 'no-observed-startup-exception'];
    console.log(`Native launch passed: STARTED + RENDERER_READY; secure storage ${report.secureStorage}. Authentication, capture hardware and production signing were not tested.`);
  } catch (error) { failure = error; report.error = error.message; }
  finally {
    if (child?.pid) report.shutdown = await stopOwnedChild(child, appBundle);
    report.passed = !failure;
    fs.writeFileSync(path.join(output, 'native-launch-smoke.json'), `${JSON.stringify(report, null, 2)}\n`);
  }
  if (failure) throw failure;
}

main().catch(error => { console.error(error.message); process.exitCode = 1; });
