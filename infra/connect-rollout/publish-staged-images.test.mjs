import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { TARGET } from '../backend-release/backend-deployment-plan.mjs';
import { objectKeys } from './stage-image.mjs';
import { receiptIdentity, imageMetadata, inspectArchive, registryCapacity, verifyExisting } from './publish-staged-images.mjs';

const source = 'a'.repeat(40), profile = 'collector-hosted-bridge', nonce = '1'.repeat(32);
const hash = b => createHash('sha256').update(b).digest('hex');
const { bucket, archiveKey } = objectKeys(source, profile, nonce);
const receipt = { schema: 'packproof.staged-connect-image/v1', source, profile, bucket, archiveKey, sha256: '5'.repeat(64), bytes: 100 };
const id = receiptIdentity(receipt, source, profile);
const opts = { registryId: TARGET.account, repositoryName: TARGET.serviceName };
const registry = { ...opts, repositoryUri: TARGET.repository, imageTagMutability: 'MUTABLE' };
const lifecycle = { ...opts, lifecyclePolicyText: JSON.stringify({ rules: [
  { rulePriority: 1, selection: { tagStatus: 'any', countType: 'imageCountMoreThan', countNumber: 10 }, action: { type: 'expire' } }] }) };
const config = Buffer.from(JSON.stringify({ architecture: 'amd64', os: 'linux', config: { Labels: { 'org.opencontainers.image.revision': source } },
  rootfs: { type: 'layers', diff_ids: ['sha256:' + hash('layer')] } }));
const entry = { Config: hash(config) + '.json', RepoTags: [TARGET.repository + ':' + id.inputTag], Layers: ['layer.tar'] };

test('only the exact private run receipt, source, profile and canonical save tag are admitted', () => {
  for (const change of [{ bucket: 'other' }, { source: 'b'.repeat(40) }, { profile: 'reconstruction-v11' },
    { archiveKey: archiveKey.replace('/staged/', '/../') }, { sha256: 'unbound' }, { bytes: 0 }]) {
    assert.throws(() => receiptIdentity({ ...receipt, ...change }, source, profile));
  }
  const img = imageMetadata(id, [entry], () => config);
  assert.equal(img.imageId, 'sha256:' + hash(config));
  assert.equal(img.tag, 'collector-compat-' + source + '-' + hash(config));
  assert.throws(() => imageMetadata(id, [{ ...entry, RepoTags: [...entry.RepoTags, 'bad:tag'] }], () => config));
  assert.throws(() => imageMetadata(id, [{ ...entry, Config: '../config.json' }], () => config));
  assert.throws(() => imageMetadata(id, [entry], () => Buffer.from('{}')));
  assert.throws(() => imageMetadata(id, [entry, entry], () => config));
});
test('docker-save gzip read binds actual archive bytes, config ID, layer count and OCI source revision', async t => {
  const dir = await mkdtemp(path.join(tmpdir(), 'pp-staged-ecr-')); t.after(() => rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'image.tar.gz');
  await writeFile(path.join(dir, entry.Config), config);
  await writeFile(path.join(dir, 'manifest.json'), JSON.stringify([entry]));
  await writeFile(path.join(dir, 'layer.tar'), 'layer');
  execFileSync('tar', ['-C', dir, '-czf', file, 'manifest.json', entry.Config, 'layer.tar']);
  const bytes = await readFile(file);
  const staged = { ...id, receipt: { ...receipt, bytes: bytes.length, sha256: hash(bytes) } };
  assert.equal((await inspectArchive(file, staged)).imageId, 'sha256:' + hash(config));
  await assert.rejects(inspectArchive(file, id), /length/);
  await assert.rejects(inspectArchive(file, { ...staged, receipt: { ...staged.receipt, sha256: hash('wrong') } }), /digest/);
  assert.throws(() => imageMetadata({ ...id, receipt: { ...receipt, source: 'b'.repeat(40) } }, [entry], () => config), /revision/);
});
test('current whole-repository count protects maintained old worker and allows exact retries', () => {
  const images = Array.from({ length: 10 }, (_, i) => ({ ...opts, imageDigest: 'sha256:' + hash('release' + i) }));
  assert.throws(() => registryCapacity(registry, lifecycle, images, 2), /needs room for 2/);
  assert.throws(() => registryCapacity(registry, lifecycle, images.slice(0, 9), 2), /needs room for 2/);
  assert.equal(registryCapacity(registry, lifecycle, images.slice(0, 8), 2).count, 8);
  assert.equal(registryCapacity(registry, lifecycle, images, 0).newImages, 0);
  assert.throws(() => registryCapacity(registry, { ...lifecycle, lifecyclePolicyText: '{"rules":[]}' }, images, 1));
  assert.throws(() => registryCapacity({ ...registry, registryId: 'other' }, lifecycle, images, 1));
});
test('existing tag reuse compares registry manifest digest and staged image configuration', () => {
  const image = imageMetadata(id, [entry], () => config), tag = image.tag;
  const missing = { images: [], failures: [{ imageId: { imageTag: tag }, failureCode: 'ImageNotFound' }] };
  assert.equal(verifyExisting(missing, tag, image), null);
  const raw = JSON.stringify({ schemaVersion: 2, config: { digest: image.imageId } });
  const row = { ...opts, imageId: { imageDigest: 'sha256:' + hash(raw), imageTag: tag }, imageManifest: raw };
  assert.equal(verifyExisting({ images: [row], failures: [] }, tag, image).image, TARGET.repository + '@sha256:' + hash(raw));
  assert.throws(() => verifyExisting({ images: [row], failures: [] }, tag, { ...image, imageId: 'sha256:' + hash('other') }), /differs/);
  assert.throws(() => verifyExisting({ images: [{ ...row, imageManifest: raw + ' ' }], failures: [] }, tag, image), /differs/);
  assert.throws(() => verifyExisting({ images: [], failures: [{ failureCode: 'AccessDenied' }] }, tag, image));
});
