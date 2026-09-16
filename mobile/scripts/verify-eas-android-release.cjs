// Validate the actual artifact before EAS marks an Android store build successful.
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const profiles = new Set(['internal-staging', 'shipping-integration', 'production']);
if (process.env.EAS_BUILD_PLATFORM === 'android' && profiles.has(process.env.EAS_BUILD_PROFILE)) {
  const result = spawnSync('python3', [
    path.join(__dirname, 'check-aab-release.py'),
    path.join(__dirname, '../android/app/build/outputs/bundle/release/app-release.aab'),
  ], { stdio: 'inherit' });
  if (result.error) console.error(result.error.message);
  process.exit(result.status ?? 1);
}
