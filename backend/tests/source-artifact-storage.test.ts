import {describe,it,expect} from 'vitest';
import {mkdtemp,rm,writeFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {Readable} from 'node:stream';
import {HeadObjectCommand,GetObjectCommand,CopyObjectCommand,type S3Client} from '@aws-sdk/client-s3';
import {LocalObjectStore} from '../src/s3/local-object-store.js';
import {AwsS3ObjectStore} from '../src/s3/aws-s3-object-store.js';
import {sha256Hex} from '../src/hash.js';

describe('exact accepted upload versions',()=>{
 it('reads and preserves an earlier local staging version after replacement, including distinct MIME versions',async()=>{
  const dir=await mkdtemp(path.join(os.tmpdir(),'exact-source-version-'));try{
   const store=new LocalObjectStore(dir,'http://example.test','unused'),key='evidence/proof_exact/source_exact/object',body=Buffer.from('original-version');
   const first=await store.putStream(key,Readable.from([body]),'video/mp4',body.length);
   await store.putStream(key,Readable.from([Buffer.from('replacement')]),'video/mp4',11);
   expect((await store.get(key,{versionId:first.versionId}))?.body).toEqual(body);
   const result=await store.commitUpload(key,{expectedVersionId:first.versionId,sha256:sha256Hex(body),byteSize:body.length});expect(result?.stagingVersionId).toBe(first.versionId);expect(result?.sha256).toBe(sha256Hex(body));
   const differentMime=await store.putStream(key,Readable.from([body]),'application/octet-stream',body.length);expect(differentMime.versionId).not.toBe(first.versionId);
   await expect(store.commitUpload(key,{expectedVersionId:differentMime.versionId})).rejects.toMatchObject({code:'OBJECT_ALREADY_PRESERVED'});
   await expect(store.commitUpload(key,{expectedVersionId:'unrecognized-version'})).rejects.toMatchObject({code:'EVIDENCE_VERSION_MISMATCH'});
  }finally{const resolved=path.resolve(dir);if(!resolved.startsWith(path.resolve(os.tmpdir())+path.sep))throw Error('Unsafe cleanup');await rm(resolved,{recursive:true,force:true});}
 });
 it('never accepts a partially published existing local committed candidate',async()=>{
  const dir=await mkdtemp(path.join(os.tmpdir(),'partial-source-version-'));try{
   const store=new LocalObjectStore(dir,'http://example.test','unused'),key='evidence/proof_exact/source_exact/object',body=Buffer.from('complete original');
   const first=await store.putStream(key,Readable.from([body]),'video/mp4',body.length),preserved=await store.commitUpload(key,{expectedVersionId:first.versionId});
   await writeFile(path.join(dir,preserved!.key),Buffer.from('partial'));
   await expect(store.commitUpload(key,{expectedVersionId:first.versionId})).rejects.toMatchObject({code:'EVIDENCE_OBJECT_INTEGRITY_FAILURE'});
  }finally{const resolved=path.resolve(dir);if(!resolved.startsWith(path.resolve(os.tmpdir())+path.sep))throw Error('Unsafe cleanup');await rm(resolved,{recursive:true,force:true});}
 });
 it('pins the supplied S3 VersionId for head, server digest and preservation copy',async()=>{
  const commands:any[]=[],body=Buffer.from('accepted original'),key='evidence/proof_exact/source_exact/object';
  const client={send:async(command:any)=>{commands.push(command);if(command instanceof HeadObjectCommand){if(command.input.Key!==key)throw Object.assign(new Error('missing'),{$metadata:{httpStatusCode:404}});return {ContentLength:body.length,ContentType:'video/mp4',VersionId:'accepted-version'};}if(command instanceof GetObjectCommand)return {Body:Readable.from([body]),ContentLength:body.length,ContentType:'video/mp4',VersionId:'accepted-version'};if(command instanceof CopyObjectCommand)return {VersionId:'preserved-version'};throw Error('Unexpected storage action');}} as unknown as S3Client;
  const store=new AwsS3ObjectStore('staging',{region:'us-east-1',client,committedBucket:'preserved'}),result=await store.commitUpload(key,{expectedVersionId:'accepted-version'});
  expect(result).toMatchObject({sha256:sha256Hex(body),versionId:'preserved-version',stagingVersionId:'accepted-version'});
  expect(commands[0].input.VersionId).toBe('accepted-version');expect(commands.find(c=>c instanceof GetObjectCommand).input.VersionId).toBe('accepted-version');expect(commands.find(c=>c instanceof CopyObjectCommand).input.CopySource).toContain('?versionId=accepted-version');
 });
 it('rejects an S3 adapter that returns latest instead of the requested staging version',async()=>{
  const client={send:async()=>({VersionId:'different-version',ContentLength:10,ContentType:'video/mp4'})} as unknown as S3Client;
  await expect(new AwsS3ObjectStore('staging',{region:'us-east-1',client}).commitUpload('evidence/proof_exact/source_exact/object',{expectedVersionId:'accepted-version'})).rejects.toMatchObject({code:'EVIDENCE_VERSION_MISMATCH'});
 });
});
