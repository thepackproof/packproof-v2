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
  assert.equal(config.version,'0.3.7');
  assert.equal(config.android.versionCode,36);
  assert.equal(config.android.package,'com.packproof.mobile');
  assert.equal(config.android.allowBackup,false);
});

test('native Gradle outputs are ignored while local module source remains part of release identity', () => {
  for(const moduleName of ['packproof-attestation','packproof-unified-camera']){
    for(const [suffix,expected] of [['build/outputs/aar/module-debug.aar',0],['src/main/AndroidManifest.xml',1],['build.gradle',1]]){
      const result=spawnSync('git',['check-ignore','--no-index',`modules/${moduleName}/android/${suffix}`],{cwd:path.resolve(__dirname,'..'),encoding:'utf8'});
      assert.equal(result.status,expected,result.stderr);
    }
  }
});
