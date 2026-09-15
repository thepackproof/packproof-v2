const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const profiles = require('../eas.json');

function config(env = {}) {
  return spawnSync(process.execPath, ['-e', 'process.stdout.write(JSON.stringify(require("./app.config.js").expo))'], {
    cwd: path.resolve(__dirname, '..'), encoding: 'utf8',
    env: { ...process.env, EXPO_PUBLIC_PACKPROOF_CAMERA_SPIKE: 'false', EXPO_PUBLIC_PACKPROOF_AUTH_MODE: 'cognito',
      EXPO_PUBLIC_PACKPROOF_API_BASE_URL: '', PACKPROOF_IOS_BUILD_NUMBER: '1', ...env },
  });
}

for (const profile of ['ios-simulator', 'ios-device', 'ios-testflight']) {
  test(`${profile} resolves the production app identity and authenticated HTTPS API`, () => {
    const result = config({ EAS_BUILD_PROFILE: profile });
    assert.equal(result.status, 0, result.stderr);
    const app = JSON.parse(result.stdout);
    assert.equal(app.ios.bundleIdentifier, 'com.packproof.mobile');
    assert.deepEqual(app.scheme, ['packproof-v2', 'packproof']);
    assert.match(app.extra.packproofApiBaseUrl, /^https:\/\//);
    assert.ok(app.ios.infoPlist.NSFaceIDUsageDescription);
    assert.ok(app.ios.infoPlist.NSCameraUsageDescription);
    assert.equal(app.ios.infoPlist.UIFileSharingEnabled, false);
    assert.equal(app.ios.infoPlist.LSSupportsOpeningDocumentsInPlace, false);
    assert.ok(!app.ios.infoPlist.NSMicrophoneUsageDescription);
  });
  for (const unsafe of [
    { EXPO_PUBLIC_PACKPROOF_AUTH_MODE: 'dev' },
    { EXPO_PUBLIC_PACKPROOF_API_BASE_URL: 'http://localhost:3000' },
    { EXPO_PUBLIC_PACKPROOF_API_BASE_URL: 'https://localhost:3000' },
    { EXPO_PUBLIC_PACKPROOF_CAMERA_SPIKE: 'true' },
  ]) test(`${profile} refuses unsafe configuration ${JSON.stringify(unsafe)}`, () => {
    assert.notEqual(config({ EAS_BUILD_PROFILE: profile, ...unsafe }).status, 0);
  });
}

test('iOS profiles share current Android feature flags and use an iOS 26 build image', () => {
  const release = profiles.build['ios-testflight'];
  assert.deepEqual(release.env, {
    ...profiles.build['internal-staging'].env, ...profiles.build['shipping-integration'].env,
  });
  assert.match(release.ios.image, /xcode-26\./);
  assert.equal(release.distribution, 'store');
  assert.equal(profiles.build['ios-simulator'].ios.simulator, true);
  assert.equal(profiles.build['ios-device'].distribution, 'internal');
});

test('Apple build number can advance without changing the Android release identity', () => {
  const result = config({ EAS_BUILD_PROFILE: 'ios-testflight', PACKPROOF_IOS_BUILD_NUMBER: '12' });
  assert.equal(result.status, 0, result.stderr);
  const app = JSON.parse(result.stdout);
  assert.equal(app.ios.buildNumber, '12');
  assert.equal(app.android.versionCode, 50);
  assert.notEqual(config({ PACKPROOF_IOS_BUILD_NUMBER: 'invalid' }).status, 0);
});
