import {S3Client,GetObjectCommand,DeleteObjectCommand,GetBucketVersioningCommand,GetBucketLocationCommand} from '@aws-sdk/client-s3';
import {STSClient,GetCallerIdentityCommand} from '@aws-sdk/client-sts';
import {Readable} from 'node:stream';
import type {Clock} from '../clock.js';
import {DomainError} from '../domain/errors.js';
import {sha256Hex} from '../hash.js';
import {readPinnedReconstructionQualification} from './reconstruction-qualification.js';
import {initializeSourceDispositionRuntime,type SourceDispositionBinding,type ExactVersionDispositionTransport} from './source-retention-disposition.js';

const denied=(message:string):never=>{throw new DomainError('SOURCE_DISPOSITION_AWS_UNQUALIFIED',message,503);};
/** A dedicated worker role is required; no erase method is added to the API's
 * ObjectStore. Initialization performs read-only identity/bucket checks. There
 * is no delete until an approved job reaches its exact-version execution gate. */
export async function initializeAwsSourceDispositionRuntime(input:{clock:Clock;activeSourceSha:string;processRole:string;sourceStore:{kind:string;bucket?:string;region?:string};env?:NodeJS.ProcessEnv;s3?:S3Client;sts?:STSClient}){
 const env=input.env??process.env;if(env.PACKPROOF_SOURCE_DISPOSITION_ENABLED!=='true'||input.processRole==='api')return undefined;
 if(input.processRole!=='worker')denied('Privileged source disposition requires a dedicated worker process; a combined API process cannot receive erase authority');
 const binding=readPinnedReconstructionQualification<SourceDispositionBinding>(env,'PACKPROOF_SOURCE_DISPOSITION_BINDING'),aws=binding.aws;
 if(input.sourceStore.kind!=='s3'||!input.sourceStore.bucket||input.sourceStore.bucket!==binding.bucket||(input.sourceStore.region!==undefined&&input.sourceStore.region!==aws?.region))denied('Disposition must use the actual configured source-original S3 bucket and region');
 if(binding.mode!=='qualified_exact_version'||!aws||!/^\d{12}$/.test(aws.accountId)||!/^[-a-z0-9]+-\d$/.test(aws.region)||!new RegExp(`^arn:aws:iam::${aws.accountId}:role/[A-Za-z0-9_+=,.@/-]+$`).test(aws.roleArn)||env.PACKPROOF_SOURCE_DISPOSITION_PRIVILEGED_ROLE_ARN!==aws.roleArn||aws.bucketVersioning!=='Enabled'||!binding.bucket||binding.bucket.includes('/')||binding.bucket.length>63)denied('A separately reviewed exact worker role, account, region and versioned bucket binding is required');
 const authority=aws!,s3=input.s3??new S3Client({region:authority.region,maxAttempts:2}),sts=input.sts??new STSClient({region:authority.region,maxAttempts:2});
 async function verifyIdentity(){const identity=await sts.send(new GetCallerIdentityCommand({}),{abortSignal:AbortSignal.timeout(15000)});const roleName=authority.roleArn.split('/').at(-1)!;if(identity.Account!==authority.accountId||!identity.Arn?.startsWith(`arn:aws:sts::${authority.accountId}:assumed-role/${roleName}/`))denied('The current AWS caller is not the reviewed privileged disposition worker role');}
 await verifyIdentity();
 const versioning=await s3.send(new GetBucketVersioningCommand({Bucket:binding.bucket,ExpectedBucketOwner:authority.accountId}),{abortSignal:AbortSignal.timeout(15000)});if(versioning.Status!=='Enabled')denied('The reviewed source bucket must retain enabled exact object versioning');
 const location=await s3.send(new GetBucketLocationCommand({Bucket:binding.bucket,ExpectedBucketOwner:authority.accountId}),{abortSignal:AbortSignal.timeout(15000)});const actualRegion=location.LocationConstraint==='EU'?'eu-west-1':location.LocationConstraint||'us-east-1';if(actualRegion!==authority.region)denied('The actual source bucket region differs from its reviewed qualification');
 const transport:ExactVersionDispositionTransport={
  async headExact(target){
   await verifyIdentity();
   try{
    const result=await s3.send(new GetObjectCommand({Bucket:target.bucket,Key:target.key,VersionId:target.versionId,ExpectedBucketOwner:authority.accountId}),{abortSignal:AbortSignal.timeout(15000)});
    const body=result.Body instanceof Readable?result.Body:denied('The exact original requires a bounded server stream');
    if(!result.ContentLength||result.ContentLength>2097152||result.VersionId!==target.versionId){body.destroy();denied('The reviewed original version returned an invalid identity or bounded size');}
    const chunks:Buffer[]=[];let bytes=0;try{for await(const chunk of body){bytes+=chunk.length;if(bytes>2097152)denied('The exact original exceeded the bounded disposition read');chunks.push(Buffer.from(chunk));}}finally{body.destroy();}
    return {versionId:result.VersionId!,sha256:sha256Hex(Buffer.concat(chunks)),byteSize:bytes};
   }catch(error){const e=error as {name?:string;$metadata?:{httpStatusCode?:number}};if(['NoSuchKey','NoSuchVersion','NotFound'].includes(e.name??'')&&e.$metadata?.httpStatusCode===404)return null;throw error;}
  },
  async deleteExact(target){
   await verifyIdentity();
   // A specific immutable VersionId is mandatory. There is no governance bypass,
   // bulk delete, prefix listing, delete-marker operation or backup erasure.
   if(!target.versionId||target.versionId==='null'||target.bucket!==binding.bucket)denied('An exact original version in the qualified bucket is required');
   await s3.send(new DeleteObjectCommand({Bucket:binding.bucket,Key:target.key,VersionId:target.versionId,ExpectedBucketOwner:authority.accountId}),{abortSignal:AbortSignal.timeout(15000)});
  },
 };
 return initializeSourceDispositionRuntime({...input,transport,env});
}
