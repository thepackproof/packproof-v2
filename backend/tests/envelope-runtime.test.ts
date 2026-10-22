import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { beforeEach, afterEach, describe, expect, it } from 'vitest';
import type { AppConfig } from '../src/config.js';
import type { Database } from '../src/db/database.js';
import { sha256 } from '../src/integrity/envelope-profile.js';
import { initializeEnvelopeRuntime, validateEnvelopeDeployment } from '../src/integrity/envelope-runtime.js';

const now=new Date('2026-10-22T05:00:00.000Z'),clock={now:()=>new Date(now)};
const source='a'.repeat(40),account='123456789012';
const config={processRole:'api',migrateOnStart:false,requireDurableReceipts:true,objectStore:'s3',awsRegion:'us-east-1',awsS3Bucket:'original-fixture',release:{commit:source,environment:'production'}} as AppConfig;
const binding={artifactBucket:'envelope-fixture',evidenceBucket:'original-fixture',journalBucket:'journal-fixture',account,region:'us-east-1',
  keyArn:`arn:aws:kms:us-east-1:${account}:key/11111111-2222-3333-4444-555555555555`,keyId:'envelope-key',issuer:'https://envelopes.example.test',
  apiRole:`arn:aws:iam::${account}:role/api-fixture`,workerRole:`arn:aws:iam::${account}:role/worker-fixture`,
  apiDatabaseRole:'test_api',workerDatabaseRole:'test_worker',
  sourceSha:source,environment:'production',organizationEnvironment:'live',merchantIds:['org_fixture'],cutoverAt:now.toISOString(),retainUntil:'2027-10-22T05:00:00.000Z',writerGeneration:'generation-fixture'};
const positive={schema:'packproof.envelope-deployment.v1',binding,reviewedBy:'synthetic-test',evidenceReference:'synthetic-test-only',verifiedAt:now.toISOString(),expiresAt:'2026-10-23T05:00:00.000Z',
  versioningVerified:true,complianceRetentionVerified:true,originalProtectionVerified:true,conditionalCreationVerified:true,exactVersionReadVerified:true,apiWritesDenied:true,apiSigningDenied:true,
  workerDeletionDenied:true,retentionMutationDenied:true,crossBucketAccessDenied:true,writerFenceVerified:true,freshRestoreVerified:true,databaseRolesVerified:true,authenticatedHttpVerified:true};
let directory:string,env:NodeJS.ProcessEnv;
async function evidence(value:unknown){const bytes=Buffer.from(JSON.stringify(value));await writeFile(env.PACKPROOF_ENVELOPE_PROTECTION_EVIDENCE_FILE!,bytes);env.PACKPROOF_ENVELOPE_PROTECTION_EVIDENCE_SHA256=sha256(bytes);}
beforeEach(async()=>{
  directory=await mkdtemp(path.join(os.tmpdir(),'packproof-envelope-policy-'));
  env={PACKPROOF_ENVELOPES_ENABLED:'true',PACKPROOF_ORGANIZATIONS_ENABLED:'true',PACKPROOF_ENVELOPE_TRUST_PUBLICATION_ENABLED:'true',
    PACKPROOF_ENVELOPE_S3_BUCKET:binding.artifactBucket,PACKPROOF_RECOVERY_S3_BUCKET:binding.journalBucket,PACKPROOF_ENVELOPE_BUCKET_OWNER:account,
    PACKPROOF_ENVELOPE_KMS_KEY_ARN:binding.keyArn,PACKPROOF_ENVELOPE_KEY_ID:binding.keyId,PACKPROOF_ENVELOPE_ISSUER:binding.issuer,
    PACKPROOF_API_TASK_ROLE_ARN:binding.apiRole,PACKPROOF_RECOVERY_TASK_ROLE_ARN:binding.workerRole,PACKPROOF_M2_API_DATABASE_ROLE:binding.apiDatabaseRole,PACKPROOF_M2_WORKER_DATABASE_ROLE:binding.workerDatabaseRole,
    PACKPROOF_ENVELOPE_ORGANIZATION_ENVIRONMENT:'live',PACKPROOF_ENVELOPE_MERCHANT_IDS:JSON.stringify(binding.merchantIds),PACKPROOF_ENVELOPE_CUTOVER_AT:binding.cutoverAt,
    PACKPROOF_ENVELOPE_RETAIN_UNTIL:binding.retainUntil,PACKPROOF_RECOVERY_WRITER_GENERATION:binding.writerGeneration,PACKPROOF_ENVELOPE_PROTECTION_EVIDENCE_FILE:path.join(directory,'evidence.json')};
  await evidence(positive);
});
afterEach(async()=>{await rm(directory,{recursive:true,force:true});});

describe('envelope deployment admission',()=>{
  it('has no database or cloud effects when disabled and rejects a misspelled flag',async()=>{
    const db={query:async()=>{throw Error('Unexpected database call');},transaction:async()=>{throw Error('Unexpected database call');}} as Database;
    expect(await initializeEnvelopeRuntime(config,clock,db,{})).toBeUndefined();
    await expect(initializeEnvelopeRuntime(config,clock,db,{PACKPROOF_ENVELOPES_ENABLED:'yes'})).rejects.toThrow('FLAG_INVALID');
  });
  it('binds deployment environment separately from the merchant namespace',()=>{
    expect(validateEnvelopeDeployment(config,clock,env)).toEqual(binding);
    expect(()=>validateEnvelopeDeployment(config,clock,{...env,PACKPROOF_ENVELOPE_ORGANIZATION_ENVIRONMENT:'production'})).toThrow('UNVERIFIED');
    expect(()=>validateEnvelopeDeployment(config,clock,{...env,PACKPROOF_ENVELOPE_ORGANIZATION_ENVIRONMENT:'sandbox'})).toThrow('UNVERIFIED');
  });
  it.each([
    ['combined process',{processRole:'combined'},{}],['startup DDL',{migrateOnStart:true},{}],['unprotected receipts',{requireDurableReceipts:false},{}],
    ['changed application',{release:{commit:'b'.repeat(40),environment:'production'}},{}],
    ['shared bucket',{}, {PACKPROOF_ENVELOPE_S3_BUCKET:'original-fixture'}],['shared signing key',{}, {PACKPROOF_RECOVERY_KMS_KEY_ARN:binding.keyArn}],
    ['shared IAM role',{}, {PACKPROOF_RECOVERY_TASK_ROLE_ARN:binding.apiRole}],['shared database role',{}, {PACKPROOF_M2_WORKER_DATABASE_ROLE:binding.apiDatabaseRole}],
    ['empty cohort',{}, {PACKPROOF_ENVELOPE_MERCHANT_IDS:'[]'}],['implicit backfill',{}, {PACKPROOF_ENVELOPE_CUTOVER_AT:''}],
    ['missing public trust',{}, {PACKPROOF_ENVELOPE_TRUST_PUBLICATION_ENABLED:'false'}],['inactive organizations',{}, {PACKPROOF_ORGANIZATIONS_ENABLED:'false'}],
  ])('refuses %s',(name,configChange,envChange)=>{
    expect(()=>validateEnvelopeDeployment({...config,...configChange} as AppConfig,clock,{...env,...envChange})).toThrow('UNVERIFIED');
  });
  it('refuses altered evidence, expired review and unproven authorization or recovery',async()=>{
    await writeFile(env.PACKPROOF_ENVELOPE_PROTECTION_EVIDENCE_FILE!,'{}');expect(()=>validateEnvelopeDeployment(config,clock,env)).toThrow('UNVERIFIED');
    for(const change of [{expiresAt:now.toISOString()},{authenticatedHttpVerified:false},{writerFenceVerified:false},{freshRestoreVerified:false},{apiSigningDenied:false},{originalProtectionVerified:false}]){
      await evidence({...positive,...change});expect(()=>validateEnvelopeDeployment(config,clock,env)).toThrow('UNVERIFIED');
    }
  });
});
