import {it,expect,afterAll,vi} from 'vitest';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Readable} from 'node:stream';
import type {S3Client} from '@aws-sdk/client-s3';
import type {STSClient} from '@aws-sdk/client-sts';
import {initializeAwsSourceDispositionRuntime} from '../src/records/source-disposition-s3.js';
import type {SourceDispositionBinding} from '../src/records/source-retention-disposition.js';
import {sha256Hex} from '../src/hash.js';
import {canonicalize} from '../src/canonical.js';
const directory=mkdtempSync(join(tmpdir(),'packproof-disposition-adapter-')),clock={now:()=>new Date('2026-11-14T03:00:00Z')},body=Buffer.from('Synthetic exact-version original'),digest=sha256Hex(body);
const binding:SourceDispositionBinding={schema:'packproof.source-disposition-binding/v1',sourceSha:'a'.repeat(40),organizationIds:['synthetic-org'],environment:'sandbox',bucket:'synthetic-source-bucket',permittedPrefix:'evidence/synthetic-org/',reviewedPolicyVersions:['synthetic-policy'],policyReviewReference:'Synthetic SDK command fixture only',qualificationReference:'Synthetic runtime wiring; no live qualification',reviewedAt:'2026-11-13T00:00:00Z',expiresAt:'2026-11-16T00:00:00Z',mode:'qualified_exact_version',aws:{accountId:'123456789012',region:'us-east-1',roleArn:'arn:aws:iam::123456789012:role/synthetic-disposition-worker',bucketVersioning:'Enabled'}};
const file=join(directory,'binding.json');writeFileSync(file,canonicalize(binding));const env={PACKPROOF_SOURCE_DISPOSITION_ENABLED:'true',PACKPROOF_SOURCE_DISPOSITION_BINDING_FILE:file,PACKPROOF_SOURCE_DISPOSITION_BINDING_SHA256:sha256Hex(canonicalize(binding)),PACKPROOF_SOURCE_DISPOSITION_PRIVILEGED_ROLE_ARN:binding.aws!.roleArn};
const target={batchId:'synthetic-batch',organizationId:'synthetic-org',environment:'sandbox' as const,key:`evidence/synthetic-org/synthetic-batch/committed/sha256-${digest}`,versionId:'synthetic-exact-version',sha256:digest,byteSize:body.length,policyVersion:'synthetic-policy'};
const sourceStore={kind:'s3',bucket:binding.bucket,region:'us-east-1'};
function clients(){let deleted=false,wrongRole=false,versioning='Enabled',region:undefined|string;const calls:{name:string;input:Record<string,unknown>}[]=[];const sts={send:vi.fn(async()=>({Account:'123456789012',Arn:`arn:aws:sts::123456789012:assumed-role/${wrongRole?'ordinary-api':'synthetic-disposition-worker'}/synthetic-session`}))};const s3={send:vi.fn(async(command:{constructor:{name:string};input:Record<string,unknown>})=>{const name=command.constructor.name;calls.push({name,input:command.input});if(name==='GetBucketVersioningCommand')return {Status:versioning};if(name==='GetBucketLocationCommand')return {LocationConstraint:region};if(name==='GetObjectCommand'){if(deleted)throw Object.assign(Error('Synthetic version absent'),{name:'NoSuchVersion',$metadata:{httpStatusCode:404}});return {VersionId:'synthetic-exact-version',ContentLength:body.length,Body:Readable.from([body])};}if(name==='DeleteObjectCommand'){deleted=true;return {};}throw Error('Unexpected synthetic SDK command');})};return {s3:s3 as unknown as S3Client,sts:sts as unknown as STSClient,calls,wrongRole:()=>{wrongRole=true;},unversioned:()=>{versioning='Suspended';},wrongRegion:()=>{region='eu-west-1';}};}
afterAll(()=>rmSync(directory,{recursive:true,force:true}));
it('does not initialize any privileged clients in the API role or while disabled',async()=>{
 const c=clients();expect(await initializeAwsSourceDispositionRuntime({clock,activeSourceSha:'a'.repeat(40),processRole:'api',sourceStore,env,...c})).toBeUndefined();expect(await initializeAwsSourceDispositionRuntime({clock,activeSourceSha:'a'.repeat(40),processRole:'worker',sourceStore,env:{},...c})).toBeUndefined();expect(c.calls).toEqual([]);
 await expect(initializeAwsSourceDispositionRuntime({clock,activeSourceSha:'a'.repeat(40),processRole:'combined',sourceStore,env,...c})).rejects.toMatchObject({code:'SOURCE_DISPOSITION_AWS_UNQUALIFIED'});expect(c.calls).toEqual([]);
});
it('performs read-only startup checks and uses only the exact owner-bound original version after approval',async()=>{
 const c=clients(),runtime=(await initializeAwsSourceDispositionRuntime({clock,activeSourceSha:'a'.repeat(40),processRole:'worker',sourceStore,env,...c}))!;
 expect(c.calls.map(call=>call.name)).toEqual(['GetBucketVersioningCommand','GetBucketLocationCommand']);
 expect(await runtime.dispose(target)).toBe('deleted_exact_version');const deletion=c.calls.find(call=>call.name==='DeleteObjectCommand');expect(deletion?.input).toEqual({Bucket:binding.bucket,Key:target.key,VersionId:target.versionId,ExpectedBucketOwner:'123456789012'});expect(await runtime.dispose(target)).toBe('already_absent');expect(c.calls.filter(call=>call.name==='DeleteObjectCommand')).toHaveLength(1);
});
it('rejects the ordinary API role, suspended versioning and a different bucket region',async()=>{
 for(const configure of [(c:ReturnType<typeof clients>)=>c.wrongRole(),(c:ReturnType<typeof clients>)=>c.unversioned(),(c:ReturnType<typeof clients>)=>c.wrongRegion()]){const c=clients();configure(c);await expect(initializeAwsSourceDispositionRuntime({clock,activeSourceSha:'a'.repeat(40),processRole:'worker',sourceStore,env,...c})).rejects.toMatchObject({code:'SOURCE_DISPOSITION_AWS_UNQUALIFIED'});expect(c.calls.some(call=>call.name==='DeleteObjectCommand')).toBe(false);}
});
it('rechecks the actual caller before each storage operation and never deletes on a role change',async()=>{
 const c=clients(),runtime=(await initializeAwsSourceDispositionRuntime({clock,activeSourceSha:'a'.repeat(40),processRole:'worker',sourceStore,env,...c}))!;c.wrongRole();await expect(runtime.dispose(target)).rejects.toMatchObject({code:'SOURCE_DISPOSITION_AWS_UNQUALIFIED'});expect(c.calls.some(call=>call.name==='DeleteObjectCommand')).toBe(false);
});
it('rejects a reviewed bucket that differs from the actual source-original store',async()=>{
 for(const actual of [{kind:'memory',bucket:binding.bucket},{kind:'s3',bucket:'different-source-bucket'},{kind:'s3',bucket:binding.bucket,region:'eu-west-1'}]){const c=clients();await expect(initializeAwsSourceDispositionRuntime({clock,activeSourceSha:'a'.repeat(40),processRole:'worker',sourceStore:actual,env,...c})).rejects.toMatchObject({code:'SOURCE_DISPOSITION_AWS_UNQUALIFIED'});expect(c.calls).toEqual([]);}
});
