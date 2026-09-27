const test = require('node:test');
const assert = require('node:assert/strict');
const { existingReleaseObject } = require('../scripts/publish-release.cjs');

test('a missing immutable release key is checked using only its channel prefix', () => {
  const calls = [];
  const key = 'desktop/staging/win32/x64/PackProof-Staging-1.0.0.exe';
  const result = existingReleaseObject('release-bucket', key, args => { calls.push(args); return JSON.stringify({ Contents: [{ Key: `${key}.blockmap` }] }); });
  assert.equal(result, null);
  assert.equal(calls.length, 1);
  assert.equal(calls[0][1], 'list-objects-v2');
  assert.equal(calls[0][calls[0].indexOf('--prefix') + 1], key);
});

test('an existing release is inspected before deciding whether its hash permits an idempotent replay', () => {
  const key = 'desktop/production/darwin/arm64/PackProof-1.0.0.zip';
  const calls = [];
  const result = existingReleaseObject('release-bucket', key, args => { calls.push(args); return JSON.stringify(args[1] === 'list-objects-v2' ? { Contents: [{ Key: key }] } : { Metadata: { sha256: 'verified-original-hash' } }); });
  assert.equal(result.Metadata.sha256, 'verified-original-hash');
  assert.deepEqual(calls.map(args => args[1]), ['list-objects-v2', 'head-object']);
});

test('an access denial never becomes permission to replace an existing release', () => {
  const key = 'desktop/production/win32/x64/PackProof-1.0.0.exe';
  assert.throws(() => existingReleaseObject('release-bucket', key, args => {
    if (args[1] === 'list-objects-v2') return JSON.stringify({ Contents: [{ Key: key }] });
    throw new Error('AccessDenied');
  }), /AccessDenied/);
});
