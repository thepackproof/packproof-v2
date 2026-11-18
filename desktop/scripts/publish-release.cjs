const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const YAML = require('yaml');
const { validateAcceptance, validatePlatformScope, platformsForScope } = require('./check-acceptance.cjs');

async function digest(file, algorithm = 'sha256', encoding = 'hex') {
  const hash = crypto.createHash(algorithm);
  for await (const chunk of fs.createReadStream(file)) hash.update(chunk);
  return hash.digest(encoding);
}

function aws(args, allowMissing = false) {
  const result = spawnSync('aws', args, { encoding: 'utf8', maxBuffer: 1024 * 1024 });
  if (result.status !== 0) {
    if (allowMissing && /\(404\)|Not Found|NoSuchKey/.test(result.stderr || '')) return null;
    throw new Error('AWS release publication failed. Check the scoped role, bucket and deployment logs.');
  }
  return result.stdout;
}

function existingReleaseObject(bucket, key, execute = aws) {
  // HEAD returns 403 for a missing key when ListBucket is prefix-restricted.
  // List the exact key first so roles never need to enumerate the other channel.
  const listing = JSON.parse(execute(['s3api', 'list-objects-v2', '--bucket', bucket, '--prefix', key, '--max-keys', '1', '--output', 'json']));
  if (listing.Contents !== undefined && !Array.isArray(listing.Contents)) throw new Error('Unexpected release object listing.');
  if (!(listing.Contents || []).some(object => object.Key === key)) return null;
  // An existing key disappearing or an access denial is an error, never permission to overwrite.
  return JSON.parse(execute(['s3api', 'head-object', '--bucket', bucket, '--key', key, '--output', 'json']));
}

async function inspectRelease(directory, { channel, sourceCommit }) {
  const report = JSON.parse(fs.readFileSync(path.join(directory, 'release-evidence.json'), 'utf8'));
  if (report.channel !== channel || report.sourceCommit !== sourceCommit || report.signed !== true) throw new Error('Artifact identity or signed release verification does not match this promotion.');
  if (!['win32/x64', 'darwin/x64', 'darwin/arm64'].includes(`${report.platform}/${report.arch}`)) throw new Error('Unexpected release architecture.');
  const checks = report.platform === 'win32' ? ['authenticode-valid', 'publisher-matches', 'timestamp-valid'] : ['codesign-valid', 'apple-team-matches', 'hardened-runtime', 'notarized', 'stapled', 'gatekeeper-accepted'];
  for (const check of checks) if (!report.checks.includes(check)) throw new Error(`Signed verification is missing: ${check}`);
  const prefix = `desktop/${channel}/${report.platform}/${report.arch}/`;
  if (report.updateUrl !== `https://downloads.thepackproof.com/${prefix}`) throw new Error('Unexpected updater origin.');
  for (const artifact of report.artifacts) {
    if (path.basename(artifact.file) !== artifact.file || !/^PackProof(?:-Staging)?[-.][a-zA-Z0-9_.-]+$/.test(artifact.file)) throw new Error('Unsafe artifact name.');
    const file = path.join(directory, artifact.file);
    if (fs.statSync(file).size !== artifact.bytes || await digest(file) !== artifact.sha256) throw new Error('Release artifact bytes do not match the OS-verified build.');
  }
  const metadataName = report.platform === 'win32' ? 'latest.yml' : 'latest-mac.yml';
  const metadata = YAML.parse(fs.readFileSync(path.join(directory, metadataName), 'utf8'));
  if (metadata.version !== report.version || !Array.isArray(metadata.files) || !metadata.files.length) throw new Error('Invalid updater metadata version or file list.');
  for (const file of metadata.files) {
    if (path.basename(file.url) !== file.url || !report.artifacts.some(artifact => artifact.file === file.url)) throw new Error('Updater metadata references an unverified or external file.');
    if (await digest(path.join(directory, file.url), 'sha512', 'base64') !== file.sha512) throw new Error('Updater metadata hash does not match signed artifact bytes.');
  }
  if (metadata.path && (!metadata.files.some(file => file.url === metadata.path) || await digest(path.join(directory, metadata.path), 'sha512', 'base64') !== metadata.sha512)) throw new Error('Legacy updater metadata hash is inconsistent.');
  return { report, prefix, metadataName, directory };
}

function validateReleaseSet(releases, value = 'all') {
  const expected = platformsForScope(value);
  const actual = releases.map(item => `${item.report.platform}/${item.report.arch}`);
  if (actual.length !== expected.length || new Set(actual).size !== actual.length || actual.some(item => !expected.includes(item))) throw new Error('Promotion requires exactly the selected platform set, without missing, extra or duplicate architectures.');
  if (new Set(releases.map(item => item.report.version)).size !== 1) throw new Error('All selected desktop artifacts must use one version.');
}

async function publishRelease({ env = process.env, root = path.resolve(process.argv[2] || 'release-downloads'), executeAws = aws, fetchImpl = globalThis.fetch } = {}) {
  const channel = env.APP_ENV;
  const bucket = env.PACKPROOF_RELEASE_BUCKET;
  const sourceCommit = env.GITHUB_SHA;
  const scope = validatePlatformScope(env.PACKPROOF_RELEASE_PLATFORMS);
  if (!['staging', 'production'].includes(channel) || !/^[a-f0-9]{40}$/.test(sourceCommit || '')) throw new Error('Publication requires a release channel and exact source commit.');
  if (!/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(bucket || '')) throw new Error('A dedicated desktop release bucket is required.');
  if (channel === 'production') validateAcceptance(JSON.parse(env.PACKPROOF_RELEASE_ACCEPTANCE_JSON || '{}'), sourceCommit, scope);
  const releases = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) if (entry.isDirectory()) releases.push(await inspectRelease(path.join(root, entry.name), { channel, sourceCommit }));
  validateReleaseSet(releases, scope);
  // Resolve every upload, including auxiliary files, before any network request. A
  // missing file in a later architecture must not leave an earlier one uploaded.
  for (const release of releases) {
    const names = [...release.report.artifacts.map(item => item.file), ...fs.readdirSync(release.directory).filter(name => name.endsWith('.blockmap')), 'SHA256SUMS', 'release-evidence.json'];
    release.uploads = [];
    for (const name of names) {
      if (path.basename(name) !== name) throw new Error('Unsafe release file name.');
      const file = path.join(release.directory, name);
      if (!fs.lstatSync(file).isFile()) throw new Error('Release upload must be a regular file.');
      release.uploads.push({ name, file, sha256: await digest(file), versioned: name.includes(release.report.version), key: release.prefix + name });
    }
    const metadataFile = path.join(release.directory, release.metadataName);
    if (!fs.lstatSync(metadataFile).isFile()) throw new Error('Update metadata must be a regular file.');
    release.metadataSha256 = await digest(metadataFile);
  }
  const health = await fetchImpl('https://downloads.thepackproof.com/desktop/health.json', { signal: AbortSignal.timeout(15000), redirect: 'error' });
  if (!health.ok || (await health.json()).service !== 'packproof-desktop-updates') throw new Error('PackProof update distribution is not ready.');
  // All files and native verification records are checked BEFORE the first write.
  for (const release of releases) {
    for (const { file, sha256, versioned, key } of release.uploads) {
      if (versioned) {
        const existing = existingReleaseObject(bucket, key, executeAws);
        if (existing !== null) {
          if (existing.Metadata?.sha256 === sha256) continue;
          throw new Error('Refusing to overwrite different bytes for an existing release version. Increment the application version.');
        }
      }
      executeAws(['s3', 'cp', file, `s3://${bucket}/${key}`, '--only-show-errors', '--metadata', `sha256=${sha256}`, '--cache-control', versioned ? 'public,max-age=31536000,immutable' : 'no-cache,no-store,must-revalidate']);
    }
  }
  // Promotion is last; existing versions remain available for in-progress updater downloads.
  for (const release of releases) {
    const file = path.join(release.directory, release.metadataName);
    executeAws(['s3', 'cp', file, `s3://${bucket}/${release.prefix}${release.metadataName}`, '--only-show-errors', '--content-type', 'application/yaml', '--cache-control', 'no-cache,no-store,must-revalidate']);
    const response = await fetchImpl(`${release.report.updateUrl}${release.metadataName}`, { redirect: 'error', cache: 'no-store', signal: AbortSignal.timeout(15000) });
    if (!response.ok || crypto.createHash('sha256').update(Buffer.from(await response.arrayBuffer())).digest('hex') !== release.metadataSha256) throw new Error('Published update metadata did not match the verified release.');
  }
  return { channel, platforms: scope, version: releases[0].report.version };
}

module.exports = { inspectRelease, existingReleaseObject, validateReleaseSet, publishRelease };
if (require.main === module) publishRelease().then(result => console.log(`Published verified ${result.channel} ${result.platforms} desktop release ${result.version}.`)).catch(error => { console.error(error.message); process.exitCode = 1; });
