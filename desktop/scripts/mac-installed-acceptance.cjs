'use strict';

// Partial, real installed-package verification on disposable native macOS CI.
// This never approves the full release acceptance report or modifies signed code.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { launchCycle } = require('./native-launch-smoke.cjs');

const APP = '/Applications/PackProof.app';
const BUNDLE_ID = 'com.thepackproof.desktop';
const SHA = /^[a-f0-9]{40}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const ALLOWED_ENV = ['HOME', 'USER', 'LOGNAME', 'PATH', 'TMPDIR', 'LANG', 'LC_ALL', 'LC_CTYPE', 'SHELL', '__CF_USER_TEXT_ENCODING', 'DISPLAY'];
class HarnessError extends Error {
  constructor(code, detail = {}) { super(code); this.code = code; this.detail = detail; }
}
function requireCondition(condition, code) { if (!condition) throw new HarnessError(code); }
function parseArguments(args) {
  const allowed = new Set(['--artifacts', '--source-commit', '--team-id', '--report']);
  const parsed = {};
  for (let i = 0; i < args.length; i += 2) {
    requireCondition(allowed.has(args[i]) && typeof args[i + 1] === 'string' && !parsed[args[i]], 'ARGUMENTS_INVALID');
    parsed[args[i]] = args[i + 1];
  }
  requireCondition(Object.keys(parsed).length === 4, 'ARGUMENTS_REQUIRED');
  requireCondition(path.isAbsolute(parsed['--artifacts']) && path.isAbsolute(parsed['--report']), 'ABSOLUTE_PATHS_REQUIRED');
  requireCondition(SHA.test(parsed['--source-commit']) && /^[A-Z0-9]{10}$/.test(parsed['--team-id']), 'SOURCE_OR_TEAM_INVALID');
  return { artifacts: path.resolve(parsed['--artifacts']), sourceCommit: parsed['--source-commit'], teamId: parsed['--team-id'], report: path.resolve(parsed['--report']) };
}
function assertRunner(env = process.env, platform = process.platform, arch = process.arch) {
  requireCondition(env.CI === 'true' && env.GITHUB_ACTIONS === 'true' && env.RUNNER_ENVIRONMENT === 'github-hosted', 'DISPOSABLE_GITHUB_HOSTED_CI_REQUIRED');
  requireCondition(platform === 'darwin' && ['x64', 'arm64'].includes(arch), 'NATIVE_MACOS_REQUIRED');
  requireCondition(SHA.test(env.GITHUB_SHA || ''), 'HARNESS_SOURCE_SHA_REQUIRED');
}
function childEnvironment(env = process.env) {
  return Object.fromEntries(ALLOWED_ENV.filter(key => typeof env[key] === 'string').map(key => [key, env[key]]));
}
function contained(root, target) {
  const relative = path.relative(root, target);
  return relative !== '' && !path.isAbsolute(relative) && relative !== '..' && !relative.startsWith('..' + path.sep);
}
function plainFile(file) {
  requireCondition(fs.existsSync(file) && fs.lstatSync(file).isFile() && !fs.lstatSync(file).isSymbolicLink(), 'PLAIN_FILE_REQUIRED');
}
async function hash(file) {
  const h = crypto.createHash('sha256');
  for await (const chunk of fs.createReadStream(file)) h.update(chunk);
  return h.digest('hex');
}
function command(executable, args, code, { timeout = 60000, input, run = spawnSync } = {}) {
  const result = run(executable, args, { encoding: 'utf8', timeout, input, maxBuffer: 8 * 1024 * 1024, windowsHide: true });
  if (result.status !== 0 || result.error) throw new HarnessError(code, { exitStatus: result.status ?? null, signal: result.signal ?? null, timedOut: result.error?.code === 'ETIMEDOUT' });
  // Raw output is transient and never written to the receipt or console.
  return `${result.stdout || ''}\n${result.stderr || ''}`.trim();
}
function safeFailure(error) {
  if (error instanceof HarnessError) return { code: error.code, ...error.detail };
  const nativeCode = /Native application reported ([A-Z_]+)[. ]/.exec(error?.message || '')?.[1];
  const allowed = new Set(['UNCAUGHT_EXCEPTION', 'UNHANDLED_REJECTION', 'RENDERER_CRASH', 'SECURE_STORAGE_OR_QUEUE_UNAVAILABLE', 'QUIT_FAILED']);
  return { code: nativeCode && allowed.has(nativeCode) ? nativeCode : 'INSTALLED_HARNESS_STEP_FAILED' };
}
async function verifyArtifacts(directory, sourceCommit, arch) {
  const reportFile = path.join(directory, 'release-evidence.json'); plainFile(reportFile);
  requireCondition(fs.statSync(reportFile).size < 1024 * 1024, 'INVENTORY_SIZE_LIMIT');
  const report = JSON.parse(fs.readFileSync(reportFile, 'utf8'));
  requireCondition(report.schemaVersion === 1 && report.sourceCommit === sourceCommit && report.channel === 'production' && report.platform === 'darwin' && report.arch === arch && report.signed === true, 'CANDIDATE_IDENTITY_MISMATCH');
  requireCondition(/^\d+\.\d+\.\d+$/.test(report.version || ''), 'CANDIDATE_VERSION_INVALID');
  const checks = ['codesign-valid', 'apple-team-matches', 'hardened-runtime', 'notarized', 'stapled', 'gatekeeper-accepted'];
  requireCondition(checks.every(code => report.checks?.includes(code)), 'CANDIDATE_NATIVE_VERIFICATION_MISSING');
  requireCondition(report.updateUrl === `https://downloads.thepackproof.com/desktop/production/darwin/${arch}/`, 'CANDIDATE_FEED_MISMATCH');
  requireCondition(Array.isArray(report.artifacts) && report.artifacts.length >= 2 && report.artifacts.length <= 8, 'CANDIDATE_INVENTORY_INVALID');
  const files = new Map();
  const prefix = `PackProof-${report.version}-${arch}`;
  const allowed = new Set([`${prefix}.dmg`, `${prefix}.zip`, `${prefix}.pkg`, 'PackProof.dmg', 'PackProof.pkg']);
  for (const item of report.artifacts) {
    requireCondition(item && allowed.has(item.file) && !files.has(item.file) && Number.isSafeInteger(item.bytes) && item.bytes > 0 && SHA256.test(item.sha256 || ''), 'CANDIDATE_FILE_ENTRY_INVALID');
    const full = path.join(directory, item.file); plainFile(full);
    requireCondition(fs.statSync(full).size === item.bytes && await hash(full) === item.sha256, 'CANDIDATE_FILE_HASH_MISMATCH');
    files.set(item.file, item);
  }
  for (const ext of ['dmg', 'zip']) requireCondition(files.has(`${prefix}.${ext}`), 'CANDIDATE_PACKAGE_MISSING');
  // Never silently omit a shipped PKG, or accept an alias whose bytes differ.
  for (const ext of ['dmg', 'pkg']) if (files.has(`PackProof.${ext}`)) requireCondition(files.has(`${prefix}.${ext}`) && files.get(`PackProof.${ext}`).sha256 === files.get(`${prefix}.${ext}`).sha256, 'CANDIDATE_ALIAS_MISMATCH');
  for (const name of fs.readdirSync(directory)) if (/\.(dmg|pkg|zip)$/.test(name)) requireCondition(files.has(name), 'UNLISTED_CANDIDATE_PACKAGE');
  const sumsFile = path.join(directory, 'SHA256SUMS'); plainFile(sumsFile);
  const expectedSums = [...files.values()].sort((a, b) => a.file.localeCompare(b.file)).map(item => `${item.sha256}  ${item.file}`).sort();
  const actualSums = fs.readFileSync(sumsFile, 'utf8').trim().split(/\r?\n/).sort();
  requireCondition(JSON.stringify(expectedSums) === JSON.stringify(actualSums), 'SHA256SUMS_MISMATCH');
  return { version: report.version, artifacts: [...files.values()], inventorySha256: await hash(reportFile), dmg: path.join(directory, `${prefix}.dmg`), pkg: files.has(`${prefix}.pkg`) ? path.join(directory, `${prefix}.pkg`) : null };
}
async function bundleInventory(bundle) {
  requireCondition(fs.lstatSync(bundle).isDirectory() && !fs.lstatSync(bundle).isSymbolicLink(), 'BUNDLE_DIRECTORY_REQUIRED');
  const root = fs.realpathSync(bundle), rows = [];
  async function walk(dir) {
    for (const name of fs.readdirSync(dir).sort()) {
      const full = path.join(dir, name), relative = path.relative(root, full).split(path.sep).join('/'), stat = fs.lstatSync(full);
      requireCondition(rows.length < 40000, 'BUNDLE_FILE_LIMIT');
      if (stat.isSymbolicLink()) {
        const target = fs.readlinkSync(full);
        requireCondition(!path.isAbsolute(target) && contained(root, fs.realpathSync(full)), 'BUNDLE_SYMLINK_ESCAPES');
        rows.push({ path: relative, kind: 'symlink', target });
      } else if (stat.isDirectory()) { rows.push({ path: relative, kind: 'directory' }); await walk(full); }
      else { requireCondition(stat.isFile(), 'BUNDLE_SPECIAL_FILE'); rows.push({ path: relative, kind: 'file', bytes: stat.size, executable: Boolean(stat.mode & 0o111), sha256: await hash(full) }); }
    }
  }
  await walk(root);
  return { digest: crypto.createHash('sha256').update(JSON.stringify(rows)).digest('hex'), fileCount: rows.filter(row => row.kind === 'file').length, entries: rows };
}
async function assertBundleMatches(bundle, expected) {
  const actual = await bundleInventory(bundle);
  requireCondition(actual.digest === expected.digest, 'INSTALLED_BUNDLE_BYTES_MISMATCH');
  return { bundleInventorySha256: actual.digest, fileCount: actual.fileCount, exactFilesAndSymlinksMatch: true };
}
function verifyNativeTrust(app, teamId, version, arch) {
  command('/usr/bin/codesign', ['--verify', '--deep', '--strict', '--verbose=2', app], 'APP_CODESIGN_FAILED');
  const signature = command('/usr/bin/codesign', ['--display', '--verbose=4', app], 'APP_SIGNING_DETAILS_FAILED');
  requireCondition(signature.split('\n').some(line => line.trim() === `TeamIdentifier=${teamId}`) && /flags=.*\bruntime\b/.test(signature), 'APP_TEAM_OR_HARDENED_RUNTIME_MISMATCH');
  command('/usr/bin/xcrun', ['stapler', 'validate', app], 'APP_STAPLE_FAILED');
  command('/usr/sbin/spctl', ['--assess', '--type', 'execute', '--verbose=4', app], 'APP_GATEKEEPER_FAILED');
  const info = JSON.parse(command('/usr/bin/plutil', ['-convert', 'json', '-o', '-', path.join(app, 'Contents/Info.plist')], 'APP_PLIST_FAILED'));
  requireCondition(info.CFBundleIdentifier === BUNDLE_ID && info.CFBundleShortVersionString === version && info.CFBundleExecutable === 'PackProof', 'APP_BUNDLE_IDENTITY_MISMATCH');
  const executable = path.join(app, 'Contents/MacOS/PackProof');
  const architectures = command('/usr/bin/lipo', ['-archs', executable], 'APP_ARCHITECTURE_CHECK_FAILED').split(/\s+/);
  requireCondition(architectures.length === 1 && architectures[0] === (arch === 'x64' ? 'x86_64' : 'arm64'), 'APP_ARCHITECTURE_MISMATCH');
  const asar = require('@electron/asar');
  const runtime = JSON.parse(asar.extractFile(path.join(app, 'Contents/Resources/app.asar'), 'dist/main/runtime-config.json').toString('utf8'));
  let api;
  try { api = new URL(runtime.apiBaseUrl); } catch { throw new HarnessError('APP_RUNTIME_API_INVALID'); }
  requireCondition(runtime.channel === 'production' && api.protocol === 'https:' && !api.username && !api.password && !api.search && !api.hash && !['localhost', '127.0.0.1', '[::1]'].includes(api.hostname) && runtime.webBaseUrl === 'https://thepackproof.com' && runtime.updateUrl === `https://downloads.thepackproof.com/desktop/production/darwin/${arch}/` && Boolean(runtime.cognito?.clientId), 'APP_PRODUCTION_RUNTIME_MISMATCH');
  return { bundleId: info.CFBundleIdentifier, version, architecture: architectures[0], signingTeam: teamId, hardenedRuntime: true, codesign: 'passed', staple: 'passed', gatekeeper: 'passed', runtimeChannel: runtime.channel };
}
function assertCleanLocations(app, profile) {
  requireCondition(app === APP && !fs.existsSync(app) && !fs.existsSync(profile), 'PREEXISTING_APP_OR_PROFILE_PRESERVED');
  requireCondition(!fs.lstatSync('/Applications').isSymbolicLink(), 'APPLICATIONS_DIRECTORY_UNEXPECTED');
}
function removeOwnedDirectory(target, allowed, run = command) {
  requireCondition(allowed.has(target), 'CLEANUP_TARGET_NOT_OWNED');
  if (!fs.existsSync(target)) return;
  requireCondition(fs.lstatSync(target).isDirectory() && !fs.lstatSync(target).isSymbolicLink() && fs.realpathSync(target) === target, 'CLEANUP_TARGET_CHANGED');
  try { fs.rmSync(target, { recursive: true, force: false }); }
  catch (error) {
    requireCondition(target === APP && ['EACCES', 'EPERM'].includes(error.code), 'OWNED_DIRECTORY_CLEANUP_FAILED');
    run('/usr/bin/sudo', ['-n', '/bin/rm', '-rf', '--', APP], 'OWNED_APP_CLEANUP_FAILED');
  }
  requireCondition(!fs.existsSync(target), 'OWNED_DIRECTORY_REMAINS');
}

async function runAcceptance(options) {
  const report = { schemaVersion: 1, sourceCommit: options.sourceCommit, harnessSourceCommit: process.env.GITHUB_SHA || null, platform: process.platform, arch: process.arch, channel: 'production', startedAt: new Date().toISOString(), passed: false, installedAcceptanceComplete: false, releaseAuthorized: false, steps: [], launches: [], cleanup: {}, limitations: ['Partial installed-package CI evidence only; not full release acceptance.', 'No older-version update, automatic updater, authenticated account, production Proof, camera, microphone, scanner, real evidence queue, accessibility or physical-device acceptance.', 'A disposable synthetic file is not evidence-queue recovery.', 'Native protected storage is observed through successful runtime initialization and unchanged ciphertext; no installation secret is decrypted or exported.', 'No signing certificate, Gatekeeper policy, sandbox setting or signed application byte is modified.'] };
  const owned = new Set(); let temp, mountPoint, mounted = false, profile, baseline, vaultHash, sentinelHash, candidate, failure;
  async function step(id, work) {
    const record = { id, status: 'running' }; report.steps.push(record); const started = Date.now();
    try { const details = await work(); Object.assign(record, { status: 'passed', elapsedMs: Date.now() - started }, details || {}); return details; }
    catch (error) { Object.assign(record, { status: 'failed', elapsedMs: Date.now() - started, failure: safeFailure(error) }); throw error; }
  }
  function verifyPreserved() {
    return (async () => {
      const vault = path.join(profile, 'Credentials/installation.vault'); plainFile(vault);
      requireCondition(await hash(vault) === vaultHash, 'PROTECTED_INSTALLATION_CHANGED');
      const sentinel = path.join(profile, 'InstalledAcceptanceSynthetic/sentinel.bin'); plainFile(sentinel);
      requireCondition(await hash(sentinel) === sentinelHash, 'SYNTHETIC_SENTINEL_CHANGED');
      return { protectedInstallationCiphertextPreserved: true, syntheticSentinelPreserved: true };
    })();
  }
  async function launch(id) {
    await step(id, async () => {
      const cycle = { phase: id, started: false, rendererReady: false, secureStorage: 'not-reported', shutdown: 'not-started' }; report.launches.push(cycle);
      await launchCycle({ executable: path.join(APP, 'Contents/MacOS/PackProof'), appBundle: APP }, path.join(profile, 'Logs/desktop.log'), cycle, { env: childEnvironment() });
      return { nativeInstalledProcess: true, freshReadiness: cycle.started && cycle.rendererReady, cleanNormalQuit: cycle.exitCode === 0 && cycle.signalCode === null, secureStorage: cycle.secureStorage };
    });
  }
  try {
    await step('native-clean-runner', async () => {
      assertRunner();
      requireCondition(fs.existsSync(options.artifacts) && !fs.lstatSync(options.artifacts).isSymbolicLink(), 'ARTIFACT_DIRECTORY_INVALID');
      const home = fs.realpathSync(os.homedir()); profile = path.join(home, 'Library/Application Support/PackProof');
      assertCleanLocations(APP, profile);
      const policy = command('/usr/sbin/spctl', ['--status'], 'GATEKEEPER_STATUS_FAILED');
      requireCondition(policy.includes('assessments enabled'), 'GATEKEEPER_NOT_ENABLED');
      const existingKey = spawnSync('/usr/bin/security', ['find-generic-password', '-s', 'PackProof Safe Storage'], { encoding: 'utf8', timeout: 10000 });
      requireCondition(existingKey.status === 44 && !existingKey.error, 'PREEXISTING_OR_UNCHECKABLE_KEYCHAIN_ITEM_PRESERVED');
      command('/usr/bin/sudo', ['-n', '/usr/bin/true'], 'CI_INSTALL_PERMISSION_UNAVAILABLE');
      temp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'packproof-installed-'))); owned.add(temp);
      mountPoint = path.join(temp, 'dmg'); fs.mkdirSync(mountPoint);
      return { platform: 'darwin', arch: process.arch, appInitiallyAbsent: true, profileInitiallyAbsent: true, knownAppKeychainItemInitiallyAbsent: true, gatekeeperEnabled: true };
    });
    await step('candidate-byte-identity', async () => {
      candidate = await verifyArtifacts(options.artifacts, options.sourceCommit, process.arch);
      report.version = candidate.version; report.artifacts = candidate.artifacts; report.releaseInventorySha256 = candidate.inventorySha256;
      return { sourceCommit: options.sourceCommit, version: candidate.version, artifactCount: candidate.artifacts.length };
    });
    await step('dmg-notarization-and-readonly-mount', async () => {
      command('/usr/bin/xcrun', ['stapler', 'validate', candidate.dmg], 'DMG_STAPLE_FAILED');
      command('/usr/bin/hdiutil', ['verify', candidate.dmg], 'DMG_IMAGE_VERIFICATION_FAILED', { timeout: 120000 });
      // Mark intent before attach so a partial mount is also detached on failure.
      mounted = true;
      command('/usr/bin/hdiutil', ['attach', '-readonly', '-nobrowse', '-noautoopen', '-mountpoint', mountPoint, candidate.dmg], 'DMG_ATTACH_FAILED', { timeout: 120000 });
      const mounts = command('/sbin/mount', [], 'MOUNT_INSPECTION_FAILED');
      requireCondition(mounts.split('\n').some(line => line.includes(` on ${mountPoint} (`) && line.includes('read-only')), 'DMG_READONLY_NOT_OBSERVED');
      const app = path.join(mountPoint, 'PackProof.app');
      const trust = verifyNativeTrust(app, options.teamId, candidate.version, process.arch);
      baseline = await bundleInventory(app); report.candidateApp = { ...trust, bundleInventorySha256: baseline.digest, fileCount: baseline.fileCount, executableSha256: await hash(path.join(app, 'Contents/MacOS/PackProof')), asarSha256: await hash(path.join(app, 'Contents/Resources/app.asar')) };
      return { readOnly: true, nativeAppTrustPassed: true, bundleInventorySha256: baseline.digest };
    });
    async function copyDmg() {
      requireCondition(!fs.existsSync(APP), 'INSTALL_DESTINATION_BECAME_OCCUPIED');
      fs.mkdirSync(APP); owned.add(APP);
      command('/usr/bin/ditto', [path.join(mountPoint, 'PackProof.app'), APP], 'DMG_APP_COPY_FAILED', { timeout: 120000 });
      verifyNativeTrust(APP, options.teamId, candidate.version, process.arch);
      return assertBundleMatches(APP, baseline);
    }
    await step('dmg-installed-to-applications', copyDmg);
    // The original profile was absent and only this owned installed process may create it.
    owned.add(profile);
    await launch('dmg-installed-first-launch');
    await step('prepare-private-preservation-control', async () => {
      const vault = path.join(profile, 'Credentials/installation.vault'); plainFile(vault); requireCondition(fs.statSync(vault).size >= 32, 'PROTECTED_INSTALLATION_MISSING'); vaultHash = await hash(vault);
      const sentinelDir = path.join(profile, 'InstalledAcceptanceSynthetic'); fs.mkdirSync(sentinelDir, { mode: 0o700 });
      const sentinel = path.join(sentinelDir, 'sentinel.bin'); fs.writeFileSync(sentinel, crypto.randomBytes(64), { flag: 'wx', mode: 0o600 }); sentinelHash = await hash(sentinel);
      return { syntheticBytes: 64, outsideEvidenceQueue: true, credentialBytesAndHashNotExported: true };
    });
    await launch('dmg-normal-relaunch');
    await step('dmg-relaunch-preservation', verifyPreserved);
    await step('same-version-dmg-reinstall', async () => { removeOwnedDirectory(APP, owned); return copyDmg(); });
    await launch('reinstalled-dmg-launch');
    await step('dmg-reinstall-preservation', verifyPreserved);
    if (candidate.pkg) {
      await step('pkg-native-trust', async () => {
        const signature = command('/usr/sbin/pkgutil', ['--check-signature', candidate.pkg], 'PKG_SIGNATURE_FAILED');
        requireCondition(signature.includes(`(${options.teamId})`) && signature.includes('Developer ID Installer'), 'PKG_SIGNING_TEAM_MISMATCH');
        command('/usr/bin/xcrun', ['stapler', 'validate', candidate.pkg], 'PKG_STAPLE_FAILED');
        command('/usr/sbin/spctl', ['--assess', '--type', 'install', '--verbose=4', candidate.pkg], 'PKG_GATEKEEPER_FAILED');
        return { signingTeam: options.teamId, signature: 'passed', staple: 'passed', gatekeeper: 'passed' };
      });
      async function installPkg(clean) {
        if (clean) removeOwnedDirectory(APP, owned);
        // This exact signed, hash-verified candidate is the only installer invoked.
        owned.add(APP);
        command('/usr/bin/sudo', ['-n', '/usr/sbin/installer', '-pkg', candidate.pkg, '-target', '/'], 'PKG_INSTALL_FAILED', { timeout: 180000 });
        verifyNativeTrust(APP, options.teamId, candidate.version, process.arch);
        return assertBundleMatches(APP, baseline);
      }
      await step('pkg-install-and-payload-comparison', () => installPkg(true));
      await launch('pkg-installed-launch');
      await step('pkg-install-preservation', verifyPreserved);
      await step('same-version-pkg-reinstall', () => installPkg(false));
      await launch('reinstalled-pkg-launch');
      await step('pkg-reinstall-preservation', verifyPreserved);
    } else report.steps.push({ id: 'pkg-installed-acceptance', status: 'not-applicable', reason: 'No PKG is present in the verified candidate inventory.' });
    await step('final-signed-byte-identity', async () => { await verifyArtifacts(options.artifacts, options.sourceCommit, process.arch); return { distributedArtifactsUnchanged: true, ...await assertBundleMatches(APP, baseline) }; });
  } catch (error) { failure = error; report.failure = safeFailure(error); }
  finally {
    // Never read/export keychain secrets or remove any keychain item. The disposable
    // runner owns its private keychain lifecycle; pre-existing profiles are untouched.
    for (const target of [APP, profile]) if (target && owned.has(target)) {
      try { removeOwnedDirectory(target, owned); report.cleanup[target === APP ? 'ownedApplication' : 'ownedProfile'] = 'removed'; }
      catch (error) { failure ||= error; report.cleanup[target === APP ? 'ownedApplication' : 'ownedProfile'] = safeFailure(error); }
    }
    if (mounted) {
      try { command('/usr/bin/hdiutil', ['detach', mountPoint], 'OWNED_MOUNT_DETACH_FAILED'); mounted = false; report.cleanup.readonlyMount = 'detached'; }
      catch (error) { failure ||= error; report.cleanup.readonlyMount = safeFailure(error); }
    }
    if (temp && !mounted) { try { removeOwnedDirectory(temp, owned); report.cleanup.ownedTemporaryDirectory = 'removed'; } catch (error) { failure ||= error; report.cleanup.ownedTemporaryDirectory = safeFailure(error); } }
    report.cleanup.keychain = 'No keychain item deleted or exported; isolated hosted runner lifecycle applies.';
    report.passed = !failure;
    report.finishedAt = new Date().toISOString();
    fs.writeFileSync(options.report, JSON.stringify(report, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  }
  if (failure) throw new HarnessError(report.failure?.code || 'INSTALLED_HARNESS_CLEANUP_FAILED');
  return report;
}
async function main() {
  const options = parseArguments(process.argv.slice(2));
  requireCondition(!fs.existsSync(options.report), 'EXISTING_RECEIPT_PRESERVED');
  requireCondition(fs.existsSync(path.dirname(options.report)) && !fs.lstatSync(path.dirname(options.report)).isSymbolicLink(), 'REPORT_PARENT_REQUIRED');
  const report = await runAcceptance(options);
  console.log(JSON.stringify({ passed: report.passed, sourceCommit: report.sourceCommit, harnessSourceCommit: report.harnessSourceCommit, arch: report.arch, installedAcceptanceComplete: false, releaseAuthorized: false }));
}
module.exports = { parseArguments, assertRunner, childEnvironment, safeFailure, verifyArtifacts, bundleInventory, assertBundleMatches, removeOwnedDirectory, command, runAcceptance };
if (require.main === module) main().catch(error => { console.error(JSON.stringify(safeFailure(error))); process.exitCode = 1; });
