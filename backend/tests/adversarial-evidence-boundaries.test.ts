import { generateKeyPairSync, sign } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHarness, createUser, commitProofEvidence, commitFulfillmentAndAttest, prepareCameraCapture, type TestHarness } from './helpers.js';
import { createProof } from '../src/domain/create-proof.js';
import { createCaptureSession, completeCaptureSession, CAPTURE_ASSURANCE } from '../src/domain/capture-sessions.js';
import { assertShippingReviewComplete, getCaptureLabelReview, resolveCaptureLabel } from '../src/domain/capture-label-review.js';
import { bindCaptureShipping, getCaptureShipping } from '../src/domain/capture-shipping.js';
import { initializeEvidenceUpload } from '../src/domain/evidence.js';
import { finalizeProof, getManifest } from '../src/domain/finalize.js';
import { createSignatureAnchor, createSignatureSnapshot, askSignatureProof, appendSignatureComparison } from '../src/domain/signature.js';
import { inviteCommerceReceiver, acceptCommerceReceiver, createCommerceStage, initializeStageEvidence, commitStageEvidence, finalizeCommerceStage } from '../src/domain/commerce-lifecycle.js';
import { appendProofSupplement, getProofSupplementSnapshot } from '../src/domain/proof-supplements.js';
import { sha256Hex } from '../src/hash.js';
import type { ManifestSigner } from '../src/domain/manifest-signing.js';

// These are adversarial software-boundary fixtures, not a visual fraud detector
// evaluation. Physical-world attacks unobserved by the record stay unresolved.
describe('W02-D adversarial evidence classifications',()=>{
 let h:TestHarness;
 beforeAll(async()=>{h=await createHarness();});afterAll(async()=>h.close());
 const keys=generateKeyPairSync('ec',{namedCurve:'prime256v1'});
 const signer:ManifestSigner={signManifest:async input=>({algorithm:'ECDSA_SHA_256',keyId:'adversarial-fixture-key',signedAt:h.clock.now().toISOString(),signatureBase64:sign('sha256',Buffer.from(input.canonicalJson),keys.privateKey).toString('base64')})};
 async function fixture(seller?:string){const actor=seller??await createUser(h);const proof=await createProof(h.db,h.clock,actor,{transaction:{itemTitle:'Recorded camera',quantity:1}});return {seller:actor,proofId:proof.proofId};}
 async function abstains(seller:string,proofId:string,question:string){const snapshot=await createSignatureSnapshot(h.db,h.clock,seller,proofId);const answer=await askSignatureProof(h.db,seller,proofId,{snapshotId:snapshot.snapshotId,question});expect(answer).toMatchObject({state:'NOT_ESTABLISHED',citations:[],model:null});return snapshot;}
 const anchor=(seller:string,proofId:string,evidenceId:string,key:string,stageId?:string)=>createSignatureAnchor(h.db,h.clock,seller,proofId,{evidenceId,stageId,startMs:0,endMs:100,label:'Identifier observation',sourceType:'USER_MARKED',idempotencyKey:key});
 it('DETECTED reported label swap: rejects replacing the bound tracking identity and documents both scans; an unseen physical swap remains unresolved',async()=>{
  const f=await fixture(),session=await createCaptureSession(h.db,h.clock,f.seller,f.proofId,{client:'NATIVE_CAMERA',idempotencyKey:'label-camera'});
  const scan={rawValue:'1Z999AA10123456784',format:'CODE_128',detectedAtMs:10,idempotencyKey:'first-scan',confirmed:true};
  await bindCaptureShipping(h.db,h.clock,f.seller,f.proofId,session.id,scan);
  const conflict=await bindCaptureShipping(h.db,h.clock,f.seller,f.proofId,session.id,{...scan,rawValue:'1Z999AA10123456785',idempotencyKey:'swapped-scan'});
  expect(conflict).toMatchObject({status:'CONFLICT',currentTrackingNumber:scan.rawValue,trackingNumber:'1Z999AA10123456785',observationId:expect.any(String)});
  const review=await getCaptureLabelReview(h.db,f.seller,f.proofId,session.id);
  expect(review.reviewRequired).toBe(true);
  expect(review.observations).toEqual(expect.arrayContaining([
    expect.objectContaining({trackingNumber:scan.rawValue,associated:true}),
    expect.objectContaining({trackingNumber:'1Z999AA10123456785',associated:false,resolution:null}),
  ]));
  await expect(assertShippingReviewComplete(h.db,f.proofId,session.id)).rejects.toMatchObject({code:'LABEL_REVIEW_REQUIRED'});
  expect((await getCaptureShipping(h.db,f.proofId))?.observations.map(row=>row.trackingNumber)).toEqual([scan.rawValue]);
  expect((await h.db.query<{tracking_number:string}>('SELECT tracking_number FROM capture_label_observations WHERE proof_id=$1 ORDER BY tracking_number',[f.proofId])).rows.map(row=>row.tracking_number)).toEqual([scan.rawValue,'1Z999AA10123456785']);
  await abstains(f.seller,f.proofId,'Was the physical shipping label swapped after recording?');
  const observed=review.observations.find(row=>row.trackingNumber==='1Z999AA10123456785')!;
  const resolved=await resolveCaptureLabel(h.db,h.clock,f.seller,f.proofId,session.id,observed.observationId,{decision:'NOT_THIS_PACKAGE',reason:'Another label was visible beside the package'});
  expect(resolved.reviewRequired).toBe(false);
  expect(resolved.currentTrackingNumber).toBe(scan.rawValue);
  expect(resolved.observations.find(row=>row.observationId===observed.observationId)).toMatchObject({trackingNumber:'1Z999AA10123456785',associated:false,resolution:{decision:'NOT_THIS_PACKAGE'}});
  // A participant's resolution changes neither tracking identity nor knowledge of unseen physical acts.
  await abstains(f.seller,f.proofId,'Was the physical shipping label swapped after recording?');
 });
 it('DOCUMENTED authorized byte equality: identical recordings in new sessions carry no fraud finding and reveal no other account recording',async()=>{
  const a=await fixture(),b=await fixture(a.seller),privateProof=await fixture();
  const bytes=await readFile(new URL('./fixtures/camera-recording.mp4',import.meta.url));
  const first=await commitProofEvidence(h,a.seller,a.proofId,{bytes,evidenceType:'FULFILLMENT_CAPTURE'}),same=await commitProofEvidence(h,b.seller,b.proofId,{bytes,evidenceType:'FULFILLMENT_CAPTURE'}),privateMedia=await commitProofEvidence(h,privateProof.seller,privateProof.proofId,{bytes,evidenceType:'FULFILLMENT_CAPTURE'});
  expect(first.sha256).toBe(same.sha256);expect(first.sha256).toBe(privateMedia.sha256);
  const session=(await h.db.query<{capture_session_id:string}>('SELECT capture_session_id FROM evidence WHERE id=$1',[first.evidenceId])).rows[0].capture_session_id;
  await expect(initializeEvidenceUpload(h.db,h.clock,h.objectStore,b.seller,b.proofId,{contentType:'video/mp4',evidenceType:'FULFILLMENT_CAPTURE',captureSessionId:session,idempotencyKey:'transplanted-session'})).rejects.toMatchObject({code:'CAPTURE_SESSION_NOT_FOUND'});
  const snapshot=await abstains(a.seller,a.proofId,'Was this recording reused to commit fraud?');
  expect(snapshot.data.evidence.map(row=>row.evidenceId)).toEqual([first.evidenceId]);
  expect(JSON.stringify(snapshot)).not.toContain(privateMedia.evidenceId);expect(JSON.stringify(snapshot)).not.toContain(privateProof.proofId);
  await expect(createSignatureSnapshot(h.db,h.clock,a.seller,privateProof.proofId)).rejects.toMatchObject({httpStatus:403});
  await expect(anchor(a.seller,a.proofId,privateMedia.evidenceId,'foreign-source')).rejects.toMatchObject({code:'ANCHOR_SOURCE_NOT_FOUND'});
  expect(CAPTURE_ASSURANCE).toContain('Camera origin is not independently attested');
 });
 it('UNRESOLVED similar-item substitution: visible identifiers remain attributed observations and never establish physical identity',async()=>{
  const f=await fixture(),recording=await commitProofEvidence(h,f.seller,f.proofId,{evidenceType:'FULFILLMENT_CAPTURE'}),chapter=await anchor(f.seller,f.proofId,recording.evidenceId,'similar-item');
  expect(chapter).toMatchObject({sourceCategory:'USER_MARKED_OBSERVATION',authorUserId:f.seller,sourceHash:recording.sha256});
  const snapshot=await abstains(f.seller,f.proofId,'Is this the same physical item rather than a similar substitute?');
  expect(snapshot.data.order.source).toBe('PARTICIPANT_SUPPLIED_STATEMENT');
  expect(snapshot.data.limitations.join(' ')).toContain('not a finding of physical truth');
  await abstains(f.seller,f.proofId,'Is the item authentic?');
 });
 it('UNRESOLVED physical reopening after filming: digital replacement is rejected while an attributed later statement preserves the frozen core',async()=>{
  const f=await fixture(),media=await commitFulfillmentAndAttest(h,f.seller,f.proofId);
  const session=(await h.db.query<{capture_session_id:string;byte_size:number}>('SELECT capture_session_id,byte_size FROM evidence WHERE id=$1',[media.evidenceId])).rows[0];
  await expect(completeCaptureSession(h.db,h.clock,f.seller,f.proofId,session.capture_session_id,{sha256:'0'.repeat(64),byteSize:Number(session.byte_size),contentType:'video/mp4'})).rejects.toMatchObject({code:'CAPTURE_RECORDING_CONFLICT'});
  const frozen=await finalizeProof(h.db,h.clock,f.seller,f.proofId,signer);
  await expect(h.db.query('UPDATE evidence SET sha256=$2 WHERE id=$1',[media.evidenceId,'0'.repeat(64)])).rejects.toThrow('EVIDENCE_ALREADY_COMMITTED');
  const statement=await appendProofSupplement(h.db,h.clock,signer,f.seller,f.proofId,{operationId:'later-reopening-statement',kind:'CORRECTION',facts:{statement:'Seller reports the box was reopened after filming'}});
  expect(JSON.parse(statement.canonicalJson).actorUserId).toBe(f.seller);
  expect((await getManifest(h.db,f.seller,f.proofId)).canonicalJson).toBe(frozen.manifest.canonicalJson);
  await abstains(f.seller,f.proofId,'Was the package reopened after the recording ended?');
 });
 it('DOCUMENTED contradictory return: preserves competing attributed statements and comparison observations without assigning fraud or liability',async()=>{
  const f=await fixture(),buyer=await createUser(h),outboundMedia=await commitFulfillmentAndAttest(h,f.seller,f.proofId);
  const outbound=await anchor(f.seller,f.proofId,outboundMedia.evidenceId,'outbound');const frozen=await finalizeProof(h.db,h.clock,f.seller,f.proofId,signer);
  await inviteCommerceReceiver(h.db,h.clock,f.seller,f.proofId,buyer);await acceptCommerceReceiver(h.db,h.clock,buyer,f.proofId);
  async function stage(type:'RECEIPT'|'RETURN_PACKING'){
   const step=await createCommerceStage(h.db,h.clock,buyer,f.proofId,type),capture=await prepareCameraCapture(h,buyer,f.proofId,`camera-${type}`,step.stageId);
   const upload=await initializeStageEvidence(h.db,h.clock,h.objectStore,buyer,f.proofId,step.stageId,{contentType:'video/mp4',captureSessionId:capture.captureSessionId,idempotencyKey:`upload-${type}`});
   const row=(await h.db.query<{object_key:string}>('SELECT object_key FROM commerce_stage_evidence WHERE id=$1',[upload.evidenceId])).rows[0];await h.objectStore.put(row.object_key,capture.bytes,'video/mp4');
   await commitStageEvidence(h.db,h.clock,h.objectStore,buyer,f.proofId,step.stageId,upload.evidenceId,sha256Hex(capture.bytes));
   await finalizeCommerceStage(h.db,h.clock,buyer,f.proofId,step.stageId,step.attestation,signer);return {step,evidenceId:upload.evidenceId};
  }
  await stage('RECEIPT');const returned=await stage('RETURN_PACKING');
  await appendProofSupplement(h.db,h.clock,signer,buyer,f.proofId,{operationId:'buyer-return-assertion',kind:'RECIPIENT_RESPONSE',facts:{statement:'I returned the original item unchanged'}});
  await appendProofSupplement(h.db,h.clock,signer,f.seller,f.proofId,{operationId:'seller-return-assertion',kind:'CORRECTION',facts:{statement:'The return shows a different serial number'}});
  const inbound=await anchor(buyer,f.proofId,returned.evidenceId,'return-identifier',returned.step.stageId),snapshot=await createSignatureSnapshot(h.db,h.clock,f.seller,f.proofId);
  const comparison=await appendSignatureComparison(h.db,h.clock,f.seller,f.proofId,{snapshotId:snapshot.snapshotId,outboundAnchorId:outbound.anchorId,inboundAnchorId:inbound.anchorId,state:'OBSERVED_DIFFERENCE',note:'Seller observes a different visible serial marking'});
  expect(comparison).toMatchObject({sourceCategory:'USER_MARKED_OBSERVATION',authorUserId:f.seller,alignment:'MANUAL_PAIRING'});
  expect(comparison.limitations.join(' ')).toContain('not a finding of fraud or liability');
  await expect(appendSignatureComparison(h.db,h.clock,f.seller,f.proofId,{snapshotId:snapshot.snapshotId,outboundAnchorId:outbound.anchorId,inboundAnchorId:inbound.anchorId,state:'FRAUD_CONFIRMED',note:'Unsupported verdict'})).rejects.toMatchObject({code:'INVALID_COMPARISON_STATE'});
  const supplements=await getProofSupplementSnapshot(h.db,f.proofId);expect(supplements.supplements.map(row=>JSON.parse(row.canonicalJson))).toEqual(expect.arrayContaining([expect.objectContaining({actorUserId:buyer}),expect.objectContaining({actorUserId:f.seller})]));
  expect(JSON.stringify(supplements)).toContain('I returned the original item unchanged');expect(JSON.stringify(supplements)).toContain('The return shows a different serial number');
  expect((await getManifest(h.db,f.seller,f.proofId)).sha256).toBe(frozen.manifest.sha256);
  await abstains(f.seller,f.proofId,'Which participant committed return fraud?');
 });
});
