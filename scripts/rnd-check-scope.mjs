import { execFileSync } from 'node:child_process';
import { appendFileSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const groups = {
  backend: /^(backend\/|packages\/|research\/(vision|privacy|witness|benchmarks)\/|verifier\/|scripts\/(rnd-source-text|generate-rnd-client|check-rnd-openapi|requirements-rnd-contracts))/,
  surfaces: /^(web\/|desktop\/|mobile\/|packages\/|config\/rnd\/|backend\/src\/(capture\/|identifiers\/|domain\/proof-presentation\.|canonical\.|hash\.))/,
  federated: /^research\/federated\//,
  proof: /^research\/privacy\/zk\//,
  sandbox: /^(research\/(vision|privacy)\/|scripts\/rnd-(worker-sandbox|sandbox-probe))/,
  container: /^(backend\/|packages\/|research\/(backend\.Dockerfile|container-)|scripts\/rnd-container)/,
  android: /^(mobile\/|packages\/onboarding\/|packages\/evidence-contracts\/(?!generated-client|test\/generated-client)|config\/rnd\/|backend\/src\/(capture\/|identifiers\/|domain\/proof-presentation\.|canonical\.|hash\.))/,
  fragments: /^(research\/capture-fragments\/|packages\/evidence-contracts\/)/,
};

export function scopeFor(files, complete = false) {
  files = files.filter(file => !file.startsWith('docs/') && !file.endsWith('.md'));
  // Scope selection itself is always tested by source-isolation. Application
  // checks follow changed inputs; a general CI edit does not rebuild Android.
  const all = complete || files.some(file => /^\.github\/workflows\/rnd-release-policy|^scripts\/rnd(?:\.mjs|-runtime|-release-guard)/.test(file));
  const general = files.includes('.github/workflows/rnd-ci.yml');
  const native = files.includes('.github/workflows/rnd-native.yml');
  return Object.fromEntries(Object.entries(groups).map(([name, pattern]) => [name,
    all || (['android', 'fragments'].includes(name) ? native : general) || files.some(file => pattern.test(file))]));
}

export function changedFiles(event, name, git = args => execFileSync('git', args, { encoding: 'utf8' })) {
  if (name === 'workflow_dispatch') return null;
  const base = name === 'pull_request' ? event.pull_request?.base?.sha : event.before;
  const head = name === 'pull_request' ? event.pull_request?.head?.sha : event.after;
  // New branches and unavailable history receive all checks, never an empty pass.
  if (![base, head].every(value => /^[0-9a-f]{40}$/.test(value ?? '') && !/^0+$/.test(value))) return null;
  try {
    const revisions = name === 'pull_request' ? [`${base}...${head}`] : [base, head];
    return git(['diff', '--name-only', '-z', ...revisions]).split('\0').filter(Boolean);
  } catch { return null; }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const event = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, 'utf8'));
  const files = changedFiles(event, process.env.GITHUB_EVENT_NAME);
  const scope = scopeFor(files ?? [], files === null);
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, Object.entries(scope).map(([name, selected]) => `${name}=${selected}\n`).join(''));
  console.log(JSON.stringify({ files, complete: files === null, scope }, null, 2));
}
