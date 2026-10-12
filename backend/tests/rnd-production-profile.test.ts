import { afterAll,beforeAll,describe,expect,it,vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import { generateKeyPairSync,sign,verify } from 'node:crypto';
import { mkdtempSync,writeFileSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { canonicalize } from '../../packages/evidence-contracts/contracts.mjs';
import { loadConfig } from '../src/config.js';
import { rndConfigFromEnv,rndCapabilities,requireRnd } from '../src/rnd/config.js';
import { assertResearchRuntimeIsolation } from '../src/rnd/runtime-isolation.js';
import { rndRouter } from '../src/rnd/router.js';
import { currentConsents,captureReceipts,recordConsent,issueIntent,startIntent,closeIntent } from '../src/rnd/capture.js';
import { researchBundle,exportResearchZip } from '../src/rnd/exports.js';
import { runRndWorkerOnce } from '../src/rnd/analyses.js';
import { rndMetrics,retryResearchAnalysis } from '../src/rnd/operations.js';
import { collectSmallZip } from '../src/export/zip-stream.js';
import { createHarness,createUser,commitProofEvidence,type TestHarness } from './helpers.js';
import { createTransaction } from '../src/domain/transactions.js';
import { createOrGetProof } from '../src/domain/create-proof.js';
import { createCaptureSession } from '../src/domain/capture-sessions.js';
import { commitAttestation } from '../src/domain/attestations.js';
import { finalizeProof } from '../src/domain/finalize.js';
import type { RndDeps } from '../src/rnd/types.js';
import type { ManifestSigningRuntime } from '../src/integrity/signing-runtime.js';

const profileEnv={PACKPROOF_RND_PROFILE:'capture-receipts-v1',PACKPROOF_RND_ENABLED:'1',PACKPROOF_RND_KILL_SWITCH:'0'};
const productionEnv={...profileEnv,PACKPROOF_ENVIRONMENT:'production',NODE_ENV:'production',PACKPROOF_AUTH_MODE:'cognito',PACKPROOF_COGNITO_USER_POOL_ID:'synthetic-pool',PACKPROOF_COGNITO_CLIENT_ID:'synthetic-client',PACKPROOF_OBJECT_STORAGE:'s3',AWS_S3_BUCKET:'synthetic-receipt-bucket',DATABASE_URL:'postgres://synthetic:synthetic@database.invalid/packproof'};
const consent=(granted:boolean)=>({purpose:'EXPERIMENTAL_ANALYSIS',version:'packproof.research-consent.v1',granted});

describe('bounded production receipt profile',()=>{
 it('enables only digital capture receipts and metadata review/export; every processor remains disabled',async()=>{
  const config=rndConfigFromEnv(productionEnv),caps=rndCapabilities(config);
  expect(caps).toMatchObject({profile:'capture-receipts-v1',qualification:'DIGITAL_RECEIPTS_ONLY',supportedOperations:{captureReceipts:true,receiptReview:true,receiptExport:true,receiptExportMode:'METADATA_ONLY',sidecars:false,analyses:false,platformAssurance:false}});
  for(const [feature,flags] of Object.entries(config.features)){expect(flags.processing).toBe(false);expect(flags.customerDisplay).toBe(false);if(feature!=='verifiedcapture')expect(flags.collection||flags.internalDisplay).toBe(false);}
  const db={query:vi.fn(()=>{throw Error('Worker must not touch the database');}),transaction:vi.fn()};
  expect(await runRndWorkerOnce({rnd:config,db} as unknown as RndDeps)).toEqual({state:'IDLE'});expect(db.query).not.toHaveBeenCalled();
  await expect(rndMetrics({rnd:config,db} as unknown as RndDeps,'actor')).rejects.toMatchObject({code:'RND_DISABLED'});
  await expect(retryResearchAnalysis({rnd:config,db} as unknown as RndDeps,'actor','analysis','key',{reason:'retry'})).rejects.toMatchObject({code:'RND_DISABLED'});
  expect(db.query).not.toHaveBeenCalled();
 });
 it.each(['PACKPROOF_RND_PROOFPRINT_PROCESSING','PACKPROOF_RND_PROOFPILOT_COLLECTION','PACKPROOF_RND_VERIFIEDCAPTURE_CUSTOMER_DISPLAY','PACKPROOF_RND_WORKER_SCRIPT','PACKPROOF_RND_WITNESS_SCRIPT','PACKPROOF_RND_ZK_SCRIPT','PACKPROOF_RND_PLATFORM_POLICY_FILE','PACKPROOF_RND_LEARNING_TRUST_KEYS'])('rejects product configuration that attempts to enable %s',key=>expect(()=>rndConfigFromEnv({...productionEnv,[key]:'1'})).toThrow(/do not permit/));
 it('rejects unknown profiles and cannot promote an isolated research runtime',()=>{
  expect(()=>rndConfigFromEnv({...profileEnv,PACKPROOF_RND_PROFILE:''})).toThrow(/Unknown/);
  expect(()=>rndConfigFromEnv({...profileEnv,PACKPROOF_ENV:'research'})).toThrow(/isolated research/);
  const config=rndConfigFromEnv(productionEnv);config.features.proofpilot.processing=true;
  expect(()=>requireRnd(config,'proofpilot','processing')).toThrow(/disabled/);
 });
 it('requires explicit source authorization and durable authenticated runtime; retains isolated-research rejection',()=>{
  const directory=mkdtempSync(path.join(tmpdir(),'receipt-runtime-policy-')),marker=pathToFileURL(path.join(directory,'policy.json'));
  try {
   writeFileSync(marker,JSON.stringify({researchOnly:true,distributionAllowed:false}));
   expect(()=>assertResearchRuntimeIsolation(loadConfig(productionEnv),rndConfigFromEnv(productionEnv),productionEnv,marker)).toThrow(/authorized product/);
   writeFileSync(marker,JSON.stringify({researchOnly:false,distributionAllowed:true,productionProfiles:['capture-receipts-v1']}));
   expect(()=>assertResearchRuntimeIsolation(loadConfig(productionEnv),rndConfigFromEnv(productionEnv),productionEnv,marker)).not.toThrow();
   for(const change of [{PACKPROOF_AUTH_MODE:'dev'},{PACKPROOF_DEV_AUTH:'true'},{PACKPROOF_OBJECT_STORAGE:'local'},{DATABASE_URL:''},{PACKPROOF_ENVIRONMENT:'development'}]){const env={...productionEnv,...change};expect(()=>assertResearchRuntimeIsolation(loadConfig(env),rndConfigFromEnv(env),env,marker)).toThrow(/authenticated durable/);}
   const research={PACKPROOF_ENV:'research',PACKPROOF_ENVIRONMENT:'research',PACKPROOF_RND_ENABLED:'1',PACKPROOF_RND_KILL_SWITCH:'0',PACKPROOF_DEV_AUTH:'true',PACKPROOF_CREDENTIAL_STORE:'memory',PGLITE_DIR:'/tmp/packproof-rnd-profile'};
   expect(()=>assertResearchRuntimeIsolation(loadConfig(research),rndConfigFromEnv(research),research,marker)).not.toThrow();
   expect(()=>assertResearchRuntimeIsolation(loadConfig({...research,AWS_PROFILE:'synthetic-cloud'}),rndConfigFromEnv(research),{...research,AWS_PROFILE:'synthetic-cloud'},marker)).toThrow(/remove inherited cloud/);
  } finally {rmSync(directory,{recursive:true,force:true});}
 });
 it('route allowlist denies advanced routes before touching data and leaves unrelated core routes available',async()=>{
  const db={query:vi.fn(()=>{throw Error('Unexpected database access');}),transaction:vi.fn()};
  const app=express();app.use(rndRouter({rnd:rndConfigFromEnv(profileEnv),db} as unknown as RndDeps));app.get('/proofs/core-route',(_r,s)=>s.json({ordinary:true}));
  app.use((error:any,_r:express.Request,s:express.Response,_n:express.NextFunction)=>s.status(error.httpStatus??500).json({code:error.code}));
  for(const endpoint of ['/proofs/p/rnd/analyses','/proofs/p/rnd/annotations','/proofs/p/rnd/sidecars/id','/rnd/platform/unknown'])expect((await request(app).get(endpoint)).status).toBe(404);
  for(const endpoint of ['/proofs/p/rnd/analyses','/proofs/p/rnd/derivatives','/proofs/p/rnd/live-challenges','/proofs/p/rnd/capture-intents/id/sidecars/research-frame-0.pgm'])expect((await request(app).post(endpoint)).status).toBe(404);
  expect((await request(app).get('/rnd/capabilities')).body.supportedOperations.analyses).toBe(false);
  expect((await request(app).get('/proofs/core-route')).body).toEqual({ordinary:true});expect(db.query).not.toHaveBeenCalled();
 });
});

describe('production consent and signed final-file protocol',()=>{
 let h:TestHarness,deps:RndDeps,seller:string,outsider:string;let now=Date.parse('2026-10-12T10:00:00Z');
 const pair=generateKeyPairSync('ec',{namedCurve:'prime256v1'}),pem=pair.publicKey.export({type:'spki',format:'pem'}).toString();
 const signing:ManifestSigningRuntime={publicStatus:{mode:'SIGNED',algorithm:'ECDSA_SHA_256',keyId:'synthetic-product-key',required:true,trustListSha256:null},signer:{async signManifest(input){return {algorithm:'ECDSA_SHA_256',keyId:'synthetic-product-key',signedAt:new Date(now).toISOString(),signatureBase64:sign('sha256',Buffer.from(input.canonicalJson),pair.privateKey).toString('base64')};}}};
 beforeAll(async()=>{h=await createHarness({now:()=>new Date(now)},{manifestSigning:signing});seller=await createUser(h);outsider=await createUser(h);deps={...h,rnd:rndConfigFromEnv(profileEnv),manifestSigning:signing};},30000);
 afterAll(async()=>h?.close());
 async function proof(){const transaction=await createTransaction(h.db,h.clock,seller,{itemTitle:'Synthetic final-file receipt fixture'});return (await createOrGetProof(h.db,h.clock,seller,transaction.transactionId)).proofId;}
 it('reads explicit opt-in per actor/Proof, orders same-millisecond withdrawal and permits withdrawal after disable',async()=>{
  const id=await proof(),other=await proof();
  expect(await currentConsents(deps,seller,id)).toMatchObject({allowedPurposes:['EXPERIMENTAL_ANALYSIS'],consents:[{purpose:'EXPERIMENTAL_ANALYSIS',granted:false,recordedAt:null},{purpose:'LEARNING',granted:false}]});
  await expect(issueIntent(deps,seller,id,'no-consent',{acquisitionMode:'ONLINE',profileId:'native-final-file-v1'})).rejects.toMatchObject({code:'RND_CONSENT_REQUIRED'});
  await recordConsent(deps,seller,id,'grant',consent(true));await recordConsent(deps,seller,id,'withdraw',consent(false));
  expect((await currentConsents(deps,seller,id)).consents[0].granted).toBe(false);
  await recordConsent(deps,seller,id,'grant2',consent(true));
  expect((await currentConsents(deps,seller,other)).consents[0].granted).toBe(false);
  await expect(currentConsents(deps,outsider,id)).rejects.toMatchObject({code:'PARTICIPANT_NOT_AUTHORIZED'});
  await expect(recordConsent(deps,seller,id,'learning',{...consent(true),purpose:'LEARNING'})).rejects.toMatchObject({code:'RND_DISABLED'});
  const disabled={...deps,rnd:rndConfigFromEnv({...profileEnv,PACKPROOF_RND_KILL_SWITCH:'1'})};await recordConsent(disabled,seller,id,'off-withdraw',consent(false));
  expect((await currentConsents(disabled,seller,id))).toMatchObject({allowedPurposes:[],consents:[{granted:false},{granted:false}]});
  await expect(recordConsent(disabled,seller,id,'off-grant',consent(true))).rejects.toMatchObject({code:'RND_DISABLED'});
 });
 it('binds native and server signatures to exact committed bytes; exports metadata without rereading original media',async()=>{
  const id=await proof();await recordConsent(deps,seller,id,'grant',consent(true));
  const issued=await issueIntent(deps,seller,id,'intent',{acquisitionMode:'ONLINE',profileId:'native-final-file-v1'});
  const session=await createCaptureSession(h.db,h.clock,seller,id,{client:'NATIVE_CAMERA',idempotencyKey:'product-capture'});
  await expect(startIntent(deps,seller,id,issued.intent.id,'missing-key',{nonce:issued.intent.nonce,captureSessionId:session.id})).rejects.toMatchObject({code:'RND_CLIENT_KEY_REQUIRED'});
  await startIntent(deps,seller,id,issued.intent.id,'start',{nonce:issued.intent.nonce,captureSessionId:session.id,clientPublicKeyPem:pem});
  const evidence=await commitProofEvidence(h,seller,id,{evidenceType:'FULFILLMENT_CAPTURE',idempotencyKey:'product-capture'});
  const row=(await h.db.query<{sha256:string;byte_size:string}>('SELECT sha256,byte_size FROM evidence WHERE id=$1',[evidence.evidenceId])).rows[0];
  const canonical=canonicalize({schemaVersion:'packproof.native-final-file.v1',intentId:issued.intent.id,proofId:id,captureSessionId:session.id,chainCoverage:'FINAL_FILE_ONLY',mediaSha256:row.sha256,mediaByteLength:Number(row.byte_size)});
  const input={evidenceIds:[evidence.evidenceId],clientCanonicalJson:canonical,clientSignatureBase64:sign('sha256',Buffer.from(canonical),pair.privateKey).toString('base64')};
  await expect(closeIntent(deps,seller,id,issued.intent.id,'bad-signature',{...input,clientSignatureBase64:Buffer.alloc(70).toString('base64')})).rejects.toMatchObject({code:'RND_CLIENT_SIGNATURE_INVALID'});
  const receipt=await closeIntent(deps,seller,id,issued.intent.id,'close',input);
  expect(receipt.receipt.assurance).toMatchObject({chainCoverage:'FINAL_FILE_ONLY',sensorAttestation:'UNSUPPORTED',appAttestation:'UNSUPPORTED',signatureVerification:'BOUND_CLIENT_AND_SERVER_SIGNATURES'});
  expect(verify('sha256',Buffer.from(receipt.canonicalJson),pem,Buffer.from(receipt.signature.signatureBase64,'base64'))).toBe(true);
  expect((await captureReceipts(deps,seller,id)).captureReceipts[0].digest).toBe(receipt.digest);
  await expect(captureReceipts(deps,outsider,id)).rejects.toMatchObject({code:'PARTICIPANT_NOT_AUTHORIZED'});
  await commitAttestation(h.db,h.clock,seller,id,{statement:'PACKED_DESCRIBED_ITEM',relatedEvidenceId:evidence.evidenceId});await finalizeProof(h.db,h.clock,seller,id,signing.signer);
  const core=(await h.db.query<{sha256:string}>('SELECT sha256 FROM final_manifests WHERE proof_id=$1',[id])).rows[0].sha256;
  const restricted={...deps,objectStore:{...deps.objectStore,get:async()=>{throw Error('Metadata export must not read original media');}}};
  const bundle=await researchBundle(restricted,seller,id,'ORIGINALS_INCLUDED');expect(bundle.mode).toBe('METADATA_ONLY');expect(bundle.captureReceipts).toHaveLength(1);expect(bundle.extensions).toEqual([]);expect(bundle.sidecars).toEqual([]);
  expect((await collectSmallZip(await exportResearchZip(restricted,seller,id))).length).toBeGreaterThan(0);
  expect((await h.db.query<{sha256:string}>('SELECT sha256 FROM final_manifests WHERE proof_id=$1',[id])).rows[0].sha256).toBe(core);
  await expect(h.db.query('DELETE FROM rnd_session_receipts WHERE intent_id=$1',[issued.intent.id])).rejects.toThrow(/IMMUTABLE/);
 });
 it('does not retroactively label an earlier preauthorized capture as a fresh started session',async()=>{
  const id=await proof();await recordConsent(deps,seller,id,'grant',consent(true));
  const session=await createCaptureSession(h.db,h.clock,seller,id,{client:'NATIVE_CAMERA',idempotencyKey:'earlier'});now+=1000;
  const issued=await issueIntent(deps,seller,id,'later',{acquisitionMode:'ONLINE',profileId:'native-final-file-v1'});
  await expect(startIntent(deps,seller,id,issued.intent.id,'start',{nonce:issued.intent.nonce,captureSessionId:session.id,clientPublicKeyPem:pem})).rejects.toMatchObject({code:'RND_CAPTURE_BINDING'});
 });
});
