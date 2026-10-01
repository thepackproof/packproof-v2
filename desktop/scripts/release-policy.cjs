const fs = require('node:fs');
const path = require('node:path');

const channels = new Set(['development', 'research', 'staging', 'production']);
const updateOrigin = 'https://downloads.thepackproof.com';
const azureSigningHosts = new Set('brs cus eus jpe krc ncus neu plc scus swn wcus weu wus wus2 wus3'.split(' ').map(region => `${region}.codesigning.azure.net`));

// Keep aligned with the renderer-free runtime reporter's public, hosted DSN policy.
function validPublicSentryDsn(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.password && !url.port && !url.search && !url.hash
      && /^[a-f0-9]{32}$/i.test(url.username) && /^\/\d+$/.test(url.pathname)
      && (url.hostname === 'sentry.io' || /^[a-z0-9-]+\.ingest(?:\.[a-z]{2})?\.sentry\.io$/.test(url.hostname));
  } catch { return false; }
}

function windowsSigningOptions(env = process.env) {
  if ((env.PACKPROOF_WINDOWS_SIGNING_PROVIDER || 'pfx') === 'azure') return {
    azureSignOptions: {
      publisherName: env.WINDOWS_PUBLISHER_NAME,
      endpoint: env.AZURE_TRUSTED_SIGNING_ENDPOINT,
      certificateProfileName: env.AZURE_TRUSTED_SIGNING_PROFILE,
      codeSigningAccountName: env.AZURE_TRUSTED_SIGNING_ACCOUNT,
      fileDigest: 'SHA256', timestampDigest: 'SHA256', timestampRfc3161: 'http://timestamp.acs.microsoft.com',
    },
  };
  return { signtoolOptions: {
    publisherName: env.WINDOWS_PUBLISHER_NAME,
    signingHashAlgorithms: ['sha256'], rfc3161TimeStampServer: 'http://timestamp.digicert.com',
  } };
}

function releaseContext(env = process.env, platform = env.PACKPROOF_BUILD_PLATFORM || process.platform, arch = env.PACKPROOF_BUILD_ARCH || process.arch) {
  const channel = env.APP_ENV || 'development';
  if (!channels.has(channel)) throw new Error('APP_ENV must be development, research, staging or production.');
  if (!['x64', 'arm64'].includes(arch)) throw new Error('Desktop builds support only x64 and arm64.');
  const suffix = channel === 'production' ? '' : channel === 'staging' ? ' Staging' : channel === 'research' ? ' RND' : ' Dev';
  return {
    channel, platform, arch,
    appId: `com.thepackproof.desktop${channel === 'production' ? '' : `.${channel}`}`,
    productName: `PackProof${suffix}`,
    packageName: `packproof-desktop${channel === 'production' ? '' : `-${channel}`}`,
    artifactPrefix: `PackProof${suffix.replaceAll(' ', '-')}`,
    protocol: channel === 'production' ? 'packproof' : channel === 'staging' ? 'packproof-staging' : channel === 'research' ? 'packproof-rnd' : 'packproof-dev',
    outputDirectory: `release/${channel}/${platform}-${arch}`,
    updateUrl: channel === 'research' ? '' : `${updateOrigin}/desktop/${channel}/${platform}/${arch}/`,
    includePkg: env.PACKPROOF_BUILD_PKG === '1',
  };
}

function checkReleaseEnvironment({ env = process.env, platform = process.platform, checkRuntime = false, cwd = process.cwd() } = {}) {
  const release = releaseContext(env, env.PACKPROOF_BUILD_PLATFORM || platform);
  const errors = [];
  const required = name => { if (!env[name]?.trim()) errors.push(`${name} is required`); };
  if (!['development', 'research'].includes(release.channel)) {
    if (!['win32', 'darwin'].includes(platform)) errors.push('Signed releases must be built on native Windows or macOS runners');
    if (release.platform !== platform) errors.push('Signed release target must match the native build runner');
    for (const key of ['PACKPROOF_API_BASE_URL', 'PACKPROOF_COGNITO_CLIENT_ID', 'PACKPROOF_COGNITO_REGION', 'PACKPROOF_UPDATES_URL']) required(key);
    if (release.channel === 'production') required('PACKPROOF_SENTRY_DSN');
    if (env.PACKPROOF_SENTRY_DSN && !validPublicSentryDsn(env.PACKPROOF_SENTRY_DSN)) errors.push('PACKPROOF_SENTRY_DSN must be a valid public hosted Sentry HTTPS DSN');
    try {
      const api = new URL(env.PACKPROOF_API_BASE_URL);
      if (api.protocol !== 'https:' || api.username || api.password || api.search || api.hash) errors.push('Release API must use HTTPS without credentials, query or fragment');
      if (['localhost', '127.0.0.1', '[::1]'].includes(api.hostname)) errors.push('Release API must not be a loopback endpoint');
    } catch { errors.push('Release API URL is invalid'); }
    if (env.PACKPROOF_UPDATES_URL !== release.updateUrl) errors.push(`PACKPROOF_UPDATES_URL must be ${release.updateUrl}`);
    if (platform === 'win32') {
      required('WINDOWS_PUBLISHER_NAME');
      const provider = env.PACKPROOF_WINDOWS_SIGNING_PROVIDER || 'pfx';
      if (provider === 'pfx') { required('WIN_CSC_LINK'); required('WIN_CSC_KEY_PASSWORD'); }
      else if (provider === 'azure') {
        for (const key of ['AZURE_TENANT_ID', 'AZURE_CLIENT_ID', 'AZURE_SUBSCRIPTION_ID', 'AZURE_TRUSTED_SIGNING_ENDPOINT', 'AZURE_TRUSTED_SIGNING_ACCOUNT', 'AZURE_TRUSTED_SIGNING_PROFILE']) required(key);
        for (const key of ['AZURE_TENANT_ID', 'AZURE_CLIENT_ID', 'AZURE_SUBSCRIPTION_ID']) if (!/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i.test(env[key] || '')) errors.push(`${key} must be an Azure identifier`);
        for (const key of ['AZURE_TRUSTED_SIGNING_ACCOUNT', 'AZURE_TRUSTED_SIGNING_PROFILE']) if (!/^[a-zA-Z0-9][a-zA-Z0-9-]{0,99}$/.test(env[key] || '')) errors.push(`${key} must be an existing signing resource name`);
        try {
          const endpoint = new URL(env.AZURE_TRUSTED_SIGNING_ENDPOINT);
          if (endpoint.protocol !== 'https:' || !azureSigningHosts.has(endpoint.hostname) || endpoint.username || endpoint.password || endpoint.port || endpoint.search || endpoint.hash || endpoint.pathname !== '/') throw new Error();
        } catch { errors.push('AZURE_TRUSTED_SIGNING_ENDPOINT must be an official public Azure regional signing HTTPS endpoint'); }
        // The supplied route uses azure/login OIDC and AzureCliCredential in an isolated hosted runner.
        // Do not allow environment credentials to take precedence in the provider's default chain.
        if (env.GITHUB_ACTIONS !== 'true' || env.RUNNER_ENVIRONMENT !== 'github-hosted') errors.push('Azure signing requires the protected GitHub-hosted OIDC release workflow');
        required('ACTIONS_ID_TOKEN_REQUEST_URL'); required('ACTIONS_ID_TOKEN_REQUEST_TOKEN');
        for (const key of ['AZURE_CLIENT_SECRET', 'AZURE_CLIENT_CERTIFICATE_PATH', 'AZURE_USERNAME', 'AZURE_PASSWORD', 'AZURE_FEDERATED_TOKEN_FILE']) if (env[key]) errors.push(`${key} is forbidden for the Azure CLI OIDC signing route`);
        if (env.WIN_CSC_LINK || env.WIN_CSC_KEY_PASSWORD) errors.push('Azure signing must not also receive PFX credentials');
      } else errors.push('PACKPROOF_WINDOWS_SIGNING_PROVIDER must be pfx or azure');
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
  if (release.channel === 'research') {
    for (const key of ['PACKPROOF_UPDATES_URL', 'PACKPROOF_SENTRY_DSN', 'SENTRY_DSN', 'PACKPROOF_COGNITO_CLIENT_ID', 'PACKPROOF_COGNITO_USER_POOL_ID', 'WIN_CSC_LINK', 'CSC_LINK', 'APPLE_ID', 'APPLE_API_KEY']) {
      if (env[key]) errors.push(`${key} is forbidden for research builds`);
    }
  }
  if (checkRuntime) {
    try {
      const runtime = JSON.parse(fs.readFileSync(path.join(cwd, 'dist/main/runtime-config.json'), 'utf8'));
      if (release.channel === 'research' && (runtime.updateUrl || runtime.sentryDsn || runtime.cognito?.clientId || runtime.cognito?.userPoolId)) errors.push('Research runtime contains a distribution or live authentication destination');
      if (runtime.channel !== release.channel) errors.push('Built runtime channel does not match packaging channel; rebuild with the correct APP_ENV');
      if (!['development', 'research'].includes(release.channel) && (runtime.updateUrl !== release.updateUrl || runtime.apiBaseUrl !== env.PACKPROOF_API_BASE_URL || runtime.cognito?.clientId !== env.PACKPROOF_COGNITO_CLIENT_ID)) errors.push('Built runtime does not match release API, Cognito client and isolated update feed');
      if (release.channel === 'production' && runtime.sentryDsn !== env.PACKPROOF_SENTRY_DSN) errors.push('Built runtime does not match the required production reporting destination');
    } catch { errors.push('Build dist/main/runtime-config.json before packaging'); }
  }
  if (errors.length) throw new Error(`Desktop release blocked:\n- ${errors.join('\n- ')}`);
  return release;
}

module.exports = { releaseContext, checkReleaseEnvironment, validPublicSentryDsn, windowsSigningOptions };

if (require.main === module) {
  try {
    const release = checkReleaseEnvironment({ checkRuntime: process.argv.includes('--runtime') });
    process.stdout.write(`Release configuration accepted: ${release.channel}, ${release.platform}, ${release.arch}.\n`);
  } catch (error) { process.stderr.write(`${error.message}\n`); process.exitCode = 1; }
}
