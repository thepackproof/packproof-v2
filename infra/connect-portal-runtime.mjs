import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';

// Historical129 and recovery130 are distinct reviewed candidate recipes.
// Selection follows the exact source catalogue; neither accepts an arbitrary recipe.
const historicalRecipes = new Map([
  ['backend/Dockerfile', '4a73cf0d555184448ee25aab3c3a945ccbb81017'],
  ['backend/Dockerfile.logistics-candidate', 'ed0830bfc8dcfb79051e675dfcb4998f5ac7fec0'],
]);
const recoveryRecipes = new Map([
  ['backend/Dockerfile', '4a73cf0d555184448ee25aab3c3a945ccbb81017'],
  ['backend/Dockerfile.recovery-candidate', '9772e04e53509009793a69e03d784a80afe82370'],
]);
const digestPattern = /^sha256:[0-9a-f]{64}$/;
const repository = '784514617543.dkr.ecr.us-east-1.amazonaws.com/packproof-v2-staging-api@';

function git(root, args) {
  return execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
}

function runtimeInputs(root, commit) {
  const sources = new Set(['.dockerignore']);
  const optional = new Set(['.dockerignore']);
  const recoveryMigration='backend/migrations/130_connect_recovery_collector_version.sql';
  const recovery=git(root,['ls-tree','--name-only',commit,'--',recoveryMigration]).trim()===recoveryMigration;
  const recipes=recovery?recoveryRecipes:historicalRecipes;
  for (const [recipe, expectedBlob] of recipes) {
    assert.equal(git(root, ['rev-parse', commit + ':' + recipe]).trim(), expectedBlob, 'Unreviewed runtime Dockerfile: ' + recipe);
    sources.add(recipe);
    sources.add(recipe + '.dockerignore');
    optional.add(recipe + '.dockerignore');
    for (const line of git(root, ['show', commit + ':' + recipe]).split(/\r?\n/)) {
      if (!line.startsWith('COPY ') || line.startsWith('COPY --from=build ')) continue;
      for (const source of line.split(/\s+/).slice(1, -1)) {
        assert.match(source, /^[a-zA-Z0-9._/*-]+$/, 'Unsupported runtime COPY path');
        sources.add(source);
      }
    }
  }
  const patterns = [...sources].map(source => ({ source, matches: false,
    pattern: new RegExp('^' + source.replaceAll('.', '\\.').replaceAll('*', '[^/]*') + '(?:/|$)') }));
  const entries = git(root, ['ls-tree', '-r', '-z', '--full-tree', commit]).split('\0').filter(Boolean);
  const selected = entries.filter(row => {
    const name = row.slice(row.indexOf('\t') + 1);
    let selected = false;
    for (const input of patterns) {
      if (input.pattern.test(name)) {
        input.matches = true;
        selected = true;
      }
    }
    return selected;
  });
  for (const input of patterns) assert.ok(input.matches || optional.has(input.source), 'Missing runtime input: ' + input.source);
  assert.ok(selected.every(row => /^100(?:644|755) blob /.test(row)), 'Unsupported runtime input type');
  return selected;
}

export function verifyRuntimeInputs(root, apiCommit, portalCommit, apiImage) {
  for (const source of [apiCommit, portalCommit]) assert.match(source, /^[a-f0-9]{40}$/, 'Full source commits required');
  assert.ok(typeof apiImage === 'string' && apiImage.startsWith(repository) && digestPattern.test(apiImage.slice(repository.length)), 'Expected the immutable production Logistics image');
  git(root, ['merge-base', '--is-ancestor', apiCommit, portalCommit]);
  const running = runtimeInputs(root, apiCommit);
  const candidate = runtimeInputs(root, portalCommit);
  const hash = rows => createHash('sha256').update(rows.join('\0') + '\0').digest('hex');
  const runtimeInputsSha256 = hash(running);
  assert.equal(hash(candidate), runtimeInputsSha256, 'Portal source changes inputs to the running API or worker');
  return { apiCommit, apiImage, portalCommit, runtimeInputsSha256, runtimeInputCount: running.length };
}
