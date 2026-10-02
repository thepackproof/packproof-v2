import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { distributionDecision, evaluateRepository, readBuildPolicy } from './rnd-release-guard.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const authorized = {
  marker: { schemaVersion: 'packproof.build-policy.v1', researchOnly: false, distributionAllowed: true },
  refs: ['refs/heads/main'], environment: { PACKPROOF_DISTRIBUTION_AUTHORIZED: 'true' }, sourceSha: 'a'.repeat(40),
};

test('distribution is denied for research branches, pull requests, tags and non-main sources', () => {
  for (const ref of ['rnd/trust', 'refs/heads/rnd/trust', 'research/capture', 'refs/pull/23/merge', 'refs/tags/v1', 'feature/copied-research']) {
    assert.equal(distributionDecision({ ...authorized, refs: ['refs/heads/main', ref] }).allowed, false, ref);
  }
});

test('research marker blocks renamed branches, merged source and explicit authorization', () => {
  assert.equal(distributionDecision({ ...authorized, marker: readBuildPolicy(root) }).allowed, false);
  for (const marker of [null, {}, { researchOnly: false, distributionAllowed: true }, { ...authorized.marker, researchOnly: 'false' }, { ...authorized.marker, distributionAllowed: false }]) {
    assert.equal(distributionDecision({ ...authorized, marker }).allowed, false);
  }
});

test('absence of explicit authorization, exact source, or supported metadata fails closed', () => {
  assert.equal(distributionDecision(authorized).allowed, true);
  assert.equal(distributionDecision({ ...authorized, environment: {} }).allowed, false);
  assert.equal(distributionDecision({ ...authorized, sourceSha: '' }).allowed, false);
  assert.equal(distributionDecision({ ...authorized, refs: [] }).allowed, false);
  for (const flag of ['PACKPROOF_RND', 'PACKPROOF_RESEARCH_BUILD', 'EXPO_PUBLIC_PACKPROOF_RND', 'VITE_PACKPROOF_RND']) {
    assert.equal(distributionDecision({ ...authorized, environment: { ...authorized.environment, [flag]: 'true' } }).allowed, false);
  }
});

test('missing and malformed marker do not become release authorization', () => {
  const temporary = mkdtempSync(resolve(tmpdir(), 'packproof-rnd-guard-'));
  try {
    assert.equal(readBuildPolicy(temporary), null);
    mkdirSync(resolve(temporary, 'config/rnd'), { recursive: true });
    writeFileSync(resolve(temporary, 'config/rnd/research-build.json'), '{ broken json');
    assert.equal(readBuildPolicy(temporary), null);
  } finally { rmSync(temporary, { recursive: true, force: true }); }
});

test('checked-out source must match event source and current R&D checkout cannot distribute', () => {
  const decision = evaluateRepository(root, { ...authorized.environment, GITHUB_REF: 'refs/heads/main', PACKPROOF_SOURCE_SHA: '0'.repeat(40) });
  assert.equal(decision.allowed, false);
  assert.ok(decision.reasons.includes('CHECKED_OUT_SOURCE_MISMATCH'));
  assert.ok(decision.reasons.includes('RESEARCH_BUILD_NOT_DISTRIBUTABLE'));
});

function jobs(source) {
  const body = source.slice(source.indexOf('\njobs:\n') + 7);
  const matches = [...body.matchAll(/^  ([\w-]+):\n/gm)];
  return matches.map((match, index) => ({ name: match[1], text: body.slice(match.index, matches[index + 1]?.index ?? body.length) }));
}

test('every credential-bearing and publishing workflow job requires no-secret source policy', () => {
  let protectedCount = 0;
  for (const filename of readdirSync(resolve(root, '.github/workflows')).filter(name => /\.ya?ml$/.test(name))) {
    const source = readFileSync(resolve(root, '.github/workflows', filename), 'utf8');
    for (const job of jobs(source)) {
      const sensitive = /secrets\.|configure-aws-credentials|azure\/login|eas(?:-cli@[^ ]+)?\s+(?:build|submit|update)|publish-release\.cjs|deploy-staging-current/.test(job.text);
      if (!sensitive) continue;
      protectedCount++;
      assert.match(job.text, /^    needs: (?:rnd-release-policy|\[[^\n]*rnd-release-policy[^\n]*\])$/m, `${filename}:${job.name} dependency`);
      assert.match(job.text, /^    if:.*needs\.rnd-release-policy\.outputs\.allowed == 'true'/m, `${filename}:${job.name} condition`);
      assert.match(job.text, /!startsWith\(github\.ref_name, 'rnd\/'\)/, `${filename}:${job.name} branch guard`);
      assert.match(source, /rnd-release-policy:\n    uses: \.\/\.github\/workflows\/rnd-release-policy\.yml/);
    }
  }
  assert.ok(protectedCount >= 9, 'audit should cover all known signing/publication jobs');
  const policy = readFileSync(resolve(root, '.github/workflows/rnd-release-policy.yml'), 'utf8');
  assert.doesNotMatch(policy, /secrets\.|id-token: write|secrets: inherit/);
  assert.match(policy, /persist-credentials: false/);
  assert.match(policy, /node scripts\/rnd-release-guard\.mjs/);
});

test('legacy native candidate builds cannot inherit live endpoints on the R&D branch', () => {
  for (const [file, jobName] of [['desktop-ci.yml', 'candidate'], ['ios.yml', 'simulator'], ['ios-store-assets.yml', 'simulator'], ['ci.yml', 'native-attestation'], ['android-camera-spike.yml', 'build']]) {
    const job = jobs(readFileSync(resolve(root, '.github/workflows', file), 'utf8')).find(item => item.name === jobName);
    assert.ok(job);
    assert.match(job.text, /needs\.rnd-release-policy\.outputs\.allowed == 'true'/);
  }
});
