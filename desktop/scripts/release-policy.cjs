const fs = require('node:fs');
const path = require('node:path');

const channels = new Set(['development', 'staging', 'production']);
const updateOrigin = 'https://downloads.thepackproof.com';

function releaseContext(env = process.env, platform = env.PACKPROOF_BUILD_PLATFORM || process.platform, arch = env.PACKPROOF_BUILD_ARCH || process.arch) {
  const channel = env.APP_ENV || 'development';
  if (!channels.has(channel)) throw new Error('APP_ENV must be development, staging or production.');
  if (!['x64', 'arm64'].includes(arch)) throw new Error('Desktop builds support only x64 and arm64.');
  const suffix = channel === 'production' ? '' : channel === 'staging' ? ' Staging' : ' Dev';
  return {
    channel, platform, arch,
    appId: `com.thepackproof.desktop${channel === 'production' ? '' : `.${channel}`}`,
    productName: `PackProof${suffix}`,
    packageName: `packproof-desktop${channel === 'production' ? '' : `-${channel}`}`,
    artifactPrefix: `PackProof${suffix.replaceAll(' ', '-')}`,
    protocol: channel === 'production' ? 'packproof' : channel === 'staging' ? 'packproof-staging' : 'packproof-dev',
    outputDirectory: `release/${channel}/${platform}-${arch}`,
    updateUrl: `${updateOrigin}/desktop/${channel}/${platform}/${arch}/`,
    includePkg: env.PACKPROOF_BUILD_PKG === '1',
  };
}

function checkReleaseEnvironment({ env = process.env, platform = process.platform, checkRuntime = false, cwd = process.cwd() } = {}) {
  const release = releaseContext(env, env.PACKPROOF_BUILD_PLATFORM || platform);
  const errors = [];
  const required = name => { if (!env[name]?.trim()) errors.push(`${name} is required`); };
  if (release.channel !== 'development') {
    if (!['win32', 'darwin'].includes(platform)) errors.push('Signed releases must be built on native Windows or macOS runners');
    if (release.platform !== platform) errors.push('Signed release target must match the native build runner');
    for (const key of ['PACKPROOF_API_BASE_URL', 'PACKPROOF_COGNITO_CLIENT_ID', 'PACKPROOF_COGNITO_REGION', 'PACKPROOF_UPDATES_URL']) required(key);
    try {
      const api = new URL(env.PACKPROOF_API_BASE_URL);
      if (api.protocol !== 'https:' || api.username || api.password || api.search || api.hash) errors.push('Release API must use HTTPS without credentials, query or fragment');
      if (['localhost', '127.0.0.1', '[::1]'].includes(api.hostname)) errors.push('Release API must not be a loopback endpoint');
    } catch { errors.push('Release API URL is invalid'); }
    if (env.PACKPROOF_UPDATES_URL !== release.updateUrl) errors.push(`PACKPROOF_UPDATES_URL must be ${release.updateUrl}`);
    if (platform === 'win32') {
      required('WIN_CSC_LINK'); required('WIN_CSC_KEY_PASSWORD'); required('WINDOWS_PUBLISHER_NAME');
    }
    if (platform === 'darwin') {
      required('CSC_LINK'); required('CSC_KEY_PASSWORD'); required('APPLE_TEAM_ID');
      const notarization = ['APPLE_API_KEY', 'APPLE_API_KEY_ID', 'APPLE_API_ISSUER'].every(name => env[name]?.trim());
      const appleIdNotarization = ['APPLE_ID', 'APPLE_APP_SPECIFIC_PASSWORD', 'APPLE_TEAM_ID'].every(name => env[name]?.trim());
      if (!notarization && !appleIdNotarization) errors.push('Apple notarization requires APPLE_API_KEY/ID/ISSUER or APPLE_ID/APP_SPECIFIC_PASSWORD/TEAM_ID');
      if (release.includePkg) { required('CSC_INSTALLER_LINK'); required('CSC_INSTALLER_KEY_PASSWORD'); }
    }
    if (env.CSC_IDENTITY_AUTO_DISCOVERY === 'false' && platform === 'darwin') errors.push('Signed macOS builds cannot disable certificate discovery');
  }
  if (checkRuntime) {
    try {
      const runtime = JSON.parse(fs.readFileSync(path.join(cwd, 'dist/main/runtime-config.json'), 'utf8'));
      if (runtime.channel !== release.channel) errors.push('Built runtime channel does not match packaging channel; rebuild with the correct APP_ENV');
      if (release.channel !== 'development' && (runtime.updateUrl !== release.updateUrl || runtime.apiBaseUrl !== env.PACKPROOF_API_BASE_URL || runtime.cognito?.clientId !== env.PACKPROOF_COGNITO_CLIENT_ID)) errors.push('Built runtime does not match release API, Cognito client and isolated update feed');
    } catch { errors.push('Build dist/main/runtime-config.json before packaging'); }
  }
  if (errors.length) throw new Error(`Desktop release blocked:\n- ${errors.join('\n- ')}`);
  return release;
}

module.exports = { releaseContext, checkReleaseEnvironment };

if (require.main === module) {
  try {
    const release = checkReleaseEnvironment({ checkRuntime: process.argv.includes('--runtime') });
    process.stdout.write(`Release configuration accepted: ${release.channel}, ${release.platform}, ${release.arch}.\n`);
  } catch (error) { process.stderr.write(`${error.message}\n`); process.exitCode = 1; }
}
