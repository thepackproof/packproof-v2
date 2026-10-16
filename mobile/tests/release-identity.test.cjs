const test = require('node:test');
const assert = require('node:assert/strict');
const {spawnSync} = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

function productionConfig(overrides = {}) {
  return spawnSync(process.execPath, ['-e', 'process.stdout.write(JSON.stringify(require("./app.config.js").expo))'], {
    cwd: path.resolve(__dirname, '..'), encoding: 'utf8',
    env: {...process.env, EAS_BUILD_PROFILE: 'production', EAS_BUILD_PLATFORM: 'android', EAS_BUILD: 'true',
      EAS_BUILD_GIT_COMMIT_HASH: 'ab'.repeat(20), EXPO_PUBLIC_PACKPROOF_BUILD_SHA: 'cd'.repeat(20),
      PACKPROOF_ANDROID_VERSION_CODE: '69', EXPO_PUBLIC_PACKPROOF_CAMERA_SPIKE: 'false',
      EXPO_PUBLIC_PACKPROOF_AUTH_MODE: 'cognito', EXPO_PUBLIC_PACKPROOF_API_BASE_URL: 'https://api.example.com',
      EXPO_PUBLIC_PACKPROOF_RND_PRODUCTION: 'true', EXPO_PUBLIC_PACKPROOF_RND: 'false', EXPO_PUBLIC_PACKPROOF_MOBILE_TASK_UX: 'true', EXPO_PUBLIC_PACKPROOF_FIRST_PROOF_EXPERIENCE: 'true', ...overrides},
  });
}

test('production profile pins store AAB 69 and retains the existing runtime and upload key', () => {
  const config = require('../eas.json');
  const production = config.build.production;
  assert.ok(production, 'Android production profile is required');
  assert.equal(production.extends, 'shipping-integration');
  assert.equal(production.environment, 'production');
  assert.equal(production.env.PACKPROOF_ANDROID_VERSION_CODE, '69');
  assert.equal(production.env.EXPO_PUBLIC_PACKPROOF_ANDROID_TASK_FIRST, 'true');
  assert.equal(production.env.EXPO_PUBLIC_PACKPROOF_MOBILE_TASK_UX, 'true');
  assert.equal(production.env.EXPO_PUBLIC_PACKPROOF_RND_PRODUCTION, 'true');
  const shipping = config.build[production.extends];
  const base = config.build[shipping.extends];
  assert.equal(base.distribution, 'store');
  assert.equal(base.android.buildType, 'app-bundle');
  assert.equal(base.android.credentialsSource, 'remote');
  assert.equal(base.android.keystoreName, 'Build Credentials pdbJYV45vI');
  assert.equal(base.env.EXPO_PUBLIC_PACKPROOF_AUTH_MODE, 'cognito');
  assert.equal(shipping.env.EXPO_PUBLIC_PACKPROOF_IN_VIDEO_SHIPPING, 'true');
  assert.equal(config.submit.production, undefined, 'Building does not automatically submit to a Play track');
});

test('production config binds worker source, authenticated release guards and UX without a review marker', () => {
  const result = productionConfig();
  assert.equal(result.status, 0, result.stderr);
  const app = JSON.parse(result.stdout);
  assert.equal(app.version, '1.0.1');
  assert.equal(app.android.versionCode, 69);
  assert.equal(app.android.package, 'com.packproof.mobile');
  assert.equal(app.extra.eas.projectId, '0196c3f7-cb3a-472c-99be-825558f227e8');
  assert.equal(app.android.allowBackup, false);
  assert.equal(app.android.usesCleartextTraffic, false);
  assert.equal(app.extra.packproofBuildSha, 'ab'.repeat(20));
  assert.equal(app.extra.packproofMobileTaskUx, true);
  assert.equal(app.extra.packproofFirstProofExperience, true);
  assert.equal(app.extra.packproofResearchProduction, true);
  assert.equal(app.extra.packproofResearchProfile, 'capture-receipts-v1');
  assert.equal(Object.hasOwn(app.extra, 'packproofInternalReview'), false);
  const rollback = productionConfig({EXPO_PUBLIC_PACKPROOF_MOBILE_TASK_UX: 'false'});
  assert.equal(rollback.status, 0, rollback.stderr);
  assert.equal(JSON.parse(rollback.stdout).extra.packproofMobileTaskUx, false);
});

test('production refuses stale version, missing worker source, development auth, camera spike and wrong platform', () => {
  for (const [overrides, error] of [
    [{PACKPROOF_ANDROID_VERSION_CODE: '56'}, /Production Android versionCode must be at least 62/],
    [{PACKPROOF_ANDROID_VERSION_CODE: '57'}, /Production Android versionCode must be at least 62/],
    [{PACKPROOF_ANDROID_VERSION_CODE: '61'}, /Production Android versionCode must be at least 62/],
    [{PACKPROOF_ANDROID_VERSION_CODE: '58'}, /Production Android versionCode must be at least 62/],
    [{EAS_BUILD_GIT_COMMIT_HASH: ''}, /Source-bound build requires a valid EAS source commit/],
    [{EAS_BUILD_GIT_COMMIT_HASH: 'invalid'}, /Source-bound build requires a valid EAS source commit/],
    [{EXPO_PUBLIC_PACKPROOF_AUTH_MODE: 'dev'}, /Production capture receipts require the authorized Android production profile and HTTPS\/Cognito configuration/],
    [{EXPO_PUBLIC_PACKPROOF_API_BASE_URL: 'http://localhost:3000'}, /Production capture receipts require the authorized Android production profile and HTTPS\/Cognito configuration/],
    [{EXPO_PUBLIC_PACKPROOF_CAMERA_SPIKE: 'true'}, /Production capture receipts require the authorized Android production profile and HTTPS\/Cognito configuration/],
    [{EAS_BUILD_PLATFORM: 'ios'}, /The production profile is for Android only/],
  ]) {
    const result = productionConfig(overrides);
    assert.notEqual(result.status, 0, JSON.stringify(overrides));
    assert.match(result.stderr, error);
  }
  const local = productionConfig({EAS_BUILD: '', EAS_BUILD_GIT_COMMIT_HASH: ''});
  assert.equal(local.status, 0, local.stderr);
  assert.equal(Object.hasOwn(JSON.parse(local.stdout).extra, 'packproofBuildSha'), false);
});

test('signed AAB workflow resolves production identity before dispatch and freezes the existing credential', () => {
  const workflow = require('js-yaml').load(fs.readFileSync(path.resolve(__dirname, '../../.github/workflows/android-aab.yml'), 'utf8'));
  const steps = workflow.jobs.build.steps;
  const identity = steps.find(step => step.id === 'release');
  const build = steps.find(step => step.name === 'Build signed Android App Bundle');
  assert.equal(build.env.EAS_BUILD_PROFILE, 'production');
  assert.match(identity.run, /npm run test:research\b/);
  assert.match(build.run, /eas build --platform android --profile production\b[^\n]*--freeze-credentials/);
  const script = identity.run.match(/node <<'NODE'\r?\n([\s\S]*?)\r?\nNODE/)[1];
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'packproof-release-identity-'));
  try {
    const output = path.join(temporary, 'outputs.txt');
    const result = spawnSync(process.execPath, ['-e', script], {cwd: path.resolve(__dirname, '..'), encoding: 'utf8',
      env: {...process.env, EAS_BUILD: '', EAS_BUILD_PROFILE: '', EAS_BUILD_GIT_COMMIT_HASH: '',
        EXPO_PUBLIC_PACKPROOF_CAMERA_SPIKE: 'false', GITHUB_OUTPUT: output}});
    assert.equal(result.status, 0, result.stderr);
    assert.match(fs.readFileSync(output, 'utf8'), /(?:^|\n)artifact=packproof-1\.0\.1-69(?:\n|$)/);
  } finally {
    fs.rmSync(temporary, {recursive: true, force: true});
  }
});

test('signed AAB workflow rejects false or missing task-first flag even when the runner environment enables it', () => {
  const workflow = require('js-yaml').load(fs.readFileSync(path.resolve(__dirname, '../../.github/workflows/android-aab.yml'), 'utf8'));
  const script = workflow.jobs.build.steps.find(step => step.id === 'release').run.match(/node <<'NODE'\r?\n([\s\S]*?)\r?\nNODE/)[1];
  const env = {...process.env};
  try {
    process.env.EXPO_PUBLIC_PACKPROOF_ANDROID_TASK_FIRST = 'true';
    for (const value of ['false', undefined]) {
      const config = structuredClone(require('../eas.json'));
      if (value === undefined) delete config.build.production.env.EXPO_PUBLIC_PACKPROOF_ANDROID_TASK_FIRST;
      else config.build.production.env.EXPO_PUBLIC_PACKPROOF_ANDROID_TASK_FIRST = value;
      let outputWritten = false;
      const dependency = name => {
        if (name === 'fs') return {appendFileSync() { outputWritten = true; }};
        if (name === './eas.json') return config;
        throw new Error(`Unexpected workflow dependency ${name}`);
      };
      assert.throws(() => new Function('require', script)(dependency), /Production Android task-first experience must be explicitly enabled/);
      assert.equal(outputWritten, false);
    }
  } finally {
    for (const name of Object.keys(process.env)) if (!(name in env)) delete process.env[name];
    Object.assign(process.env, env);
  }
});

test('signed AAB workflow rejects missing or mismatched receipt scope before publishing artifact identity', () => {
  const workflow = require('js-yaml').load(fs.readFileSync(path.resolve(__dirname, '../../.github/workflows/android-aab.yml'), 'utf8'));
  const script = workflow.jobs.build.steps.find(step => step.id === 'release').run.match(/node <<'NODE'\r?\n([\s\S]*?)\r?\nNODE/)[1];
  const base = JSON.parse(productionConfig().stdout);
  const env = {...process.env};
  try {
    for (const change of [{packproofResearch:true}, {packproofResearchProduction:false}, {packproofResearchProfile:'laboratory'}, {packproofResearchProfile:null}]) {
      let outputWritten = false;
      const dependency = name => {
        if (name === 'fs') return {appendFileSync() { outputWritten = true; }};
        if (name === './eas.json') return require('../eas.json');
        if (name === './app.config.js') return {expo:{...base,extra:{...base.extra,...change}}};
        throw new Error(`Unexpected workflow dependency ${name}`);
      };
      assert.throws(() => new Function('require', script)(dependency), /Production capture receipt profile is incorrect/);
      assert.equal(outputWritten, false);
    }
  } finally {
    for (const name of Object.keys(process.env)) if (!(name in env)) delete process.env[name];
    Object.assign(process.env,env);
  }
});

test('signed AAB workflow rejects a completed artifact from the wrong source or release identity', () => {
  const workflow = require('js-yaml').load(fs.readFileSync(path.resolve(__dirname, '../../.github/workflows/android-aab.yml'), 'utf8'));
  const build = workflow.jobs.build.steps.find(step => step.name === 'Build signed Android App Bundle');
  const script = build.run.match(/node <<'NODE'\r?\n([\s\S]*?)\r?\nNODE/)[1];
  const source = 'ab'.repeat(20);
  const metadata = {status: 'FINISHED', gitCommitHash: source, platform: 'ANDROID', distribution: 'STORE',
    buildProfile: 'production', appIdentifier: 'com.packproof.mobile', appVersion: '1.0.1', appBuildVersion: '62',
    artifacts: {buildUrl: 'https://example.invalid/fixture.aab'}};
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'packproof-release-receipt-'));
  try {
    fs.mkdirSync(path.join(temporary, 'dist'));
    const output = path.join(temporary, 'dist/aab-url.txt');
    for (const overrides of [null, {gitCommitHash: 'cd'.repeat(20)}, {platform: 'IOS'}, {distribution: 'INTERNAL'},
      {buildProfile: 'shipping-integration'}, {appIdentifier: 'com.thepackproof.app'}, {appVersion: '0.2.0'}, {appBuildVersion: '56'}, {appBuildVersion: '60'}, {appBuildVersion: '61'}]) {
      fs.rmSync(output, {force: true});
      fs.writeFileSync(path.join(temporary, 'dist/eas-build.json'), JSON.stringify([{...metadata, ...overrides}]));
      const result = spawnSync(process.execPath, ['-e', script], {cwd: temporary, encoding: 'utf8',
        env: {...process.env, GITHUB_SHA: source, PACKPROOF_EXPECTED_VERSION: '1.0.1', PACKPROOF_EXPECTED_VERSION_CODE: '62'}});
      if (overrides === null) {
        assert.equal(result.status, 0, result.stderr);
        assert.equal(fs.readFileSync(output, 'utf8').trim(), metadata.artifacts.buildUrl);
      } else {
        assert.notEqual(result.status, 0, JSON.stringify(overrides));
        assert.match(result.stderr, /EAS (?:build source revision|artifact identity) does not match/);
        assert.equal(fs.existsSync(output), false);
      }
    }
  } finally {
    fs.rmSync(temporary, {recursive: true, force: true});
  }
});
const policyPath = path.resolve(__dirname, '../../config/rnd/research-build.json');
const researchOnly = fs.existsSync(policyPath) && JSON.parse(fs.readFileSync(policyPath, 'utf8')).researchOnly;

test('next standard Android candidate advances the installed baseline and retains account media protection', () => {
  const result=spawnSync(process.execPath,['-e','process.stdout.write(JSON.stringify(require("./app.config.js").expo))'],{
    cwd:path.resolve(__dirname,'..'),encoding:'utf8',
    env:{...process.env,EAS_BUILD_PROFILE:'',EXPO_PUBLIC_PACKPROOF_CAMERA_SPIKE:'false'},
  });
  assert.equal(result.status,0,result.stderr);
  const config=JSON.parse(result.stdout);
  assert.equal(config.version,'1.0.1');
  assert.equal(config.android.versionCode,56);
  assert.equal(config.android.package,'com.packproof.mobile');
  assert.equal(config.android.allowBackup,false);
});

test('store profiles preserve the existing Play package and signing credential', () => {
  const profiles = require('../eas.json').build;
  assert.equal(profiles['shipping-integration'].env.PACKPROOF_ANDROID_VERSION_CODE, '56');
  assert.equal(profiles['internal-staging'].android.keystoreName, 'Build Credentials pdbJYV45vI');
  assert.equal(profiles['internal-staging'].android.credentialsSource, 'remote');
  for (const profile of ['internal-staging', 'shipping-integration']) {
    const run = (overrides = {}) => spawnSync(process.execPath, ['-e', 'process.stdout.write(JSON.stringify(require("./app.config.js").expo))'], {
      cwd: path.resolve(__dirname, '..'), encoding: 'utf8',
      env: {...process.env, EAS_BUILD_PROFILE: profile, EXPO_PUBLIC_PACKPROOF_CAMERA_SPIKE: 'false', EXPO_PUBLIC_PACKPROOF_AUTH_MODE: 'cognito', ...overrides},
    });
    const result = run();
    if (researchOnly) { assert.notEqual(result.status, 0); assert.match(result.stderr, /R&D branch cannot use distribution/); continue; }
    assert.equal(result.status, 0, result.stderr);
    const config = JSON.parse(result.stdout);
    assert.equal(config.android.package, 'com.packproof.mobile');
    assert.equal(config.android.usesCleartextTraffic, false);
    assert.equal(config.android.allowBackup, false);
    assert.notEqual(run({EXPO_PUBLIC_PACKPROOF_AUTH_MODE: 'dev'}).status, 0);
    assert.notEqual(run({PACKPROOF_ANDROID_VERSION_CODE: '52'}).status, 0);
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

test('production research mode rejects lab mode, other profiles and unsafe HTTPS authority', () => {
  for (const overrides of [
    {EXPO_PUBLIC_PACKPROOF_RND: 'true'}, {EAS_BUILD_PROFILE: 'shipping-integration'}, {EAS_BUILD_PROFILE: 'ios-testflight'},
    ...['https://user:pass@api.example.com','https://api.example.com/path','https://api.example.com?x=1','https://api.example.com#x','https://10.0.0.1','https://172.16.0.1','https://192.168.1.1','https://[::1]','https://8.8.8.8','https://api.example.com:8443','https://test.local'].map(value => ({EXPO_PUBLIC_PACKPROOF_API_BASE_URL: value})),
  ]) {
    const result = productionConfig(overrides);
    assert.notEqual(result.status, 0, JSON.stringify(overrides));
    assert.match(result.stderr, /Production capture receipts require the authorized Android production profile/);
  }
  const disabled = productionConfig({EXPO_PUBLIC_PACKPROOF_RND_PRODUCTION:'false'});
  assert.equal(disabled.status,0,disabled.stderr); assert.equal(JSON.parse(disabled.stdout).extra.packproofResearchProduction,false);
});
