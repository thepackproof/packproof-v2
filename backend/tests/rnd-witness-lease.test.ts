import {afterAll,afterEach,beforeAll,describe,expect,it} from 'vitest';
import {generateKeyPairSync,sign} from 'node:crypto';
import {createHarness,createUser,commitFulfillmentAndAttest,type TestHarness} from './helpers.js';
import {createTransaction} from '../src/domain/transactions.js';
import {createOrGetProof} from '../src/domain/create-proof.js';
import {finalizeProof} from '../src/domain/finalize.js';
import {recordConsent} from '../src/rnd/capture.js';
import {enabledResearchConfig} from '../src/rnd/config.js';
import {requestAnalysis,leaseAnalysis,completeAnalysis,runRndWorkerOnce} from '../src/rnd/analyses.js';
import {witnessLeaseCheckpoint,WITNESS_ATTEMPT_MS} from '../src/rnd/witness-lease.js';
import type {RndDeps,WorkerResult} from '../src/rnd/types.js';
import type {ManifestSigningRuntime} from '../src/integrity/signing-runtime.js';

describe('bounded witness stage leases',()=>{
 let h:TestHarness,deps:RndDeps,actor:string,proofId:string,evidenceId:string,counter=0;
 let now=Date.parse('2026-10-11T10:00:00Z');
 const pair=generateKeyPairSync('ec',{namedCurve:'prime256v1'});
 const signing:ManifestSigningRuntime={publicStatus:{mode:'SIGNED',algorithm:'ECDSA_SHA_256',keyId:'research-lease-test',required:true,trustListSha256:null},signer:{async signManifest(input){return {algorithm:'ECDSA_SHA_256',keyId:'research-lease-test',signedAt:new Date(now).toISOString(),signatureBase64:sign('sha256',Buffer.from(input.canonicalJson),pair.privateKey).toString('base64')};}}};
 const result:WorkerResult={findingState:'NOT_CHECKED',observations:[],coverage:{},limitations:['Synthetic lease fixture only.']};
 beforeAll(async()=>{
  h=await createHarness({now:()=>new Date(now)},{manifestSigning:signing});deps={...h,rnd:enabledResearchConfig(),manifestSigning:signing};actor=await createUser(h);
  const transaction=await createTransaction(h.db,h.clock,actor,{itemTitle:'Witness lease fixture'});
  const proof=await createOrGetProof(h.db,h.clock,actor,transaction.transactionId);proofId=proof.proofId;
  await recordConsent(deps,actor,proofId,'consent',{purpose:'EXPERIMENTAL_ANALYSIS',version:'packproof.research-consent.v1',granted:true});
  evidenceId=(await commitFulfillmentAndAttest(h,actor,proofId)).evidenceId;await finalizeProof(h.db,h.clock,actor,proofId,signing.signer);
 },30000);
 afterEach(async()=>{deps.rnd!.killSwitch=false;await h.db.query("UPDATE rnd_analyses SET operational_state='CANCELLED' WHERE operational_state IN ('RUNNING','QUEUED')");});
 afterAll(async()=>h?.close());
 async function queued(){return requestAnalysis(deps,actor,proofId,`job-${++counter}`,{feature:'proofwitness',scope:`lease-${counter}`,evidenceIds:[evidenceId]});}
 async function leased(){const request=await queued(),job=await leaseAnalysis(deps);expect(job?.id).toBe(request.analysisId);return job!;}
 it('publishes once after three valid stages take longer than the original 90-second lease',async()=>{
  const job=await leased(),checkpoint=witnessLeaseCheckpoint(deps,job),started=now;
  for(let stage=0;stage<3;stage++){expect(await checkpoint()).toBe(60000);now+=40000;await checkpoint();}
  expect(now-started).toBe(120000);await completeAnalysis(deps,job,result,'a'.repeat(64));
  expect((await h.db.query('SELECT id FROM rnd_extensions WHERE analysis_id=$1',[job.id])).rows).toHaveLength(1);
  await expect(checkpoint()).rejects.toMatchObject({code:'RND_LEASE_LOST'});
 });
 it('never renews an expired or stolen lease and cannot publish over its successor',async()=>{
  const first=await leased(),checkpoint=witnessLeaseCheckpoint(deps,first);now+=91000;
  await expect(checkpoint()).rejects.toMatchObject({code:'RND_LEASE_LOST'});
  const successor=await leaseAnalysis(deps);expect(successor?.lease_token).not.toBe(first.lease_token);
  await expect(checkpoint()).rejects.toMatchObject({code:'RND_LEASE_LOST'});
  await expect(completeAnalysis(deps,first,result,'a'.repeat(64))).rejects.toMatchObject({code:'RND_LEASE_LOST'});
  await witnessLeaseCheckpoint(deps,successor!)();await completeAnalysis(deps,successor!,result,'b'.repeat(64));
  expect((await h.db.query('SELECT id FROM rnd_extensions WHERE analysis_id=$1',[first.id])).rows).toHaveLength(1);
 });
 it('caps every renewal and attempt at 600 seconds without a timer keeping it alive',async()=>{
  const job=await leased(),checkpoint=witnessLeaseCheckpoint(deps,job),started=now;
  for(let stage=0;stage<11;stage++){await checkpoint();now+=50000;}
  expect(await checkpoint()).toBe(50000);
  const row=(await h.db.query<{lease_until:Date}>('SELECT lease_until FROM rnd_analyses WHERE id=$1',[job.id])).rows[0];
  expect(new Date(row.lease_until).getTime()).toBe(started+WITNESS_ATTEMPT_MS);
  now=started+WITNESS_ATTEMPT_MS;await expect(checkpoint()).rejects.toMatchObject({code:'RND_WITNESS_DEADLINE'});
  await expect(completeAnalysis(deps,job,result,'a'.repeat(64))).rejects.toMatchObject({code:'RND_LEASE_LOST'});
 });
 it('worker completion rechecks ownership after execution even if an adapter returns a result',async()=>{
  const request=await queued();
  const outcome=await runRndWorkerOnce(deps,async job=>{await h.db.query("UPDATE rnd_analyses SET lease_token='replacement-owner' WHERE id=$1",[job.id]);return result;});
  expect(outcome).toMatchObject({state:'FAILED',errorCode:'RND_LEASE_LOST'});
  expect((await h.db.query('SELECT id FROM rnd_extensions WHERE analysis_id=$1',[request.analysisId])).rows).toHaveLength(0);
  expect((await h.db.query<{lease_token:string}>('SELECT lease_token FROM rnd_analyses WHERE id=$1',[request.analysisId])).rows[0].lease_token).toBe('replacement-owner');
 });
});
