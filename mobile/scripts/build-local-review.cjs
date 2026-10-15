#!/usr/bin/env node
/* Build-only G2 review artifact. Never installs, replaces an app, uploads or submits. */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');

function resolveReviewProfile(profiles) {
  const layers = [], seen = new Set();
  for (let name = 'mobile-ux-review'; name; name = profiles[name].extends) {
    if (seen.has(name) || !profiles[name]) throw new Error('Invalid internal review profile inheritance.');
    seen.add(name); layers.unshift(profiles[name]);
  }
  const profile = { env: {}, android: {} };
  for (const layer of layers) {
    if (layer.distribution) profile.distribution = layer.distribution;
    Object.assign(profile.android, layer.android);
    Object.assign(profile.env, layer.env);
  }
  if (profile.distribution !== 'internal' || profile.android.buildType !== 'apk') {
    throw new Error('Only the existing internal APK review profile is allowed.');
  }
  if (profile.env.PACKPROOF_ANDROID_VERSION_CODE !== '66') throw new Error('Review versionCode must be 66.');
  if (profile.env.EXPO_PUBLIC_PACKPROOF_ANDROID_TASK_FIRST !== 'true') throw new Error('Review must explicitly enable the approved Android composition.');
  if (profile.env.EXPO_PUBLIC_PACKPROOF_AUTH_MODE !== 'cognito') throw new Error('Review must retain Cognito authentication.');
  return profile;
}

function assertReviewConfig(expo, sha) {
  if (expo.android?.package !== 'com.packproof.mobile' || expo.android.versionCode !== 66 || expo.version !== '1.0.1') {
    throw new Error('Unexpected existing review package/version.');
  }
  if (expo.android.allowBackup !== false || expo.android.usesCleartextTraffic !== false) throw new Error('Review must retain media and transport protections.');
  if (expo.extra?.packproofInternalReview !== true || expo.extra.packproofMobileTaskUx !== true
      || expo.extra.packproofFirstProofExperience !== true || expo.extra.packproofBuildSha !== sha
      || expo.extra.packproofResearch !== false || expo.extra.packproofResearchProduction !== false) {
    throw new Error('Review feature or source identity mismatch.');
  }
}

function argumentsFor(argv) {
  const options = { workers: 2 };
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i], value = argv[i + 1];
    if (!value || !['--expected-sha', '--out', '--workers'].includes(key)) throw new Error('Usage: build-local-review.cjs --expected-sha <40-character SHA> --out <absolute directory> [--workers 2]');
    options[key === '--expected-sha' ? 'sha' : key.slice(2)] = key === '--workers' ? Number(value) : value;
  }
  if (!/^[a-f0-9]{40}$/.test(options.sha || '') || !path.isAbsolute(options.out || '')
      || !Number.isSafeInteger(options.workers) || options.workers < 1 || options.workers > 8) {
    throw new Error('An exact source SHA, absolute output directory and 1–8 workers are required.');
  }
  return options;
}

function main(argv = process.argv.slice(2)) {
  const options = argumentsFor(argv), mobile = path.resolve(__dirname, '..'), root = path.resolve(mobile, '..');
  const run = (command, args, env = process.env, log) => {
    const fd = log ? fs.openSync(log, 'w') : undefined;
    let result;
    try { result = spawnSync(command, args, { cwd: mobile, env, encoding: log ? undefined : 'utf8', maxBuffer: 32 * 1024 * 1024, stdio: log ? ['ignore', fd, fd] : 'pipe' }); }
    finally { if (fd !== undefined) fs.closeSync(fd); }
    if (result.error || result.status !== 0) throw new Error(`${command} failed${log ? `; inspect ${log}` : `: ${result.stderr || result.error?.message || result.status}`}`);
    return result.stdout;
  };
  const assertClean = () => {
    if (run('git', ['rev-parse', 'HEAD']).trim() !== options.sha) throw new Error('HEAD is not the requested source SHA.');
    if (run('git', ['status', '--porcelain', '--untracked-files=all']).trim()) throw new Error('The entire source tree must be clean before and after this build.');
  };
  assertClean();
  if (options.out === root || options.out.startsWith(root + path.sep)) throw new Error('Build output must be outside the source checkout.');
  const sdk = process.env.ANDROID_HOME || process.env.ANDROID_SDK_ROOT;
  if (!sdk || !process.env.JAVA_HOME) throw new Error('Configure an existing Android SDK and JDK17 first.');
  const buildTools = path.join(sdk, 'build-tools', '36.0.0');
  for (const file of ['aapt', 'apksigner']) if (!fs.existsSync(path.join(buildTools, file))) throw new Error(`Android build tools36.0.0 are missing ${file}.`);
  fs.mkdirSync(options.out, { recursive: true });
  const profile = resolveReviewProfile(JSON.parse(fs.readFileSync(path.join(mobile, 'eas.json'), 'utf8')).build);
  const env = { ...process.env, ...profile.env, EAS_BUILD: 'false', EAS_BUILD_PROFILE: 'mobile-ux-review',
    EAS_BUILD_GIT_COMMIT_HASH: options.sha, EXPO_PUBLIC_PACKPROOF_BUILD_SHA: options.sha, CI: '1', EXPO_NO_TELEMETRY: '1', EXPO_NO_DOTENV: '1', NODE_ENV: 'production' };
  run(process.execPath, ['scripts/assert-release-allowed.cjs'], env);
  const expo = JSON.parse(run(process.execPath, ['-e', 'process.stdout.write(JSON.stringify(require("./app.config.js").expo))'], env));
  assertReviewConfig(expo, options.sha);
  if (run('git', ['ls-files', '--', 'android']).trim()) throw new Error('Refusing to regenerate tracked native Android inputs.');
  run('git', ['check-ignore', 'android/app/build.gradle']);
  run('npx', ['expo', 'prebuild', '--platform', 'android', '--clean', '--no-install', '--skip-dependency-update', 'react,react-native'], env, path.join(options.out, 'prebuild.log'));
  assertClean();
  const gradle = fs.readFileSync(path.join(mobile, 'android/app/build.gradle'), 'utf8');
  if (!/release\s*\{[^}]*signingConfig signingConfigs\.debug/.test(gradle)
      || !/applicationId ['"]com\.packproof\.mobile['"]/.test(gradle)) throw new Error('Generated local release signing/package is not the expected debug-signed review configuration.');
  run(path.join(mobile, 'android/gradlew'), ['-p', path.join(mobile, 'android'), ':app:assembleRelease', '--no-daemon', '--console=plain', `--max-workers=${options.workers}`, '-PreactNativeArchitectures=arm64-v8a,x86_64'], env, path.join(options.out, 'gradle.log'));
  assertClean();
  const generatedApk = path.join(mobile, 'android/app/build/outputs/apk/release/app-release.apk');
  const name = `packproof-1.0.1-66-${options.sha.slice(0, 12)}-local-review-debug-signed.apk`, apk = path.join(options.out, name);
  const badging = run(path.join(buildTools, 'aapt'), ['dump', 'badging', generatedApk], env);
  if (!badging.includes("package: name='com.packproof.mobile' versionCode='66' versionName='1.0.1'")) throw new Error('Actual APK identity mismatch.');
  fs.writeFileSync(path.join(options.out, 'package.txt'), badging);
  const signing = run(path.join(buildTools, 'apksigner'), ['verify', '--verbose', '--print-certs', generatedApk], env);
  const certificate = spawnSync(path.join(process.env.JAVA_HOME, 'bin/keytool'), ['-exportcert', '-alias', 'androiddebugkey', '-keystore', path.join(mobile, 'android/app/debug.keystore'), '-storepass', 'android'], { encoding: null, stdio: ['ignore', 'pipe', 'pipe'] });
  if (certificate.status !== 0) throw new Error('Could not verify generated local debug certificate.');
  const signerSha256 = crypto.createHash('sha256').update(certificate.stdout).digest('hex');
  if (!signing.toLowerCase().includes(`certificate sha-256 digest: ${signerSha256}`)) throw new Error('APK signer does not match the generated local debug key.');
  fs.writeFileSync(path.join(options.out, 'signing.txt'), signing);
  const inspection = JSON.parse(run('python3', ['-c', [
    'import json,sys,zipfile,pathlib',
    'with zipfile.ZipFile(sys.argv[1]) as archive:',
    ' assert archive.testzip() is None, "APK ZIP CRC failure"',
    ' names=archive.namelist()',
    ' assert not any(pathlib.PurePosixPath(n).name in (".env","credentials.json") or n.endswith((".jks",".keystore",".p12",".p8")) for n in names), "Packaged credential file"',
    ' bundle=archive.read("assets/index.android.bundle")',
    ' assert sys.argv[2].encode() in bundle, "Source SHA missing from compiled JS"',
    ' config=json.loads(archive.read("assets/app.config"))',
    ' config=config.get("expo",config)',
    ' assert config["extra"]["packproofBuildSha"]==sys.argv[2], "Packaged config SHA mismatch"',
    ' assert config["extra"]["packproofInternalReview"] is True, "Review marker missing"',
    ' print(json.dumps({"sourceShaInBundle":True,"sourceShaInConfig":True,"internalReviewMarker":True,"credentialsPackaged":False,"bundleBytes":len(bundle)}))',
  ].join('\n'), generatedApk, options.sha], env));
  const pageSize = JSON.parse(run('python3', [path.join(mobile, 'scripts/check-apk-page-size.py'), generatedApk], env));
  if (!pageSize.passed) throw new Error('APK16KB ELF/ZIP alignment check failed.');
  fs.writeFileSync(path.join(options.out, 'page-size.json'), JSON.stringify(pageSize, null, 2) + '\n');
  fs.copyFileSync(generatedApk, apk);
  const copiedSha256 = crypto.createHash('sha256').update(fs.readFileSync(apk)).digest('hex');
  if (copiedSha256 !== pageSize.sha256) throw new Error('Copied APK bytes do not match the validated artifact.');
  const javaVersion = spawnSync(path.join(process.env.JAVA_HOME, 'bin/java'), ['-version'], { encoding: 'utf8' });
  if (javaVersion.status !== 0) throw new Error('Could not record the JDK runtime identity.');
  const receipt = { schema: 'packproof.local-review-build.v1', createdAt: new Date().toISOString(), sourceSha: options.sha,
    file: name, sha256: pageSize.sha256, bytes: fs.statSync(apk).size, package: 'com.packproof.mobile', versionName: '1.0.1', versionCode: 66,
    profile: 'mobile-ux-review', variant: 'release', signing: 'generated local debug key; not Play release signing', signerSha256,
    installationScope: 'Clean spare Android device or emulator only. Does not upgrade a differently signed Play install. Do not uninstall the existing app or clear its media.',
    distribution: 'Local artifact only; no installation, upload, store submission or release performed.',
    buildInputs: { androidTaskFirst: true, dotenvLoaded: false, nativeProjectRegenerated: true },
    runtime: { node: process.version, java: javaVersion.stderr.trim().split('\n')[0], androidBuildTools: '36.0.0', abis: ['arm64-v8a', 'x86_64'] },
    deviceVerification: 'NOT RUN', ...inspection, pageSize16kbPassed: true };
  fs.writeFileSync(path.join(options.out, 'build-receipt.json'), JSON.stringify(receipt, null, 2) + '\n');
  fs.writeFileSync(path.join(options.out, 'SHA256SUMS'), `${receipt.sha256}  ${name}\n`);
  console.log(JSON.stringify(receipt, null, 2));
}

if (require.main === module) { try { main(); } catch (error) { console.error(error.message); process.exitCode = 1; } }
module.exports = { argumentsFor, resolveReviewProfile, assertReviewConfig };
