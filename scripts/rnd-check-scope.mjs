import { execFileSync } from 'node:child_process';
import { appendFileSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const groups = {
  backend: /^(backend\/|packages\/|research\/(vision|privacy|witness|benchmarks)\/|verifier\/|scripts\/(generate-rnd-client|check-rnd-openapi|requirements-rnd-contracts))/,
  surfaces: /^(web\/|desktop\/|mobile\/|packages\/|config\/rnd\/)/,
  federated: /^research\/federated\//,
  proof: /^research\/privacy\/zk\//,
  sandbox: /^(research\/(vision|privacy)\/|scripts\/rnd-(worker-sandbox|sandbox-probe))/,
  container: /^(backend\/|packages\/|research\/(backend\.Dockerfile|container-)|scripts\/rnd-container)/,
  android: /^(mobile\/|packages\/|config\/rnd\/)/,
  fragments: /^(research\/capture-fragments\/|packages\/evidence-contracts\/fragments\.mjs$)/,
};

export function scopeFor(files, complete = false) {
  // A workflow or shared runner change requires each affected workflow's checks.
  const all = complete || files.some(file => /^\.github\/workflows\/rnd-|^scripts\/rnd(?:\.mjs|-check-scope|-runtime|-release-guard)/.test(file));
  return Object.fromEntries(Object.entries(groups).map(([name, pattern]) => [name, all || files.some(file => pattern.test(file))]));
}

export function changedFiles(event, name, git = args => execFileSync('git', args, { encoding: 'utf8' })) {
  if (name === 'workflow_dispatch') return null;
  const base = name === 'pull_request' ? event.pull_request?.base?.sha : event.before;
  const head = name === 'pull_request' ? event.pull_request?.head?.sha : event.after;
  // New branches and unavailable history receive all checks, never an empty pass.
  if (![base, head].every(value => /^[0-9a-f]{40}$/.test(value ?? '') && !/^0+$/.test(value))) return null;
  try {
    return git(['diff', '--name-only', '-z', `${base}...${head}`]).split('\0').filter(Boolean);
  } catch { return null; }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const event = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, 'utf8'));
  const files = changedFiles(event, process.env.GITHUB_EVENT_NAME);
  const scope = scopeFor(files ?? [], files === null);
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, Object.entries(scope).map(([name, selected]) => `${name}=${selected}\n`).join(''));
  console.log(JSON.stringify({ files, complete: files === null, scope }, null, 2));
}
