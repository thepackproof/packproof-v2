/** Build-only native runner. No EAS, store credentials, submission, or OTA commands. */
import { spawnSync } from 'node:child_process';
import { mkdirSync, readdirSync, copyFileSync, writeFileSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve, join } from 'node:path';
import { createHash } from 'node:crypto';
const root = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const mobile = join(root, 'mobile');
const platform = process.argv[2];
if (!['android', 'ios'].includes(platform) || process.argv.length > 3) throw new Error('Usage: node scripts/rnd/build-mobile.mjs android|ios');
if (platform === 'ios' && process.platform !== 'darwin') throw new Error('iOS simulator compilation requires macOS with Xcode and CocoaPods.');
const env = { ...process.env, CI: '1', EXPO_NO_TELEMETRY: '1', EXPO_PUBLIC_PACKPROOF_RND_BUILD: 'true', EXPO_PUBLIC_PACKPROOF_FINGERPRINT_ENABLED: 'true', EXPO_PUBLIC_PACKPROOF_IN_VIDEO_SHIPPING: 'true', EXPO_PUBLIC_PACKPROOF_AUTH_MODE: 'dev', EAS_BUILD_PROFILE: '' };
env.EXPO_PUBLIC_PACKPROOF_API_BASE_URL ||= 'http://127.0.0.1:3000';
for (const name of ['EXPO_PUBLIC_COGNITO_CLIENT_ID', 'EXPO_PUBLIC_COGNITO_USER_POOL_ID', 'EXPO_TOKEN', 'GOOGLE_SERVICES_JSON', 'APPLE_API_KEY', 'APPLE_ID']) delete env[name];
function run(command, args, cwd = mobile) {
  const result = spawnSync(command, args, { cwd, env, stdio: 'inherit', shell: process.platform === 'win32' });
  if (result.status !== 0) throw new Error(`${command} failed (${result.status ?? result.error?.message}). No artifact was submitted.`);
}
run('npx', ['--no-install', 'expo', 'prebuild', '--platform', platform, '--no-install']);
const out = join(mobile, 'dist', 'rnd');
mkdirSync(out, { recursive: true });
let artifact;
if (platform === 'android') {
  run(process.platform === 'win32' ? 'gradlew.bat' : './gradlew', [':app:assembleRelease', '--no-daemon', '--console=plain', '-PreactNativeArchitectures=arm64-v8a'], join(mobile, 'android'));
  artifact = join(out, 'PackProof-RND-Android.apk');
  copyFileSync(join(mobile, 'android/app/build/outputs/apk/release/app-release.apk'), artifact);
} else {
  run('pod', ['install'], join(mobile, 'ios'));
  const project = readdirSync(join(mobile, 'ios')).find(name => name.endsWith('.xcworkspace'));
  if (project !== 'PackProofRND.xcworkspace') throw new Error(`Unexpected research workspace ${project}`);
  const derived = join(out, 'ios-derived');
  run('xcodebuild', ['-workspace', `ios/${project}`, '-scheme', 'PackProofRND', '-configuration', 'Release', '-sdk', 'iphonesimulator', '-destination', 'generic/platform=iOS Simulator', '-derivedDataPath', derived, 'CODE_SIGNING_ALLOWED=NO', 'build']);
  artifact = join(out, 'PackProof-RND-iOS-Simulator.zip');
  run('ditto', ['-c', '-k', '--sequesterRsrc', '--keepParent', join(derived, 'Build/Products/Release-iphonesimulator/PackProofRND.app'), artifact]);
}
const hash = createHash('sha256').update(readFileSync(artifact)).digest('hex');
writeFileSync(artifact + '.sha256', hash + '  ' + artifact.split(/[\\/]/).at(-1) + '\n');
console.log(`Created experimental build: ${artifact}`);
