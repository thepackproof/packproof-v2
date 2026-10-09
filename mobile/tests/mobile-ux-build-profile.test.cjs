const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const profiles = require('../eas.json');
const { setAndroidBuildProvenance } = require('../scripts/set-android-build-provenance.cjs');
const { artifactValidationCommand } = require('../scripts/verify-eas-android-release.cjs');
const sha = 'ab'.repeat(20);
function resolvedProfile(name) { const value=profiles.build[name]; return {...(value.extends?resolvedProfile(value.extends):{}),...value,env:{...(value.extends?resolvedProfile(value.extends).env:{}),...value.env},android:{...(value.extends?resolvedProfile(value.extends).android:{}),...value.android}}; }
const review=resolvedProfile('mobile-ux-review');
function config(overrides={}) {
  return spawnSync(process.execPath,['-e','process.stdout.write(JSON.stringify(require("./app.config.js").expo))'],{
    cwd:path.resolve(__dirname,'..'),encoding:'utf8',env:{...process.env,...review.env,EAS_BUILD_PROFILE:'mobile-ux-review',EAS_BUILD_PLATFORM:'android',EAS_BUILD:'true',EAS_BUILD_GIT_COMMIT_HASH:sha,EXPO_PUBLIC_PACKPROOF_CAMERA_SPIKE:'false',...overrides},
  });
}
test('internal review inherits authenticated shipping runtime and signing while creating version 57 APK only',()=>{
  assert.equal(review.distribution,'internal');assert.equal(review.android.buildType,'apk');
  assert.equal(review.android.keystoreName,profiles.build['internal-staging'].android.keystoreName);
  assert.equal(review.android.credentialsSource,'remote');
  assert.equal(review.env.PACKPROOF_ANDROID_VERSION_CODE,'57');
  assert.equal(review.env.EXPO_PUBLIC_PACKPROOF_IN_VIDEO_SHIPPING,'true');
  assert.equal(review.env.EXPO_PUBLIC_PACKPROOF_MOBILE_TASK_UX,'true');
  assert.equal(review.env.EXPO_PUBLIC_PACKPROOF_AUTH_MODE,'cognito');
  assert.equal(profiles.submit['mobile-ux-review'],undefined);
  assert.equal(profiles.build['shipping-integration'].env.PACKPROOF_ANDROID_VERSION_CODE,'56');
});
test('internal review config has worker source identity and keeps release authentication and media guards',()=>{
  const result=config();assert.equal(result.status,0,result.stderr);const app=JSON.parse(result.stdout);
  assert.equal(app.android.versionCode,57);assert.equal(app.android.package,'com.packproof.mobile');
  assert.equal(app.android.allowBackup,false);assert.equal(app.android.usesCleartextTraffic,false);
  assert.equal(app.extra.packproofBuildSha,sha);assert.equal(app.extra.packproofMobileTaskUx,true);assert.equal(app.extra.packproofInternalReview,true);
  for(const overrides of [{EAS_BUILD_GIT_COMMIT_HASH:''},{EXPO_PUBLIC_PACKPROOF_AUTH_MODE:'dev'},{EXPO_PUBLIC_PACKPROOF_API_BASE_URL:'http://localhost:3000'},{EXPO_PUBLIC_PACKPROOF_CAMERA_SPIKE:'true'}]) assert.notEqual(config(overrides).status,0);
});
test('review worker binds Metro to its source and uses APK validation without changing store AAB checks',()=>{
  const calls=[];
  assert.equal(setAndroidBuildProvenance({EAS_BUILD:'true',EAS_BUILD_PLATFORM:'android',EAS_BUILD_PROFILE:'mobile-ux-review',EAS_BUILD_GIT_COMMIT_HASH:sha},(...args)=>{calls.push(args);return {status:0};}),true);
  assert.deepEqual(calls[0][1],['EXPO_PUBLIC_PACKPROOF_BUILD_SHA',sha]);
  assert.match(artifactValidationCommand({EAS_BUILD_PLATFORM:'android',EAS_BUILD_PROFILE:'mobile-ux-review'})[1],/app-release\.apk$/);
  for(const profile of ['internal-staging','shipping-integration','production']) assert.match(artifactValidationCommand({EAS_BUILD_PLATFORM:'android',EAS_BUILD_PROFILE:profile})[1],/app-release\.aab$/);
  assert.equal(artifactValidationCommand({EAS_BUILD_PLATFORM:'ios',EAS_BUILD_PROFILE:'ios-simulator'}),null);
});
test('native startup bars match dark task UX and retain the light rollback composition',()=>{
  const enabled=JSON.parse(config().stdout);
  const disabled=JSON.parse(config({EXPO_PUBLIC_PACKPROOF_MOBILE_TASK_UX:'false'}).stdout);
  for(const key of ['androidStatusBar','androidNavigationBar']) {
    assert.equal(enabled[key].backgroundColor,'#141D2A');assert.equal(enabled[key].barStyle,'light-content');
    assert.equal(disabled[key].backgroundColor,'#E9EEF4');assert.equal(disabled[key].barStyle,'dark-content');
  }
  assert.deepEqual(enabled.android,disabled.android);
  assert.deepEqual(enabled.ios,disabled.ios);
});
