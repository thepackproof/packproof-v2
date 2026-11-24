// Build, capture, and switch the existing PackProof Connect browser portal.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { execFile, execFileSync, spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { verifyHostedApproval } from './verify-hosted-approval.mjs';
import { digest } from '../web/scripts/write-connect-release.mjs';
import { verifyRuntimeInputs } from './connect-portal-runtime.mjs';

const execute = promisify(execFile);
const repo = fileURLToPath(new URL('../', import.meta.url));
export const target = Object.freeze({
  web: 'https://dvpmnwc27i8tw.cloudfront.net', api: 'https://pa-5faf90eb81cb4764b37bd3dc259a5ac4.ecs.us-east-1.on.aws',
  bucket: 'packproof-v2-staging-web-784514617543', owner: '784514617543', distribution: 'E1TWYI3YRLSHTD',
  region: 'us-east-1', userPoolId: 'us-east-1_GdgTeYaOO', clientId: '34pnucunllka2jcs8hsq762m5e',
});
const newOrigin = target.bucket + '.s3.' + target.region + '.amazonaws.com';
const hex = /^[a-f0-9]{64}$/;
const mime = { html: 'text/html', js: 'text/javascript', css: 'text/css', json: 'application/json', svg: 'image/svg+xml',
  png: 'image/png', jpg: 'image/jpeg', ttf: 'font/ttf', woff2: 'font/woff2', txt: 'text/plain', mp4: 'video/mp4', wasm: 'application/wasm' };

export function assetMap(manifest, requireWorkspace = false) {
  const m = manifest;
  if (m.schema !== 'packproof.web-release/v1' || m.environment !== 'production' || m.apiUrl !== target.api ||
      !/^[a-f0-9]{40}$/.test(m.commit) || m.approvalPath !== '/app/records/connect/approve' ||
      m.capabilities?.connectApproval !== 1 || !Array.isArray(m.assets) || !hex.test(m.indexSha256)) throw Error('Unexpected portal manifest');
  if (requireWorkspace && (m.capabilities.orderWorkspaceApproval !== 1 || m.auth?.mode !== 'cognito' ||
      m.auth.userPoolId !== target.userPoolId || m.auth.clientId !== target.clientId || m.auth.region !== target.region)) {
    throw Error('Candidate has no compatible customer workspace approval configuration');
  }
  const entries = new Map();
  for (const a of m.assets) {
    if (typeof a.path !== 'string' || !/^[a-zA-Z0-9._/-]+$/.test(a.path) || a.path.split('/').some(s => !s || s === '.' || s === '..') ||
        entries.has(a.path) || a.path.startsWith('.packproof/') || a.path === 'release.json' || !hex.test(a.sha256) || !Number.isSafeInteger(a.byteSize) || a.byteSize < 0) {
      throw Error('Unsafe or ambiguous release asset');
    }
    entries.set(a.path, a);
  }
  if (entries.get('index.html')?.sha256 !== m.indexSha256) throw Error('Missing or inconsistent index');
  return entries;
}

export function matchAsset(bytes, a) {
  if (bytes.length !== a.byteSize || digest(bytes) !== a.sha256) throw Error('Asset mismatch: ' + a.path);
}

// A staged rollback copy becomes visible only after all its bytes have matched.
async function batch(items, operation) {
  let cursor = 0;
  const work = async () => { while (cursor < items.length) await operation(items[cursor++]); };
  const results = await Promise.allSettled(Array.from({ length: Math.min(items.length, 6) }, work));
  const failed = results.find(r => r.status === 'rejected');
  if (failed) throw failed.reason;
}
async function request(url, options = {}) {
  return fetch(url, { cache: 'no-store', redirect: 'error', signal: AbortSignal.timeout(45000), ...options });
}
async function publicBytes(key) {
  const r = await request(target.web + '/' + key);
  if (!r.ok) throw Error('HTTP ' + r.status + ': ' + key);
  return Buffer.from(await r.arrayBuffer());
}
async function verifyRoutes(manifest) {
  const result = await verifyHostedApproval(target.web, target.api, request, { requireOrderWorkspace: manifest.capabilities.orderWorkspaceApproval === 1 });
  if (result.webCommit !== manifest.commit) throw Error('Approval link serves a different release');
}
async function readBundle(dir, requireWorkspace) {
  const manifestBytes = await readFile(path.join(dir, 'release.json'));
  const manifest = JSON.parse(manifestBytes);
  const entries = assetMap(manifest, requireWorkspace);
  await batch([...entries.values()], async a => matchAsset(await readFile(path.join(dir, a.path)), a));
  return { dir, manifest, manifestBytes, entries };
}
export async function snapshot(destination) {
  const file = path.resolve(destination);
  await mkdir(path.dirname(file), { recursive: true });
  const temp = await mkdtemp(path.join(path.dirname(file), '.portal-'));
  try {
    const bytes = await publicBytes('release.json');
    const manifest = JSON.parse(bytes);
    const assets = assetMap(manifest);
    await batch([...assets.values()], async a => {
      const asset = await publicBytes(a.path);
      matchAsset(asset, a);
      const out = path.join(temp, a.path);
      await mkdir(path.dirname(out), { recursive: true });
      await writeFile(out, asset);
    });
    await verifyRoutes(manifest);
    assert.equal(digest(await publicBytes('release.json')), digest(bytes), 'Hosted release changed during snapshot');
    await writeFile(path.join(temp, 'release.json'), bytes);
    await rename(temp, file);
    return { commit: manifest.commit, files: assets.size, directory: file };
  } finally { await rm(temp, { recursive: true, force: true }); }
}
async function verifyPublic(bundle) {
  const m = bundle.manifest;
  await batch([...bundle.entries.values()], async a => matchAsset(await publicBytes(a.path), a));
  await verifyRoutes(m);
  assert.equal(digest(await publicBytes('release.json')), digest(bundle.manifestBytes), 'Hosted manifest differs');
  return { commit: m.commit, assetsVerified: bundle.entries.size, orderWorkspaceApproval: m.capabilities.orderWorkspaceApproval === 1 };
}
async function aws(args) {
  const { stdout } = await execute('aws', [...args, '--region', target.region, '--no-cli-pager', '--output', 'json'], { maxBuffer: 4 * 1024 * 1024, ...(args[1] === 'wait' ? {} : { timeout: 45000 }) });
  return stdout.trim() ? JSON.parse(stdout) : {};
}
function originStore(temp) {
  // The existing origin is unversioned. Conditional writes preserve intervening releases.
  const bucket = ['--bucket', target.bucket, '--expected-bucket-owner', target.owner];
  const current = path.join(temp, 'current');
  return {
    async inspect(key) {
      try {
        const meta = await aws(['s3api', 'get-object', ...bucket, '--key', key, current]);
        const bytes = await readFile(current);
        return { hash: digest(bytes), etag: meta.ETag, bytes, modified: Date.parse(meta.LastModified) };
      } catch (e) {
        if (/\((NoSuchKey|404|NotFound)\)/.test(e.stderr || '')) return null;
        throw e;
      }
    },
    async put(asset, filename, etag) {
      const key = asset.path;
      const type = mime[key.split('.').pop()] || 'application/octet-stream';
      const cache = /^assets\/[^/]+-[A-Za-z0-9_-]{8,}\.[^/]+$/.test(key) ? 'public,max-age=31536000,immutable' : 'no-cache,must-revalidate';
      return aws(['s3api', 'put-object', ...bucket, '--key', key, '--body', filename, '--content-type', type,
        '--cache-control', cache, '--checksum-sha256', Buffer.from(asset.sha256, 'hex').toString('base64'),
        ...(etag ? ['--if-match', etag] : ['--if-none-match', '*'])]);
    },
  };
}

// AWS protects each mutable object independently. Serialize the short origin
// switch across release operators as well. A crashed holder expires; a resumed
// holder must renew its own ETag before writing another public file.
const lockKey = '.packproof/portal-publisher.json';
export async function withOriginLease(store, dir, work, now = Date.now) {
  const holder = randomUUID();
  const file = path.join(dir, 'publisher.json');
  const old = await store.inspect(lockKey);
  if (old) {
    const lock = JSON.parse(old.bytes);
    if (lock.schema !== 'packproof.portal-publisher/v1' || !['idle', 'publishing'].includes(lock.state) ||
        !Number.isFinite(old.modified)) throw Error('Unknown portal publication state');
    if (lock.state === 'publishing' && now() - old.modified < 5 * 60000) throw Error('Another portal publication is in progress; retry after it finishes');
  }
  let etag = old?.etag, lastHeartbeat = 0;
  async function update(state) {
    const bytes = Buffer.from(JSON.stringify({ schema: 'packproof.portal-publisher/v1', state, holder }));
    await writeFile(file, bytes);
    const response = await store.put({ path: lockKey, sha256: digest(bytes) }, file, etag);
    assert.ok(response.ETag, 'S3 must acknowledge the publication lock');
    etag = response.ETag;
    lastHeartbeat = now();
  }
  async function heartbeat() { if (now() - lastHeartbeat >= 30000) await update('publishing'); }
  await update('publishing');
  try { await work(heartbeat); }
  finally { await update('idle'); }
}

export async function switchOrigin(previous, next, store, heartbeat = async () => {}) {
  const manifestAsset = b => ({ path: 'release.json', sha256: digest(b.manifestBytes) });
  const before = manifestAsset(previous), after = manifestAsset(next);
  const marker = await store.inspect('release.json');
  if (!marker || ![before.sha256, after.sha256].includes(marker.hash)) throw Error('Origin has another release; capture the current baseline');
  const assets = [...next.entries.values()].filter(a => a.path !== 'index.html');
  assets.push(next.entries.get('index.html'), after);
  for (const asset of assets) {
    const prior = asset.path === 'release.json' ? before : previous.entries.get(asset.path);
    await heartbeat();
    const existing = await store.inspect(asset.path);
    if (existing?.hash === asset.sha256) continue;
    if (existing ? existing.hash !== prior?.sha256 : !!prior) throw Error('Origin changed independently: ' + asset.path);
    await heartbeat();
    await store.put(asset, path.join(next.dir, asset.path), existing?.etag);
  }
}
export async function verifyApiTarget(commit, image, fetcher = request) {
  const response = await fetcher(target.api + '/meta');
  const meta = response.ok && await response.json();
  if (meta?.environment !== 'production' || meta.commit !== commit || (image && meta.image !== image)) {
    throw Error('The production API identity differs from the reviewed source or image');
  }
  const readiness = await fetcher(target.api + '/ready');
  if (!readiness.ok || (await readiness.json()).status !== 'ready') throw Error('Release API is not ready');
  const auth = await fetcher(target.api + '/me/records/agent-installations/release-route-check/order-workspace/release-route-check', { headers: { Origin: target.web } });
  if (auth.status !== 401 || auth.headers.get('access-control-allow-origin') !== target.web) throw Error('The approval API does not enforce login and allow the web origin');
}

async function switchRelease(mode, source, destination, apiCommit, apiImage) {
  const rollback = mode === 'rollback';
  const previous = await readBundle(source, rollback), next = await readBundle(destination, !rollback);
  const compatibility = mode === 'promote-portal' ? verifyRuntimeInputs(repo, apiCommit, next.manifest.commit, apiImage) : null;
  const dist = (await aws(['cloudfront', 'get-distribution', '--id', target.distribution])).Distribution;
  const config = dist.DistributionConfig;
  const origin = config.Origins.Items.find(o => o.Id === config.DefaultCacheBehavior.TargetOriginId);
  if (dist.DomainName !== new URL(target.web).host || !dist.ARN.includes('::' + target.owner + ':') || origin?.DomainName !== newOrigin ||
      origin.OriginPath || !config.Enabled) throw Error('CloudFront is not serving the selected release bucket');
  if (!rollback) await verifyApiTarget(compatibility?.apiCommit ?? next.manifest.commit, compatibility?.apiImage);
  const temp = await mkdtemp(path.join(tmpdir(), 'portal-switch-'));
  try {
    const store = originStore(temp);
    await withOriginLease(store, temp, async heartbeat => {
      if (compatibility) await verifyApiTarget(compatibility.apiCommit, compatibility.apiImage);
      await switchOrigin(previous, next, store, heartbeat);
    });
    const result = await aws(['cloudfront', 'create-invalidation', '--distribution-id', target.distribution, '--paths', '/*']);
    if (compatibility) {
      assert.ok(result.Invalidation?.Id, 'CloudFront must acknowledge the invalidation');
      return { status: 'invalidation-requested', distribution: target.distribution, invalidation: result.Invalidation.Id, ...compatibility };
    }
    await aws(['cloudfront', 'wait', 'invalidation-completed', '--distribution-id', target.distribution, '--id', result.Invalidation.Id]);
    return { ...await verifyPublic(next), invalidation: result.Invalidation.Id };
  } finally { await rm(temp, { recursive: true, force: true }); }
}
function build() {
  const git = args => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' }).trim();
  if (git(['status', '--porcelain'])) throw Error('Build from a clean source checkout');
  const commit = git(['rev-parse', 'HEAD']);
  const env = { ...process.env, PACKPROOF_WEB_RELEASE_COMMIT: commit, PACKPROOF_WEB_RELEASE_ENVIRONMENT: 'production',
    VITE_PACKPROOF_AUTH_MODE: 'cognito', VITE_PACKPROOF_API_BASE_URL: target.api, VITE_PACKPROOF_COGNITO_REGION: target.region,
    VITE_PACKPROOF_COGNITO_USER_POOL_ID: target.userPoolId, VITE_PACKPROOF_COGNITO_CLIENT_ID: target.clientId };
  const result = spawnSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['run', 'build:connect-portal'], { cwd: path.join(repo, 'web'), env, stdio: 'inherit',
    shell: process.platform === 'win32' });
  if (result.error) throw result.error;
  if (result.status !== 0) throw Error('Connect portal build failed');
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [mode, a, b, c, d] = process.argv.slice(2);
  if (mode === 'build' && !a) build();
  else if (mode === 'snapshot' && a && !b) console.log(await snapshot(a));
  else if (mode === 'verify' && a && !b) console.log(await verifyPublic(await readBundle(a, false)));
  else if (['promote', 'rollback'].includes(mode) && a && b && !c) console.log(await switchRelease(mode, path.resolve(a), path.resolve(b)));
  else if (mode === 'promote-portal' && process.argv.length === 7) {
    console.log(JSON.stringify(await switchRelease(mode, path.resolve(a), path.resolve(b), c, d)));
  } else if (mode === 'verify-portal' && process.argv.length === 6) {
    const bundle = await readBundle(path.resolve(a), true);
    const compatibility = verifyRuntimeInputs(repo, b, bundle.manifest.commit, c);
    await verifyApiTarget(b, c);
    const hosted = await verifyPublic(bundle);
    await verifyApiTarget(b, c);
    console.log(JSON.stringify({ status: 'public-release-verified', ...compatibility, ...hosted }));
  } else throw Error('Usage: connect-portal-release.mjs build | snapshot NEW_DIR | verify DIR | promote PREVIOUS CANDIDATE | rollback CANDIDATE PREVIOUS | promote-portal PREVIOUS CANDIDATE API_COMMIT API_IMAGE | verify-portal CANDIDATE API_COMMIT API_IMAGE');
}
