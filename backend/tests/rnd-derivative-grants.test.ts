import {beforeAll,afterAll,describe,it,expect} from 'vitest';
import {generateKeyPairSync,sign} from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import request from 'supertest';
import {createServerApp} from '../src/server-app.js';
import {BearerUserAdapter} from '../src/auth/adapter.js';
import {createHarness,createUser,commitFulfillmentAndAttest,commitProofEvidence,type TestHarness} from './helpers.js';
import {createTransaction} from '../src/domain/transactions.js';
import {createOrGetProof} from '../src/domain/create-proof.js';
import {finalizeProof} from '../src/domain/finalize.js';
import {recordConsent} from '../src/rnd/capture.js';
import {requestAnalysis,runRndWorkerOnce} from '../src/rnd/analyses.js';
import {reviewDerivative,artifactFor} from '../src/rnd/exports.js';
import {createDerivativeGrant,listDerivativeGrants,revokeDerivativeGrant,redeemDerivativeGrant} from '../src/rnd/derivative-grants.js';
import {enabledResearchConfig} from '../src/rnd/config.js';
import {collectSmallZip} from '../src/export/zip-stream.js';
import type {RndDeps} from '../src/rnd/types.js';
import type {ManifestSigningRuntime} from '../src/integrity/signing-runtime.js';

describe('reviewed derivative bearer grants',()=>{
 let h:TestHarness,deps:RndDeps,seller:string,outsider:string,proofId:string,analysisId:string,scope:{artifactSha256:string;recipeSha256:string;expiresInSeconds:number};
 let now=Date.parse('2026-10-02T12:00:00.000Z'),sequence=0;
 const keys=generateKeyPairSync('ec',{namedCurve:'prime256v1'});
 const signing:ManifestSigningRuntime={publicStatus:{mode:'SIGNED',algorithm:'ECDSA_SHA_256',keyId:'grant-test',required:true,trustListSha256:null},signer:{async signManifest(i){return {algorithm:'ECDSA_SHA_256',keyId:'grant-test',signedAt:new Date(now).toISOString(),signatureBase64:sign('sha256',Buffer.from(i.canonicalJson),keys.privateKey).toString('base64')};}}};
 beforeAll(async()=>{
  h=await createHarness({now:()=>new Date(now)},{manifestSigning:signing});seller=await createUser(h);outsider=await createUser(h);deps={...h,rnd:enabledResearchConfig(),manifestSigning:signing};
  deps.rnd!.worker={python:process.env.PACKPROOF_TEST_PRIVACY_PYTHON??'/tmp/packproof-privacy-venv/bin/python',script:new URL('../../research/vision/worker.py',import.meta.url).pathname,timeoutMs:60000,maxInputBytes:128*1024*1024};
  const txn=await createTransaction(h.db,h.clock,seller,{itemTitle:'Synthetic privacy grant'}),proof=await createOrGetProof(h.db,h.clock,seller,txn.transactionId);proofId=proof.proofId;
  await recordConsent(deps,seller,proofId,'consent',{purpose:'EXPERIMENTAL_ANALYSIS',version:'packproof.research-consent.v1',granted:true});
  // A real high-entropy PNG keeps the export larger than stream buffers, allowing
  // revocation to occur during transmission rather than after a tiny ZIP completes.
  const {stdout:imageBytes}=await promisify(execFile)(deps.rnd!.worker.python,['-c','from PIL import Image; import random,sys; Image.frombytes("RGB",(512,512),random.Random(7).randbytes(512*512*3)).save(sys.stdout.buffer,format="PNG")'],{encoding:'buffer',maxBuffer:2*1024*1024,timeout:15000});
  const image=await commitProofEvidence(h,seller,proofId,{contentType:'image/png',bytes:imageBytes,idempotencyKey:'image'});
  await commitFulfillmentAndAttest(h,seller,proofId);await finalizeProof(h.db,h.clock,seller,proofId,signing.signer);
  const job=await requestAnalysis(deps,seller,proofId,'redact',{feature:'proofshield',evidenceIds:[image.evidenceId],parameters:{kind:'still',masks:[{x:0,y:0,width:10,height:10,class:'manual'}]}});analysisId=job.analysisId;
  expect(await runRndWorkerOnce(deps)).toMatchObject({state:'SUCCEEDED'});
  const artifact=await artifactFor(deps,seller,proofId,analysisId,0),record=(artifact.row.result_json!.details as {observations:{record:{derivativeSha256:string;recipeSha256:string}}[]}).observations[0].record;
  scope={artifactSha256:record.derivativeSha256,recipeSha256:record.recipeSha256,expiresInSeconds:120};
 },45000);
 afterAll(async()=>h?.close());
 const grant=()=>createDerivativeGrant(deps,seller,proofId,analysisId,`grant-${sequence++}`,scope);
 it('requires exact human review and denies foreign actors, substituted digests and expiry outside bounds',async()=>{
  await expect(grant()).rejects.toMatchObject({code:'RND_PRIVACY_REVIEW_REQUIRED'});
  await reviewDerivative(deps,seller,proofId,analysisId,'review',{approved:true,artifactSha256:scope.artifactSha256,recipeSha256:scope.recipeSha256});
  await expect(createDerivativeGrant(deps,outsider,proofId,analysisId,'foreign',scope)).rejects.toMatchObject({code:'PARTICIPANT_NOT_AUTHORIZED'});
  await expect(createDerivativeGrant(deps,seller,proofId,analysisId,'wrong',{...scope,artifactSha256:'0'.repeat(64)})).rejects.toMatchObject({code:'RND_GRANT_SCOPE'});
  await expect(createDerivativeGrant(deps,seller,proofId,analysisId,'forever',{...scope,expiresInSeconds:86401})).rejects.toMatchObject({code:'RND_INVALID_GRANT'});
 });
 it('delivers token once, stores only its hash, audits redemption, and exports no originals',async()=>{
  const first=await createDerivativeGrant(deps,seller,proofId,analysisId,'once',scope);expect(first.tokenDelivery).toBe('ONCE');expect(first.token).toMatch(/^rndg_/);
  const retry=await createDerivativeGrant(deps,seller,proofId,analysisId,'once',scope);expect(retry.token).toBeNull();expect(retry.grant.id).toBe(first.grant.id);
  const rows=(await h.db.query('SELECT * FROM rnd_derivative_grants')).rows,events=(await h.db.query('SELECT * FROM rnd_derivative_grant_events')).rows,idempotency=(await h.db.query('SELECT * FROM rnd_idempotency')).rows;
  expect(JSON.stringify({rows,events,idempotency})).not.toContain(first.token!);
  const zip=await collectSmallZip(await redeemDerivativeGrant(deps,{token:first.token})),text=zip.toString('latin1');expect(text).toContain('disclosure.json');expect(text).toContain('redacted.png');expect(text).not.toContain('originals/');
  const listed=await listDerivativeGrants(deps,seller,proofId,analysisId);expect(JSON.stringify(listed)).not.toContain(first.token!);
  const entry=listed.grants.find(g=>g.grant.id===first.grant.id)!;expect(entry.audit.map(e=>JSON.parse(e.canonicalJson).kind)).toContain('REDEEM_COMPLETED');
  await expect(h.db.query('UPDATE rnd_derivative_grants SET token_hash=$1 WHERE id=$2',['0'.repeat(64),first.grant.id])).rejects.toThrow(/IMMUTABLE/);
 });
 it('revokes idempotently and rejects unknown, expired and disabled grants',async()=>{
  await reviewDerivative(deps,seller,proofId,analysisId,'review',{approved:true,artifactSha256:scope.artifactSha256,recipeSha256:scope.recipeSha256});
  const first=await grant();await revokeDerivativeGrant(deps,seller,proofId,String(first.grant.id));await revokeDerivativeGrant(deps,seller,proofId,String(first.grant.id));
  await expect(redeemDerivativeGrant(deps,{token:first.token})).rejects.toMatchObject({code:'RND_GRANT_UNAVAILABLE'});
  await expect(revokeDerivativeGrant(deps,outsider,proofId,String(first.grant.id))).rejects.toMatchObject({code:'PARTICIPANT_NOT_AUTHORIZED'});
  await expect(redeemDerivativeGrant(deps,{token:'rndg_'+'A'.repeat(43)})).rejects.toMatchObject({code:'RND_GRANT_UNAVAILABLE'});
  const expired=await grant();now+=121000;await expect(redeemDerivativeGrant(deps,{token:expired.token})).rejects.toMatchObject({code:'RND_GRANT_UNAVAILABLE'});
  const disabled=await grant();deps.rnd!.killSwitch=true;await expect(redeemDerivativeGrant(deps,{token:disabled.token})).rejects.toMatchObject({code:'RND_DISABLED'});
  await revokeDerivativeGrant(deps,seller,proofId,String(disabled.grant.id));deps.rnd!.killSwitch=false;
  await expect(redeemDerivativeGrant(deps,{token:disabled.token})).rejects.toMatchObject({code:'RND_GRANT_UNAVAILABLE'});
 });
 it('mounts token redemption before account authentication while grant creation remains private',async()=>{
  const first=await grant(),app=createServerApp({...h,rnd:deps.rnd,manifestSigning:signing,auth:new BearerUserAdapter(h.db),publicBaseUrl:'http://127.0.0.1',devAuth:false,testFixtures:true});
  const response=await request(app).post('/rnd/derivative-grants/redeem').send({token:first.token});expect(response.status).toBe(200);expect(response.headers['content-type']).toContain('application/zip');expect(response.headers['cache-control']).toContain('no-store');
  const denied=await request(app).post(`/proofs/${proofId}/rnd/analyses/${analysisId}/grants`).send(scope);expect(denied.status).toBe(401);
  const queryToken=await request(app).post('/rnd/derivative-grants/redeem?token=ignored').send({});expect(queryToken.status).toBe(404);
 });
 it('interrupts an in-progress archive after revocation and records an aborted redemption',async()=>{
  const first=await grant(),zip=await redeemDerivativeGrant(deps,{token:first.token}),iterator=zip[Symbol.asyncIterator]();expect((await iterator.next()).done).toBe(false);
  await revokeDerivativeGrant(deps,seller,proofId,String(first.grant.id));
  await expect((async()=>{for(;;){if((await iterator.next()).done)break;}})()).rejects.toMatchObject({code:'RND_GRANT_UNAVAILABLE'});
  const kinds=(await h.db.query<{kind:string}>('SELECT kind FROM rnd_derivative_grant_events WHERE grant_id=$1',[first.grant.id])).rows.map(e=>e.kind);expect(kinds).toContain('REDEEM_ABORTED');
 });
 it('withdrawn consent and replacement review immediately invalidate issued grants',async()=>{
  const first=await grant();now++;await recordConsent(deps,seller,proofId,'withdraw',{purpose:'EXPERIMENTAL_ANALYSIS',version:'packproof.research-consent.v1',granted:false});
  await expect(redeemDerivativeGrant(deps,{token:first.token})).rejects.toMatchObject({code:'RND_CONSENT_REQUIRED'});
  now++;await recordConsent(deps,seller,proofId,'restore',{purpose:'EXPERIMENTAL_ANALYSIS',version:'packproof.research-consent.v1',granted:true});
  const second=await grant();now++;await reviewDerivative(deps,seller,proofId,analysisId,'reject',{approved:false,artifactSha256:scope.artifactSha256,recipeSha256:scope.recipeSha256});
  await expect(redeemDerivativeGrant(deps,{token:second.token})).rejects.toMatchObject({code:'RND_GRANT_UNAVAILABLE'});
 });
});
