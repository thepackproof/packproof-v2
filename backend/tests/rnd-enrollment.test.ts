import {beforeAll,afterAll,describe,it,expect} from 'vitest';
import {generateKeyPairSync,sign} from 'node:crypto';
import {existsSync} from 'node:fs';
import {createHarness,createUser,commitFulfillmentAndAttest,type TestHarness} from './helpers.js';
import {createTransaction} from '../src/domain/transactions.js';
import {createOrGetProof} from '../src/domain/create-proof.js';
import {finalizeProof} from '../src/domain/finalize.js';
import {enabledResearchConfig} from '../src/rnd/config.js';
import {recordConsent} from '../src/rnd/capture.js';
import {createEnrollment,listEnrollments,onEnrollmentAnalysisCompleted} from '../src/rnd/enrollment.js';
import {runRndWorkerOnce} from '../src/rnd/analyses.js';
import type {RndDeps} from '../src/rnd/types.js';
import type {ManifestSigningRuntime} from '../src/integrity/signing-runtime.js';

const python=process.env.PACKPROOF_RND_TEST_PYTHON??'/tmp/packproof-vision-venv/bin/python';
describe.skipIf(!existsSync(python))('passive immutable research enrollment',()=>{
 let h:TestHarness,deps:RndDeps,seller:string,outsider:string;
 const {privateKey}=generateKeyPairSync('ec',{namedCurve:'prime256v1'});
 const signing:ManifestSigningRuntime={publicStatus:{mode:'SIGNED',algorithm:'ECDSA_SHA_256',keyId:'enrollment-test',required:true,trustListSha256:null},trustList:null,signer:{async signManifest(input){return {algorithm:'ECDSA_SHA_256',keyId:'enrollment-test',signedAt:'2026-10-02T10:00:00Z',signatureBase64:sign('sha256',Buffer.from(input.canonicalJson),privateKey).toString('base64')};}}};
 beforeAll(async()=>{h=await createHarness(undefined,{manifestSigning:signing});seller=await createUser(h);outsider=await createUser(h);
  deps={...h,manifestSigning:signing,rnd:enabledResearchConfig()};deps.rnd!.worker={python,script:new URL('../../research/vision/worker.py',import.meta.url).pathname,timeoutMs:60000,maxInputBytes:128*1024*1024};
 },30000);
 afterAll(async()=>h?.close());
 async function proof(){const transaction=await createTransaction(h.db,h.clock,seller,{itemTitle:'Synthetic enrollment protocol'});const proof=await createOrGetProof(h.db,h.clock,seller,transaction.transactionId);
  await recordConsent(deps,seller,proof.proofId,'consent',{purpose:'EXPERIMENTAL_ANALYSIS',version:'packproof.research-consent.v1',granted:true});
  const evidence=await commitFulfillmentAndAttest(h,seller,proof.proofId);await finalizeProof(h.db,h.clock,seller,proof.proofId,signing.signer);return {id:proof.proofId,evidenceId:evidence.evidenceId};}
 it('runs actual passive analysis then locks unavailable with frozen signed source inventory',async()=>{
  const p=await proof();const before=(await h.db.query<{sha256:string}>('SELECT sha256 FROM final_manifests WHERE proof_id=$1',[p.id])).rows[0].sha256;
  const enrolled=await createEnrollment(deps,seller,p.id,'enroll',{evidenceIds:[p.evidenceId]});
  expect(await createEnrollment(deps,seller,p.id,'enroll',{evidenceIds:[p.evidenceId]})).toEqual(enrolled);
  let listing=await listEnrollments(deps,seller,p.id);expect(listing.enrollments[0].events.map(e=>e.state)).toEqual(['CANDIDATE','SOURCES_COMMITTED']);
  expect(await runRndWorkerOnce(deps)).toMatchObject({state:'SUCCEEDED'});
  // Calling the hook again tests crash/retry idempotency independent of route mounting.
  const job=(await h.db.query<any>('SELECT * FROM rnd_analyses WHERE id=$1',[enrolled.analysisId])).rows[0];
  await h.db.transaction(tx=>onEnrollmentAnalysisCompleted(deps,tx,job,job.result_json));
  listing=await listEnrollments(deps,seller,p.id);const result=listing.enrollments[0];
  expect(result.events.map(e=>e.state)).toEqual(['CANDIDATE','SOURCES_COMMITTED','ANALYZED','UNAVAILABLE','LOCKED']);
  expect(result.frozenRequiredGroups).toEqual(['label','carton']);expect(result.qualified).toBe(false);
  expect(result.events.every(e=>e.signature&&e.digest)).toBe(true);
  await expect(h.db.query('UPDATE rnd_enrollments SET frozen_groups=$2 WHERE id=$1',[enrolled.enrollmentId,JSON.stringify(['label'])])).rejects.toThrow(/IMMUTABLE/);
  await expect(h.db.query('DELETE FROM rnd_enrollment_events WHERE enrollment_id=$1',[enrolled.enrollmentId])).rejects.toThrow(/IMMUTABLE/);
  expect((await h.db.query<{sha256:string}>('SELECT sha256 FROM final_manifests WHERE proof_id=$1',[p.id])).rows[0].sha256).toBe(before);
 },90000);
 it('rejects unbound prior versions, source edits and unauthorized readers',async()=>{
  const a=await proof(),b=await proof();const enrolled=await createEnrollment(deps,seller,a.id,'first',{evidenceIds:[a.evidenceId]});
  await expect(createEnrollment(deps,seller,b.id,'bad-parent',{evidenceIds:[b.evidenceId],supersedesEnrollmentId:enrolled.enrollmentId})).rejects.toMatchObject({code:'RND_ENROLLMENT_PARENT_FORBIDDEN'});
  await expect(createEnrollment(deps,seller,a.id,'first',{evidenceIds:[b.evidenceId]})).rejects.toMatchObject({code:'RND_IDEMPOTENCY_CONFLICT'});
  await expect(listEnrollments(deps,outsider,a.id)).rejects.toMatchObject({code:'PARTICIPANT_NOT_AUTHORIZED'});
  await expect(createEnrollment(deps,seller,a.id,'qualified',{evidenceIds:[a.evidenceId],qualified:true})).rejects.toMatchObject({code:'RND_INVALID_INPUT'});
  deps.rnd!.features.proofprint.internalDisplay=false;await expect(listEnrollments(deps,seller,a.id)).rejects.toMatchObject({code:'RND_DISABLED'});deps.rnd!.features.proofprint.internalDisplay=true;
 });
});
