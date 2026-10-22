import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {afterAll,describe,expect,it} from 'vitest';
import {loadConfig} from '../src/config.js';
import {sha256Hex} from '../src/hash.js';
import {initializeRecipientPreservation,validateRecipientDeployment} from '../src/export/recipient-runtime.js';

const directory=mkdtempSync(path.join(os.tmpdir(),'recipient-gate-'));
afterAll(()=>rmSync(directory,{recursive:true,force:true}));
const clock={now:()=>new Date('2026-10-22T12:00:00.000Z')};
function setup(){
 const config={...loadConfig({}),objectStore:'s3' as const,awsRegion:'us-east-1',awsS3Bucket:'original-fixture',processRole:'api' as 'api'|'worker'|'combined',requireDurableReceipts:true};
 config.release={...config.release,environment:'staging',commit:'a'.repeat(40)};
 const env:NodeJS.ProcessEnv={PACKPROOF_CLAIM_EXPORTS_ENABLED:'true',PACKPROOF_RECIPIENT_S3_BUCKET:'recipient-fixture',PACKPROOF_RECIPIENT_BUCKET_OWNER:'123456789012',PACKPROOF_RECOVERY_TASK_ROLE_ARN:'arn:aws:iam::123456789012:role/worker',PACKPROOF_API_TASK_ROLE_ARN:'arn:aws:iam::123456789012:role/api',PACKPROOF_RECOVERY_WRITER_GENERATION:'synthetic-initial',PACKPROOF_RECIPIENT_COHORT:'synthetic-only',PACKPROOF_RECIPIENT_RETAIN_UNTIL:'2027-10-22T12:00:00.000Z',PACKPROOF_RECIPIENT_PROTECTION_EVIDENCE_FILE:path.join(directory,'evidence.json')};
 const evidence:Record<string,unknown>={schema:'packproof.recipient-deployment.v1',bucket:env.PACKPROOF_RECIPIENT_S3_BUCKET,account:env.PACKPROOF_RECIPIENT_BUCKET_OWNER,region:config.awsRegion,workerRoleArn:env.PACKPROOF_RECOVERY_TASK_ROLE_ARN,apiRoleArn:env.PACKPROOF_API_TASK_ROLE_ARN,environment:config.release.environment,sourceSha:config.release.commit,cohort:env.PACKPROOF_RECIPIENT_COHORT,retainUntil:env.PACKPROOF_RECIPIENT_RETAIN_UNTIL,reviewedBy:'synthetic-unit-fixture',evidenceReference:'not-cloud-acceptance',verifiedAt:clock.now().toISOString(),expiresAt:'2026-10-23T12:00:00.000Z'};
 for(const check of ['versioningVerified','complianceRetentionVerified','conditionalCreationVerified','exactVersionReadVerified','apiWritesDenied','workerDeletionDenied','retentionMutationDenied','crossBucketAccessDenied','writerFenceVerified','freshRestoreVerified'])evidence[check]=true;
 const save=()=>{const bytes=Buffer.from(JSON.stringify(evidence));writeFileSync(env.PACKPROOF_RECIPIENT_PROTECTION_EVIDENCE_FILE!,bytes);env.PACKPROOF_RECIPIENT_PROTECTION_EVIDENCE_SHA256=sha256Hex(bytes);};save();
 return {config,env,evidence,save};
}
describe('recipient deployment admission (synthetic evidence only)',()=>{
 it('stays inert when disabled and separates API readers from worker writers',()=>{
  const f=setup();expect(initializeRecipientPreservation(f.config,clock,{})).toBeUndefined();
  const api=initializeRecipientPreservation(f.config,clock,f.env)!;expect(api.writer).toBeUndefined();expect(Object.keys(api.reader)).toEqual(['read']);
  f.config.processRole='worker';expect(initializeRecipientPreservation(f.config,clock,f.env)?.writer).toBeDefined();
 });
 it('refuses missing durability, combined roles, bucket reuse and digest changes',()=>{
  const f=setup();for(const changed of [{requireDurableReceipts:false},{processRole:'combined' as const},{awsS3Bucket:f.env.PACKPROOF_RECIPIENT_S3_BUCKET}])expect(()=>validateRecipientDeployment({...f.config,...changed},clock,f.env)).toThrow();
  expect(()=>validateRecipientDeployment(f.config,clock,{...f.env,PACKPROOF_RECOVERY_TASK_ROLE_ARN:f.env.PACKPROOF_API_TASK_ROLE_ARN})).toThrow();
  expect(()=>validateRecipientDeployment(f.config,clock,{...f.env,PACKPROOF_RECIPIENT_PROTECTION_EVIDENCE_SHA256:'0'.repeat(64)})).toThrow('digest');
 });
 it('binds reviewed evidence to source, cohort, retention, time and tested protections',()=>{
  for(const [key,value] of Object.entries({sourceSha:'b'.repeat(40),cohort:'other',retainUntil:'2028-10-22T12:00:00.000Z',verifiedAt:'2026-10-23T12:00:00.000Z',expiresAt:clock.now().toISOString(),apiWritesDenied:false,freshRestoreVerified:false})){
   const f=setup();f.evidence[key]=value;f.save();expect(()=>validateRecipientDeployment(f.config,clock,f.env),key).toThrow();
  }
 });
});
