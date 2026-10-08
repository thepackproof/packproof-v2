const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const { setAndroidBuildProvenance } = require('../scripts/set-android-build-provenance.cjs');

const sourceSha = 'ab'.repeat(20);
const buildEnv = {
  EAS_BUILD: 'true', EAS_BUILD_PLATFORM: 'android', EAS_BUILD_PROFILE: 'shipping-integration',
  EAS_BUILD_GIT_COMMIT_HASH: sourceSha,
  EXPO_PUBLIC_PACKPROOF_BUILD_SHA: 'cd'.repeat(20),
};

test('Android store builds replace a stale public revision with EAS source metadata for later phases', () => {
  for (const profile of ['internal-staging', 'shipping-integration', 'production']) {
    const calls = [];
    assert.equal(setAndroidBuildProvenance({ ...buildEnv, EAS_BUILD_PROFILE: profile }, (...args) => {
      calls.push(args);
      return { status: 0 };
    }), true);
    assert.equal(calls.length, 1);
    assert.equal(calls[0][0], 'set-env');
    assert.deepEqual(calls[0][1], ['EXPO_PUBLIC_PACKPROOF_BUILD_SHA', sourceSha]);
  }
});

test('missing or invalid build metadata cannot fall back to an older environment revision', () => {
  for (const value of [undefined, '', 'invalid', 'A'.repeat(40), `${sourceSha}\n`]) {
    assert.throws(() => setAndroidBuildProvenance({ ...buildEnv, EAS_BUILD_GIT_COMMIT_HASH: value }, () => {
      assert.fail('set-env must not run without valid build metadata');
    }), /requires a valid EAS source commit/);
  }
});

test('failure to persist the source revision stops the store build without exposing tool output', () => {
  for (const result of [{ status: 1, stderr: 'private worker output' }, { status: null, error: new Error('missing executable') }]) {
    assert.throws(() => setAndroidBuildProvenance(buildEnv, () => result), {
      message: 'Could not bind Android build provenance for subsequent build phases.',
    });
  }
});

test('iOS, ordinary local tasks and development profiles never invoke worker environment changes', () => {
  for (const overrides of [
    { EAS_BUILD_PLATFORM: 'ios' }, { EAS_BUILD: undefined }, { EAS_BUILD: 'false' },
    { EAS_BUILD_PLATFORM: undefined }, { EAS_BUILD_PROFILE: 'development' },
  ]) {
    assert.equal(setAndroidBuildProvenance({ ...buildEnv, ...overrides }, () => {
      assert.fail('Non-release-Android tasks must remain unchanged');
    }), false);
  }
});

function resolveConfig(overrides = {}) {
  return spawnSync(process.execPath, ['-e', 'process.stdout.write(JSON.stringify(require("./app.config.js").expo))'], {
    cwd: path.resolve(__dirname, '..'), encoding: 'utf8',
    env: { ...process.env, ...buildEnv, EXPO_PUBLIC_PACKPROOF_CAMERA_SPIKE: 'false',
      EXPO_PUBLIC_PACKPROOF_AUTH_MODE: 'cognito', EXPO_PUBLIC_PACKPROOF_API_BASE_URL: '', ...overrides },
  });
}

test('Android packaged config records trusted worker source even when a public SHA is stale', () => {
  for (const profile of ['shipping-integration', 'internal-staging']) {
    const result = resolveConfig({ EAS_BUILD_PROFILE: profile });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).extra.packproofBuildSha, sourceSha);
  }
});

test('Android worker config fails closed without source metadata while pre-submission local config remains usable', () => {
  for (const value of ['', 'invalid']) {
    assert.notEqual(resolveConfig({ EAS_BUILD_GIT_COMMIT_HASH: value }).status, 0);
  }
  const local = resolveConfig({ EAS_BUILD: '', EAS_BUILD_GIT_COMMIT_HASH: '' });
  assert.equal(local.status, 0, local.stderr);
  assert.equal(Object.hasOwn(JSON.parse(local.stdout).extra, 'packproofBuildSha'), false);
});

test('provenance metadata cannot alter any iOS config field', () => {
  for (const profile of ['ios-simulator', 'ios-device', 'ios-testflight']) {
    const base = { EAS_BUILD_PLATFORM: 'ios', EAS_BUILD_PROFILE: profile };
    const previous = resolveConfig({ ...base, EAS_BUILD_GIT_COMMIT_HASH: '', EXPO_PUBLIC_PACKPROOF_BUILD_SHA: '' });
    const current = resolveConfig(base);
    assert.equal(previous.status, 0, previous.stderr);
    assert.equal(current.status, 0, current.stderr);
    assert.deepEqual(JSON.parse(current.stdout), JSON.parse(previous.stdout));
    assert.equal(Object.hasOwn(JSON.parse(current.stdout).extra, 'packproofBuildSha'), false);
  }
});
