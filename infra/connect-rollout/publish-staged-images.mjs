// Operator command for promoting already qualified docker-save archives. The
// ECR tag includes the complete image configuration digest; ECS consumes only
// the registry manifest digest returned after verifying that configuration.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { TARGET } from '../backend-release/backend-deployment-plan.mjs';
import { objectKeys } from './stage-image.mjs';

const profiles = ['collector-hosted-bridge', 'reconstruction-v11'];
const registry = TARGET.repository.split('/')[0];
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const sha256 = /^sha256:[a-f0-9]{64}$/;
const prefixes = { 'reconstruction-v11': 'connect-runtime-', 'collector-hosted-bridge': 'collector-compat-' };

export function receiptIdentity(receipt, source, profile) {
  const nonce = receipt?.archiveKey?.split('/').at(-2);
  const expected = objectKeys(source, profile, nonce);
  if (receipt.schema !== 'packproof.staged-connect-image/v1' || receipt.source !== source || receipt.profile !== profile ||
      receipt.bucket !== expected.bucket || receipt.archiveKey !== expected.archiveKey || !/^[a-f0-9]{64}$/.test(receipt.sha256) ||
      !Number.isSafeInteger(receipt.bytes) || receipt.bytes < 1 || receipt.bytes > 5 * 1024 ** 3) throw Error('Invalid private staging receipt for ' + profile);
  return { receipt, inputTag: prefixes[profile] + source };
}

export function imageMetadata(identity, manifest, readMember) {
  const preferred = TARGET.repository + ':' + identity.inputTag;
  const row = Array.isArray(manifest) && manifest.length === 1 && manifest[0];
  if (!row || row.RepoTags?.length !== 1 || row.RepoTags[0] !== preferred || !Array.isArray(row.Layers) || !row.Layers.length) {
    throw Error('Unexpected image or tags in docker-save archive');
  }
  const config = /^(?:blobs\/sha256\/([a-f0-9]{64})|([a-f0-9]{64})\.json)$/.exec(row.Config);
  if (!config) throw Error('Unexpected image configuration path');
  const bytes = readMember(row.Config);
  const configHash = hash(bytes), image = JSON.parse(bytes);
  const id = 'sha256:' + configHash;
  if (configHash !== (config[1] || config[2]) || image.os !== 'linux' || image.architecture !== 'amd64' ||
      image.config?.Labels?.['org.opencontainers.image.revision'] !== identity.receipt.source ||
      image.rootfs?.type !== 'layers' || image.rootfs.diff_ids?.length !== row.Layers.length ||
      !image.rootfs.diff_ids.every(x => sha256.test(x))) throw Error('Staged config, architecture, revision label or layers mismatch');
  return { ...identity, imageId: id, layers: image.rootfs.diff_ids, tag: identity.inputTag + '-' + configHash };
}

export async function inspectArchive(file, identity) {
  const h = createHash('sha256');
  if ((await stat(file)).size !== identity.receipt.bytes) throw Error('Staged archive length differs from receipt');
  for await (const chunk of createReadStream(file)) h.update(chunk);
  if (h.digest('hex') !== identity.receipt.sha256) throw Error('Staged archive digest differs from receipt');
  const member = key => execFileSync('tar', ['-xOzf', file, '--', key], { maxBuffer: 4 * 1024 * 1024 });
  return { ...imageMetadata(identity, JSON.parse(member('manifest.json')), member), file };
}
export function registryCapacity(repo, lifecycle, details, newImages) {
  if (repo?.registryId !== TARGET.account || repo?.repositoryUri !== TARGET.repository || repo.repositoryName !== TARGET.serviceName ||
      !['MUTABLE', 'IMMUTABLE', 'MUTABLE_WITH_EXCLUSION', 'IMMUTABLE_WITH_EXCLUSION'].includes(repo.imageTagMutability)) throw Error('Unexpected ECR repository');
  const rules = JSON.parse(lifecycle.lifecyclePolicyText).rules;
  if (lifecycle.registryId !== TARGET.account || lifecycle.repositoryName !== TARGET.serviceName || rules?.length !== 1 ||
      rules[0].selection?.tagStatus !== 'any' || rules[0].selection.countType !== 'imageCountMoreThan' ||
      !Number.isSafeInteger(rules[0].selection.countNumber) || rules[0].selection.countNumber < 1 || rules[0].action?.type !== 'expire') {
    throw Error('Unexpected ECR lifecycle policy; inspect its actual retention selection');
  }
  if (!Array.isArray(details) || details.some(d => d.registryId !== TARGET.account || d.repositoryName !== TARGET.serviceName || !sha256.test(d.imageDigest))) {
    throw Error('Incomplete ECR inventory');
  }
  const count = new Set(details.map(d => d.imageDigest)).size, retained = rules[0].selection.countNumber;
  if (newImages && count + newImages > retained) throw Error('ECR retains ' + retained + ' images, has ' + count +
    ' and needs room for ' + newImages + ' more. Preserve recovery images before publishing.');
  return { count, retained, newImages, imageTagMutability: repo.imageTagMutability };
}

const awsParams = ['--region', TARGET.region, '--no-cli-pager', '--output', 'json'];
function awsJson(...args) {
  return JSON.parse(execFileSync('aws', [...args, ...awsParams], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 }));
}
export function verifyExisting(response, tag, image) {
  if (!Array.isArray(response.images) || !Array.isArray(response.failures)) throw Error('Invalid registry lookup');
  if (response.images.length === 0 && response.failures.length === 1 && response.failures[0].failureCode === 'ImageNotFound' &&
      response.failures[0].imageId?.imageTag === tag) return null;
  const item = response.images[0];
  if (response.images.length !== 1 || response.failures.length || item.registryId !== TARGET.account || item.repositoryName !== TARGET.serviceName ||
      item.imageId?.imageTag !== tag || !sha256.test(item.imageId.imageDigest) ||
      'sha256:' + hash(item.imageManifest) !== item.imageId.imageDigest || JSON.parse(item.imageManifest).config?.digest !== image.imageId) {
    throw Error('Published tag differs from the verified staged image: ' + tag);
  }
  return { tag, image: TARGET.repository + '@' + item.imageId.imageDigest, digest: item.imageId.imageDigest };
}
const repositoryArgs = ['--registry-id', TARGET.account, '--repository-name', TARGET.serviceName];
function tagDetails(image, tag) {
  return verifyExisting(awsJson('ecr', 'batch-get-image', ...repositoryArgs, '--image-ids', 'imageTag=' + tag), tag, image);
}
function readRegistry(images) {
  const existing = new Map();
  for (const image of images) {
    const canonical = tagDetails(image, image.inputTag);
    const pinned = tagDetails(image, image.tag);
    if (pinned || canonical) existing.set(image.tag, pinned || canonical);
  }
  const repository = awsJson('ecr', 'describe-repositories', '--registry-id', TARGET.account, '--repository-names', TARGET.serviceName);
  const policy = awsJson('ecr', 'get-lifecycle-policy', ...repositoryArgs);
  const inventory = awsJson('ecr', 'describe-images', ...repositoryArgs);
  const capacity = registryCapacity(repository.repositories?.[0], policy, inventory.imageDetails, images.length - existing.size);
  return { existing, capacity };
}
function verifyDockerImage(image, temp) {
  const sourceTag = TARGET.repository + ':' + image.inputTag;
  const opts = ['--config', temp, 'image'];
  const local = execFileSync('docker', [...opts, 'ls', '--no-trunc', '--format', '{{.ID}}', sourceTag], { encoding: 'utf8' }).trim();
  if (local && local !== image.imageId) throw Error('A different local image uses ' + sourceTag + '; use an isolated release Docker context');
  if (!local) execFileSync('docker', [...opts, 'load', '--input', image.file], { stdio: ['ignore', 2, 2] });
  const [actual] = JSON.parse(execFileSync('docker', [...opts, 'inspect', sourceTag], { encoding: 'utf8' }));
  if (actual?.Id !== image.imageId || actual.Config?.Labels?.['org.opencontainers.image.revision'] !== image.receipt.source ||
      actual.Os !== 'linux' || actual.Architecture !== 'amd64' || JSON.stringify(actual.RootFS?.Layers) !== JSON.stringify(image.layers)) {
    throw Error('Loaded image identity or layer payload mismatch');
  }
}
async function main() {
  const [mode, source, receiptDir, files] = process.argv.slice(2);
  if (!['check', 'publish'].includes(mode) || !receiptDir || !/^[a-f0-9]{40}$/.test(source) || process.argv.length > 6) {
    throw Error('Use check|publish FULL_SOURCE RECEIPT_DIR [ARCHIVE_DIR]');
  }
  const account = awsJson('sts', 'get-caller-identity').Account;
  if (account !== TARGET.account) throw Error('AWS account differs from the reviewed target');
  const temp = await mkdtemp(path.join(tmpdir(), 'connect-registry-'));
  const images = [];
  try {
    for (const profile of profiles) {
      const r = JSON.parse(await readFile(path.join(receiptDir, profile + '.json'), 'utf8'));
      const identity = receiptIdentity(r, source, profile), file = path.resolve(files || temp, profile + '.tar.gz');
      if (!files) execFileSync('aws', ['s3', 'cp', 's3://' + r.bucket + '/' + r.archiveKey, file,
        '--only-show-errors', '--region', TARGET.region], { stdio: ['ignore', 'ignore', 'inherit'] });
      images.push(await inspectArchive(file, identity));
    }
    const initial = readRegistry(images), results = [];
    const loaded = new Set();
    if (mode === 'publish') {
      for (const image of images.filter(i => !initial.existing.has(i.tag))) {
        verifyDockerImage(image, temp);
        loaded.add(image.tag);
      }
    }
    let loggedIn = false;
    for (const image of images) {
      let remote = initial.existing.get(image.tag);
      if (mode === 'publish') {
        remote = readRegistry(images).existing.get(image.tag);
        if (!remote) {
          const docker = args => execFileSync('docker', ['--config', temp, ...args], { stdio: ['ignore', 2, 2] });
          if (!loggedIn) {
            const password = execFileSync('aws', ['ecr', 'get-login-password', '--region', TARGET.region]);
            try { execFileSync('docker', ['--config', temp, 'login', '--username', 'AWS', '--password-stdin', registry], { input: password, stdio: ['pipe', 2, 2] }); }
            finally { password.fill(0); }
            loggedIn = true;
          }
          if (!loaded.has(image.tag)) verifyDockerImage(image, temp);
          docker(['image', 'tag', image.imageId, TARGET.repository + ':' + image.tag]);
          const again = readRegistry(images);
          remote = again.existing.get(image.tag);
          if (!remote) {
            docker(['image', 'push', TARGET.repository + ':' + image.tag]);
            remote = tagDetails(image, image.tag);
            assert.ok(remote, 'Registry has not confirmed the pushed image');
          }
        }
      }
      results.push({ profile: image.receipt.profile, archiveSha256: image.receipt.sha256, bytes: image.receipt.bytes,
        imageId: image.imageId, contentTag: image.tag, published: remote || null });
    }
    console.log(JSON.stringify({ schema: 'packproof.connect-registry-publication/v1', mode, source, capacity: initial.capacity, images: results }, null, 2));
  } finally { await rm(temp, { recursive: true, force: true }); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(e => { console.error(e.message); process.exitCode = 1; });
}
