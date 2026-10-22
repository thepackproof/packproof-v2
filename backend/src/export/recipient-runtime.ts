import { readFileSync } from 'node:fs';
import { sha256Hex } from '../hash.js';
import type { AppConfig } from '../config.js';
import type { Clock } from '../clock.js';
import { envelopeS3Transport } from '../integrity/envelope-s3-store.js';
import { createRecipientS3Store } from './recipient-s3-store.js';
import { RECIPIENT_PROTECTION_PROFILE, validateRecipientProtection, type RecipientPreservationRuntime } from './recipient-preservation.js';

/** Configuration admission supplements actual-role cloud acceptance; it cannot
 * establish that a supplied role ARN is the identity of the running task. */
export function validateRecipientDeployment(config:AppConfig,clock:Clock,env:NodeJS.ProcessEnv=process.env){
 const bucket=env.PACKPROOF_RECIPIENT_S3_BUCKET,account=env.PACKPROOF_RECIPIENT_BUCKET_OWNER;
 const worker=env.PACKPROOF_RECOVERY_TASK_ROLE_ARN,api=env.PACKPROOF_API_TASK_ROLE_ARN,generation=env.PACKPROOF_RECOVERY_WRITER_GENERATION;
 const file=env.PACKPROOF_RECIPIENT_PROTECTION_EVIDENCE_FILE,expected=env.PACKPROOF_RECIPIENT_PROTECTION_EVIDENCE_SHA256,cohort=env.PACKPROOF_RECIPIENT_COHORT;
 if(config.requireDurableReceipts!==true||!['api','worker'].includes(config.processRole??'')||config.objectStore!=='s3'||!config.awsRegion||
  !bucket||!account||!/^\d{12}$/.test(account)||[config.awsS3Bucket,env.PACKPROOF_COMMITTED_S3_BUCKET,env.PACKPROOF_RECOVERY_S3_BUCKET].includes(bucket)||
  !worker||!api||worker===api||![worker,api].every(role=>new RegExp(`^arn:aws:iam::${account}:role/[A-Za-z0-9_+=,.@/-]+$`).test(role))||
  !generation||!file||!expected||!cohort||!config.release.commit||!/^[a-f0-9]{40}$/.test(config.release.commit))
  throw new Error('Recipient preservation requires a separate bucket, API/worker roles, durable journal and source-bound reviewed evidence');
 const policy={profile:RECIPIENT_PROTECTION_PROFILE,bucket,retainUntil:env.PACKPROOF_RECIPIENT_RETAIN_UNTIL??''};
 validateRecipientProtection(policy,clock);
 const bytes=readFileSync(file);
 if(bytes.length>65536||sha256Hex(bytes)!==expected)throw new Error('Recipient protection evidence digest mismatch');
 const proof=JSON.parse(bytes.toString('utf8'));
 if(proof.schema!=='packproof.recipient-deployment.v1'||proof.bucket!==bucket||proof.account!==account||proof.region!==config.awsRegion||
  proof.workerRoleArn!==worker||proof.apiRoleArn!==api||proof.environment!==config.release.environment||proof.sourceSha!==config.release.commit||
  proof.cohort!==cohort||proof.retainUntil!==policy.retainUntil||!proof.reviewedBy||!proof.evidenceReference||
  !Number.isFinite(Date.parse(proof.verifiedAt))||Date.parse(proof.verifiedAt)>clock.now().getTime()||
  !Number.isFinite(Date.parse(proof.expiresAt))||Date.parse(proof.expiresAt)<=clock.now().getTime())throw new Error('Recipient evidence does not match the current deployment');
 for(const check of ['versioningVerified','complianceRetentionVerified','conditionalCreationVerified','exactVersionReadVerified',
  'apiWritesDenied','workerDeletionDenied','retentionMutationDenied','crossBucketAccessDenied','writerFenceVerified','freshRestoreVerified'])
  if(proof[check]!==true)throw new Error('Recipient deployment protection checks are incomplete');
 return {policy,account,generation,expiresAt:String(proof.expiresAt)};
}
export function initializeRecipientPreservation(config:AppConfig,clock:Clock,env:NodeJS.ProcessEnv=process.env):RecipientPreservationRuntime|undefined{
 if(env.PACKPROOF_CLAIM_EXPORTS_ENABLED!=='true')return undefined;
 const admitted=validateRecipientDeployment(config,clock,env);
 const store=createRecipientS3Store({bucket:admitted.policy.bucket,expectedBucketOwner:admitted.account,clock,transport:envelopeS3Transport(config.awsRegion!)});
 // Do not expose write methods through API dependencies.
 return {assertReady:()=>{validateRecipientDeployment(config,clock,env);},policy:admitted.policy,writerGeneration:admitted.generation,reader:{read:store.read},...(config.processRole==='worker'?{writer:store}:{})};
}
