import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import { assertProductionRuntime } from '../src/operations/production-runtime.js';
import { createEbayRuntime } from '../src/integrations/ebay/runtime.js';
import { ebayUserCredentialReference } from '../src/integrations/ebay/credentials.js';

const production = (): NodeJS.ProcessEnv => ({
  NODE_ENV: 'production', PACKPROOF_ENVIRONMENT: 'production',
  PACKPROOF_AUTH_MODE: 'cognito', PACKPROOF_COGNITO_USER_POOL_ID: 'us-east-1_test',
  PACKPROOF_COGNITO_CLIENT_ID: 'testclient', AWS_REGION: 'us-east-1',
  PACKPROOF_OBJECT_STORAGE: 's3', PACKPROOF_S3_BUCKET: 'test-evidence',
  PACKPROOF_CREDENTIAL_STORE: 'secrets-manager', PACKPROOF_CREDENTIAL_NAMESPACE: 'staging',
  PACKPROOF_MIGRATE_ON_START: 'false', DATABASE_URL: 'postgres://runtime@database.invalid/proofs?sslmode=verify-full',
  PACKPROOF_DB_CA_FILE: 'certs/test-public-ca.pem', PACKPROOF_PUBLIC_URL: 'https://api.example.com',
  PACKPROOF_WEB_ORIGINS: 'https://example.com', PACKPROOF_MANIFEST_SIGNING_MODE: 'kms',
  PACKPROOF_MANIFEST_SIGNING_REQUIRED: 'true',
  PACKPROOF_MANIFEST_KMS_KEY_ARN: 'arn:aws:kms:us-east-1:123456789012:key/11111111-1111-4111-8111-111111111111',
  PACKPROOF_READINESS_OBJECT_KEY: 'readiness/sentinel', PACKPROOF_READINESS_OBJECT_VERSION: 'pinned-version',
  PACKPROOF_RELEASE_SHA: 'a'.repeat(40), PACKPROOF_RELEASE_IMAGE: `registry.example.com/api@sha256:${'b'.repeat(64)}`,
  PACKPROOF_RELEASE_VERSION: 'production-test',
});

describe('production runtime admission', () => {
  it('admits managed production dependencies without changing credential storage', () => {
    const env = production(), config = loadConfig(env);
    expect(() => assertProductionRuntime(config, env)).not.toThrow();
    expect(config.release.environment).toBe('production');
    const ebay = createEbayRuntime(config, { publicBaseUrl: config.publicBaseUrl, webOrigins: config.webOrigins });
    expect(ebayUserCredentialReference({ packproofEnvironment: ebay.packproofEnvironment, ebayEnvironment: 'production', connectionId: 'account-1' }))
      .toBe('packproof/staging/integrations/ebay/production/account-1');
  });
  it.each([
    ['NODE_ENV', 'development'], ['PACKPROOF_AUTH_MODE', 'dev'], ['PACKPROOF_DEV_AUTH', 'true'],
    ['PACKPROOF_DEV_AUTH', '1'], ['PACKPROOF_COGNITO_CLIENT_ID', ''], ['PACKPROOF_OBJECT_STORAGE', 'local'],
    ['PACKPROOF_CREDENTIAL_STORE', 'memory'], ['PACKPROOF_MIGRATE_ON_START', 'true'],
    ['DATABASE_URL', 'postgres://runtime:do-not-print@database.invalid/proofs?sslmode=disable'],
    ['PACKPROOF_DB_CA_FILE', ''], ['PACKPROOF_PUBLIC_URL', 'http://api.example.com'],
    ['PACKPROOF_WEB_ORIGINS', 'http://example.com'], ['PACKPROOF_MANIFEST_SIGNING_MODE', 'unsigned'],
    ['PACKPROOF_MANIFEST_SIGNING_REQUIRED', 'false'], ['PACKPROOF_MANIFEST_KMS_KEY_ARN', 'alias/unpinned'],
    ['PACKPROOF_READINESS_OBJECT_VERSION', ''], ['PACKPROOF_RELEASE_SHA', 'main'],
    ['PACKPROOF_RELEASE_IMAGE', 'registry.example.com/api:latest'],
  ])('rejects unsafe %s without disclosing configuration values', (name, value) => {
    const env = { ...production(), [name]: value };
    expect(() => assertProductionRuntime(loadConfig(env), env)).toThrow(/Production runtime rejected:/);
    try { assertProductionRuntime(loadConfig(env), env); } catch (error) {
      expect(String(error)).not.toContain('do-not-print');
    }
  });
  it('keeps local development usable', () => expect(() => assertProductionRuntime(loadConfig({}), {})).not.toThrow());
  it('defaults a new deployment namespace to its environment and rejects path injection', () => {
    expect(loadConfig({ PACKPROOF_ENVIRONMENT: 'production' }).credentialNamespace).toBe('production');
    expect(() => loadConfig({ PACKPROOF_CREDENTIAL_NAMESPACE: '../other' })).toThrow(/credential_namespace/i);
  });
});
