import { assertCommitExpectations, type CommitExpectations } from "./commit-expectations.js";
import { randomUUID } from "node:crypto";
import { createWriteStream, constants as fsConstants } from "node:fs";
import { mkdir, readFile, writeFile, open, rename, rm, link, stat, copyFile } from "node:fs/promises";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";
import path from "node:path";
import { DomainError } from "../domain/errors.js";
import { sha256Hex, sha256HexFromStream } from "../hash.js";
import { assertSafeObjectKey, committedEvidenceObjectKey } from "./object-key.js";
import { boundedExactStream } from "./aws-s3-object-store.js";
import type {CommittedObject,ObjectDigest,ObjectMetadata,ObjectReference,ObjectStore,ObjectStream,StoredObject,UploadTarget} from "./object-store.js";

export class LocalObjectStore implements ObjectStore {
  readonly boundedUploadGateway=true;
  readonly immutableRecoveryJournal=false;
  readonly gatewayBaseUrl:string;
  constructor(private readonly directory:string,publicBaseUrl:string,_secret:string){this.gatewayBaseUrl=publicBaseUrl;}
  async put(key:string,body:Buffer,contentType:string):Promise<void>{
    if(key.includes('/committed/')||key.startsWith('recovery/')){
      const result=await this.putIfAbsent(key,body,contentType);
      if(!result.created){const existing=await this.get(key);if(!existing||sha256Hex(existing.body)!==sha256Hex(body)||existing.contentType!==contentType)throw new DomainError('OBJECT_ALREADY_PRESERVED','Preserved objects cannot be replaced',409);}
      return;
    }
    await this.putStream(key,Readable.from([body]),contentType,body.length);
  }
  async putIfAbsent(key:string,body:Buffer,contentType:string):Promise<{created:boolean}>{
    const file=this.filePath(key);await mkdir(path.dirname(file),{recursive:true});
    // Publish a completed temporary inode atomically: readers never see a partial journal.
    const temporary=`${file}.${randomUUID()}.tmp`;
    try{
      await writeFile(temporary,body,{mode:0o600,flag:'wx'});
      try{await this.publishNewFile(temporary,file);}
      catch(error){
        if((error as NodeJS.ErrnoException).code!=='EEXIST')throw error;
        // A process may stop between publishing the body and its sidecar. A
        // byte-identical retry can finish that publication without replacing it.
        if((await readFile(file)).equals(body)){await this.publishStagingVersion(file,key,sha256Hex(body),contentType,body.length);await this.publishMetadata(file,contentType,true);}
        return {created:false};
      }
      await this.publishStagingVersion(file,key,sha256Hex(body),contentType,body.length);await this.publishMetadata(file,contentType,true);return {created:true};
    }
    finally{await rm(temporary,{force:true});}
  }
  async putStream(key:string,body:AsyncIterable<Uint8Array>,contentType:string,byteSize:number):Promise<{versionId:string}>{
    if(key.includes('/committed/')||key.startsWith('recovery/'))throw new DomainError('STAGING_KEY_REQUIRED','Uploads can write only staging objects',403);
    const file=this.filePath(key);await mkdir(path.dirname(file),{recursive:true});const temporary=`${file}.${randomUUID()}.tmp`;
    try{
      await pipeline(Readable.from(boundedExactStream(body,byteSize)),createWriteStream(temporary,{mode:0o600,flags:'wx'}));
      const digest=await sha256HexFromStream((await open(temporary,'r')).createReadStream()),versionId=this.stagingVersionId(digest.sha256,contentType);
      const exact=this.stagingVersionPath(key,versionId);await mkdir(path.dirname(exact),{recursive:true});
      try{await this.publishNewFile(temporary,exact);}catch(error){if((error as NodeJS.ErrnoException).code!=='EEXIST')throw error;}
      await this.verifyFile(exact,digest.sha256,byteSize);
      await this.publishMetadata(exact,contentType,true);
      await rename(temporary,file);await this.publishMetadata(file,contentType,false);return {versionId};
    }
    finally{await rm(temporary,{force:true});}
  }
  async head(key:string,reference:ObjectReference={}):Promise<ObjectMetadata|null>{
    if(reference.versionId&&!key.includes('/committed/')&&!reference.versionId.startsWith('local-staging-v1:'))throw new DomainError('EVIDENCE_VERSION_MISMATCH','Unknown exact staging version',409);
    try{const file=reference.versionId?.startsWith('local-staging-v1:')?this.stagingVersionPath(key,reference.versionId):this.filePath(key);const info=await stat(file),meta=JSON.parse(await readFile(`${file}.meta.json`,'utf8')) as {contentType:string};
      const versionId=key.includes('/committed/')?`local-sha256:${key.split('sha256-').at(-1)}`:key.startsWith('recovery/')?null:reference.versionId??this.stagingVersionId((await sha256HexFromStream((await open(file,'r')).createReadStream())).sha256,meta.contentType);
      if(reference.versionId&&reference.versionId!==versionId)throw new DomainError('EVIDENCE_VERSION_MISMATCH','Exact object version unavailable',409);
      return {byteSize:info.size,contentType:meta.contentType,versionId};}
    catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return null;throw error;}
  }
  async getStream(key:string,input:ObjectReference&{start?:number;end?:number}={}):Promise<ObjectStream|null>{
    const metadata=await this.head(key,input);if(!metadata)return null;
    if(input.versionId&&metadata.versionId!==input.versionId)throw new DomainError('EVIDENCE_VERSION_MISMATCH','Exact preserved object version is unavailable',409);
    const handle=await open(metadata.versionId?.startsWith('local-staging-v1:')?this.stagingVersionPath(key,metadata.versionId):this.filePath(key),'r');
    const info=await handle.stat();
    return {...metadata,byteSize:input.start===undefined?info.size:(input.end??info.size-1)-input.start+1,body:handle.createReadStream({start:input.start,end:input.end,autoClose:true,highWaterMark:64*1024})};
  }
  async get(key:string,reference:ObjectReference={}):Promise<StoredObject|null>{
    const data=await this.getStream(key,reference);if(!data)return null;const parts:Buffer[]=[];for await(const part of data.body)parts.push(Buffer.from(part));return {body:Buffer.concat(parts),contentType:data.contentType};
  }
  async digest(key:string,reference:ObjectReference={}):Promise<ObjectDigest|null>{const data=await this.getStream(key,reference);if(!data)return null;return {...await sha256HexFromStream(data.body),contentType:data.contentType,versionId:data.versionId};}
  async commitUpload(key:string,expected:CommitExpectations={}):Promise<CommittedObject|null>{
    const source=await this.getStream(key,{versionId:expected.expectedVersionId});if(!source)return null;
    const temporary=`${this.filePath(key)}.${randomUUID()}.preserve`;
    const {createHash}=await import('node:crypto');const hash=createHash('sha256');let byteSize=0;
    async function* snapshot(){for await(const chunk of source!.body){const bytes=Buffer.from(chunk);hash.update(bytes);byteSize+=bytes.length;yield bytes;}}
    try{
      await pipeline(Readable.from(snapshot()),createWriteStream(temporary,{mode:0o600,flags:'wx'}));
      const sha256=hash.digest('hex');
      assertCommitExpectations({sha256,byteSize,contentType:source.contentType},expected);
      const committedKey=committedEvidenceObjectKey(key,sha256),target=this.filePath(committedKey);await mkdir(path.dirname(target),{recursive:true});
      try{await this.publishNewFile(temporary,target);}catch(error){if((error as NodeJS.ErrnoException).code!=='EEXIST')throw error;}
      await this.verifyFile(target,sha256,byteSize);
      await this.publishMetadata(target,source.contentType,true);
      return {key:committedKey,sha256,byteSize,contentType:source.contentType,versionId:`local-sha256:${sha256}`,stagingVersionId:source.versionId};
    }finally{source.body.destroy();await rm(temporary,{force:true});}
  }
  async deleteStaging(key:string):Promise<void>{
    if(!/^evidence\/[^/]+\/[^/]+\/object(?:\.parts\/[^/]+)?$/.test(assertSafeObjectKey(key)))throw new DomainError('STAGING_KEY_REQUIRED','Cleanup cannot delete preserved records',403);
    const file=this.filePath(key);await rm(file,{force:true});await rm(`${file}.meta.json`,{force:true});
    const versions=path.resolve(`${file}.versions`),root=path.resolve(this.directory);
    if(!versions.startsWith(root+path.sep))throw new DomainError('INVALID_OBJECT_KEY','Cleanup target escapes staging storage',400);
    await rm(versions,{recursive:true,force:true});
  }
  private stagingVersionPath(key:string,versionId:string):string {
    if(key.includes('/committed/')||!/^local-staging-v1:[a-f0-9]{64}$/.test(versionId))throw new DomainError('EVIDENCE_VERSION_MISMATCH','Invalid staging version',409);
    return `${this.filePath(key)}.versions/${versionId.slice('local-staging-v1:'.length)}`;
  }
  private stagingVersionId(digest:string,contentType:string):string{return `local-staging-v1:${sha256Hex(JSON.stringify({sha256:digest,contentType}))}`;}
  private async publishStagingVersion(file:string,key:string,digest:string,contentType:string,byteSize:number):Promise<void>{
    if(key.includes('/committed/')||key.startsWith('recovery/'))return;
    const exact=this.stagingVersionPath(key,this.stagingVersionId(digest,contentType));await mkdir(path.dirname(exact),{recursive:true});
    try{await this.publishNewFile(file,exact);}catch(error){if((error as NodeJS.ErrnoException).code!=='EEXIST')throw error;}
    await this.verifyFile(exact,digest,byteSize);await this.publishMetadata(exact,contentType,true);
  }
  async createUploadTarget():Promise<UploadTarget>{throw new DomainError('UPLOAD_ADMISSION_REQUIRED','Create an evidence upload reservation before sending bytes',409);}
  async putUpload():Promise<{key:string}>{throw new DomainError('UPLOAD_ADMISSION_REQUIRED','Direct upload credentials are disabled',403);}
  private async publishMetadata(file:string,contentType:string,immutable:boolean):Promise<void>{
    // Never truncate a published sidecar: concurrent commit/read processes must
    // see either the previous complete metadata or the new complete metadata.
    const destination=`${file}.meta.json`,temporary=`${destination}.${randomUUID()}.tmp`;
    try{
      await writeFile(temporary,JSON.stringify({contentType}),{mode:0o600,flag:'wx'});
      if(!immutable){await rename(temporary,destination);return;}
      try{await this.publishNewFile(temporary,destination);}
      catch(error){
        if((error as NodeJS.ErrnoException).code!=='EEXIST')throw error;
        const existing=JSON.parse(await readFile(destination,'utf8')) as {contentType:string};
        if(existing.contentType!==contentType)throw new DomainError('OBJECT_ALREADY_PRESERVED','Preserved object metadata cannot be replaced',409);
      }
    }finally{await rm(temporary,{force:true});}
  }
  private async publishNewFile(source:string,target:string):Promise<void>{
    try{await link(source,target);}catch(error){
      if(!['EPERM','ENOTSUP','EOPNOTSUPP'].includes((error as NodeJS.ErrnoException).code??''))throw error;
      // Restricted local filesystems may disallow hardlinks. Exclusive creation
      // still forbids replacement; body metadata is published only after copy.
      await copyFile(source,target,fsConstants.COPYFILE_EXCL);
    }
  }
  private async verifyFile(file:string,sha256:string,byteSize:number):Promise<void>{
    const actual=await sha256HexFromStream((await open(file,'r')).createReadStream());
    if(actual.sha256!==sha256||actual.byteSize!==byteSize)throw new DomainError('EVIDENCE_OBJECT_INTEGRITY_FAILURE','Existing local preserved candidate failed verification',409);
  }
  private filePath(key:string):string{return path.join(this.directory,...assertSafeObjectKey(key).split('/'));}
}
