#!/usr/bin/env node
/** No network, credentials or dependencies. Deny distribution of research source. */
import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export function distributionDecision({ marker, refs = [], environment = {}, sourceSha = '' }) {
  const reasons = [];
  if (!marker || marker.schemaVersion !== 'packproof.build-policy.v1') reasons.push('BUILD_POLICY_MISSING_OR_INVALID');
  if (marker?.researchOnly !== false || marker?.distributionAllowed !== true) reasons.push('RESEARCH_BUILD_NOT_DISTRIBUTABLE');
  if (refs.some(ref => /(?:^|\/)rnd(?:\/|$)|(?:^|\/)research(?:\/|$)/i.test(String(ref)))) reasons.push('RESEARCH_BRANCH');
  if (refs.some(ref => /refs\/pull\//.test(String(ref)))) reasons.push('PULL_REQUEST_SOURCE');
  if (!refs.includes('refs/heads/main')) reasons.push('MAIN_BRANCH_REQUIRED');
  if (refs.some(ref => !['main', 'refs/heads/main'].includes(ref))) reasons.push('NON_MAIN_SOURCE');
  if (environment.PACKPROOF_DISTRIBUTION_AUTHORIZED !== 'true') reasons.push('DISTRIBUTION_NOT_AUTHORIZED');
  if (!/^[0-9a-f]{40}$/.test(sourceSha)) reasons.push('EXACT_SOURCE_SHA_REQUIRED');
  if (['PACKPROOF_RND', 'PACKPROOF_RESEARCH_BUILD', 'EXPO_PUBLIC_PACKPROOF_RND', 'VITE_PACKPROOF_RND'].some(key => ['true', '1'].includes(environment[key]))) reasons.push('RESEARCH_ENVIRONMENT');
  return { schemaVersion: 'packproof.distribution-decision.v1', allowed: reasons.length === 0, sourceSha, reasons: [...new Set(reasons)] };
}

export function readBuildPolicy(root) {
  const path = resolve(root, 'config/rnd/research-build.json');
  if (!existsSync(path)) return null;
  try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return null; }
}

function git(root, args) {
  try { return execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch { return ''; }
}

export function evaluateRepository(root, environment = process.env) {
  const localBranch = git(root, ['symbolic-ref', '--quiet', 'HEAD']);
  const localSha = git(root, ['rev-parse', 'HEAD']);
  const eventSha = environment.PACKPROOF_SOURCE_SHA || environment.GITHUB_SHA || localSha;
  const decision = distributionDecision({
    marker: readBuildPolicy(root), environment, sourceSha: eventSha,
    refs: [localBranch, environment.GITHUB_REF, environment.GITHUB_HEAD_REF, environment.PACKPROOF_SOURCE_BRANCH].filter(Boolean),
  });
  if (eventSha !== localSha) { decision.allowed = false; decision.reasons.push('CHECKED_OUT_SOURCE_MISMATCH'); }
  return decision;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = resolve(process.argv.includes('--root') ? process.argv[process.argv.indexOf('--root') + 1] : '.');
  const decision = evaluateRepository(root);
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `allowed=${decision.allowed}\n`);
  process.stdout.write(`${JSON.stringify(decision, null, 2)}\n`);
  if (process.argv.includes('--enforce') && !decision.allowed) process.exitCode = 1;
}
