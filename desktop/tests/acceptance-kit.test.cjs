const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { inspectCandidates, prepareKit, parseArguments } = require('../scripts/prepare-acceptance-kit.cjs');
const { required, validateAcceptance } = require('../scripts/check-acceptance.cjs');
const sourceCommit = 'a'.repeat(40);
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'packproof-kit-')), artifacts = path.join(root, 'artifacts'), out = path.join(root, 'kit');
  fs.mkdirSync(artifacts);const bytes = Buffer.from('synthetic installer fixture, not executable'), file = 'PackProof-Dev-Setup.exe';fs.writeFileSync(path.join(artifacts, file), bytes);
  const report = { sourceCommit, version: '1.0.0', channel: 'development', signed: false, platform: 'win32', arch: 'x64', artifacts: [{ file, bytes: bytes.length, sha256: crypto.createHash('sha256').update(bytes).digest('hex') }] };
  const save = () => fs.writeFileSync(path.join(artifacts, 'release-evidence.json'), JSON.stringify(report));save();
  return { root, artifacts, out, report, save };
}
test('candidate kit verifies bytes but leaves every current release gate pending and unapproved', async () => {
  const f = fixture();try {
    const result = await prepareKit({ sourceCommit, artifacts: f.artifacts, out: f.out });
    assert.equal(result.pendingGates, required.length);assert.deepEqual(result.missingPlatforms, ['darwin-x64', 'darwin-arm64']);
    const report = JSON.parse(fs.readFileSync(path.join(f.out, 'release-acceptance.json')));
    assert.equal(report.sourceCommit, sourceCommit);assert.equal(report.approvedBy, '');assert.deepEqual(report.tests.map(t => t.id), required);assert.ok(report.tests.every(t => t.status === 'pending' && t.evidence === ''));
    assert.throws(() => validateAcceptance(report, sourceCommit));
    const manifest = JSON.parse(fs.readFileSync(path.join(f.out, 'candidate-manifest.json')));assert.equal(manifest.acceptance, 'not-executed');assert.equal(manifest.inventories[0].signed, false);
    await assert.rejects(prepareKit({ sourceCommit, artifacts: f.artifacts, out: f.out }), /Output already exists/);
  } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
});
test('wrong source, changed installer bytes and escaped inventory paths are rejected before output creation', async () => {
  const f = fixture();try {
    await assert.rejects(inspectCandidates(f.artifacts, 'b'.repeat(40)), /exact source/);
    fs.writeFileSync(path.join(f.artifacts, f.report.artifacts[0].file), 'tampered');
    await assert.rejects(prepareKit({ sourceCommit, artifacts: f.artifacts, out: f.out }), /bytes do not match/);assert.equal(fs.existsSync(f.out), false);
    f.report.artifacts[0].file = '../outside.exe';f.save();await assert.rejects(inspectCandidates(f.artifacts, sourceCommit), /invalid filename/);
  } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
});
test('mixed versions and duplicate platform inventories cannot form one candidate', async () => {
  const f = fixture();try {
    const second = path.join(f.artifacts, 'second');fs.mkdirSync(second);
    fs.copyFileSync(path.join(f.artifacts, f.report.artifacts[0].file), path.join(second, f.report.artifacts[0].file));
    const file = path.join(second, 'release-evidence.json');fs.writeFileSync(file, JSON.stringify(f.report));
    await assert.rejects(inspectCandidates(f.artifacts, sourceCommit), /duplicate platform/);
    fs.writeFileSync(file, JSON.stringify({ ...f.report, platform: 'darwin', arch: 'arm64', version: '2.0.0' }));
    await assert.rejects(inspectCandidates(f.artifacts, sourceCommit), /same channel and version/);
  } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
});
test('symlink inputs and malformed command lines are rejected', async () => {
  const f = fixture();try {
    const alias = path.join(f.root, 'linked');fs.symlinkSync(f.artifacts, alias, process.platform === 'win32' ? 'junction' : 'dir');
    await assert.rejects(inspectCandidates(alias, sourceCommit), /symbolic links/);
    for (const args of [[], ['--source', 'main', '--artifacts', f.artifacts, '--out', f.out], ['--source', sourceCommit, '--source', sourceCommit]]) assert.throws(() => parseArguments(args));
    assert.equal(parseArguments(['--source', sourceCommit, '--artifacts', f.artifacts, '--out', f.out]).sourceCommit, sourceCommit);
  } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
});
