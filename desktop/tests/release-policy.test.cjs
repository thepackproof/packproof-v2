const test = require('node:test');
const assert = require('node:assert/strict');
const { releaseContext, checkReleaseEnvironment, windowsSigningOptions } = require('../scripts/release-policy.cjs');
const { validateAcceptance, required } = require('../scripts/check-acceptance.cjs');
const { inspectRelease } = require('../scripts/publish-release.cjs');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const YAML = require('yaml');

const windows = {
  APP_ENV: 'production', PACKPROOF_BUILD_ARCH: 'x64',
  PACKPROOF_API_BASE_URL: 'https://api.example.test', PACKPROOF_COGNITO_CLIENT_ID: 'examplepublicclient',
  PACKPROOF_COGNITO_REGION: 'us-east-1', PACKPROOF_UPDATES_URL: 'https://downloads.thepackproof.com/desktop/production/win32/x64/',
  PACKPROOF_SENTRY_DSN: 'https://0123456789abcdef0123456789abcdef@o1.ingest.sentry.io/123',
  WIN_CSC_LINK: 'test-fixture-not-a-real-certificate', WIN_CSC_KEY_PASSWORD: 'test-fixture', WINDOWS_PUBLISHER_NAME: 'Test Publisher',
};

const azure = {
  ...windows, PACKPROOF_WINDOWS_SIGNING_PROVIDER: 'azure', WIN_CSC_LINK: '', WIN_CSC_KEY_PASSWORD: '',
  AZURE_TENANT_ID: '11111111-1111-1111-1111-111111111111', AZURE_CLIENT_ID: '22222222-2222-2222-2222-222222222222',
  AZURE_SUBSCRIPTION_ID: '33333333-3333-3333-3333-333333333333', AZURE_TRUSTED_SIGNING_ENDPOINT: 'https://eus.codesigning.azure.net/',
  AZURE_TRUSTED_SIGNING_ACCOUNT: 'test-account', AZURE_TRUSTED_SIGNING_PROFILE: 'test-profile',
  GITHUB_ACTIONS: 'true', RUNNER_ENVIRONMENT: 'github-hosted',
  ACTIONS_ID_TOKEN_REQUEST_URL: 'https://example.test/oidc', ACTIONS_ID_TOKEN_REQUEST_TOKEN: 'test-fixture-never-log',
};

test('production requires a public reporting destination and rejects credential-bearing or arbitrary endpoints', () => {
  for (const dsn of ['', 'http://0123456789abcdef0123456789abcdef@o1.ingest.sentry.io/123', 'https://0123456789abcdef0123456789abcdef:secret@o1.ingest.sentry.io/123', 'https://0123456789abcdef0123456789abcdef@collector.example.test/123']) {
    assert.throws(() => checkReleaseEnvironment({ env: { ...windows, PACKPROOF_SENTRY_DSN: dsn }, platform: 'win32' }), /PACKPROOF_SENTRY_DSN/);
  }
  checkReleaseEnvironment({ env: { ...windows, APP_ENV: 'staging', PACKPROOF_SENTRY_DSN: '', PACKPROOF_UPDATES_URL: windows.PACKPROOF_UPDATES_URL.replace('/production/', '/staging/') }, platform: 'win32' });
});
test('production rejects a build with a different reporting project', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'packproof-runtime-release-test-'));
  try {
    fs.mkdirSync(path.join(directory, 'dist/main'), { recursive: true });
    const runtime = { channel: 'production', updateUrl: windows.PACKPROOF_UPDATES_URL, apiBaseUrl: windows.PACKPROOF_API_BASE_URL, cognito: { clientId: windows.PACKPROOF_COGNITO_CLIENT_ID }, sentryDsn: '' };
    fs.writeFileSync(path.join(directory, 'dist/main/runtime-config.json'), JSON.stringify(runtime));
    assert.throws(() => checkReleaseEnvironment({ env: windows, platform: 'win32', checkRuntime: true, cwd: directory }), /reporting destination/);
    runtime.sentryDsn = windows.PACKPROOF_SENTRY_DSN;
    fs.writeFileSync(path.join(directory, 'dist/main/runtime-config.json'), JSON.stringify(runtime));
    checkReleaseEnvironment({ env: windows, platform: 'win32', checkRuntime: true, cwd: directory });
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});
test('Azure OIDC signing accepts no exportable key and keeps one signing provider', () => {
  checkReleaseEnvironment({ env: azure, platform: 'win32' });
  const options = windowsSigningOptions(azure);
  assert.equal(options.signtoolOptions, undefined);
  assert.equal(options.azureSignOptions.publisherName, windows.WINDOWS_PUBLISHER_NAME);
  assert.equal(options.azureSignOptions.fileDigest, 'SHA256');
  assert.equal(windowsSigningOptions(windows).azureSignOptions, undefined);
});
test('Azure signing rejects alternate credential chains, missing OIDC, untrusted endpoints and mixed providers', () => {
  for (const overrides of [
    { ACTIONS_ID_TOKEN_REQUEST_TOKEN: '' }, { GITHUB_ACTIONS: '' }, { RUNNER_ENVIRONMENT: 'self-hosted' },
    { AZURE_CLIENT_SECRET: 'do-not-echo-test-value' }, { AZURE_FEDERATED_TOKEN_FILE: '/tmp/token' },
    { AZURE_TRUSTED_SIGNING_ENDPOINT: 'https://eus.codesigning.azure.net.attacker.test/' },
    { AZURE_TRUSTED_SIGNING_ENDPOINT: 'https://eus.codesigning.azure.net/sign' },
    { AZURE_TRUSTED_SIGNING_ENDPOINT: 'https://eus.codesigning.azure.net/?redirect=1' },
    { AZURE_CLIENT_ID: 'missing' }, { WIN_CSC_LINK: 'unexpected-certificate' },
    { PACKPROOF_WINDOWS_SIGNING_PROVIDER: 'unsigned' },
  ]) assert.throws(() => checkReleaseEnvironment({ env: { ...azure, ...overrides }, platform: 'win32' }), error => !error.message.includes('do-not-echo-test-value'));
});

test('missing Windows signing material fails closed without echoing secrets', () => {
  const env = { ...windows, WIN_CSC_LINK: '', WIN_CSC_KEY_PASSWORD: 'do-not-echo-test-value' };
  assert.throws(() => checkReleaseEnvironment({ env, platform: 'win32' }), error => /WIN_CSC_LINK/.test(error.message) && !error.message.includes('do-not-echo-test-value'));
});
test('public build flags cannot make production silently unsigned', () => {
  assert.throws(() => checkReleaseEnvironment({ env: { ...windows, WIN_CSC_LINK: '' }, platform: 'win32' }));
  assert.throws(() => checkReleaseEnvironment({ env: windows, platform: 'linux' }), /native Windows or macOS/);
});
test('update URL is bound to owned origin, environment and architecture', () => {
  checkReleaseEnvironment({ env: windows, platform: 'win32' });
  for (const url of ['https://downloads.thepackproof.com/desktop/staging/win32/x64/', 'https://attacker.example/latest/', windows.PACKPROOF_UPDATES_URL + '?redirect=1', windows.PACKPROOF_UPDATES_URL.replace('/x64/', '/arm64/')]) {
    assert.throws(() => checkReleaseEnvironment({ env: { ...windows, PACKPROOF_UPDATES_URL: url }, platform: 'win32' }), /PACKPROOF_UPDATES_URL/);
  }
});
test('channels have unique install identities and protocol registrations', () => {
  const contexts = ['development', 'staging', 'production'].map(APP_ENV => releaseContext({ APP_ENV }, 'win32', 'x64'));
  for (const field of ['appId', 'productName', 'packageName', 'protocol', 'updateUrl', 'outputDirectory']) assert.equal(new Set(contexts.map(item => item[field])).size, 3);
  assert.equal(contexts[2].protocol, 'packproof');
});
test('signed PKG builds require the Installer certificate and notarization', () => {
  const env = { ...windows, PACKPROOF_BUILD_PKG: '1', PACKPROOF_UPDATES_URL: 'https://downloads.thepackproof.com/desktop/production/darwin/x64/', CSC_LINK: 'test', CSC_KEY_PASSWORD: 'test', APPLE_TEAM_ID: 'TESTTEAM' };
  assert.throws(() => checkReleaseEnvironment({ env, platform: 'darwin' }), /Apple notarization/);
  assert.throws(() => checkReleaseEnvironment({ env, platform: 'darwin' }), /CSC_INSTALLER_LINK/);
});
test('hardware acceptance cannot be replaced by a successful compile', () => {
  const sourceCommit = 'a'.repeat(40);
  const report = { sourceCommit, approvedBy: 'Reviewer', testedAt: '2026-09-27T12:00:00Z', tests: required.map(id => ({ id, status: 'passed', evidence: 'Evidence record reference' })) };
  assert.equal(validateAcceptance(report, sourceCommit), true);
  assert.throws(() => validateAcceptance(report, 'b'.repeat(40)), /exact source commit/);
  report.tests[0].status = 'pending';
  assert.throws(() => validateAcceptance(report, sourceCommit), /incomplete/);
});
test('production promotion requires actual centralized reporting delivery evidence', () => {
  const sourceCommit = 'd'.repeat(40);
  const report = { sourceCommit, approvedBy: 'Reviewer', testedAt: '2026-09-27T12:00:00Z', tests: required.filter(id => id !== 'centralized-error-reporting-delivery').map(id => ({ id, status: 'passed', evidence: 'Evidence record reference' })) };
  assert.throws(() => validateAcceptance(report, sourceCommit), /centralized-error-reporting-delivery/);
});

test('publication rejects tampering after native signature verification', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'packproof-release-test-'));
  try {
    const bytes = Buffer.from('synthetic signed artifact fixture; no executable');
    const file = 'PackProof-Setup-1.0.0.exe';
    const sourceCommit = 'c'.repeat(40);
    fs.writeFileSync(path.join(directory, file), bytes);
    fs.writeFileSync(path.join(directory, 'release-evidence.json'), JSON.stringify({
      channel: 'production', sourceCommit, signed: true, platform: 'win32', arch: 'x64', version: '1.0.0',
      updateUrl: 'https://downloads.thepackproof.com/desktop/production/win32/x64/',
      checks: ['authenticode-valid', 'publisher-matches', 'timestamp-valid'],
      artifacts: [{ file, bytes: bytes.length, sha256: crypto.createHash('sha256').update(bytes).digest('hex') }],
    }));
    const sha512 = crypto.createHash('sha512').update(bytes).digest('base64');
    fs.writeFileSync(path.join(directory, 'latest.yml'), YAML.stringify({ version: '1.0.0', files: [{ url: file, sha512 }], path: file, sha512 }));
    await inspectRelease(directory, { channel: 'production', sourceCommit });
    fs.writeFileSync(path.join(directory, 'latest.yml'), YAML.stringify({ version: '1.0.0', files: [{ url: 'https://attacker.example/payload.exe', sha512 }] }));
    await assert.rejects(inspectRelease(directory, { channel: 'production', sourceCommit }), /unverified or external/);
    fs.writeFileSync(path.join(directory, file), 'changed after signature verification');
    await assert.rejects(inspectRelease(directory, { channel: 'production', sourceCommit }), /do not match/);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});
