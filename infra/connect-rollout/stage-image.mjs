import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { request as httpsRequest } from 'node:https';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { TARGET } from '../backend-release/backend-deployment-plan.mjs';

const bucket = 'packproof-v2-staging-build-' + TARGET.account;
const profiles = ['reconstruction-v11', 'collector-hosted-bridge'];
const signingFields = ['X-Amz-Algorithm', 'X-Amz-Credential', 'X-Amz-Date', 'X-Amz-Expires',
  'X-Amz-SignedHeaders', 'X-Amz-Signature', 'X-Amz-Security-Token', 'x-id'];

export function objectKeys(source, profile, nonce) {
  if (!/^[a-f0-9]{40}$/.test(source) || !profiles.includes(profile) || !/^[a-f0-9]{32}$/.test(nonce)) {
    throw Error('Expected full Git commit, supported image profile and 32-character hex run nonce.');
  }
  const prefix = ['connect-rollout/staged', source, profile, nonce].join('/');
  return { bucket, descriptorKey: prefix + '/upload.json', archiveKey: prefix + '/image.tar.gz' };
}

// Input comes from the verified packet. Only replace registry publication.
export function stageBuildRequest(original, source, profile, nonce) {
  objectKeys(source, profile, nonce);
  const staged = structuredClone(original);
  const spec = JSON.parse(staged.buildspecOverride);
  if (staged.projectName !== TARGET.serviceName || staged.sourceTypeOverride !== 'NO_SOURCE' ||
      staged.environmentVariablesOverride?.find(x => x.name === 'REVIEWED_SOURCE_SHA')?.value !== source ||
      spec.phases.post_build.commands[1] !== 'docker push "$ECR:$IMAGE_TAG"') {
    throw Error('Expected the verified release packet CodeBuild request.');
  }
  const archive = '/tmp/connect-staged-image.tar';
  spec.phases.post_build = { 'on-failure': 'ABORT', commands: [
    'test "$CODEBUILD_BUILD_SUCCEEDING" = 1',
    'docker save --output ' + archive + ' "$ECR:$IMAGE_TAG"',
    'gzip -1 -n ' + archive,
    'node /tmp/connect-source/infra/connect-rollout/stage-image.mjs upload ' +
      [source, profile, nonce, archive + '.gz'].join(' '),
  ] };
  staged.buildspecOverride = JSON.stringify(spec);
  staged.idempotencyToken = createHash('sha256').update(JSON.stringify([source, profile, nonce, 'private-staging/v1'])).digest('hex');
  return staged;
}

export function checkedUploadUrl(value, archiveKey, now = Date.now()) {
  const bad = () => { throw Error('Invalid private S3 staging descriptor.'); };
  let url;
  try { url = new URL(value); } catch { bad(); }
  if (url.protocol !== 'https:' || url.username || url.password || url.port || url.hash) bad();
  const endpoints = ['s3.' + TARGET.region + '.amazonaws.com', 's3.amazonaws.com'];
  const valid = endpoints.some(host =>
    (url.hostname === bucket + '.' + host && url.pathname === '/' + archiveKey) ||
    (url.hostname === host && url.pathname === '/' + bucket + '/' + archiveKey));
  const q = url.searchParams;
  if (!valid || [...q.keys()].some(k => !signingFields.includes(k) || q.getAll(k).length !== 1)) bad();
  const date = q.get('X-Amz-Date') || '';
  const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/.exec(date);
  const credential = (q.get('X-Amz-Credential') || '').split('/');
  const expiry = Number(q.get('X-Amz-Expires'));
  if (!m || q.get('X-Amz-Algorithm') !== 'AWS4-HMAC-SHA256' ||
      credential.length !== 5 || !credential[0] || credential.slice(1).join('/') !==
        [date.slice(0, 8), TARGET.region, 's3', 'aws4_request'].join('/') ||
      !Number.isInteger(expiry) || expiry < 1 || expiry > 900 ||
      q.get('X-Amz-SignedHeaders') !== 'host;if-none-match;x-amz-server-side-encryption' ||
      !/^[a-f0-9]{64}$/.test(q.get('X-Amz-Signature') || '') ||
      (q.has('x-id') && q.get('x-id') !== 'PutObject')) bad();
  const when = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]);
  if (!Number.isFinite(when) || when > now + 120000) bad();
  return now + 5000 >= when + expiry * 1000 ? null : url;
}

async function measure(stream) {
  const hash = createHash('sha256');
  let bytes = 0;
  for await (const chunk of stream) { bytes += chunk.length; hash.update(chunk); }
  return { bytes, sha256: hash.digest('hex') };
}

async function checkStagedBytes(archiveKey, expected) {
  const read = spawn('aws', ['s3', 'cp', 's3://' + bucket + '/' + archiveKey, '-', '--only-show-errors', '--region', TARGET.region],
    { stdio: ['ignore', 'pipe', 'ignore'] });
  const exited = new Promise((resolve, reject) => {
    read.once('error', reject);
    read.once('close', resolve);
  });
  const [actual, exit] = await Promise.all([measure(read.stdout), exited]);
  if (exit !== 0 || actual.bytes !== expected.bytes || actual.sha256 !== expected.sha256) throw Error('Staged object verification failed.');
}

function putFile(url, file, size) {
  return new Promise((resolve, reject) => {
    const input = createReadStream(file);
    const req = httpsRequest(url, { method: 'PUT', headers: {
      'Content-Length': size, 'If-None-Match': '*', 'x-amz-server-side-encryption': 'AES256',
    } }, res => {
      // The built-in client never follows redirects. Never print response bodies or signed request URLs.
      input.unpipe(req); input.destroy();
      res.resume();
      res.once('end', () => resolve(res.statusCode));
      res.once('error', () => reject(Error('Staging PUT response interrupted.')));
    });
    req.on('error', () => { input.destroy(); reject(Error('Staging PUT connection interrupted.')); });
    input.on('error', () => req.destroy());
    req.setTimeout(120000, () => req.destroy());
    input.pipe(req);
  });
}

async function upload(source, profile, nonce, file) {
  const { descriptorKey, archiveKey } = objectKeys(source, profile, nonce);
  const expected = await measure(createReadStream(file));
  if (!expected.bytes || expected.bytes > 5 * 1024 ** 3) throw Error('Compressed image exceeds single PUT size or is empty.');
  const dir = await mkdtemp(path.join(tmpdir(), 'connect-private-upload-'));
  const descriptorFile = path.join(dir, 'put.json');
  try {
    for (let attempt = 0; attempt < 6; attempt++) {
      if (attempt) await delay(15000);
      try {
        execFileSync('aws', ['s3api', 'get-object', '--region', TARGET.region, '--bucket', bucket, '--key', descriptorKey, descriptorFile],
          { stdio: 'ignore', timeout: 30000 });
      } catch { continue; }
      if ((await stat(descriptorFile)).size > 16000) throw Error('Invalid staging descriptor length.');
      let descriptor;
      try { descriptor = JSON.parse(await readFile(descriptorFile, 'utf8')); } catch { throw Error('Invalid staging descriptor JSON.'); }
      const url = checkedUploadUrl(descriptor?.url, archiveKey);
      if (!url) continue;
      const status = await putFile(url, file, expected.bytes).catch(() => 503);
      if (status === 200 || status === 412) {
        await checkStagedBytes(archiveKey, expected);
        console.log(JSON.stringify({ schema: 'packproof.staged-connect-image/v1', source, profile, bucket, archiveKey, ...expected }));
        return;
      }
      if (![403, 408, 409, 429, 500, 502, 503, 504].includes(status)) throw Error('S3 staging PUT rejected (' + status + ').');
    }
    throw Error('Image staging expired or could not complete. Refresh the exact run descriptor before starting a new run.');
  } finally { await rm(dir, { recursive: true, force: true }); }
}

async function main() {
  const [action, ...args] = process.argv.slice(2);
  if (action === 'keys' && args.length === 3) console.log(JSON.stringify(objectKeys(...args), null, 2));
  else if (action === 'request' && args.length === 4) {
    const [dir, source, profile, nonce] = args;
    objectKeys(source, profile, nonce);
    execFileSync(process.execPath, [fileURLToPath(new URL('./prepare.mjs', import.meta.url)), 'verify', dir, source], { stdio: ['ignore','ignore','inherit'] });
    const original = JSON.parse(await readFile(path.join(dir, profile + '.json'), 'utf8'));
    console.log(JSON.stringify(stageBuildRequest(original, source, profile, nonce), null, 2));
  } else if (action === 'upload' && args.length === 4) await upload(...args);
  else throw Error('Use keys SOURCE PROFILE NONCE or request PACKET_DIR SOURCE PROFILE NONCE.');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(e => { console.error(e.message); process.exitCode = 1; });
}
