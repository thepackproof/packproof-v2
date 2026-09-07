import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import type { AppConfig } from '../config.js';
import type { Clock } from '../clock.js';
import type { RecoveryPublisher } from '../domain/recovery-journal.js';
import { AwsS3ObjectStore } from '../s3/aws-s3-object-store.js';
import { initializeManifestSigningRuntime } from '../integrity/kms-signing-runtime.js';
import { createRecoveryPublisher } from './runtime-jobs.js';

/** This is a deployment gate, not an automatic claim that configured IAM is correct.
 * A reviewed, SHA-pinned evidence file must describe the independently tested boundary.
 * Workers run under a dedicated task role; API tasks must not receive recovery signing rights.
 */
export function validateRecoveryDeployment(config:AppConfig,env:NodeJS.ProcessEnv=process.env):void {
  const bucket=env.PACKPROOF_RECOVERY_S3_BUCKET,key=env.PACKPROOF_RECOVERY_KMS_KEY_ARN;
  const workerRole=env.PACKPROOF_RECOVERY_TASK_ROLE_ARN,apiRole=env.PACKPROOF_API_TASK_ROLE_ARN;
  const file=env.PACKPROOF_RECOVERY_PROTECTION_EVIDENCE_FILE,expected=env.PACKPROOF_RECOVERY_PROTECTION_EVIDENCE_SHA256;
  if(!bucket||bucket===config.awsS3Bucket||bucket===env.PACKPROOF_COMMITTED_S3_BUCKET||!key||key===env.PACKPROOF_MANIFEST_KMS_KEY_ARN||!workerRole||workerRole===apiRole||!apiRole||!file||!expected||!env.PACKPROOF_RECOVERY_WRITER_GENERATION)
    throw new Error('Recovery requires separate journal bucket, signing key, worker role and reviewed protection evidence');
  let bytes:Buffer;try{bytes=readFileSync(file);}catch{throw new Error('Recovery protection evidence is unavailable');}
  if(bytes.length>65536||createHash('sha256').update(bytes).digest('hex')!==expected)throw new Error('Recovery protection evidence digest mismatch');
  let proof:Record<string,unknown>;try{proof=JSON.parse(bytes.toString('utf8'));}catch{throw new Error('Recovery protection evidence is invalid');}
  if(proof.schema!=='packproof.recovery-protection.v1'||proof.bucket!==bucket||proof.signingKeyArn!==key||proof.workerRoleArn!==workerRole||proof.apiRoleArn!==apiRole||proof.environment!==config.release.environment||!proof.reviewedBy||!proof.evidenceReference||!Number.isFinite(Date.parse(String(proof.verifiedAt)))||!Number.isFinite(Date.parse(String(proof.expiresAt)))||Date.parse(String(proof.expiresAt))<=Date.now())throw new Error('Recovery protection evidence does not match this deployment or is stale');
  for(const check of ['versioningVerified','objectLockVerified','conditionalCreationVerified','apiJournalWritesDenied','apiRecoverySigningDenied','workerDeletionDenied','kmsDeletionRestricted','restoreWriterFenceVerified'])if(proof[check]!==true)throw new Error('Recovery deployment protection checks are incomplete');
}
export async function initializeRecoveryPublisher(config:AppConfig,clock:Clock,env:NodeJS.ProcessEnv=process.env):Promise<RecoveryPublisher|undefined>{
  if(env.PACKPROOF_RECOVERY_WORKER!=='true'&&config.requireDurableReceipts!==true)return undefined;
  validateRecoveryDeployment(config,env);
  if(config.processRole==='combined')throw new Error('Protected recovery requires separate API and worker process roles');
  if(config.processRole!=='worker')return undefined;
  const bucket=env.PACKPROOF_RECOVERY_S3_BUCKET!;
  const store=new AwsS3ObjectStore(bucket,{region:config.awsRegion!,immutableRecoveryJournal:true});
  const signing=await initializeManifestSigningRuntime(clock,{...env,
    PACKPROOF_MANIFEST_SIGNING_MODE:'kms',PACKPROOF_MANIFEST_SIGNING_REQUIRED:'true',
    PACKPROOF_MANIFEST_KMS_KEY_ARN:env.PACKPROOF_RECOVERY_KMS_KEY_ARN,
    PACKPROOF_MANIFEST_SIGNING_KEY_ID:env.PACKPROOF_RECOVERY_SIGNING_KEY_ID??env.PACKPROOF_RECOVERY_KMS_KEY_ARN,
    PACKPROOF_MANIFEST_SIGNING_ALGORITHM:env.PACKPROOF_RECOVERY_SIGNING_ALGORITHM??'ECDSA_SHA_256',
    PACKPROOF_MANIFEST_TRUST_HISTORY_JSON:env.PACKPROOF_RECOVERY_TRUST_HISTORY_JSON,
  });
  return createRecoveryPublisher(config,store,signing,clock,env);
}
