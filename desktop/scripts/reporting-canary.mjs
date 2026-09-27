import { build } from 'esbuild';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

async function main() {
  const args = process.argv.slice(2);
  const allowed = new Set(['--send', '--approved-project-id', '--approved-ingest-host', '--source-commit', '--output']);
  const values = {};
  for (let index = 0; index < args.length; index++) {
    const name = args[index];
    if (!allowed.has(name) || Object.hasOwn(values, name)) throw new Error('INVALID_ARGUMENTS');
    if (name === '--send') values[name] = true;
    else { if (!args[index + 1] || args[index + 1].startsWith('--')) throw new Error('INVALID_ARGUMENTS'); values[name] = args[++index]; }
  }
  if (!values['--send'] || [...allowed].some(name => !values[name])) throw new Error('EXPLICIT_SEND_AND_APPROVED_PROJECT_REQUIRED');
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const actualSource = execFileSync('git', ['-C', root, 'rev-parse', 'HEAD'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  if (actualSource !== values['--source-commit']) throw new Error('SOURCE_COMMIT_MISMATCH');
  execFileSync('git', ['-C', root, 'diff', '--quiet', 'HEAD', '--', 'src/main/error-reporting.ts', 'src/main/reporting-canary.ts', 'scripts/reporting-canary.mjs', 'package.json', 'package-lock.json'], { stdio: 'ignore' });
  const untracked = execFileSync('git', ['-C', root, 'ls-files', '--others', '--exclude-standard', '--', 'src/main/reporting-canary.ts', 'scripts/reporting-canary.mjs'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  if (untracked.trim()) throw new Error('UNCOMMITTED_REPORTER_SOURCE');
  const version = JSON.parse(await readFile(join(root, 'package.json'), 'utf8')).version;
  const cache = join(root, 'node_modules', '.cache');
  await mkdir(cache, { recursive: true });
  const temporary = await mkdtemp(join(cache, 'packproof-reporting-canary-'));
  try {
    const target = join(temporary, 'canary.cjs');
    await build({ absWorkingDir: root, entryPoints: ['src/main/reporting-canary.ts'], outfile: target, bundle: true, platform: 'node', target: 'node24', format: 'cjs', packages: 'external', logLevel: 'silent' });
    const { runReportingCanary } = await import(pathToFileURL(target).href);
    const output = resolve(values['--output']);
    await writeFile(output, JSON.stringify({ result: 'CANARY_DID_NOT_COMPLETE', deliveryVerified: false }) + '\n', { mode: 0o600, flag: 'wx' });
    const receipt = await runReportingCanary({ send: true, dsn: process.env.PACKPROOF_SENTRY_DSN ?? process.env.SENTRY_DSN ?? '', channel: process.env.APP_ENV ?? '', version, sourceCommit: actualSource, approvedProjectId: values['--approved-project-id'], approvedIngestHost: values['--approved-ingest-host'] });
    await writeFile(output, JSON.stringify(receipt, null, 2) + '\n', { mode: 0o600 });
    process.stdout.write(JSON.stringify({ result: receipt.result, eventId: receipt.eventId, ingestAcknowledged: receipt.ingestAcknowledged, deliveryVerified: false }) + '\n');
    return receipt.ingestAcknowledged ? 0 : 1;
  } finally { await rm(temporary, { recursive: true, force: true }); }
}

try { process.exit(await main()); }
catch { process.stderr.write('Reporting canary did not complete. Check explicit send, approved project, clean exact source, environment configuration, and a new receipt output path. No delivery acceptance was recorded.\n'); process.exit(1); }
