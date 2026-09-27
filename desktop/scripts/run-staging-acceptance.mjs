import { build } from 'esbuild';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const dir = await mkdtemp(join(tmpdir(), 'packproof-staging-script-'));
try {
  const entry = join(dir, 'acceptance.mjs');
  await build({ entryPoints: [join(root, 'scripts/staging-acceptance.ts')], outfile: entry, bundle: true, platform: 'node', target: 'node24', format: 'esm', logLevel: 'silent' });
  const exitCode = await new Promise((done, reject) => {
    const child = spawn(process.execPath, [entry, ...process.argv.slice(2)], { cwd: root, env: process.env, stdio: 'inherit', shell: false });
    child.on('error', reject); child.on('exit', code => done(code ?? 1));
  });
  process.exitCode = exitCode;
} catch {
  console.error(JSON.stringify({ status: 'FAIL', code: 'ACCEPTANCE_SCRIPT_START_FAILED' }));
  process.exitCode = 1;
} finally {
  await rm(dir, { recursive: true, force: true });
}
