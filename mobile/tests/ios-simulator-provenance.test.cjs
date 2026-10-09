const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const { setIosSimulatorBuildProvenance } = require('../scripts/set-android-build-provenance.cjs');
const profiles = require('../eas.json');
const sourceSha = 'ab'.repeat(20);
const buildEnv = { EAS_BUILD:'true', EAS_BUILD_PLATFORM:'ios', EAS_BUILD_PROFILE:'ios-simulator', EAS_BUILD_GIT_COMMIT_HASH:sourceSha, EXPO_PUBLIC_PACKPROOF_BUILD_SHA:'cd'.repeat(20) };

test('simulator review replaces stale shared source only for this worker', () => {
  const calls=[];
  assert.equal(setIosSimulatorBuildProvenance(buildEnv,(...args)=>{calls.push(args);return {status:0};}),true);
  assert.deepEqual(calls[0][1],['EXPO_PUBLIC_PACKPROOF_BUILD_SHA',sourceSha]);
  assert.equal(profiles.build['ios-simulator'].env.EXPO_PUBLIC_PACKPROOF_MOBILE_TASK_UX,'true');
  assert.equal(profiles.build['ios-simulator'].distribution,'internal');
  assert.equal(profiles.build['ios-simulator'].ios.simulator,true);
});

test('simulator source binding fails closed on missing metadata or worker failure',()=>{
  for(const source of [undefined,'','invalid','A'.repeat(40)]) assert.throws(()=>setIosSimulatorBuildProvenance({...buildEnv,EAS_BUILD_GIT_COMMIT_HASH:source},()=>assert.fail()),/requires a valid EAS source commit/);
  assert.throws(()=>setIosSimulatorBuildProvenance(buildEnv,()=>({status:1,stderr:'private worker output'})),{message:'Could not bind iOS simulator build provenance for subsequent build phases.'});
});

test('simulator binding never affects signed iOS, Android, or local work',()=>{
  for(const change of [{EAS_BUILD_PROFILE:'ios-testflight'},{EAS_BUILD_PROFILE:'ios-device'},{EAS_BUILD_PLATFORM:'android'},{EAS_BUILD:'false'}]) assert.equal(setIosSimulatorBuildProvenance({...buildEnv,...change},()=>assert.fail()),false);
});

test('simulator packaged config uses worker source and allows local configuration before dispatch',()=>{
  function config(overrides={}) { return spawnSync(process.execPath,['-e','process.stdout.write(JSON.stringify(require("./app.config.js").expo))'],{cwd:path.resolve(__dirname,'..'),encoding:'utf8',env:{...process.env,...buildEnv,EXPO_PUBLIC_PACKPROOF_AUTH_MODE:'cognito',EXPO_PUBLIC_PACKPROOF_CAMERA_SPIKE:'false',EXPO_PUBLIC_PACKPROOF_API_BASE_URL:'',EXPO_PUBLIC_PACKPROOF_MOBILE_TASK_UX:'true',...overrides}}); }
  const result=config();assert.equal(result.status,0,result.stderr);
  const app=JSON.parse(result.stdout);assert.equal(app.extra.packproofBuildSha,sourceSha);assert.equal(app.extra.packproofInternalReview,true);assert.equal(app.extra.packproofMobileTaskUx,true);
  assert.notEqual(config({EAS_BUILD_GIT_COMMIT_HASH:''}).status,0);
  assert.equal(config({EAS_BUILD:'',EAS_BUILD_GIT_COMMIT_HASH:''}).status,0);
});
