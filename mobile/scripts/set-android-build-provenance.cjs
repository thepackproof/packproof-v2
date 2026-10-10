// EAS does not forward arbitrary variables from the machine submitting a build.
// Bind Android store bundles and internal review APKs to the worker revision before Metro runs,
// overriding any older public revision retained in the shared EAS environment.
const { spawnSync } = require('node:child_process');
const releaseProfiles = new Set(['internal-staging', 'shipping-integration', 'production', 'mobile-ux-review']);

function setAndroidBuildProvenance(env = process.env, run = spawnSync) {
  if (env.EAS_BUILD !== 'true' || env.EAS_BUILD_PLATFORM !== 'android' || !releaseProfiles.has(env.EAS_BUILD_PROFILE)) {
    return false;
  }
  const sourceSha = env.EAS_BUILD_GIT_COMMIT_HASH;
  if (typeof sourceSha !== 'string' || !/^[a-f0-9]{40}$/.test(sourceSha)) {
    throw new Error('Android store build requires a valid EAS source commit.');
  }
  // set-env persists this value for later phases of this build only. It does not
  // modify project/account environment settings or another platform's build.
  const result = run('set-env', ['EXPO_PUBLIC_PACKPROOF_BUILD_SHA', sourceSha], {
    encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (result.error || result.status !== 0) {
    throw new Error('Could not bind Android build provenance for subsequent build phases.');
  }
  return true;
}

// Simulator review builds use the same worker-only binding. Deliberately leave
// signed device and TestFlight build behavior unchanged.
function setIosSimulatorBuildProvenance(env = process.env, run = spawnSync) {
  if (env.EAS_BUILD !== 'true' || env.EAS_BUILD_PLATFORM !== 'ios' || env.EAS_BUILD_PROFILE !== 'ios-simulator') {
    return false;
  }
  const sourceSha = env.EAS_BUILD_GIT_COMMIT_HASH;
  if (typeof sourceSha !== 'string' || !/^[a-f0-9]{40}$/.test(sourceSha)) {
    throw new Error('iOS simulator review build requires a valid EAS source commit.');
  }
  const result = run('set-env', ['EXPO_PUBLIC_PACKPROOF_BUILD_SHA', sourceSha], {
    encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (result.error || result.status !== 0) {
    throw new Error('Could not bind iOS simulator build provenance for subsequent build phases.');
  }
  return true;
}

if (require.main === module) {
  try {
    if (setAndroidBuildProvenance()) console.log('Android bundle source revision bound to EAS build metadata.');
    if (setIosSimulatorBuildProvenance()) console.log('iOS simulator bundle source revision bound to EAS build metadata.');
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}

module.exports = { setAndroidBuildProvenance, setIosSimulatorBuildProvenance };
