import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { writeFile } from 'node:fs/promises';

// This entry point is for the dedicated private CodeBuild runner only. No URL fallback.
assert.equal(process.env.PACKPROOF_TEST_PURPOSE, 'isolated-m1-synthetic');
assert.equal(process.env.AWS_REGION ?? process.env.AWS_DEFAULT_REGION, 'us-east-1');
assert.equal(process.env.PACKPROOF_TEST_DB_HOST,
  'packproof-m1-20261020-db.c8v2esku2zyt.us-east-1.rds.amazonaws.com');
const secret = JSON.parse(process.env.ISOLATED_DB_SECRET ?? '{}');
assert.equal(secret.username, 'packproof');
assert.equal(typeof secret.password, 'string');
assert.ok(secret.password.length > 0);
const url = new URL(`postgresql://${process.env.PACKPROOF_TEST_DB_HOST}:5432/packproof_v2`);
url.username = secret.username;
url.password = secret.password;
url.searchParams.set('sslmode', 'verify-full');
delete process.env.ISOLATED_DB_SECRET;
process.env.PACKPROOF_TEST_DATABASE_URL = url.toString();
process.env.PACKPROOF_DB_CA_FILE = '/tmp/packproof-rds-ca.pem';
// Child arguments and logs contain no credential or connection string.
const steps = [
  ['--import', 'tsx', 'scripts/isolated-migration-preservation.mjs'],
  ['node_modules/vitest/vitest.mjs', 'run', 'tests/organization-foundation.test.ts',
    'tests/partner-postgres-gate.test.ts', '--pool=threads', '--reporter=default',
    '--reporter=junit', '--outputFile=acceptance-artifacts/database-tests.xml'],
];
for (const args of steps) {
  const result = spawnSync(process.execPath, args, { env: process.env, stdio: 'inherit' });
  if (result.error || result.status !== 0) process.exit(result.status || 1);
}
const evidence = { event: 'isolated_m1_database_checks_passed',
  source: process.env.CANDIDATE_SHA, baseline: process.env.BASELINE_SHA,
  storageAdapter: 'MemoryObjectStore', authentication: 'synthetic-in-process',
  recoveryCertified: false, deviceAcceptance: false };
await writeFile(new URL('../acceptance-artifacts/database-gates.json', import.meta.url), JSON.stringify(evidence, null, 2));
console.log(JSON.stringify(evidence));
