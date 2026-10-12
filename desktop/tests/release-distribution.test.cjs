const test = require('node:test');
const assert = require('node:assert/strict');
const { existingReleaseObject, publishRelease } = require('../scripts/publish-release.cjs');
const { requiredForScope } = require('../scripts/check-acceptance.cjs');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const YAML = require('yaml');

test('a missing immutable release key is checked using only its channel prefix', () => {
  const calls = [];
  const key = 'desktop/staging/win32/x64/PackProof-Staging-1.0.0.exe';
  const result = existingReleaseObject('release-bucket', key, args => { calls.push(args); return JSON.stringify({ Contents: [{ Key: `${key}.blockmap` }] }); });
  assert.equal(result, null);
  assert.equal(calls.length, 1);
  assert.equal(calls[0][1], 'list-objects-v2');
  assert.equal(calls[0][calls[0].indexOf('--prefix') + 1], key);
});

test('an existing release is inspected before deciding whether its hash permits an idempotent replay', () => {
  const key = 'desktop/production/darwin/arm64/PackProof-1.0.0.zip';
  const calls = [];
  const result = existingReleaseObject('release-bucket', key, args => { calls.push(args); return JSON.stringify(args[1] === 'list-objects-v2' ? { Contents: [{ Key: key }] } : { Metadata: { sha256: 'verified-original-hash' } }); });
  assert.equal(result.Metadata.sha256, 'verified-original-hash');
  assert.deepEqual(calls.map(args => args[1]), ['list-objects-v2', 'head-object']);
});

test('an access denial never becomes permission to replace an existing release', () => {
  const key = 'desktop/production/win32/x64/PackProof-1.0.0.exe';
  assert.throws(() => existingReleaseObject('release-bucket', key, args => {
    if (args[1] === 'list-objects-v2') return JSON.stringify({ Contents: [{ Key: key }] });
    throw new Error('AccessDenied');
  }), /AccessDenied/);
});

const sourceCommit = 'a'.repeat(40);
function releaseFixture(scope, members) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'packproof-scoped-release-'));
  const receipts = [];
  for (const [index, identity] of members.entries()) {
    const [platform, arch] = identity.split('/'), directory = path.join(root, `candidate-${index}`);fs.mkdirSync(directory);
    const file = platform === 'win32' ? 'PackProof-Setup-1.0.1.exe' : `PackProof-1.0.1-${arch}.zip`;
    const bytes = Buffer.from(`Synthetic nonexecutable signing-policy fixture ${identity}`);
    const checks = platform === 'win32' ? ['authenticode-valid', 'publisher-matches', 'timestamp-valid'] : ['codesign-valid', 'apple-team-matches', 'hardened-runtime', 'notarized', 'stapled', 'gatekeeper-accepted'];
    const report = { channel: 'production', sourceCommit, signed: true, platform, arch, version: '1.0.1', checks,
      updateUrl: `https://downloads.thepackproof.com/desktop/production/${platform}/${arch}/`,
      artifacts: [{ file, bytes: bytes.length, sha256: crypto.createHash('sha256').update(bytes).digest('hex') }] };
    fs.writeFileSync(path.join(directory, file), bytes);fs.writeFileSync(path.join(directory, 'release-evidence.json'), JSON.stringify(report));
    fs.writeFileSync(path.join(directory, 'SHA256SUMS'), `${report.artifacts[0].sha256}  ${file}\n`);
    const metadataName = platform === 'win32' ? 'latest.yml' : 'latest-mac.yml';
    fs.writeFileSync(path.join(directory, metadataName), YAML.stringify({ version: report.version, files: [{ url: file, sha512: crypto.createHash('sha512').update(bytes).digest('base64') }] }));
    receipts.push({ directory, report, metadataName, save: () => fs.writeFileSync(path.join(directory, 'release-evidence.json'), JSON.stringify(report)) });
  }
  const acceptance = { sourceCommit, platforms: scope, approvedBy: 'Synthetic policy-test reviewer', testedAt: '2026-10-12T01:00:00Z', tests: requiredForScope(scope).map(id => ({ id, status: 'passed', evidence: 'Synthetic policy test only; no actual acceptance' })) };
  const env = { APP_ENV: 'production', GITHUB_SHA: sourceCommit, PACKPROOF_RELEASE_BUCKET: 'synthetic-release-bucket', PACKPROOF_RELEASE_PLATFORMS: scope, PACKPROOF_RELEASE_ACCEPTANCE_JSON: JSON.stringify(acceptance) };
  const events = [];
  const executeAws = args => { events.push({ kind: 'aws', args });return '{}'; };
  const fetchImpl = async url => {
    events.push({ kind: 'fetch', url });
    if (url.endsWith('/health.json')) return { ok: true, json: async () => ({ service: 'packproof-desktop-updates' }) };
    const receipt = receipts.find(item => url === item.report.updateUrl + item.metadataName);
    assert.ok(receipt);return { ok: true, arrayBuffer: async () => fs.readFileSync(path.join(receipt.directory, receipt.metadataName)) };
  };
  return { root, receipts, acceptance, env, events, executeAws, fetchImpl };
}

test('selected Mac, Windows and legacy all releases upload all selected binaries before any update pointers', async () => {
  for (const [scope, members] of [['mac', ['darwin/x64', 'darwin/arm64']], ['windows', ['win32/x64']], ['all', ['win32/x64', 'darwin/x64', 'darwin/arm64']]]) {
    const f = releaseFixture(scope, members);try {
      if (scope === 'all') { delete f.env.PACKPROOF_RELEASE_PLATFORMS;delete f.acceptance.platforms;f.env.PACKPROOF_RELEASE_ACCEPTANCE_JSON = JSON.stringify(f.acceptance); }
      assert.equal((await publishRelease(f)).platforms, scope);
      const writes = f.events.filter(event => event.kind === 'aws' && event.args[0] === 's3');
      const firstPointer = writes.findIndex(event => /latest(?:-mac)?\.yml$/.test(event.args[3]));
      assert.equal(firstPointer, members.length * 3);
      assert.equal(writes.length, members.length * 4);
      assert.ok(writes.slice(firstPointer).every(event => /latest(?:-mac)?\.yml$/.test(event.args[3])));
      assert.ok(writes.every(event => members.some(identity => event.args[3].includes(`/production/${identity}/`))));
    } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
  }
});

test('missing, extra, duplicate or mixed release identities fail before network access or cloud writes', async () => {
  const scenarios = [
    { members: ['darwin/x64'] },
    { members: ['darwin/x64', 'darwin/arm64', 'win32/x64'] },
    { members: ['darwin/x64', 'darwin/x64'] },
    { mutate: f => { f.receipts[1].report.sourceCommit = 'b'.repeat(40);f.receipts[1].save(); } },
    { mutate: f => { f.receipts[1].report.channel = 'staging';f.receipts[1].save(); } },
    { mutate: f => { f.receipts[1].report.version = '1.0.2';f.receipts[1].save();const file = path.join(f.receipts[1].directory, 'latest-mac.yml');const metadata = YAML.parse(fs.readFileSync(file, 'utf8'));metadata.version = '1.0.2';fs.writeFileSync(file, YAML.stringify(metadata)); } },
    { mutate: f => { f.receipts[1].report.checks = [];f.receipts[1].save(); } },
    { mutate: f => fs.writeFileSync(path.join(f.receipts[1].directory, f.receipts[1].report.artifacts[0].file), 'tampered') },
  ];
  for (const scenario of scenarios) {
    const f = releaseFixture('mac', scenario.members || ['darwin/x64', 'darwin/arm64']);try {
      scenario.mutate?.(f);await assert.rejects(publishRelease(f));assert.deepEqual(f.events, []);
    } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
  }
});

test('invalid scope, legacy or mismatched acceptance, and shared pending cases cannot trigger publication', async () => {
  for (const mutate of [f => f.env.PACKPROOF_RELEASE_PLATFORMS = '', f => f.env.PACKPROOF_RELEASE_PLATFORMS = 'darwin',
    f => delete f.acceptance.platforms, f => f.acceptance.platforms = 'all',
    f => f.acceptance.tests.find(item => item.id === 'camera-permissions-disconnect').status = 'pending',
    f => f.acceptance.tests.find(item => item.id === 'privacy-review').evidence = '']) {
    const f = releaseFixture('mac', ['darwin/x64', 'darwin/arm64']);try {
      mutate(f);f.env.PACKPROOF_RELEASE_ACCEPTANCE_JSON = JSON.stringify(f.acceptance);
      await assert.rejects(publishRelease(f));assert.deepEqual(f.events, []);
    } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
  }
});

test('a signed verification flag must be the literal boolean true before any network access', async () => {
  for (const signed of [false, 'true', 'false', 1, {}, [], null]) {
    const f = releaseFixture('mac', ['darwin/x64', 'darwin/arm64']);try {
      f.receipts[1].report.signed = signed;f.receipts[1].save();
      await assert.rejects(publishRelease(f), /signed release verification/);
      assert.deepEqual(f.events, []);
    } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
  }
});

test('missing or non-file auxiliary uploads in the later architecture fail before health reads or cloud writes', async () => {
  for (const mutate of [
    directory => fs.unlinkSync(path.join(directory, 'SHA256SUMS')),
    directory => { fs.unlinkSync(path.join(directory, 'SHA256SUMS'));fs.mkdirSync(path.join(directory, 'SHA256SUMS')); },
    directory => fs.mkdirSync(path.join(directory, 'PackProof-1.0.1-arm64.zip.blockmap')),
  ]) {
    const f = releaseFixture('mac', ['darwin/x64', 'darwin/arm64']);try {
      mutate(f.receipts[1].directory);
      await assert.rejects(publishRelease(f));
      assert.deepEqual(f.events, []);
    } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
  }
});

test('auxiliary blockmap bytes receive their precomputed hash and are uploaded before update pointers', async () => {
  const f = releaseFixture('mac', ['darwin/x64', 'darwin/arm64']);try {
    const name = 'PackProof-1.0.1-arm64.zip.blockmap', bytes = Buffer.from('Synthetic blockmap bytes for publication ordering only');
    fs.writeFileSync(path.join(f.receipts[1].directory, name), bytes);
    await publishRelease(f);
    const writes = f.events.filter(event => event.kind === 'aws' && event.args[0] === 's3');
    const index = writes.findIndex(event => event.args[3].endsWith(name));
    assert.ok(index >= 0 && index < writes.findIndex(event => /latest(?:-mac)?\.yml$/.test(event.args[3])));
    assert.equal(writes[index].args[writes[index].args.indexOf('--metadata') + 1], `sha256=${crypto.createHash('sha256').update(bytes).digest('hex')}`);
  } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
});
