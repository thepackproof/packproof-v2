// Validate the actual artifact before EAS marks an Android build successful.
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const profiles = new Set(['internal-staging', 'shipping-integration', 'production']);
function artifactValidationCommand(env = process.env) {
  if (env.EAS_BUILD_PLATFORM !== 'android') return null;
  if (env.EAS_BUILD_PROFILE === 'mobile-ux-review') return [
    path.join(__dirname, 'check-apk-page-size.py'),
    path.join(__dirname, '../android/app/build/outputs/apk/release/app-release.apk'),
  ];
  return profiles.has(env.EAS_BUILD_PROFILE) ? [
    path.join(__dirname, 'check-aab-release.py'),
    path.join(__dirname, '../android/app/build/outputs/bundle/release/app-release.aab'),
  ] : null;
}
if (require.main === module) {
  const command = artifactValidationCommand();
  if (command) {
    const result = spawnSync('python3', command, { stdio: 'inherit' });
    if (result.error) console.error(result.error.message);
    process.exit(result.status ?? 1);
  }
}
module.exports = { artifactValidationCommand };
