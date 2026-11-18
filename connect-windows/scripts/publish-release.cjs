const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { parseUpdateInfo } = require('electron-updater/out/providers/Provider');
const { aws, digest, existingReleaseObject } = require('../../desktop/scripts/release-storage.cjs');
const { context, trustedUrl } = require('./release-policy.cjs');

const versionPattern = /^(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})$/;
const shaPattern = /^[a-f0-9]{64}$/;
const immutable = 'public,max-age=31536000,immutable';
const fresh = 'no-cache,no-store,must-revalidate';
const bucketPattern = /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/;

function newerThan(previous, next) {
  if (!versionPattern.test(previous)) throw Error('Existing Connect feed has an invalid version.');
  const a = previous.split('.').map(Number), b = next.split('.').map(Number);
  const index = a.findIndex((number, i) => number !== b[i]);
  return index >= 0 && a[index] > b[index];
}

function parseFeed(text, url) {
  try {
    return parseUpdateInfo(text, 'latest.yml', new URL('latest.yml', url));
  } catch {
    throw Error('Invalid Connect update metadata.');
  }
}

async function inspect(directory, { channel, commit, installerHash, apiOrigin, webOrigin }) {
  if (!['production', 'staging'].includes(channel) || !/^[a-f0-9]{40}$/.test(commit) || !shaPattern.test(installerHash)) {
    throw Error('Select a signed channel, reviewed commit, and accepted installer SHA-256.');
  }
  const report = JSON.parse(await fs.readFile(path.join(directory, 'release-evidence.json'), 'utf8'));
  const { updateUrl } = context({ APP_ENV: channel });
  if (report.product !== 'PackProof Connect' || report.channel !== channel || report.signed !== true ||
      report.sourceDirty !== false || report.sourceCommit !== commit || !versionPattern.test(report.version) ||
      report.application?.schema !== 'packproof.connect-build/v1' || report.application.sourceDirty !== false ||
      report.application.sourceCommit !== commit || report.application.channel !== channel || report.application.appVersion !== report.version ||
      report.feed?.url !== updateUrl || !report.feed.publisher || !trustedUrl(webOrigin) || !trustedUrl(apiOrigin) ||
      report.feed.webOrigin !== webOrigin || report.feed.apiOrigin !== apiOrigin) {
    throw Error('Signed application provenance, endpoints, or channel differ from the promotion request.');
  }
  const exeName = `PackProof-Connect-${channel}-Setup-${report.version}.exe`;
  const names = [exeName, exeName + '.blockmap', 'latest.yml'];
  const rows = [...(report.artifacts || []), ...(report.feed.files || [])];
  if (report.artifacts?.length !== 1 || report.artifacts[0].file !== exeName ||
      report.artifacts[0].sha256 !== installerHash || rows.length !== names.length) {
    throw Error('The signed installer or file list differs from the accepted release.');
  }
  const files = [];
  for (const name of names) {
    const row = rows.find(item => item.file === name);
    const file = path.join(directory, name);
    const stat = await fs.lstat(file);
    if (!row || !stat.isFile() || stat.size < 1 || row.bytes !== stat.size ||
        !shaPattern.test(row.sha256) || await digest(file) !== row.sha256) {
      throw Error('Release file failed its signed-build hash or length check: ' + name);
    }
    files.push({ ...row, name, path: file });
  }
  const metadata = parseFeed(await fs.readFile(files[2].path, 'utf8'), updateUrl);
  const entry = metadata?.files?.[0];
  const sha512 = await digest(files[0].path, 'sha512', 'base64');
  if (metadata?.version !== report.version || metadata?.path !== exeName || metadata?.sha512 !== sha512 ||
      !Array.isArray(metadata.files) || metadata.files.length !== 1 || entry.url !== exeName ||
      entry.size !== files[0].bytes || entry.sha512 !== sha512 || (entry.blockMapSize !== undefined && entry.blockMapSize !== files[1].bytes)) {
    throw Error('The updater metadata does not identify exactly the accepted installer.');
  }
  return { files, updateUrl, version: report.version, prefix: new URL(updateUrl).pathname.slice(1) };
}

function base64Hash(hex) { return Buffer.from(hex, 'hex').toString('base64'); }

async function publish(directory, env, execute = aws, fetchImpl = fetch) {
  const verified = await inspect(directory, { channel: env.APP_ENV, commit: env.GITHUB_SHA,
    installerHash: env.CONNECT_INSTALLER_SHA256, webOrigin: env.PACKPROOF_WEB_BASE_URL, apiOrigin: env.PACKPROOF_API_BASE_URL });
  const bucket = env.PACKPROOF_RELEASE_BUCKET;
  if (!bucketPattern.test(bucket || '')) throw Error('The downloads bucket is required.');
  const { files, prefix, updateUrl, version } = verified;
  const physical = f => ['--bucket', bucket, '--key', prefix + f.name];
  const current = f => existingReleaseObject(bucket, prefix + f.name, execute);
  const pointer = files[2];
  const previous = current(pointer);
  let currentHash;
  const checksum = f => base64Hash(f.sha256);
  function verifyStored(file) {
    const row = JSON.parse(execute(['s3api', 'head-object', ...physical(file), '--checksum-mode', 'ENABLED', '--output', 'json']));
    if (row.ContentLength !== file.bytes || row.ChecksumSHA256 !== checksum(file)) throw Error('Stored object does not match ' + file.name);
  }
  function put(file, contentType, cacheControl, condition) {
    execute(['s3api', 'put-object', ...physical(file), '--body', file.path, '--checksum-sha256', checksum(file),
      '--metadata', 'sha256=' + file.sha256, '--content-type', contentType, '--cache-control', cacheControl, ...condition]);
    verifyStored(file);
  }
  if (previous) {
    if (!previous.ETag) throw Error('Existing Connect feed cannot be identified.');
    const scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'connect-feed-'));
    try {
      const file = path.join(scratch, 'current.yml');
      execute(['s3api','get-object', ...physical(pointer),'--if-match',previous.ETag,file]);
      const previousBytes = await fs.readFile(file);
      currentHash = crypto.createHash('sha256').update(previousBytes).digest('hex');
      const previousVersion = parseFeed(previousBytes.toString('utf8'), updateUrl)?.version;
      if (newerThan(previousVersion, version) ||
          (previousVersion === version && currentHash !== pointer.sha256)) {
        throw Error('A newer release or different build of this version is already published.');
      }
    } finally { await fs.rm(scratch, { recursive: true, force: true }); }
  }
  for (const file of files.slice(0, 2)) {
    if (current(file)) verifyStored(file);
    else put(file, 'application/octet-stream', immutable, ['--if-none-match', '*']);
    // Verify that the public origin serves these exact immutable objects before changing the feed.
    const response = await fetchImpl(updateUrl + file.name, { redirect: 'error', cache: 'no-store', signal: AbortSignal.timeout(120000) });
    if (!response.ok || !response.body) throw Error('Download origin did not serve ' + file.name);
    const hash = crypto.createHash('sha256');
    for await (const chunk of response.body) hash.update(chunk);
    if (hash.digest('hex') !== file.sha256) throw Error('Download origin served different bytes for ' + file.name);
  }
  if (currentHash !== pointer.sha256) {
    put(pointer, 'application/yaml', fresh, previous ? ['--if-match', previous.ETag] : ['--if-none-match', '*']);
  }
  const response = await fetchImpl(updateUrl + pointer.name, { redirect: 'error', cache: 'no-store', signal: AbortSignal.timeout(15000) });
  if (!response.ok || crypto.createHash('sha256').update(Buffer.from(await response.arrayBuffer())).digest('hex') !== pointer.sha256) {
    throw Error('Published Connect feed is pending CDN verification. Retry the same artifact.');
  }
  return { version, installer: updateUrl + files[0].name, sha256: files[0].sha256, feed: updateUrl + pointer.name };
}

module.exports = { inspect, publish };
if (require.main === module) publish(process.argv[2], process.env)
  .then(result => console.log(JSON.stringify(result)))
  .catch(error => { console.error(error.message); process.exitCode = 1; });
