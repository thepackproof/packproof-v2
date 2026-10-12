'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { parseArguments, assertRunner, childEnvironment, safeFailure, verifyArtifacts, bundleInventory, assertBundleMatches, removeOwnedDirectory, command, runAcceptance } = require('../scripts/mac-installed-acceptance.cjs');
const SOURCE = 'a'.repeat(40);
function temporary(t) { const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'packproof-installed-test-'))); t.after(() => fs.rmSync(dir, { recursive: true, force: true })); return dir; }
function candidate(dir) {
  const artifacts = [];
  for (const ext of ['dmg', 'zip', 'pkg']) {
    const file = `PackProof-1.0.1-arm64.${ext}`, bytes = Buffer.from(`synthetic ${ext}`);
    fs.writeFileSync(path.join(dir, file), bytes);
    artifacts.push({ file, bytes: bytes.length, sha256: crypto.createHash('sha256').update(bytes).digest('hex') });
  }
  const value = { schemaVersion: 1, version: '1.0.1', sourceCommit: SOURCE, platform: 'darwin', arch: 'arm64', channel: 'production', signed: true, updateUrl: 'https://downloads.thepackproof.com/desktop/production/darwin/arm64/', checks: ['codesign-valid', 'apple-team-matches', 'hardened-runtime', 'notarized', 'stapled', 'gatekeeper-accepted'], artifacts };
  writeInventory(dir, value); return value;
}
function writeInventory(dir, value) { fs.writeFileSync(path.join(dir, 'release-evidence.json'), JSON.stringify(value)); fs.writeFileSync(path.join(dir, 'SHA256SUMS'), value.artifacts.map(item => `${item.sha256}  ${item.file}\n`).join('')); }

test('installed harness admits only explicit complete native candidate parameters', () => {
  const args = ['--artifacts', path.resolve('candidate'), '--source-commit', SOURCE, '--team-id', 'ABCDE12345', '--report', path.resolve('receipt.json')];
  assert.equal(parseArguments(args).sourceCommit, SOURCE);
  for (const bad of [[], [...args, '--no-sandbox', 'true'], [...args, '--source-commit', SOURCE], args.slice(0, -1), args.map(x => x === SOURCE ? 'branch-name' : x), args.map(x => x === 'ABCDE12345' ? 'unverified' : x)]) assert.throws(() => parseArguments(bad));
});

test('native execution is limited to disposable GitHub-hosted native macOS and exposes no workflow credentials to app', () => {
  const env = { CI: 'true', GITHUB_ACTIONS: 'true', RUNNER_ENVIRONMENT: 'github-hosted', GITHUB_SHA: SOURCE, HOME: '/Users/runner', PATH: '/usr/bin', GITHUB_TOKEN: 'private', CSC_KEY_PASSWORD: 'private', NODE_OPTIONS: '--require injected', ELECTRON_DISABLE_SANDBOX: '1' };
  assert.doesNotThrow(() => assertRunner(env, 'darwin', 'arm64'));
  for (const [changed, platform, arch] of [[{ ...env, CI: 'false' }, 'darwin', 'arm64'], [{ ...env, RUNNER_ENVIRONMENT: 'self-hosted' }, 'darwin', 'arm64'], [env, 'win32', 'x64'], [env, 'darwin', 'ia32'], [{ ...env, GITHUB_SHA: '' }, 'darwin', 'x64']]) assert.throws(() => assertRunner(changed, platform, arch));
  assert.deepEqual(childEnvironment(env), { HOME: '/Users/runner', PATH: '/usr/bin' });
});

test('all distributed package bytes and checksum inventory must match exact source and native architecture', async t => {
  const dir = temporary(t); const value = candidate(dir);
  const result = await verifyArtifacts(dir, SOURCE, 'arm64'); assert.ok(result.pkg.endsWith('.pkg')); assert.equal(result.artifacts.length, 3);
  await assert.rejects(verifyArtifacts(dir, 'b'.repeat(40), 'arm64'), /IDENTITY_MISMATCH/);
  await assert.rejects(verifyArtifacts(dir, SOURCE, 'x64'), /IDENTITY_MISMATCH/);
  fs.appendFileSync(path.join(dir, value.artifacts[0].file), 'tamper');
  await assert.rejects(verifyArtifacts(dir, SOURCE, 'arm64'), /HASH_MISMATCH/);
});

test('shipped PKG cannot be silently excluded and alias bytes cannot select a different candidate', async t => {
  const dir = temporary(t); let value = candidate(dir);
  value.artifacts = value.artifacts.filter(item => !item.file.endsWith('.pkg')); writeInventory(dir, value);
  await assert.rejects(verifyArtifacts(dir, SOURCE, 'arm64'), /UNLISTED_CANDIDATE_PACKAGE/);
  value = candidate(dir);
  fs.copyFileSync(path.join(dir, value.artifacts[1].file), path.join(dir, 'PackProof.dmg'));
  value.artifacts.push({ ...value.artifacts[1], file: 'PackProof.dmg' }); writeInventory(dir, value);
  await assert.rejects(verifyArtifacts(dir, SOURCE, 'arm64'), /ALIAS_MISMATCH/);
});

test('traversal, duplicate package inventory and detached checksum edits are rejected', async t => {
  const dir = temporary(t); let value = candidate(dir);
  value.artifacts[0].file = '../PackProof-1.0.1-arm64.dmg'; writeInventory(dir, value);
  await assert.rejects(verifyArtifacts(dir, SOURCE, 'arm64'), /FILE_ENTRY_INVALID/);
  value = candidate(dir); value.artifacts.push(value.artifacts[0]); writeInventory(dir, value);
  await assert.rejects(verifyArtifacts(dir, SOURCE, 'arm64'), /FILE_ENTRY_INVALID/);
  candidate(dir); fs.appendFileSync(path.join(dir, 'SHA256SUMS'), '0'.repeat(64) + '  forged.pkg\n');
  await assert.rejects(verifyArtifacts(dir, SOURCE, 'arm64'), /SHA256SUMS_MISMATCH/);
});

test('installed bundle identity includes every file and symlink, not only executable or asar', async t => {
  const dir = temporary(t), first = path.join(dir, 'original'), second = path.join(dir, 'installed');
  fs.mkdirSync(first); fs.writeFileSync(path.join(first, 'binary'), 'same executable'); fs.mkdirSync(path.join(first, 'Resources')); fs.writeFileSync(path.join(first, 'Resources', 'config.json'), '{}');
  fs.cpSync(first, second, { recursive: true }); const inventory = await bundleInventory(first);
  assert.equal((await assertBundleMatches(second, inventory)).exactFilesAndSymlinksMatch, true);
  fs.writeFileSync(path.join(second, 'Resources', 'config.json'), '{"changed":true}');
  await assert.rejects(assertBundleMatches(second, inventory), /BUNDLE_BYTES_MISMATCH/);
  fs.symlinkSync(dir, path.join(first, 'outside'), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(bundleInventory(first), /BUNDLE_SYMLINK_ESCAPES/);
});

test('cleanup requires explicit ownership and preserves pre-existing targets', t => {
  const dir = temporary(t), owned = path.join(dir, 'owned'), other = path.join(dir, 'other'); fs.mkdirSync(owned); fs.mkdirSync(other); fs.writeFileSync(path.join(other, 'valuable'), 'keep');
  assert.throws(() => removeOwnedDirectory(other, new Set([owned])), /NOT_OWNED/);
  assert.equal(fs.readFileSync(path.join(other, 'valuable'), 'utf8'), 'keep');
  removeOwnedDirectory(owned, new Set([owned])); assert.equal(fs.existsSync(owned), false);
});

test('command failures retain fixed step/status details without private stderr or argument contents', () => {
  let caught;
  try { command('/usr/bin/example', ['private-value'], 'NATIVE_VERIFICATION_FAILED', { run: () => ({ status: 9, stderr: 'credential=private-value', stdout: 'private-user-record' }) }); } catch (error) { caught = error; }
  assert.deepEqual(safeFailure(caught), { code: 'NATIVE_VERIFICATION_FAILED', exitStatus: 9, signal: null, timedOut: false });
  assert.deepEqual(safeFailure(new Error('private-user-record')), { code: 'INSTALLED_HARNESS_STEP_FAILED' });
  assert.deepEqual(safeFailure(new Error('Native application reported SECURE_STORAGE_OR_QUEUE_UNAVAILABLE.')), { code: 'SECURE_STORAGE_OR_QUEUE_UNAVAILABLE' });
});

test('a rejected host retains a failed partial receipt without claiming install or release acceptance', async t => {
  const dir = temporary(t), report = path.join(dir, 'failed.json');
  const old = process.env.CI; process.env.CI = 'false';
  try { await assert.rejects(runAcceptance({ artifacts: dir, sourceCommit: SOURCE, teamId: 'ABCDE12345', report }), /DISPOSABLE_GITHUB_HOSTED_CI_REQUIRED/); }
  finally { if (old === undefined) delete process.env.CI; else process.env.CI = old; }
  const value = JSON.parse(fs.readFileSync(report, 'utf8'));
  assert.equal(value.passed, false); assert.equal(value.installedAcceptanceComplete, false); assert.equal(value.releaseAuthorized, false); assert.equal(value.launches.length, 0);
  assert.equal(value.steps[0].status, 'failed'); assert.equal(value.failure.code, 'DISPOSABLE_GITHUB_HOSTED_CI_REQUIRED');
});
