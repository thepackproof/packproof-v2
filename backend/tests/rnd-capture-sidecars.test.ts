import {beforeAll,afterAll,describe,it,expect} from 'vitest';
import {generateKeyPairSync,sign} from 'node:crypto';
import {readFile,mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {commitAttestation} from '../src/domain/attestations.js';
import {finalizeProof} from '../src/domain/finalize.js';
import {researchBundle} from '../src/rnd/exports.js';
import {requestAnalysis,leaseAnalysis,completeAnalysis} from '../src/rnd/analyses.js';
import {executeVision} from '../src/rnd/worker.js';
import {canonicalize} from '../../packages/evidence-contracts/contracts.mjs';
import {createHarness,createUser,type TestHarness} from './helpers.js';
import {createTransaction} from '../src/domain/transactions.js';
import {createOrGetProof} from '../src/domain/create-proof.js';
import {createCaptureSession,completeCaptureSession} from '../src/domain/capture-sessions.js';
import {initializeEvidenceUpload,commitEvidence} from '../src/domain/evidence.js';
import {recordConsent,issueIntent,startIntent,closeIntent} from '../src/rnd/capture.js';
import {uploadCaptureSidecar,listCaptureSidecars,validateSidecarChunk,validateNativeAcquisition,SIDECAR_CHUNK_BYTES} from '../src/rnd/capture-sidecars.js';
import {enabledResearchConfig} from '../src/rnd/config.js';
import {sha256Hex} from '../src/hash.js';
import type {RndDeps} from '../src/rnd/types.js';
import type {ManifestSigningRuntime} from '../src/integrity/signing-runtime.js';

describe('native signed sidecar receipt',()=>{
 let h:TestHarness,deps:RndDeps,seller:string,outsider:string;let now=Date.parse('2026-10-02T10:00:00Z');
 const pair=generateKeyPairSync('ec',{namedCurve:'prime256v1'}),pem=pair.publicKey.export({format:'pem',type:'spki'}).toString();
 const signing:ManifestSigningRuntime={publicStatus:{mode:'SIGNED',algorithm:'ECDSA_SHA_256',keyId:'sidecar-test',required:true,trustListSha256:null},signer:{async signManifest(i){return {algorithm:'ECDSA_SHA_256',keyId:'sidecar-test',signedAt:new Date(now).toISOString(),signatureBase64:sign('sha256',Buffer.from(i.canonicalJson),pair.privateKey).toString('base64')};}}};
 beforeAll(async()=>{h=await createHarness({now:()=>new Date(now)},{manifestSigning:signing});deps={...h,rnd:enabledResearchConfig(),manifestSigning:signing};seller=await createUser(h);outsider=await createUser(h);},30000);
 afterAll(async()=>h?.close());
 const consent=(granted:boolean)=>({purpose:'EXPERIMENTAL_ANALYSIS',version:'packproof.research-consent.v1',granted});
 const frameBytes=Buffer.concat([Buffer.from('P5\n1024 512\n255\n'),Buffer.alloc(1024*512,128)]);
 const descriptor={fileName:'research-frame-0.pgm',sha256:sha256Hex(frameBytes),byteLength:frameBytes.length,width:1024,height:512,mediaTimeMs:300,relationship:'CONCURRENT_CAPTURED_SIDECAR',transform:'NATIVE_LUMA_PLANE_PGM_NO_RESIZE'};
 const acquisition=Buffer.from(JSON.stringify({schemaVersion:'packproof.native-acquisition.v1',mode:'PASSIVE',frames:[descriptor]}));
 const journal=Buffer.from('{"event":"stop"}\n');
 async function fixture(){
  const txn=await createTransaction(h.db,h.clock,seller,{itemTitle:'Sidecar fixture'}),p=await createOrGetProof(h.db,h.clock,seller,txn.transactionId),proofId=p.proofId;
  await recordConsent(deps,seller,proofId,'consent',consent(true));
  const intent=await issueIntent(deps,seller,proofId,'intent',{legId:'OUTBOUND',acquisitionMode:'ONLINE',profileId:'native-final-file-v1'});
  const cap=await createCaptureSession(h.db,h.clock,seller,proofId,{client:'NATIVE_CAMERA',idempotencyKey:'cap'});
  await startIntent(deps,seller,proofId,intent.intent.id,'start',{nonce:intent.intent.nonce,captureSessionId:cap.id,clientPublicKeyPem:pem});
  const video=await readFile(new URL('./fixtures/camera-recording.mp4',import.meta.url));
  await completeCaptureSession(h.db,h.clock,seller,proofId,cap.id,{sha256:sha256Hex(video),byteSize:video.length,contentType:'video/mp4'});
  const upload=await initializeEvidenceUpload(h.db,h.clock,h.objectStore,seller,proofId,{contentType:'video/mp4',evidenceType:'FULFILLMENT_CAPTURE',captureSessionId:cap.id,idempotencyKey:'upload'});
  await h.objectStore.put(upload.objectKey,video,'video/mp4');const evidence=await commitEvidence(h.db,h.clock,h.objectStore,seller,proofId,upload.evidenceId,sha256Hex(video));
  const canonicalJson=canonicalize({schemaVersion:'packproof.native-final-file.v1',intentId:intent.intent.id,proofId,captureSessionId:cap.id,mediaSha256:sha256Hex(video),mediaByteLength:video.length,journalSha256:sha256Hex(journal),acquisitionSha256:sha256Hex(acquisition),chainCoverage:'FINAL_FILE_ONLY'});
  const receipt=await closeIntent(deps,seller,proofId,intent.intent.id,'close',{evidenceIds:[evidence.evidenceId],clientCanonicalJson:canonicalJson,clientSignatureBase64:sign('sha256',Buffer.from(canonicalJson),pair.privateKey).toString('base64')});
  return {proofId,intentId:intent.intent.id,evidenceId:evidence.evidenceId,receipt};
 }
 const chunk=(bytes:Buffer,index=0)=>({partIndex:index,partCount:Math.ceil(bytes.length/SIDECAR_CHUNK_BYTES),byteLength:bytes.length,sha256:sha256Hex(bytes),dataBase64:bytes.subarray(index*SIDECAR_CHUNK_BYTES,(index+1)*SIDECAR_CHUNK_BYTES).toString('base64')});
 it('validates fixed-size chunks and rejects unsafe acquisition filenames',()=>{
  expect(validateSidecarChunk(chunk(acquisition)).bytes).toEqual(acquisition);
  expect(()=>validateSidecarChunk({...chunk(acquisition),partCount:9})).toThrow();
  expect(()=>validateSidecarChunk({...chunk(acquisition),dataBase64:'YQ==\n'})).toThrow();
  expect(()=>validateNativeAcquisition(Buffer.from(JSON.stringify({schemaVersion:'packproof.native-acquisition.v1',mode:'PASSIVE',frames:[{...descriptor,fileName:'../secret'}]})))).toThrow();
 });
 it('receives exact signed acquisition then out-of-order chunks and never upgrades pixel identity',async()=>{
  const f=await fixture();
  await expect(uploadCaptureSidecar(deps,seller,f.proofId,f.intentId,descriptor.fileName,'early',chunk(frameBytes))).rejects.toMatchObject({code:'RND_SIDECAR_ACQUISITION_REQUIRED'});
  const metadata=await uploadCaptureSidecar(deps,seller,f.proofId,f.intentId,'research-acquisition.json','acq',chunk(acquisition));expect(metadata.state).toBe('RECEIVED');
  const part=await uploadCaptureSidecar(deps,seller,f.proofId,f.intentId,descriptor.fileName,'part2',chunk(frameBytes,2));expect(part.state).toBe('PART_RECEIVED');
  await uploadCaptureSidecar(deps,seller,f.proofId,f.intentId,descriptor.fileName,'part0',chunk(frameBytes,0));
  const final=await uploadCaptureSidecar(deps,seller,f.proofId,f.intentId,descriptor.fileName,'part1',chunk(frameBytes,1));expect(final.state).toBe('RECEIVED');
  const rows=await listCaptureSidecars(deps,seller,f.proofId),frame=rows.find(r=>r.sidecar.fileName===descriptor.fileName)!;
  expect(frame.sidecar).toMatchObject({parentEvidenceId:f.evidenceId,parentReceiptDigest:f.receipt.digest,relationship:'CONCURRENT_SIDECAR',assurance:{pixelEquivalence:'NOT_ASSERTED',sensorAttestation:'UNSUPPORTED'},frameReference:descriptor});
  const bytes=await h.objectStore.get(frame.sidecar.source.objectKey,{versionId:frame.sidecar.source.objectVersionId});expect(bytes?.body).toEqual(frameBytes);
  expect((await h.db.query('SELECT * FROM rnd_sources WHERE evidence_id=$1',[frame.sidecar.id])).rows).toHaveLength(1);
  expect(await uploadCaptureSidecar(deps,seller,f.proofId,f.intentId,descriptor.fileName,'new-retry',chunk(frameBytes,0))).toMatchObject({state:'RECEIVED',digest:frame.digest});
  await expect(h.db.query("UPDATE rnd_capture_sidecars SET sha256=$1 WHERE id=$2",['a'.repeat(64),frame.sidecar.id])).rejects.toThrow(/IMMUTABLE/);
  expect((await h.db.query<{digest:string}>('SELECT digest FROM rnd_session_receipts WHERE intent_id=$1',[f.intentId])).rows[0].digest).toBe(f.receipt.digest);
  await uploadCaptureSidecar(deps,seller,f.proofId,f.intentId,'native-journal.jsonl','journal',chunk(journal));
  await commitAttestation(h.db,h.clock,seller,f.proofId,{statement:'PACKED_DESCRIBED_ITEM',relatedEvidenceId:f.evidenceId});
  await finalizeProof(h.db,h.clock,seller,f.proofId,signing.signer);
  deps.rnd!.worker={python:process.env.PACKPROOF_RND_TEST_PYTHON??'/tmp/packproof-vision-venv/bin/python',script:new URL('../../research/vision/worker.py',import.meta.url).pathname,timeoutMs:60000,maxInputBytes:128*1024*1024};
  await requestAnalysis(deps,seller,f.proofId,'sidecar-analysis',{feature:'proofpilot',evidenceIds:[frame.sidecar.id]});
  const job=await leaseAnalysis(deps);expect(job?.input_json.sources[0]).toMatchObject({relationship:'CONCURRENT_SIDECAR',frameReference:descriptor});
  const result=await executeVision(deps,job!);expect(result.observations.length).toBeGreaterThan(0);await completeAnalysis(deps,job!,result,'a'.repeat(64));
  const bundle=await researchBundle(deps,seller,f.proofId,'ORIGINALS_INCLUDED');
  const directory=await mkdtemp(path.join(tmpdir(),'rnd-sidecar-export-'));
  try {
   const items=[...bundle.sources,...bundle.artifacts,...bundle.sidecars.map(s=>({...s.sidecar.source,archivePath:s.archivePath}))];
   for(const item of items){const bytes=await h.objectStore.get(item.objectKey,{versionId:item.objectVersionId});expect(bytes).not.toBeNull();const file=path.join(directory,item.archivePath);await mkdir(path.dirname(file),{recursive:true});await writeFile(file,bytes!.body);}
   const {verifyResearchBundle}=await import(new URL('../../verifier/rnd_bundle.mjs',import.meta.url).href);
   const trust={schema:'packproof.trust-list.v1',generatedAt:'2026-01-01T00:00:00Z',expiresAt:'2027-01-01T00:00:00Z',keys:[{keyId:'sidecar-test',algorithm:'ECDSA_SHA_256',status:'ACTIVE',publicKeyPem:pem}]};
   const result=await verifyResearchBundle(bundle,{trust,baseDir:directory,now});
   expect(result).toMatchObject({valid:true,sidecarCount:3,sidecarAcquisitionBytes:'VERIFIED_FOR_EXPORTED_INVENTORY',sidecarPixelEquivalence:'NOT_ASSERTED',completeByteCoverage:true});
  }finally{await rm(directory,{recursive:true,force:true});}

 });
 it('denies substitution, foreign actors, uncommitted files and revoked consent including retries',async()=>{
  const f=await fixture();
  await expect(uploadCaptureSidecar(deps,outsider,f.proofId,f.intentId,'research-acquisition.json','foreign',chunk(acquisition))).rejects.toMatchObject({code:'PARTICIPANT_NOT_AUTHORIZED'});
  await expect(uploadCaptureSidecar(deps,seller,f.proofId,f.intentId,'../video.mp4','path',chunk(acquisition))).rejects.toMatchObject({code:'RND_SIDECAR_FILENAME'});
  await expect(uploadCaptureSidecar(deps,seller,f.proofId,f.intentId,'research-acquisition.json','hash',{...chunk(acquisition),sha256:'a'.repeat(64)})).rejects.toMatchObject({code:'RND_SIDECAR_UNCOMMITTED'});
  await uploadCaptureSidecar(deps,seller,f.proofId,f.intentId,'research-acquisition.json','acq',chunk(acquisition));
  await expect(uploadCaptureSidecar(deps,seller,f.proofId,f.intentId,'research-frame-5.pgm','absent',chunk(frameBytes))).rejects.toMatchObject({code:'RND_SIDECAR_UNCOMMITTED'});
  const corrupt=Buffer.from(journal);corrupt[0]=0;
  await expect(uploadCaptureSidecar(deps,seller,f.proofId,f.intentId,'native-journal.jsonl','corrupt',{...chunk(journal),dataBase64:corrupt.toString('base64')})).rejects.toMatchObject({code:'RND_SIDECAR_INTEGRITY'});
  now++;await recordConsent(deps,seller,f.proofId,'withdraw',consent(false));
  await expect(uploadCaptureSidecar(deps,seller,f.proofId,f.intentId,'research-acquisition.json','acq',chunk(acquisition))).rejects.toMatchObject({code:'RND_CONSENT_REQUIRED'});
 });
});
