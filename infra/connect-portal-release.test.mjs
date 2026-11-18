import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { assetMap, matchAsset, switchOrigin, target, withOriginLease } from './connect-portal-release.mjs';
import { digest, releaseConfig, writeConnectRelease } from '../web/scripts/write-connect-release.mjs';

const env = { PACKPROOF_WEB_RELEASE_COMMIT: 'b'.repeat(40), VITE_PACKPROOF_API_BASE_URL: target.api,
  VITE_PACKPROOF_AUTH_MODE: 'cognito', VITE_PACKPROOF_COGNITO_REGION: target.region,
  VITE_PACKPROOF_COGNITO_USER_POOL_ID: target.userPoolId, VITE_PACKPROOF_COGNITO_CLIENT_ID: target.clientId };
function manifest(commit, files) {
  const assets = Object.entries(files).map(([key, bytes]) => ({ path: key, byteSize: Buffer.byteLength(bytes), sha256: digest(bytes) }));
  return { schema: 'packproof.web-release/v1', ...releaseConfig(env), commit, indexSha256: digest(files['index.html']),
    approvalPath: '/app/records/connect/approve', capabilities: { connectApproval: 1, orderWorkspaceApproval: 1 }, assets };
}
async function sample(t, name, files) {
  const dir = await mkdtemp(path.join(tmpdir(), 'portal-release-test-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const m = manifest(name.repeat(40), files), manifestBytes = Buffer.from(JSON.stringify(m));
  for (const [key, data] of Object.entries({ ...files, 'release.json': manifestBytes })) {
    await mkdir(path.dirname(path.join(dir, key)), { recursive: true }); await writeFile(path.join(dir, key), data);
  }
  return { manifest: m, manifestBytes, dir, entries: assetMap(m, true) };
}
async function origin(base, now = Date.now) {
  const values = new Map();
  const writes = [];
  function set(key, bytes) { values.set(key, { bytes, hash: digest(bytes), etag: '"' + digest(bytes) + '"', modified: now() }); }
  for (const key of [...base.entries.keys(), 'release.json']) set(key, await readFile(path.join(base.dir, key)));
  return { writes, get: key => values.get(key), set, inspect: async key => values.get(key) || null,
    put: async (a, f, previous) => { assert.equal(values.get(a.path)?.etag, previous); const bytes = await readFile(f);
      assert.equal(digest(bytes), a.sha256); writes.push(a.path); set(a.path, bytes); return { ETag: values.get(a.path).etag }; } };
}
test('rejects fixture auth, unsafe paths, duplicate assets, mismatched index and corrupt bytes', () => {
  assert.throws(() => releaseConfig({ ...env, VITE_PACKPROOF_AUTH_MODE: 'dev' }));
  const m = manifest('a'.repeat(40), { 'index.html': 'index' });
  for (const key of ['../outside', '.packproof/portal-publisher.json', '/absolute', 'x//y', 'release.json', 'index.html']) {
    assert.throws(() => assetMap({ ...m, assets: [...m.assets, { ...m.assets[0], path: key }] }));
  }
  assert.throws(() => assetMap({ ...m, indexSha256: 'e'.repeat(64) }));
  assert.throws(() => matchAsset(Buffer.from('other'), m.assets[0]));
  assert.throws(() => assetMap({ ...m, auth: { ...m.auth, clientId: 'another' } }, true));
});
test('manifest must describe compiled Cognito/identity/approval bytes', async t => {
  const b = await sample(t, 'a', { 'index.html': 'page', 'assets/app.js': 'dev' });
  await assert.rejects(writeConnectRelease(b.dir, env), /compiled application/);
  await writeFile(path.join(b.dir, 'assets/app.js'), [env.PACKPROOF_WEB_RELEASE_COMMIT, target.api, target.userPoolId,
    target.clientId, 'packproof.connect.approval-return.v1', 'Review this collection computer', 'Approve collection',
    'workspaceSession', '/order-workspace/'].join(' '));
  assert.equal((await writeConnectRelease(b.dir, env)).capabilities.orderWorkspaceApproval, 1);
});
test('resumes after an interrupted switch, verifies changed keys, then restores captured bytes and retains old chunks', async t => {
  const a = await sample(t, 'a', { 'index.html': 'old', 'logo.svg': 'old logo', 'assets/old.js': 'old file' });
  const b = await sample(t, 'b', { 'index.html': 'new', 'logo.svg': 'new logo', 'assets/new.js': 'new file' });
  const s = await origin(a), put = s.put;
  await assert.rejects(switchOrigin(a, b, { ...s, put: async (...args) => {
    if (args[0].path === 'index.html') throw Error('interrupted'); return put(...args);
  } }), /interrupted/);
  assert.equal(s.get('index.html').hash, digest('old'));
  await switchOrigin(a, b, s);
  assert.deepEqual(s.writes, ['logo.svg', 'assets/new.js', 'index.html', 'release.json']);
  await switchOrigin(a, b, s);
  assert.equal(s.writes.length, 4);
  await switchOrigin(b, a, s);
  assert.equal(s.get('release.json').hash, digest(a.manifestBytes)); assert.equal(s.get('logo.svg').hash, digest('old logo'));
  assert.ok(s.get('assets/old.js')); assert.ok(s.get('assets/new.js'));
  s.set('logo.svg', Buffer.from('independent edit'));
  await assert.rejects(switchOrigin(a, b, s), /changed independently/);
  s.set('release.json', Buffer.from('another release'));
  await assert.rejects(switchOrigin(a, b, s), /another release/);
});
test('overlapping publishers are excluded and an abandoned lease can be recovered', async t => {
  let clock = 1700000000000;
  const dir = await mkdtemp(path.join(tmpdir(), 'portal-lease-test-')); t.after(() => rm(dir, { recursive: true, force: true }));
  const a = await sample(t, 'a', { 'index.html': 'old' }), s = await origin(a, () => clock);
  const key = '.packproof/portal-publisher.json';
  await withOriginLease(s, dir, async hb => {
    await assert.rejects(withOriginLease(s, dir, async () => {}, () => clock), /publication is in progress/);
    clock += 31000; await hb();
  }, () => clock);
  assert.equal(JSON.parse(s.get(key).bytes).state, 'idle');
  s.set(key, Buffer.from(JSON.stringify({ schema: 'packproof.portal-publisher/v1', state: 'publishing', holder: 'stopped' })));
  clock += 5 * 60000 + 1;
  await withOriginLease(s, dir, async () => {}, () => clock);
  assert.equal(JSON.parse(s.get(key).bytes).state, 'idle');
});
