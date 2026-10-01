#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { mkdirSync, existsSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

// Build an allowlist, not a copy of the caller's cloud/production environment.
export function sandboxEnvironment(source, options = {}) {
  const environment = {};
  for (const key of ['PATH', 'HOME', 'USERPROFILE', 'SystemRoot', 'COMSPEC', 'PATHEXT', 'TEMP', 'TMP', 'TMPDIR', 'LANG']) {
    if (source[key]) environment[key] = source[key];
  }
  const apiPort = options.apiPort ?? 3000;
  const webPort = options.webPort ?? 5173;
  for (const port of [apiPort, webPort]) if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Use a local unprivileged port');
  const enabled = options.research === true ? 'true' : 'false';
  return Object.assign(environment, {
    NODE_ENV: 'development', PORT: String(apiPort),
    PACKPROOF_ENVIRONMENT: 'research', PACKPROOF_RESEARCH_BUILD: 'true',
    PACKPROOF_LISTEN_HOST: '127.0.0.1',
    PACKPROOF_PUBLIC_URL: `http://127.0.0.1:${apiPort}`,
    PACKPROOF_WEB_ORIGINS: `http://127.0.0.1:${webPort},http://localhost:${webPort}`,
    PACKPROOF_AUTH_MODE: 'dev', PACKPROOF_DEV_AUTH: 'true',
    PACKPROOF_OBJECT_STORAGE: 'local', PACKPROOF_CREDENTIAL_STORE: 'memory',
    PACKPROOF_MANIFEST_SIGNING_MODE: 'unsigned', PACKPROOF_MANIFEST_SIGNING_REQUIRED: 'false',
    PACKPROOF_UPLOAD_SECRET: randomBytes(32).toString('hex'),
    PACKPROOF_PROCESS_ROLE: 'combined', PACKPROOF_MIGRATE_ON_START: 'true',
    PACKPROOF_REQUIRE_DURABLE_RECEIPTS: 'false',
    PACKPROOF_COMMERCE_WORKER: 'false', PACKPROOF_CAPTURE_SHIPMENT_WORKER: 'false',
    PACKPROOF_MEDIA_WORKER: 'false', PACKPROOF_RECIPIENT_EXPORT_WORKER: 'false',
    PACKPROOF_WEBHOOK_WORKER: 'false', PACKPROOF_RECOVERY_WORKER: 'false',
    PACKPROOF_SURFACE_COLLECTION: enabled, PACKPROOF_SURFACE_EXTRACTION: enabled,
    PACKPROOF_SURFACE_INTERNAL_COMPARISON: enabled, PACKPROOF_SURFACE_CUSTOMER_FINDINGS: 'false',
    PACKPROOF_SURFACE_KILL_SWITCH: 'false',
    PACKPROOF_SURFACE_WORKER_ROOT: path.join(repository, 'surface-worker'),
    PACKPROOF_SURFACE_PYTHON: options.python ?? (process.platform === 'win32' ? 'python' : 'python3'),
    PGLITE_DIR: path.join(repository, 'data/rnd/database'),
    VITE_PACKPROOF_API_BASE_URL: `http://127.0.0.1:${apiPort}`,
    VITE_PACKPROOF_AUTH_MODE: 'dev', VITE_PACKPROOF_RESEARCH_BUILD: 'true',
    VITE_PACKPROOF_SURFACE_RND: 'true',
    VITE_SURFACE_FINGERPRINT_REVIEW: 'true',
    AWS_EC2_METADATA_DISABLED: 'true', PYTHONNOUSERSITE: '1',
  });
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes('--help')) {
    console.log('node scripts/rnd/dev.mjs [--enable-research] [--api-only] [--python /path/to/python]\nLocal R&D sandbox; analysis defaults off. Never deploys or submits builds.');
    return;
  }
  const allowed = new Set(['--enable-research', '--api-only', '--python']);
  let python;
  for (let i = 0; i < args.length; i++) {
    if (!allowed.has(args[i])) throw new Error(`Unknown option: ${args[i]}`);
    if (args[i] === '--python') { python = args[++i]; if (!python || python.startsWith('--')) throw new Error('--python requires an executable path'); }
  }
  const runtime = path.join(repository, 'data/rnd/runtime');
  mkdirSync(runtime, { recursive: true, mode: 0o700 });
  // index.ts loads .env from its CWD; no user-supplied settings belong here.
  if (existsSync(path.join(runtime, '.env'))) throw new Error('Remove the unexpected data/rnd/runtime/.env before starting the isolated sandbox');
  const loader = path.join(repository, 'backend/node_modules/tsx/dist/loader.mjs');
  if (!existsSync(loader)) throw new Error('Install dependencies with npm ci in backend, mobile and web first');
  const env = sandboxEnvironment(process.env, { research: args.includes('--enable-research'), python });
  const children = [];
  let stopping = false;
  function stop(code = 0) {
    if (stopping) return;
    stopping = true;
    for (const child of children) child.kill('SIGTERM');
    process.exitCode = code;
    const timer = setTimeout(() => { for (const child of children) child.kill('SIGKILL'); }, 5000);
    timer.unref();
  }
  function start(command, argv, cwd) {
    const child = spawn(command, argv, { cwd, env, stdio: 'inherit', shell: false });
    children.push(child);
    child.on('error', error => { console.error(error.message); stop(1); });
    child.on('exit', code => { if (!stopping) stop(code ?? 1); });
  }
  start(process.execPath, ['--import', loader, path.join(repository, 'backend/src/index.ts')], runtime);
  if (!args.includes('--api-only')) {
    start(process.execPath, [path.join(repository, 'web/node_modules/vite/bin/vite.js'), '--mode', 'rnd', '--host', '127.0.0.1', '--port', '5173', '--strictPort'], path.join(repository, 'web'));
  }
  console.log(`PackProof R&D sandbox: http://127.0.0.1:5173 • API http://127.0.0.1:3000\nResearch analysis ${args.includes('--enable-research') ? 'enabled; all profiles remain unqualified' : 'off'}. Local accounts and evidence only.`);
  process.on('SIGINT', () => stop());
  process.on('SIGTERM', () => stop());
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch(error => { console.error(error.message); process.exitCode = 1; });
