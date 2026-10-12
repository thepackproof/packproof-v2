import test from 'node:test';
import assert from 'node:assert/strict';
import { changedFiles, scopeFor } from './rnd-check-scope.mjs';

test('documentation reuses prior checks while changed research areas select their dependencies', () => {
  assert.ok(Object.values(scopeFor(['docs/rnd/HANDOFF.md'])).every(value => !value));
  assert.ok(Object.values(scopeFor(['research/federated/TRANSPORT.md'])).every(value => !value));
  const privacy = scopeFor(['research/privacy/redact.py']);
  assert.equal(privacy.backend, true);
  assert.equal(privacy.sandbox, true);
  assert.equal(privacy.federated, false);
  assert.equal(privacy.android, false);
  assert.equal(scopeFor(['mobile/package-lock.json']).android, true);
  assert.equal(scopeFor(['packages/evidence-contracts/generated-client.mjs']).android, false);
  assert.equal(scopeFor(['packages/evidence-contracts/contracts.mjs']).android, true);
  assert.equal(scopeFor(['research/federated/requirements.lock']).federated, true);
  assert.equal(scopeFor(['research/privacy/zk/circuit.mjs']).proof, true);
  assert.equal(scopeFor(['packages/evidence-contracts/fragments.mjs']).fragments, true);
  assert.equal(scopeFor(['packages/evidence-contracts/contracts.mjs']).fragments, true);
  assert.equal(scopeFor(['.github/workflows/rnd-ci.yml']).backend, true);
  assert.equal(scopeFor(['.github/workflows/rnd-ci.yml']).android, false);
  assert.equal(scopeFor(['.github/workflows/rnd-native.yml']).android, true);
  assert.equal(scopeFor(['.github/workflows/rnd-native.yml']).backend, false);
});

test('a push rollback compares actual endpoint bytes instead of an empty merge-base diff', () => {
  let args;
  const event = { before: 'b'.repeat(40), after: 'a'.repeat(40) };
  const files = changedFiles(event, 'push', passed => { args = passed; return 'backend/src/rnd/worker.ts\0'; });
  assert.deepEqual(args, ['diff', '--name-only', '-z', event.before, event.after]);
  assert.equal(scopeFor(files).backend, true);
});

test('new branches, manual runs and missing ancestry fail to the complete check set', () => {
  assert.equal(changedFiles({}, 'workflow_dispatch'), null);
  assert.equal(changedFiles({ before: '0'.repeat(40), after: 'a'.repeat(40) }, 'push'), null);
  assert.equal(changedFiles({ before: 'b'.repeat(40), after: 'a'.repeat(40) }, 'push', () => { throw Error('unavailable'); }), null);
  assert.ok(Object.values(scopeFor([], true)).every(Boolean));
});

test('pull request changes use the source head, preserve spaces and include deleted paths', () => {
  const event = { pull_request: { base: { sha: 'a'.repeat(40) }, head: { sha: 'b'.repeat(40) } } };
  let args;
  const files = changedFiles(event, 'pull_request', passed => { args = passed; return 'research/vision/removed.py\0docs/rnd/file with spaces.md\0'; });
  assert.deepEqual(args, ['diff', '--name-only', '-z', `${'a'.repeat(40)}...${'b'.repeat(40)}`]);
  assert.equal(files.length, 2);
  assert.equal(scopeFor(files).backend, true);
});
