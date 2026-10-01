import test from 'node:test';
import assert from 'node:assert/strict';
import { sandboxEnvironment } from './dev.mjs';

test('sandbox never inherits production endpoints, credentials, loaders or auto-submission settings', () => {
  const env = sandboxEnvironment({ PATH: '/usr/bin', HOME: '/home/example', DATABASE_URL: 'postgres://production', AWS_ACCESS_KEY_ID: 'private', EXPO_TOKEN: 'private', NODE_OPTIONS: '--import malicious.mjs', PACKPROOF_ENVIRONMENT: 'production', PACKPROOF_SURFACE_CUSTOMER_FINDINGS: 'true', EAS_AUTO_SUBMIT: 'true' });
  for (const key of ['DATABASE_URL', 'AWS_ACCESS_KEY_ID', 'EXPO_TOKEN', 'NODE_OPTIONS', 'EAS_AUTO_SUBMIT']) assert.equal(env[key], undefined);
  assert.equal(env.PACKPROOF_ENVIRONMENT, 'research');
  assert.equal(env.PACKPROOF_LISTEN_HOST, '127.0.0.1');
  assert.equal(env.PACKPROOF_OBJECT_STORAGE, 'local');
  assert.equal(env.PACKPROOF_SURFACE_CUSTOMER_FINDINGS, 'false');
  assert.equal(env.PACKPROOF_SURFACE_COLLECTION, 'false');
});

test('research opt-in enables internal processing without public findings', () => {
  const env = sandboxEnvironment({}, { research: true });
  assert.equal(env.PACKPROOF_SURFACE_COLLECTION, 'true');
  assert.equal(env.PACKPROOF_SURFACE_EXTRACTION, 'true');
  assert.equal(env.PACKPROOF_SURFACE_INTERNAL_COMPARISON, 'true');
  assert.equal(env.PACKPROOF_SURFACE_CUSTOMER_FINDINGS, 'false');
  assert.notEqual(env.PACKPROOF_UPLOAD_SECRET, sandboxEnvironment({}).PACKPROOF_UPLOAD_SECRET);
});
