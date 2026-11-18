import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFileSync } from 'node:child_process';
import { connectRuntimeBuildRequest } from '../backend-release/connect-runtime-release.mjs';
import { TARGET } from '../backend-release/backend-deployment-plan.mjs';
import { checkedUploadUrl, objectKeys, stageBuildRequest } from './stage-image.mjs';

const source = 'a'.repeat(40);
const nonce = 'b'.repeat(32);
const date = '20261118T101530Z';
const now = Date.UTC(2026, 10, 18, 10, 16, 0);
const predecessor = TARGET.repository + '@sha256:3722c462d1e35de35aea2bc94c71dc0a74a617e729d16da7baabe4e817d7cbf3';
const { bucket, archiveKey } = objectKeys(source, 'reconstruction-v11', nonce);
function signed(host, pathname) {
  const u = new URL('https://' + host + pathname);
  u.search = new URLSearchParams({ 'X-Amz-Algorithm': 'AWS4-HMAC-SHA256', 'X-Amz-Credential': 'TEST/20261118/us-east-1/s3/aws4_request',
    'X-Amz-Date': date, 'X-Amz-Expires': '900', 'X-Amz-SignedHeaders': 'host;if-none-match;x-amz-server-side-encryption',
    'X-Amz-Signature': '0'.repeat(64) }).toString();
  return u;
}

test('both private staging requests preserve the verified source, Docker builds and image probes and replace release publication', () => {
  for (const profile of ['reconstruction-v11', 'collector-hosted-bridge']) {
    const request = connectRuntimeBuildRequest({ sourceSha: source, profile, archiveSha256: 'd'.repeat(64), sourceTransport: 'git-commit', predecessorImages: [predecessor] });
    const old = JSON.parse(request.buildspecOverride);
    const staged = stageBuildRequest(request, source, profile, nonce);
    const spec = JSON.parse(staged.buildspecOverride);
    assert.deepEqual(spec.phases.pre_build, old.phases.pre_build);
    assert.deepEqual(spec.phases.build, old.phases.build);
    assert.deepEqual(staged.environmentVariablesOverride, request.environmentVariablesOverride);
    assert.ok(!JSON.stringify(spec).includes('docker push'));
    assert.match(spec.phases.post_build.commands.join('\n'), /docker save --output/);
    assert.match(spec.phases.post_build.commands.at(-1), new RegExp([source,profile,nonce].join(' ')));
    assert.notEqual(staged.idempotencyToken, request.idempotencyToken);
    assert.notEqual(staged.idempotencyToken, stageBuildRequest(request, source, profile, 'e'.repeat(32)).idempotencyToken);
    for (const command of spec.phases.post_build.commands) execFileSync('sh',['-n'],{input:command});
  }
});
test('only exact private us-east-1 uploads are accepted, with signed encryption and conditional creation', () => {
  const host = bucket + '.s3.us-east-1.amazonaws.com';
  const u = signed(host, '/' + archiveKey);
  assert.equal(checkedUploadUrl(u,archiveKey,now).href, u.href);
  assert.equal(checkedUploadUrl(signed('s3.amazonaws.com','/' + bucket + '/' + archiveKey),archiveKey,now).hostname,'s3.amazonaws.com');
  assert.equal(checkedUploadUrl(u,archiveKey,now+900000), null);
  for (const mutate of [
    v=>{v.protocol='http:';}, v=>{v.hostname='other.example';}, v=>{v.pathname += '.old';},
    v=>{v.username='secret';}, v=>{v.searchParams.set('X-Amz-Expires','901');},
    v=>{v.searchParams.set('X-Amz-Credential','TEST/20261118/eu-west-1/s3/aws4_request');},
    v=>{v.searchParams.set('X-Amz-SignedHeaders','host');}, v=>{v.searchParams.set('x-amz-acl','public-read');},
    v=>{v.searchParams.set('uploadId','123');}, v=>{v.searchParams.set('x-id','CopyObject');},
    v=>{v.searchParams.append('X-Amz-Date',date);},
  ]) {
    const copy = new URL(u); mutate(copy);
    assert.throws(()=>checkedUploadUrl(copy,archiveKey,now),/Invalid private S3/);
  }
  assert.throws(()=>objectKeys(source,'reconstruction-v11','../wrong'));
  assert.throws(()=>objectKeys(source,'arbitrary',nonce));
});
