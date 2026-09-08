import { assertCommitExpectations, type CommitExpectations } from "./commit-expectations.js";
import { CopyObjectCommand, DeleteObjectCommand, GetObjectCommand, HeadObjectCommand, ListObjectVersionsCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { Readable } from "node:stream";
import { DomainError } from "../domain/errors.js";
import { sha256Hex, sha256HexFromStream } from "../hash.js";
import { assertSafeObjectKey, committedEvidenceObjectKey } from "./object-key.js";
import type { CommittedObject, ObjectDigest, ObjectMetadata, ObjectReference, ObjectStore, ObjectStream, StoredObject, UploadTarget } from "./object-store.js";

export interface AwsS3ObjectStoreOptions {
  region: string;
  expiresInSeconds?: number;
  client?: S3Client;
  gatewayBaseUrl?: string;
  /** Set only after an independently verified Object Lock / IAM deployment check. */
  immutableRecoveryJournal?: boolean;
  committedBucket?: string;
  signPutUrl?: (input: {key:string;contentType:string;expiresInSeconds:number}) => Promise<string>;
}

export class AwsS3ObjectStore implements ObjectStore {
  private readonly client: S3Client;
  readonly boundedUploadGateway = true;
  readonly gatewayBaseUrl: string;
  readonly immutableRecoveryJournal: boolean;
  private readonly committedBucket: string;
  constructor(private readonly bucket: string, options: AwsS3ObjectStoreOptions) {
    this.client = options.client ?? new S3Client({ region: options.region, requestChecksumCalculation: "WHEN_REQUIRED" });
    this.gatewayBaseUrl = options.gatewayBaseUrl ?? "";
    this.immutableRecoveryJournal = options.immutableRecoveryJournal === true;
    this.committedBucket = options.committedBucket ?? bucket;
  }
  private bucketFor(key: string): string { return key.includes("/committed/") || key.startsWith("recovery/") ? this.committedBucket : this.bucket; }
  async put(key: string, body: Buffer, contentType: string): Promise<void> {
    const objectKey = assertSafeObjectKey(key);
    await this.client.send(new PutObjectCommand({ Bucket: this.bucketFor(objectKey), Key: objectKey, Body: body, ContentType: contentType,
      ...(objectKey.includes("/committed/") || objectKey.startsWith("recovery/") ? {IfNoneMatch:"*"} : {}) }));
  }
  async putIfAbsent(key: string, body: Buffer, contentType: string): Promise<{created:boolean}> {
    const objectKey=assertSafeObjectKey(key);
    try { await this.client.send(new PutObjectCommand({Bucket:this.bucketFor(objectKey),Key:objectKey,Body:body,ContentType:contentType,IfNoneMatch:"*"})); return {created:true}; }
    catch(error) { if(isS3PreconditionFailure(error)) return {created:false}; throw error; }
  }
  async putStream(key: string, body: AsyncIterable<Uint8Array>, contentType: string, byteSize: number): Promise<{versionId?:string}> {
    const objectKey=assertSafeObjectKey(key);
    if(objectKey.includes("/committed/")||objectKey.startsWith("recovery/")) throw new DomainError("STAGING_KEY_REQUIRED","Uploads can write only staging objects",403);
    const stream=Readable.from(boundedExactStream(body,byteSize));
    try {
      const result=await this.client.send(new PutObjectCommand({Bucket:this.bucket,Key:objectKey,Body:stream,ContentLength:byteSize,ContentType:contentType}));
      return {versionId:result.VersionId};
    } finally { stream.destroy(); }
  }
  async head(key: string, reference: ObjectReference={}): Promise<ObjectMetadata|null> {
    const objectKey=assertSafeObjectKey(key);
    try { const result=await this.client.send(new HeadObjectCommand({Bucket:this.bucketFor(objectKey),Key:objectKey,VersionId:reference.versionId??undefined}));
      return {byteSize:result.ContentLength??0,contentType:result.ContentType??"application/octet-stream",versionId:result.VersionId};
    } catch(error) {if(isMissingS3Object(error))return null;throw error;}
  }
  async getStream(key: string, input: ObjectReference & {start?:number;end?:number}={}): Promise<ObjectStream|null> {
    const objectKey=assertSafeObjectKey(key);
    try {
      const result=await this.client.send(new GetObjectCommand({Bucket:this.bucketFor(objectKey),Key:objectKey,VersionId:input.versionId??undefined,
        ...(input.start!==undefined?{Range:`bytes=${input.start}-${input.end??""}`}:{})}));
      if(!result.Body)return null;
      return {body:result.Body instanceof Readable?result.Body:Readable.from(result.Body as AsyncIterable<Uint8Array>),byteSize:result.ContentLength??0,contentType:result.ContentType??"application/octet-stream",versionId:result.VersionId};
    } catch(error) {if(isMissingS3Object(error))return null;throw error;}
  }
  async get(key: string, reference: ObjectReference={}): Promise<StoredObject|null> {
    const objectKey=assertSafeObjectKey(key);
    try { const result=await this.client.send(new GetObjectCommand({Bucket:this.bucketFor(objectKey),Key:objectKey,VersionId:reference.versionId??undefined}));
      const bytes=await result.Body?.transformToByteArray();if(!bytes)return null;
      const body=Buffer.from(bytes);assertCommittedDigestValue(objectKey,sha256Hex(body));
      return {body,contentType:result.ContentType??"application/octet-stream"};
    } catch(error) {if(isMissingS3Object(error))return null;throw error;}
  }
  async digest(key: string, reference: ObjectReference={}): Promise<ObjectDigest|null> {
    const meta=await this.head(key,reference);if(!meta)return null;
    const data=await this.getStream(key,{versionId:reference.versionId??meta.versionId});if(!data)return null;
    const hashed=await sha256HexFromStream(data.body);
    if(hashed.byteSize!==meta.byteSize)throw new DomainError("EVIDENCE_OBJECT_INCOMPLETE","Object size does not match its stored metadata",409);
    assertCommittedDigestValue(key,hashed.sha256);return {...hashed,contentType:meta.contentType,versionId:meta.versionId};
  }
  async commitUpload(key: string, expected:CommitExpectations={}): Promise<CommittedObject|null> {
    const sourceKey=assertSafeObjectKey(key),candidate=await this.head(sourceKey);if(!candidate)return null;
    // An ETag is neither a full-file digest nor an immutable version identity.
    if(!candidate.versionId||candidate.versionId==="null")throw new DomainError("EVIDENCE_VERSIONING_REQUIRED","Evidence storage versioning is required before preservation",503);
    const digest=await this.digest(sourceKey,{versionId:candidate.versionId});if(!digest)return null;
    assertCommitExpectations(digest,expected);
    const committedKey=committedEvidenceObjectKey(sourceKey,digest.sha256);
    // A lost database/HTTP response must not create another retained version on
    // every retry. Reconcile the deterministic preserved candidate first.
    const preserved=await this.head(committedKey);
    if(preserved){
      if(!preserved.versionId||preserved.versionId==='null')throw new DomainError('EVIDENCE_VERSIONING_REQUIRED','Preserved storage must expose its exact version',503);
      const verified=await this.digest(committedKey,{versionId:preserved.versionId});
      if(!verified||verified.sha256!==digest.sha256||verified.byteSize!==digest.byteSize)throw new DomainError('EVIDENCE_OBJECT_INTEGRITY_FAILURE','Existing preserved candidate failed verification',500);
      return {...verified,key:committedKey,versionId:preserved.versionId,stagingVersionId:candidate.versionId};
    }
    const result=await this.client.send(new CopyObjectCommand({Bucket:this.committedBucket,Key:committedKey,
      CopySource:`${this.bucket}/${sourceKey.split("/").map(encodeURIComponent).join("/")}?versionId=${encodeURIComponent(candidate.versionId)}`,MetadataDirective:"COPY"}));
    if(!result.VersionId||result.VersionId==="null")throw new DomainError("EVIDENCE_VERSIONING_REQUIRED","Committed storage must supply an immutable version identity",503);
    return {...digest,key:committedKey,versionId:result.VersionId,stagingVersionId:candidate.versionId};
  }
  async deleteStaging(key:string,reference:ObjectReference={}):Promise<void> {
    const safe=assertSafeObjectKey(key);
    if(!/^evidence\/[^/]+\/[^/]+\/object(?:\.parts\/[^/]+)?$/.test(safe))throw new DomainError("STAGING_KEY_REQUIRED","Cleanup cannot delete preserved records",403);
    // Interrupted responses can leave a version the database never received.
    // Enumerate only the exact expired staging key; never a parent/Proof prefix.
    const versions=await this.client.send(new ListObjectVersionsCommand({Bucket:this.bucket,Prefix:safe,MaxKeys:1000}));
    const exact=[...(versions.Versions??[]),...(versions.DeleteMarkers??[])].filter(item=>item.Key===safe&&item.VersionId);
    for(const item of exact)await this.client.send(new DeleteObjectCommand({Bucket:this.bucket,Key:safe,VersionId:item.VersionId}));
    if(versions.IsTruncated)throw new DomainError('STAGING_CLEANUP_PENDING','Additional staging versions require another bounded cleanup pass',503);
    if(!exact.length)await this.client.send(new DeleteObjectCommand({Bucket:this.bucket,Key:safe,VersionId:reference.versionId??undefined}));
  }
  async createUploadTarget():Promise<UploadTarget> {throw new DomainError("UPLOAD_ADMISSION_REQUIRED","Create an evidence upload reservation before sending bytes",409);}
  async putUpload():Promise<{key:string}> {throw new DomainError("UPLOAD_ADMISSION_REQUIRED","Direct storage upload credentials are disabled",403);}
}
export async function* boundedExactStream(body:AsyncIterable<Uint8Array>,expectedBytes:number):AsyncGenerator<Uint8Array> {
  let total=0;for await(const chunk of body){total+=chunk.byteLength;if(total>expectedBytes)throw new DomainError("UPLOAD_TOO_LARGE","Upload exceeds its reserved byte limit",413);yield chunk;}
  if(total!==expectedBytes)throw new DomainError("UPLOAD_INCOMPLETE","Upload ended before its declared byte length",409);
}
export function isMissingS3Object(error:unknown):boolean { const e=error as {name?:string;$metadata?:{httpStatusCode?:number}};return !!e&&(e.name==="NotFound"||e.name==="NoSuchKey"||e.name==="NoSuchVersion"||e.name==="NotFoundException"||e.$metadata?.httpStatusCode===404); }
function isS3PreconditionFailure(error:unknown):boolean {const e=error as {name?:string;$metadata?:{httpStatusCode?:number}};return !!e&&(e.name==="PreconditionFailed"||e.$metadata?.httpStatusCode===412);}
function assertCommittedDigestValue(key:string,actual:string):void {const digest=/\/committed\/sha256-([a-f0-9]{64})$/.exec(key)?.[1];if(digest&&digest!==actual)throw new DomainError("EVIDENCE_OBJECT_INTEGRITY_FAILURE","Committed bytes do not match their SHA-256 key",500);}
