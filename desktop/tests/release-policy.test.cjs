const test = require('node:test');
const assert = require('node:assert/strict');
const { releaseContext, checkReleaseEnvironment } = require('../scripts/release-policy.cjs');
const { validateAcceptance, required, validatePlatformScope, platformsForScope, requiredForScope } = require('../scripts/check-acceptance.cjs');
const { inspectRelease } = require('../scripts/publish-release.cjs');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const YAML = require('yaml');

const mac = {
  APP_ENV: 'production', PACKPROOF_BUILD_ARCH: 'x64',
  PACKPROOF_API_BASE_URL: 'https://api.example.test', PACKPROOF_COGNITO_CLIENT_ID: 'examplepublicclient',
  PACKPROOF_COGNITO_REGION: 'us-east-1', PACKPROOF_UPDATES_URL: 'https://downloads.thepackproof.com/desktop/production/darwin/x64/',
  PACKPROOF_SENTRY_DSN: 'https://0123456789abcdef0123456789abcdef@o1.ingest.sentry.io/123',
  CSC_LINK: 'test', CSC_KEY_PASSWORD: 'test', APPLE_TEAM_ID: 'TESTTEAM',
  APPLE_ID: 'test', APPLE_APP_SPECIFIC_PASSWORD: 'test',
};

test('production requires a public reporting destination and rejects credential-bearing or arbitrary endpoints', () => {
  for (const dsn of ['', 'http://0123456789abcdef0123456789abcdef@o1.ingest.sentry.io/123', 'https://0123456789abcdef0123456789abcdef:secret@o1.ingest.sentry.io/123', 'https://0123456789abcdef0123456789abcdef@collector.example.test/123']) {
    assert.throws(() => checkReleaseEnvironment({ env: { ...mac, PACKPROOF_SENTRY_DSN: dsn }, platform: 'darwin' }), /PACKPROOF_SENTRY_DSN/);
  }
  checkReleaseEnvironment({ env: { ...mac, APP_ENV: 'staging', PACKPROOF_SENTRY_DSN: '', PACKPROOF_UPDATES_URL: mac.PACKPROOF_UPDATES_URL.replace('/production/', '/staging/') }, platform: 'darwin' });
});
test('production rejects a build with a different reporting project', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'packproof-runtime-release-test-'));
  try {
    fs.mkdirSync(path.join(directory, 'dist/main'), { recursive: true });
    const runtime = { channel: 'production', updateUrl: mac.PACKPROOF_UPDATES_URL, apiBaseUrl: mac.PACKPROOF_API_BASE_URL, cognito: { clientId: mac.PACKPROOF_COGNITO_CLIENT_ID }, sentryDsn: '' };
    fs.writeFileSync(path.join(directory, 'dist/main/runtime-config.json'), JSON.stringify(runtime));
    assert.throws(() => checkReleaseEnvironment({ env: mac, platform: 'darwin', checkRuntime: true, cwd: directory }), /reporting destination/);
    runtime.sentryDsn = mac.PACKPROOF_SENTRY_DSN;
    fs.writeFileSync(path.join(directory, 'dist/main/runtime-config.json'), JSON.stringify(runtime));
    checkReleaseEnvironment({ env: mac, platform: 'darwin', checkRuntime: true, cwd: directory });
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});
test('signed releases require a macOS runner and signing material', () => {
  assert.throws(() => checkReleaseEnvironment({ env: { ...mac, CSC_LINK: '' }, platform: 'darwin' }), /CSC_LINK/);
  assert.throws(() => checkReleaseEnvironment({ env: { ...mac, PACKPROOF_BUILD_PLATFORM: 'darwin' }, platform: 'linux' }), /native macOS/);
  assert.throws(() => checkReleaseEnvironment({ env: { APP_ENV: 'development' }, platform: 'win32' }), /macOS only/);
});
test('update URL is bound to owned origin, environment and architecture', () => {
  checkReleaseEnvironment({ env: mac, platform: 'darwin' });
  for (const url of ['https://downloads.thepackproof.com/desktop/staging/darwin/x64/', 'https://attacker.example/latest/', mac.PACKPROOF_UPDATES_URL + '?redirect=1', mac.PACKPROOF_UPDATES_URL.replace('/x64/', '/arm64/')]) {
    assert.throws(() => checkReleaseEnvironment({ env: { ...mac, PACKPROOF_UPDATES_URL: url }, platform: 'darwin' }), /PACKPROOF_UPDATES_URL/);
  }
});
test('channels have unique install identities and protocol registrations', () => {
  const contexts = ['development', 'staging', 'production'].map(APP_ENV => releaseContext({ APP_ENV }, 'darwin', 'x64'));
  for (const field of ['appId', 'productName', 'packageName', 'protocol', 'updateUrl', 'outputDirectory']) assert.equal(new Set(contexts.map(item => item[field])).size, 3);
  assert.equal(contexts[2].protocol, 'packproof');
});
test('signed PKG builds require the Installer certificate and notarization', () => {
  const env = { ...mac, PACKPROOF_BUILD_PKG: '1', APPLE_ID: '' };
  assert.throws(() => checkReleaseEnvironment({ env, platform: 'darwin' }), /Apple notarization/);
  assert.throws(() => checkReleaseEnvironment({ env, platform: 'darwin' }), /CSC_INSTALLER_LINK/);
});
test('hardware acceptance cannot be replaced by a successful compile', () => {
  const sourceCommit = 'a'.repeat(40);
  const report = { sourceCommit, platforms: 'mac', approvedBy: 'Reviewer', testedAt: '2026-09-27T12:00:00Z', tests: required.map(id => ({ id, status: 'passed', evidence: 'Evidence record reference' })) };
  assert.equal(validateAcceptance(report, sourceCommit), true);
  assert.throws(() => validateAcceptance(report, 'b'.repeat(40)), /exact source commit/);
  report.tests[0].status = 'pending';
  assert.throws(() => validateAcceptance(report, sourceCommit), /incomplete/);
});

test('only the Mac scope can authorize releases of both supported architectures', () => {
  assert.equal(validatePlatformScope(), 'mac');
  for (const value of ['', 'all', 'windows', null, [], {}]) assert.throws(() => validatePlatformScope(value));
  assert.deepEqual(platformsForScope(), ['darwin/x64', 'darwin/arm64']);
  assert.equal(requiredForScope().length, 17);
});

test('acceptance must explicitly identify the supported platform scope', () => {
  const sourceCommit = 'a'.repeat(40);
  const report = platforms => ({ sourceCommit, platforms, approvedBy: 'Reviewer', testedAt: '2026-10-12T01:00:00Z', tests: required.map(id => ({ id, status: 'passed', evidence: 'Synthetic policy-test reference' })) });
  assert.equal(validateAcceptance(report('mac'), sourceCommit), true);
  for (const scope of [undefined, 'all', 'windows']) assert.throws(() => validateAcceptance(report(scope), sourceCommit), /scope/);
  const duplicate = report('mac');duplicate.tests.push({ ...duplicate.tests[0], status: 'pending' });
  assert.throws(() => validateAcceptance(duplicate, sourceCommit, 'mac'), /duplicate/);
  const extra = report('mac');extra.tests.push({ id: 'unexpected-install-gate', status: 'passed', evidence: 'Unrelated scope' });
  assert.throws(() => validateAcceptance(extra, sourceCommit, 'mac'), /scope/);
  for (const value of ['pending', 'partial', 'not-applicable']) {
    const incomplete = report('mac');incomplete.tests.find(test => test.id === 'continuous-recording-valid-media').status = value;
    assert.throws(() => validateAcceptance(incomplete, sourceCommit, 'mac'), /continuous-recording-valid-media/);
  }
  for (const value of ['', ' ', null, true]) {
    const incomplete = report('mac');incomplete.tests.find(test => test.id === 'privacy-review').evidence = value;
    assert.throws(() => validateAcceptance(incomplete, sourceCommit, 'mac'), /privacy-review/);
  }
});
test('production promotion requires actual centralized reporting delivery evidence', () => {
  const sourceCommit = 'd'.repeat(40);
  const report = { sourceCommit, platforms: 'mac', approvedBy: 'Reviewer', testedAt: '2026-09-27T12:00:00Z', tests: required.filter(id => id !== 'centralized-error-reporting-delivery').map(id => ({ id, status: 'passed', evidence: 'Evidence record reference' })) };
  assert.throws(() => validateAcceptance(report, sourceCommit), /centralized-error-reporting-delivery/);
});

test('an explicit owner device waiver is bound to source, scope and accountable approval without claiming passed tests', () => {
  const sourceCommit = 'e'.repeat(40);
  const report = {
    sourceCommit, platforms:'mac', approvedBy:'Synthetic owner', testedAt:'2026-10-13T18:00:00Z',
    deviceCheckWaiver:{sourceCommit,platforms:'mac',approvedBy:'Synthetic owner',approvedAt:'2026-10-13T17:00:00Z',authorization:'Synthetic explicit device-check waiver for policy testing only',acknowledgesUnverifiedDeviceBehavior:true},
    tests:requiredForScope('mac').map(id=>({id,status:['privacy-review','centralized-error-reporting-delivery'].includes(id)?'passed':'waived-device-check',evidence:'Synthetic test fixture; no real acceptance'})),
  };
  assert.equal(validateAcceptance(report,sourceCommit,'mac'),true);
  const noWaiver=structuredClone(report);delete noWaiver.deviceCheckWaiver;
  assert.throws(()=>validateAcceptance(noWaiver,sourceCommit,'mac'),/incomplete/);
  for (const [key,value] of [['sourceCommit','f'.repeat(40)],['platforms','all'],['approvedBy','Another reviewer'],['approvedAt','invalid'],['authorization',' '],['acknowledgesUnverifiedDeviceBehavior',false]]) {
    const invalid=structuredClone(report);invalid.deviceCheckWaiver[key]=value;
    assert.throws(()=>validateAcceptance(invalid,sourceCommit,'mac'),/waiver/);
  }
  for (const id of ['privacy-review','centralized-error-reporting-delivery']) {
    const invalid=structuredClone(report);invalid.tests.find(test=>test.id===id).status='waived-device-check';
    assert.throws(()=>validateAcceptance(invalid,sourceCommit,'mac'),new RegExp(id));
  }
  const incomplete=structuredClone(report);incomplete.tests[0].evidence='';
  assert.throws(()=>validateAcceptance(incomplete,sourceCommit,'mac'),/incomplete/);
});

test('publication rejects tampering after native signature verification', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'packproof-release-test-'));
  try {
    const bytes = Buffer.from('synthetic signed artifact fixture; no executable');
    const file = 'PackProof-1.0.0-x64.zip';
    const sourceCommit = 'c'.repeat(40);
    fs.writeFileSync(path.join(directory, file), bytes);
    fs.writeFileSync(path.join(directory, 'release-evidence.json'), JSON.stringify({
      channel: 'production', sourceCommit, signed: true, platform: 'darwin', arch: 'x64', version: '1.0.0',
      updateUrl: 'https://downloads.thepackproof.com/desktop/production/darwin/x64/',
      checks: ['codesign-valid', 'apple-team-matches', 'hardened-runtime', 'notarized', 'stapled', 'gatekeeper-accepted'],
      artifacts: [{ file, bytes: bytes.length, sha256: crypto.createHash('sha256').update(bytes).digest('hex') }],
    }));
    const sha512 = crypto.createHash('sha512').update(bytes).digest('base64');
    fs.writeFileSync(path.join(directory, 'latest-mac.yml'), YAML.stringify({ version: '1.0.0', files: [{ url: file, sha512 }], path: file, sha512 }));
    await inspectRelease(directory, { channel: 'production', sourceCommit });
    fs.writeFileSync(path.join(directory, 'latest-mac.yml'), YAML.stringify({ version: '1.0.0', files: [{ url: 'https://attacker.example/payload.zip', sha512 }] }));
    await assert.rejects(inspectRelease(directory, { channel: 'production', sourceCommit }), /unverified or external/);
    fs.writeFileSync(path.join(directory, file), 'changed after signature verification');
    await assert.rejects(inspectRelease(directory, { channel: 'production', sourceCommit }), /do not match/);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});
