const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { configureIosStoreBuild } = require('../scripts/configure-ios-store-build.cjs');
const { setIosStoreBuildProvenance } = require('../scripts/set-android-build-provenance.cjs');
const profiles = require('../eas.json');
const source = 'ab'.repeat(20);
const runner = { GITHUB_SHA: source, EXPO_PUBLIC_PACKPROOF_BUILD_SHA: source, PACKPROOF_IOS_BUILD_NUMBER: '80' };
const worker = { EAS_BUILD: 'true', EAS_BUILD_PLATFORM: 'ios', EAS_BUILD_PROFILE: 'ios-testflight', EAS_BUILD_GIT_COMMIT_HASH: source };

function resolve(env) {
  return spawnSync(process.execPath, ['-e', 'process.stdout.write(JSON.stringify(require("./app.config.js").expo))'], {
    cwd: path.resolve(__dirname, '..'), encoding: 'utf8',
    env: { ...process.env, PACKPROOF_IOS_BUILD_NUMBER: '', PACKPROOF_EXPECTED_SOURCE_SHA: '',
      EXPO_PUBLIC_PACKPROOF_CAMERA_SPIKE: 'false', EXPO_PUBLIC_PACKPROOF_AUTH_MODE: 'cognito', ...env },
  });
}

test('serialized EAS profile carries the exact build number across the runner/worker boundary', () => {
  const configured = configureIosStoreBuild(structuredClone(profiles), runner);
  const remote = JSON.parse(JSON.stringify(configured)).build['ios-testflight'].env;
  const calls = [];
  assert.equal(setIosStoreBuildProvenance({ ...remote, ...worker }, (...args) => { calls.push(args); return { status: 0 }; }), true);
  assert.deepEqual(calls[0][1], ['EXPO_PUBLIC_PACKPROOF_BUILD_SHA', source]);
  const result = resolve({ ...remote, ...worker, EXPO_PUBLIC_PACKPROOF_BUILD_SHA: 'cd'.repeat(20) });
  assert.equal(result.status, 0, result.stderr);
  const app = JSON.parse(result.stdout);
  assert.equal(app.ios.buildNumber, '80');
  assert.equal(app.extra.packproofBuildSha, source);
  assert.equal(app.extra.packproofFirstProofExperience, true);
  assert.equal(app.extra.packproofInternalReview, undefined);
  const expected = structuredClone(profiles);
  expected.build['ios-testflight'].env = remote;
  assert.deepEqual(configured, expected, 'No signing, Android or feature configuration changes');
});

test('profile preparation rejects invalid source, baseline numbers and changed signing without mutating config', () => {
  for (const bad of [{ GITHUB_SHA: 'cd'.repeat(20) }, { EXPO_PUBLIC_PACKPROOF_BUILD_SHA: '' },
    ...['', '1', '5', '1.2', '-1', '9007199254740992'].map(value => ({ PACKPROOF_IOS_BUILD_NUMBER: value }))]) {
    const config = structuredClone(profiles);
    assert.throws(() => configureIosStoreBuild(config, { ...runner, ...bad }));
    assert.deepEqual(config, profiles);
  }
  const config = structuredClone(profiles); config.build['ios-testflight'].ios.credentialsSource = 'local';
  assert.throws(() => configureIosStoreBuild(config, runner), /signing profile/);
});

test('worker refuses missing or mismatched source and lost build number before building', () => {
  const remote = configureIosStoreBuild(structuredClone(profiles), runner).build['ios-testflight'].env;
  for (const bad of [{ EAS_BUILD_GIT_COMMIT_HASH: '' }, { EAS_BUILD_GIT_COMMIT_HASH: 'cd'.repeat(20) },
    { PACKPROOF_EXPECTED_SOURCE_SHA: '' }, { PACKPROOF_IOS_BUILD_NUMBER: '' }, { PACKPROOF_IOS_BUILD_NUMBER: '1' }]) {
    assert.throws(() => setIosStoreBuildProvenance({ ...remote, ...worker, ...bad }, () => assert.fail()));
  }
  for (const bad of [{ EAS_BUILD_GIT_COMMIT_HASH: '' }, { PACKPROOF_IOS_BUILD_NUMBER: '' }, { PACKPROOF_IOS_BUILD_NUMBER: '1' }]) {
    assert.notEqual(resolve({ ...remote, ...worker, ...bad }).status, 0);
  }
  assert.throws(() => setIosStoreBuildProvenance({ ...remote, ...worker }, () => ({ status: 1, stderr: 'private' })), {
    message: 'Could not bind iOS store build provenance for subsequent build phases.',
  });
});

test('signed iOS hook cannot alter Android, simulator, internal-device or local builds', () => {
  for (const bad of [{ EAS_BUILD_PLATFORM: 'android' }, { EAS_BUILD_PROFILE: 'production' },
    { EAS_BUILD_PROFILE: 'ios-simulator' }, { EAS_BUILD_PROFILE: 'ios-device' }, { EAS_BUILD: '' }]) {
    assert.equal(setIosStoreBuildProvenance({ ...worker, ...bad }, () => assert.fail()), false);
  }
});

test('producer verifies downloaded package before declaring success and retains frozen credentials', () => {
  const workflow = require('js-yaml').load(fs.readFileSync(path.resolve(__dirname, '../../.github/workflows/ios.yml'), 'utf8'));
  const command = workflow.jobs['app-store'].steps.find(step => step.name === 'Build with existing remote Apple signing credentials').run;
  assert.ok(command.indexOf('node scripts/configure-ios-store-build.cjs') < command.indexOf('eas-cli@'));
  assert.match(command, /--freeze-credentials --non-interactive/);
  assert.match(command, /release\.verify_build\(value, source, build\['id'\], number\)/);
  assert.match(command, /release\.verify_ipa\(Path\('dist\/PackProof\.ipa'\), source, number\)/);
  assert.match(command, /set -euo pipefail/);
});
