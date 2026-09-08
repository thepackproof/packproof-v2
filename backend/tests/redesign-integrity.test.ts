import { generateKeyPairSync, sign } from 'node:crypto';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getDisclosureProjection } from '../src/domain/disclosure.js';
import { auth, createHarness, createUser, prepareCameraCapture, type TestHarness } from './helpers.js';
import { importNormalizedTransaction } from '../src/domain/transaction-import.js';
import { createCaptureSession } from '../src/domain/capture-sessions.js';
import { createAttestationChallenge } from '../src/domain/attestation-authorization.js';
import { commitAttestation } from '../src/domain/attestations.js';
import { bindCaptureShipping } from '../src/domain/capture-shipping.js';
import { getCaptureLabelReview, resolveCaptureLabel } from '../src/domain/capture-label-review.js';
import { initializeEvidenceUpload, commitEvidence } from '../src/domain/evidence.js';
import { finalizeProof } from '../src/domain/finalize.js';
import { sha256Hex } from '../src/hash.js';

const label = '1Z999AA10123456784';
const wrongLabel = '1Z999AA10123456785';
const keys = generateKeyPairSync('ec', {namedCurve:'prime256v1'});
const publicKey = keys.publicKey.export({format:'der',type:'spki'}).toString('base64');
const authorization = (challenge:{challengeId:string;payload:string}) => ({challengeId:challenge.challengeId,signature:sign('sha256',Buffer.from(challenge.payload),keys.privateKey).toString('base64')});
const imported = {provider:'ebay',externalTransactionId:'order-ux-1',itemTitle:'Imported camera',quantity:1,shipping:{trackingNumber:label,carrier:'UPS'},provenance:{source:'MARKETPLACE_API',sourceRecordId:'order-ux-1',importedAt:'2026-09-08T00:00:00Z'}};

describe('redesign evidence and account boundaries',()=>{
  let h:TestHarness,seller:string,other:string;
  beforeEach(async()=>{h=await createHarness();seller=await createUser(h);other=await createUser(h);});
  afterEach(async()=>h.close());
  async function manual(shipping?:Record<string,string>) {
    const t=await request(h.app).post('/transactions').set(auth(seller)).send({itemTitle:'My camera',shipping});
    const p=await request(h.app).post(`/transactions/${t.body.transactionId}/proof`).set(auth(seller)).send({});
    return {transactionId:t.body.transactionId as string,proofId:p.body.proofId as string};
  }
  async function committed(proofId:string,key:string) {
    const capture=await prepareCameraCapture(h,seller,proofId,key);
    const upload=await initializeEvidenceUpload(h.db,h.clock,h.objectStore,seller,proofId,{contentType:'video/mp4',evidenceType:'FULFILLMENT_CAPTURE',captureSessionId:capture.captureSessionId,idempotencyKey:key});
    await h.objectStore.put(upload.objectKey,capture.bytes,'video/mp4');
    await commitEvidence(h.db,h.clock,h.objectStore,seller,proofId,upload.evidenceId);
    return {...capture,evidenceId:upload.evidenceId};
  }
  it('rejects imported rewrites from direct/stale clients and exposes server correction policy',async()=>{
    const initial=await importNormalizedTransaction(h.db,h.clock,seller,imported,{createProof:true});
    for(const [suffix,patch] of [['',{itemTitle:'Substitute item'}],['/shipping',{trackingNumber:wrongLabel}]] as const){
      const response=await request(h.app).patch(`/transactions/${initial.transaction.transactionId}${suffix}`).set(auth(seller)).send(patch);
      expect(response.status).toBe(409);expect(response.body.error.code).toBe('IMPORTED_FACTS_READ_ONLY');
    }
    const read=await request(h.app).get(`/transactions/${initial.transaction.transactionId}`).set(auth(seller));
    expect(read.body).toMatchObject({itemTitle:'Imported camera',shipping:{trackingNumber:label},correctionPolicy:{canCorrectOrderDetails:false,canCorrectShipping:false,reason:'IMPORTED_FACTS_READ_ONLY'}});
    expect((await h.db.query('SELECT * FROM audit_events WHERE proof_id=$1 AND event_type IN (\'TRANSACTION_DETAILS_UPDATED\',\'SHIPPING_DETAILS_UPDATED\')',[initial.proof!.proofId])).rows).toHaveLength(0);
  });
  it('allows manual correction before camera binding and locks stale deep links once setup is issued',async()=>{
    const context=await manual();
    expect((await request(h.app).patch(`/transactions/${context.transactionId}`).set(auth(seller)).send({itemTitle:'Correct item'})).status).toBe(200);
    await createCaptureSession(h.db,h.clock,seller,context.proofId,{client:'NATIVE_CAMERA',idempotencyKey:'setup'});
    const patch=await request(h.app).patch(`/transactions/${context.transactionId}`).set(auth(seller)).send({quantity:9});
    expect(patch.status).toBe(409);expect(patch.body.error.code).toBe('CAPTURE_CONTEXT_LOCKED');
  });
  it('preserves provider revisions after binding without replacing the recorded order snapshot or creating duplicates',async()=>{
    const first=await importNormalizedTransaction(h.db,h.clock,seller,imported,{createProof:true});
    await createCaptureSession(h.db,h.clock,seller,first.proof!.proofId,{client:'NATIVE_CAMERA',idempotencyKey:'snapshot'});
    const revision={...imported,itemTitle:'Provider later revision',quantity:2};
    const updated=await importNormalizedTransaction(h.db,h.clock,seller,revision,{createProof:true});
    expect(updated.transaction.itemTitle).toBe('Imported camera');expect(updated.transaction.quantity).toBe(1);
    expect(updated.proof!.proofId).toBe(first.proof!.proofId);
    await importNormalizedTransaction(h.db,h.clock,seller,revision,{createProof:true});
    const revisions=(await h.db.query<{snapshot:any}>('SELECT snapshot FROM transaction_source_observations WHERE transaction_id=$1',[first.transaction.transactionId])).rows;
    expect(revisions).toHaveLength(2);expect(revisions.some(r=>r.snapshot.itemTitle==='Provider later revision')).toBe(true);
    await expect(h.db.query('DELETE FROM transaction_source_observations WHERE transaction_id=$1',[first.transaction.transactionId])).rejects.toThrow('CAPTURE_SHIPPING_IMMUTABLE');
  });
  it('invalidates a signed challenge when tracking changes, accepts a fresh exact context, and prevents later rewriting',async()=>{
    const {proofId}=await manual();const capture=await committed(proofId,'context');
    const input={captureSessionId:capture.captureSessionId,sha256:sha256Hex(capture.bytes),publicKey};
    const stale=await createAttestationChallenge(h.db,h.clock,seller,proofId,input);
    await bindCaptureShipping(h.db,h.clock,seller,proofId,capture.captureSessionId,{rawValue:label,format:'CODE_128',detectedAtMs:0,idempotencyKey:'first-label',confirmed:true});
    await expect(commitAttestation(h.db,h.clock,seller,proofId,{statement:'PACKED_DESCRIBED_ITEM',relatedEvidenceId:capture.evidenceId,authorization:authorization(stale)})).rejects.toMatchObject({code:'ATTESTATION_CONTEXT_CHANGED'});
    const current=await createAttestationChallenge(h.db,h.clock,seller,proofId,input);
    expect(current.challengeId).not.toBe(stale.challengeId);
    const saved=await commitAttestation(h.db,h.clock,seller,proofId,{statement:'PACKED_DESCRIBED_ITEM',relatedEvidenceId:capture.evidenceId,authorization:authorization(current)});
    const final=await finalizeProof(h.db,h.clock,seller,proofId);
    expect(final.proof.status).toBe('FINALIZED');
    expect((await commitAttestation(h.db,h.clock,seller,proofId,{statement:'PACKED_DESCRIBED_ITEM',relatedEvidenceId:capture.evidenceId,authorization:authorization(current)})).attestation).toEqual(saved.attestation);
  });
  it('blocks conflicts before challenge and finalization, then preserves an explicit attributed resolution',async()=>{
    const {proofId}=await manual({trackingNumber:label});const capture=await committed(proofId,'conflict');
    const scan=await bindCaptureShipping(h.db,h.clock,seller,proofId,capture.captureSessionId,{rawValue:wrongLabel,format:'CODE_128',detectedAtMs:0,idempotencyKey:'wrong'});
    expect(scan.status).toBe('CONFLICT');
    const before=await getCaptureLabelReview(h.db,seller,proofId,capture.captureSessionId);expect(before.reviewRequired).toBe(true);
    const id=before.observations[0].observationId;
    await expect(createAttestationChallenge(h.db,h.clock,seller,proofId,{captureSessionId:capture.captureSessionId,sha256:sha256Hex(capture.bytes),publicKey})).rejects.toMatchObject({code:'LABEL_REVIEW_REQUIRED'});
    await commitAttestation(h.db,h.clock,seller,proofId,{statement:'PACKED_DESCRIBED_ITEM',relatedEvidenceId:capture.evidenceId});
    await expect(finalizeProof(h.db,h.clock,seller,proofId)).rejects.toMatchObject({code:'LABEL_REVIEW_REQUIRED'});
    const resolution={decision:'NOT_THIS_PACKAGE',reason:'Another label visible in recording'};
    await expect(resolveCaptureLabel(h.db,h.clock,other,proofId,capture.captureSessionId,id,resolution)).rejects.toMatchObject({code:'PARTICIPANT_NOT_AUTHORIZED'});
    const after=await resolveCaptureLabel(h.db,h.clock,seller,proofId,capture.captureSessionId,id,resolution);
    expect(after.reviewRequired).toBe(false);expect(after.currentTrackingNumber).toBe(label);
    expect(after.observations[0]).toMatchObject({trackingNumber:wrongLabel,associated:false,resolution});
    expect(await resolveCaptureLabel(h.db,h.clock,seller,proofId,capture.captureSessionId,id,resolution)).toEqual(after);
    await expect(resolveCaptureLabel(h.db,h.clock,seller,proofId,capture.captureSessionId,id,{...resolution,reason:'Changed story'})).rejects.toMatchObject({code:'LABEL_RESOLUTION_CONFLICT'});
    expect((await finalizeProof(h.db,h.clock,seller,proofId)).proof.status).toBe('FINALIZED');
    await expect(h.db.query('DELETE FROM capture_label_resolutions WHERE proof_id=$1',[proofId])).rejects.toThrow('CAPTURE_SHIPPING_IMMUTABLE');
  });
  it('preserves a dismissed ambiguous label and never silently reassociates it',async()=>{
    const {proofId}=await manual();const capture=await committed(proofId,'dismissed');
    const scan={rawValue:'123456789012',format:'CODE_128',detectedAtMs:0,idempotencyKey:'ambiguous',confirmed:false};
    expect((await bindCaptureShipping(h.db,h.clock,seller,proofId,capture.captureSessionId,scan)).status).toBe('NEEDS_CONFIRMATION');
    const review=await getCaptureLabelReview(h.db,seller,proofId,capture.captureSessionId);
    await resolveCaptureLabel(h.db,h.clock,seller,proofId,capture.captureSessionId,review.observations[0].observationId,{decision:'NOT_THIS_PACKAGE',reason:'Product barcode visible in recording'});
    await expect(bindCaptureShipping(h.db,h.clock,seller,proofId,capture.captureSessionId,{...scan,confirmed:true})).rejects.toMatchObject({code:'LABEL_RESOLUTION_CONFLICT'});
    expect((await getCaptureLabelReview(h.db,seller,proofId,capture.captureSessionId)).currentTrackingNumber).toBeNull();
  });
  it('projects chronology and tracking only for granted categories without private audit or label data',async()=>{
    const {proofId}=await manual({trackingNumber:label,carrier:'UPS'});
    await committed(proofId,'public-scope');
    const context={proofId,grantId:'test-scope',policyVersion:'packproof.disclosure/v1',scopeVersion:1,purpose:'BUYER_RECEIPT' as const,fields:['status'] as Array<'status'|'shipping'>,media:[]};
    const narrow=await getDisclosureProjection(h.db,context);
    expect(narrow.recordTracking).toBeNull();
    expect(narrow.chronology.map(e=>e.eventType)).toEqual(['PROOF_CREATED']);
    expect(JSON.stringify(narrow)).not.toContain(label);
    expect(JSON.stringify(narrow.chronology)).not.toContain(seller);
    const shipping=await getDisclosureProjection(h.db,{...context,fields:['status','shipping']});
    expect(shipping.recordTracking).toMatchObject({carrier:'UPS',syncState:'AWAITING_CARRIER_SCAN',source:'UNKNOWN',status:null,lastUpdatedAt:null,events:[]});
    expect(JSON.stringify(shipping.recordTracking)).not.toContain(label);
  });
  it('requires explicit authenticated account deletion requests and returns the same account-scoped status on retry',async()=>{
    const path='/me/account-deletion-request';
    expect((await request(h.app).post(path).send({confirmation:'REQUEST_ACCOUNT_DELETION'})).status).toBe(401);
    expect((await request(h.app).post(path).set(auth(seller)).send({})).status).toBe(400);
    expect((await request(h.app).get(path).set(auth(seller))).body.request).toBeNull();
    const submitted=await request(h.app).post(path).set(auth(seller)).send({confirmation:'REQUEST_ACCOUNT_DELETION'});
    expect(submitted.status).toBe(202);expect(submitted.body.request.state).toBe('REQUESTED');
    expect((await request(h.app).post(path).set(auth(seller)).send({confirmation:'REQUEST_ACCOUNT_DELETION'})).body).toEqual(submitted.body);
    expect((await request(h.app).get(path).set(auth(other))).body.request).toBeNull();
    expect((await h.db.query('SELECT * FROM account_audit_events WHERE actor_user_id=$1 AND event_type=\'ACCOUNT_DELETION_REQUESTED\'',[seller])).rows).toHaveLength(1);
    expect((await h.db.query<{status:string}>('SELECT status FROM users WHERE id=$1',[seller])).rows[0].status).toBe('ACTIVE');
  });
});
