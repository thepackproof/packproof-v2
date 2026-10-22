import { readFileSync, statSync } from 'node:fs';
import { KMSClient, GetPublicKeyCommand, SignCommand } from '@aws-sdk/client-kms';
import type { AppConfig } from '../config.js';
import type { Clock } from '../clock.js';
import type { Database } from '../db/database.js';
import { trustKeyPermitsSignature } from '../domain/signing-trust.js';
import { loadSignedTrustRegistryRuntime } from './trust-registry-runtime.js';
import { createEnvelopeTrust, createTrustedEnvelopeSigner } from './envelope-trust.js';
import { createEnvelopeS3Store, createEnvelopeS3Reader, envelopeS3Transport } from './envelope-s3-store.js';
import { assertEnvelopeRequestAuthority, type EnvelopeAccessRuntime } from './envelope-access.js';
import type { EnvelopeWorker } from './envelope-jobs.js';
import { jcsBytes, sha256 } from './envelope-profile.js';
import { verifyM2RuntimePrivileges } from '../../scripts/m2-runtime-privileges.mjs';

const fail = (): never => { throw Error('ENVELOPE_DEPLOYMENT_UNVERIFIED'); };
const exactDate = (value: unknown): value is string => typeof value === 'string' && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
/** Source-bound operational evidence supplements actual-role acceptance; it does
 * not turn operator-supplied booleans into independent AWS permission proof. */
export function validateEnvelopeDeployment(config: AppConfig, clock: Clock, env: NodeJS.ProcessEnv = process.env) {
  const artifactBucket = env.PACKPROOF_ENVELOPE_S3_BUCKET, evidenceBucket = env.PACKPROOF_COMMITTED_S3_BUCKET || config.awsS3Bucket;
  const journalBucket = env.PACKPROOF_RECOVERY_S3_BUCKET, account = env.PACKPROOF_ENVELOPE_BUCKET_OWNER;
  const keyArn = env.PACKPROOF_ENVELOPE_KMS_KEY_ARN, keyId = env.PACKPROOF_ENVELOPE_KEY_ID, issuer = env.PACKPROOF_ENVELOPE_ISSUER;
  const apiRole = env.PACKPROOF_API_TASK_ROLE_ARN, workerRole = env.PACKPROOF_RECOVERY_TASK_ROLE_ARN;
  const apiDatabaseRole = env.PACKPROOF_M2_API_DATABASE_ROLE, workerDatabaseRole = env.PACKPROOF_M2_WORKER_DATABASE_ROLE;
  const organizationEnvironment = env.PACKPROOF_ENVELOPE_ORGANIZATION_ENVIRONMENT;
  const cutoverAt = env.PACKPROOF_ENVELOPE_CUTOVER_AT, retainUntil = env.PACKPROOF_ENVELOPE_RETAIN_UNTIL, writerGeneration = env.PACKPROOF_RECOVERY_WRITER_GENERATION;
  const file = env.PACKPROOF_ENVELOPE_PROTECTION_EVIDENCE_FILE, expected = env.PACKPROOF_ENVELOPE_PROTECTION_EVIDENCE_SHA256;
  if (env.PACKPROOF_ENVELOPES_ENABLED !== 'true' || env.PACKPROOF_ORGANIZATIONS_ENABLED !== 'true' || env.PACKPROOF_ENVELOPE_TRUST_PUBLICATION_ENABLED !== 'true' ||
      !['api', 'worker'].includes(config.processRole ?? '') || config.migrateOnStart !== false || config.requireDurableReceipts !== true || config.objectStore !== 's3' ||
      !config.awsRegion || !config.release.commit || !/^[a-f0-9]{40}$/.test(config.release.commit) || !account || !/^\d{12}$/.test(account) ||
      !organizationEnvironment || !['sandbox','live'].includes(organizationEnvironment) || (config.release.environment === 'production' && organizationEnvironment !== 'live') ||
      !artifactBucket || !evidenceBucket || !journalBucket || new Set([artifactBucket,evidenceBucket,journalBucket]).size !== 3 || artifactBucket === config.awsS3Bucket ||
      ![artifactBucket,evidenceBucket,journalBucket].every(b => /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(b)) ||
      !keyArn || !new RegExp(`^arn:aws:kms:${config.awsRegion}:${account}:key/(?:[a-f0-9-]{36}|mrk-[a-f0-9]{32})$`).test(keyArn) ||
      [env.PACKPROOF_MANIFEST_KMS_KEY_ARN,env.PACKPROOF_RECOVERY_KMS_KEY_ARN].includes(keyArn) || !keyId || !/^[A-Za-z0-9_-]{1,160}$/.test(keyId) || !issuer ||
      !apiRole || !workerRole || apiRole === workerRole || ![apiRole,workerRole].every(r => new RegExp(`^arn:aws:iam::${account}:role/[A-Za-z0-9_+=,.@/-]+$`).test(r)) ||
      !apiDatabaseRole || !workerDatabaseRole || apiDatabaseRole === workerDatabaseRole || ![apiDatabaseRole,workerDatabaseRole].every(r => /^[a-z][a-z0-9_]{0,62}$/.test(r)) ||
      !exactDate(cutoverAt) || Date.parse(cutoverAt) > clock.now().getTime() || !exactDate(retainUntil) || Date.parse(retainUntil) <= clock.now().getTime() ||
      !writerGeneration || !/^[A-Za-z0-9_-]{1,160}$/.test(writerGeneration) || !file || !expected || !/^[a-f0-9]{64}$/.test(expected)) return fail();
  let merchantIds: string[], proof: Record<string, any>;
  try {
    merchantIds = JSON.parse(env.PACKPROOF_ENVELOPE_MERCHANT_IDS ?? 'null');
    if (!Array.isArray(merchantIds) || merchantIds.length < 1 || merchantIds.length > 100 || new Set(merchantIds).size !== merchantIds.length || merchantIds.some(id => typeof id !== 'string' || !/^[A-Za-z0-9_-]{1,160}$/.test(id))) return fail();
    const stat = statSync(file); if (!stat.isFile() || stat.size < 1 || stat.size > 65536) return fail();
    const bytes = readFileSync(file); if (bytes.length > 65536 || sha256(bytes) !== expected) return fail();
    proof = JSON.parse(bytes.toString('utf8'));
  } catch { return fail(); }
  const binding = { artifactBucket,evidenceBucket,journalBucket,account,region:config.awsRegion,keyArn,keyId,issuer,apiRole,workerRole,apiDatabaseRole,workerDatabaseRole,
    sourceSha:config.release.commit,environment:config.release.environment,organizationEnvironment,merchantIds:[...merchantIds].sort(),cutoverAt,retainUntil,writerGeneration };
  if (proof?.schema !== 'packproof.envelope-deployment.v1' || !proof.binding || !jcsBytes(proof.binding).equals(jcsBytes(binding)) ||
      typeof proof.reviewedBy !== 'string' || !proof.reviewedBy.trim() || typeof proof.evidenceReference !== 'string' || !proof.evidenceReference.trim() ||
      !exactDate(proof.verifiedAt) || Date.parse(proof.verifiedAt) > clock.now().getTime() || !exactDate(proof.expiresAt) || Date.parse(proof.expiresAt) <= clock.now().getTime() || Date.parse(proof.expiresAt) > Date.parse(retainUntil)) return fail();
  for (const name of ['versioningVerified','complianceRetentionVerified','originalProtectionVerified','conditionalCreationVerified','exactVersionReadVerified',
    'apiWritesDenied','apiSigningDenied','workerDeletionDenied','retentionMutationDenied','crossBucketAccessDenied','writerFenceVerified','freshRestoreVerified','databaseRolesVerified','authenticatedHttpVerified'])
    if (proof[name] !== true) return fail();
  return binding;
}
function currentTrust(clock: Clock, env: NodeJS.ProcessEnv) {
  const loaded = loadSignedTrustRegistryRuntime(clock, env); if (!loaded) return fail();
  return createEnvelopeTrust({ issuer:env.PACKPROOF_ENVELOPE_ISSUER!,clock,
    readRegistry:()=>Buffer.from(loaded.signedTrustRegistryJson),readAuthorityPins:()=>loaded.registryAuthorityKeys });
}
export async function initializeEnvelopeRuntime(config: AppConfig, clock: Clock, db: Database, env: NodeJS.ProcessEnv = process.env) {
  const flag = env.PACKPROOF_ENVELOPES_ENABLED ?? 'false';
  if (!['true','false'].includes(flag)) throw Error('ENVELOPE_FEATURE_FLAG_INVALID');
  if (flag === 'false') return undefined;
  const binding = validateEnvelopeDeployment(config, clock, env);
  const assertReady = () => {
    if (!jcsBytes(validateEnvelopeDeployment(config, clock, env)).equals(jcsBytes(binding))) return fail();
    currentTrust(clock, env).snapshot();
  };
  const checkDatabase = async () => {
    const identity = (await db.query<{role:string;login:string}>('SELECT current_user AS role,session_user AS login')).rows[0];
    const expected = config.processRole === 'api' ? binding.apiDatabaseRole : binding.workerDatabaseRole;
    if (identity.role !== expected || identity.login !== expected) throw Error('ENVELOPE_DATABASE_IDENTITY_MISMATCH');
    await verifyM2RuntimePrivileges(db, { apiRole:binding.apiDatabaseRole,workerRole:binding.workerDatabaseRole });
  };
  assertReady(); await checkDatabase(); currentTrust(clock,env).activeKey(binding.keyId);
  const transport = envelopeS3Transport(binding.region);
  const storage = { artifactBucket:binding.artifactBucket,evidenceBuckets:[binding.evidenceBucket],expectedBucketOwner:binding.account,clock,transport };
  const journalReader = createEnvelopeS3Reader({ ...storage,evidenceBuckets:[binding.journalBucket] });
  const trustedPublicKey: EnvelopeWorker['trustedPublicKey'] = async (issuer,keyId,issuedAt) => {
    try { return await currentTrust(clock,env).trustedPublicKey(issuer,keyId,issuedAt); } catch { return null; }
  };
  const access: EnvelopeAccessRuntime = { assertReady,
    cohort:{merchantIds:binding.merchantIds,environment:binding.organizationEnvironment,cutoverAt:binding.cutoverAt},
    admission:{evidenceBucket:binding.evidenceBucket,artifactBucket:binding.artifactBucket,issuer:binding.issuer,keyId:binding.keyId,retainUntil:binding.retainUntil,writerGeneration:binding.writerGeneration},
    reader:createEnvelopeS3Reader(storage),trustedPublicKey,
    sourceJournal:{store:{get:async(key,reference)=>{
      if (!/^recovery\/v1\/[a-f0-9]{64}\.json$/.test(key) || !reference?.versionId || reference.versionId === 'null') throw Error('ENVELOPE_SOURCE_VERSION_REQUIRED');
      const result = await journalReader.readExact({bucket:binding.journalBucket,key,versionId:reference.versionId},8*1024*1024);
      return {body:result.body,contentType:'application/json'};
    }},trustedPublicKey:async(keyId,signedAt)=>{
      try {
        if (!signedAt) return null;
        const key = loadSignedTrustRegistryRuntime(clock,env)?.signedTrustRegistry.registry.keys.find(k=>k.keyId===keyId);
        return key && trustKeyPermitsSignature(key,{keyId,algorithm:key.algorithm,signedAt,signatureBase64:''},clock.now()) ? key.publicKeyPem : null;
      } catch { return null; }
    }},
  };
  let worker: EnvelopeWorker | undefined;
  if (config.processRole === 'worker') {
    const kms = new KMSClient({region:binding.region,maxAttempts:3});
    const trust = {issuer:binding.issuer,activeKey:(id:string)=>currentTrust(clock,env).activeKey(id),snapshot:()=>currentTrust(clock,env).snapshot(),trustedPublicKey};
    const sign = await createTrustedEnvelopeSigner({keyArn:binding.keyArn,keyId:binding.keyId,clock,trust,transport:{
      getPublicKey:input=>kms.send(new GetPublicKeyCommand(input),{abortSignal:AbortSignal.timeout(10000)}),
      sign:input=>kms.send(new SignCommand(input),{abortSignal:AbortSignal.timeout(10000)}),
    }});
    worker = {writerGeneration:binding.writerGeneration,store:createEnvelopeS3Store(storage),sourceJournal:access.sourceJournal,trustedPublicKey,sign,
      authorizeRequest:(tx,operationId,request)=>assertEnvelopeRequestAuthority(tx,access,operationId,request)};
  }
  return {access,worker,checkDatabase,assertReady};
}
