import type { AppConfig } from '../config.js';

/** Admission before database access, migrations, signing or background jobs.
 * This checks configuration; readiness and release preflight verify dependencies.
 */
export function assertProductionRuntime(config: AppConfig, env: NodeJS.ProcessEnv = process.env): void {
  if (config.release.environment !== 'production') return;
  const require = (ok: unknown, message: string) => {
    if (!ok) throw new Error(`Production runtime rejected: ${message}`);
  };
  const https = (value: string) => {
    try { const url = new URL(value); return url.protocol === 'https:' && !url.username && !url.password; }
    catch { return false; }
  };
  require(env.NODE_ENV === 'production', 'NODE_ENV must be production');
  require(config.authMode === 'cognito' && !config.devAuth && env.PACKPROOF_DEV_AUTH !== '1'
    && config.cognitoUserPoolId && config.cognitoClientId && config.cognitoRegion, 'Cognito authentication is required');
  require(config.objectStore === 's3' && config.awsRegion && config.awsS3Bucket, 'S3 evidence storage is required');
  require(config.credentialStore === 'secrets-manager', 'managed integration credentials are required');
  require(config.migrateOnStart === false, 'automatic migrations must be disabled');
  let database: URL | undefined;
  try { database = new URL(config.databaseUrl ?? ''); } catch { /* fail with a non-secret diagnostic below */ }
  require(database && ['postgres:', 'postgresql:'].includes(database.protocol)
    && ['require', 'verify-ca', 'verify-full'].includes(database.searchParams.get('sslmode') ?? '')
    && (env.PACKPROOF_DB_CA_FILE || env.PACKPROOF_DB_CA_PEM || database.searchParams.get('sslrootcert')),
    'PostgreSQL with verified TLS and a CA bundle is required');
  require(https(config.publicBaseUrl) && config.webOrigins.length > 0 && config.webOrigins.every(https),
    'HTTPS API and browser origins are required');
  require(env.PACKPROOF_MANIFEST_SIGNING_MODE === 'kms' && env.PACKPROOF_MANIFEST_SIGNING_REQUIRED === 'true'
    && /^arn:aws(?:-[a-z]+)?:kms:[a-z0-9-]+:\d{12}:key\/[a-zA-Z0-9-]+$/.test(env.PACKPROOF_MANIFEST_KMS_KEY_ARN ?? ''),
    'required KMS manifest signing is required');
  require(env.PACKPROOF_READINESS_OBJECT_KEY && env.PACKPROOF_READINESS_OBJECT_VERSION,
    'a pinned evidence-storage readiness object is required');
  require(/^[a-f0-9]{40}$/.test(config.release.commit ?? '')
    && /@sha256:[a-f0-9]{64}$/.test(config.release.image ?? '') && config.release.version,
    'immutable release identity is required');
}
