const fs = require('node:fs');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');

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

module.exports = { digest, aws, existingReleaseObject };
