import request from 'supertest';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Readable } from 'node:stream';
import type { S3Client } from '@aws-sdk/client-s3';
import { HeadObjectCommand, GetObjectCommand, CopyObjectCommand } from '@aws-sdk/client-s3';
import { createHarness, createUser, type TestHarness } from './helpers.js';
import { createTransaction } from '../src/domain/transactions.js';
import { createOrGetProof } from '../src/domain/create-proof.js';
import { commitEvidence, initializeEvidenceUpload, parseEvidenceByteRange, streamPreservedObject } from '../src/domain/evidence.js';
import { MEDIA_MAX_BYTES, reserveMediaIngress, finishMediaIngress, sweepExpiredMediaAdmissions } from '../src/domain/media-admission.js';
import { AwsS3ObjectStore } from '../src/s3/aws-s3-object-store.js';
import { sha256Hex } from '../src/hash.js';
let h:TestHarness;
afterEach(async()=>{const current=h;h=undefined as unknown as TestHarness;await current?.close();vi.restoreAllMocks();});
async function setup(clock?:{now:()=>Date}){h=await createHarness(clock);const actor=await createUser(h),tx=await createTransaction(h.db,h.clock,actor,{itemTitle:'Admission fixture'}),proof=await createOrGetProof(h.db,h.clock,actor,tx.transactionId);return {actor,proofId:proof.proofId};}
async function reserve(actor:string,proofId:string,key:string,size=8){return initializeEvidenceUpload(h.db,h.clock,h.objectStore,actor,proofId,{contentType:'video/mp4',idempotencyKey:key,byteSize:size});}
describe('media admission guarantees',()=>{
 it('refuses an oversized declaration and duplicate account concurrency before issuing contracts',async()=>{
  const {actor,proofId}=await setup();await expect(reserve(actor,proofId,'too-large',MEDIA_MAX_BYTES+1)).rejects.toMatchObject({code:'UPLOAD_TOO_LARGE'});
  const first=await reserve(actor,proofId,'first');await reserve(actor,proofId,'second');await expect(reserve(actor,proofId,'third')).rejects.toMatchObject({code:'UPLOAD_CONCURRENCY_LIMIT'});
  const replay=await reserve(actor,proofId,'first');expect(replay.evidenceId).toBe(first.evidenceId);
  expect(Number((await h.db.query<{count:string}>('SELECT COUNT(*) AS count FROM evidence_upload_admissions')).rows[0].count)).toBe(2);
 });
 it('rejects wrong lengths before storage and consumes a completed credential only once',async()=>{
  const {actor,proofId}=await setup(),upload=await reserve(actor,proofId,'whole',8),path=new URL(upload.upload.url).pathname;
  const write=vi.spyOn(h.objectStore,'putStream');
  await request(h.app).put(path).set('Content-Type','video/mp4').send(Buffer.alloc(9)).expect(413);expect(write).not.toHaveBeenCalled();
  await request(h.app).put(path).set('Content-Type','video/mp4').send(Buffer.from([0,0,0,24,102,116,121,112])).expect(200);
  await request(h.app).put(path).set('Content-Type','video/mp4').send(Buffer.from('87654321')).expect(409);expect(write).toHaveBeenCalledTimes(1);
  const account=(await h.db.query<{ingress_bytes:string}>('SELECT ingress_bytes FROM evidence_upload_admissions WHERE evidence_id=$1',[upload.evidenceId])).rows[0];expect(Number(account.ingress_bytes)).toBe(8);
 });
 it('charges failed attempts before body consumption, so retries have a cumulative ceiling',async()=>{
  const {actor,proofId}=await setup(),upload=await reserve(actor,proofId,'retry',8),token=new URL(upload.upload.url).pathname.split('admission_')[1];
  for(let i=0;i<2;i++){const lease=await reserveMediaIngress(h.db,h.clock,{token,byteSize:8,wholeObject:true});await finishMediaIngress(h.db,h.clock,{...lease,received:false});}
  await expect(reserveMediaIngress(h.db,h.clock,{token,byteSize:1,wholeObject:false})).rejects.toMatchObject({code:'UPLOAD_INGRESS_LIMIT'});
  expect(Number((await h.db.query<{ingress_bytes:string}>('SELECT ingress_bytes FROM evidence_upload_admissions WHERE evidence_id=$1',[upload.evidenceId])).rows[0].ingress_bytes)).toBe(16);
  const renewed=await reserve(actor,proofId,'retry',8);expect(renewed.evidenceId).toBe(upload.evidenceId);
  const continued=await reserveMediaIngress(h.db,h.clock,{token:new URL(renewed.upload.url).pathname.split('admission_')[1],byteSize:8,wholeObject:true});await finishMediaIngress(h.db,h.clock,{...continued,received:false});
  expect(Number((await h.db.query<{reserved_bytes:string}>('SELECT reserved_bytes FROM media_admission_accounts WHERE actor_user_id=$1',[actor])).rows[0].reserved_bytes)).toBe(16);
  expect(Number((await h.db.query<{ingress_bytes:string}>('SELECT ingress_bytes FROM evidence_upload_admissions WHERE evidence_id=$1',[upload.evidenceId])).rows[0].ingress_bytes)).toBe(24);
 });
 it('rejects a forged MIME label from actual leading bytes without receiving evidence',async()=>{
  const {actor,proofId}=await setup(),upload=await reserve(actor,proofId,'forged-format',8);
  const response=await request(h.app).put(new URL(upload.upload.url).pathname).set('Content-Type','video/mp4').send(Buffer.from('notvideo'));
  expect(response.status).toBe(422);expect(response.body.error.code).toBe('EVIDENCE_FORMAT_MISMATCH');expect(await h.objectStore.get(upload.objectKey)).toBeNull();
  expect((await h.db.query<{state:string}>('SELECT state FROM evidence_upload_admissions WHERE evidence_id=$1',[upload.evidenceId])).rows[0].state).toBe('OPEN');
 });
 it('sweeps expired staging and preserves the exact committed bytes',async()=>{
  let now=new Date('2026-09-07T10:00:00Z');const {actor,proofId}=await setup({now:()=>now}),upload=await reserve(actor,proofId,'sweep');
  await request(h.app).put(new URL(upload.upload.url).pathname).set('Content-Type','video/mp4').send(Buffer.from([0,0,0,24,102,116,121,112])).expect(200);
  const committed=await commitEvidence(h.db,h.clock,h.objectStore,actor,proofId,upload.evidenceId);
  const row=(await h.db.query<{object_key:string;object_version_id:string}>('SELECT object_key,object_version_id FROM evidence WHERE id=$1',[upload.evidenceId])).rows[0];
  now=new Date(now.getTime()+8*24*60*60*1000);expect((await sweepExpiredMediaAdmissions(h.db,h.clock,h.objectStore)).cleaned).toBe(1);
  expect(await h.objectStore.get(upload.objectKey)).toBeNull();expect((await h.objectStore.digest(row.object_key,{versionId:row.object_version_id}))?.sha256).toBe(committed.sha256);
 });
});
describe('exact-version streaming',()=>{
 it('pins the staging VersionId for hashing and copy even if latest changes',async()=>{
  const old=Buffer.from('original-bytes'),gets:unknown[]=[];let copy:CopyObjectCommand|undefined;
  const client={send:async(command:unknown)=>{
   if(command instanceof HeadObjectCommand){if(command.input.Key?.includes('/committed/'))throw Object.assign(new Error('missing'),{name:'NotFound'});return {ContentLength:old.length,ContentType:'video/mp4',VersionId:command.input.VersionId??'original/version+1'};}
   if(command instanceof GetObjectCommand){gets.push(command.input.VersionId);return {Body:Readable.from([old]),ContentLength:old.length,ContentType:'video/mp4',VersionId:command.input.VersionId};}
   if(command instanceof CopyObjectCommand){copy=command;return {VersionId:'preserved/version+2'};}throw new Error('Unexpected storage operation');
  }} as unknown as S3Client;
  const result=await new AwsS3ObjectStore('staging',{region:'us-east-1',client,committedBucket:'preserved'}).commitUpload('evidence/p/e/object');
  expect(gets).toEqual(['original/version+1']);expect(copy?.input.CopySource).toBe('staging/evidence/p/e/object?versionId=original%2Fversion%2B1');expect(copy?.input.Bucket).toBe('preserved');expect(result?.versionId).toBe('preserved/version+2');
 });
 it('reads exactly a requested 1 MiB range from a 100 MiB object without whole-object reads',async()=>{
  const total=100*1024*1024,requested=1024*1024,commands:GetObjectCommand[]=[];
  const client={send:async(command:unknown)=>{if(!(command instanceof GetObjectCommand))throw new Error('Whole-object metadata/hash access is forbidden for a pinned range');commands.push(command);return {Body:Readable.from([Buffer.alloc(requested)]),ContentLength:requested,ContentType:'video/mp4',VersionId:'preserved-1'};}} as unknown as S3Client;
  const store=new AwsS3ObjectStore('b',{region:'us-east-1',client}),result=await streamPreservedObject(store,{id:'e',object_key:`evidence/p/e/committed/sha256-${'a'.repeat(64)}`,object_version_id:'preserved-1',content_type:'video/mp4',sha256:'a'.repeat(64),byte_size:total},`bytes=1048576-${1048576+requested-1}`);
  let bytes=0;for await(const chunk of result.body!)bytes+=chunk.length;expect(bytes).toBe(requested);expect(commands).toHaveLength(1);expect(commands[0].input.Range).toBe('bytes=1048576-2097151');expect(commands[0].input.VersionId).toBe('preserved-1');expect(result.status).toBe(206);expect(result.headers['Content-Length']).toBe(String(requested));
 });
 it('rejects missing versioning before preservation and handles unsatisfiable ranges without reads',async()=>{
  const client={send:async()=>({ContentLength:12,ContentType:'video/mp4'})} as unknown as S3Client;
  const store=new AwsS3ObjectStore('b',{region:'us-east-1',client});await expect(store.commitUpload('evidence/p/e/object')).rejects.toMatchObject({code:'EVIDENCE_VERSIONING_REQUIRED'});
  const get=vi.spyOn(store,'getStream'),result=await streamPreservedObject(store,{id:'e',object_key:'evidence/p/e/object',object_version_id:'v',content_type:'video/mp4',sha256:sha256Hex('abc'),byte_size:3},'bytes=3-5');expect(result.status).toBe(416);expect(result.headers['Content-Range']).toBe('bytes */3');expect(get).not.toHaveBeenCalled();
  expect(parseEvidenceByteRange('bytes=-2',3)).toEqual({start:1,end:2});expect(parseEvidenceByteRange('bytes=0-0,2-2',3)).toBe('unsatisfiable');
 });
});

describe('revocation during an active stream',()=>{
 it('interrupts an open response after at most one admission window and destroys storage',async()=>{
  const {guardDisclosureStream}=await import('../src/domain/disclosure-stream.js');
  let revoked=false,checks=0,delivered=0;
  const source=Readable.from([Buffer.alloc(4*1024*1024)]);
  const guarded=guardDisclosureStream(source,async()=>{checks++;if(revoked)throw new Error('Grant revoked');});
  await expect((async()=>{for await(const chunk of guarded){delivered+=chunk.length;revoked=true;}})()).rejects.toThrow('Grant revoked');
  expect(delivered).toBeGreaterThan(0);expect(delivered).toBeLessThanOrEqual(1024*1024);expect(checks).toBeGreaterThanOrEqual(2);expect(source.destroyed).toBe(true);
 });
 it('expires a long response even if the grant remains valid',async()=>{
  const {guardDisclosureStream}=await import('../src/domain/disclosure-stream.js');let now=0;
  const source=Readable.from((async function*(){yield Buffer.alloc(65536);now=2000;yield Buffer.alloc(65536);})());
  const guarded=guardDisclosureStream(source,async()=>undefined,{maximumLifetimeMs:1000,now:()=>now});
  await expect((async()=>{for await(const _ of guarded){/* drain */}})()).rejects.toMatchObject({code:'ACCESS_RESPONSE_EXPIRED'});expect(source.destroyed).toBe(true);
 });
});
