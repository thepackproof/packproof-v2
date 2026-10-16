const test = require('node:test');
const assert = require('node:assert/strict');
const { argumentsFor, resolveReviewProfile, assertReviewConfig } = require('../scripts/build-local-review.cjs');
const config = require('../eas.json');

test('local review build refuses ambiguous source and output identity', () => {
  assert.throws(() => argumentsFor([]));
  assert.throws(() => argumentsFor(['--expected-sha', 'main', '--out', '/tmp/review']));
  assert.throws(() => argumentsFor(['--expected-sha', 'a'.repeat(40), '--out', 'dist']));
  assert.throws(() => argumentsFor(['--expected-sha', 'a'.repeat(40), '--out', '/tmp/review', '--workers', '0']));
});

test('local review loads inherited HTTPS authentication without changing production profile', () => {
  const profile = resolveReviewProfile(config.build);
  assert.equal(profile.distribution, 'internal');
  assert.equal(profile.android.buildType, 'apk');
  assert.equal(profile.env.EXPO_PUBLIC_PACKPROOF_AUTH_MODE, 'cognito');
  assert.equal(profile.env.PACKPROOF_ANDROID_VERSION_CODE, '66');
  assert.equal(profile.env.EXPO_PUBLIC_PACKPROOF_ANDROID_TASK_FIRST, 'true');
  assert.equal(config.build.production.env.PACKPROOF_ANDROID_VERSION_CODE, '69');
});

test('local review rejects store output, stale versions and inherited profile loops', () => {
  for (const patch of [{ distribution: 'store' }, { android: { buildType: 'app-bundle' } }, { env: { PACKPROOF_ANDROID_VERSION_CODE: '57' } },
    { env: { PACKPROOF_ANDROID_VERSION_CODE: '66', EXPO_PUBLIC_PACKPROOF_ANDROID_TASK_FIRST: 'false' } }, { extends: 'mobile-ux-review' }]) {
    const profiles = structuredClone(config.build);
    Object.assign(profiles['mobile-ux-review'], patch);
    assert.throws(() => resolveReviewProfile(profiles));
  }
});

test('actual review config must retain source, role flags and media protections', () => {
  const sha = 'a'.repeat(40);
  const expo = { version: '1.0.1', android: { package: 'com.packproof.mobile', versionCode: 66, allowBackup: false, usesCleartextTraffic: false }, extra: {
    packproofInternalReview: true, packproofMobileTaskUx: true, packproofFirstProofExperience: true, packproofBuildSha: sha,
    packproofResearch: false, packproofResearchProduction: false,
  } };
  assert.doesNotThrow(() => assertReviewConfig(expo, sha));
  for (const change of [e => e.android.package = 'com.packproof.mobile.research', e => e.android.allowBackup = true,
    e => e.android.usesCleartextTraffic = true, e => e.extra.packproofBuildSha = 'b'.repeat(40),
    e => e.extra.packproofInternalReview = false, e => e.extra.packproofResearch = true]) {
    const other = structuredClone(expo); change(other); assert.throws(() => assertReviewConfig(other, sha));
  }
});
