const test = require('node:test');
const assert = require('node:assert/strict');
const {spawnSync} = require('node:child_process');
const path = require('node:path');

test('next standard Android candidate advances the installed baseline and retains account media protection', () => {
  const result=spawnSync(process.execPath,['-e','process.stdout.write(JSON.stringify(require("./app.config.js").expo))'],{
    cwd:path.resolve(__dirname,'..'),encoding:'utf8',
    env:{...process.env,EAS_BUILD_PROFILE:'',EXPO_PUBLIC_PACKPROOF_CAMERA_SPIKE:'false'},
  });
  assert.equal(result.status,0,result.stderr);
  const config=JSON.parse(result.stdout);
  assert.equal(config.version,'0.3.22');
  assert.equal(config.android.versionCode,51);
  assert.equal(config.android.package,'com.packproof.mobile');
  assert.equal(config.android.allowBackup,false);
});

test('registered APK uses the requested package and its existing key with production authentication', () => {
  const profiles = require('../eas.json').build;
  assert.equal(profiles['registered-apk'].android.buildType, 'apk');
  assert.equal(profiles['registered-apk'].android.keystoreName, 'PackProof Android Release');
  assert.equal(profiles['internal-staging'].android.keystoreName, 'Build Credentials pdbJYV45vI');
  for (const profile of ['registered-apk', 'shipping-integration']) {
    const run = (overrides = {}) => spawnSync(process.execPath, ['-e', 'process.stdout.write(JSON.stringify(require("./app.config.js").expo))'], {
      cwd: path.resolve(__dirname, '..'), encoding: 'utf8',
      env: {...process.env, EAS_BUILD_PROFILE: profile, EXPO_PUBLIC_PACKPROOF_CAMERA_SPIKE: 'false', EXPO_PUBLIC_PACKPROOF_AUTH_MODE: 'cognito', ...overrides},
    });
    const result = run();
    assert.equal(result.status, 0, result.stderr);
    const config = JSON.parse(result.stdout);
    assert.equal(config.android.package, profile === 'registered-apk' ? 'com.packproof.app' : 'com.packproof.mobile');
    assert.equal(config.android.usesCleartextTraffic, false);
    assert.equal(config.android.allowBackup, false);
    assert.notEqual(run({EXPO_PUBLIC_PACKPROOF_AUTH_MODE: 'dev'}).status, 0);
    assert.notEqual(run({PACKPROOF_ANDROID_VERSION_CODE: '50'}).status, 0);
  }
});

test('native Gradle outputs are ignored while local module source remains part of release identity', () => {
  for(const moduleName of ['packproof-attestation','packproof-unified-camera']){
    for(const [suffix,expected] of [['build/outputs/aar/module-debug.aar',0],['src/main/AndroidManifest.xml',1],['build.gradle',1]]){
      const result=spawnSync('git',['check-ignore','--no-index',`modules/${moduleName}/android/${suffix}`],{cwd:path.resolve(__dirname,'..'),encoding:'utf8'});
      assert.equal(result.status,expected,result.stderr);
    }
  }
});
