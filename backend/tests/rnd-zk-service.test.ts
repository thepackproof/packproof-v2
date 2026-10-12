import { beforeAll,afterAll,describe,it,expect } from 'vitest';
import { generateKeyPairSync,sign } from 'node:crypto';
import { mkdtemp,readFile,writeFile,rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { createHarness,createUser,commitFulfillmentAndAttest,commitProofEvidence,type TestHarness } from './helpers.js';
import { createTransaction } from '../src/domain/transactions.js';
import { createOrGetProof } from '../src/domain/create-proof.js';
import { finalizeProof } from '../src/domain/finalize.js';
import { enabledResearchConfig } from '../src/rnd/config.js';
import { recordConsent } from '../src/rnd/capture.js';
import { requestAnalysis,runRndWorkerOnce,getAnalysis } from '../src/rnd/analyses.js';
import { artifactFor,exportDerivativeZip,reviewDerivative } from '../src/rnd/exports.js';
import type { RndDeps } from '../src/rnd/types.js';
import type { ManifestSigningRuntime } from '../src/integrity/signing-runtime.js';

describe('actual isolated ZK service',()=>{
 let h:TestHarness,deps:RndDeps,dir:string,seller:string,proofId:string,evidenceId:string,enrollmentId:string;
 const now=new Date('2026-10-02T10:00:00Z'),server=generateKeyPairSync('ec',{namedCurve:'prime256v1'});
 const signing:ManifestSigningRuntime={publicStatus:{mode:'SIGNED',algorithm:'ECDSA_SHA_256',keyId:'zk-test-server',required:true,trustListSha256:null},trustList:null,signer:{async signManifest(input){return {algorithm:'ECDSA_SHA_256',keyId:'zk-test-server',signedAt:now.toISOString(),signatureBase64:sign('sha256',Buffer.from(input.canonicalJson),server.privateKey).toString('base64')};}}};
 beforeAll(async()=>{
  dir=await mkdtemp(path.join(tmpdir(),'packproof-zk-service-'));const issuer=generateKeyPairSync('ed25519');
  await writeFile(path.join(dir,'issuer.pem'),issuer.privateKey.export({type:'pkcs8',format:'pem'}),{mode:0o600});await writeFile(path.join(dir,'issuer-public.pem'),issuer.publicKey.export({type:'spki',format:'pem'}));
  const fixture=JSON.parse(await readFile(new URL('../../research/privacy/zk/fixtures/synthetic-trust.json',import.meta.url),'utf8'));
  await writeFile(path.join(dir,'registry.json'),JSON.stringify({schemaVersion:'packproof.zk-verification-registry.v1',profiles:{[fixture.circuitId]:{verificationKeyId:fixture.verificationKeyId,verificationKey:fixture.verificationKey}}}));
  h=await createHarness({now:()=>now},{manifestSigning:signing});seller=await createUser(h);deps={...h,manifestSigning:signing,rnd:enabledResearchConfig()};
  deps.rnd!.worker={python:process.env.PACKPROOF_TEST_PRIVACY_PYTHON??'/tmp/packproof-privacy-venv/bin/python',script:new URL('../../research/vision/worker.py',import.meta.url).pathname,timeoutMs:60000,maxInputBytes:128*1024*1024};
  deps.rnd!.zk={node:process.execPath,script:new URL('../../research/privacy/zk/prove.mjs',import.meta.url).pathname,sourcePrivateKeyFile:path.join(dir,'issuer.pem'),sourcePublicKeyFile:path.join(dir,'issuer-public.pem'),verificationRegistryFile:path.join(dir,'registry.json'),timeoutMs:120000};
  const txn=await createTransaction(h.db,h.clock,seller,{itemTitle:'Synthetic exact RGB8 R&D fixture'}),p=await createOrGetProof(h.db,h.clock,seller,txn.transactionId);proofId=p.proofId;
  await recordConsent(deps,seller,proofId,'consent',{purpose:'EXPERIMENTAL_ANALYSIS',version:'packproof.research-consent.v1',granted:true});
  const bytes=await readFile(new URL('../../research/privacy/zk/fixtures/synthetic-redacted.png',import.meta.url));
  const image=await commitProofEvidence(h,seller,proofId,{contentType:'image/png',bytes,idempotencyKey:'tiny-image'});evidenceId=image.evidenceId;
  await commitFulfillmentAndAttest(h,seller,proofId);await finalizeProof(h.db,h.clock,seller,proofId,signing.signer);
 },30000);
 afterAll(async()=>{await h?.close();if(dir)await rm(dir,{recursive:true,force:true});});
 it('fails without a completed earlier enrollment',async()=>{
  const job=await requestAnalysis(deps,seller,proofId,'missing-enrollment',{feature:'proofshield',evidenceIds:[evidenceId],parameters:{mode:'zk-prove',enrollmentId:'absent',mask:Array(16).fill(false)}});
  expect(await runRndWorkerOnce(deps)).toMatchObject({state:'FAILED',errorCode:'RND_ZK_PRIOR_ENROLLMENT_REQUIRED'});
  expect((await getAnalysis(deps,seller,job.analysisId)).operationalState).toBe('FAILED');
 });
 it('enrolls source before any mask and excludes private pixels/blind from findings',async()=>{
  const job=await requestAnalysis(deps,seller,proofId,'enroll',{feature:'proofshield',evidenceIds:[evidenceId],parameters:{mode:'zk-enroll'}});
  expect(await runRndWorkerOnce(deps)).toMatchObject({state:'SUCCEEDED'});
  const enrolled=await getAnalysis(deps,seller,job.analysisId),result=enrolled.result!;enrollmentId=(result.details as {observations:{enrollmentId:string}[]}).observations[0].enrollmentId;
  const raw=(await h.db.query<{private_witness_json:string;source_binding_json:string}>('SELECT private_witness_json,source_binding_json FROM rnd_zk_enrollments WHERE id=$1',[enrollmentId])).rows[0],secret=JSON.parse(raw.private_witness_json);
  expect(JSON.stringify(result)).not.toContain(secret.blind);expect(JSON.stringify(result)).not.toContain('private_witness_json');expect(JSON.stringify(result)).not.toContain('"pixels":');
  await expect(h.db.query('UPDATE rnd_zk_enrollments SET private_witness_json=$2 WHERE id=$1',[enrollmentId,'{}'])).rejects.toThrow(/IMMUTABLE/);
 },45000);
 it('runs a real proof, verifies against independent registry, and requires exact human review',async()=>{
  const job=await requestAnalysis(deps,seller,proofId,'prove',{feature:'proofshield',evidenceIds:[evidenceId],parameters:{mode:'zk-prove',enrollmentId,mask:Array.from({length:16},(_,i)=>i%2===0)}});
  const outcome=await runRndWorkerOnce(deps);expect(outcome).toMatchObject({state:'SUCCEEDED'});
  const a=await artifactFor(deps,seller,proofId,job.analysisId,0),record=(a.row.result_json!.details as {observations:{record:{verificationLevel:string;derivativeSha256:string;recipeSha256:string;proofBundle:{proof:{proof:string}}}}[]}).observations[0].record;
  expect(record.verificationLevel).toBe('ZERO_KNOWLEDGE_TRANSFORM_PROOF');expect(record.proofBundle.proof.proof.length).toBeGreaterThan(1000);
  await expect(exportDerivativeZip(deps,seller,proofId,job.analysisId)).rejects.toMatchObject({code:'RND_PRIVACY_REVIEW_REQUIRED'});
  await reviewDerivative(deps,seller,proofId,job.analysisId,'review',{approved:true,artifactSha256:record.derivativeSha256,recipeSha256:record.recipeSha256});
  expect(await exportDerivativeZip(deps,seller,proofId,job.analysisId)).toBeTruthy();
 },150000);
});
